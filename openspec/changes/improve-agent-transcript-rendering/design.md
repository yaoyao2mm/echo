## 背景

当前移动端会话的核心渲染路径在 `public/app/sessions.js`：

- `buildConversationTimeline()` 把 messages/events 合并成 timeline entries。
- `renderConversationEntry()` 对普通 message 使用 `escapeHtml(entry.text)` 直接写入 `.thread-bubble`。
- approval 和 interaction 独立显示在 `codexApprovals` 区域，使用较重的 inline card 和大块 radio option。

这个实现安全、简单，但它把 agent transcript 降级成纯文本。Claude Code 这类 backend 输出表格、Markdown 结论、代码和 checklist 时，手机端无法提供现代 agent UI 应有的阅读体验。

## 设计原则

1. **安全优先**
   - Markdown 渲染后的 HTML 必须 sanitize。
   - 禁止 raw HTML、`javascript:`、事件 handler、iframe、style 注入等危险内容。
   - 附件和 artifact 链接继续通过 Echo 已有 authenticated resource path 处理。

2. **先做统一文本 renderer，再做结构化 transcript**
   - 第一阶段把 assistant text 从 raw Markdown 升级为安全富文本。
   - 第二阶段把现有 timeline entry 扩展成 part/card，不依赖从自然语言里猜测工具动作。

3. **保持 Echo 轻量栈**
   - 不引入 React 作为移动端运行时前置条件。
   - 优先选择 vanilla JS 可用的 markdown-it 或 marked，配合 DOMPurify 和可选 highlight.js / Shiki。
   - 依赖应固定版本，并以本地静态资源或明确构建步骤提供给 PWA，避免运行时依赖 CDN。

4. **渲染失败可降级**
   - 如果 Markdown renderer 或 sanitizer 加载失败，assistant message 必须回退到现有 plain text `escapeHtml` 行为。
   - 渲染失败不能影响发送消息、审批、取消 turn、查看日志或复制原始文本。

5. **手机端密度优先**
   - Transcript 应适合扫读，不把每个状态都渲染成大卡片。
   - 卡片只用于需要边界的工具动作、审批、测试结果和 Git summary。
   - 选择控件应紧凑、触控安全、有明确选中态，不使用粗重的大块嵌套卡片。

6. **不重新发明通用渲染能力**
   - Markdown parsing 不自研。
   - HTML sanitize 不自研。
   - 代码高亮和 ANSI/terminal output 解析不自研。
   - Echo 自己实现的部分只限于 glue layer、安全策略、移动端 CSS、结构化 transcript part mapping 和 domain-specific decision controls。

## 技术选型与开源复用方案

### 推荐路径

第一阶段推荐采用 vanilla-friendly 组合：

- Markdown parser：优先评估 markdown-it。
- HTML sanitizer：DOMPurify 作为必选安全层。
- 代码高亮：优先从 highlight.js 起步；Shiki 作为更高质量但更重的备选。
- Streaming 容错：先实现 Echo 的 bounded pre-normalization，同时借鉴 Streamdown 行为；如果 Streamdown 能在不引入 React runtime 的前提下复用，再评估直接接入。
- ANSI/terminal output：如果后续需要渲染 backend stdout/stderr 的 ANSI 颜色，使用 ansi-to-html 或 xterm.js 的成熟方案，不自研 ANSI parser。

这条路径符合 Echo 当前 vanilla JS/PWA 架构：依赖少、集成边界清晰、fallback 简单，且能快速修复 raw Markdown 在手机上不可读的问题。

### 选型矩阵

| 目标 | 推荐 | 备选 | 不采用/暂不采用 | 理由 |
| --- | --- | --- | --- | --- |
| Markdown parsing | markdown-it | marked | 自研 parser | markdown-it 插件和 token 控制更稳，适合 GFM 表格、link rule、code fence 定制；marked 更轻，可在实现时对比包体和 API。 |
| HTML sanitize | DOMPurify | 无 | 自研 sanitizer | XSS 风险高，sanitize 必须使用成熟库；raw HTML 默认关闭，DOMPurify 作为第二道防线。 |
| 代码高亮 | highlight.js | Shiki | 自研 highlighter | highlight.js 集成简单、包体可控，适合 v1；Shiki 视觉质量更好，但主题、bundle 和异步加载成本更高。 |
| Streaming Markdown | Echo bounded pre-normalization + Streamdown 行为参考 | 直接复用 Streamdown 的非 React 部分 | 完整自研 streaming parser | Echo 当前会重新渲染 SSE session，不需要先做完整 streaming parser；若 Streamdown 可低成本接入再升级。 |
| React chat UI | 借鉴 assistant-ui / AI Elements 的模型 | 未来重构时再评估 | 当前直接引入 React runtime | Echo 移动端是 vanilla PWA，直接引 React 会扩大改动面；message parts 模型值得借鉴。 |
| ANSI output | ansi-to-html | xterm.js | 自研 ANSI parser | 普通 command 摘要用 ansi-to-html 足够；完整交互终端不是本 change 目标。 |
| Mermaid/math/notebook | 暂不实现 | 后续独立 change | 混入 v1 | 会显著扩大安全、包体和布局复杂度，不是当前手机可读性痛点的必要条件。 |

