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

- 手机/PWA 是主要控制面，负责记录任务、选择项目、选择 backend/model/权限、查看进度、发送 follow-up，以及处理仍然必要的交互。
- Relay 负责认证、排队、持久化会话状态、保存事件，并通过 SSE 把实时进度推送给手机。
- Desktop agent 是唯一能接触本机仓库、Git、worktree、文件系统和本地 agent runtime 的进程。
- Backend 是桌面 agent 暴露出来的执行能力，例如 Codex app-server、Claude Code，或通过 Claude Code 接入的 Anthropic-compatible 模型服务。

Echo 不是远程 shell。手机不能传任意本机路径，不能直接调用 shell endpoint，也不能直接访问 Codex app-server。所有真实执行都必须落在桌面端广告的 workspace 和 backend capability 内；日常 runtime 权限由移动端控制。

### 核心概念

| 概念 | 含义 |
| --- | --- |
| Desktop agent | 运行在你电脑上的本地守护进程，负责 workspace、Git、worktree、凭证和 backend 进程。 |
| Backend | 一个可执行的 agent runtime 集成，例如 Codex、Claude Code、DeepSeek via Claude Code。 |
| Model | 某个 backend 下可选择的模型；模型列表由桌面端探测或配置后广播给 relay 和手机。 |
| Workspace | 桌面端广告、创建，或经桌面端校验后从手机注册的项目目录。手机只能选择这些目录。 |
| Session | 手机端的一条 agent 会话，可以继续对话、取消 turn、在支持的 backend 上压缩上下文、归档恢复和查看结果。 |
| Runtime preference | 用户在手机上为某个 Desktop + Workspace 选择的 backend、model、权限模式和 worktree 偏好。 |

当前实现已经支持多个归属用户/电脑共享同一个 relay，并在同一桌面 agent 上注册多个 backend/profile；手机按目标电脑、workspace、backend、model 和权限模式创建会话。更高阶的多 agent 编排设计记录在 [agent orchestration design](docs/agent-orchestration-design.md) 中。

权限模式是 Workspace 级持久偏好。用户在手机上选择 `full` 后，该设置应跨 Conversation、Codex 和 Claude Code 持续生效，直到用户主动修改；Echo 不要求回到桌面重新授权，也不增加每轮或每个会话的确认。完整产品契约见 [移动端控制模型](docs/mobile-control-model.md)。

历史命名说明：仓库里部分脚本、环境变量和 macOS bundle 路径仍保留 `Codex` 或 `ECHO_CODEX_*` 前缀，这是为了兼容已有配置、脚本路径和数据库字段，不代表 Echo 只能运行 Codex。

### 后端能力矩阵

| 能力 | Codex app-server | 内置 Claude Code | Claude Code compatible profiles |
| --- | --- | --- | --- |
| 文本 turn | 是 | 是 | 是 |
| 上下文用量 | 是 | 是，前提是 CLI 输出 usage 数据 | 是，前提是该 profile 输出 usage 数据 |
| 远程上下文压缩 | 是 | 否 | 默认否，除非该 profile 明确实现 |
| 文件/截图附件 | 是 | 否 | 默认否，除非该 profile 明确实现 |
| 审批请求 | 是 | 否 | 默认否，除非该 profile 明确映射 |
| 交互请求 | 是 | 否 | 默认否，除非该 profile 明确映射 |
| Git 摘要 | 是 | 是 | 是 |
| worktree 执行 | 是 | 是 | 是 |

这张表描述的是默认能力，不是对某个 profile 的绝对承诺。桌面端广播的 runtime capability 才是最终准绳。

### 当前能力

