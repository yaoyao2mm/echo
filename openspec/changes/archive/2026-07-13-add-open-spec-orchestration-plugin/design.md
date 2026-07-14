## 背景

Echo 的 OpenSpec 面板目前将每个 change 视为一个可单独操作的条目。点击 Apply 会创建一个普通执行 Session；Session 可以在独立 Worktree 中运行，但用户仍负责启动下一个 change、判断是否完成、请求 Apply，并在主 Workspace 基线变化后处理后续结果。

Symphony 证明了一种有效的执行模型：由单一调度权威持续 claim 工作、创建隔离 Workspace、运行 Agent、reconcile 外部状态，并在失败后重试。Echo 不应照搬它的 Linear tracker 或内存状态，而应复用自身的移动控制面、SQLite、Desktop allowlist、Backend adapter、Session/SSE 和 Worktree 安全边界。

## 目标

- 用户只需选择一批 OpenSpec change、确认一次路线，之后主要处理异常和最终结果。
- 并行实现不触碰当前 checkout，每个 change 都有可追溯的实现、验收与 commit 证据。
- Relay 或 Desktop 重启、网络中断和 transient failure 不会造成重复执行或丢失运行状态。
- 插件关闭时，Echo 的默认体验和资源消耗与今天一致。
- 移动工作台以状态扫描为主，不把调度器、Git 和 Agent 内部细节暴露为默认界面。

## 核心模型

### Orchestration Run

一次用户确认的批次，包含：

- `id`、`userId`、`targetAgentId`、`projectId`
- 创建时固定的 `baseBranch` 与 `baseCommit`
- `status`: `draft | queued | running | paused | attention | integrating | completed | failed | cancelled`
- 有界的 `runtimePolicy`：Backend、模型、权限 preset、最大并发、Worktree 模式
- `integrationPolicy`: 第一版固定为 `isolated-branch`
- 创建、开始、暂停、完成和取消时间

### Change Item

一个 Run 中的 OpenSpec change 快照：

- `changeId`、标题、排序位置和 `dependsOn`
- 创建时的 proposal/tasks/spec 摘要指纹
- `status`: `queued | blocked | preparing | implementing | verifying | ready | integrating | completed | attention | failed | cancelled`
- 当前 Attempt、最终 commit、验收结论和 bounded 错误摘要

OpenSpec 文件仍是需求与验收输入，但 Run 状态不能只靠 task checkbox 推断。任务勾选可能滞后，也可能由 Agent 修改；调度状态必须由 Echo 持久化。

### Attempt

一次具体执行尝试，关联现有 Echo Session：

- `kind`: `implement | verify | repair | integrate | aggregate-verify`
- `sessionId`、`attemptNumber`、lease owner/expiry
- 开始和结束状态、失败分类、下次重试时间

Session/Turn 继续属于 Backend 执行层。移动端可以从 Change Item 下钻到 Session，但 Orchestration Run 不应通过拼接 Session 状态临时推导。

### Artifact

结构化、大小有界的执行证据：

- Git summary 与 commit SHA
- 执行过的校验命令、退出状态和摘要
- OpenSpec strict validation 结果
- Reviewer/Verifier 结论
- 集成冲突摘要和最终分支信息

Relay 不保存完整本地日志、任意文件内容或 secret-heavy raw payload。

## 插件边界

新增内建插件：

```js
{
  id: "orchestration",
  name: "编排",
  version: "1.0.0",
  defaultEnabled: false,
  requires: ["open-spec"],
  capabilities: [
    "orchestration.plan",
    "orchestration.execute",
    "orchestration.integrate",
    "orchestration.mobile-workbench"
  ]
}
```

第一版继续采用 Echo 内建 registry，不动态加载插件代码。启用状态由 Desktop agent 持久保存和广告，Relay 与 Desktop 都必须在创建或执行命令时复核门禁。

依赖规则：

- `open-spec` 未启用或 Desktop 未广告受管 Worktree 时，`orchestration` 不可启用。
- 关闭 `open-spec` 前必须先关闭 `orchestration`。
- 运行中关闭编排采用 drain 语义：立即禁止新 Run 和新 Attempt，已执行的本地进程不会被开关动作粗暴终止；用户选择暂停、取消或等待当前 Attempt 收敛。
- 插件停用后保留历史 Run 结果，但默认工作台不展示编排入口或轮询活跃状态。

## 所有权与协调

### Relay 保存 desired state

