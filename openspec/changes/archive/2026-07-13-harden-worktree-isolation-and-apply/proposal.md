## Why

Echo 已经能够创建、复用、应用和丢弃 Session Worktree，但现有 Apply 只检查主 Workspace 是否干净，没有确认主分支 `HEAD` 仍等于创建 Worktree 时记录的 `baseCommit`。主分支在此期间产生新提交时，Echo 可能把 Worktree 文件直接覆盖回去而不报告冲突。

另一个问题是：用户明确选择隔离执行后，如果 Workspace 不是 Git 仓库或还没有初始提交，Desktop 会静默回退到主 Workspace。远程用户会以为任务在隔离环境中运行，实际却可能直接修改活动 checkout。

这两个问题都是 Worktree 后续 setup、cache 和 warm pool 之前必须完成的安全基线。

## What Changes

- Apply 前验证 Workspace 身份、当前分支、当前 `HEAD`、创建时 `baseCommit` 和工作区状态。
- 当基线已经移动时阻止直接复制，返回结构化冲突结果，不部分应用文件。
- 明确定义 Apply 的原子性、重复请求和失败恢复语义。
- 用户请求 Worktree 而客观条件不满足时，返回 `worktree.unavailable`，禁止静默回退主 Workspace。
- 手机端展示不可用原因、冲突摘要和可执行的恢复动作。
- 为创建、Apply、Discard 和 Cleanup 增加路径所有权与错误可见性测试。

## Capabilities

### Modified Capabilities

- `codex-worktree-execution`: Worktree 请求不再静默降级，Apply 具有基线和冲突保护。
- `mobile-session-workbench`: 手机端能够区分 Worktree 不可用、Apply 冲突和成功应用。

## Non-Goals

- 不在本 Change 中实现 setup profile、共享缓存或 warm pool。
- 不自动 merge、rebase、force apply 或覆盖用户的新提交。
- 不允许手机提供本机路径、Git 参数或 shell 命令。
- 不把 Worktree 改成默认执行模式。

## Impact

- Desktop agent：Worktree 创建和 Apply/Discard/Cleanup 状态机。
- Relay/store：结构化 Worktree failure/result 状态。
- Mobile PWA：不可用和冲突恢复 UI。
- Tests：Git 基线变化、失败原子性、路径所有权和重复动作。
