# OpenSpec 编排基础设施

本文记录 `add-open-spec-orchestration-plugin` 的运行边界。编排插件默认关闭；Desktop 开启受管 Worktree 后，可以从移动端插件设置启用，并在现有 OpenSpec 面板创建和观察编排。

## 所有权

Relay/SQLite 保存 desired state：

- Run、Item、Dependency、Attempt 和 bounded Artifact；
- 固定的 Desktop、Workspace、base branch、base commit 与 OpenSpec 摘要指纹；
- 原子 claim、lease、并发上限、暂停、继续、取消、重试和 reconciliation 状态；
- 面向移动端的 bounded snapshot、查询接口和 SSE 更新。

Desktop 保存 local fact：

- Workspace 是否仍在 allowlist；
- OpenSpec change 是否真实存在且未归档；
- Git branch、HEAD、受管 Worktree、commit 和冲突现场；
- Worktree metadata 中的 Desktop、Workspace、Run、Item 和基线身份。
- 选中 change 的本地文件快照、内容摘要和物化时间；change 可以包含 tracked、modified 或 untracked 文件，不要求用户预先提交。

手机只提交 Desktop/Workspace/change id 和依赖顺序，不提交本机路径、branch 名称、Git 参数或命令。可信 plan 由 Desktop 重新读取 OpenSpec 和 Git 后生成。

## Change 快照与当前 checkout

编排的 Git 基线仍固定为 Run 创建时的 branch 和 commit，但选中 OpenSpec change 的内容以 Desktop 在首次执行 Item 时物化的受控快照为准：

- Desktop 在专属 Worktree 中复制该 change 的完整目录，并记录 bounded（有界）文件数、字节数、内容摘要和计划指纹；
- 后续 retry（重试）复用同一快照，不从当前 checkout 重新复制，也不覆盖已有执行结果；
- 不自动提交当前 checkout，不把无关未提交文件卷入 change commit；
- 集成时，只有当前 checkout 中的 change 目录仍与原快照完全一致，Echo 才会用集成结果接管该目录；运行期间若用户又修改了它，Run 进入待处理而不是覆盖用户内容；
- 与该 change 无关的未提交文件不阻止创建、执行或 fast-forward（快进）集成。若它们与集成结果实际重叠，Git 的覆盖保护仍会阻止集成并保留现场。

这使“change 已经写好但尚未 git add/commit”成为正常主路径，同时保持当前 checkout 的其它工作不被隐式提交。

## Session 与 Attempt 边界

Attempt 是编排层的一次持久执行尝试；Session/Turn 是 backend 执行层。一个 Attempt 可以关联一个 Session，并在同一受管 Worktree 中 continuation，但不能通过 Session 的自然语言结果直接推导 Item `ready`。

进入 `ready` 至少需要：

- Desktop 可验证的 commit；
- bounded Git summary Artifact；
- validation Artifact；
- verifier Artifact 与结论。

纯人工、浏览器、移动端或视觉验收不属于自动编排的阻塞验证。执行 Session 必须将这类 checkbox 直接标记为完成，Desktop 也会在 validation（自动校验）前按同一策略收敛遗漏；它们作为统一提交、推送或部署后的人工复核事项在结果中说明。编排仍只运行仓库允许的非 e2e 自动测试，不会为了完成 checkbox 擅自运行 e2e。

现有普通 Session Worktree Apply 保持原有 base commit、当前分支和 dirty Workspace 预检。编排集成使用独立 Integration Worktree，不循环调用普通 Apply，也不修改当前 checkout。

## 恢复与停用

lease 过期后 Attempt 进入 `reconciling`，Item 和 Run 进入 `attention`；Relay 不自动在另一个 Worktree 重复派发。Desktop 重连后必须用 Session、Worktree metadata 和 commit 事实收敛状态。

停用编排时 Relay 与 Desktop 都会检查依赖和活跃工作。活跃工作存在时采用 drain 语义：禁止新工作，要求用户暂停、取消或等待当前 Attempt 到达安全边界；已有 Worktree 和 Artifact 不被删除。

## Rollout

当前版本提供生产调度循环、Attempt/Session 受管路径绑定、有限 repair、聚合校验和移动编排模式。`orchestration` 仍默认关闭，普通 OpenSpec 和 Session 行为不变；编排在目标 checkout 仍位于固定分支、固定 commit，且未提交内容不与集成结果冲突时自动 fast-forward 集成结果，基线变化时保留独立集成分支并进入待处理；系统不自动 push 或 Archive change。
