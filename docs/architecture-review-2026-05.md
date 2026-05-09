# Echo 架构评审报告

**评审日期：** 2026-05-07
**评审人：** 架构评审
**项目版本：** HEAD (ecf748c)

---

## 一、项目概况

Echo 是一个**移动端 → 中继服务器 → 桌面代理**三层架构的远程 Codex/Claude Code 控制面。手机 PWA 发起任务，relay 负责鉴权和任务队列，desktop agent 是唯一触碰本地仓库的执行节点。

### 技术栈

- **运行时：** Node.js ≥20，纯 ES Module
- **服务端框架：** Express 4.x
- **数据库：** SQLite（better-sqlite3，WAL 模式）
- **前端：** 原生 JS PWA（无框架）
- **包管理：** pnpm workspace
- **测试：** Node 原生 test runner + Playwright（e2e）
- **依赖数：** 6 个运行时依赖

### 核心模块规模

| 模块 | 行数 | 职责 |
|------|------|------|
| src/lib/codexStore.js | 5081 | 数据库操作、session 生命周期、队列、审批状态机 |
| src/lib/codexInteractiveRunner.js | 1279 | Codex app-server 交互运行器 |
| src/server.js | 1036 | Express HTTP 服务（relay / local 两种模式） |
| src/desktop-agent.js | 608 | 桌面代理主循环（poll + execute + report） |
| src/lib/codexQueue.js | 380 | 内存事件总线 + 长轮询等待 |
| src/lib/codexRuntime.js | 321 | Runtime 能力归一化、权限映射、模型选择 |
| src/lib/backendAdapterContract.js | 289 | Backend adapter 契约定义与校验 |
| src/lib/config.js | 244 | 环境变量解析与配置组装 |
| public/app/*.js | 6175 | 移动端 PWA 前端 |
| test/*.test.js | 5384 | 19 个测试文件 |

---

## 二、架构亮点

### 2.1 安全边界设计正确

`AGENTS.md` 明确了核心安全原则："desktop agent 是唯一允许触碰本地仓库的进程"。这条原则在代码中有多层贯彻：

- **工作空间白名单** (`codexInteractiveRunner.js:578-599`)：`#workspaceFor()` 强制校验 projectId 必须在 `publicWorkspaces()` 白名单内
- **Worktree 路径隔离** (`codexInteractiveRunner.js:588-592`)：执行路径严格限定在 `worktreeRoot` 下，用 `isPathInside` 做路径穿越防护
- **权限交集策略** (`codexRuntime.js:150-166`)：`sanitizeRuntimeForAgent()` 将移动端请求的 runtime 参数与 agent 声明的能力做交集——手机不能越权选择 sandbox 模式或模型

### 2.2 Backend Adapter 契约层

`backendAdapterContract.js` 是新加入的最有价值的架构抽象：

- **三道防线**：`assertBackendAdapterContract` → `assertBackendRuntimeContract` → `assertBackendSnapshotContract`，分别在构造时校验 adapter 结构、runtime 行为、snapshot 数据，全部 fail-fast
- **版本化契约**：`backendAdapterContractVersion = "echo.backend-adapter.v1"` 为将来 breaking changes 留了后路
- **零耦合**：`desktopBackendRegistry.js` 只依赖契约接口，不耦合 Codex 或 Claude Code 的具体实现
- **Codex 和 Claude Code 两个 backend 并行存在**而互不污染

### 2.3 Runtime 能力归一化

`codexRuntime.js` 的能力模型设计考虑周全：

- `normalizeRuntimeBackend()` 统一不同 provider 的字段命名和结构
- `sanitizeRuntimeForAgent()` 是核心安全决策点，确保移动端请求不超越 agent 能力
- `permissionModeFromRuntime()` 覆盖了多个后端的不同命名惯例（`readonly`/`suggest` → `strict`，`approved`/`auto` → `approve`）
- 模型列表的 `supportedReasoningEfforts` per-model 粒度设计为后续按模型控制推理强度留了接口

### 2.4 Delta 事件缓冲

`codexInteractiveRunner.js:784-835` 中的流式事件缓冲机制：

- 将连续的 agent message delta 合并后再 flush 到 SSE
- `streamDeltaFlushDelayMs = 80ms` 和 `streamDeltaFlushMaxChars = 1200` 两个阈值配合使用：先达到者触发 flush
- 避免 SSE 通道被大量小事件淹没，同时保证 UI 感知不到明显延迟

### 2.5 数据存储选型

SQLite + WAL 模式是正确的选择：

- 单文件部署，零外部依赖，运维简单
- `better-sqlite3` 同步 API 简化了事务处理
- WAL 模式保证读写并发
- 对单机 relay 场景的规模来说完全足够

### 2.6 重试策略有区分度

`desktop-agent.js:548-567` 的 `createRetryBackoff`：

- 网络错误 → 指数退避（1.8x，上限 30s）
- 业务错误 → 固定间隔（2.5s）
- 不会在非网络错误上做无意义的长时间等待

### 2.7 设计文档先行

`docs/agent-orchestration-design.md` 质量高，明确了：
- 稳定性底线（Codex 路径不变、新 backend 增量接入、不破坏已有语义）
- 现有能力的复用路径
- 当前限制的诚实评估

---

## 三、需要关注的问题

### 3.1 【高优】codexStore.js 严重膨胀（5081 行）

这是当前最大的技术债。一个文件承担了全部数据库操作、session 生命周期、agent 管理、approval 状态机、file request 队列、quick skill CRUD、artifact/attachment 存储、事件存储、worktree 记录和 migration。

这已经不是一个"store"，而是一个单体 DAO 层。每次修改风险高，新人理解成本大。

**建议分拆：**

```
src/lib/store/
  schema.js          # DDL + migration
  sessions.js        # session CRUD + lifecycle
  agents.js          # agent registration / heartbeat
  approvals.js       # approval state machine
  messages.js        # message queue & events
  files.js           # file request lifecycle
  quick-skills.js    # quick skill CRUD
  artifacts.js       # attachment/artifact storage
```

拆分时 store 层对外暴露的接口保持不变（`codexQueue.js` 已有一层薄封装），对上游零影响。

### 3.2 【高优】配置缺少结构化验证

`config.js` 的 244 行主要是 env var 读取和回退逻辑，没有 schema 验证：

- `ECHO_CODEX_WORKTREE_MODE` 设为 `"yes"` 会静默 fallback 到 `"off"` 而不是报错
- relay 模式下如果 `ECHO_TOKEN` 为空，会生成随机 token 但没有任何警告
- `ECHO_CODEX_SANDBOX` 没有取值范围校验

**建议：** 启动时加 `validateConfig()` 函数，对安全相关字段做显式校验并 fail-fast。

### 3.3 【高优】两个 Backend Adapter 重复代码

`CodexBackendAdapter` 和 `ClaudeCodeBackendAdapter` 的 `refreshCapabilities` 逻辑几乎完全相同（~40 行中的 ~36 行），只有几个差异点：

- `modelCapabilitySource` 的取值不同（`"codex-app-server"` vs `"deepseek-models-api"` / `"config"`）
- `backendId` / `provider` / `backendName` 不同
- `capabilities` 常量不同

**建议：** 抽取 `BaseBackendAdapter`，子类只提供差异化配置。

### 3.4 【中优】长轮询 + EventEmitter 双通道竞态

`codexQueue.js` 用 `EventEmitter` 做内存内通知，同时 desktop agent 用 HTTP long polling 拉命令。`waitForEventValue` 中的"先 acquire 再注册监听器"模式能工作但脆弱：

- 如果有两个 session worker 并发 poll，事件路由的准确性依赖 agentId 过滤
- 事件类型字符串（`codex-session-command`、`codex-workspace-command`、`codex-file-request`）分散在各处，没有统一的事件类型枚举

**建议：** 引入统一的事件类型枚举，后续考虑用一个命令分发器按 agentId 做 fan-out。

### 3.5 【中优】缺少 relay ↔ agent 协议集成测试

测试覆盖偏重单元测试（`codex-queue.test.js` 1890 行），但 relay 和 desktop agent 之间的 HTTP 协议交互没有集成测试：

- poll → execute → complete → event append 的完整交互序列
- 命令超时/过期后的 relay 侧清理
- agent 重连后的状态恢复

**建议：** 加至少一个 contract test 覆盖端到端的命令生命周期。

### 3.6 【中优】Migration 策略不透明

`codexStore.js:34` 调用 `migrate()` 但没有显式的版本管理。随着 schema 演进，缺乏 migration 版本记录可能导致生产数据库不兼容。

**建议：** 引入 `schema_version` 表，每次 schema 变更对应一个版本号的 migration 步骤。

### 3.7 【低优】collaborationModePresets 缓存无失效

`codexInteractiveRunner.js:365-381` 中 plan mode preset 第一次获取成功后永久缓存，只有失败才标记 `collaborationModeUnavailable`。如果 Codex 升级后 plan mode 能力变化，不会被感知到，直到 desktop agent 重启。

**建议：** 加 TTL（例如 1 小时）或与 backend adapter 的 `refreshCapabilities` 周期挂钩。

### 3.8 【低优】前端复杂度在上升

`public/app/` 下 6175 行纯 JS PWA，目前管理着 session、SSE 流、文件浏览、runtime 选择、quick skill 等多个功能域。纯 DOM 操作在交互复杂度继续增长时会成为维护负担。

**建议：** 不是立即行动项，但后续如果再加功能域，考虑引入 Preact 等轻量框架来管理状态和 DOM 更新。

---

## 四、评分概要

| 维度 | 评分 | 说明 |
|------|------|------|
| 安全边界 | ★★★★☆ | 白名单、worktree 隔离、权限交集策略均正确实现 |
| 架构演进 | ★★★★☆ | Backend adapter 的引入时机和方式恰当，增量式演进策略可操作 |
| 代码组织 | ★★★☆☆ | store.js 膨胀是最大问题，其余模块边界清晰 |
| 可测试性 | ★★★☆☆ | 单元测试覆盖好，集成/契约测试不足 |
| 可运维性 | ★★★☆☆ | SQLite 选型好，但 migration 管理和配置验证缺失 |
| 前端架构 | ★★★☆☆ | 纯 JS PWA 目前够用，但复杂度在上升 |

---

## 五、改进优先级

| 优先级 | 事项 | 预期收益 |
|--------|------|----------|
| 立即 | 拆分 `codexStore.js` | 降低每次改动的风险，减少回归范围 |
| 短期 | 加配置 schema 校验 | 防止静默 fallback 导致的安全降级 |
| 短期 | 抽取 `BaseBackendAdapter` | 消除两个 adapter 的 90% 重复代码 |
| 中期 | 引入 migration 版本号管理 | 生产部署安全性 |
| 中期 | 加 relay ↔ agent 协议集成测试 | 协议正确性保障 |
| 长期 | 评估前端是否需要轻量框架 | 维护成本控制 |

---

## 六、总体评价

这是一个**架构意识很强**的项目。设计文档先行，安全边界明确，多 backend 扩展做得很克制——不为了"统一抽象"而破坏既有的 golden path。Backend adapter 契约层的引入是教科书级的增量演进：先定义契约，再让新 backend 适配，同时默认路径完全不受影响。

当前最紧迫的问题是 `codexStore.js` 的单体化趋势。5000+ 行的一个文件在每次改 session、approval、或 queue 逻辑时都是高风险操作。拆分它不会改变任何外部行为，但会显著降低维护成本和 bug 风险。

整体方向正确，工程纪律良好。
