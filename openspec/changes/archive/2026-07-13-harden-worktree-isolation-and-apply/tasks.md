## 1. 隔离启动语义

- [x] 1.1 将非 Git、无 HEAD、dirty base 和创建失败归一化为结构化 `worktree.unavailable` 原因。
- [x] 1.2 删除明确 Worktree 请求到主 Workspace 的静默 fallback。
- [x] 1.3 在手机端提供“修复后重试”与显式“改用主 Workspace”入口，后者创建新的非隔离命令。

## 2. Apply 安全

- [x] 2.1 Apply 前校验 agent、Workspace、受管根目录、Session ownership、base branch 和 `baseCommit`。
- [x] 2.2 比较主 Workspace 当前 `HEAD` 与 `baseCommit`，区分 advanced、diverged、dirty 和 missing ref。
- [x] 2.3 实现失败不部分写入的预检/执行边界，并返回 bounded change/conflict summary。
- [x] 2.4 让 Apply/Discard 重复请求幂等，防止网络重试重复写入。

## 3. 状态与移动端

- [x] 3.1 持久化 `unavailable`、`apply-blocked`、`applied`、`discarded`、`cleanup-failed` 状态和稳定错误码。
- [x] 3.2 手机端显示不可用原因、基线冲突和恢复动作，不显示真实本机路径。
- [x] 3.3 Cleanup/Git 删除失败必须上报，禁止吞错后标记成功。

## 4. 验证

- [x] 4.1 增加 HEAD 未变化、前进、分叉、dirty 和无 HEAD 的 Worktree 测试。
- [x] 4.2 增加 Apply 失败零文件修改、重复 Apply/Discard 和越界路径测试。
- [x] 4.3 增加移动端非 e2e 状态与恢复动作测试。
- [x] 4.4 运行 `pnpm run check:js` 和 `pnpm test`。
- [x] 4.5 不运行 e2e，除非用户明确要求。
