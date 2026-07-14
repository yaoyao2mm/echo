## 1. 数据模型与 API

- [x] 1.1 新增兼容 migration 和 Workspace runtime preference 表/索引。
- [x] 1.2 实现 owner + agent + workspace 范围的读取、创建和版本化更新 API。
- [x] 1.3 校验 Workspace、backend、model、权限和 Worktree 值来自目标 Desktop capability。
- [x] 1.4 增加并发版本冲突与审计时间字段。

## 2. 权限与 Backend 映射

- [x] 2.1 固化 `strict/approve/full` 的 provider-neutral 契约。
- [x] 2.2 为 Codex、Claude Code 和兼容 backend 添加显式映射与 unsupported 错误。
- [x] 2.3 删除 `allowedPermissionModes` 的授权上限行为，引入或迁移到 `supportedPermissionModes`。
- [x] 2.4 禁止 backend、model 或权限的静默 fallback。

## 3. 移动端迁移

- [x] 3.1 Workspace 切换时从 Relay 加载 preference 并与 capability 合成 UI 状态。
- [x] 3.2 设置变化即时保存到 Relay，并处理 loading、冲突、失败和重试。
- [x] 3.3 一次性迁移合法 `localStorage` runtime 值，Relay 已有记录时不覆盖。
- [x] 3.4 让 Conversation、follow-up 和 backend 切换复用 Workspace preference。

## 4. 验证

- [x] 4.1 增加用户、Desktop、Workspace 隔离和并发更新测试。
- [x] 4.2 增加 Codex/Claude 权限映射及 unsupported/fallback 拒绝测试。
- [x] 4.3 增加移动端非 e2e 的换 Workspace、换 Conversation、换 backend 和迁移测试。
- [x] 4.4 运行 `pnpm run check:js` 和 `pnpm test`。
- [x] 4.5 不运行 e2e，除非用户明确要求。
