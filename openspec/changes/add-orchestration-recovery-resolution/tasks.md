# Tasks

## 1. 状态机与 API

- [x] 1.1 为 Run 和 Item 输出统一 `availableActions`
- [x] 1.2 增加有界 Item Recovery 转移并限制普通 retry 为瞬态失败
- [x] 1.3 增加保留成果的 Run finish 终止动作
- [x] 1.4 暴露 recover 与 finish HTTP API 并发送实时更新

## 2. Agent 收敛

- [x] 2.1 Recovery prompt 包含最新失败分类、摘要和 Artifact
- [x] 2.2 Desktop 对 Recovery 结果继续执行现有结构化校验与 commit 门禁

## 3. 移动体验

- [x] 3.1 根据 `availableActions` 显示“让 Echo 处理”，不再复制失败分类
- [x] 3.2 提供“结束本批次”并清晰区分失败终态
- [x] 3.3 选择、确认、Run 详情实现逐级返回与独立关闭

## 4. 验证

- [x] 4.1 增加 Store、Service 和移动 DOM 非 e2e 回归测试
- [x] 4.2 运行 `pnpm run check:js`、`pnpm test` 和 OpenSpec strict validation

## 5. 历史 Run 恢复

- [x] 5.1 Resume 根据 Item/Integration 事实推导状态，不制造虚假执行中
- [x] 5.2 Integration 接受 completed + ready 混合态并只重放 ready Item
- [x] 5.3 覆盖混合态与空 Integration 回归测试
- [x] 5.4 调度器自动修复旧版本遗留的虚假 running 状态
