# open-spec-change-orchestration Specification

## Purpose
TBD - created by archiving change add-open-spec-orchestration-plugin. Update Purpose after archive.
## Requirements
### Requirement: 用户可以把多个 OpenSpec change 确认为一个持久编排
系统 SHALL 允许用户从同一 Desktop 广告的 Workspace 选择多个非归档 OpenSpec change，并在一次确认后创建带固定顺序、依赖、运行偏好和 Git 基线的 Orchestration Run。

#### Scenario: 用户确认执行路线
- **WHEN** 用户选择多个 change 并确认 Echo 提出的顺序与依赖
- **THEN** Relay 原子保存 Run 与 Change Item 快照
- **AND** Run 记录创建时的 Workspace、Desktop agent、base branch 和 base commit
- **AND** 运行期间新出现的 change 不会自动加入该 Run

#### Scenario: Change 不属于所选 Workspace
- **WHEN** 请求包含不在该 Workspace OpenSpec 摘要中的 change id
- **THEN** Relay 或 Desktop 拒绝创建 Run
- **AND** 手机不能提供路径绕过 Workspace allowlist

### Requirement: 编排调度必须有单一持久权威并防止重复执行
系统 SHALL 通过持久 Item/Attempt 状态、原子 claim 和可续租 lease 调度工作，并 MUST NOT 因重复请求、网络重试或短暂失联同时启动同一写入 Attempt。

#### Scenario: 两个调度 tick 同时发现可执行 Item
- **WHEN** 同一 Item 同时被两个调度路径判断为 ready
- **THEN** 只有一个路径获得 claim 和 lease
- **AND** 只创建一个写入 Session/Attempt

#### Scenario: Desktop 心跳短暂中断
- **WHEN** 一个运行中 Attempt 暂时停止续租
- **THEN** Relay 将其标记为等待 reconciliation，而不是立即重复派发
- **AND** Desktop 重连后根据 Session、Worktree metadata 和 commit 事实恢复或收敛状态

### Requirement: 调度必须遵守依赖和有界并发
系统 SHALL 只派发依赖已经完成的 Change Item，并 SHALL 同时遵守 Run 并发设置与 Desktop 广告的客观并发上限。

#### Scenario: 两个 change 互不依赖
- **WHEN** 两个 Item 都已就绪且至少有两个可用槽
- **THEN** 系统在不同受管 Worktree 中并行执行它们，直到填满 Run 与 Desktop 的较小并发上限

#### Scenario: 展示顺序不构成依赖
- **WHEN** 用户在确认页调整或确认 Item 的展示与集成顺序
- **AND** Item 没有显式 `dependsOn`
- **THEN** 系统保持这些 Item 彼此独立并可并行派发
- **AND** 不根据 affected spec 重叠或相邻位置推测依赖

#### Scenario: Change 等待依赖
- **WHEN** Item B 依赖的 Item A 尚未完成
- **THEN** Item B 保持 blocked/queued
- **AND** 不会创建 B 的写入 Session

#### Scenario: Desktop 广告并发容量
- **WHEN** Desktop 启动 N 个 orchestration worker 并在 capability 中广告 N
- **THEN** 手机创建 Run 时使用 N 作为默认 `maxConcurrency`
- **AND** Relay 仍将最终值限制在已知安全范围内

### Requirement: 单个 change 只有经过结构化验收并提交后才能进入集成
系统 SHALL 在 Change Worktree 中完成实现、验证和 commit，并 SHALL 使用 Desktop 生成的 Artifact 判定 readiness，而不是仅相信 Agent 最终回复。

#### Scenario: Agent 声称完成但校验失败
- **WHEN** Implement Attempt 正常结束但相关测试或 OpenSpec strict validation 失败
- **THEN** Item 不进入 `ready`
- **AND** 系统按策略创建有限 Repair Attempt 或转入 `attention`

#### Scenario: Change 验收通过
- **WHEN** Desktop 已记录 commit、Git summary、相关校验结果和 verifier 结论
- **THEN** Item 进入 `ready`
- **AND** Artifact 只包含大小有界的结果与引用