- **多 backend / 多 model**：Codex 是默认 backend；可选启用 Claude Code；可用 `ECHO_AGENT_BACKENDS_JSON` 注册多个 Claude Code compatible profile，例如 DeepSeek Code、不同模型组或不同权限默认值。附件、审批、交互和上下文压缩能力是否可用，见上面的矩阵。
- **多用户 / 多桌面 agent**：桌面 agent 心跳会绑定 agent id、显示名、owner user 和 per-agent token；手机端按目标电脑 + workspace 创建 session，同名 workspace 不会互相覆盖。
- **桌面能力广播**：桌面 agent 会上报 backend roster、健康状态、支持模型、功能支持和 workspace 列表；relay 会校验所选能力客观存在，但 runtime 权限偏好由手机控制。
- **手机优先 PWA**：移动端任务输入、项目选择、backend/model/权限选择、会话列表、工作台、日志、审批、文件浏览、快速指令和深色模式。
- **实时会话**：支持新会话、继续会话、计划/执行模式、取消当前 turn、失败恢复、归档/恢复、在支持的 backend 上进行 context compaction 和最终回复查看。
- **SSE 进度流**：会话事件通过 SSE 实时推送，轮询保留为兼容兜底。
- **Agent transcript 渲染**：assistant 回复在手机端安全渲染 Markdown/GFM，包括标题、列表、表格、链接、代码块和 checklist；命令、文件修改、测试结果、Git 摘要和状态以 backend-neutral transcript part 展示，审批和交互问题按时间进入 transcript 并使用紧凑 decision controls，复制仍保留原始 Markdown/text。
- **审批与交互**：`full` 用于无人值守执行，不应产生 Echo 额外审批；在 `strict` / `approve` 或 backend 确实要求交互时，请求会转发到手机端处理。
- **受控 workspace**：手机只能选择桌面 agent 广告的 `ECHO_CODEX_WORKSPACES` 或桌面端创建的 managed workspace。
- **代码浏览**：手机端可列出和预览 allowlist workspace 内的文本文件；路径必须相对 workspace，敏感文件和越界 symlink 会被阻止。
- **文件/截图附件与产物**：支持附件的 backend 才会开放上传；relay 保存附件和 backend 产物元数据及内容引用，桌面 agent 会把上传附件转成本地文件路径交给 Codex 使用。
- **快速指令**：全局/项目级 quick skills 可复用常见 prompt；内置部署类指令仍走普通会话路径，不绕过权限边界。
- **Agent Skills 管理**：Quick Skills 是 Echo 内保存的 prompt 快捷指令；Agent Skills 是桌面端发现的本机 `SKILL.md` 能力；MCP 是工具连接。手机端可以启用/停用、控制是否显示在 composer Agent Skills 菜单，并把同一份 Skill 同步到 Codex、Claude Code 等本地 backend。
- **Git 摘要**：turn 完成后桌面端生成统一 `git.summary`，手机端可看到改动文件、统计和状态。
- **隔离 worktree**：默认关闭；启用后新会话可在桌面控制的 Git worktree 中执行，并可从手机端应用到主 checkout 或丢弃。
- **持久化队列**：SQLite 保存 session、event、message、approval、interaction、attachment、artifact、quick skill、agent heartbeat 和 lease。
- **macOS 桌面体验**：可生成本地 `Echo Codex.app`，提供精简的首次连接、配对二维码、连接状态、重启、网络诊断和更新入口；日常 agent 配置留在手机端。
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
- `scripts/`：Android USB 转发、macOS app/DMG 构建、网络诊断、更新和 relay 部署脚本。

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
ECHO_TOKEN=replace-with-a-long-random-phone-secret \
ECHO_AGENT_TOKEN=replace-with-a-long-random-agent-secret \
pnpm run relay
```

另一个终端在运行本地 backend 的电脑上启动 desktop agent：

```bash
ECHO_RELAY_URL=http://127.0.0.1:3888 \
ECHO_AGENT_TOKEN=replace-with-a-long-random-agent-secret \
ECHO_AGENT_ID=my-mac \
ECHO_AGENT_DISPLAY_NAME="My Mac" \
ECHO_AGENT_OWNER_USERNAME=owner \
ECHO_CODEX_WORKSPACES=echo=/absolute/path/to/project \
pnpm run desktop
```

手机打开：

```text
http://YOUR_LAN_IP:3888/?token=replace-with-a-long-random-phone-secret
```

#### 公网 relay

长期部署建议使用密码 hash，而不是把明文密码留在环境变量里：

```bash
printf '%s' 'replace-with-a-strong-password' | shasum -a 256
```

长期 agent token 也建议写入 hash，而不是把原始 token 留在 relay 配置中：

```bash
printf '%s' 'replace-with-a-long-random-agent-secret' | shasum -a 256
```

在服务器上配置 `.env`；手机 pairing token 可以先用 `ECHO_TOKEN` 引导登录，然后在 owner UI 里为每台手机生成 per-device token 并撤掉旧 token：

```bash
ECHO_MODE=relay
ECHO_PUBLIC_URL=https://your-domain.example
ECHO_TOKEN=replace-with-a-temporary-bootstrap-phone-secret
ECHO_AGENT_TOKENS_JSON='[{"tokenSha256":"replace-with-sha256-of-agent-secret","ownerUsername":"owner","agentId":"owner-mac","displayName":"Owner Mac"}]'

