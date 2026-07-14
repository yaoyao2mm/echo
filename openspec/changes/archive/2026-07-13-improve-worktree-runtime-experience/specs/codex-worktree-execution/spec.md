## ADDED Requirements

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
