# Proposal: 增加 OpenSpec 编排异常收敛

## Why

OpenSpec 编排在验收失败或计划已经过时时，会把 Item 留在 `attention`，但移动端通常只提供“重试”。重试复用相同快照和 Worktree；如果失败不是瞬态错误，用户会反复得到相同结果，也无法明确结束这个 Run。规划选择与确认又复用了面板关闭按钮，导致用户丢失上一步上下文。

Echo 的目标是替用户收敛 change，而不是要求用户管理 Attempt。异常状态必须给出与失败性质匹配的恢复动作，并在无法继续时保留成果、结束活跃 Run。

## What Changes

- Relay 统一计算 Run 和 Item 的可用动作，移动端不再复制失败分类规则。
- 瞬态失败保留兼容的重试能力；确定性验收失败提供“让 Echo 处理”，创建有界 Recovery Attempt。
- Recovery Agent 获得失败摘要、历史 Artifact 和原 change 上下文，可以修复实现或修正已经过时的 OpenSpec 内容；Desktop 仍重新执行非 e2e 校验并要求可验证 commit。
- 用户可以“结束本批次”，将无法继续的 Run 置为保留历史的终态，不删除 Attempt、Session、Worktree 或 Artifact。
- OpenSpec 选择、确认和 Run 详情使用明确的返回层级；只有根层级关闭按钮才关闭整个右侧工作台。

## Impact

- Relay orchestration 状态机和 HTTP API
- Desktop orchestration Repair Session 提示
- Mobile OpenSpec 工作台
- SQLite 仍兼容现有数据库，不删除历史数据