ECHO_AUTH_ENABLED=true
ECHO_AUTH_USERNAME=owner
ECHO_AUTH_PASSWORD_SHA256=replace-with-sha256-of-strong-password

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
ECHO_AGENT_TOKEN=replace-with-a-long-random-agent-secret \
ECHO_AGENT_ID=owner-mac \
ECHO_AGENT_DISPLAY_NAME="Owner Mac" \
ECHO_AGENT_OWNER_USERNAME=owner \
ECHO_CODEX_WORKSPACES=echo=/absolute/path/to/project \
pnpm run desktop
```

手机打开：

```text
https://your-domain.example/?token=replace-with-a-long-random-phone-secret
```

#### macOS 桌面应用

生成并打开本地 app：

```bash
pnpm run desktop:mac:app
```

桌面 app 是唯一的本机 agent 入口。配置、状态、网络检查、日志和重启都从 app 窗口或托盘菜单进入。

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
| `ECHO_TOKEN` / `ECHO_TOKEN_SHA256` | 旧式/引导手机配对密钥；共享 relay 建议改由 owner UI 创建 per-user/per-device token | 启动时随机生成 |
| `ECHO_PAIRING_TOKENS_JSON` | relay 侧预配置手机配对 token，可用 `tokenSha256` 绑定 `ownerUsername` | 空 |
| `ECHO_AGENT_TOKEN` / `ECHO_AGENT_TOKEN_SHA256` | 单 desktop agent token；relay 和对应桌面端需一致 | 回退到 `ECHO_TOKEN` 以兼容旧配置 |
| `ECHO_AGENT_TOKENS_JSON` | relay 侧多 desktop agent token 配置，可绑定 owner、agent id 和显示名；长期配置优先用 `tokenSha256` | 空 |
| `ECHO_AGENT_ID` / `ECHO_AGENT_DISPLAY_NAME` | desktop agent 的稳定机器标识和手机端显示名 | 本地生成 id / 空 |
| `ECHO_AGENT_OWNER_USERNAME` | desktop agent 归属用户；普通用户只能看到归属自己的 agent、workspace 和 session | 空 |
| `ECHO_AGENT_SHARED_SKILL_ROOT` | Echo shared Agent Skill registry；desktop agent 可从这里发现并同步到 backend skill root | `~/.echo-voice/skills` |
| `ECHO_AGENT_SKILL_ROOTS` | 额外只读 Skill 扫描 root，使用系统 path delimiter 分隔；只能由 desktop owner 配置，手机端不能传路径 | 空 |
| `ECHO_AUTH_ENABLED` | 是否开启网页登录 | 根据用户配置自动判断 |
| `ECHO_AUTH_USERNAME` / `ECHO_AUTH_PASSWORD_SHA256` | 单用户登录凭据；长期部署优先使用 SHA-256 密码 hash | 空 |
| `ECHO_USERS_JSON` | 多用户登录配置数组 | 空 |
| `ECHO_SESSION_SECRET` | Web session 签名密钥 | `ECHO_TOKEN` 或启动随机值 |
| `ECHO_SESSION_NOT_BEFORE` | 全局撤销旧 Web session 的时间戳，支持 ISO 或 epoch seconds | 空 |
| `ECHO_LOGIN_RATE_LIMIT_WINDOW_SECONDS` / `ECHO_LOGIN_RATE_LIMIT_MAX` | 登录失败限流窗口和最大次数 | `60` / `8` |
| `ECHO_USER_STORAGE_QUOTA_MB` / `ECHO_USER_STORAGE_QUOTA_BYTES` | 默认每用户附件和产物存储配额；owner UI 可覆盖单个用户 | `0`，不限制 |
| `ECHO_PROXY_URL` | 出站代理；macOS 可用 `system` | 环境代理或空 |
| `ECHO_NO_PROXY` | 代理绕过列表 | localhost、RFC1918、`.local` |

#### Workspace 和执行策略

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `ECHO_CODEX_WORKSPACES` | desktop agent 广告给手机的项目 allowlist | 当前目录 |
| `ECHO_CODEX_WORKSPACE_ROOT` | 手机端新建 managed workspace 的根目录 | 第一个 allowlist 项目的父目录，或 `~/workspace/projects` |
| `ECHO_CODEX_IMPORT_ROOTS` | 手机端“打开现有项目”可浏览的根目录，逗号分隔 | 已存在的常见代码目录：`~/workspace/projects`、`~/workspace`、`~/Projects`、`~/Developer`、`~/src`、`~/code`、`~/repos` |
| `ECHO_CODEX_SESSION_CONCURRENCY` | 桌面 session worker 数；同一非隔离 checkout 会自动串行 | `3` |
| `ECHO_CODEX_LEASE_MS` | relay 没收到更新多久后回收 running lease | `600000` |
| `ECHO_CODEX_TIMEOUT_MS` | 单次 backend 执行超时 | `1800000` |
| `ECHO_CODEX_RETRY_TRANSIENT_ERRORS` | 对 Codex 429/5xx 等上游临时错误自动重试 | `true` |
| `ECHO_CODEX_RETRY_DELAY_MS` | 每次自动重试前等待多久 | `60000` |
| `ECHO_CODEX_RETRY_MAX_ATTEMPTS` | 每个 start/message command 最多自动重试次数 | `2` |
| `ECHO_CODEX_RETRY_DOWNGRADE_REASONING` | 第二次及以后重试时推理强度降一档 | `true` |
| `ECHO_CODEX_MAX_EVENTS` | 每个 session 保留的最大事件数 | `500` |
| `ECHO_CODEX_WORKTREE_MODE` | `off`、`optional` 或 `always` | `off` |
| `ECHO_CODEX_WORKTREE_ROOT` | 隔离 worktree 根目录 | `~/.echo-voice/worktrees` |
| `ECHO_CODEX_WORKTREE_RETENTION_DAYS` | 自动清理超过保留期且 Git 状态干净的 worktree | `14` |

`ECHO_CODEX_WORKSPACES` 支持逗号分隔的 `label=/absolute/path`：

```bash
ECHO_CODEX_WORKSPACES=frontend=/absolute/path/to/frontend,api=/absolute/path/to/api
```

手机端“打开现有项目”不需要你回到桌面端逐个授权目录。desktop agent 默认会发布本机已存在的常见项目根目录；如果你的代码放在别处，可以用 `ECHO_CODEX_IMPORT_ROOTS=~/src,/Volumes/Code` 指定可浏览根目录。手机仍然只能发送 root id 和相对路径，desktop agent 会用 realpath 校验目录边界。带有 `.git`、`package.json`、`pyproject.toml`、`README` 等项目标记的目录会直接打开；普通文件夹会在手机端二次确认后打开。

多用户或多电脑共享同一个 relay 时，workspace 在手机端按 `agent_id + workspace_id` 区分。同一个 `echo` workspace 可以同时出现在 Alice Mac 和 Bob PC 上；手机会显示电脑名，创建 session、文件浏览、审批和归档都会带上目标 agent。普通 `user` 只能看到归属自己的 agent、workspace 和 session；`owner` 角色可以查看和管理所有归属。

Agent Skills 由 desktop agent 扫描本机 root：Echo shared registry `~/.echo-voice/skills`、Codex `$CODEX_HOME/skills` 或 `~/.codex/skills`、Claude Code `$CLAUDE_HOME/skills` / `$CLAUDE_CONFIG_DIR/skills` 或 `~/.claude/skills`，以及 desktop owner 配置的 `ECHO_AGENT_SKILL_ROOTS`。启用、隐藏和目标 backend 状态保存在 `~/.echo-voice/agent-skills.json`；多 profile/多 agent 使用 `~/.echo-voice/agent-skills-<agentId>.json`。

#### Backend 和 model

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `ECHO_CODEX_ENABLED` | 是否注册默认 Codex backend | `true` |
| `ECHO_CODEX_COMMAND` | Codex CLI 命令 | `codex` |
| `ECHO_CODEX_APP_PATH` | Codex App 内置 CLI 路径覆盖 | 空 |
| `ECHO_CODEX_SANDBOX` | Codex 默认 sandbox：`read-only`、`workspace-write`、`danger-full-access` | `workspace-write` |
| `ECHO_CODEX_APPROVAL_POLICY` | Codex 默认审批策略：`on-request` 或 `never` | `on-request` |
| `ECHO_CODEX_ALLOWED_PERMISSION_MODES` | 兼容字段；历史上用于桌面公布权限列表，不应作为移动端 Workspace 权限的授权上限 | `strict,approve,full` |
| `ECHO_CODEX_MODEL` | Codex 默认模型 | Codex 默认 |
| `ECHO_CODEX_REASONING_EFFORT` | Codex 默认推理强度 | 空 |
| `ECHO_CODEX_PROFILE` | Codex profile/权限模式默认值 | 空 |
| `ECHO_CLAUDE_ENABLED` | 是否启用内置 Claude Code backend | `false` |
| `ECHO_CLAUDE_COMMAND` | Claude Code CLI 命令 | `claude` |
| `ECHO_CLAUDE_BASE_URL` / `ANTHROPIC_BASE_URL` | Claude/Anthropic-compatible base URL | 空 |
| `ECHO_CLAUDE_AUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` | Claude/Anthropic-compatible token | 空 |
| `ECHO_CLAUDE_MODEL` | Claude Code 默认模型 | 空 |
| `ECHO_CLAUDE_SUPPORTED_MODELS` | Claude Code 可选模型列表 | `sonnet,opus`，DeepSeek URL 时为 DeepSeek 默认列表，Coding Plan URL 时为 Coding Plan 列表 |
| `ECHO_CLAUDE_ALLOWED_PERMISSION_MODES` | 兼容字段；不应覆盖移动端持久 Workspace 权限 | `strict` |
| `ECHO_VOLCENGINE_CODING_ENABLED` | 启用 Volcengine Coding Plan via Claude Code；没有显式 Claude/Anthropic-compatible 配置时接管内置 Claude Code backend，已有显式 Claude/DeepSeek 配置时自动新增独立 `volcengine-coding-plan` backend | `false` |
| `ECHO_VOLCENGINE_CODING_BACKEND_ID` | 显式 Claude/DeepSeek 配置同时存在时，自动新增的 Coding Plan backend id | `volcengine-coding-plan` |
| `ECHO_VOLCENGINE_CODING_BASE_URL` | Volcengine Coding Plan Anthropic-compatible base URL | `https://ark.cn-beijing.volces.com/api/coding` |
| `ECHO_VOLCENGINE_CODING_API_KEY` | Volcengine Coding Plan API key | 空 |
| `ECHO_VOLCENGINE_CODING_MODEL` | Claude Code 经 Coding Plan 使用的默认模型 | `ark-code-latest` |
| `ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS` | 覆盖 Coding Plan 可选模型列表 | 内置 Coding Plan 列表 |
| `ECHO_VOLCENGINE_CODING_PERMISSION_MODE` | Coding Plan 默认权限模式：`strict`、`approve`、`full` | `approve` |
| `ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES` | 兼容字段；不应作为移动端权限上限 | `strict,approve,full` |
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

