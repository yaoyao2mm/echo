## Event 边界

本 Change 只在现有 event normalization 写入边界增加两层保护：

1. 递归删除已知敏感 key，例如 authorization、cookie、token、secret、password、apiKey 和 env。
2. 对最终序列化事件应用固定的单事件大小上限；超出时保存现有结构化字段和 bounded 摘要。

事件只需记录是否发生 redaction 或 truncation。这里不增加 Session 总量配额、数据保留配置、完整 secret scanner 或新的 artifact 层。

## Attachment Staging

Desktop 下载 attachment 到 Echo data directory 下的 Session 专属目录。Runner 通过受控路径引用文件；不得在 Workspace 创建 `.echo-*` 临时目录。真实 staging path 不发送给 Relay/手机。

成功、失败、取消时清理对应目录。Desktop 启动时清理不属于当前活跃执行的旧 staging 目录。所有删除都必须先验证 realpath 位于受管根目录内。

## 兼容性

旧 raw events 保持可读，不回写历史数据。新事件带 redacted/truncated 标志；现有 API 透传这些标志即可，不增加新的数据管理页面。
