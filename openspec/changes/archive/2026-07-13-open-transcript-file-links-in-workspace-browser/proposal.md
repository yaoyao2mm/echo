## Why

移动端富文本已经会把 agent 输出中的 Markdown link 渲染成橙色链接，但 renderer 当前把 `/...`、`./...` 和 `../...` 都当成普通安全 URL，并统一设置 `target="_blank"`。当 agent 给出本机文件链接，例如 Workspace 内的 `/Users/.../docs/example.md`，浏览器会把它当成站内网页路径，最终打开一个不存在的页面。

Echo 已经有受 Workspace allowlist、相对路径校验、敏感文件和 symlink 防护的文件浏览器。Workspace 文件引用不应该离开 Echo，而应该直接打开右侧文件面板，定位目录并预览对应文件。Worktree Session 还必须读取该 Session 的 Worktree 版本，不能错误展示主 checkout 中的同名文件。

## What Changes

- 将富文本链接分类为外部 URL、Echo resource、页面 fragment 和 Workspace 文件引用。
- Workspace 文件引用渲染为内部 file action，不再使用 `_blank` 页面导航。
- 点击后打开现有文件面板，加载父目录并预览目标文件。
- 支持相对路径、当前 Workspace 内的绝对路径，以及 `:line` / `#Lline` 行号引用。
- 使用当前消息所属 Session 的 Workspace/Worktree 上下文解析文件，而不是仅使用全局当前项目。
- 文件不存在、Desktop 离线、敏感、二进制或越界时，在文件面板中显示 bounded 错误，不跳转空页面。
- 外部 `https`/`http`/`mailto` 与 authenticated Echo artifact/attachment 链接保持原有安全行为。

## Capabilities

### Added Capabilities

- `mobile-transcript-file-navigation`: 用户可以从 agent transcript 的文件引用直接进入 Echo 文件浏览器并定位对应文件。

### Modified Capabilities

- `mobile-agent-transcript-rendering`: Markdown link renderer 能区分 Workspace 文件引用和普通网页链接。

## Non-Goals

- 不把任意本机绝对路径变成可访问文件。
- 不增加远程 shell、任意 path read 或绕过敏感文件策略的 API。
- 不在本 Change 中实现代码编辑、保存或 IDE 功能。
- 不把普通文本中所有看起来像路径的字符串自动变成链接；v1 只处理明确 Markdown link 或结构化 file part。
- 不改变外部网页、attachment 和 artifact 的既有打开方式。

## Impact

- Markdown renderer：link 分类、内部 file-reference metadata 和 click delegation。
- File browser：按 Session context 打开目录/文件、行号定位和错误状态。
- Relay/Desktop：支持 opaque Session execution target，仍只接受校验后的相对路径。
- Tests：link 分类、Workspace/Worktree 定位、移动端面板和路径安全。