启用后，desktop agent 会为 Claude Code 写入 Echo 管理的 `~/.echo-voice/claude-configs/.../settings.json` 并通过 `CLAUDE_CONFIG_DIR` 启动 `claude`。这和 CC Switch 的 provider 配置切换方式一致，能避免本机全局 `~/.claude/settings.json` 覆盖 Coding Plan 的 API 地址、token 或模型。环境变量中的权限值只提供兼容默认值；用户在手机上为 Workspace 选择的持久权限才是日常执行偏好。

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

手机是 runtime preference 的来源。桌面端公布 Workspace、backend、model 和功能等客观 capability；Relay 校验这些能力存在，并应用手机端持久的 Workspace 权限。切换 backend 不应重置权限或要求桌面确认。

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
- `ECHO_TOKEN` 现在只建议作为旧式/引导手机配对密钥；共享 relay 上优先用 owner UI 为每个用户/设备生成 pairing token，DB 只保存 hash。
- Desktop agent 轮询使用 owner UI 生成的 agent token、`ECHO_AGENT_TOKEN` 或 `ECHO_AGENT_TOKENS_JSON` 中的 per-agent token；DB token 只保存 hash，配置文件长期部署优先用 `tokenSha256`，只有未配置 agent token 时才回退到旧的 `ECHO_TOKEN` 兼容模式。
- 登录认证是 token 之外的 Web 访问门；长期部署优先使用 `ECHO_AUTH_PASSWORD_SHA256` 或 `ECHO_USERS_JSON[].passwordSha256`，避免保留明文密码。
- 登录失败会按 IP + 用户名限流；需要撤销所有旧 Web session 时，设置 `ECHO_SESSION_NOT_BEFORE` 到当前时间。
- `owner` 角色可以查看和管理所有 agent/session；普通 `user` 只能操作 owner_user 与自己匹配的 agent、workspace、session、附件、审批、交互和归档动作。
- Owner UI 可以创建/禁用/撤销用户 token、禁用用户、撤销用户 Web session、设置用户存储配额并删除某个用户的会话数据。
- 手机不能指定任意本机路径；项目来自 desktop agent allowlist 或桌面端创建的 managed workspace。
- 文件浏览只允许相对路径，限制在所选 workspace 内，并阻止敏感文件预览和越界 symlink。
- Quick skill 只是保存 prompt，不新增任意 shell/path API。
- Transcript renderer 禁用 raw HTML、危险链接协议、事件属性、inline style 和 Markdown 远程图片；agent 输出里的路径、命令和 shell 文本只作为文本或结构化摘要展示，不会变成手机端可执行操作。
- Transcript part 的稳定类型为 `text`、`command`、`file-change`、`test-result`、`git-summary`、`approval`、`interaction` 和 `status`。Backend adapter 应提供结构化状态，不得要求移动端从 assistant 文本猜测结果；命令输出、失败信息和文件列表在 relay/mobile 边界内有长度与数量上限，patch 正文不进入 file-change part。
- Desktop agent 只主动连接 relay，不需要把本机端口暴露到公网。
- Codex app-server 始终只在 desktop agent 本地通过 stdio 使用，不要直接暴露到公网。
- Relay 会保存 prompt、会话事件、消息、审批、交互请求、附件、产物、日志和最终回复；请部署在你信任的基础设施上。
- SQLite 数据默认位于 `~/.echo-voice/echo.sqlite`，附件和产物默认位于同一数据目录下；如包含敏感内容，请按需备份、清理或加密宿主机磁盘。
- `full`/`danger-full-access` 适合用户自己的可信电脑和 Workspace，并可直接在手机端设为持续偏好；它不会解除 Workspace allowlist、身份隔离或禁止任意 shell API 等永久边界。
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

