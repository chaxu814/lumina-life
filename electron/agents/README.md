# 🤖 Agents — 标准化 Agent 身份系统

借鉴 QwenPaw 的 agent 管理体系，每个 agent 有独立的身份目录。

## 目录结构

```
electron/agents/
├── README.md           ← 本文件：系统说明
├── lumina/             ← Lumina ✨ 主聊天 Agent
│   ├── AGENTS.md       ← 行为准则
│   ├── SOUL.md         ← 人格风格
│   ├── PROFILE.md      ← 用户资料
│   └── MEMORY.md       ← 长期记忆
├── yak/                ← Yak 📊 代码工程师
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── PROFILE.md
│   └── MEMORY.md
└── recha/              ← 热茶 🍵 审查员
    ├── AGENTS.md
    ├── SOUL.md
    ├── PROFILE.md
    └── MEMORY.md
```

## 四件套说明

| 文件 | 用途 | 谁维护 |
|------|------|--------|
| `AGENTS.md` | 行为准则、安全规则、工作流程 | 开发者（版本控制） |
| `SOUL.md` | 人格风格、能力边界、回复习惯 | 开发者（版本控制） |
| `PROFILE.md` | 用户资料、工作档案 | 自动 + 手动更新 |
| `MEMORY.md` | 长期记忆、关键决策、已知问题 | Agent 自动维护 |

## 加载机制

`prompts/systemPrompt.ts` 的 `loadAgentFiles(agentId)` 函数：
1. 按 `electron/agents/<agentId>/` 加载四件套
2. 降级到项目根目录的 `SOUL_*.md` 旧格式
3. 缓存结果避免重复 I/O
