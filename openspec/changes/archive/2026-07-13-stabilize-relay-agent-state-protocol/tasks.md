## 1. Reconciliation 与幂等

- [x] 1.1 记录 running command、实际本地执行和 lease 的最小状态转换表。
- [x] 1.2 增加 lease 过期后的 `reconciling`，避免未确认停止就重复租赁。
- [x] 1.3 增加 Desktop 重连时对 Relay-known running command 的 reconciliation。
- [x] 1.4 实现 completion 和 terminal event 去重，并校验 command id + attempt。

## 2. 协议测试

- [x] 2.1 增加真实 Relay HTTP 的 poll -> lease -> event -> complete 测试。
- [x] 2.2 增加 completion 响应丢失、terminal event 重试和重复请求去重测试。
- [x] 2.3 增加 lease 过期、Desktop 断线/重连和进程重启测试。

## 3. 验证

- [x] 3.1 验证同一命令不会因 lease 过期、网络重试或 Desktop 重连而并发执行两次。
- [x] 3.2 验证无法恢复的命令进入明确终态，不会永久停留在 active/reconciling。
- [x] 3.3 运行 `pnpm run check:js` 和 `pnpm test`。
- [x] 3.4 不运行 e2e，除非用户明确要求。
