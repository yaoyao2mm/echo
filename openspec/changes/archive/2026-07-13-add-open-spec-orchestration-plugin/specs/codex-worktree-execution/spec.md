# codex-worktree-execution Specification

## ADDED Requirements

### Requirement: 编排 Worktree 必须由 Desktop 按 Run 与 Item 身份管理
系统 SHALL 只在 Desktop 受管根目录中为 Orchestration Run 创建 Change Worktree 和 Integration Worktree，并 SHALL 固定 Workspace、Desktop owner、base branch、base commit、Run id 和 Item id 元数据。

#### Scenario: Desktop 创建 Change Worktree
- **WHEN** 调度器派发一个可写 Change Item
- **THEN** Desktop 从 Run 固定 base commit 创建独立受管 Worktree
- **AND** Backend 只在该 Worktree 路径中执行
- **AND** 手机不能指定实际路径或 branch 名称

#### Scenario: 命令身份与 Worktree metadata 不一致
- **WHEN** 重试或恢复命令的 Run、Item、Workspace 或 Desktop owner 与本地 metadata 不匹配
- **THEN** Desktop 拒绝执行
- **AND** 不触碰该 Worktree 或当前 checkout

### Requirement: 编排集成不得绕过普通 Worktree Apply 安全语义
系统 SHALL 使用专用 Integration Worktree 整合多个 Item commit，并 MUST NOT 放宽普通 Session Worktree Apply 对 base commit、当前分支和干净 Workspace 的要求。

#### Scenario: 多个 Item 共享创建基线
- **WHEN** 第一个 Item 已在 Integration Worktree 中整合，使集成分支前进
- **THEN** 后续 Item commit 在同一 Integration Worktree 中按顺序重放
- **AND** 系统不将其文件直接复制到当前 checkout

#### Scenario: 用户单独 Apply 普通 Session Worktree
- **WHEN** 一个非编排 Session 请求 Apply
- **THEN** 系统继续执行既有 baseCommit 和 dirty Workspace 预检
- **AND** 编排 capability 不会为该请求启用自动 rebase、merge 或 force apply

#### Scenario: 聚合结果自动落地
- **WHEN** Integration Worktree 已通过聚合校验
- **AND** base Workspace 仍位于固定分支和固定 commit 且没有未提交修改
- **THEN** Desktop 使用 `--ff-only` 将集成 commit 合入 base Workspace
- **AND** 分支、commit 或 dirty 预检失败时不修改 base Workspace

### Requirement: 编排 Worktree 清理必须显式且可恢复
系统 SHALL 在 Run 完成、失败或取消后保留受管 Worktree，直到满足配置的安全保留策略或用户明确请求清理，并 SHALL 使重复清理幂等。

#### Scenario: Run 被取消
- **WHEN** 用户取消一个已有本地成果的 Run
- **THEN** Desktop 保留 Change/Integration Worktree、commit 和 metadata 供检查
- **AND** 取消动作不等于 discard

#### Scenario: 清理受管 Run
- **WHEN** 用户请求清理且没有活跃 Attempt
- **THEN** Desktop 只删除匹配 owner metadata 且位于受管根目录内的 Worktree
- **AND** 重复请求返回既有终态而不删除其它路径
