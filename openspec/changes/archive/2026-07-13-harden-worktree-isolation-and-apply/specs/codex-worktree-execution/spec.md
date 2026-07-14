## MODIFIED Requirements

### Requirement: 明确请求的 Worktree 隔离不得静默降级
系统 SHALL 在用户选择隔离 Worktree 后，要么在 Desktop 受管目录中执行，要么以结构化不可用状态停止本次启动。

#### Scenario: Workspace 不是 Git 仓库
- **WHEN** 用户以 Worktree 模式启动 Session
- **AND** Desktop 判断 Workspace 不是 Git 仓库
- **THEN** 本次命令不会在主 Workspace 中执行
- **AND** Session 显示 `worktree.unavailable` 及 `not-git` 原因

#### Scenario: Workspace 没有初始提交
- **WHEN** 用户以 Worktree 模式启动 Session
- **AND** Workspace 没有可用 `HEAD`
- **THEN** 本次命令不会静默改成非 Worktree 模式
- **AND** 用户必须显式选择其他执行方式

### Requirement: Apply 必须验证创建基线
系统 SHALL 只在主 Workspace 当前 `HEAD` 与 Worktree 记录的 `baseCommit` 一致且工作区干净时应用结果。

#### Scenario: 主分支产生了新提交
- **WHEN** Worktree 创建后主 Workspace 的 `HEAD` 已变化
- **AND** 用户请求 Apply
- **THEN** 系统返回 `apply-blocked`
- **AND** 不修改主 Workspace 文件
- **AND** 返回 bounded 的基线变化摘要

#### Scenario: 基线未变化
- **WHEN** 当前 `HEAD` 等于记录的 `baseCommit`
- **AND** 主 Workspace 干净且 ownership 校验通过
- **THEN** 系统应用 Worktree 结果
- **AND** 记录结构化 `worktree.applied` 结果

### Requirement: Worktree 终态动作必须幂等且可恢复
系统 SHALL 防止 Apply、Discard 和网络重试造成重复写入或互相冲突的终态。

#### Scenario: 重复发送 Apply
- **WHEN** 同一 Worktree 已经成功 Apply
- **AND** Relay 因网络重试再次发送 Apply
- **THEN** Desktop 返回原有成功结果
- **AND** 不再次复制文件

#### Scenario: Cleanup 失败
- **WHEN** Desktop 无法安全删除受管 Worktree
- **THEN** Session 保留 `cleanup-failed` 状态和 bounded 错误
- **AND** 系统不删除受管根目录以外的文件
