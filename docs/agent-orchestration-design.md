# 多 Agent / 多模型编排设计

这份文档讨论 Echo 下一阶段的能力边界：从“手机远程指挥单个本地 Codex”扩展为“可以像带一个 team 一样编排多个 agent、多个模型和多个执行角色”。

这里的关键不是再加一个模型下拉框，而是把 Echo 从单一运行器升级成一个可编排的执行平面。

优先级上，这是一份稳定优先的设计：现有 Codex 路径是 golden path，新 backend 只能作为增量能力接入，不能改变默认行为或破坏已有会话、审批、SSE、worktree 和 Git 摘要流程。

## 1. 设计目标

Echo 未来应该支持三件事：

1. 让用户描述目标，而不是强迫用户先理解每个 agent / model 的细节。
2. 让 Echo 根据任务类型、workspace、权限策略、可用能力和预算，选择一个或多个合适的 agent 与模型。
3. 让用户在需要时可以手动指定“哪个 agent 用什么模型做哪一步”，并且这种指定必须受 desktop policy 约束。

最终体验应该像这样：

- 用户发起一个任务，例如“重构登录流程并补测试”。
- Echo 可以自动拆成 planner / implementer / reviewer / verifier。
- 不同角色可以用不同模型，甚至来自不同 backend。
- 如果用户想手动控制，也可以指定某一步必须由某个 agent 或某个模型完成。
- 所有真正触碰本地仓库、worktree、Git 和 Codex/CLI 的动作，仍然必须由 desktop host 负责。

### 稳定性底线

- 当前 Codex 路径必须保持可用，且在没有显式新 backend 选择时仍然是默认路径。
- 新 backend 必须通过 adapter 接入，不能直接进入 relay、UI 或数据库的核心假设。
- 新能力默认是增量，不允许以“统一抽象”为名改变已有会话、turn、审批或事件语义。
- 新 backend 的失败不能拖垮现有 Codex 流程，系统必须随时能退回到当前实现。
- 早期数据库和 API 只能追加字段和表，不做破坏性重命名或删改。

## 2. 现有基础

当前实现已经有一些可以直接复用的基础，这意味着这不是从零开始重写，而是把现有单机 Codex 运行层推广成通用执行层。

### 已有的关键能力

- `src/lib/codexRuntime.js` 已经在做 capability 归一化，包括 `supportedModels`、`allowedPermissionModes`、`worktreeMode`、`sandbox`、`approvalPolicy`。
- `src/lib/codexStore.js` 已经把 agent、session、runtime、execution、memory 都放进了 SQLite。
- `src/desktop-agent.js` 已经在做 agent heartbeat、workspace advertisement、model probe、worktree preparation、session command polling。
- `src/lib/codexInteractiveRunner.js` 已经非常接近“一个 backend adapter”的形态，只是目前只适配 Codex app-server。
- 当前 UI 也已经能展示 runtime 选择、worktree 切换、模型可用性和权限模式可用性。

### 当前限制

- 现有系统把“desktop host”与“Codex backend”绑定得太紧。
- `agent`、`session`、`runtime` 这几个概念还没有完全 provider-neutral。
- 模型能力主要是“这个 host 上的 Codex 支持什么”，而不是“这个 host 上的多个 backend 各自支持什么”。
- 目前的调度仍然偏单任务、单链路，尚未形成显式的 task graph。

### 当前实现

