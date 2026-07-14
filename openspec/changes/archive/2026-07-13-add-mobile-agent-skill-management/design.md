## 背景

Echo 当前已经有两套和“技能”相关但语义不同的对象：

- Quick Skills：保存在 Echo relay/store 里的 prompt 快捷指令，可以是全局或项目级，本质是快速填充/发送 prompt。
- Agent Skills：桌面端从 Codex、Claude Code 等本机 agent 配置目录扫描到的 `SKILL.md` 能力，由 backend runtime 通过 `installedSkills` 广播到移动端，当前只能被动展示。

本 change 只处理 Agent Skills。目标是让移动端能管理“本机 agent 可加载的 Skill”，同时保持 Echo 的边界：手机是控制面，desktop agent 是唯一能读写本机配置目录的进程。

## 设计原则

1. **桌面端是本机 Skill 的权威来源**
   - desktop agent 负责扫描、解析、校验和 materialize Skill。
   - relay 不保存 Skill 文件正文，不解析本机路径，也不成为本机 Skill registry 的事实来源。

2. **移动端只操作桌面端广告的 Skill id**
   - 手机端不能提交任意路径、任意 shell 命令或任意文件内容。
   - 所有 enable/disable/pin/sync 操作都以 `{targetAgentId, skillId, desiredState}` 形式入队。

3. **同名同源合并，跨 backend 同步**
   - 桌面端把 Codex、Claude Code、Echo shared registry 等来源发现的 Skill 合并成一个公开 Skill 条目。
   - 每个 Skill 有 stable id、name、description、source summary、providers、targets、enabled、pinned、sync status。
   - 当用户启用 Skill 并勾选多个 backend，desktop agent 把同一份 Skill materialize 到对应 backend 的 skill root。

4. **启用和快捷菜单可见是两个独立开关**
   - `enabled` 表示 backend runtime 应能加载这个 Skill。
   - `pinned` 或 `showInComposer` 表示它是否出现在输入框上方 Agent Skills 菜单。
   - 这样用户可以启用某个 Skill 给 agent 使用，但不把它放进快捷菜单。

5. **失败可见、可恢复**
   - 如果 Codex 同步成功而 Claude Code 失败，UI 要显示 per-backend 状态。
   - 用户可以重试同步、停用某 backend 目标，或只保留已成功的目标。

## 数据模型

### 桌面端 Skill 条目

```js
{
  id: "sha256:...",
  name: "design-taste-frontend",
  description: "Senior UI/UX Engineer...",
  version: "",
  source: {
    kind: "echo-shared" | "codex" | "claude-code" | "external",
    label: "Echo shared registry",
    pathLabel: "~/.echo-voice/skills/design-taste-frontend"
  },
  providers: [
    { provider: "codex", label: "Codex", installed: true, enabled: true, syncState: "ready" },
    { provider: "claude-code", label: "Claude Code", installed: true, enabled: true, syncState: "ready" }
  ],
  enabled: true,
  showInComposer: true,
  updatedAt: "2026-07-10T00:00:00.000Z"
}
```

`pathLabel` 必须是桌面端生成的显示用路径，移动端不得回传或拼接成本机路径。

### 桌面端状态文件

建议使用桌面端本地状态文件，例如：

- 单 agent：`~/.echo-voice/agent-skills.json`
- 多 profile：`~/.echo-voice/agent-skills-<agentId>.json`

状态文件只保存桌面端可恢复的 desired state：

```js
{
  version: 1,
  skills: {
    "sha256:...": {
      enabled: true,
      showInComposer: true,
      targetProviders: ["codex", "claude-code"]
    }
  }
}
```

## 同步策略

### Skill 来源

第一阶段只扫描桌面端已知 root：

- Echo shared registry：`~/.echo-voice/skills`
- Codex：`$CODEX_HOME/skills` 或 `~/.codex/skills`
- Claude Code：`$CLAUDE_HOME/skills`、`$CLAUDE_CONFIG_DIR/skills` 或 `~/.claude/skills`

可选环境变量：

- `ECHO_AGENT_SKILL_ROOTS`：额外桌面端扫描 root，由 desktop owner 配置，不由手机输入。

### Materialize 方式

优先顺序：

1. 如果 backend 支持引用 shared registry，则写 backend 配置引用 shared Skill。
2. 如果 backend 只支持本地目录，则 desktop agent 复制或 symlink 到该 backend 的 `skills` root。
3. 如果目标 root 不可写，标记该 provider `syncState=failed` 并显示 bounded error。