部署 relay：

```bash
pnpm run deploy:relay -- user@your-server /opt/echo-codex
```

### 文档

- [移动端控制模型](docs/mobile-control-model.md)
- [Internet deployment](docs/internet-deploy.md)
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

- The phone/PWA is the primary control plane. It captures tasks, chooses projects, selects backend/model/permission options, reviews progress, sends follow-ups, and handles any interaction that remains necessary.
- The relay authenticates users, queues work, persists session state, stores events, and streams live progress to the phone over SSE.
- The desktop agent is the only process that can touch local repositories, Git, worktrees, filesystems, credentials, and local agent runtimes.
- A backend is an execution capability advertised by the desktop agent, such as Codex app-server, Claude Code, or a Claude Code connected Anthropic-compatible model endpoint.

Echo is not a remote shell. The phone cannot submit arbitrary local paths, call arbitrary shell endpoints, or connect to the Codex app-server. Execution stays within desktop-advertised workspaces and backend capabilities, while routine runtime permission is controlled from mobile.

### Core Concepts

| Concept | Meaning |
| --- | --- |
| Desktop agent | Local host process that owns workspaces, Git, worktrees, credentials, and backend processes. |
| Backend | Agent runtime integration, for example Codex, Claude Code, or DeepSeek via Claude Code. |
| Model | A selectable model under a backend; model lists are probed or configured by the desktop and advertised to relay/mobile. |
| Workspace | A desktop-allowed or desktop-created project directory. The phone can only choose these directories. |
| Session | A mobile-visible agent conversation that can continue, cancel turns, compact context on supported backends, archive/restore, and show results. |
| Runtime preference | Backend, model, permission mode, and worktree preferences selected on mobile for a Desktop + Workspace. |

The current implementation supports multiple owner users and desktop agents on one relay, plus multiple backend profiles on each desktop agent. Mobile sessions choose a target computer, workspace, backend, model, and permission mode. Higher-level multi-agent orchestration is tracked in [agent orchestration design](docs/agent-orchestration-design.md).

Permission is a persistent Workspace preference. Once the user selects `full` on mobile, it should continue across conversations and across Codex/Claude Code switches until the user changes it. Echo does not require a return to the desktop or add per-turn/per-conversation grants. See [Mobile Control Model](docs/mobile-control-model.md).

Naming note: some scripts, environment variables, and the macOS bundle path still keep `Codex` or `ECHO_CODEX_*` prefixes for compatibility with existing config, script paths, and database fields. That naming does not mean Echo can only run Codex.

### Backend Capability Matrix

| Capability | Codex app-server | Built-in Claude Code | Claude Code compatible profiles |
| --- | --- | --- | --- |
| Text turns | Yes | Yes | Yes |
| Context usage | Yes | Yes, when the CLI emits usage data | Yes, when the profile emits usage data |
| Remote context compaction | Yes | No | Default no, unless the profile explicitly implements it |
| File/screenshot attachments | Yes | No | Default no, unless the profile explicitly implements it |
| Approval requests | Yes | No | Default no, unless the profile explicitly maps them |
| Interaction requests | Yes | No | Default no, unless the profile explicitly maps them |
| Git summaries | Yes | Yes | Yes |
| Worktree execution | Yes | Yes | Yes |

The table above describes the default capability surface, not a promise that a specific profile can never differ. The runtime capability roster advertised by the desktop is the final source of truth.

### Current Capabilities

