# open-spec-change-orchestration Delta

## MODIFIED Requirements

### Requirement: transient failure 可以自动恢复但不得无限重试

系统 SHALL 区分瞬态重试和需要理解失败证据的 Recovery，并 SHALL 由 Relay 统一输出当前可用动作。

#### Scenario: 确定性验收持续失败
- **WHEN** Item 的自动 Repair 已停止且最新失败仍是验收失败
- **THEN** 系统不把普通重试作为主要恢复动作
- **AND** 用户可以请求 Echo 基于失败摘要和 Artifact 创建有界 Recovery Attempt
- **AND** Recovery 后仍必须通过 Desktop 结构化校验和 commit 门禁

#### Scenario: Recovery 预算耗尽
- **WHEN** Item 已达到 Repair Attempt 上限
- **THEN** Relay 不再广告 recover 或 retry
- **AND** 用户仍可查看关联 Session 或结束整个 Run

### Requirement: 用户控制动作必须幂等并保留可恢复成果

系统 SHALL 支持暂停、继续、取消、瞬态重试、Agent Recovery 和结束批次，并 SHALL 保留所有已有成果与审计历史。

#### Scenario: 用户让 Echo 处理失败 Item
- **WHEN** Relay 广告 Item 的 recover 动作且用户确认
- **THEN** 系统只为该 Item 创建一个新的受管 Repair Attempt
- **AND** Agent 收到最新 failure class、错误摘要和 bounded Artifact

#### Scenario: 用户继续仍有待处理 Item 的 Run
- **WHEN** 用户解除 Run 暂停但仍存在 `attention` 或 `failed` Item
- **THEN** Run 保持待处理状态并显示适用的 Recovery 动作
- **AND** 系统不把没有可领取 Attempt 的 Run 标记为执行中

#### Scenario: 部分 Item 已由基线事实完成
- **WHEN** Run 同时包含 `completed` 和 `ready` Item
- **THEN** 系统允许创建 Integration Attempt
- **AND** Desktop 只集成 `ready` Item，不重放已经完成的 Item
- **AND** 全部 Item 都已 completed 时不创建空 Integration Attempt

#### Scenario: 用户结束无法继续的 Run
- **WHEN** 用户对非终态 Run 选择结束本批次
- **THEN** 系统停止新 Attempt 并将 Run 置为失败终态
- **AND** 已有 Worktree、Session、commit 和 Artifact 保留
- **AND** Run 不再占用活跃编排位置
