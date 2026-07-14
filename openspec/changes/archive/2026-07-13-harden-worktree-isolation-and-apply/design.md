## 背景

当前 Worktree 创建时已经记录 `baseCommit`，但 Apply 只是确认主 Workspace 没有未提交修改，然后逐文件复制 Worktree 变更。一个干净的 checkout 仍可能已经前进到不同提交，因此“干净”不等于“仍是创建时的基线”。

## 设计决策

1. **隔离请求必须 fail closed**
   - `worktreeMode=always` 表示用户明确要求隔离。
   - Desktop 无法创建 Worktree 时必须返回结构化不可用状态，不得改成 `off` 后继续执行。
   - 用户只有在手机端显式选择“改用主 Workspace”后，才能提交新的非隔离命令。

2. **Apply 使用预检与执行两个阶段**
   - 预检确认 Workspace id、Desktop agent id、Worktree ownership、受管根目录、base branch、base commit 和当前 HEAD。
   - 预检生成 bounded change/conflict summary。
   - 任一条件失败时不复制任何文件，状态变为 `apply-blocked`。

3. **不自动处理已移动基线**
   - `HEAD != baseCommit` 时返回 `base-advanced` 或 `base-diverged`。
   - v1 不自动 merge/rebase；手机可继续在 Worktree 中工作、丢弃，或在未来独立能力中选择显式合并。

4. **重复动作幂等**
   - 已成功 Apply 的重复请求返回原结果，不再次复制。
   - 已 Discard 的 Worktree 不能 Apply。
   - 网络重试不得产生部分重复写入。

5. **错误必须可见**
   - Cleanup 或 Git 操作失败不能被吞掉后标记成功。
   - Relay 保存错误码和 bounded 摘要；真实本机路径不进入用户可见 payload。

## 依赖关系

本 Change 是 `improve-worktree-runtime-experience` 的前置安全基线。后者继续负责 setup、cache、warm pool 和更完整的生命周期 UI。

## 验证

- 单元测试覆盖主分支未变化、前进、分叉、dirty、Worktree 丢失和重复请求。
- 集成测试确认失败 Apply 不会修改主 Workspace 中任何文件。
- 运行 `pnpm run check:js` 和 `pnpm test`，不运行 e2e。
