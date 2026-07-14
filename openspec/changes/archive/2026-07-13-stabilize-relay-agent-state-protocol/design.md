## 最小状态所有权

| 状态 | 权威方 | Relay 保存内容 |
| --- | --- | --- |
| 用户、设备、Workspace 绑定 | Relay | 完整授权关系 |
| Session/command/lease | Relay | 权威状态机 |
| 本机路径、进程、Worktree 实体 | Desktop | 仅 opaque id 和摘要 |
| Native backend thread | Backend/Desktop | 受限 binding 和恢复状态 |
| Session transcript/event | Relay | bounded、版本化事件 |
| 当前 turn 是否仍实际运行 | Desktop heartbeat + terminal event | 最近确认状态 |

## 恢复原则

1. 复用现有 command id、attempt、lease owner 和 deadline，不为本 Change 重做 envelope。
2. Desktop completion 以 command id + attempt 幂等；terminal event 使用现有稳定身份或最小去重 key。
3. Lease 过期不等同于本地执行已经停止；Relay 先进入 `reconciling`，再根据 Desktop 响应决定 running、requeue 或 failed。
4. Desktop 重连时只核对 Relay 仍认为 running 的命令，不建立通用的本地进程注册表。
5. 若现有 schema 足够表达状态，禁止为架构整齐新增表或迁移。

## 最小状态转换

| Relay command | Desktop 本地状态/输入 | Relay 动作 | 是否允许再次 lease |
| --- | --- | --- | --- |
| `queued` | poll | 以当前 `attempt` lease，并绑定 agent + instance + deadline | 是，仅原子 lease 一次 |
| `leased` | heartbeat/event/completion，且 command id + attempt 匹配 | 续租、追加去重 event，或写入一次终态 | 否 |
| `leased` | lease deadline 过期 | 转为 `reconciling`，保留原 lease owner，并设置有界 reconciliation deadline | 否 |
| `reconciling` | `running` | 绑定当前 Desktop instance，恢复为 `leased` 并续租 | 否 |
| `reconciling` | `not_started` | 转为 `queued`，`attempt + 1` | 是，这是唯一的超时重租路径 |
| `reconciling` | `unknown`/其它无法确认状态 | command 和 Session 进入明确失败终态 | 否 |
| `reconciling` | reconciliation deadline 过期 | command 和 Session 进入明确失败终态 | 否 |
| `done`/`failed` | 相同 agent 重发相同 command id + attempt + result | 返回成功，不追加第二个终态 event | 否 |

Session event 的协议去重键为 `command id + attempt + event identity`。旧 Desktop 未提供协议字段时继续走既有 lease 校验；提供了 command id/attempt 后必须精确匹配，不能降级为宽松校验。

## 测试策略

使用临时 HOME/SQLite 启动真实 Relay HTTP server 和可控 fake Desktop client，覆盖 poll -> lease -> event -> complete、completion 响应丢失、lease 超时、断线重连和重复投递，不运行浏览器 e2e。
