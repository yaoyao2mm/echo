## ADDED Requirements

### Requirement: 手机端必须展示 Worktree 完整生命周期
手机 SHALL 展示创建、setup、ready、running、failed、completed、applied、discarded 和 cleanup 状态。

#### Scenario: Setup 正在运行
- **WHEN** Desktop 正在准备 Session Worktree
- **THEN** transcript 或状态区显示 setup running
- **AND** composer 不误导用户认为 agent turn 已开始

#### Scenario: Setup 失败
- **WHEN** setup profile 失败
- **THEN** 手机显示 bounded 失败摘要
- **AND** 提供重试 setup、丢弃或 policy 允许的显式恢复动作

### Requirement: Follow-up 必须说明复用当前 Worktree
手机 SHALL 在隔离 Session 的 composer 中明确下一条 follow-up 将继续使用当前 Worktree。

#### Scenario: Worktree Session 已完成一个 Turn
- **WHEN** 用户准备发送 follow-up
- **THEN** composer 显示当前隔离状态和复用语义
- **AND** 不要求重新选择 Worktree mode

### Requirement: 完成后的 Worktree 必须可审查和处理
手机 SHALL 显示 changed files、diff stat、Apply、Discard 和 Continue 动作，并消费安全 Apply contract 的结果。

#### Scenario: Worktree 有未应用变更
- **WHEN** agent turn 完成并生成 Git summary
- **THEN** 手机显示变更摘要和显式 Apply/Discard 操作
- **AND** agent turn 完成不自动 Apply