Relay/SQLite 是 Run、Item、Attempt、依赖、用户控制意图和 bounded Artifact 的持久权威。它负责：

- 原子 claim，避免同一 Item 重复派发
- 有界并发和依赖就绪判断
- 暂停、取消、重试等 desired state
- SSE 快照与增量事件
- Desktop 失联后的 lease 过期与 reconciliation 标记

### Desktop 保存 local fact

Desktop 是本地事实和副作用的唯一权威。它负责：

- 验证 Workspace allowlist、Git identity 和插件状态
- 创建、复用和清理受管 Worktree
- 启动 Backend Session、执行校验和创建 commit
- 报告本地进程、Worktree、branch 和 Git 结果
- 对 Relay 下发的重复命令返回幂等结果

手机不能提交任意路径、Git 命令、hook 或 CLI 字符串。

### Lease 与 reconciliation

- 每个可执行 Item/Attempt 只能有一个未过期 lease。
- Desktop 定期续租并报告最近活动；Relay 不能仅因一次心跳失败立即重复派发。
- lease 过期后先进入 `attention/reconciling`，Desktop 重连时检查现有 Session、Worktree metadata 和 commit，再决定恢复、重试或标记失败。
- 状态不确定时 fail closed，绝不能在另一个 Worktree 重复开始同一写入 Attempt。
- transient failure 使用有上限的指数退避；用户输入、审批、确定性测试失败和 Git 冲突不进行无限自动重试。

## 调度与路线

第一版路线是一个有向无环的 change 依赖集合，但移动端不提供任意图编辑器：

- 用户选择 change 并可调整顺序。
- Echo 根据显式顺序、用户指定依赖和 change 影响范围给出建议路线。
- 自动推断只能生成建议，启动前由用户一次确认。
- 无依赖且满足并发槽的 Item 可以并行；默认最大并发为 2，并受 Desktop capability 上限约束。
- 依赖 Item 未完成时显示“等待”，不暴露 DAG、slot 或 claim 术语。
- 启动时固定 Run 的 base commit；运行期间新增 OpenSpec change 不会自动加入当前 Run。

## 单个 Change 生命周期

1. Desktop 从 Run base commit 创建受管 Change Worktree。
2. Implement Attempt 读取固定 change id 对应的 proposal、design、tasks 和 spec delta，在该 Worktree 中执行。
3. 若正常 turn 结束但验收尚未满足，调度器在同一 Session/Worktree 中发送精简 continuation；达到上限后进入 bounded retry 或 attention。
4. Verify Attempt 检查 change 的验收输入、相关测试和 `openspec validate <change> --strict`，并生成结构化 Artifact。
5. 验收失败时可以启动有限次数 Repair Attempt，再重新 Verify。
6. 通过后 Desktop 在 Change Worktree 创建一个或多个可追溯 commit，记录最终 commit SHA，Item 进入 `ready`。
7. 不自动 Archive change；Archive 是 Run 完成后的可选独立动作。

Agent 不得仅通过最终自然语言声称完成。进入 `ready` 至少需要 Desktop 可验证的 commit、Git summary 和 verifier 结论。

## Integration Lane

现有单 Session Worktree Apply 要求当前主 Workspace `HEAD` 等于 Worktree 创建时的 `baseCommit`。多个并行 change 从同一 base 创建后，第一个结果落地会使其余 Apply 变成 `base-advanced`。因此编排不循环调用现有 Apply。

设计如下：

1. Desktop 从 Run 的 `baseCommit` 创建专用 Integration Worktree 和 `echo/orchestration-<run-id>` 分支。
2. 按用户确认的稳定顺序，将每个 `ready` Item 的 commit 串行 cherry-pick 或等价重放到 Integration Worktree。
3. 冲突时停止 integration，保存 bounded 文件列表并进入 `attention`；可以由专用 Repair Session 在 Integration Worktree 中处理，或由用户人工接管。
4. 所有 change 整合后，运行聚合校验并记录 Artifact。
5. 校验通过后，Desktop 仅在当前 checkout 仍位于 Run 固定分支、`HEAD` 仍等于固定 `baseCommit` 且 working tree/index 干净时，将集成 commit `--ff-only` 合入该分支。
6. 安全合入成功后 Run 进入 `completed`；若分支、基线或 dirty 状态已变化则进入 `attention`，保留集成分支且不覆盖用户工作。
7. 编排 Session 的 Worktree 由 Run 独占管理，Session 工作台不提供普通 Apply/Discard；系统仍不自动 push 或 Archive。

