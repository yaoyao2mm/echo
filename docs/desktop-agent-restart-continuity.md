# Desktop Agent 重启连续性

本文定义 Echo 桌面端 agent 在自身更新、配置刷新或显式重启后的 Conversation（对话）连续性协议。目标是不新增服务，复用现有 Relay、桌面 App supervisor（监督进程）和 desktop agent。

## 不变量

- desktop agent 不得在活跃 turn（轮次）中直接 `kill` 自己，也不得调用会立即重启自身的桌面设置接口。
- Relay 必须在旧进程退出前持久化 restart operation（重启操作）、checkpoint（恢复点）和旧实例的最终回复。
- 桌面 App 始终拥有根 agent 进程；启用多 profile 时，根 agent supervisor 拥有各 profile worker。实际拥有退出进程的 supervisor 负责在 graceful restart exit code（优雅重启退出码）`75` 后快速拉起。
- “重启完成”只能由新的 `agentInstanceId`、heartbeat（心跳）和预期 Git SHA 共同证明，不能由模型自行判断。
- 同一个 restart operation 最多创建一个内部 continuation command（续接命令）；重复 heartbeat 必须幂等。
- 可以恢复对话和未完成任务，不能恢复被终止进程的指令指针。重启只能发生在当前 command 已完成并被 Relay 确认后。
- checkpoint 脚本必须确认当前运行实例声明支持该协议。旧实例看到新 checkout 中的脚本时不得创建无法完成的 restart operation。

## 状态机

```text
requested -> restarting -> resuming -> completed
     |            |            |
     +----------> failed <-----+
```

- `requested`：会话内脚本已把 checkpoint 写入 Relay，但当前 turn 尚未完成。
- `restarting`：Relay 已接受 command completion（命令完成），旧 agent 可以退出。
- `resuming`：新实例和 SHA 已验证，Relay 已向原 session 插入内部 continuation command。
- `completed`：continuation turn 已完成。
- `failed`：SHA 不匹配、重启超时或 continuation 失败。

## 执行顺序

1. Desktop agent 为普通 `start` / `message` command 注入隐藏的重启协议和当前 `sessionId`。
2. Agent 完成提交、推送、部署、测试等其它动作后，最后调用 `scripts/request-desktop-agent-restart.js`。
3. 脚本验证运行实例的 restart protocol capability，读取运行 revision、当前 Git HEAD、agent instance 和 token，向 Relay 创建 restart operation；它不结束进程。
4. Agent 给出“状态已保存，正在重启”的简短回复。Desktop agent 把事件和 command completion 可靠提交给 Relay。
5. Relay 在 completion 响应中返回 `shouldExit`。Desktop agent 停止领取新 session command，等待本机活跃 command 清零，然后以 code `75` 退出。
6. 单 profile 模式由桌面 App 在 500ms 后启动新根 agent；多 profile 模式由根 supervisor 在 500ms 后启动退出的 profile worker。新实例 heartbeat 携带新的 instance ID 和 `sourceRevision`。
7. Relay 验证事实后向原 session 插入不对应可见用户消息的内部 continuation command。
8. 新 agent 先汇报已验证的重启和 SHA，再根据 checkpoint 继续任务。

## 移动端表现

手机始终与 Relay 保持 SSE（服务器发送事件）连接，并从 session 的 `restartOperation` 渲染：

- `requested`：准备重启 / 状态已保存；
- `restarting`：正在重启 / 等待新实例上线；
- `resuming`：已重新连接 / 正在恢复对话；
- `failed`：使用 session error 和结构化 `agent.restart.failed` 事件显示原因。

重启后两分钟没有新实例上线，Relay 将 operation 标记为失败，不能无限显示“正在重启”。

## API

- `POST /api/agent/codex/restarts`：旧 agent 创建 checkpointed restart operation。
- `POST /api/agent/codex/sessions/commands/complete`：完成当前 command，并在响应中返回是否应退出。
- `POST /api/agent/codex/heartbeat`：新实例上线、校验 revision、创建 exactly-once continuation。

这些接口继续使用现有 agent token，不公开本机路径、shell 参数或新的远程执行能力。

## 激活与诊断

- 支持本协议的 worker 设置 `ECHO_DESKTOP_RESTART_PROTOCOL_VERSION=1` 和自身启动时的 `ECHO_SOURCE_REVISION`。脚本只信任运行实例的 capability，不把当前 checkout 中存在新脚本误判为运行代码已经升级。
- 从协议引入前的旧版本升级时，checkpoint 脚本必须拒绝请求并要求完成当前 turn 后一次性重新打开 Echo。协议激活后，后续 agent 代码升级全部走本协议。
- startup heartbeat 返回的 reconciliation 结果写入桌面 Agent 日志，至少包含 operation、status、new instance 和 revision。失败结果同时记录 Relay 返回的 error。
- `75` 只表示已持久化 checkpoint 后的预期退出；其它退出码仍按 crash 处理并使用较慢退避。
