## 1. Backend Event 基础保护

- [x] 1.1 为持久化 backend event 定义单事件大小上限。
- [x] 1.2 在写入前递归清理已知敏感 key，并保存 redacted/truncated 标志。
- [x] 1.3 确保 API、日志和 SSE replay 不重新暴露被清理的原值。

## 2. Attachment Staging

- [x] 2.1 将 runner 临时 attachment 移到 Echo data directory 的 Session 隔离目录。
- [x] 2.2 增加完成、失败、取消 cleanup 和启动时旧 staging 清理。
- [x] 2.3 用 realpath 校验将所有清理限制在受管根目录。
- [x] 2.4 删除 Workspace 内 `.echo-codex-attachments` 依赖。

## 3. 验证

- [x] 3.1 增加超大 event 和已知敏感 key 清理测试。
- [x] 3.2 增加 attachment 成功、失败、取消、启动恢复和路径穿越测试。
- [x] 3.3 验证 attachment 不改变 Workspace Git status 且不阻止 Worktree 创建。
- [x] 3.4 运行 `pnpm run check:js` 和 `pnpm test`。
- [x] 3.5 不运行 e2e，除非用户明确要求。
