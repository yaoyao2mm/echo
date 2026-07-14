## 设计原则

1. **桌面端是插件权威来源**
   - desktop agent 决定有哪些插件、每个插件包含哪些能力以及是否启用。
   - relay 只转发桌面端已广告 plugin id 的期望状态，不发现或执行插件。

2. **插件是能力容器**
   - 公开条目包含 `id`、`name`、`description`、`version`、`source`、`capabilities` 和 `enabled`。
   - `capabilities` 第一阶段使用有界 id，例如 `open-spec.summary`、`open-spec.mobile-progress`。
   - 后续可扩展 Skills、MCP 或 Apps 组件，但不能由移动端字符串决定本机执行内容。

3. **启停必须端到端生效**
   - UI 只展示已启用 OpenSpec 插件的工作区入口。
   - relay 在已广告插件关闭时拒绝创建 OpenSpec 摘要请求。
   - desktop agent 在执行请求前再次读取本地插件状态，关闭时拒绝摘要读取。

4. **升级兼容**
   - 首次运行没有状态文件时，内建 OpenSpec 插件默认启用，保持现有用户行为。
   - 老 desktop agent 未广告 `plugins.capability.canManage` 时，移动端隐藏插件管理入口。

## 数据模型

Desktop runtime 新增：

```js
{
  plugins: {
    version: 1,
    capability: {
      canManage: true,
      commandTypes: ["plugin.list", "plugin.update"]
    },
    plugins: [
      {
        id: "open-spec",
        name: "OpenSpec",
        description: "在移动端查看工作区 OpenSpec 变更与任务进度",
        version: "1.0.0",
        source: { kind: "echo-builtin", label: "Echo 内建" },
        capabilities: ["open-spec.summary", "open-spec.mobile-progress"],
        enabled: true
      }
    ],
    summary: { total: 1, enabled: 1 }
  }
}
```

桌面状态文件使用 `~/.echo-voice/desktop-plugins[-<agentId>].json`：

```js
{
  version: 1,
  plugins: {
    "open-spec": { "enabled": false }
  }
}
```

## 命令与安全

- `plugin.list`：要求刷新 desktop registry snapshot。
- `plugin.update`：只接受 `{pluginId, enabled}`。
- relay 必须确认目标 agent 在线、广告了管理能力并且 plugin id 存在。
- desktop agent 必须再次从自身 registry 验证 plugin id。
- 状态文件路径由 desktop agent 固定生成，移动端不能提供路径。

## 后续扩展

第二阶段可以增加由 desktop owner 配置的只读插件目录，并解析兼容 `.codex-plugin/plugin.json` 的公共字段；任何代码加载、marketplace 安装、签名或权限声明都需要独立 change 和更严格的信任模型。
