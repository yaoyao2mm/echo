# Echo

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.x-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**中文** | [English](#english)

Echo is a phone-first control plane for local AI agents. It lets you start work from your phone, choose a desktop-advertised workspace, select an agent backend and model, watch live progress, approve risky actions, and review Git results without exposing your local machine as a remote shell.

Codex is the default backend today, but Echo is not a Codex-only wrapper. The desktop agent can advertise multiple backends and model profiles, including Codex, Claude Code, and Claude Code compatible Anthropic-style endpoints such as DeepSeek.

Different backends expose different capabilities; the matrix below shows the default surface Echo ships with.

不同 backend 的能力并不完全相同；下面的矩阵列出的是 Echo 默认支持的 backend 能力边界。

## 中文

### 目录

- [定位](#定位)
- [核心概念](#核心概念)
- [当前能力](#当前能力)
- [架构](#架构)
- [快速开始](#快速开始)
- [配置](#配置)
- [安全边界](#安全边界)
- [开发](#开发)
- [文档](#文档)
- [许可证](#许可证)

### 定位

Echo 是一个面向手机的本地 AI agent 控制台：

- 手机/PWA 负责记录任务、选择项目、选择 backend/model、查看进度、发送 follow-up 和作出审批决定。
- Relay 负责认证、排队、持久化会话状态、保存事件，并通过 SSE 把实时进度推送给手机。
- Desktop agent 是唯一能接触本机仓库、Git、worktree、文件系统和本地 agent runtime 的进程。
- Backend 是桌面 agent 暴露出来的执行能力，例如 Codex app-server、Claude Code，或通过 Claude Code 接入的 Anthropic-compatible 模型服务。

Echo 不是远程 shell。手机不能传任意本机路径，不能直接执行 shell，也不能直接访问 Codex app-server。所有真实执行都必须落在桌面端广告的 workspace、backend capability 和权限策略内。

### 核心概念

| 概念 | 含义 |
| --- | --- |
| Desktop agent | 运行在你电脑上的本地守护进程，负责 workspace、Git、worktree、凭证和 backend 进程。 |
| Backend | 一个可执行的 agent runtime 集成，例如 Codex、Claude Code、DeepSeek via Claude Code。 |
| Model | 某个 backend 下可选择的模型；模型列表由桌面端探测或配置后广播给 relay 和手机。 |
| Workspace | 桌面端显式授权或创建的项目目录。手机只能选择这些目录。 |
| Session | 手机端的一条 agent 会话，可以继续对话、取消 turn、在支持的 backend 上压缩上下文、归档恢复和查看结果。 |
| Runtime policy | backend、model、权限模式、sandbox、审批策略、worktree 模式和超时等桌面约束。 |

当前实现已经支持在同一桌面 agent 上注册多个 backend/profile，并由手机按会话选择 backend、model 和权限模式。更高阶的多 agent 编排设计记录在 [agent orchestration design](docs/agent-orchestration-design.md) 中。

历史命名说明：仓库里部分脚本、环境变量和 macOS bundle 路径仍保留 `Codex` 或 `ECHO_CODEX_*` 前缀，这是为了兼容已有配置、脚本路径和数据库字段，不代表 Echo 只能运行 Codex。

### 后端能力矩阵

| 能力 | Codex app-server | 内置 Claude Code | Claude Code compatible profiles |
| --- | --- | --- | --- |
| 文本 turn | 是 | 是 | 是 |
| 上下文用量 | 是 | 是，前提是 CLI 输出 usage 数据 | 是，前提是该 profile 输出 usage 数据 |
| 远程上下文压缩 | 是 | 否 | 默认否，除非该 profile 明确实现 |
| 截图附件 | 是 | 否 | 默认否，除非该 profile 明确实现 |
| 审批请求 | 是 | 否 | 默认否，除非该 profile 明确映射 |
| 交互请求 | 是 | 否 | 默认否，除非该 profile 明确映射 |
| Git 摘要 | 是 | 是 | 是 |
| worktree 执行 | 是 | 是 | 是 |

这张表描述的是默认能力，不是对某个 profile 的绝对承诺。桌面端广播的 runtime capability 才是最终准绳。

### 当前能力

- **多 backend / 多 model**：Codex 是默认 backend；可选启用 Claude Code；可用 `ECHO_AGENT_BACKENDS_JSON` 注册多个 Claude Code compatible profile，例如 DeepSeek Code、不同模型组或不同权限默认值。截图、审批、交互和上下文压缩能力是否可用，见上面的矩阵。
- **桌面能力广播**：桌面 agent 会上报 backend roster、健康状态、支持模型、权限模式、worktree 策略和 workspace 列表；relay 会在入队时校验手机选择。
- **手机优先 PWA**：移动端任务输入、项目选择、backend/model/权限选择、会话列表、工作台、日志、审批、文件浏览、快速指令和深色模式。
- **实时会话**：支持新会话、继续会话、计划/执行模式、取消当前 turn、失败恢复、归档/恢复、在支持的 backend 上进行 context compaction 和最终回复查看。
- **SSE 进度流**：会话事件通过 SSE 实时推送，轮询保留为兼容兜底。
- **审批与交互**：支持审批的 backend 会把命令/补丁审批以及交互式问题转发到手机端，并要求明确批准、拒绝或回答；不支持这些流程的 backend 会在手机端直接隐藏或阻止对应能力。
- **受控 workspace**：手机只能选择桌面 agent 广告的 `ECHO_CODEX_WORKSPACES` 或桌面端创建的 managed workspace。
- **代码浏览**：手机端可列出和预览 allowlist workspace 内的文本文件；路径必须相对 workspace，敏感文件和越界 symlink 会被阻止。
- **截图附件与产物**：支持截图附件的 backend 才会开放图片附件；relay 保存附件和 backend 产物元数据及内容引用。
- **快速指令**：全局/项目级 quick skills 可复用常见 prompt；内置提交推送指令仍走普通会话路径，不绕过权限边界。
- **Git 摘要**：turn 完成后桌面端生成统一 `git.summary`，手机端可看到改动文件、统计和状态。
- **隔离 worktree**：默认关闭；启用后新会话可在桌面控制的 Git worktree 中执行，并可从手机端应用到主 checkout 或丢弃。
- **持久化队列**：SQLite 保存 session、event、message、approval、interaction、attachment、artifact、quick skill、agent heartbeat 和 lease。
- **macOS 桌面体验**：可生成本地 `Echo Codex.app`，提供设置窗口、菜单栏入口、项目目录管理、配对二维码、网络诊断、日志和更新入口。
- **VPN/代理友好**：桌面 agent 只发起出站 HTTP(S) 请求，可用 `ECHO_PROXY_URL=system` 跟随 macOS 系统 HTTP/HTTPS 代理。

### 架构

```text
Phone PWA
  | HTTPS / token / optional login / SSE
  v
Relay server (Node.js + Express)
  | SQLite queue, sessions, approvals, interactions, files, quick skills, leases
  v
Desktop agent
  | local process / stdio / CLI
  v
Backend roster
  |-- Codex app-server
  |-- Claude Code CLI
  |-- Claude Code compatible profiles, e.g. DeepSeek
  |
  v
Allowlisted workspaces and optional Git worktrees
```

核心模块：

- `public/`：手机端 PWA、会话工作台、登录、配对、文件浏览、快速指令和 runtime 控件。
- `src/server.js`：Express relay/local server，提供认证、prompt refinement、session、SSE、文件请求、quick skills 和 agent API。
- `src/desktop-agent.js`：桌面 agent，长轮询 relay、公布 workspace/backend 能力、运行本地会话、处理文件/工作区请求并回传事件。
- `src/lib/backendAdapterContract.js`：backend adapter v1 契约，定义 snapshot、runtime command、capability、health 和结果事件形状。
- `src/lib/codexBackendAdapter.js` 和 `src/lib/claudeCodeBackendAdapter.js`：Codex 与 Claude Code backend 绑定。
- `src/lib/desktopBackendRegistry.js`：桌面 backend 注册、能力刷新和 runtime roster 发布。
- `src/lib/codex*.js`：会话队列、SQLite 存储、Codex app-server client、Git 摘要、文件浏览和 worktree 管理。
- `desktop-settings/` 和 `desktop-app/`：macOS 设置窗口和 Electron 桌面壳。
- `scripts/`：Android USB 转发、macOS app/DMG 构建、网络诊断和更新辅助脚本。

### 快速开始

#### 环境要求

- Node.js 20+
- pnpm 10+
- 要使用 Codex backend：已安装并登录官方 Codex App，或提供可用的 `codex` 命令。
- 要使用 Claude Code backend：已安装可用的 `claude` 命令，并配置相应认证。
- 公网 relay 需要可信 HTTPS 域名；LAN 调试可用 HTTP，但浏览器摄像头扫码通常需要 HTTPS 或 localhost。

#### 本地试用手机 UI

这个模式适合检查 PWA、配对页和 prompt refinement。完整远程 agent 会话需要下面的 relay + desktop agent。

```bash
pnpm install
cp .env.example .env
pnpm start
```

打开终端打印的手机 URL。URL 中包含配对 token，没有 token 的 API 请求会被拒绝。

Android 浏览器通常需要安全上下文才能使用摄像头扫码。开发时可以使用 USB 转发：

```bash
pnpm run android:usb
```

#### LAN relay + desktop agent

手机和电脑在同一网络时，可以用 LAN relay 跑完整链路。一个终端启动 relay：

```bash
ECHO_MODE=relay \
ECHO_PUBLIC_URL=http://YOUR_LAN_IP:3888 \
ECHO_TOKEN=replace-with-a-long-random-secret \
pnpm run relay
```

另一个终端在运行本地 backend 的电脑上启动 desktop agent：

```bash
ECHO_RELAY_URL=http://127.0.0.1:3888 \
ECHO_TOKEN=replace-with-a-long-random-secret \
ECHO_CODEX_WORKSPACES=echo=/absolute/path/to/project \
pnpm run desktop
```

手机打开：

```text
http://YOUR_LAN_IP:3888/?token=replace-with-a-long-random-secret
```

#### 公网 relay

在服务器上配置 `.env`：

```bash
ECHO_MODE=relay
ECHO_PUBLIC_URL=https://your-domain.example
ECHO_TOKEN=replace-with-a-long-random-secret

ECHO_AUTH_ENABLED=true
ECHO_AUTH_USERNAME=owner
ECHO_AUTH_PASSWORD=replace-with-a-strong-password

POSTPROCESS_PROVIDER=openai
LLM_API_KEY=replace-with-your-api-key
LLM_MODEL=gpt-4.1-mini
```

启动 relay：

```bash
pnpm install
pnpm run relay
```

在运行本地 backend 的电脑上启动 desktop agent：

```bash
ECHO_RELAY_URL=https://your-domain.example \
ECHO_TOKEN=replace-with-a-long-random-secret \
ECHO_CODEX_WORKSPACES=echo=/absolute/path/to/project \
pnpm run desktop
```

手机打开：

```text
https://your-domain.example/?token=replace-with-a-long-random-secret
```

#### macOS 桌面应用

生成并打开本地 app：

```bash
pnpm run desktop:mac:app
pnpm run desktop:mac -- app
```

常用命令：

```bash
pnpm run desktop:mac -- status
pnpm run desktop:mac -- settings
pnpm run desktop:mac -- doctor
pnpm run desktop:mac -- logs
pnpm run desktop:mac -- restart
```

创建本地 DMG：

```bash
pnpm run desktop:mac:dmg
```

### 配置

#### Relay、认证和网络

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `ECHO_MODE` | `local` 或 `relay`；远程 agent 会话需要 `relay` | `local`，或 `pnpm run relay` 时为 `relay` |
| `ECHO_HOST` | relay/local server 监听地址 | `0.0.0.0` |
| `ECHO_PORT` | relay/local server 端口 | `3888` |
| `ECHO_PUBLIC_URL` | relay 对手机展示的公网或 LAN URL | 空 |
| `ECHO_RELAY_URL` | desktop agent 连接的 relay URL | 空 |
| `ECHO_TOKEN` | 手机和 desktop agent 使用的配对密钥 | 启动时随机生成 |
| `ECHO_AUTH_ENABLED` | 是否开启网页登录 | 根据用户配置自动判断 |
| `ECHO_AUTH_USERNAME` / `ECHO_AUTH_PASSWORD` | 单用户登录凭据 | 空 |
| `ECHO_USERS_JSON` | 多用户登录配置数组 | 空 |
| `ECHO_SESSION_SECRET` | Web session 签名密钥 | `ECHO_TOKEN` 或启动随机值 |
| `ECHO_PROXY_URL` | 出站代理；macOS 可用 `system` | 环境代理或空 |
| `ECHO_NO_PROXY` | 代理绕过列表 | localhost、RFC1918、`.local` |

#### Workspace 和执行策略

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `ECHO_CODEX_WORKSPACES` | desktop agent 广告给手机的项目 allowlist | 当前目录 |
| `ECHO_CODEX_WORKSPACE_ROOT` | 手机端新建 managed workspace 的根目录 | 第一个 allowlist 项目的父目录，或 `~/workspace/projects` |
| `ECHO_CODEX_SESSION_CONCURRENCY` | 桌面 session worker 数；同一非隔离 checkout 会自动串行 | `3` |
| `ECHO_CODEX_LEASE_MS` | relay 没收到更新多久后回收 running lease | `600000` |
| `ECHO_CODEX_TIMEOUT_MS` | 单次 backend 执行超时 | `1800000` |
| `ECHO_CODEX_MAX_EVENTS` | 每个 session 保留的最大事件数 | `500` |
| `ECHO_CODEX_WORKTREE_MODE` | `off`、`optional` 或 `always` | `off` |
| `ECHO_CODEX_WORKTREE_ROOT` | 隔离 worktree 根目录 | `~/.echo-voice/worktrees` |
| `ECHO_CODEX_WORKTREE_RETENTION_DAYS` | 自动清理超过保留期且 Git 状态干净的 worktree | `14` |

`ECHO_CODEX_WORKSPACES` 支持逗号分隔的 `label=/absolute/path`：

```bash
ECHO_CODEX_WORKSPACES=frontend=/absolute/path/to/frontend,api=/absolute/path/to/api
```

#### Backend 和 model

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `ECHO_CODEX_ENABLED` | 是否注册默认 Codex backend | `true` |
| `ECHO_CODEX_COMMAND` | Codex CLI 命令 | `codex` |
| `ECHO_CODEX_APP_PATH` | Codex App 内置 CLI 路径覆盖 | 空 |
| `ECHO_CODEX_SANDBOX` | Codex 默认 sandbox：`read-only`、`workspace-write`、`danger-full-access` | `workspace-write` |
| `ECHO_CODEX_APPROVAL_POLICY` | Codex 默认审批策略：`on-request` 或 `never` | `on-request` |
| `ECHO_CODEX_ALLOWED_PERMISSION_MODES` | 手机端可选权限模式：`strict`、`approve`、`full` | `strict,approve,full` |
| `ECHO_CODEX_MODEL` | Codex 默认模型 | Codex 默认 |
| `ECHO_CODEX_REASONING_EFFORT` | Codex 默认推理强度 | 空 |
| `ECHO_CODEX_PROFILE` | Codex profile/权限模式默认值 | 空 |
| `ECHO_CLAUDE_ENABLED` | 是否启用内置 Claude Code backend | `false` |
| `ECHO_CLAUDE_COMMAND` | Claude Code CLI 命令 | `claude` |
| `ECHO_CLAUDE_BASE_URL` / `ANTHROPIC_BASE_URL` | Claude/Anthropic-compatible base URL | 空 |
| `ECHO_CLAUDE_AUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` | Claude/Anthropic-compatible token | 空 |
| `ECHO_CLAUDE_MODEL` | Claude Code 默认模型 | 空 |
| `ECHO_CLAUDE_SUPPORTED_MODELS` | Claude Code 可选模型列表 | `sonnet,opus`，DeepSeek URL 时为 DeepSeek 默认列表，Coding Plan URL 时为 Coding Plan 列表 |
| `ECHO_CLAUDE_ALLOWED_PERMISSION_MODES` | Claude Code 可选权限模式 | `strict` |
| `ECHO_VOLCENGINE_CODING_ENABLED` | 启用 Volcengine Coding Plan via Claude Code；没有显式 Claude/Anthropic-compatible 配置时接管内置 Claude Code backend，已有显式 Claude/DeepSeek 配置时自动新增独立 `volcengine-coding-plan` backend | `false` |
| `ECHO_VOLCENGINE_CODING_BACKEND_ID` | 显式 Claude/DeepSeek 配置同时存在时，自动新增的 Coding Plan backend id | `volcengine-coding-plan` |
| `ECHO_VOLCENGINE_CODING_BASE_URL` | Volcengine Coding Plan Anthropic-compatible base URL | `https://ark.cn-beijing.volces.com/api/coding` |
| `ECHO_VOLCENGINE_CODING_API_KEY` | Volcengine Coding Plan API key | 空 |
| `ECHO_VOLCENGINE_CODING_MODEL` | Claude Code 经 Coding Plan 使用的默认模型 | `ark-code-latest` |
| `ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS` | 覆盖 Coding Plan 可选模型列表 | 内置 Coding Plan 列表 |
| `ECHO_VOLCENGINE_CODING_PERMISSION_MODE` | Coding Plan 默认权限模式：`strict`、`approve`、`full` | `approve` |
| `ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES` | Coding Plan 手机端可选权限模式 | `strict,approve,full` |
| `ECHO_AGENT_BACKENDS_JSON` | 额外 backend profile 数组，目前支持 Claude Code compatible 配置 | 空 |

启用 Claude Code backend：

```bash
ECHO_CLAUDE_ENABLED=true
ECHO_CLAUDE_COMMAND=claude
ECHO_CLAUDE_MODEL=sonnet
ECHO_CLAUDE_ALLOWED_PERMISSION_MODES=strict
```

通过 Claude Code 接入 Volcengine Coding Plan。若你没有显式配置 Claude/DeepSeek base URL 或模型列表，Coding Plan 会作为内置 Claude Code backend 的 provider；若你已经显式配置了 Claude/DeepSeek，Echo 会额外公布一个 `Claude · Volcengine Coding Plan` backend，和 `Claude · DeepSeek` 分开选择：

```bash
ECHO_VOLCENGINE_CODING_ENABLED=true
ECHO_VOLCENGINE_CODING_API_KEY=replace-with-your-api-key
ECHO_VOLCENGINE_CODING_MODEL=ark-code-latest
ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES=strict,approve,full
```

启用后，desktop agent 会为 Claude Code 写入 Echo 管理的 `~/.echo-voice/claude-configs/.../settings.json` 并通过 `CLAUDE_CONFIG_DIR` 启动 `claude`。这和 CC Switch 的 provider 配置切换方式一致，能避免本机全局 `~/.claude/settings.json` 覆盖 Coding Plan 的 API 地址、token 或模型。Coding Plan 默认使用可编辑的 `approve` 权限并开放三种手机端权限模式；如需收紧，可以把 `ECHO_VOLCENGINE_CODING_PERMISSION_MODE` 设为 `strict`，或把 `ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES` 设为 `strict` / `strict,approve`。

添加额外 Anthropic-compatible backend profile，例如 DeepSeek via Claude Code：

```bash
DEEPSEEK_API_KEY=replace-with-your-api-key
ECHO_AGENT_BACKENDS_JSON='[
  {
    "id": "deepseek-code",
    "type": "claude-code",
    "name": "DeepSeek Code",
    "command": "claude",
    "baseUrl": "https://api.deepseek.com/anthropic",
    "authTokenEnv": "DEEPSEEK_API_KEY",
    "models": ["deepseek-v4-pro[1m]", "deepseek-v4-flash"],
    "permissionMode": "strict",
    "allowedPermissionModes": ["strict"],
    "worktreeMode": "optional"
  }
]'
```

桌面端是 runtime policy 的来源。手机可以请求 backend、model、权限和 worktree 偏好，但 relay 会按桌面端广播的 capability 做校验和归一化。

#### Prompt refinement

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `POSTPROCESS_PROVIDER` | `auto`、`openai`、`volcengine`、`ollama`、`rules` 或 `none` | `auto` |
| `LLM_BASE_URL` | OpenAI-compatible prompt refinement endpoint | `https://api.openai.com/v1` |
| `LLM_API_KEY` | OpenAI-compatible API key | 空 |
| `LLM_MODEL` | prompt refinement model | `gpt-4.1-mini` |
| `VOLCENGINE_CODING_API_KEY` | Volcengine Ark key | 空 |
| `OLLAMA_BASE_URL` | Ollama endpoint | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | Ollama model | `qwen3:4b` |

### 安全边界

- 公网 relay 必须使用 HTTPS。
- `ECHO_TOKEN` 是配对密钥，建议使用长随机字符串并避免提交到仓库。
- 登录认证是 token 之外的 Web 访问门；desktop agent 轮询仍使用 `ECHO_TOKEN`。
- 手机不能指定任意本机路径；项目来自 desktop agent allowlist 或桌面端创建的 managed workspace。
- 文件浏览只允许相对路径，限制在所选 workspace 内，并阻止敏感文件预览和越界 symlink。
- Quick skill 只是保存 prompt，不新增任意 shell/path API。
- Desktop agent 只主动连接 relay，不需要把本机端口暴露到公网。
- Codex app-server 始终只在 desktop agent 本地通过 stdio 使用，不要直接暴露到公网。
- Relay 会保存 prompt、会话事件、消息、审批、交互请求、附件、产物、日志和最终回复；请部署在你信任的基础设施上。
- SQLite 数据默认位于 `~/.echo-voice/echo.sqlite`，附件和产物默认位于同一数据目录下；如包含敏感内容，请按需备份、清理或加密宿主机磁盘。
- 默认 sandbox 是 `workspace-write`。只有在完全信任当前电脑和项目时，才允许 `full`/`danger-full-access`。
- Worktree 模式默认关闭。启用时要求 base Git workspace 干净，dirty worktree 不会被自动删除。

### 开发

```bash
pnpm install
pnpm run dev
```

常用检查：

```bash
pnpm run check:js
pnpm test
pnpm run check
```

`pnpm run check` 会运行 JS 语法检查、shell 语法检查和 Node 测试。移动端 PWA 变更默认优先做非 e2e 检查；除非明确需要，不运行 e2e。

e2e 手动运行：

```bash
pnpm run test:e2e:mobile
```

网络诊断：

```bash
pnpm run doctor:network
```

### 文档

- [Quick skills](docs/quick-skills.md)
- [Mobile Codex remote plan](docs/mobile-codex-remote-plan.md)
- [Mobile Codex roadmap](docs/mobile-codex-roadmap.md)
- [Codex architecture risk tracker](docs/codex-architecture-risk-tracker.md)
- [Multi agent / multi model orchestration design](docs/agent-orchestration-design.md)

### 许可证

[MIT](LICENSE)

## English

### Table of Contents

- [Positioning](#positioning)
- [Core Concepts](#core-concepts)
- [Current Capabilities](#current-capabilities)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Security Boundaries](#security-boundaries)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

### Positioning

Echo is a phone-first control plane for local AI agents:

- The phone/PWA captures tasks, chooses projects, selects backend/model options, reviews progress, sends follow-ups, and makes approval decisions.
- The relay authenticates users, queues work, persists session state, stores events, and streams live progress to the phone over SSE.
- The desktop agent is the only process that can touch local repositories, Git, worktrees, filesystems, credentials, and local agent runtimes.
- A backend is an execution capability advertised by the desktop agent, such as Codex app-server, Claude Code, or a Claude Code connected Anthropic-compatible model endpoint.

Echo is not a remote shell. The phone cannot submit arbitrary local paths, directly execute shell commands, or connect to the Codex app-server. Real execution must stay within desktop-advertised workspaces, backend capabilities, and policy.

### Core Concepts

| Concept | Meaning |
| --- | --- |
| Desktop agent | Local host process that owns workspaces, Git, worktrees, credentials, and backend processes. |
| Backend | Agent runtime integration, for example Codex, Claude Code, or DeepSeek via Claude Code. |
| Model | A selectable model under a backend; model lists are probed or configured by the desktop and advertised to relay/mobile. |
| Workspace | A desktop-allowed or desktop-created project directory. The phone can only choose these directories. |
| Session | A mobile-visible agent conversation that can continue, cancel turns, compact context on supported backends, archive/restore, and show results. |
| Runtime policy | Backend, model, permission mode, sandbox, approval policy, worktree mode, and timeout constraints. |

The current implementation supports multiple backend profiles on one desktop agent, with per-session backend, model, and permission selection from mobile. Higher-level multi-agent orchestration is tracked in [agent orchestration design](docs/agent-orchestration-design.md).

Naming note: some scripts, environment variables, and the macOS bundle path still keep `Codex` or `ECHO_CODEX_*` prefixes for compatibility with existing config, script paths, and database fields. That naming does not mean Echo can only run Codex.

### Backend Capability Matrix

| Capability | Codex app-server | Built-in Claude Code | Claude Code compatible profiles |
| --- | --- | --- | --- |
| Text turns | Yes | Yes | Yes |
| Context usage | Yes | Yes, when the CLI emits usage data | Yes, when the profile emits usage data |
| Remote context compaction | Yes | No | Default no, unless the profile explicitly implements it |
| Screenshot attachments | Yes | No | Default no, unless the profile explicitly implements it |
| Approval requests | Yes | No | Default no, unless the profile explicitly maps them |
| Interaction requests | Yes | No | Default no, unless the profile explicitly maps them |
| Git summaries | Yes | Yes | Yes |
| Worktree execution | Yes | Yes | Yes |

The table above describes the default capability surface, not a promise that a specific profile can never differ. The runtime capability roster advertised by the desktop is the final source of truth.

### Current Capabilities

- **Multi-backend / multi-model**: Codex is the default backend. Claude Code can be enabled, and `ECHO_AGENT_BACKENDS_JSON` can register multiple Claude Code compatible profiles such as DeepSeek Code, different model groups, or different permission defaults. Screenshot, approval, interaction, and compaction support varies by backend and is listed in the matrix above.
- **Desktop capability roster**: the desktop advertises backends, health, supported models, permission modes, worktree policy, and workspaces. The relay validates mobile choices before queueing work.
- **Phone-first PWA**: mobile composer, project picker, backend/model/permission controls, session list, workbench, logs, approvals, file browser, quick skills, and dark mode.
- **Live sessions**: start sessions, continue sessions, choose plan/execute mode, cancel the active turn, recover failures, archive/restore, compact context on supported backends, and inspect final answers.
- **SSE progress stream**: session events stream over SSE with polling kept as fallback.
- **Approvals and interactions**: backends that support approval flows forward command/patch approvals and interactive questions to mobile for explicit decisions, while unsupported backends hide or block those controls.
- **Controlled workspaces**: the phone can only choose `ECHO_CODEX_WORKSPACES` advertised by the desktop agent or desktop-created managed workspaces.
- **Code browsing**: the phone can list and preview text files inside allowlisted workspaces. Paths must be relative, sensitive previews are blocked, and symlinks cannot escape the workspace.
- **Screenshot attachments and artifacts**: backends that support attachments expose image uploads; relay stores attachment and backend artifact metadata plus content references.
- **Quick skills**: global/project prompts reuse common tasks through the normal session path and do not bypass permissions.
- **Git summaries**: after a turn completes, the desktop emits a unified `git.summary` so the phone can show changed files, stats, and status.
- **Isolated worktrees**: off by default. When enabled, new sessions can run in desktop-controlled Git worktrees and later be applied to the base checkout or discarded from mobile.
- **Persistent queue**: SQLite-backed sessions, events, messages, approvals, interactions, attachments, artifacts, quick skills, agent heartbeats, and leases.
- **macOS desktop experience**: local `Echo Codex.app`, settings window, menu bar item, workspace manager, pairing QR code, network doctor, logs, and updater.
- **VPN/proxy friendly**: the desktop agent only makes outbound HTTP(S) requests and can follow the macOS system HTTP/HTTPS proxy with `ECHO_PROXY_URL=system`.

### Architecture

```text
Phone PWA
  | HTTPS / token / optional login / SSE
  v
Relay server (Node.js + Express)
  | SQLite queue, sessions, approvals, interactions, files, quick skills, leases
  v
Desktop agent
  | local process / stdio / CLI
  v
Backend roster
  |-- Codex app-server
  |-- Claude Code CLI
  |-- Claude Code compatible profiles, e.g. DeepSeek
  |
  v
Allowlisted workspaces and optional Git worktrees
```

Core modules:

- `public/`: mobile PWA, session workbench, login, pairing, file browser, quick skills, and runtime controls.
- `src/server.js`: Express relay/local server for auth, prompt refinement, sessions, SSE, file requests, quick skills, and agent APIs.
- `src/desktop-agent.js`: desktop agent that long-polls the relay, publishes workspace/backend capabilities, runs local sessions, handles file/workspace requests, and reports events.
- `src/lib/backendAdapterContract.js`: backend adapter v1 contract for snapshots, runtime commands, capabilities, health, and result events.
- `src/lib/codexBackendAdapter.js` and `src/lib/claudeCodeBackendAdapter.js`: Codex and Claude Code backend bindings.
- `src/lib/desktopBackendRegistry.js`: desktop backend registration, capability refresh, and runtime roster publishing.
- `src/lib/codex*.js`: session queue, SQLite storage, Codex app-server client, Git summaries, file browsing, and worktree management.
- `desktop-settings/` and `desktop-app/`: macOS settings UI and Electron desktop wrapper.
- `scripts/`: Android USB forwarding, macOS app/DMG builds, network diagnostics, and update helpers.

### Quick Start

#### Requirements

- Node.js 20+
- pnpm 10+
- For the Codex backend: official Codex App installed and signed in, or an available `codex` command.
- For the Claude Code backend: an available `claude` command and matching auth.
- A trusted HTTPS domain for internet relay mode. LAN debugging can use HTTP, but browser camera pairing usually needs HTTPS or localhost.

#### Try The Phone UI Locally

This mode is useful for checking the PWA, pairing page, and prompt refinement. Full remote agent sessions require the relay + desktop agent setup below.

```bash
pnpm install
cp .env.example .env
pnpm start
```

Open the printed phone URL. The URL includes a pairing token; API requests without that token are rejected.

Android browsers usually require a secure context for camera-based QR pairing. For development, use USB forwarding:

```bash
pnpm run android:usb
```

#### LAN Relay + Desktop Agent

If your phone and computer are on the same network, use a LAN relay for the complete path. Start the relay in one terminal:

```bash
ECHO_MODE=relay \
ECHO_PUBLIC_URL=http://YOUR_LAN_IP:3888 \
ECHO_TOKEN=replace-with-a-long-random-secret \
pnpm run relay
```

Start the desktop agent on the computer that should run local backends:

```bash
ECHO_RELAY_URL=http://127.0.0.1:3888 \
ECHO_TOKEN=replace-with-a-long-random-secret \
ECHO_CODEX_WORKSPACES=echo=/absolute/path/to/project \
pnpm run desktop
```

Open the phone URL:

```text
http://YOUR_LAN_IP:3888/?token=replace-with-a-long-random-secret
```

#### Internet Relay

Create `.env` on the relay host:

```bash
ECHO_MODE=relay
ECHO_PUBLIC_URL=https://your-domain.example
ECHO_TOKEN=replace-with-a-long-random-secret

ECHO_AUTH_ENABLED=true
ECHO_AUTH_USERNAME=owner
ECHO_AUTH_PASSWORD=replace-with-a-strong-password

POSTPROCESS_PROVIDER=openai
LLM_API_KEY=replace-with-your-api-key
LLM_MODEL=gpt-4.1-mini
```

Start the relay:

```bash
pnpm install
pnpm run relay
```

Start the desktop agent on the machine that should run local backends:

```bash
ECHO_RELAY_URL=https://your-domain.example \
ECHO_TOKEN=replace-with-a-long-random-secret \
ECHO_CODEX_WORKSPACES=echo=/absolute/path/to/project \
pnpm run desktop
```

Open the phone URL:

```text
https://your-domain.example/?token=replace-with-a-long-random-secret
```

#### macOS Desktop App

Build and open the local app:

```bash
pnpm run desktop:mac:app
pnpm run desktop:mac -- app
```

Useful commands:

```bash
pnpm run desktop:mac -- status
pnpm run desktop:mac -- settings
pnpm run desktop:mac -- doctor
pnpm run desktop:mac -- logs
pnpm run desktop:mac -- restart
```

Create a local DMG:

```bash
pnpm run desktop:mac:dmg
```

### Configuration

#### Relay, Auth, And Network

| Variable | Description | Default |
| --- | --- | --- |
| `ECHO_MODE` | `local` or `relay`; remote agent sessions require `relay` | `local`, or `relay` when using `pnpm run relay` |
| `ECHO_HOST` | Relay/local server bind host | `0.0.0.0` |
| `ECHO_PORT` | Relay/local server port | `3888` |
| `ECHO_PUBLIC_URL` | Public or LAN URL shown to the phone | empty |
| `ECHO_RELAY_URL` | Relay URL used by the desktop agent | empty |
| `ECHO_TOKEN` | Pairing secret for phone and desktop agent requests | random on startup |
| `ECHO_AUTH_ENABLED` | Enable browser login | inferred from user config |
| `ECHO_AUTH_USERNAME` / `ECHO_AUTH_PASSWORD` | Single-user login credentials | empty |
| `ECHO_USERS_JSON` | Multi-user login config array | empty |
| `ECHO_SESSION_SECRET` | Web session signing secret | `ECHO_TOKEN` or startup random |
| `ECHO_PROXY_URL` | Outbound proxy; `system` follows macOS system proxy | env proxy or empty |
| `ECHO_NO_PROXY` | Proxy bypass list | localhost, RFC1918, `.local` |

#### Workspace And Execution Policy

| Variable | Description | Default |
| --- | --- | --- |
| `ECHO_CODEX_WORKSPACES` | Desktop-advertised project allowlist | current directory |
| `ECHO_CODEX_WORKSPACE_ROOT` | Root for mobile-created managed workspaces | first allowlisted workspace's parent, or `~/workspace/projects` |
| `ECHO_CODEX_SESSION_CONCURRENCY` | Desktop session worker count; same non-isolated checkout is serialized | `3` |
| `ECHO_CODEX_LEASE_MS` | Relay lease recovery window without updates | `600000` |
| `ECHO_CODEX_TIMEOUT_MS` | Single backend execution timeout | `1800000` |
| `ECHO_CODEX_MAX_EVENTS` | Maximum retained events per session | `500` |
| `ECHO_CODEX_WORKTREE_MODE` | `off`, `optional`, or `always` | `off` |
| `ECHO_CODEX_WORKTREE_ROOT` | Isolated worktree root directory | `~/.echo-voice/worktrees` |
| `ECHO_CODEX_WORKTREE_RETENTION_DAYS` | Prune old clean worktrees after this many days | `14` |

`ECHO_CODEX_WORKSPACES` accepts comma-separated `label=/absolute/path` entries:

```bash
ECHO_CODEX_WORKSPACES=frontend=/absolute/path/to/frontend,api=/absolute/path/to/api
```

#### Backend And Model

| Variable | Description | Default |
| --- | --- | --- |
| `ECHO_CODEX_ENABLED` | Register the default Codex backend | `true` |
| `ECHO_CODEX_COMMAND` | Codex CLI command | `codex` |
| `ECHO_CODEX_APP_PATH` | Override path to the Codex App bundled CLI | empty |
| `ECHO_CODEX_SANDBOX` | Codex default sandbox: `read-only`, `workspace-write`, `danger-full-access` | `workspace-write` |
| `ECHO_CODEX_APPROVAL_POLICY` | Codex default approval policy: `on-request` or `never` | `on-request` |
| `ECHO_CODEX_ALLOWED_PERMISSION_MODES` | Mobile-selectable permission modes: `strict`, `approve`, `full` | `strict,approve,full` |
| `ECHO_CODEX_MODEL` | Codex default model | Codex default |
| `ECHO_CODEX_REASONING_EFFORT` | Codex default reasoning effort | empty |
| `ECHO_CODEX_PROFILE` | Codex profile/permission-mode default | empty |
| `ECHO_CLAUDE_ENABLED` | Enable the built-in Claude Code backend | `false` |
| `ECHO_CLAUDE_COMMAND` | Claude Code CLI command | `claude` |
| `ECHO_CLAUDE_BASE_URL` / `ANTHROPIC_BASE_URL` | Claude/Anthropic-compatible base URL | empty |
| `ECHO_CLAUDE_AUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` | Claude/Anthropic-compatible token | empty |
| `ECHO_CLAUDE_MODEL` | Claude Code default model | empty |
| `ECHO_CLAUDE_SUPPORTED_MODELS` | Claude Code selectable model list | `sonnet,opus`, DeepSeek defaults for DeepSeek URLs, or Coding Plan defaults for Coding Plan URLs |
| `ECHO_CLAUDE_ALLOWED_PERMISSION_MODES` | Claude Code selectable permission modes | `strict` |
| `ECHO_VOLCENGINE_CODING_ENABLED` | Enable Volcengine Coding Plan through Claude Code; without explicit Claude/Anthropic-compatible config it takes over the built-in Claude Code backend, and with explicit Claude/DeepSeek config it auto-adds a separate `volcengine-coding-plan` backend | `false` |
| `ECHO_VOLCENGINE_CODING_BACKEND_ID` | Backend id for the auto-added Coding Plan backend when explicit Claude/DeepSeek config also exists | `volcengine-coding-plan` |
| `ECHO_VOLCENGINE_CODING_BASE_URL` | Volcengine Coding Plan Anthropic-compatible base URL | `https://ark.cn-beijing.volces.com/api/coding` |
| `ECHO_VOLCENGINE_CODING_API_KEY` | Volcengine Coding Plan API key | empty |
| `ECHO_VOLCENGINE_CODING_MODEL` | Default model for Claude Code through Coding Plan | `ark-code-latest` |
| `ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS` | Override the Coding Plan selectable model list | built-in Coding Plan list |
| `ECHO_VOLCENGINE_CODING_PERMISSION_MODE` | Coding Plan default permission mode: `strict`, `approve`, `full` | `approve` |
| `ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES` | Coding Plan mobile-selectable permission modes | `strict,approve,full` |
| `ECHO_AGENT_BACKENDS_JSON` | Extra backend profile array; currently supports Claude Code compatible configs | empty |

Enable the Claude Code backend:

```bash
ECHO_CLAUDE_ENABLED=true
ECHO_CLAUDE_COMMAND=claude
ECHO_CLAUDE_MODEL=sonnet
ECHO_CLAUDE_ALLOWED_PERMISSION_MODES=strict
```

Use Volcengine Coding Plan through Claude Code. If no explicit Claude/DeepSeek base URL or model list is configured, Coding Plan becomes the provider for the built-in Claude Code backend. If explicit Claude/DeepSeek config already exists, Echo advertises an additional `Claude · Volcengine Coding Plan` backend so it can be selected separately from `Claude · DeepSeek`:

```bash
ECHO_VOLCENGINE_CODING_ENABLED=true
ECHO_VOLCENGINE_CODING_API_KEY=replace-with-your-api-key
ECHO_VOLCENGINE_CODING_MODEL=ark-code-latest
ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES=strict,approve,full
```

When enabled, the desktop agent writes an Echo-managed `~/.echo-voice/claude-configs/.../settings.json` and launches `claude` with `CLAUDE_CONFIG_DIR`. This mirrors the provider-config switching model used by CC Switch and prevents a global `~/.claude/settings.json` from overriding the Coding Plan API URL, token, or model. Coding Plan defaults to the editable `approve` permission and opens all three mobile-selectable permission modes by default; set `ECHO_VOLCENGINE_CODING_PERMISSION_MODE` to `strict`, or set `ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES` to `strict` / `strict,approve`, to tighten it.

Add an extra Anthropic-compatible backend profile, for example DeepSeek via Claude Code:

```bash
DEEPSEEK_API_KEY=replace-with-your-api-key
ECHO_AGENT_BACKENDS_JSON='[
  {
    "id": "deepseek-code",
    "type": "claude-code",
    "name": "DeepSeek Code",
    "command": "claude",
    "baseUrl": "https://api.deepseek.com/anthropic",
    "authTokenEnv": "DEEPSEEK_API_KEY",
    "models": ["deepseek-v4-pro[1m]", "deepseek-v4-flash"],
    "permissionMode": "strict",
    "allowedPermissionModes": ["strict"],
    "worktreeMode": "optional"
  }
]'
```

The desktop is the source of runtime policy. The phone can request backend, model, permission, and worktree preferences, but the relay validates and normalizes them against desktop-advertised capabilities.

#### Prompt Refinement

| Variable | Description | Default |
| --- | --- | --- |
| `POSTPROCESS_PROVIDER` | `auto`, `openai`, `volcengine`, `ollama`, `rules`, or `none` | `auto` |
| `LLM_BASE_URL` | OpenAI-compatible prompt refinement endpoint | `https://api.openai.com/v1` |
| `LLM_API_KEY` | OpenAI-compatible API key | empty |
| `LLM_MODEL` | Prompt refinement model | `gpt-4.1-mini` |
| `VOLCENGINE_CODING_API_KEY` | Volcengine Ark key | empty |
| `OLLAMA_BASE_URL` | Ollama endpoint | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | Ollama model | `qwen3:4b` |

### Security Boundaries

- Use HTTPS for internet relay mode.
- Treat `ECHO_TOKEN` as a pairing secret. Use a long random value and never commit it.
- Browser login is an additional web gate on top of the token; desktop agent polling still uses `ECHO_TOKEN`.
- The phone cannot choose arbitrary local paths; projects come from the desktop agent allowlist or desktop-created managed workspaces.
- File browsing only accepts relative paths inside the selected workspace and blocks sensitive previews and escaping symlinks.
- Quick skills are saved prompts only; they do not add arbitrary shell/path APIs.
- The desktop agent only opens outbound connections to the relay; it does not require inbound access to the desktop.
- The Codex app-server remains local to the desktop agent over stdio and must not be exposed directly to the internet.
- The relay stores prompts, session events, messages, approvals, interaction requests, attachments, artifacts, logs, and final answers. Run it on infrastructure you trust.
- SQLite data is stored at `~/.echo-voice/echo.sqlite` by default, with attachments and artifacts under the same data directory. Back it up, prune it, or encrypt the host disk if session history is sensitive.
- The default sandbox is `workspace-write`. Allow `full`/`danger-full-access` only on a fully trusted personal machine and project.
- Worktree mode is off by default. When enabled, it requires a clean base Git workspace, and dirty worktrees are not automatically deleted.

### Development

```bash
pnpm install
pnpm run dev
```

Common checks:

```bash
pnpm run check:js
pnpm test
pnpm run check
```

`pnpm run check` runs JS syntax checks, shell syntax checks, and the Node test suite. For mobile PWA changes, prefer targeted non-e2e checks by default; do not run e2e unless explicitly needed.

Manual e2e:

```bash
pnpm run test:e2e:mobile
```

Network diagnostics:

```bash
pnpm run doctor:network
```

### Documentation

- [Quick skills](docs/quick-skills.md)
- [Mobile Codex remote plan](docs/mobile-codex-remote-plan.md)
- [Mobile Codex roadmap](docs/mobile-codex-roadmap.md)
- [Codex architecture risk tracker](docs/codex-architecture-risk-tracker.md)
- [Multi agent / multi model orchestration design](docs/agent-orchestration-design.md)

### License

[MIT](LICENSE)
