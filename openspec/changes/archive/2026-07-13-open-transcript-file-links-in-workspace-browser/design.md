## 当前问题

`renderAgentMarkdown()` 使用 markdown-it。现有 `link_open` rule 对所有通过 `isSafeAgentMarkdownHref()` 的链接添加 `_blank`；而安全函数允许 `/`、`./` 和 `../` 开头的 href。对网页相对链接这可以工作，但本机绝对路径也以 `/` 开头，因此会被错误送给浏览器路由。

文件浏览器已经提供：

- 打开右侧/移动端 sheet；
- 加载 Workspace 相对目录；
- 读取可预览文本文件；
- 阻止敏感文件、二进制、越界 symlink 和非 allowlisted Workspace。

本 Change 复用该能力，不建立第二套文件预览器。

## Link 分类

Markdown link 在 sanitize 前被归一化为以下类别：

1. `external`: `https:`、`http:`、`mailto:`，保留安全新页面行为。
2. `echo-resource`: 受认证的 attachment/artifact route，沿用现有 resource handler。
3. `fragment`: 当前 transcript/page 内 fragment；只有存在已知目标时才处理。
4. `workspace-file`: 明确的相对文件路径，或能够证明位于消息 Session execution root 内的绝对路径。
5. `invalid`: 危险协议、未知绝对路径、无法归属的路径或格式错误，不提供导航。

内部 file action 使用事件委托拦截点击。Sanitizer 只允许 Echo 自己生成的最小 metadata；不能信任 agent 提供的 `data-*` 属性。

## File Reference

归一化结果：

```json
{
  "workspaceId": "opaque-workspace-id",
  "sessionId": "echo-session-id",
  "executionTarget": "workspace-or-session-worktree",
  "relativePath": "docs/example.md",
  "line": 42,
  "column": null
}
```

手机发送给文件 API 的仍是相对路径和 opaque context。真实 Workspace/Worktree path 由 Desktop 根据 Session ownership 解析。手机不能提交任意绝对路径。

绝对路径兼容策略：只有 Desktop 或受信 snapshot 能证明它位于当前 Session 的 base Workspace 或 Worktree root 内时，才转换为相对路径。其他绝对路径显示为不可访问，不尝试读取。

## 打开流程

1. 用户点击 transcript 中的 workspace-file action。
2. 阻止默认 anchor navigation，并记录 transcript focus/scroll return point。
3. 打开现有文件面板。
4. 根据 message/session context 选择 base Workspace 或 Session Worktree。
5. 加载目标父目录并读取文件 preview。
6. 如果包含行号，preview 渲染后滚动并高亮目标行；没有行号时显示文件顶部。
7. 关闭文件面板后恢复 transcript 位置和合理焦点。

宽屏继续表现为右侧文件管理区域；窄屏使用现有 sheet，不引入新的全页 route。

## Worktree 语义

如果消息来自活动 Worktree Session，文件引用优先解析到该 Session 的 Worktree。Worktree 已 discarded/unavailable 时显示明确状态，不静默回退主 Workspace。只有用户显式选择“查看主 Workspace 版本”且 policy 允许时才改变 target。

## 错误与安全

- Desktop 离线：打开面板并显示等待连接/重试状态。
- 文件不存在：保留目标相对路径和返回操作。
- 敏感或二进制文件：沿用现有拒绝和不可预览语义。
- 路径越界或 symlink escape：拒绝，不向 Relay 返回真实 resolved path。
- 外部链接：继续 `noopener noreferrer`，不得被 file handler 拦截。

## 依赖关系

本 Change 基于 `improve-agent-transcript-rendering` 已完成的安全 Markdown renderer，并可与其尚未完成的 structured transcript parts 独立实施。未来结构化 file-change/file-reference part 应复用同一个 `openWorkspaceFileReference()` 入口。