- desktop agent 已经通过 `CodexBackendAdapter` 创建 interactive runtime，不再直接依赖 `CodexInteractiveRuntime` 作为系统边界。
- relay 和 SQLite runtime 记录现在保留 `backendId`、`provider` 和 `backendName`，为后续多 backend 路由预留了兼容字段。
- Codex 仍然是默认 backend，现有会话、审批、SSE 和 worktree 行为没有改变。
- `src/lib/desktopBackendRegistry.js` 现在会注册 Codex backend，并在 `ECHO_CLAUDE_ENABLED=true` 时注册 Claude Code backend。
- Claude Code backend 已经能作为显式选择的运行时进入移动端会话路径，支持流式输出、继续会话、取消当前 turn、权限模式映射、模型选择和完成后的 Git summary。
- DeepSeek 现在通过 Claude Code 的 Anthropic-compatible 配置接入：当 `ECHO_CLAUDE_BASE_URL` 或 `ANTHROPIC_BASE_URL` 指向 DeepSeek 时，provider 会标记为 `deepseek-via-claude`，默认主模型使用 `deepseek-v4-pro[1m]`，并保留 `deepseek-v4-flash` 作为 haiku/subagent 快速模型；`/models` 探测只做健康校验，不会把其它模型追加成可选项。
- 移动端 runtime 控件已经按所选 backend 切换模型列表和允许的权限模式，不再只有一组 Codex-only 模型选项。
- 桌面设置页已经提供默认权限、手机端可用权限、worktree 模式、worktree 根目录和保留天数配置。
- `src/lib/backendAdapterContract.js` 已经把 adapter/snapshot/runtime 的最小契约固化成 `echo.backend-adapter.v1`：包括 `snapshot()`、`refreshCapabilities()`、`createRuntime()`、runtime `handleCommand()`/`stop()`、capability flags、unsupported features、Git summary/worktree 能力和 backend health。
- desktop backend registry 会在注册 adapter、创建 runtime、发布 runtime roster 时执行契约断言；relay 存储层也会保留 `contractVersion`、`capabilities`、`unsupportedFeatures` 和 `health`，避免契约信息只停留在桌面进程内。
- `BaseBackendAdapter` 现在承载通用的 snapshot normalization、capability refresh、busy-deferred model probe 和 health check 逻辑；具体 backend 只需要提供 runtime factory、snapshot factory、model probe 和 capability 差异。
- `ECHO_AGENT_BACKENDS_JSON` 可以声明额外的 Claude Code / Anthropic-compatible backend profile，例如同一台桌面上并列暴露 Claude、DeepSeek 或其它通过 Claude Code 命令兼容的模型配置。token 可以通过 `authTokenEnv` 留在桌面环境变量中，不进入 relay runtime snapshot。
- 同一 workspace 的写入任务仍然会被 `busyProjectIds` 串行化；多 backend 并存不等于多并发 slot，真正的并行写入仍然必须通过隔离 worktree 表达。

### 2026-05-07 对齐后的剩余限制

- 公共 API、SQLite 表和很多函数名仍然是 `codex_*`，目前它们实际承担的是“移动执行会话”兼容层，还不是 provider-neutral 的 run/step 层。
- backend contract 已经有代码级 v1 基线和兼容测试，但事件/result 的 provider-neutral 命名还没有完全收敛，现阶段仍保留 Codex app-server 风格事件作为兼容层。
- Claude Code backend 是 opt-in 路径，还不应该被视为和 Codex 完全等价：截图附件和远程 context compaction 已显式标记为不支持。
- writable worktree 隔离需要按 backend 逐一验证。当前 Codex 和 Claude Code runtime 都会在 desktop-prepared `execution.path` 下执行；后续每个新 backend 都必须用兼容测试锁住这个行为。
- Git summary 已经在 Codex 与 Claude 路径上统一为 `git.summary` 结构；更细的 turn/tool 事件命名还需要继续收敛，避免 UI 消费 provider-specific payload。
- 还没有 `run` / `step` / `artifact` 的通用编排表；当前仍然是一条 session command 队列加 backend 选择。
- 调度层还没有把 main checkout、isolated worktree 和只读 lane 做成显式执行槽；当前的 same-project 串行化仍然通过 `busyProjectIds` 隐式完成。

## 3. 核心抽象

建议把系统拆成下面几层。