- **Multi-backend / multi-model**: Codex is the default backend. Claude Code can be enabled, and `ECHO_AGENT_BACKENDS_JSON` can register multiple Claude Code compatible profiles such as DeepSeek Code, different model groups, or different permission defaults. Attachment, approval, interaction, and compaction support varies by backend and is listed in the matrix above.
- **Multi-user / multi-desktop agents**: desktop heartbeats bind an agent id, display name, owner user, and per-agent token. Mobile creates sessions against a target computer + workspace, so duplicate workspace ids do not overwrite each other.
- **Desktop capability roster**: the desktop advertises backends, health, supported models, feature support, and workspaces. The relay verifies objective capability, while mobile owns runtime permission preferences.
- **Phone-first PWA**: mobile composer, project picker, backend/model/permission controls, session list, workbench, logs, approvals, file browser, quick skills, and dark mode.
- **Live sessions**: start sessions, continue sessions, choose plan/execute mode, cancel the active turn, recover failures, archive/restore, compact context on supported backends, and inspect final answers.
- **SSE progress stream**: session events stream over SSE with polling kept as fallback.
- **Agent transcript rendering**: assistant replies render safe Markdown/GFM on mobile, including headings, lists, tables, links, code fences, and checklists. Commands, file changes, test results, Git summaries, and statuses render as backend-neutral transcript parts; approvals and interactions enter the timeline at their request time and use compact decision controls. Copy actions keep the original Markdown/text.
- **Approvals and interactions**: `full` is intended for unattended execution and adds no Echo approval gate. In `strict` / `approve`, or when a backend genuinely requires interaction, requests are handled on mobile.
- **Controlled workspaces**: the phone can only choose `ECHO_CODEX_WORKSPACES` advertised by the desktop agent or desktop-created managed workspaces.
- **Code browsing**: the phone can list and preview text files inside allowlisted workspaces. Paths must be relative, sensitive previews are blocked, and symlinks cannot escape the workspace.
- **File/screenshot attachments and artifacts**: backends that support attachments expose uploads; relay stores attachment and backend artifact metadata plus content references, and the desktop agent turns uploaded attachments into local file paths for Codex.
- **Quick skills**: global/project prompts reuse common tasks through the normal session path and do not bypass permissions.
- **Agent Skill management**: Quick Skills are Echo-stored prompt shortcuts; Agent Skills are local `SKILL.md` capabilities discovered by the desktop; MCP is a tool connection. Mobile can enable/disable Agent Skills, control composer visibility, and sync one Skill to local backends such as Codex and Claude Code.
- **Git summaries**: after a turn completes, the desktop emits a unified `git.summary` so the phone can show changed files, stats, and status.
- **Isolated worktrees**: off by default. When enabled, new sessions can run in desktop-controlled Git worktrees and later be applied to the base checkout or discarded from mobile.
- **Persistent queue**: SQLite-backed sessions, events, messages, approvals, interactions, attachments, artifacts, quick skills, agent heartbeats, and leases.
- **macOS desktop experience**: a compact local `Echo Codex.app` for first connection, pairing QR, connection status, restart, network diagnostics, and updates; routine agent controls stay on mobile.
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
- `scripts/`: Android USB forwarding, macOS app/DMG builds, network diagnostics, update, and relay deployment scripts.

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
ECHO_TOKEN=replace-with-a-long-random-phone-secret \
ECHO_AGENT_TOKEN=replace-with-a-long-random-agent-secret \
pnpm run relay
```

Start the desktop agent on the computer that should run local backends:

```bash
ECHO_RELAY_URL=http://127.0.0.1:3888 \
ECHO_AGENT_TOKEN=replace-with-a-long-random-agent-secret \
ECHO_AGENT_ID=my-mac \
ECHO_AGENT_DISPLAY_NAME="My Mac" \
ECHO_AGENT_OWNER_USERNAME=owner \
ECHO_CODEX_WORKSPACES=echo=/absolute/path/to/project \
pnpm run desktop
```

Open the phone URL:

```text
http://YOUR_LAN_IP:3888/?token=replace-with-a-long-random-phone-secret
```

#### Internet Relay

For long-running deployments, prefer a password hash over a plaintext password:

```bash
printf '%s' 'replace-with-a-strong-password' | shasum -a 256
```

Prefer a hash for long-running agent tokens as well:

```bash
printf '%s' 'replace-with-a-long-random-agent-secret' | shasum -a 256
```

Create `.env` on the relay host. Use `ECHO_TOKEN` only to bootstrap the first phone, then create per-device pairing tokens from the owner UI and revoke/replace the bootstrap token:

```bash
ECHO_MODE=relay
ECHO_PUBLIC_URL=https://your-domain.example
ECHO_TOKEN=replace-with-a-temporary-bootstrap-phone-secret
ECHO_AGENT_TOKENS_JSON='[{"tokenSha256":"replace-with-sha256-of-agent-secret","ownerUsername":"owner","agentId":"owner-mac","displayName":"Owner Mac"}]'

