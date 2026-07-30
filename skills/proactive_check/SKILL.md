# proactive_check

主动对话触发检测 Skill — 心跳检测 + 时机评估 + 内容生成。

## 触发词
（自动触发，不需要用户调用）

## 工作流
1. 检测用户空闲时间 / 屏幕变化 / 时间节点
2. 评估触发时机（LLM 判断是否合适开口）
3. 生成自然的主动对话内容
4. 发送到主聊天面板

## 触发类型
- time: 早安/晚安/午餐提醒
- idle: 用户 5 分钟不活动
- event: 文件变更/系统通知
- opportunity: LLM 评估认为适合互动

## 适用 Agent
Lumina（主）

## 依赖工具
proactive_status, proactive_trigger
