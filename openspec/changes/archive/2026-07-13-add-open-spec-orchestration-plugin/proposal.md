## Why

Echo 已经能在移动端查看 OpenSpec change，并为单个 change 创建 Apply、Sync、Validate 或 Archive 会话。但当 Workspace 积累多个待执行 change 时，用户仍要逐项启动会话、追踪执行、触发验收，再手动处理各个 Worktree 的落地。这迫使用户监督 Agent，而不是管理要完成的工作。

Echo 已具备持久 Session、SSE、取消、移动审批、Git 摘要、Desktop 受管 Worktree 和多 Backend 适配器。缺失的是一层以 OpenSpec change 为任务来源、能持续调度和收敛结果的编排能力，以及一个只在需要时出现的移动控制面。

这项能力不应增加 Echo 默认界面的复杂度。它应作为默认关闭的内建插件存在；启用后自然增强现有 OpenSpec 工作台，关闭后不留下入口、后台调度或无关状态。

## What Changes

- 增加默认关闭的内建 `orchestration` 插件，并声明其对 `open-spec` 插件和 Desktop Worktree capability 的依赖。
- 允许用户从现有 OpenSpec 工作台选择多个 change，由 Echo 给出一条可确认的执行路线。
- 增加持久化 Orchestration Run、Change Item、Attempt、Artifact 和依赖状态，支持有界并发、claim/lease、自动 continuation、失败退避与重启 reconciliation。
- 每个可写 change 在独立的 Desktop 受管 Worktree 中实现、验收并形成 commit；并行 change 不直接逐个 Apply 到当前 checkout。
- 增加串行 Integration Worktree，按确认顺序整合已验收 commit，处理基线前进、运行聚合校验，并产出独立的已提交集成分支。
- 增加极简移动编排工作台：默认只显示 change 名称、状态和轻量进度；详细任务、Agent transcript、测试日志和 Git 信息按需下沉。
- 支持暂停、继续、取消、重试和人工接管；只有审批、真实 blocker、不可自动解决的冲突或最终验收需要用户注意。
- 保留现有单项 OpenSpec 操作和 Session 工作台，不启用插件时行为不变。

## Capabilities

### New Capabilities

- `open-spec-change-orchestration`：把多个 OpenSpec change 作为一个可恢复批次进行隔离实现、验收、提交和集成。
- `mobile-orchestration-workbench`：从移动端创建、观察和控制编排，并以异常优先的极简界面完成验收。

### Modified Capabilities

- `mobile-desktop-plugin-management`：插件可以声明依赖与运行中停用语义，编排插件默认关闭。
- `mobile-open-spec-progress`：启用编排插件后，现有 OpenSpec 面板增加选择和编排状态，而默认 change list 做信息减法。
- `codex-worktree-execution`：增加面向编排的 Change Worktree 与 Integration Worktree，但不放宽既有单 Session Apply 的安全检查。

## Non-Goals

- 不建设任意 DAG、通用工作流引擎或完整的多 Agent 角色平台。
- 不从 Linear、GitHub Issues 或其它远程 tracker 自动发现任务。
- 不动态加载第三方 JavaScript、Shell 模块或任意插件代码。
- 不允许手机提交本机路径、Git 参数、CLI 参数或任意 sandbox 字符串。
- 不默认修改当前 checkout、自动 push、自动合并远端分支或自动 Archive OpenSpec change。
- 不在第一版提供复杂的成本优化、跨 Desktop 调度或同一 change 的多模型竞赛。
- 不运行 e2e 测试，除非用户明确要求。

## Impact

- Desktop agent：插件能力、调度 lease、受管 Change/Integration Worktree、commit、校验与恢复。
- Relay/store：新增持久 Run/Item/Attempt/Artifact 数据、控制 API、SSE 事件和迁移。
- Mobile PWA：OpenSpec 列表减法、选择/确认流程、运行概览与异常操作。
- Backend adapter：复用现有 Session/Turn 作为 Attempt 执行实现，不改变默认 Solo 路径。
- Tests：状态机、并发、重试、重启恢复、Git 集成安全、插件门禁与移动端非 e2e 行为。
