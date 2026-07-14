## ADDED Requirements

### Requirement: Running Command 必须可恢复
系统 SHALL 在 lease 过期或 Desktop 重连时核对 running command 的实际执行状态，避免重复执行或永久卡住。

#### Scenario: Lease 过期但 Desktop 仍在运行
- **WHEN** Relay 发现 running command lease 过期
- **THEN** Relay 进入 reconciliation 流程
- **AND** 不立即把同一命令并发租给第二个 Desktop

#### Scenario: Desktop 重启
- **WHEN** Desktop 用相同身份重新连接
- **THEN** Relay 可以询问已知 running command 的本地状态
- **AND** 根据结构化响应恢复或终止 Session

### Requirement: Command 与终态报告必须幂等
系统 SHALL 使用 command id、attempt 和稳定 event identity 去重重试。

#### Scenario: Completion 请求超时后重试
- **WHEN** Desktop 已完成本地执行但未收到 Relay 响应
- **AND** Desktop 重发相同 completion
- **THEN** Relay 返回同一终态结果
- **AND** 不重复追加终态事件或重新执行命令

### Requirement: 协议实现必须有 HTTP contract tests
系统 SHALL 用真实 Relay route 和可控 Desktop client 验证命令完整生命周期。

#### Scenario: 正常命令生命周期
- **WHEN** Desktop poll、lease、上报事件并 complete 命令
- **THEN** Relay Session、lease、events 和终态保持一致

#### Scenario: Desktop 断线后重连
- **WHEN** Desktop 在命令运行中断线后重新注册
- **THEN** 协议测试验证不会重复执行或永久卡住
