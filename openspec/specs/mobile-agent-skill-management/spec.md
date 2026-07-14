# mobile-agent-skill-management Specification

## Purpose
TBD - created by archiving change add-mobile-agent-skill-management. Update Purpose after archive.
## Requirements
### Requirement: 移动端可以管理桌面端 Agent Skills
移动端 SHALL 提供一个设置页子页面，用于查看、启用、停用和整理当前桌面 agent 广播的本机 Agent Skills。

#### Scenario: 用户打开 Skills 管理页
- **WHEN** 用户在移动端设置页点击 `Skills`
- **THEN** 应用进入 `Skills 管理` 子页
- **AND** 页面显示当前 desktop agent 的 Skill 数量、启用数量、快捷菜单可见数量和同步失败数量
- **AND** 用户可以返回设置页而不丢失当前项目或会话状态

#### Scenario: 桌面端尚未同步 Skills
- **WHEN** 当前 desktop agent 在线但还没有返回 Skill registry
- **THEN** 页面显示等待或空状态
- **AND** 页面提供刷新动作
- **AND** 不显示移动端手动输入本机路径的入口

### Requirement: Agent Skills 与 Quick Skills 和 MCP 清晰区分
系统 SHALL 在数据模型和 UI 文案上区分 Agent Skills、Quick Skills 和 MCP。

#### Scenario: 用户查看 Skills 管理页
- **WHEN** 页面展示 Agent Skills
- **THEN** 文案说明这些 Skills 是本机 agent runtime 可加载的 `SKILL.md` 能力
- **AND** 不把它们描述为 Echo 保存的 prompt 快捷指令
- **AND** 不把它们描述为 MCP server/tool

#### Scenario: 用户打开输入框上方 Skills 菜单
- **WHEN** 用户点击 composer 的 Agent Skills 菜单
- **THEN** 菜单只显示已启用且允许显示在快捷菜单中的 Agent Skills
- **AND** Quick Skills 仍保留在 Quick Skills 菜单中

### Requirement: 同一份 Skill 可以同步到多个本地 agent backend
desktop agent SHALL 支持把同一份已发现 Skill 同步到 Codex、Claude Code 等支持 Skill 的本地 backend。

#### Scenario: 用户启用 Skill 并选择多个 backend
- **WHEN** 用户在 Skills 管理页启用一个 Skill 并选择 Codex 与 Claude Code
- **THEN** relay queues 一个有界 Skill 管理命令给目标 desktop agent
- **AND** desktop agent 将该 Skill materialize 到对应 backend 的本地 Skill root 或配置引用
- **AND** desktop agent 刷新 runtime snapshot，让移动端看到每个 backend 的同步状态

#### Scenario: 某个 backend 同步失败
- **WHEN** Skill 同步到一个 backend 成功但同步到另一个 backend 失败
- **THEN** Skill 仍显示为部分可用
- **AND** UI 显示失败 backend 和 bounded 错误信息
- **AND** 用户可以重试同步或取消该 backend target

### Requirement: Skill 管理命令遵守桌面端安全边界
系统 SHALL 保持手机端只发送桌面端广告的 Skill id 和目标 backend 状态，不允许通过 Skill 管理引入任意本机路径或 shell 执行。

#### Scenario: 移动端请求更新 Skill 状态
- **WHEN** 移动端提交 enable/disable/showInComposer/targetProviders 更新
- **THEN** 请求 payload 只包含 `targetAgentId`、`skillId` 和有界 desired state
- **AND** relay 校验用户只能操作自己可见的 desktop agent
- **AND** desktop agent 校验 `skillId` 和 `targetProviders` 来自本机已发现/已广告的 registry

#### Scenario: 请求包含未知 Skill 或 backend
- **WHEN** 请求引用未知 `skillId` 或未广告的 backend/provider
- **THEN** relay 或 desktop agent 拒绝该命令
- **AND** 不写入本机 Skill root
- **AND** 返回 bounded 错误

#### Scenario: Skill materialize 遇到路径逃逸
- **WHEN** 目标 Skill root、source path 或 materialized path 通过 symlink/realpath 逃逸出 desktop agent 允许的 Skill root
- **THEN** desktop agent 拒绝写入
- **AND** 标记该 provider 同步失败
- **AND** 不向 relay 返回敏感绝对路径或 Skill 文件正文

### Requirement: Composer Skills 菜单实时反映管理状态
移动端 composer Agent Skills 菜单 SHALL 根据 desktop agent 最新 Skill registry 和当前 backend 过滤显示。

#### Scenario: 用户隐藏 Skill
- **WHEN** 用户在 Skills 管理页关闭 `显示在快捷菜单`
- **THEN** desktop agent 保存状态并刷新 snapshot
- **AND** composer Agent Skills 菜单不再显示该 Skill
- **AND** 已有会话和历史消息不被修改

#### Scenario: 用户重新显示 Skill
- **WHEN** 用户重新开启 `显示在快捷菜单`
- **THEN** Skill 在下次 snapshot 或命令完成后回到 Agent Skills 菜单
- **AND** 点击后仍按现有规则向 composer 插入 `$skill-name`