实现必须避免把移动端命令变成本机任意写入：

- 只能写入 desktop agent 识别的 backend skill root 或 Echo shared registry。
- 目标路径由 desktop agent 根据 stable skill id/name 生成。
- 写入前后做 realpath 校验，拒绝 symlink escape。

## 移动端 UX

### 设置页入口

在设置页“集成”区域新增 `Skills`：

- 标题：`Skills`
- 副标题：`N 个启用 · M 个在快捷菜单`
- 点击进入 `Skills 管理` 子页，和 MCP 子页同级。

### Skills 管理页

页面结构：

- 顶部：返回设置、标题、刷新按钮。
- 概览：已安装、已启用、快捷菜单可见、同步失败数量。
- 列表：按 enabled/pinned/failed/available 分组或筛选。
- 条目内容：名称、描述、来源、可用 backend、同步状态。
- 操作：
  - 启用/停用。
  - 显示/隐藏于输入框 Skills 菜单。
  - backend target 多选：Codex、Claude Code 等。
  - 重试同步。

### Composer Skills 菜单

输入框上方 Agent Skills 菜单只显示：

- 当前选中 desktop agent 广播的 Skill。
- `enabled=true`。
- `showInComposer=true`。
- 当前 backend 或当前会话 backend 可用。

如果用户在管理页关闭一个 Skill，它应在下一次 desktop snapshot/command completion 后从菜单消失；如果打开，则出现在菜单中，不需要用户回桌面手动配置。

## Relay/API

建议复用现有 workspace/MCP command 的桌面队列模式，新增 command 类型：

- `agent-skill.list`：可选，用于强制刷新桌面 Skill registry。
- `agent-skill.update`：更新 enabled/showInComposer/targetProviders。
- `agent-skill.sync`：重试 materialize 到 backend skill roots。

请求约束：

- 必须带 `targetAgentId`。
- `skillId` 必须存在于该 agent 最近广告的 Skill 清单或 desktop agent 当前 registry。
- `targetProviders` 必须是 desktop agent 广告的 backend/provider 集合子集。
- 错误消息要 bounded，不回传未授权路径或文件正文。

## 安全与权限

- 普通 user 只能管理自己可见的 desktop agent 的 Skills。
- owner 可管理自己拥有或授权可见的 agent；跨 owner agent 仍按现有 auth boundary 隔离。
- 不显示完整 `SKILL.md` 正文作为默认行为；可显示名称、描述、来源标签和 provider 状态。
- 未来如果支持查看/编辑 Skill 文件，需要单独 change，因为这会引入文件内容泄露和写入策略问题。
- 如果某 Skill 来源未知、路径不可写或 provider 同步失败，UI 要明确标记，不静默启用。

## 开源参考映射

- VS Code Extensions：借鉴“安装”和“启用/禁用”分离，以及按当前 workspace 控制启停的心智模型。
- Open WebUI Tools/Functions：借鉴在管理界面中展示扩展能力，并把可执行扩展能力视为高风险配置的安全提示。
- Continue Prompts/Rules/Tools：借鉴把可调用 prompt、长期规则和工具能力分成不同配置类型；Echo 应明确区分 Quick Skills、Agent Skills 和 MCP。

这些参考只影响产品模型，不改变 Echo 的安全边界：本机文件系统写入仍只发生在 desktop agent。

## 迁移计划

1. 保留当前 `installedSkills` 广播格式，新增可选字段 `enabled`、`showInComposer`、`providers[].syncState`。
2. 初次启动时把已发现且当前可用的 Skills 默认设为 `enabled=true`、`showInComposer=true`，保持现有菜单不突然清空。
3. 如果用户从移动端停用或隐藏 Skill，写入 desktop state 文件并刷新 runtime snapshot。
4. 后续再考虑 marketplace/install/import；本 change 只做管理已存在或桌面端已配置的本机 Skill。

## 验证

- 单元测试：Skill registry 合并、状态文件读写、目标 provider 校验、symlink escape 防护。
- Relay 测试：Skill command owner/targetAgentId 隔离，拒绝未知 skillId/provider。
- 移动端测试：设置页 Skills 子页导航、启停/pin 交互、composer Agent Skills 菜单过滤。
- 运行 `pnpm run check:js` 和 `pnpm test`。
- 不运行 e2e，除非明确要求。
