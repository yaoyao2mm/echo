## Why

Relay 持有 Session、命令 lease、runtime metadata 和事件，Desktop/backend 持有真实执行进程、native thread 和本机状态。当前系统依赖 polling、heartbeat、lease 和 event replay 保持一致，但状态所有权没有形成完整协议，恢复路径散落在 store、queue、runner 和 desktop agent 中。

当前最重要的风险不是内部文件大小，而是 lease 过期或网络重试时可能重复执行，以及 Desktop 重连后 Session 可能卡住。这个 Change 只处理这些可观察的可靠性问题。

## What Changes

- 明确 running command 在 lease 过期和 Desktop 重连时的 reconciliation 语义。
- 让 command completion 和 terminal event 的网络重试保持幂等。
- 增加真实 Relay HTTP 到 Desktop command lifecycle 的协议级测试。

## Capabilities

### Added Capabilities

- `relay-agent-state-protocol`: Relay 与 Desktop 在超时、重试和重连时不会重复执行或永久卡住 Session。

## Non-Goals

- 不把 Codex app-server 暴露到网络。
- 不更换 SQLite、Express 或现有 polling/SSE transport。
- 不拆分 `codexStore.js`，不重做 migration runner，也不引入全面的协议版本体系。
- 不统一所有 Queue event name 或重建 backend thread 模型。
- 不改变用户已经依赖的 Session 外部行为。

## Impact

- Store/queue/server/desktop agent：running command reconciliation 和幂等终态写入。
- Tests：Relay HTTP、lease、重连和重复投递 contract tests。