### 依赖引入策略

- 依赖必须固定版本，进入 `package.json` / lockfile，或以明确脚本 vendored 到 `public/vendor`。
- PWA 运行时不得依赖 CDN。
- renderer 初始化必须可失败；失败时回退到 plain text。
- 代码高亮语言包应按需裁剪，避免把全量语言和主题打进移动端首屏。
- 如果使用 Shiki，必须评估首屏加载、worker/wasm 支持和离线 PWA 缓存行为。
- 如果使用 marked 而不是 markdown-it，必须补齐 GFM 表格、link sanitize hook、code block hook 和 checklist 行为。

### Echo 自己实现的边界

Echo 只实现这些项目内能力：

- `renderAgentMarkdown` 的应用层 wrapper。
- Markdown 输出后的 DOMPurify allowlist、link rewrite、image 禁用策略。
- draft pre-normalization，例如临时补齐未闭合 code fence。
- `.rich-transcript` 移动端样式。
- session events / approvals / interactions / git summary 到 transcript parts 的映射。
- approval、interaction、Plan Mode 的 decision controls。

Echo 不实现这些通用底层能力：

- Markdown parser。
- HTML sanitizer。
- 代码语法分析器。
- ANSI escape parser。
- Mermaid/math renderer。
- 通用 React chat component framework。

## 阶段一：安全 Markdown Renderer

### API

新增一个移动端渲染入口，例如：

```js
app.renderAgentMarkdown = function renderAgentMarkdown(text, options = {}) {
  return { html, degraded, warnings };
};
```

调用方只关心 sanitized HTML：

```js
const bodyHtml =
  entry.role === "assistant"
    ? app.renderAgentMarkdown(entry.text, { draft: entry.draft }).html
    : app.escapeHtml(entry.text);
```

同时在 DOM 上保留原始文本：

```html
<div class="thread-bubble thread-bubble-assistant rich-transcript" data-raw-message="...">
  ...
</div>
```

为避免把长文本塞进 attribute，也可以把 raw text 保留在 timeline state，并让 copy/edit action 从 entry id 或当前渲染 map 读取。

### Markdown 能力

第一阶段 MUST 支持：

- 段落、换行、标题。
- 粗体、斜体、删除线、inline code。
- 有序/无序/checklist 列表。
- blockquote。
- GFM 表格。
- fenced code block，包含 language class。
- 链接，且只允许安全协议。

第一阶段 SHOULD 支持：

- diff 代码块的加减行样式。
- 代码块复制按钮。
- 长表格和长代码横向滚动。
- 流式输出中未闭合 code fence 的临时补全。

### 流式容错

Echo 当前 SSE 更新会重新渲染 selected session。为了让流式 Markdown 可读，renderer 应做 bounded pre-normalization：

- 如果 fenced code block 未闭合，临时补一个 closing fence 渲染，并在下一次更新重新计算。
- 如果表格 header/separator 已出现但行仍在追加，保持 table wrapper 横向滚动。
- 如果列表项未完成，不让整个后续文本变成错误结构。

这不是完整 Markdown parser 重写，只是借鉴 Streamdown 的 tolerant streaming 行为。实现应限制在 assistant draft 消息，最终消息按标准 Markdown 渲染。

### Sanitizer 策略

- 默认不允许 raw HTML；Markdown parser 配置 `html: false` 或等效选项。
- DOMPurify allowlist 只保留 transcript 需要的标签：`p`、`strong`、`em`、`del`、`code`、`pre`、`blockquote`、`ul`、`ol`、`li`、`table`、`thead`、`tbody`、`tr`、`th`、`td`、`a`、`br`、`hr`、`h1`-`h6`。
- 链接默认加 `target="_blank"` 和 `rel="noreferrer noopener"`。
- 禁止 inline style 和 event attributes。
- image Markdown 默认不渲染远程图片；图片继续通过 Echo attachments/artifacts 渲染，避免 agent 注入第三方 tracking image。

### CSS

新增 `.rich-transcript` 样式：

- 设置合理段落间距、列表缩进、代码块背景和字号。
- 表格放在 overflow wrapper 或通过 CSS 让 table 横向滚动。
- 长单词、路径、URL 使用 `overflow-wrap: anywhere`。
- 代码块和表格不撑破 mobile viewport。
- 避免使用大面积单色主题；应和现有 Echo 色彩体系协调。

