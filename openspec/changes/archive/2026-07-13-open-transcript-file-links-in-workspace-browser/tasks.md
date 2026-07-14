## 1. Link 分类与渲染

- [x] 1.1 定义 external、echo-resource、fragment、workspace-file 和 invalid link classifier。
- [x] 1.2 修改 markdown-it link rule，让 Workspace 文件引用生成内部 action，普通外部链接保留 `_blank` 安全属性。
- [x] 1.3 在 sanitize 后通过事件委托处理内部 file action，禁止信任 agent 原始 `data-*` 属性。
- [x] 1.4 支持相对路径、受信 Workspace 内绝对路径、目录和 `:line` / `#Lline` 格式。

## 2. Session-scoped 文件目标

- [x] 2.1 定义包含 Workspace、Session、opaque execution target、relative path 和 line 的 file reference。
- [x] 2.2 扩展文件请求，使 Desktop 能根据 Session ownership 解析 base Workspace 或受管 Worktree。
- [x] 2.3 确保手机和 Relay 不发送或保存 Worktree 真实路径，Desktop 只接受校验后的相对路径。
- [x] 2.4 Worktree discarded/unavailable 时明确失败，禁止静默回退主 Workspace。

## 3. 文件面板导航

- [x] 3.1 新增统一 `openWorkspaceFileReference()`，供 Markdown link 和未来 structured transcript parts 复用。
- [x] 3.2 点击文件时打开现有面板、加载父目录并直接读取 preview；点击目录时打开目录列表。
- [x] 3.3 增加 preview 行号、滚动和高亮，同时处理截断或超出范围提示。
- [x] 3.4 保留 transcript scroll/focus，关闭文件面板后返回原 Conversation 位置。
- [x] 3.5 对 Desktop 离线、不存在、敏感、二进制、过大和越界引用显示 bounded 面板状态。

## 4. 验证

- [x] 4.1 增加 Markdown link classifier、sanitize 和 click delegation 测试。
- [x] 4.2 增加 base Workspace、Worktree、discarded Worktree、目录和行号定位测试。
- [x] 4.3 增加绝对路径越界、`..`、symlink escape、敏感和二进制文件测试。
- [x] 4.4 增加移动端非 e2e 的面板打开、错误状态和返回位置测试。
- [x] 4.5 运行 `pnpm run check:js` 和 `pnpm test`。
- [x] 4.6 不运行 e2e，除非用户明确要求。
