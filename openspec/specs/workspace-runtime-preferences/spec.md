# workspace-runtime-preferences Specification

## Purpose
TBD - created by archiving change persist-mobile-workspace-runtime-preferences. Update Purpose after archive.
## Requirements
### Requirement: Runtime 偏好按用户、Desktop 和 Workspace 持久化
Relay SHALL 为每个 `ownerUser + targetAgentId + workspaceId` 保存一份版本化 runtime preference。

#### Scenario: 新建 Conversation
- **WHEN** 用户在某 Workspace 将权限设为 `full`
- **AND** 随后在同一 Desktop 和 Workspace 新建 Conversation
- **THEN** 新 Conversation 默认使用已保存的 `full`
- **AND** 不要求 Desktop 再次授权

#### Scenario: 切换到另一个 Workspace
- **WHEN** 用户切换到同一 Desktop 的另一个 Workspace
- **THEN** 系统加载另一个 Workspace 自己的偏好
- **AND** 不继承前一个 Workspace 的权限

#### Scenario: 换手机登录
- **WHEN** 同一用户在另一台手机登录并选择相同 Desktop 和 Workspace
- **THEN** 手机从 Relay 恢复 runtime preference
- **AND** 不依赖原手机的 `localStorage`

### Requirement: Echo 权限跨兼容 Backend 保持语义一致
系统 SHALL 保存 provider-neutral 权限偏好，并由 adapter 映射到所选 backend。

#### Scenario: 从 Codex 切换到 Claude Code
- **WHEN** Workspace preference 为 `full`
- **AND** 用户从 Codex 切换到支持该模式的 Claude Code
- **THEN** Claude Code 使用 `bypassPermissions`
- **AND** preference 仍为 `full`

#### Scenario: Backend 不支持所选权限
- **WHEN** 用户选择的 backend 客观上无法表达当前权限模式
- **THEN** Relay 拒绝启动并返回明确错误
- **AND** 不静默降级权限或切换 backend

### Requirement: Desktop 只提供客观能力
Desktop SHALL 不使用日常默认权限或历史 allowlist 覆盖用户已经持久化的 Workspace preference。

#### Scenario: 旧 snapshot 包含 allowedPermissionModes
- **WHEN** Desktop 上报历史 `allowedPermissionModes`
- **THEN** Relay 将其视为兼容 metadata
- **AND** 不把它作为用户选择 `full` 的额外桌面授权门槛

### Requirement: 偏好更新支持并发和兼容迁移
系统 SHALL 防止旧浏览器状态或并发设备静默覆盖更新后的 Relay preference。

#### Scenario: 两台手机同时修改
- **WHEN** 客户端用过期版本更新 preference
- **THEN** Relay 返回版本冲突和最新记录
- **AND** 不静默覆盖较新的设置

#### Scenario: 首次迁移 localStorage
- **WHEN** Relay 尚无该 Workspace preference
- **AND** 手机有合法旧偏好
- **THEN** 系统可创建初始 Relay 记录
- **AND** 后续以 Relay 记录为权威
