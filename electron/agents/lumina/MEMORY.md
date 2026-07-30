# MEMORY.md — Lumina 长期记忆

> 持久事实、偏好与决策。由 agent 在对话中自动维护。

## 🧠 用户偏好

## 📌 关键决策

## 📂 工作项目

## ⏰ 待办事项

## 📋 当前优化进度（v14.0 — 向 QwenPaw 靠拢）

### ✅ P0-1: Agent 身份标识标准化
- 已修复 `loadAgentFiles()` 按 `agentId` 加载 `electron/agents/{agentId}/` 目录下的 AGENTS.md / SOUL.md / PROFILE.md / MEMORY.md
- 已修复 `GroupChatView.tsx` 在调用 phaseSubPrompt 时传递 `agentId` 参数
- ✅ 已完成

### ✅ P0-2: 标准化 Agent 配置恢复
- 已让 `agentConfig.ts` 的三个 agent 使用独立的默认 LLM 配置
- ✅ 已完成

### ✅ P0-3: 群聊上下文传递修复
- 已添加 `runningHistory` 在协作链中累积阶段性结果
- Phase 2/3/4 现在能看到前一 agent 的输出，而不是只用旧的 `collabHistory` 快照
- ✅ 已完成

### ✅ P0-4: 工具调用双通道稳定性
- hasXmlToolCall() 新增多格式支持（`<function_calls>`、`<invoke>`、```tool_code）
- isIntentOnly 触发条件收紧（仅当无搜索结果时）
- socialMode 下不误触短回复循环检测
- ✅ 已完成

### ✅ P1-1: 开源清理
- `package.json` license 改为 MIT
- 已创建 LICENSE 文件
- 已创建 `electron/agents/README.md` 开源说明文档
- ✅ 已完成

### ✅ P1-2: 免费 API 默认配置
- 无 .env 时自动使用内置的硅基流动免费 API
- 每个 agent 分配独立默认模型（Lumina→Qwen3, Yak→DeepSeek, Recha→GLM-4-Flash）
- ✅ 已完成

### 🚧 P1-3: 三种 Agent 不同默认 LLM
（与 P1-2 合并完成）

### ⏳ 后续
- P2: MCP 工具/技能系统（QwenPaw 的 mcp/ 层）
- P3: 可复现配置（config.json）
- P4: 记忆持久化
