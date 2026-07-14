## ADDED Requirements

### Requirement: 持久化 Backend Event 必须有基础边界
Relay SHALL 在写入 SQLite 前限制单个 backend event 的大小并清理已知敏感字段。

#### Scenario: Backend 返回超大 output
- **WHEN** backend event 超过单事件大小上限
- **THEN** Relay 只保存 bounded 摘要
- **AND** 记录数据已截断
- **AND** 不影响 terminal event 的状态语义

#### Scenario: Payload 包含凭证字段
- **WHEN** event 包含 authorization、cookie、token、secret、password 或 env 数据
- **THEN** 持久化前删除或遮盖敏感值
- **AND** 日志和 API 不包含原值

### Requirement: 临时 Attachment 不得污染 Workspace
Desktop SHALL 在 Echo 受管数据目录中 materialize attachment，而不是在用户 Workspace 内创建临时文件。

#### Scenario: Runner 使用图片附件
- **WHEN** Desktop 为本地 backend 准备手机上传的图片
- **THEN** 文件位于 Echo 受管 Session staging directory
- **AND** Workspace Git status 不因 staging 文件变化

#### Scenario: Desktop 异常退出
- **WHEN** attachment staging 在进程退出后残留
- **THEN** 启动恢复或 TTL cleanup 可以安全清理它
- **AND** cleanup 不访问受管根目录以外的文件

### Requirement: 数据截断必须对消费者可见
系统 SHALL 标识 payload 是否被截断、清理或转为 artifact。

#### Scenario: UI 展示截断事件
- **WHEN** Session event 只保留了 bounded 摘要
- **THEN** API 返回 truncation metadata
- **AND** 消费者不把摘要当作完整原始输出
