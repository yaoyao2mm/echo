## 1. 桌面端 Skill Registry

- [x] 1.1 定义 Agent Skill public metadata：`id`、`name`、`description`、`source`、`providers`、`enabled`、`showInComposer`、`syncState`。
- [x] 1.2 扩展 `src/lib/agentSkills.js`，从 Echo shared registry、Codex、Claude Code 等 root 发现并合并 Skills。
- [x] 1.3 增加桌面端本地 desired-state 文件，支持按 agent profile 隔离。
- [x] 1.4 实现 enable/disable/showInComposer/targetProviders 的状态更新。
- [x] 1.5 实现 materialize/sync 到目标 backend skill root，并做 realpath/symlink escape 防护。
- [x] 1.6 在 desktop runtime snapshot 中广播 enabled Skills、同步状态和 Skill 管理 capability。

## 2. Relay 与命令队列

- [x] 2.1 新增 Skill 管理 command 类型：刷新、更新状态、重试同步。
- [x] 2.2 校验 `targetAgentId`、owner user、`skillId` 和 `targetProviders` 都来自 desktop-advertised capability。
- [x] 2.3 限制命令 payload，禁止移动端传本机路径、文件正文或 shell 命令。
- [x] 2.4 command 完成后刷新 agent snapshot，使移动端实时看到菜单变化。

## 3. 移动端 Skills 管理页

- [x] 3.1 在设置页“集成”区域新增 `Skills` 入口，与 MCP 同级。
- [x] 3.2 新增 `Skills 管理` 子页：概览、列表、刷新、空状态、错误状态。
- [x] 3.3 支持启用/停用、显示/隐藏于快捷菜单、选择目标 backend、重试同步。
- [x] 3.4 清晰区分 Quick Skills、Agent Skills、MCP 的说明和文案。
- [x] 3.5 返回行为和 MCP/访问管理/账户子页一致：子页返回设置页。

## 4. Composer Agent Skills 菜单

- [x] 4.1 只显示 `enabled=true` 且 `showInComposer=true` 的 Agent Skills。
- [x] 4.2 根据当前 backend/session backend 过滤不可用 Skill。
- [x] 4.3 enable/disable/pin 变化后无需刷新页面即可更新菜单。
- [x] 4.4 保留 `$skill-name` 插入行为和现有 composer 可用性逻辑。

## 5. 文档与安全

- [x] 5.1 更新 README，解释 Quick Skills、Agent Skills、MCP 的区别。
- [x] 5.2 记录桌面端 Skill root、shared registry、状态文件和多 profile 行为。
- [x] 5.3 给未知来源、同步失败、不可写 root 增加 bounded 用户提示。

## 6. 验证

- [x] 6.1 增加 `agentSkills` registry 单元测试：合并、启停状态、provider 状态、路径安全。
- [x] 6.2 增加 relay command 测试：owner/targetAgentId 隔离和未知 skill/provider 拒绝。
- [x] 6.3 增加移动端非 e2e 测试：Skills 子页导航、启停/pin、composer 菜单过滤。
- [x] 6.4 运行 `pnpm run check:js`。
- [x] 6.5 运行 `pnpm test`。
- [x] 6.6 不运行 e2e，除非明确要求。