## 阶段二：结构化 Transcript Parts

### Entry/Part 模型

在现有 timeline entry 基础上引入稳定 part 类型，而不是继续把所有东西压成 message text：

```js
{
  kind: "message",
  role: "assistant",
  parts: [
    { type: "text", text: "..." },
    { type: "command", command: "pnpm test", status: "running" },
    { type: "file-change", path: "public/app/sessions.js", changeType: "modified" },
    { type: "test-result", command: "pnpm test", status: "passed" },
    { type: "git-summary", filesChanged: 3, insertions: 42, deletions: 8 }
  ]
}
```

兼容策略：

- `entry.text` 继续存在，用于老数据和 copy/edit。
- 新数据优先走 `entry.parts`。
- 后端未提供 parts 时，mobile 继续从现有 events 归一化出 system/plan/test/git 等 card。

### 结构化组件

Transcript renderer 应提供这些组件：

- `text`: 使用阶段一 Markdown renderer。
- `command`: 命令、cwd 摘要、状态、最近输出，支持 running/succeeded/failed/cancelled。
- file change: 文件路径、change type、可选 diff stat。
- test result: 复用现有 test card，但更紧凑。
- git summary: changed files、stat、branch/ref、worktree 状态。
- `approval`: 命令审批、文件修改审批、权限请求。
- `interaction`: Plan Mode、用户选择、短答输入。
- `status`: compact status pill，例如 compaction、recovery、cancel requested。

这些组件应直接来自 Echo 已有 session events、approvals、interactions、artifacts、git summary，而不是解析 assistant 自然语言。

### 渲染边界

- 普通正文不放进卡片，保持 transcript 的阅读流。
- 工具动作卡片使用轻边界、紧凑标题、状态 pill 和可展开详情。
- 不把卡片套卡片；approval/interaction 内部使用 fieldset/list，不再把每个 option 做成沉重大卡。
- 结构化卡片应能按时间插入 transcript，而不是总是漂在消息流外，避免用户错过 Plan Mode 或审批上下文。

## Decision Controls 精修

当前 interaction UI 的主要问题是 option 框过大、边框和留白过重，在手机上显得粗糙。新控件应统一为 thread decision card：

- 顶部显示 compact 状态 pill，例如 `需要选择`、`命令审批`、`Plan Mode`。
- 问题正文使用小标题/正文两级，不用大段粗体。
- 单选项使用紧凑 row 或 segmented list：
  - 选中态清晰，但不使用整块厚重背景。
  - 每个选项保持足够触控高度，建议最小 40px 到 44px。
  - 描述文字作为 secondary text，最多两行，超长内容折叠或自然换行。
- “其他”输入只在选中后展开，避免默认占位过大。
- 操作按钮区域固定为轻量 footer：次要操作在左，主要操作在右。
- 在窄屏上按钮可以同排或两列，但文字不得溢出。
- approval 的命令/detail 默认显示摘要，长详情可展开，避免一进页面就占满屏幕。

Plan Mode 或 agent 发出的选择型交互应复用同一套 decision controls，而不是另外做一套大块选项 UI。

## 状态与兼容

- 旧会话：没有 parts 的旧 session 继续按 `entry.text` 渲染。
- 新会话：如果 backend/event adapter 能提供结构化信息，优先生成 parts。
- 复制消息：默认复制原始 Markdown/text，而不是复制 rendered text。
- 重新编辑用户消息：保持当前用户消息编辑行为。
- Debug log：继续显示 plain text，不走富文本 renderer。
- 离线缓存：已缓存的 session 打开时可重新渲染，不需要迁移数据库。

## 安全风险

- XSS：通过禁用 raw HTML、DOMPurify、协议 allowlist 和测试覆盖降低风险。
- 远程图片追踪：Markdown image 默认禁用，附件图片继续走 Echo attachment 渲染。
- 内容撑破 viewport：表格、代码块、长 URL 必须有 overflow 和 wrap 规则。
- 结构化状态误导：status/card 必须来自 Echo event/approval/interactions 等结构化数据，不从 assistant 文本中猜测“测试通过”。

## 验证

- Markdown renderer 单元测试：表格、代码块、列表、链接、raw HTML、危险协议、未闭合 code fence。
- Timeline rendering 测试：assistant markdown HTML、fallback plain text、copy 原始文本。
- Structured transcript 测试：command/test/git/approval/interaction entries 映射和排序。
- Mobile UI 非 e2e 测试：decision controls 的选中、其他输入、提交、取消、长文案不溢出。
- 运行 `pnpm run check:js`。
- 运行 `pnpm test`。
- 不运行 e2e，除非明确要求。
