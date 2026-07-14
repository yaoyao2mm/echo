# codex-worktree-execution Specification

## Purpose

定义 Echo 为 Codex Session 提供的可选受管 Worktree 隔离、结果应用和终态处理语义。
## Requirements
### Requirement: 明确请求的 Worktree 隔离不得静默降级
系统 SHALL 在用户选择隔离 Worktree 后，要么在 Desktop 受管目录中执行，要么以结构化不可用状态停止本次启动。

#### Scenario: Workspace 不是 Git 仓库
- **WHEN** 用户以 Worktree 模式启动 Session
- **AND** Desktop 判断 Workspace 不是 Git 仓库
- **THEN** 本次命令不会在主 Workspace 中执行
- **AND** Session 显示 `worktree.unavailable` 及 `not-git` 原因

#### Scenario: Workspace 没有初始提交
- **WHEN** 用户以 Worktree 模式启动 Session
- **AND** Workspace 没有可用 `HEAD`
- **THEN** 本次命令不会静默改成非 Worktree 模式
- **AND** 用户必须显式选择其他执行方式

### Requirement: Apply 必须验证创建基线
系统 SHALL 只在主 Workspace 当前 `HEAD` 与 Worktree 记录的 `baseCommit` 一致且工作区干净时应用结果。

#### Scenario: 主分支产生了新提交
- **WHEN** Worktree 创建后主 Workspace 的 `HEAD` 已变化
- **AND** 用户请求 Apply
- **THEN** 系统返回 `apply-blocked`
- **AND** 不修改主 Workspace 文件
- **AND** 返回 bounded 的基线变化摘要

#### Scenario: 基线未变化
- **WHEN** 当前 `HEAD` 等于记录的 `baseCommit`
- **AND** 主 Workspace 干净且 ownership 校验通过
- **THEN** 系统应用 Worktree 结果
- **AND** 记录结构化 `worktree.applied` 结果

### Requirement: Worktree 终态动作必须幂等且可恢复
系统 SHALL 防止 Apply、Discard 和网络重试造成重复写入或互相冲突的终态。

#### Scenario: 重复发送 Apply
- **WHEN** 同一 Worktree 已经成功 Apply
- **AND** Relay 因网络重试再次发送 Apply
- **THEN** Desktop 返回原有成功结果
- **AND** 不再次复制文件

#### Scenario: Cleanup 失败
- **WHEN** Desktop 无法安全删除受管 Worktree
- **THEN** Session 保留 `cleanup-failed` 状态和 bounded 错误
- **AND** 系统不删除受管根目录以外的文件

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

### Requirement: Session Worktree 必须可复用并具备准备状态
系统 SHALL 为一个隔离 Session 分配至多一个受管 Worktree，并在 follow-up 中复用它，同时在需要时完成 Desktop 定义的 setup。

#### Scenario: Session 发送 Follow-up
- **WHEN** 隔离 Session 已有有效 Worktree
- **AND** 用户发送 follow-up
- **THEN** Desktop 复用同一个 Worktree
- **AND** 不创建第二个分叉 Worktree

#### Scenario: Setup Key 发生变化
- **WHEN** lockfile、toolchain marker 或配置的输入改变
- **THEN** Worktree 返回 needs-setup 状态
- **AND** 在依赖该 setup 的 agent turn 前重新准备

### Requirement: Worktree Setup 只能使用 Desktop 定义的 Profile
系统 SHALL 只运行 Desktop 本地配置并已广告的 setup profile，不接受手机提供的命令或路径。

#### Scenario: 手机请求准备 Worktree
- **WHEN** 手机请求已广告的 setup profile id
- **THEN** Desktop 在受管 Worktree 中运行该固定 profile
- **AND** Relay 只获得 bounded setup 状态和输出摘要

### Requirement: Worktree 可以使用受控共享缓存和 Warm Pool
系统在启用共享缓存或 warm pool 时 SHALL 只使用 Desktop 配置的受控资源，并保持默认 pool size 为零。

#### Scenario: 分配 Ready Warm Worktree
- **WHEN** Workspace 有 setup key 匹配的 ready warm Worktree
- **AND** 用户启动隔离 Session
- **THEN** Desktop 将它转为该 Session 独占的 Worktree
- **AND** 它不再属于 idle pool