| 概念 | 含义 | 说明 |
| --- | --- | --- |
| Host | 一台 desktop 机器 | 负责本地 workspace、Git、worktree、凭证和执行边界 |
| Backend | 一个 agent runtime 集成 | 例如 Codex、Claude Code、Cursor Agent、其他 CLI/API 适配器 |
| Executor | Host + Backend + Model + Policy 的组合 | 这是实际干活的逻辑执行单元 |
| Capability Snapshot | 某个 host 当前可提供的能力快照 | 包括模型列表、工具能力、权限模式、worktree、模态能力等 |
| Run | 一次完整任务执行 | 对用户来说是一件事，对系统来说是一个生命周期容器 |
| Step | Run 内的一个子任务 | 由一个 executor 单独负责 |
| Team Plan | 一组有依赖关系的 steps | 可以是串行、并行，或 fan-out / fan-in |
| Artifact | Step 或 Run 产出的结构化结果 | 例如 diff、git summary、测试结果、最终回复、审查意见 |
| Policy | 允许哪些 backend / model / mode | 由 desktop owner 和 workspace policy 决定 |

最重要的是区分这三件事：

- **Host** 是机器。
- **Backend** 是能力实现。
- **Executor** 是 Echo 真正调度的对象。
- **Run / Step** 是 Echo 对外暴露的公共编排语义。
- **Session / Turn** 是具体 backend 的实现细节，尤其是 Codex adapter 的内部语义，不应该成为所有 backend 的公共前提。

如果不分清这三层，后面多 agent / 多模型会很快变成一团。

## 4. 产品模型

Echo 不应该把“多 agent”做成一堆暴露给用户的底层按钮，而应该把它做成几个清晰的操作模式。

### 推荐的用户模式

1. **Solo**
   - 一个 executor 完成全部任务。
   - 适合简单修 bug、写文档、小改动。

2. **Guided Team**
   - 用户选择一个模板，Echo 自动分配 planner / implementer / reviewer / verifier。
   - 适合大多数工程任务。

3. **Manual Team**
   - 用户显式指定某个 role 由哪个 agent / model 执行。
   - 适合对成本、风格或可靠性要求很高的场景。

4. **Parallel Compare**
   - 同一问题分发给多个 agent / model 并行求解。
   - 最后由 reviewer 或用户选择更好的结果。

### 推荐的 team 角色

| 角色 | 主要职责 | 典型模型倾向 | 必要能力 |
| --- | --- | --- | --- |
| Planner | 拆任务、定方案、给出执行顺序 | 便宜、速度快、指令遵循强 | 只读、文本、上下文理解 |
| Implementer | 改代码、改配置、产出补丁 | coding 强、工具使用强 | 写文件、Git、shell、worktree |
| Reviewer | 审查 diff、发现风险、找遗漏 | 推理强、审查严谨 | 只读、diff、日志 |
| Verifier | 跑测试、核对行为、收敛失败 | 本地能力强或能理解测试输出 | shell、测试、日志 |
| Summarizer | 生成结果摘要和下一步建议 | 便宜且稳定 | 文本、artifact 读取 |

这套角色是建议，不是强制。Echo 的编排器应该允许其它 role，但优先围绕这些最常见的工程职责展开。

## 5. capability 和 policy 的分工

Echo 的核心约束应该是：**能力是被广告出来的，不是被手机想出来的。**

### capability snapshot 应该包含什么

每个 host 或 backend 应该广播一份 capability snapshot，至少包括：

- `provider`：Codex、Claude Code、Cursor、custom CLI、remote API 等。
- `models`：可用模型列表，以及默认模型。
- `tools`：是否支持 file read/write、shell、Git、approval、vision、attachments、patch apply。
- `execution`：是否支持 workspace-write、read-only、danger-full-access、worktree。
- `modalities`：文本、图片、截图、代码片段等。
- `limits`：最大并发、超时、上下文上限、附件限制。
- `policy`：哪些模式允许从手机请求，哪些只能由 desktop owner 决定。
- `runtime status`：在线状态、最近一次 capability probe 时间、错误信息。

