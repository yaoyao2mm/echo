## 0. 技术选型与依赖策略

- [x] 0.1 完成 renderer 选型记录：优先评估 markdown-it + DOMPurify + highlight.js，并记录 marked、Shiki、Streamdown 的取舍。
- [x] 0.2 确认不自研 Markdown parser、HTML sanitizer、代码高亮器和 ANSI parser，只实现 Echo 集成层。
- [x] 0.3 确定依赖加载方式：固定版本、本地打包或 vendored，禁止运行时 CDN。
- [x] 0.4 评估 bundle size、PWA 离线缓存、初始化失败 fallback 和移动端性能。
- [x] 0.5 如果 Streamdown 可在不引入 React runtime 的前提下复用，记录直接接入方案；否则只借鉴 streaming 容错行为。

## 1. Markdown Renderer

- [x] 1.1 引入选定的 Markdown renderer、HTML sanitizer 和可选代码高亮依赖，并把版本固定到 lockfile。
- [x] 1.2 新增 `renderAgentMarkdown` 入口，并为 renderer 加载失败提供 plain text fallback。
- [x] 1.3 支持 GFM 表格、列表、blockquote、inline code、fenced code block、链接和基础文本格式。
- [x] 1.4 增加 sanitizer allowlist，禁用 raw HTML、危险协议、事件属性、inline style 和 Markdown image。
- [x] 1.5 增加 streaming draft 容错：未闭合 code fence、追加中的列表和表格不破坏整条消息渲染。
- [x] 1.6 更新 assistant message 渲染路径，让 assistant bubble 使用富文本，user message 继续按 plain text 安全渲染。
- [x] 1.7 保留原始消息文本给复制、重新编辑和 debug log 使用。

## 2. Transcript Styling

- [x] 2.1 新增 `.rich-transcript` CSS，覆盖段落、标题、列表、引用、inline code、代码块、表格和链接。
- [x] 2.2 让长表格、长代码、长 URL、长文件路径在移动端不撑破 viewport。
- [x] 2.3 给代码块增加 compact header 或复制 affordance，保持触控区域稳定。
- [x] 2.4 用截图或 targeted DOM/style 检查确认表格和代码块在窄屏可读。

## 3. Structured Transcript Parts

- [x] 3.1 扩展 timeline entry 模型，支持 `parts`，并保持 `entry.text` 兼容旧会话。
- [x] 3.2 从现有 events/approvals/interactions/artifacts/git summary 归一化 `text`、`command`、`file-change`、`test-result`、`git-summary`、`approval`、`interaction`、`status` parts。
- [x] 3.3 新增 part renderer，按类型渲染正文、命令、文件修改、测试、Git、审批、交互和状态。
- [x] 3.4 把结构化卡片按 timeline 时间插入 transcript，避免审批或 Plan Mode 选择脱离上下文。
- [x] 3.5 保持 backend-neutral 命名，不把 Claude Code、Codex、OpenCode 的事件直接泄漏成 UI 结构。

## 4. Decision Controls 精修

- [x] 4.1 设计并实现统一 `thread-decision-card`，覆盖 approval、interaction 和 Plan Mode 选择。
- [x] 4.2 将大块 radio option 改为紧凑 option rows 或 segmented list，提供清晰选中态和 touch-safe 高度。
- [x] 4.3 让选项描述、长选项文字、其他输入和 secret 输入在手机上不溢出、不占用过多默认空间。
- [x] 4.4 将命令审批和文件修改审批的长详情默认摘要化，并提供展开查看。
- [x] 4.5 保持提交、取消、批准、拒绝的现有权限语义和 API payload 不变。

## 5. Tests

- [x] 5.1 增加 Markdown renderer 测试：表格、代码块、列表、链接、raw HTML、危险协议、Markdown image、未闭合 code fence。
- [x] 5.2 增加 conversation rendering 测试：assistant 富文本、user plain text、renderer fallback、复制原始文本。
- [x] 5.3 增加 structured transcript 测试：command/test/git/approval/interaction/status part 映射和排序。
- [x] 5.4 增加移动端非 e2e 测试：Plan Mode/interaction option 选择、其他输入展开、提交/取消、长文案。
- [x] 5.5 运行 `pnpm run check:js`。
- [x] 5.6 运行 `pnpm test`。
- [x] 5.7 不运行 e2e，除非明确要求。

## 6. Documentation

- [x] 6.1 更新 README 或相关文档，说明 Echo transcript renderer 支持的 Markdown 范围和安全限制。
- [x] 6.2 记录结构化 transcript part 类型和 backend adapter 应提供的数据边界。
- [x] 6.3 记录 approval/interaction/Plan Mode decision controls 的 UI 语义和可访问性要求。