Integration Worktree 仍受路径所有权、branch identity、幂等命令和 cleanup 保护。它是新的编排操作，不放宽 `applyCodexSessionWorktree` 的既有预检。

## 移动工作台

### 信息架构

OpenSpec 工作台保持一个表面，只增加三种互斥模式：

1. **浏览**：扫描 change 状态。
2. **选择**：选择 change 并进入路线确认。
3. **运行**：观察当前 Run，处理异常或下钻 Session。

不新增常驻顶层导航或独立仪表盘。插件关闭时只存在浏览模式。

### 减法约束

浏览列表每个 change 默认只显示：

- 名称
- 一个状态词或状态图标
- 一条不改变布局的轻量进度信号

以下内容不得同时出现在默认列表层：

- proposal 摘要
- affected spec 标签
- task checklist
- Apply/Sync/Validate/Archive 四个文字按钮
- Agent transcript、token、retry count
- Git 文件列表和测试日志

这些信息只在 change 详情、Session 详情或异常详情中按需出现。每个视图只保留一个主操作；正常状态不使用说明段落，异常状态最多显示一句可行动原因。

### 创建流程

- 顶部以单一“编排”命令进入选择态。
- 选择态只显示勾选、名称和已选数量，底部主操作为“下一步”。
- 确认态只显示顺序、必要依赖、并行开关和结果目标，主操作为“开始”。
- Backend、模型和权限默认继承当前 Workspace 持久偏好；只有不可满足或用户主动展开时才显示高级设置。

### 运行流程

- 顶部显示批次名称、完成数量和暂停/更多操作。
- Item 行只显示名称及 `等待 / 执行中 / 验收中 / 待处理 / 已提交 / 正在集成 / 完成` 等用户语言。
- 点击 Item 下钻到现有 Session 工作台，返回后保持 Run 上下文。
- 审批、交互请求、真实 blocker、Git 冲突和聚合校验失败进入统一“待处理”分组。
- SSE 是实时主路径，断线时使用 bounded polling fallback；缓存结果可显示为 stale，但不能把过期状态伪装成实时状态。

## 控制语义

- **暂停**：不派发新 Attempt；正在运行的 Attempt 默认允许收敛到安全边界。
- **继续**：重新计算依赖与可用槽，恢复派发。
- **取消**：中断可安全取消的当前 turn，阻止新 Attempt，保留 Worktree 与 Artifact 供检查；清理由用户另行确认。
- **重试**：只对选定失败 Item 创建新 Attempt，复用其受管 Worktree，不能另开不受控副本。
- **人工接管**：暂停该 Item 的自动派发并打开关联 Session/Worktree 上下文。

## 迁移与兼容

- 只追加 SQLite 表、索引和字段，兼容现有数据库。
- 新插件默认关闭，升级后 OpenSpec 与 Session 现有行为不变。
- 老 Desktop 未广告 orchestration capability 时，移动端完全隐藏入口。
- 历史普通 Worktree Session 不会自动转换为 Run Item。
- 删除或回滚插件 UI/调度器不应破坏普通 Session 数据；历史 Run 表可保留只读。

## 风险与缓解

- **并行 change 语义冲突**：通过确认路线、独立 commit、串行 Integration Worktree 和聚合校验收敛。
- **Agent 过早声称完成**：状态转移依赖结构化 verifier Artifact，不只依赖最终回复。
- **重启后重复写入**：持久 Attempt、lease、Desktop metadata 与幂等命令共同保护。
- **Relay 存储膨胀或泄露**：只保存 bounded 摘要和引用，不保存完整 transcript/test log。
- **移动 UI 重新变重**：将默认可见字段和禁止字段写入规格及非 e2e DOM 测试。
- **插件停用造成半完成工作**：使用 drain/pause 语义并保留受管 Worktree，不将开关等同于强制终止。

## 验证策略

- 状态机测试覆盖依赖、claim、并发、暂停、取消、retry/backoff 和终态幂等。
- migration 测试覆盖已有 SQLite 数据库升级。
- Desktop Git 测试覆盖独立 change commit、稳定集成顺序、冲突、聚合校验失败和 current checkout 不变。
- 插件测试覆盖默认关闭、依赖门禁、drain 和旧 Desktop 兼容。
- 移动端非 e2e 测试覆盖三种模式、默认信息预算、异常入口、SSE/poll fallback 和下钻返回。
- 运行 `pnpm run check:js` 和 `pnpm test`；除非用户明确要求，不运行 e2e。
