# mobile-orchestration-workbench Specification

## Purpose
TBD - created by archiving change add-open-spec-orchestration-plugin. Update Purpose after archive.
## Requirements
### Requirement: 编排插件只增强现有 OpenSpec 工作台
移动端 SHALL 在编排插件启用且能力可用时，在现有 OpenSpec 工作台中提供编排浏览、选择和运行模式，并 MUST NOT 增加常驻顶层仪表盘。

#### Scenario: 插件已启用
- **WHEN** 当前 Desktop、Workspace 和 OpenSpec 满足编排前置条件
- **THEN** OpenSpec 工作台显示一个编排入口
- **AND** 用户无需离开该工作台即可选择 change 和确认路线

#### Scenario: 插件未启用或不受支持
- **WHEN** 当前 Desktop 未广告或未启用编排插件
- **THEN** 移动端不显示编排入口
- **AND** 不请求或轮询编排状态
- **AND** 普通 OpenSpec 与 Session 行为保持不变

### Requirement: 默认 change 列表必须遵守最小信息预算
移动端 SHALL 让默认列表中的每个 change 只呈现名称、单一状态信号和稳定尺寸的轻量进度，并 SHALL 将详细内容下沉到按需详情。

#### Scenario: 用户浏览 change list
- **WHEN** OpenSpec 工作台处于浏览模式
- **THEN** 每行默认显示 change 名称、一个状态词或图标以及轻量进度
- **AND** 默认行不同时显示 proposal 摘要、affected spec 标签、task checklist、Agent transcript、token、Git 文件列表或测试日志

#### Scenario: 用户需要 change 详情
- **WHEN** 用户打开某个 change
- **THEN** 工作台按需显示 proposal、tasks、spec 和单项操作
- **AND** 关闭详情后恢复简洁列表位置和上下文

### Requirement: 创建编排只要求一次简洁确认
移动端 SHALL 通过选择和确认两个短步骤创建 Run，并 SHALL 只在必要时显示依赖、冲突或高级运行设置。

#### Scenario: 用户选择 change
- **WHEN** 用户进入选择模式
- **THEN** 列表只显示未归档且任务尚未全部完成的 change，并增加选择控件和已选数量
- **AND** 已完成 change 不可进入当前 Run
- **AND** 视图只有一个“下一步”主操作

#### Scenario: Echo 提出的路线没有异常
- **WHEN** 所选 change 没有显式依赖并可使用 Workspace 持久运行偏好
- **THEN** 确认视图显示可立即启动数量、Desktop 并发上限和结果目标
- **AND** 展示顺序只决定最终集成顺序，不会生成执行依赖
- **AND** 视图只有一个“开始”主操作

#### Scenario: 存在必要依赖或运行能力不满足
- **WHEN** Echo 检测到必须串行的依赖或 Desktop 无法满足当前偏好
- **THEN** 确认视图显示一句可行动原因和必要选择
- **AND** 不展示 claim、lease、attempt、slot 或 integration lane 等内部术语

### Requirement: 运行视图优先支持扫描和异常处理
移动端 SHALL 用简洁的 Item 状态和统一待处理分组展示活跃 Run，并 SHALL 将完整执行细节留在现有 Session 工作台。

#### Scenario: Run 正常执行
- **WHEN** 用户查看一个活跃 Run
- **THEN** 顶部显示完成数量与暂停/更多操作
- **AND** Item 按执行中、等待依赖、待启动和已完成分组
- **AND** 等待依赖的 Item 显示尚未完成的前置 change 名称

#### Scenario: Run 需要用户处理
- **WHEN** 出现审批、交互、真实 blocker、Git 冲突或聚合校验失败
- **THEN** 对应 Item 进入统一待处理分组
- **AND** 行内最多显示一句可行动原因
- **AND** 用户可以下钻关联 Session 或执行适用的恢复动作

### Requirement: 编排控制保持上下文并避免布局抖动
移动端 SHALL 为固定格式的状态、进度和操作控件提供稳定尺寸，并 SHALL 在下钻 Session 后恢复原 Run 上下文。

#### Scenario: Item 状态实时变化
- **WHEN** Item 从执行中进入验收中或已提交
- **THEN** 状态变化不会改变相邻行的整体布局或遮挡文本

#### Scenario: 用户查看关联 Session
- **WHEN** 用户从 Item 打开现有 Session 工作台并返回
- **THEN** OpenSpec 工作台恢复同一个 Run、滚动位置和选择上下文
- **AND** 该内部 Session 不显示普通 Worktree 的应用或丢弃操作

### Requirement: 编排状态以 SSE 为主并提供有限轮询回退
移动端 SHALL 使用实时事件更新活跃 Run，在 SSE 不可用时使用 bounded polling fallback，并 SHALL 明确区分缓存状态和实时状态。

#### Scenario: SSE 正常连接
- **WHEN** Run 产生 Item、审批或集成事件
- **THEN** 移动工作台增量更新对应状态
- **AND** 不需要用户手动刷新

#### Scenario: Desktop 或网络暂时离线
- **WHEN** 移动端只有缓存 Run 快照
- **THEN** 工作台可保留快照并标记为 stale
- **AND** 不把旧状态伪装成正在实时推进
