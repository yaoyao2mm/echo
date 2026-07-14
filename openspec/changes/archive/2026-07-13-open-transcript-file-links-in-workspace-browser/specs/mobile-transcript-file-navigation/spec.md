## ADDED Requirements

### Requirement: Transcript 必须区分 Workspace 文件引用与网页链接
移动端 SHALL 在渲染 agent Markdown link 时区分 Workspace 文件、外部 URL、Echo resource 和无效引用。

#### Scenario: Agent 输出 Workspace 相对文件链接
- **WHEN** assistant message 包含 `[配置](docs/config.md)`
- **THEN** 链接被标记为内部 Workspace file action
- **AND** 不设置为打开新网页

#### Scenario: Agent 输出外部网页链接
- **WHEN** assistant message 包含合法 `https://` 链接
- **THEN** 链接继续以安全外部链接方式打开
- **AND** 使用 `noopener noreferrer`

#### Scenario: Agent 输出未知绝对路径
- **WHEN** href 是无法证明属于当前 Session Workspace/Worktree 的绝对路径
- **THEN** 系统不读取该路径
- **AND** 不把它当作站内网页导航

### Requirement: 点击文件引用必须打开现有文件浏览器
移动端 SHALL 复用现有文件面板，定位目标父目录并预览文件。

#### Scenario: 点击可预览文本文件
- **WHEN** 用户点击 transcript 中有效的 Workspace 文件引用
- **THEN** 右侧文件面板或移动端 sheet 打开
- **AND** 文件树定位到目标父目录
- **AND** preview 显示目标文件
- **AND** 浏览器地址不会跳到不存在的页面

#### Scenario: 点击目录引用
- **WHEN** 有效引用指向 Workspace 目录
- **THEN** 文件面板打开该目录列表
- **AND** 不请求文件 preview

### Requirement: 文件引用必须使用消息所属 Session 的执行上下文
系统 SHALL 根据产生该消息的 Session 选择 base Workspace 或受管 Worktree 文件目标。

#### Scenario: Worktree Session 引用已修改文件
- **WHEN** assistant message 属于活动 Worktree Session
- **AND** 引用文件在 Worktree 中已修改但主 Workspace 尚未 Apply
- **THEN** 文件面板显示 Worktree 版本
- **AND** 不静默显示主 Workspace 的旧版本

#### Scenario: Worktree 已被丢弃
- **WHEN** 用户点击来自已 discarded Worktree 的文件引用
- **THEN** 文件面板显示该执行目标不可用
- **AND** 不自动回退主 Workspace

### Requirement: 文件引用可以定位行号
移动端 SHALL 识别受支持的 `:line` 或 `#Lline` 后缀，并在 preview 中定位目标行。

#### Scenario: 点击带行号的引用
- **WHEN** 用户点击 `src/server.js:865` 或等价 `src/server.js#L865` 引用
- **THEN** 文件 preview 打开对应文件
- **AND** 滚动并突出显示第 865 行

#### Scenario: 行号超出范围
- **WHEN** 引用行号大于可预览内容范围
- **THEN** 文件仍正常打开
- **AND** UI 显示无法定位该行的 bounded 提示

### Requirement: 文件导航必须保持现有安全边界
系统 SHALL 只读取 Desktop allowlisted Workspace 或 Session-owned Worktree 内的校验后相对路径。

#### Scenario: 路径包含越界跳转
- **WHEN** 文件引用通过 `..` 或 symlink 尝试离开执行根目录
- **THEN** Desktop 拒绝读取
- **AND** Relay 和手机不获得越界文件内容或真实 resolved path

#### Scenario: 文件敏感或不可预览
- **WHEN** 引用指向被现有策略阻止的 secret、binary 或过大文件
- **THEN** 文件面板显示现有不可预览状态
- **AND** 不绕过 file browser policy

### Requirement: 文件面板失败不得破坏 Conversation
移动端 SHALL 在文件不存在、Desktop 离线或请求失败时保留 transcript 和返回位置。

#### Scenario: Desktop 暂时离线
- **WHEN** 用户点击文件引用但 Desktop 不在线
- **THEN** 文件面板显示等待连接或重试状态
- **AND** 不跳转空白页面
- **AND** 关闭面板后用户回到原 Conversation 位置
