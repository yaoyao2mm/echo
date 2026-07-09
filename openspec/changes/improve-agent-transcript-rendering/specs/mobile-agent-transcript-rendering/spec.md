## ADDED Requirements

### Requirement: 移动端安全渲染 assistant Markdown
移动端 SHALL 将 assistant message 中的 Markdown 安全渲染为富文本 transcript，而不是直接显示 raw Markdown。

#### Scenario: Assistant 输出 GFM 表格
- **WHEN** assistant message 包含 GFM Markdown 表格
- **THEN** 移动端会话显示为表格
- **AND** 表格在窄屏上可以横向滚动或以等效方式保持可读
- **AND** 表格不得撑破会话容器或遮挡 composer

#### Scenario: Assistant 输出代码块
- **WHEN** assistant message 包含 fenced code block
- **THEN** 移动端会话显示为代码块
- **AND** 长代码行不得撑破 viewport
- **AND** 原始文本仍可被复制

#### Scenario: Assistant 输出危险 HTML
- **WHEN** assistant message 包含 raw HTML、事件属性、`javascript:` 链接或等效危险内容
- **THEN** 渲染器会移除或转义危险内容
- **AND** 不执行 agent 提供的脚本、事件 handler 或未知嵌入内容

#### Scenario: Renderer 加载失败
- **WHEN** Markdown renderer 或 sanitizer 无法加载
- **THEN** 会话回退到 plain text 安全渲染
- **AND** 用户仍可以查看、复制、继续会话、审批和取消 turn

### Requirement: 流式 assistant 输出保持可读
移动端 SHALL 在 assistant 回复仍在流式更新时保持 Markdown transcript 可读。

#### Scenario: 流式输出未闭合代码块
- **WHEN** assistant draft 包含开始但尚未闭合的 fenced code block
- **THEN** 移动端临时按代码块渲染已收到内容
- **AND** 后续事件到达后重新渲染最终结构
- **AND** 未闭合结构不得吞掉后续整条 transcript

#### Scenario: 流式输出正在追加表格
- **WHEN** assistant draft 正在追加 Markdown 表格行
- **THEN** 已收到的表格内容保持可读
- **AND** 后续新增行不导致页面大幅跳动或横向溢出

### Requirement: Agent 动作以结构化 transcript part 展示
移动端 SHALL 将可获得的 agent 动作和运行结果渲染为结构化 transcript part，而不是只依赖 assistant 自然语言描述。

#### Scenario: Agent 执行命令
- **WHEN** session events 包含命令执行状态
- **THEN** transcript 显示 compact 命令 part
- **AND** part 显示命令摘要、状态和 bounded output
- **AND** 该状态来自结构化 event 而不是从 assistant 文本中猜测

#### Scenario: Agent 产生测试结果
- **WHEN** session events 包含测试命令和结果
- **THEN** transcript 显示测试结果 part
- **AND** part 显示 pass/fail/cancelled 状态、命令和可用 artifact 链接

#### Scenario: Turn 完成后有 Git summary
- **WHEN** desktop agent 生成 Git result summary
- **THEN** transcript 显示 Git summary part
- **AND** part 显示 changed files、stats、branch/ref 或 worktree 状态中的可用信息

### Requirement: Decision controls 精致且适合手机
移动端 SHALL 使用统一、紧凑、可访问的 decision controls 展示 approval、interaction 和 Plan Mode 选择。

#### Scenario: Agent 请求 Plan Mode 选择
- **WHEN** agent 发起包含多个选项的 interaction
- **THEN** 移动端显示紧凑 option rows 或 segmented list
- **AND** 当前选中态清晰可见
- **AND** 选项控件不得以粗重大卡片占据过多屏幕高度

#### Scenario: 选项包含长文案
- **WHEN** interaction option 的 label 或 description 很长
- **THEN** 文案在控件内换行或截断为可读布局
- **AND** 不与按钮、输入框或后续内容重叠

#### Scenario: 用户选择其他输入
- **WHEN** interaction 支持 `其他` 输入
- **THEN** 其他输入默认不占据大块空间
- **AND** 用户选中 `其他` 后再展开输入框
- **AND** 提交 payload 保持现有 interaction API 语义

#### Scenario: Agent 请求命令或文件修改审批
- **WHEN** session 有 pending approval
- **THEN** transcript 或审批区域显示 compact decision card
- **AND** 长命令、cwd、文件列表或 patch detail 默认摘要化
- **AND** 用户可以展开查看详情后批准或拒绝

### Requirement: Transcript 渲染保持 Echo 安全边界
Transcript renderer SHALL 不扩大移动端对本机文件、shell 或桌面 agent 的权限。

#### Scenario: Agent Markdown 包含本机路径或 shell 文本
- **WHEN** assistant message 中出现本机路径、命令或 shell 输出
- **THEN** renderer 仅把它作为文本或结构化摘要展示
- **AND** 不把它变成可执行的移动端操作

#### Scenario: Markdown 包含图片语法
- **WHEN** assistant message 包含 Markdown image
- **THEN** 移动端默认不加载第三方远程图片
- **AND** Echo attachments/artifacts 继续通过已有 authenticated resource path 渲染

#### Scenario: 用户复制消息
- **WHEN** 用户点击复制 assistant message
- **THEN** 复制内容为原始 assistant 文本或等效原始 Markdown
- **AND** 不复制 sanitizer 生成的内部 HTML