### backend adapter contract

每个 backend 至少要明确实现一组稳定契约。它不一定长得像 Codex，但必须能被 Echo 统一调度、统一回退和统一观测。

当前 v1 契约在代码里对应 `src/lib/backendAdapterContract.js`，最小形状是：

- adapter 必须实现 `snapshot()`、`refreshCapabilities()`、`createRuntime()` 和 `healthCheck()`。
- runtime 必须实现 `handleCommand(command)` 和 `stop()`；`warmup()` 可以存在但不是必需。
- runtime command 兼容层先固定为 `start`、`message`、`stop`、`compact`，后续 `run/step` 层会在这之上演进。
- capability snapshot 必须带 `contractVersion`、`backendId`、`provider`、`backendName`、`supportedModels`、`allowedPermissionModes`、`capabilities.supports`、`unsupportedFeatures` 和 `health`。
- `capabilities.supports` 至少要明确 `attachments`、`cancellation`、`compaction`、`approvalRequests`、`interactionRequests`、`gitSummary` 和 `worktree`。
- 不支持的能力必须显式进入 `unsupportedFeatures`，例如 Claude Code 当前标记 `attachments`、`remote-context-compaction`、`approval-requests` 和 `interaction-requests`。
- writable backend 必须在 desktop-prepared `execution.path` 下执行 worktree command，并在完成后尽量输出统一的 `git.summary`。

如果某个 backend 不能提供其中一部分能力，它仍然可以存在，但它可参与的 role 必须被限制到能力匹配的范围内，比如只做 planner 或 reviewer，而不能被错误地分配写入型 step。

### policy 应该表达什么

policy 不应该是“允许/不允许”这么简单，而应该至少区分：

- **hard constraints**：必须满足，否则任务不能派发。
- **soft preferences**：优先满足，但可以在可解释的前提下回退。
- **operator overrides**：desktop owner 的显式偏好。

例如：

- 用户选择的 model 如果不在 host 支持列表内，属于 hard fail 或明确降级。
- 用户要求 `danger-full-access`，但 desktop policy 不开放，就必须拒绝，而不是悄悄放行。
- 用户说“优先便宜模型”，这是 soft preference，调度器可以在能力相近时选择更便宜的一项。

### 现在就该保留的原则

- 手机只能请求任务，不应该直接决定本地执行边界。
- 本地 workspace / worktree / shell / Git 仍然只由 desktop host 执行。
- provider-specific 的复杂性应该藏在 backend adapter 里，而不是散落到 UI 和 relay。

## 6. 调度模型

Echo 需要一个明确的调度器，而不是把“选哪个模型”简化成“用户手动切下拉框”。

### 推荐的调度顺序

1. 先确定任务类型。
2. 再确定是否需要 team plan。
3. 再找满足 workspace / policy / capability 的 host。
4. 再在该 host 的 backend 中选择最合适的 executor。
5. 最后把任务拆成一个或多个 steps。

### 推荐的调度规则

- 读多写少的任务优先给便宜、快、稳定的模型。
- 需要改代码的 step 必须落在具备写权限和 workspace 的 executor 上。
- 需要跑测试的 step 必须落在具备本地执行能力的 executor 上。
- 需要 review 的 step 可以走只读 backend，尽量减少本地风险。
- 并行 step 必须使用隔离 worktree，除非是纯只读任务。
- 主 checkout 应被视为单一独占写入槽；如果同一 workspace 已有活跃写入任务，编排器必须给出清晰的排队原因，而不是让用户误以为 backend 失效。

### 推荐的 fallback 逻辑

- 如果用户指定的 executor 不可用，先尝试 policy 允许的最接近替代。
- 如果新 backend 不可用，默认回退到当前 Codex solo 路径，而不是让整个系统失去可用性。
- 如果任务是 hard constraint 型，且没有可用替代，必须把原因显式暴露给用户。
- 如果某个 backend 不支持某种 capability，不要让它“假装支持”，而是让编排器把它排除在外。

