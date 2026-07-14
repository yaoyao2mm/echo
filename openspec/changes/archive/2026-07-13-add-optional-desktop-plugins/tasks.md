## 1. Desktop 插件内核

- [x] 1.1 实现内建插件 registry、状态文件和启停更新
- [x] 1.2 在 desktop runtime snapshot 中广告插件能力
- [x] 1.3 为 OpenSpec desktop summary 增加插件门禁

## 2. Relay 命令

- [x] 2.1 增加 plugin list/update queued command
- [x] 2.2 校验目标 agent 广告能力和 plugin id
- [x] 2.3 OpenSpec 请求在插件关闭时提前拒绝

## 3. Mobile PWA

- [x] 3.1 设置页增加插件入口与管理子页
- [x] 3.2 支持刷新和启停 desktop-advertised 插件
- [x] 3.3 OpenSpec 入口和已打开面板跟随插件状态

## 4. 验证

- [x] 4.1 增加插件 registry 和 relay command 单元测试
- [x] 4.2 增加移动端非 e2e 测试
- [x] 4.3 运行 `pnpm run check:js` 和 `pnpm test`
