# Design: OpenSpec 编排异常收敛

## 恢复决策边界

固定代码继续拥有状态转移和最终验收权威。Agent 只负责理解失败证据并修改受管 Worktree：

1. Relay 根据最新 Attempt 和 Run 状态输出 `availableActions`。
2. `retry` 只代表相同输入可合理恢复的瞬态失败。
3. `recover` 创建新的 `repair` Attempt，并把失败摘要、失败分类和 Artifact 交给 Agent。
4. Desktop 在 Agent 完成后重新运行相关非 e2e 测试与 OpenSpec strict validation。
5. 没有校验通过的 commit，Item 不能进入 `ready`。

这样 Agent 可以处理项目特有的过时任务或验收语义，但不能自行宣布 check 通过。

## 有界恢复

每个 Item 最多保留四次 Repair Attempt。自动 Repair 和用户触发的 Recovery 共用这个预算。预算耗尽后，Relay 不再广告 `recover`，移动端只保留查看 Session 和结束 Run。

旧的 `retry` API 保留兼容，但后端只对瞬态失败分类接受它。移动端完全依赖 `availableActions`，不维护 failure class 名单。

`resume` 只解除暂停意图，不得把仍含 `attention/failed` Item 的 Run 伪装为执行中。Relay 在事务内根据 Item 和 Integration Attempt 重新推导 Run 状态；需要 Recovery 时继续显示待处理。

为兼容旧版本已经写入的虚假 `running` 状态，调度轮询会幂等修复“运行中 Run 含待处理 Item”的不变量并发送 Run 更新，无需直接迁移或手工修改生产数据库。

## 历史成果收敛

基线 reconciliation 可能先把已经存在于目标分支的 Item 标记为 `completed`，同时其它 Item 仍是 `ready`。这种 `completed + ready` 混合态可以进入 Integration，但 Desktop 只集成 `ready` Item，不重放已由 Git 事实收敛的 `completed` Item。至少存在一个 `ready` Item 才能创建 Integration Attempt，避免空集成。

## 结束而非删除

`finish` 将非终态 Run 标记为 `failed`，停止新 Attempt 并取消仍在运行的内部 Session。已有 Worktree、commit、Artifact 和 Session 全部保留。它解决活跃列表永久卡住的问题，但不伪造成功，也不删除审计历史。

## 导航层级

- 浏览层：右上角是关闭按钮，关闭 OpenSpec 工作台。
- 选择层：左上角返回浏览层。
- 确认层：左上角返回选择层并保留选择。
- Run 详情：返回箭头回到 OpenSpec 浏览层；关闭按钮关闭整个 OpenSpec 工作台。
- Escape 与当前可见的返回/关闭语义一致。