### 调度器需要能解释自己为什么这么选

当 Echo 选择某个 agent 或 model 时，应该同时保存一个简短的 `selectionReason`，例如：

- “这个 step 需要改文件并跑测试，所以分配给支持 worktree 的本地 executor。”
- “这个 step 只需要生成计划和风险检查，所以分配给便宜的 planner model。”
- “这个 step 在两个模型之间并行比较，因为用户要求保守处理。”

这会显著降低“为什么 Echo 给我选了这个模型？”的困惑。

## 7. 执行拓扑

多 agent 不是单纯“多个聊天窗口”，而是一个可组合的执行图。

### 推荐的基本拓扑

```text
Phone / PWA
  -> Relay control plane
     -> Run planner / policy engine
        -> Desktop host A
           -> Backend 1: Codex
           -> Backend 2: Claude Code / Cursor / custom CLI
        -> Desktop host B
           -> Backend 1: ...
     -> Event stream / SSE / polling fallback
```

### 三种常见拓扑

1. **Single executor**
   - 一个 backend 完成全部步骤。
   - 最简单，也是默认形态。

2. **Sequential team**
   - planner -> implementer -> reviewer -> verifier
   - 适合大多数工程任务。

3. **Parallel team**
   - 多个 implementer 并行试解，最后由 reviewer 选择或合并。
   - 成本更高，但对疑难任务更稳。

### worktree 在这里的角色

如果要做并行或多 agent 写入，worktree 不再是一个可选小功能，而是整个拓扑安全的基础设施。

建议原则是：

- 任何会写文件的并行 step 都要有独立 worktree。
- 单步 solo 任务可以按 policy 使用主 checkout 或 worktree。
- merge / apply / discard 必须成为显式动作，而不是隐式副作用。

这和当前 Echo 已经有的 `worktreeMode` 是一致的，只是未来它会从“一个 toggle”升级成“任务拓扑的一部分”。

## 8. 事件和结果归一化

如果要支持多个 backend，Echo 不能直接把 provider 原始 payload 原样摊给 UI。必须建立统一的事件层。

### 建议的统一事件类别

- `run.started`
- `step.started`
- `turn.started`
- `tool.requested`
- `approval.requested`
- `interaction.requested`
- `artifact.created`
- `git.summary.created`
- `step.completed`
- `step.failed`
- `run.completed`
- `run.failed`
- `run.cancelled`

### 归一化原则

- UI 和 relay 主要消费统一事件。
- provider 原始 payload 仍然可以存档，但应该放在 `raw_json` 或类似字段里。
- 对用户展示时优先使用标准化摘要，而不是 provider-specific 细节。

### 每一步都应该产出什么

至少建议保存这些结构化结果：

- 最终文本回应。
- 变更摘要。
- 关键文件列表。
- 测试或验证结果。
- 失败原因。
- 选择理由。
- 需要下一步时的 handoff 摘要。

这会让不同 agent 之间的交接更稳，不用反复拷贝长日志。

## 9. 数据模型建议

Echo 现在已经有 SQLite 状态层，所以最自然的演进方式不是推翻重来，而是把现有 Codex 专用表逐步泛化。

### 推荐的演进方向

#### 短期

- 保留现有 `codex_*` 表和现有 session/turn 语义。
- 在 `runtime_json` / `execution_json` / `memory_json` 中加入 provider-neutral 字段。
- 把当前 Codex adapter 视为第一个 backend implementation，而不是把 Codex 语义抹平后再重建。

#### 中期

- 在不破坏现有路径的前提下，引入 generic 表，例如：
  - `agent_hosts`
  - `agent_backends`
  - `orchestration_runs`
  - `orchestration_steps`
  - `orchestration_artifacts`
- `codex_*` 表在相当长一段时间内继续作为兼容层或迁移层存在。

### 一个推荐的数据形状