ECHO_AUTH_ENABLED=true
ECHO_AUTH_USERNAME=owner
ECHO_AUTH_PASSWORD_SHA256=replace-with-sha256-of-strong-password

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
ECHO_AGENT_TOKEN=replace-with-a-long-random-agent-secret \
ECHO_AGENT_ID=owner-mac \
ECHO_AGENT_DISPLAY_NAME="Owner Mac" \
ECHO_AGENT_OWNER_USERNAME=owner \
ECHO_CODEX_WORKSPACES=echo=/absolute/path/to/project \
pnpm run desktop
```

Open the phone URL:

```text
https://your-domain.example/?token=replace-with-a-long-random-phone-secret
```

#### macOS Desktop App

Build and open the local app:

```bash
pnpm run desktop:mac:app
```

The desktop app is the only local agent entrypoint. Use the app window or tray menu for settings, status, network checks, logs, and restart.

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
| `ECHO_TOKEN` / `ECHO_TOKEN_SHA256` | Legacy/bootstrap phone pairing secret; for shared relays, prefer owner UI per-user/per-device tokens | random on startup |
| `ECHO_PAIRING_TOKENS_JSON` | Relay-side preconfigured phone pairing tokens; supports `tokenSha256` plus `ownerUsername` | empty |
| `ECHO_AGENT_TOKEN` / `ECHO_AGENT_TOKEN_SHA256` | Single desktop agent token; set the same value on the relay and that desktop | falls back to `ECHO_TOKEN` for legacy configs |
| `ECHO_AGENT_TOKENS_JSON` | Relay-side multi-agent token config with optional owner, agent id, and display name bindings; prefer `tokenSha256` for long-running config | empty |
| `ECHO_AGENT_ID` / `ECHO_AGENT_DISPLAY_NAME` | Stable desktop agent machine id and label shown on mobile | generated local id / empty |
| `ECHO_AGENT_OWNER_USERNAME` | Desktop agent owner; normal users only see agents, workspaces, and sessions owned by them | empty |
| `ECHO_AGENT_SHARED_SKILL_ROOT` | Echo shared Agent Skill registry discovered by the desktop and synced into backend skill roots | `~/.echo-voice/skills` |
| `ECHO_AGENT_SKILL_ROOTS` | Extra read-only Skill scan roots, separated by the system path delimiter; configured only by the desktop owner, never by mobile | empty |
| `ECHO_AUTH_ENABLED` | Enable browser login | inferred from user config |
| `ECHO_AUTH_USERNAME` / `ECHO_AUTH_PASSWORD_SHA256` | Single-user login credentials; prefer the SHA-256 hash for long-running deployments | empty |
| `ECHO_USERS_JSON` | Multi-user login config array | empty |
| `ECHO_SESSION_SECRET` | Web session signing secret | `ECHO_TOKEN` or startup random |
| `ECHO_SESSION_NOT_BEFORE` | Global revocation timestamp for older web sessions; ISO timestamp or epoch seconds | empty |
| `ECHO_LOGIN_RATE_LIMIT_WINDOW_SECONDS` / `ECHO_LOGIN_RATE_LIMIT_MAX` | Login failure rate-limit window and max attempts | `60` / `8` |
| `ECHO_USER_STORAGE_QUOTA_MB` / `ECHO_USER_STORAGE_QUOTA_BYTES` | Default per-user attachment/artifact storage quota; owner UI can override individual users | `0`, unlimited |
| `ECHO_PROXY_URL` | Outbound proxy; `system` follows macOS system proxy | env proxy or empty |
| `ECHO_NO_PROXY` | Proxy bypass list | localhost, RFC1918, `.local` |

#### Workspace And Execution Policy

| Variable | Description | Default |
| --- | --- | --- |
| `ECHO_CODEX_WORKSPACES` | Desktop-advertised project allowlist | current directory |
| `ECHO_CODEX_WORKSPACE_ROOT` | Root for mobile-created managed workspaces | first allowlisted workspace's parent, or `~/workspace/projects` |
| `ECHO_CODEX_IMPORT_ROOTS` | Comma-separated browse roots for mobile "Open existing project" | existing common code directories: `~/workspace/projects`, `~/workspace`, `~/Projects`, `~/Developer`, `~/src`, `~/code`, `~/repos` |
| `ECHO_CODEX_SESSION_CONCURRENCY` | Desktop session worker count; same non-isolated checkout is serialized | `3` |
| `ECHO_CODEX_LEASE_MS` | Relay lease recovery window without updates | `600000` |
| `ECHO_CODEX_TIMEOUT_MS` | Single backend execution timeout | `1800000` |
| `ECHO_CODEX_RETRY_TRANSIENT_ERRORS` | Automatically retry transient Codex upstream failures such as 429/5xx | `true` |
| `ECHO_CODEX_RETRY_DELAY_MS` | Delay before each automatic retry | `60000` |
| `ECHO_CODEX_RETRY_MAX_ATTEMPTS` | Maximum automatic retries per start/message command | `2` |
| `ECHO_CODEX_RETRY_DOWNGRADE_REASONING` | Lower reasoning effort by one level on the second and later retries | `true` |
| `ECHO_CODEX_MAX_EVENTS` | Maximum retained events per session | `500` |
| `ECHO_CODEX_WORKTREE_MODE` | `off`, `optional`, or `always` | `off` |
| `ECHO_CODEX_WORKTREE_ROOT` | Isolated worktree root directory | `~/.echo-voice/worktrees` |
| `ECHO_CODEX_WORKTREE_RETENTION_DAYS` | Prune old clean worktrees after this many days | `14` |

`ECHO_CODEX_WORKSPACES` accepts comma-separated `label=/absolute/path` entries:

```bash
ECHO_CODEX_WORKSPACES=frontend=/absolute/path/to/frontend,api=/absolute/path/to/api
```

When multiple users or computers share one relay, mobile treats a workspace as `agent_id + workspace_id`. The same `echo` workspace can appear on Alice Mac and Bob PC at the same time; the phone labels the target computer, and session creation, file browsing, approvals, and archive actions carry the target agent. Normal `user` accounts only see their own agents, workspaces, and sessions; `owner` can see and manage all owners.

Agent Skills are discovered by the desktop from local roots: Echo shared registry `~/.echo-voice/skills`, Codex `$CODEX_HOME/skills` or `~/.codex/skills`, Claude Code `$CLAUDE_HOME/skills` / `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills`, plus desktop-owner configured `ECHO_AGENT_SKILL_ROOTS`. Desired enablement, composer visibility, and target backend state live in `~/.echo-voice/agent-skills.json`; multi-profile/multi-agent runs use `~/.echo-voice/agent-skills-<agentId>.json`.

#### Backend And Model

| Variable | Description | Default |
| --- | --- | --- |
| `ECHO_CODEX_ENABLED` | Register the default Codex backend | `true` |
| `ECHO_CODEX_COMMAND` | Codex CLI command | `codex` |
| `ECHO_CODEX_APP_PATH` | Override path to the Codex App bundled CLI | empty |
| `ECHO_CODEX_SANDBOX` | Codex default sandbox: `read-only`, `workspace-write`, `danger-full-access` | `workspace-write` |
| `ECHO_CODEX_APPROVAL_POLICY` | Codex default approval policy: `on-request` or `never` | `on-request` |
| `ECHO_CODEX_ALLOWED_PERMISSION_MODES` | Compatibility field; must not cap the persistent mobile Workspace permission | `strict,approve,full` |
| `ECHO_CODEX_MODEL` | Codex default model | Codex default |
| `ECHO_CODEX_REASONING_EFFORT` | Codex default reasoning effort | empty |
| `ECHO_CODEX_PROFILE` | Codex profile/permission-mode default | empty |
| `ECHO_CLAUDE_ENABLED` | Enable the built-in Claude Code backend | `false` |
| `ECHO_CLAUDE_COMMAND` | Claude Code CLI command | `claude` |
| `ECHO_CLAUDE_BASE_URL` / `ANTHROPIC_BASE_URL` | Claude/Anthropic-compatible base URL | empty |
| `ECHO_CLAUDE_AUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` | Claude/Anthropic-compatible token | empty |
| `ECHO_CLAUDE_MODEL` | Claude Code default model | empty |
| `ECHO_CLAUDE_SUPPORTED_MODELS` | Claude Code selectable model list | `sonnet,opus`, DeepSeek defaults for DeepSeek URLs, or Coding Plan defaults for Coding Plan URLs |
| `ECHO_CLAUDE_ALLOWED_PERMISSION_MODES` | Compatibility field; must not override mobile Workspace permission | `strict` |
| `ECHO_VOLCENGINE_CODING_ENABLED` | Enable Volcengine Coding Plan through Claude Code; without explicit Claude/Anthropic-compatible config it takes over the built-in Claude Code backend, and with explicit Claude/DeepSeek config it auto-adds a separate `volcengine-coding-plan` backend | `false` |
| `ECHO_VOLCENGINE_CODING_BACKEND_ID` | Backend id for the auto-added Coding Plan backend when explicit Claude/DeepSeek config also exists | `volcengine-coding-plan` |
| `ECHO_VOLCENGINE_CODING_BASE_URL` | Volcengine Coding Plan Anthropic-compatible base URL | `https://ark.cn-beijing.volces.com/api/coding` |
| `ECHO_VOLCENGINE_CODING_API_KEY` | Volcengine Coding Plan API key | empty |
| `ECHO_VOLCENGINE_CODING_MODEL` | Default model for Claude Code through Coding Plan | `ark-code-latest` |
| `ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS` | Override the Coding Plan selectable model list | built-in Coding Plan list |
| `ECHO_VOLCENGINE_CODING_PERMISSION_MODE` | Coding Plan default permission mode: `strict`, `approve`, `full` | `approve` |
| `ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES` | Compatibility field; must not act as a mobile permission cap | `strict,approve,full` |
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

