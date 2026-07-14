## ADDED Requirements

### Requirement: Desktop 必须按 Workspace 广告 Worktree 客观能力
Desktop SHALL 为每个 Workspace 广告 Worktree availability、setup profile 摘要、cache policy、warm pool 状态和 Apply/Discard 支持。

#### Scenario: Workspace 不支持 Worktree
- **WHEN** Desktop 无法为某 Workspace 提供受管 Worktree
- **THEN** capability 将该 Workspace 标记为 unavailable
- **AND** 手机不把 Worktree 显示为可执行选项

#### Scenario: Workspace 配置了 Setup Profile
- **WHEN** Desktop owner 为 Workspace 配置固定 setup profile
- **THEN** snapshot 只广告 profile id、label 和状态摘要
- **AND** 不广告本机命令正文、cache 路径或 secret environment

### Requirement: Worktree 实体路径必须由 Desktop 持有
Relay SHALL 只保存 opaque Worktree identity 和可展示 metadata，真实本机路径由 Desktop 管理。

#### Scenario: Relay 返回 Session Detail
- **WHEN** 手机读取 Worktree Session
- **THEN** Session detail 包含 lifecycle、branch/ref 和 opaque id
- **AND** 不包含 Worktree 或 Workspace 绝对路径
