## 1. 插件契约与持久模型

- [x] 1.1 在 Desktop plugin registry 增加默认关闭的 `orchestration` 内建插件、依赖和 capability 广告
- [x] 1.2 实现插件依赖校验、运行中 drain/pause 语义及 Relay/Desktop 双重门禁
- [x] 1.3 追加 Orchestration Run、Change Item、Attempt、Dependency 和 Artifact 的 SQLite schema 与兼容迁移
- [x] 1.4 实现 provider-neutral 的 Run/Item 公共结果与 bounded Artifact normalization

## 2. 调度与恢复

- [x] 2.1 实现 Run 创建、路线确认、固定 OpenSpec 快照和 base commit 的 API
- [x] 2.2 实现依赖就绪判断、稳定排序、全局/Workspace 并发上限和原子 claim/lease
- [x] 2.3 将现有 Session/Turn 适配为 implement、verify、repair 和 aggregate-verify Attempt
- [x] 2.4 实现同 Session/Worktree continuation、失败分类、有上限退避和手动重试
- [x] 2.5 实现 Desktop 失联、Relay/Desktop 重启、lease 过期和现有本地状态的 reconciliation
- [x] 2.6 实现暂停、继续、取消和人工接管的幂等状态转移

## 3. Change Worktree 与验收

- [x] 3.1 为每个可写 Item 创建受管 Change Worktree，并固定 Workspace、base branch、base commit 和 owner metadata
- [x] 3.2 生成只允许处理指定 change 的 implement prompt 与精简 continuation prompt
- [x] 3.3 收集 Git summary、相关测试、OpenSpec strict validation 和 verifier 结论为 bounded Artifact
- [x] 3.4 只有在 commit 与 verifier Artifact 都满足后才将 Item 标记为 `ready`
- [x] 3.5 为失败验收实现有限 Repair Attempt，并在确定性失败后转入移动端待处理

## 4. Integration Lane

- [x] 4.1 从 Run base commit 创建受管 Integration Worktree 与独立 `echo/orchestration-*` 分支
- [x] 4.2 按确认顺序幂等整合 ready commit，不调用普通 Session Worktree Apply
- [x] 4.3 对 Git 冲突生成 bounded 摘要并支持专用 Repair Session 或人工接管
- [x] 4.4 运行聚合校验并生成最终分支、commit 和 validation Artifact
- [x] 4.5 验证编排完成、失败、取消和 cleanup 均不会修改用户当前 checkout
- [x] 4.6 聚合校验通过后在固定分支、固定 HEAD 和干净 checkout 上自动 fast-forward，偏离时保留结果并进入待处理

## 5. 极简移动工作台

- [x] 5.1 将 OpenSpec 面板实现为浏览、选择和运行三种互斥模式，不增加常驻顶层页面
- [x] 5.2 精简默认 change 行，只保留名称、状态和稳定尺寸的轻量进度信号
- [x] 5.3 将 proposal、spec 标签、task checklist 和单项操作下沉到按需详情
- [x] 5.4 实现多选、排序、必要依赖确认和单一“开始”主操作
- [x] 5.5 实现运行分组、待处理入口、暂停/继续/取消/重试及 Session 下钻返回
- [x] 5.6 通过 SSE 更新 Run，保留 bounded polling fallback、stale 和离线状态
- [x] 5.7 确保插件关闭或 Desktop 不支持时不显示入口、不轮询编排状态
- [x] 5.8 编排内部 Session 不显示普通 Worktree Apply/Discard，并由 Relay 拒绝误调用
- [x] 5.9 排除已完成 change，停止从排序或 spec 重叠推测依赖，并展示 Desktop 并发容量和真实阻塞原因

## 6. 验证与文档

- [x] 6.1 增加 plugin、migration、状态机、lease、retry 和 reconciliation 单元测试
- [x] 6.2 增加 Change/Integration Worktree Git 集成测试，覆盖冲突、幂等与 current checkout 不变
- [x] 6.3 增加移动端非 e2e 测试，锁定默认信息预算、三种模式和异常优先行为
- [x] 6.4 更新架构文档，说明 Relay desired state、Desktop local fact 和 Session/Attempt 边界
- [x] 6.5 运行 `pnpm run check:js`、`pnpm test` 和 `openspec validate add-open-spec-orchestration-plugin --strict`
- [x] 6.6 不运行 e2e，除非用户明确要求
