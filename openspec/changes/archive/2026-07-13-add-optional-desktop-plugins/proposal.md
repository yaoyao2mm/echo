## 为什么

Echo 目前把 MCP、Agent Skills 和 OpenSpec 当成三类彼此独立的固定能力。OpenSpec 的入口、摘要 API 和桌面读取逻辑始终存在，桌面 owner 无法把它作为一项可选能力关闭，也没有统一位置查看 Echo 后续增加的组合式扩展。

Codex 的插件模型提供了更合适的产品心智：插件是一个有名称、说明和能力清单的容器，可以组合 Skills、MCP、Apps 等能力，并由用户明确安装或启用。Echo 不应在第一阶段远程安装任意插件代码，但应先建立同类的桌面插件注册表和启停控制面。

## 变更内容

- 增加 desktop plugin registry，由 desktop agent 广告内建插件、公开元数据、能力清单和启用状态。
- 增加移动端“插件”管理页，用户可以查看并启用或停用桌面端已广告的插件。
- 增加有界的 `plugin.update` queued command；手机只能提交 desktop snapshot 中已有的 plugin id 和布尔启用状态。
- 把现有 OpenSpec 支持登记为首个内建插件 `open-spec`，默认启用以保持升级兼容。
- OpenSpec 的移动入口、摘要请求和 desktop 文件读取都受插件启用状态约束。
- 插件状态只保存在 desktop agent 本地；relay 不保存插件代码、任意路径或 manifest 正文。

## 非目标

- 不允许移动端安装本地目录、Git 仓库或 marketplace 中的任意插件。
- 不动态加载第三方 JavaScript、shell 命令或 server module。
- 不把 Echo 内建 OpenSpec UI 声称为可直接安装到 Codex 的 marketplace 插件。
- 不改变 MCP 与 Agent Skills 现有管理语义。
- 不运行 e2e，除非明确要求。

## 影响范围

- Desktop agent：插件 registry、本地状态文件、命令处理和 OpenSpec 门禁。
- Relay/store：插件更新命令校验与短生命周期队列。
- Mobile PWA：设置页插件入口、插件管理页、OpenSpec 条件展示。
- Tests：registry、relay 安全校验、移动端开关和 OpenSpec 门禁的非 e2e 测试。
