## 权威模型

偏好主键为：

```text
ownerUser + targetAgentId + workspaceId
```

记录包含 `backendId`、`model`、`reasoningEffort`、`permissionMode`、`worktreeMode`、可选的受控 profile id、`version` 和 `updatedAt`。Relay 是持久化权威；Desktop runtime snapshot 是能力权威。

## 设计决策

1. 手机加载 Workspace 时并行读取 preference 与最新 capability，再生成有效 runtime。
2. 更新使用版本或 ETag 防止多个手机静默覆盖；冲突时返回最新记录供 UI 合并。
3. `localStorage` 旧值只迁移一次。Relay 已有记录时不得用旧本地值覆盖。
4. 离线时可显示缓存，但提交任务前必须让 Relay 用最新 capability 校验。
5. Echo 权限是 provider-neutral 值：`strict`、`approve`、`full`。Adapter 负责映射，不能让 UI 拼装 provider CLI 参数。
6. `full` 对 Codex 映射为 `danger-full-access + never`，对 Claude Code 映射为 `bypassPermissions`。
7. Backend 客观无法表达所选模式时返回 `runtime.permission.unsupported`，不改用另一模式或 backend。
8. Desktop capability 中历史 `allowedPermissionModes` 在迁移期只作兼容输入；新契约使用 `supportedPermissionModes` 表达真正技术限制。

## 安全边界

- Relay 校验 owner、agent 和 Workspace 绑定关系。
- Workspace 必须来自目标 Desktop 最新或允许短期过期的 capability snapshot。
- API 只接受枚举和已广告 id，不接受任意 path、shell 或 provider flag。

## 迁移

- 增加兼容数据库 migration。
- 手机首次加载时可上报旧本地偏好作为 `migrationCandidate`。
- Relay 仅在该主键无记录时接受候选值，随后手机删除旧的全局 runtime key。
- 旧客户端继续工作一段兼容窗口，但不能覆盖已有 Relay preference。