When enabled, the desktop agent writes an Echo-managed `~/.echo-voice/claude-configs/.../settings.json` and launches `claude` with `CLAUDE_CONFIG_DIR`. This mirrors the provider-config switching model used by CC Switch and prevents a global `~/.claude/settings.json` from overriding the Coding Plan API URL, token, or model. Environment permission values are compatibility defaults; the persistent Workspace preference selected on mobile controls routine execution.

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

Mobile is the source of runtime preferences. The desktop advertises objective Workspace, backend, model, and feature capabilities; the Relay verifies those capabilities and applies the persistent mobile Workspace permission. Backend switches must not reset permission or require desktop confirmation.

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
- Treat `ECHO_TOKEN` as a legacy/bootstrap phone pairing secret. On shared relays, create per-user/per-device pairing tokens in the owner UI; DB-backed tokens are stored hash-only.
- Desktop agent polling uses an owner UI generated agent token, `ECHO_AGENT_TOKEN`, or a per-agent token from `ECHO_AGENT_TOKENS_JSON`; DB-backed tokens are stored hash-only, long-running config should prefer `tokenSha256`, and legacy `ECHO_TOKEN` fallback is used only when no agent token is configured.
- Browser login is an additional web gate on top of the token. For long-running deployments, prefer `ECHO_AUTH_PASSWORD_SHA256` or `ECHO_USERS_JSON[].passwordSha256` instead of keeping plaintext passwords in the environment.
- Failed login attempts are rate-limited by IP + username. Set `ECHO_SESSION_NOT_BEFORE` to the current time to revoke older web sessions.
- The `owner` role can see and manage all agents/sessions. Normal `user` accounts can only operate resources whose owner_user matches them, including agents, workspaces, sessions, attachments, approvals, interactions, and archive actions.
- The owner UI can create/disable/revoke user tokens, disable users, revoke user web sessions, set per-user storage quotas, and delete one user's relay-side session data.
- The phone cannot choose arbitrary local paths; projects come from the desktop agent allowlist or desktop-created managed workspaces.
- File browsing only accepts relative paths inside the selected workspace and blocks sensitive previews and escaping symlinks.
- Quick skills are saved prompts only; they do not add arbitrary shell/path APIs.
- The transcript renderer disables raw HTML, dangerous link protocols, event attributes, inline styles, and Markdown remote images. Paths, commands, and shell output from an agent are displayed only as text or structured summaries, never as executable mobile actions.
- Stable transcript part types are `text`, `command`, `file-change`, `test-result`, `git-summary`, `approval`, `interaction`, and `status`. Backend adapters provide structured status instead of asking mobile to infer results from assistant prose. Command output, failures, and file lists are bounded across relay/mobile boundaries, and patch bodies are excluded from file-change parts.
- The desktop agent only opens outbound connections to the relay; it does not require inbound access to the desktop.
- The Codex app-server remains local to the desktop agent over stdio and must not be exposed directly to the internet.
- The relay stores prompts, session events, messages, approvals, interaction requests, attachments, artifacts, logs, and final answers. Run it on infrastructure you trust.
- SQLite data is stored at `~/.echo-voice/echo.sqlite` by default, with attachments and artifacts under the same data directory. Back it up, prune it, or encrypt the host disk if session history is sensitive.
- `full`/`danger-full-access` is appropriate for a trusted personal machine and Workspace and may be a persistent mobile preference. It does not remove permanent boundaries such as the Workspace allowlist, identity isolation, or the ban on arbitrary shell APIs.
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

Deploy the relay:

```bash
pnpm run deploy:relay -- user@your-server /opt/echo-codex
```

### Documentation

- [Mobile control model](docs/mobile-control-model.md)
- [Internet deployment](docs/internet-deploy.md)
- [Quick skills](docs/quick-skills.md)
- [Mobile Codex remote plan](docs/mobile-codex-remote-plan.md)
- [Mobile Codex roadmap](docs/mobile-codex-roadmap.md)
- [Codex architecture risk tracker](docs/codex-architecture-risk-tracker.md)
- [Multi agent / multi model orchestration design](docs/agent-orchestration-design.md)

### License

[MIT](LICENSE)