```json
{
  "run": {
    "id": "run_123",
    "projectId": "echo",
    "strategy": "plan-implement-review",
    "status": "running"
  },
  "steps": [
    {
      "id": "step_plan",
      "role": "planner",
      "backend": "claude-code",
      "model": "sonnet",
      "status": "completed",
      "selectionReason": "cheap planning is enough"
    },
    {
      "id": "step_impl",
      "role": "implementer",
      "backend": "codex",
      "model": "gpt-5.5",
      "status": "running",
      "worktree": true
    }
  ]
}
```

### 现有字段可以怎么复用

- `runtime_json` 可以容纳 policy、model、backend、strategy 和 step selection。
- `execution_json` 可以容纳 worktree、branch、base commit、assignment graph。
- `memory_json` 可以容纳跨 step 的 handoff 摘要和上下文压缩结果。

## 10. UI 建议

如果用户要像指挥 team 一样使用 Echo，UI 不能只显示“模型下拉框”，而应该显示“执行编排”。

### 建议的 UI 元素

- Agent roster：当前在线的 host / backend / model。
- Role assignment：每个 role 由谁负责。
- Strategy selector：Solo、Guided Team、Manual Team、Parallel Compare。
- Capability badges：worktree、approval、shell、vision、attachments 等。
- Budget hints：快、便宜、稳、保守、并行。
- Selection reason：Echo 为什么选了这个 executor。
- Step timeline：每一步是谁做的、做了什么、结果是什么。

### 用户应该能够看到的内容

- 某一步是哪个 agent 在做。
- 这个 agent 用的是什么 model。
- 这个 step 为什么落到这个 agent。
- 这一步是否需要 worktree。
- 是否因为 capability 不足被降级了。
- 并行的多个方案最后谁被采纳。

## 11. 安全边界

多 agent 和多模型不会改变 Echo 的安全边界，反而更需要边界清晰。

### 不变的底线

- 手机端不能直接发任意 shell。
- 手机端不能直接发任意文件路径。
- desktop host 仍然是唯一可以触碰本地仓库的实体。
- `danger-full-access` 仍然只能来自 desktop policy。
- 审批仍然必须显式、可审计。

### 新增的边界要求

- 远程云端 agent 只能通过被允许的 backend adapter 接入。
- 不同 backend 的能力差异必须在 capability 层显式表达。
- 没有能力的 backend 不应该被编排器强行分配给不适合的 role。
- 如果一个 step 的执行环境变化了，必须明确告诉用户“这个变更会从下一步生效”。

### 关键风险

- 过度自动化会让用户失去对成本和风险的感知。
- 不同 provider 的工具协议差异很大，如果过早做“完全统一”，很容易把 adapter 层做成脆弱的黑盒。
- 并行 step 如果没有 worktree 隔离，几乎一定会互相污染。

## 12. 渐进式落地建议

我建议按下面顺序做，而不是一下子做成“全自动团队大脑”。

### Phase 0: 稳住当前 Codex golden path

- 把当前 Codex 路径视为稳定基线。
- 明确哪些行为属于对外契约，哪些只是内部实现。
- 为现有会话、审批、SSE、worktree、Git summary 和取消/中断流程补齐兼容性基线。

**当前状态：基本完成。** Codex 仍是默认 backend；会话、审批、SSE、取消、Git summary、SQLite lease、worktree 和移动端 runtime 选择都有非 e2e 测试覆盖。后续工作应该避免改变这个默认路径的外部行为。

### Phase 1: 抽出 backend adapter contract

- 让 Codex 成为第一个 backend implementation，但不改变现有默认路径。
- 把 capability probe、事件流、取消、审批、结果摘要整理成稳定契约。
- 所有新增 backend 都必须先满足这个契约，再考虑接入编排器。

