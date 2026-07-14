# Echo 移动端控制模型

本文档定义 Echo 的产品控制模型。若其他设计、风险记录或历史 OpenSpec 与本文冲突，以本文为准。

## 产品立场

Echo 是移动端优先的本地 agent 控制面，不是桌面端 agent UI 的遥控附件。

- 手机/PWA 是用户日常工作的主界面，负责选择 Workspace、backend、model、权限、worktree 和其他执行偏好。
- Desktop agent 是无头执行端，负责建立配对、公布客观能力、访问本机 Workspace、启动 backend、执行任务和维持连接稳定。
- Relay 负责身份、设备连接、队列、会话状态和移动端偏好的持久化。
- 用户在外面使用 Echo 时，不应因为需要回到桌面点击授权而让任务停住。

桌面端可以提供配对二维码、连接状态、重启、诊断、日志和更新等稳定性操作，但不应成为日常 runtime 权限的人工闸门。

## Capability 与 Preference

必须区分客观能力和用户偏好：

- **Capability**：Desktop 当前客观上能提供什么，例如 Workspace、backend、model、附件、worktree 和 context compaction 支持。
- **Preference**：用户希望任务怎样执行，例如选择哪个 backend/model、使用 `strict`、`approve` 或 `full`、是否使用 worktree。

Desktop 只公布 Capability。移动端决定 Preference。Relay 只接受已知的结构化选项，并验证所选 backend/model/功能客观存在；它不能用桌面端的日常权限偏好覆盖移动端选择。

环境变量中的默认权限和历史 `allowedPermissionModes` 字段属于兼容配置，不是桌面端对移动端的授权上限。新代码和文档不应继续把它们描述成 desktop-owned policy。

## Workspace 级持久权限

权限模式是用户在某个 Desktop + Workspace 下的持久设置：

```text
user + desktop agent + workspace -> permission preference
```

- 用户选择 `full` 后，该 Workspace 后续的新 Conversation 和 follow-up 默认继续使用 `full`。
- 从 Codex 切换到 Claude Code，或切换回 Codex，不要求重新授权；Echo 将同一个偏好映射到 backend 的等价执行模式。
- 权限一直生效，直到用户在移动端主动改成其他模式。
- 权限不是仅本次 turn 或仅当前 Conversation 的临时 grant。
- `full` 是个人可信设备上的正常主路径，不应藏在高级设置里，也不应附加桌面确认。

推荐映射：

| Echo 权限 | Codex | Claude Code |
| --- | --- | --- |
| `strict` | `read-only` + `on-request` | `plan` |
| `approve` | `workspace-write` + `on-request` | `acceptEdits` |
| `full` | `danger-full-access` + `never` | `bypassPermissions` |

某个 backend 如果客观上无法表达所选权限，Echo 必须在手机上明确报错，不能静默换 backend、静默降级权限或要求用户回到桌面处理。

## 审批语义

Echo 可以承载 backend 发出的 approval/interaction 事件，但审批不是 `full` 模式的默认工作流。

- `full` 表示用户已经对该 Workspace 做出持续授权，agent 应能无人值守地完成任务。
- `strict` 或 `approve` 可以继续展示 backend 确实要求的审批。
- Echo 不额外创造一层桌面审批。
- 移动端应清楚显示当前 Workspace 的有效权限，并允许用户随时修改。

## 永久安全边界

移动端拥有 runtime 控制权，不等于 Echo 变成远程 shell。以下边界不由权限模式解除：

- 手机不能提交任意本机绝对路径，只能使用 Desktop 公布或经其路径校验注册的 Workspace。
- 手机不能调用任意 shell endpoint；命令只能由所选 agent backend 在任务执行中产生。
- Codex app-server 始终只在 Desktop 本地通过 stdio 使用。
- backend、model 和功能必须来自 Desktop 的实时 Capability。
- 用户和设备只能访问其身份范围内的 Desktop、Workspace 和 Conversation。

## 当前迁移缺口

当前实现仍有几处历史模型需要迁移：

- 移动端 runtime 偏好主要保存在浏览器本地，还没有作为 `user + agent + workspace` 设置由 Relay 持久化。
- `allowedPermissionModes` 仍会影响部分移动端 UI 和 capability snapshot；它应逐步退化为兼容字段或改名为客观的 `supportedPermissionModes`。
- 桌面设置已移除默认权限、backend/model 和“手机端可用权限”等日常控制，只保留首次连接、配对、状态、重启、诊断和更新。
- 配对、登录和逐设备撤销的关系需要形成一个一致的设备授权模型。

这些是实现缺口，不改变上面的产品不变量。
