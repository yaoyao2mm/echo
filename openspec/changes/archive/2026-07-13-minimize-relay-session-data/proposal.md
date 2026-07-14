## Why

当前临时 attachment 会被 materialize 到项目目录。异常退出可能留下未跟踪文件，使活动 checkout 变脏并阻止 Worktree 创建。此外，持久化的 backend event 缺少统一的基础大小上限和敏感 key 清理。

这两个问题已经有明确的可靠性和隐私影响，可以直接修复；更完整的数据保留和 artifact 管理体系等出现实际需求后再设计。

## What Changes

- 将临时 attachment materialization 移到 Echo data directory，并按 Session/command 隔离。
- 在完成、失败、取消和启动恢复时清理受管 attachment staging。
- 为持久化 backend event 增加单事件大小上限，并清理已知敏感 key。
- 对截断和清理结果保留最小 metadata，避免消费者把摘要当作完整数据。

## Capabilities

### Added Capabilities

- `relay-session-data-minimization`: Attachment 不污染 Workspace，持久化 backend event 具有基础大小和敏感信息边界。

## Non-Goals

- 不删除用户明确需要的 Conversation 文本历史。
- 不建立完整的数据分类、保留期、引用计数或手动清理配置体系。
- 不引入新的 artifact storage 或 provider adapter。
- 不尝试检测所有 secret-shaped 字符串；只清理明确的敏感字段。

## Impact

- Event normalization/store：单事件上限、已知敏感 key 清理和最小 metadata。
- Desktop runner：仓库外 attachment staging 与 cleanup。
- Tests：超大 payload、敏感 key、异常残留和路径安全。
