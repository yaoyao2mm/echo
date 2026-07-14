## 为什么

Echo 现在已经能从桌面端 runtime 广播 `installedSkills`，移动端输入框上方也有 Agent Skills 菜单，可以把 `$skill-name` 插入到 composer。但用户不知道这些 Skills 从哪里来、为什么只有少数几个、哪些 backend 能使用它们，也不能在手机上开启、关闭或整理这些 Skills。

这会造成三个产品问题：

- 本机 Skill 管理仍然停留在文件系统和各 agent 自己的配置目录里，普通用户难以理解。
- 同一个 Skill 如果只安装在 Codex 或 Claude Code 的其中一个目录，Echo 不能把它作为“同一份能力”统一管理。
- 移动端 Skills 菜单只能被动展示 runtime 广播结果，不能表达“已启用但未同步”“只对某 backend 启用”“隐藏出快捷菜单”等状态。

Echo 应该把 Agent Skills 作为本机桌面能力来管理：手机负责选择和确认，desktop agent 负责发现本机 Skill、维护启停状态、把已启用 Skill materialize 到各 backend 的本地 skill 目录，并广播最新可用清单。

## 变更内容

- 在移动端设置页的“集成”区域新增 `Skills` 管理入口，和 MCP 同级。
- 增加桌面端 Agent Skill registry：发现 Codex、Claude Code、Echo shared registry 等本机 Skill 来源，合并同名 Skill，记录来源、目标 backend、启用状态、快捷菜单可见状态和同步健康状态。
- 增加 relay 到 desktop agent 的 queued Skill 管理命令，只允许移动端操作桌面端已广告的 Skill id 和目标 backend，不允许传任意本机路径。
- 让 desktop agent 根据启用状态把同一份 Skill 同步到 Codex、Claude Code 等支持 Skill 的 backend，并在成功后刷新 runtime `installedSkills`。
- 让输入框上方的 Agent Skills 菜单只显示“已启用且显示在快捷菜单”的 Skills，并能实时反映 enable/disable/pin 状态。
- 保留 Quick Skills 现有语义：Quick Skill 是 Echo 内保存的 prompt 快捷指令；Agent Skill 是本机 agent runtime 可加载的 `SKILL.md` 能力。

## 参考模式

- VS Code 的 Extensions 管理把“安装”和“临时禁用”区分开，并支持在 workspace 维度启停扩展。这适合作为 Echo Skill 的启用/停用心智模型，但 Echo 的实际写入必须仍由 desktop agent 执行。
- Open WebUI 的 Tools/Functions 把扩展能力放在管理界面里，并明确提示这些扩展可能执行服务器端代码。Echo 的 Skills 也应把风险和来源显示清楚，不把 unknown source 当成普通 prompt。
- Continue 的 prompts/rules/tools 说明了 coding agent 配置通常会分成可调用 prompt、长期规则和工具能力。Echo 需要在 UI 上区分 Quick Skills、Agent Skills 和 MCP，避免用户把三者混淆。

## 能力

### 新增能力

- `mobile-agent-skill-management`: 移动端用户可以查看、启用、停用和整理桌面端本机 Agent Skills，并把同一份 Skill 同步到多个本地 agent backend。

## 非目标

- 不在这个 change 中实现远程安装 marketplace Skill。
- 不允许移动端输入任意本机路径、上传任意 Skill 文件或直接编辑 `SKILL.md`。
- 不在 relay 中保存 Skill 文件正文或本机绝对路径；relay 只保存/转发有界的命令状态和桌面端返回的公开元数据。
- 不绕过 Codex、Claude Code 等 backend 自己的 Skill 加载约束；不支持 Skill 的 backend 不显示为可同步目标。
- 不把 Quick Skills 迁移成 Agent Skills；两者继续共存。
- 不运行 e2e，除非明确要求。

## 影响范围

- Mobile PWA：设置页新增 Skills 管理子页；Agent Skills 菜单根据 enabled/pinned 状态渲染。
- Relay/store：新增短生命周期 Skill 管理命令，和现有 workspace/MCP 命令类似。
- Desktop agent：发现本机 Skill registry、维护启停状态、同步到 backend skill roots、刷新 runtime roster。
- Backend registry：runtime snapshot 中增加 Skill 管理能力、目标 backend 同步状态和 enabled installed skills。
- Tests：桌面 Skill registry 单元测试、relay command 安全测试、移动端设置页和 Agent Skills 菜单非 e2e 测试。