**当前状态：已完成 v1 基线。** Codex 和 Claude Code 已经通过 adapter/registry 接入，`echo.backend-adapter.v1` 把 adapter、runtime、capability snapshot、unsupported feature、worktree/Git summary 和 health 形状固化到代码和测试里。新增 backend 现在应该先通过 contract/compatibility 测试，再进入 mobile runtime roster 或编排器。剩余工作是继续把非 Codex 事件和结果归一化到 provider-neutral 的 `turn.*`、`approval.*`、`interaction.*`、`artifact.*` 语义。

### Phase 2: 新 backend 的 shadow / opt-in 接入

- 先让新 backend 只在显式选择时生效。
- 先限制在只读、planner、reviewer 之类低风险角色。
- 先通过兼容性测试和回退路径验证，不让新 backend 影响默认用户体验。

**当前状态：进行中。** Claude Code / DeepSeek 已经是显式选择路径，默认仍回到 Codex。风险边界上，Claude 默认 `strict`，附件和 compaction 不支持时会直接拒绝或提示。worktree 执行路径和 Git summary 结构已有兼容测试；还需要补足失败恢复、审批/交互能力矩阵和更完整的事件归一化测试。

### Phase 3: 引入 capability roster 和 team plan

- 每个 host 广播更通用的 capability snapshot。
- 允许一个 host 上同时存在多个 backend / model 选项。
- 支持 planner / implementer / reviewer / verifier 这类模板。
- 让一个 run 可以包含多个 step，先做顺序编排，再做并行编排。

**当前状态：尚未开始 run/step 层。** 现在已经有 backend/model roster 的雏形，但还没有 strategy、role assignment、selection reason 或 step timeline。

### Phase 4: 引入 parallel compare 和 worktree 隔离

- 支持两个或多个模型并行回答同一个子任务。
- 支持 reviewer / user 选择最终结果。
- 为可写 step 自动使用独立 worktree。

**当前状态：基础设施部分完成。** 单会话 worktree 已经可用；并行 compare、按 step 自动创建 worktree、结果选择和合并还没开始。

### Phase 5: 多 host 路由

- 允许多个 desktop host 出现在同一个 Echo 账户下。
- relay 根据 workspace、在线状态、能力和 policy 路由任务。
- 这一步才是真正意义上的“调一个团队”，但它应该建立在前面的稳定基线之上。

**当前状态：未开始。** 目前 relay 会合并在线 agent 的 workspace/runtime snapshot，但调度仍然偏“第一个在线可用 agent + session queue”，还不是明确的多 host routing。

## 13. 需要尽早决定的问题

这几个问题越早定下来，后面的实现越不会返工。

1. Echo 的公共编排语义应该明确以 `run / step` 为中心，还是继续围绕 backend 内部的 `session / turn` 组织？
2. 哪些字段和行为必须保持对当前 Codex 路径完全兼容，哪些可以只在新 backend 上出现？
3. 新 backend 失败时的默认回退策略是什么，哪些失败必须自动退回当前 Codex 路径？
4. provider 名称应该直接暴露给用户，还是只作为高级信息展示？
5. model 选择是 run 级别，还是 step 级别？
6. 任务编排应该默认自动，还是默认先给用户一个可编辑 plan？
7. 本地执行类 step 和只读推理类 step 的 capability 边界要不要强制分开？
8. 并行 step 的成本预算应该如何表达，是否需要显式 budget 限额？

## 14. 推荐结论

如果要我给这个方向一句话总结，我会这样定义：

> Echo 未来不应该是“能远程点一个 Codex”，而应该是“一个受 desktop policy 约束、可以调度多个 agent 和多个模型的本地工程编排器”。

最稳妥的路线不是先做一个非常炫的自动代理系统，而是先把当前 Codex 路径稳住，再把 backend adapter contract 和兼容性边界定清楚，然后用一个清晰的 capability / policy / run graph 体系把多 agent、多模型和并行编排接起来。

这样 Echo 才能既保住现在的安全边界，又真正长成你想要的那种“可以指挥一个 team”的工具。
