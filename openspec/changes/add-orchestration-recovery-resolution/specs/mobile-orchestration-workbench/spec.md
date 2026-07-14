# mobile-orchestration-workbench Delta

## MODIFIED Requirements

### Requirement: 运行视图优先支持扫描和异常处理

移动端 SHALL 根据 Relay 输出的可用动作展示异常恢复，不得自行维护 failure class 到按钮的映射。

#### Scenario: Item 需要 Agent 收敛
- **WHEN** Item 处于待处理且 `availableActions` 包含 recover
- **THEN** 行内主恢复动作显示“让 Echo 处理”
- **AND** 不同时显示无效的普通重试

#### Scenario: Run 无法继续
- **WHEN** Run 处于待处理且没有可恢复 Item
- **THEN** 用户可以查看失败证据或结束本批次
- **AND** 界面不要求用户删除历史 check 才能离开活跃状态

### Requirement: 编排控制保持上下文并避免布局抖动

移动端 SHALL 让选择、确认和 Run 详情形成明确的返回层级，并 SHALL 只在根层关闭整个 OpenSpec 工作台。

#### Scenario: 用户从确认页返回
- **WHEN** 用户在编排确认页点击顶部返回
- **THEN** 工作台回到选择页并保留已选 change

#### Scenario: 用户关闭 Run 详情
- **WHEN** 用户点击 Run 详情返回箭头
- **THEN** 工作台回到 OpenSpec 浏览页
- **WHEN** 用户点击 Run 详情关闭按钮
- **THEN** 整个 OpenSpec 工作台关闭
