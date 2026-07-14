## Why

Echo 的移动端会话现在把 agent 回复当作纯文本显示。Claude Code、Codex、OpenCode 等 backend 经常输出 Markdown 表格、粗体结论、列表、代码块、diff 和带状态的执行摘要；这些内容没有被富文本渲染时，在手机上会变成一大段 raw Markdown，尤其是表格会完全失去可读性。

这不是单纯的视觉问题。Echo 的产品定位是 remote control surface for local Codex/agent，用户需要在手机上快速判断 agent 正在做什么、是否需要批准、结果是否可信。如果 transcript 不区分正文、工具动作、审批、测试、Git 结果和用户输入，用户只能从长文本里手动解析状态，远程控制体验会变慢且容易误判。

另一个明显问题是当前 approval/interaction 组件偏大、偏粗糙。Plan Mode 或 agent 发起选择时，选项框在手机上占据过多空间，视觉层级接近整块卡片，缺少现代 agent UI 常见的紧凑、可扫读、明确状态的 decision control。

Echo 需要一个明确的 Agent Transcript Renderer：先把 agent 文本安全渲染成移动端可读的 Markdown 富文本，再把 agent 事件、工具动作和人机决策渲染成结构化 transcript 组件。

## What Changes

- 新增移动端 agent Markdown 渲染入口，用安全的 Markdown/GFM 渲染替代 assistant message 的纯 `escapeHtml` 文本输出。
- 支持常见 agent 输出：标题、粗体、列表、引用、链接、表格、代码块、inline code、diff 样式和长内容横向滚动。
- 让流式回复在 Markdown 尚未闭合时仍保持可读，借鉴 Streamdown 这类 streaming Markdown renderer 的容错思路。
- 引入受控、安全的 HTML sanitize 策略，默认禁用 raw HTML 和危险链接协议。
- 明确开源库复用策略：Markdown parsing、HTML sanitize、代码高亮、ANSI 输出解析都不自研，只做 Echo 的安全集成和样式封装。
- 增加 transcript part/card 模型，把命令执行、文件修改、测试结果、Git summary、审批、交互输入、计划更新等内容从纯文本中分离出来。
- 重新设计 approval/interaction/Plan Mode decision controls，让选项控件更紧凑、更精致、可扫读，同时保持移动端触控和可访问性。
- 保留原始消息文本用于复制、编辑和调试，不让富文本渲染破坏现有 follow-up 工作流。

## 参考模式

- Streamdown：借鉴它面向 LLM 流式输出的容错 Markdown 渲染思路，尤其是未闭合代码块、表格和列表的增量展示。
- Vercel AI SDK UIMessage parts / AI Elements：借鉴把 assistant message 拆成 text、tool call、tool result、reasoning、approval 等 part 的结构化渲染方式。
- assistant-ui：借鉴 message/action/branch/markdown 的组件边界，而不是直接引入 React 依赖。
- Open WebUI / LibreChat：借鉴成熟 chat transcript 对 Markdown、代码块、表格、复制动作和 mobile overflow 的处理。

Echo 目前是轻量 vanilla JS/PWA，不应为了这个 change 引入完整 React UI 栈。第一阶段应优先使用小型、可固定版本、可本地打包或 vendored 的 Markdown/sanitize/highlight 依赖；第二阶段再把现有 timeline entries 扩展成结构化 transcript parts。

推荐技术方向：优先评估 markdown-it + DOMPurify + highlight.js 的 vanilla 组合；marked 可以作为更轻的 Markdown parser 备选；Shiki 作为代码高亮质量更高但包体和异步加载更重的备选；Streamdown、assistant-ui、AI Elements 主要作为 streaming 和 message parts 设计参考，只有在不引入 React 运行时且依赖成本可控时才直接复用。

## Capabilities

### 新增能力

- `mobile-agent-transcript-rendering`: 移动端可以把 agent 输出安全渲染成富文本 transcript，并把 agent 动作、人机决策和运行结果以结构化组件展示。

## Non-Goals

- 不在这个 change 中重写整个移动端为 React。
- 不允许 agent 输出的 raw HTML 直接进入 DOM。
- 不让移动端通过 transcript renderer 获得任意 shell、任意路径或任意文件读取能力。
- 不在第一阶段实现 Mermaid、交互式图表、数学公式或完整 notebook 渲染；这些可以后续按需要单独加。
- 不改变 approval/interaction 的权限语义；本 change 只优化展示和提交体验。
- 不运行 e2e，除非明确要求。

## Impact

- Mobile PWA：会话消息渲染、transcript CSS、approval/interaction/Plan Mode decision controls、复制/编辑动作。
- Public assets/dependencies：新增或 vendored Markdown renderer、HTML sanitizer、可选代码高亮资源。
- Session timeline：扩展现有 `buildConversationTimeline` / `renderConversationEntry` 的 entry/part 模型。
- Tests：Markdown sanitize、assistant message rendering、structured transcript mapping、decision controls 的非 e2e 测试。
