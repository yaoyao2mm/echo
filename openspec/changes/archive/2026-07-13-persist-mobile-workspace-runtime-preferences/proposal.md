## Why

Echo 的权限、backend、model 和 Worktree 偏好目前主要保存在浏览器 `localStorage`。它既没有按用户、Desktop 和 Workspace 隔离，也不能在换手机、清理浏览器数据或切换 Conversation 后可靠恢复。

同时，历史字段 `allowedPermissionModes` 仍会被部分 Relay 和移动端逻辑当成 Desktop 授权上限。这与 Echo 的控制模型冲突：手机负责持久执行偏好，Desktop 只广告客观能力；用户选择 `full` 后应跨 Conversation 和兼容 backend 持续生效，直到用户主动修改。

## What Changes

- Relay 持久化 `user + desktop agent + workspace` 级 runtime preference。
- 手机从 Relay 读取并更新 backend、model、permission、reasoning 和 Worktree 偏好。
- 定义版本、并发更新、默认值、离线缓存和旧 `localStorage` 迁移语义。
- 将同一 Echo 权限偏好通过 adapter 映射到 Codex、Claude Code 等 backend。
- 删除 `allowedPermissionModes` 的日常授权上限语义；仅保留兼容读取或改名为客观支持字段。
- 不支持的 backend/model/权限组合明确报错，禁止静默降级或切换 backend。

## Capabilities

### Added Capabilities

- `workspace-runtime-preferences`: 用户的移动端 runtime 选择按 Desktop 和 Workspace 持久化并跨会话恢复。

### Modified Capabilities

- `desktop-agent-runtime-policy`: Desktop 广告客观支持能力，不保存或覆盖用户的日常权限偏好。

## Non-Goals

- 不在 Desktop UI 恢复 backend、model 或权限配置。
- 不允许手机提交任意 sandbox、approval policy、CLI flag、路径或 shell 字符串。
- 不把权限偏好扩展到另一个用户、Desktop 或 Workspace。

## Impact

- SQLite/migration：新增 Workspace runtime preference 存储。
- Relay API：读取、更新和校验偏好。
- Mobile PWA：Relay 为权威，`localStorage` 只作迁移与离线缓存。
- Backend adapters：明确 Echo permission mapping。