### Requirement: transient failure 可以自动恢复但不得无限重试
系统 SHALL 对可恢复的 Agent、网络或进程失败使用有上限的指数退避，并 SHALL 将需要用户输入、确定性校验失败和冲突转为可见待处理状态。

#### Scenario: Agent 进程暂时启动失败
- **WHEN** Attempt 因可恢复的启动错误失败
- **THEN** 系统在 bounded backoff 后复用同一 Item Worktree 重试
- **AND** 达到策略上限后停止自动派发并进入 `attention`

#### Scenario: Attempt 请求用户审批
- **WHEN** Backend 在非 full 权限模式下产生审批或交互请求
- **THEN** 请求通过现有移动审批能力显示
- **AND** 系统不会把等待用户响应误判为 stalled failure

### Requirement: 编排结果必须在独立 Integration Worktree 中串行收敛
系统 SHALL 从 Run 固定基线创建 Desktop 受管 Integration Worktree，并按确认顺序整合已验收 Item commit，而 MUST NOT 通过循环调用普通 Session Worktree Apply 修改当前 checkout。

#### Scenario: 多个并行 Item 已 ready
- **WHEN** 两个或多个 Item 从同一 base commit 独立完成
- **THEN** Desktop 在 Integration Worktree 中按确认顺序整合其 commit
- **AND** 用户当前 checkout 的 HEAD、index 和 working tree 保持不变

#### Scenario: 整合发生冲突
- **WHEN** 下一个 Item commit 无法干净整合
- **THEN** Integration 停止并进入 `attention`
- **AND** 手机收到 bounded 冲突文件摘要
- **AND** 系统不会产生部分成功的 completed Run

### Requirement: Run 完成需要通过聚合校验并安全合入固定目标分支
系统 SHALL 只在所有目标 Item 已整合、聚合校验通过且集成 commit 已安全 fast-forward 到 Run 固定目标分支后将 Run 标记为 completed。

#### Scenario: 聚合校验通过
- **WHEN** 所有 Item 已整合且聚合测试与 OpenSpec 校验通过
- **AND** 当前 checkout 仍位于固定 base branch、HEAD 等于固定 base commit 且 working tree/index 干净
- **THEN** Desktop 将集成 commit 以 fast-forward 方式自动合入当前 checkout
- **AND** Run 进入 `completed`
- **AND** 结果包含 bounded validation summary、集成分支和最终 commit
- **AND** 系统不自动 push 或 Archive change

#### Scenario: 用户在批次期间修改了目标 checkout
- **WHEN** 聚合校验通过但目标分支、HEAD、working tree 或 index 已偏离 Run 固定基线
- **THEN** 系统不执行合入并进入 `attention`
- **AND** 系统保留独立集成分支和 Worktree，不覆盖或回滚用户修改

#### Scenario: 聚合校验失败
- **WHEN** 独立 Item 均通过但组合后的校验失败
- **THEN** Run 进入 `attention` 或有限 Repair 流程
- **AND** 集成 Worktree 被保留以供自动修复或人工接管

### Requirement: 用户控制动作必须幂等并保留可恢复成果
系统 SHALL 支持暂停、继续、取消、重试和人工接管，并 SHALL 在重复移动请求或网络重试下保持幂等。

#### Scenario: 用户暂停 Run
- **WHEN** 用户请求暂停
- **THEN** 系统不再派发新 Attempt
- **AND** 正在执行的 Attempt 收敛到安全边界后保持暂停

#### Scenario: 用户取消 Run
- **WHEN** 用户确认取消
- **THEN** 系统阻止新 Attempt 并中断可安全取消的当前 turn
- **AND** 已有 Worktree、commit 和 Artifact 保留到用户选择清理或丢弃

#### Scenario: 用户下钻编排 Session
- **WHEN** 用户从 Run Item 打开其内部 Session
- **THEN** Session 工作台不显示普通 Worktree Apply 或 Discard 操作
- **AND** Worktree 生命周期继续由 Orchestration Run 自动管理
