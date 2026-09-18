# Lumina Life 技术档案 — 基于源码深度阅读的验证报告

> 版本: v0.1.0-preview | 分析日期: 2026-09-18
> 方法: 逐文件阅读核心源码，所有结论标注证据路径

---

## 1. 项目定位与产品形态

**结论: 这是一个"有情绪的桌面 AI 桌宠 + 多 Agent 团队"产品，而非传统的 AI 聊天客户端。**

代码证据：
- **桌宠为核心形态**: `electron/pet/petWindow.ts` (70.6KB) 实现了透明置顶副窗口、鼠标穿透模式、Live2D 渲染、崩溃自动恢复。桌宠窗口通过独立 BrowserWindow 运行，与主窗口 IPC 通信。
- **三 Agent 团队**: `electron/delegationManager.ts` (43KB) 实现了独立 AgentRunner 映射，每个团队成员（Lumina/热茶/Yak）拥有独立的 LLM 配置、独立上下文、独立记忆。
- **"用户只看到 Lumina"原则**: `agentTeamManager.ts` 中 `getAgentState()` 方法对所有模式返回统一的 lumina 配置，热茶和 Yak 在后台隐身工作，通过 DelegationManager 路由消息。
- **不是纯聊天机器人**: 主动引擎 (`proactiveEngine.ts`, 61KB) 实现了 8 种触发类型（定时/空闲/事件/机会/屏幕感知/热搜/作息/Daily Paper），桌宠会自发搭话。

**与 README 宣传的吻合度**: README 描述的"三个 AI 住在电脑里"在代码中确有实现，但三 Agent 并非完全平等——热茶和 Yak 是 Lumina 的下属 Worker，用户通过 delegate_to / delegate_chain 工具间接调用。

---

## 2. 技术栈与架构

### 2.1 技术栈

| 层 | 技术 | 证据 |
|---|---|---|
| 桌面框架 | Electron 40 | `package.json` devDependencies: `"electron": "^40.10.1"` |
| 前端框架 | React 19 + TypeScript | `package.json`: `"react": "^19.0.0"`, `"jsx": "react-jsx"` |
| 状态管理 | Zustand 5 (persist) | `package.json`: `"zustand": "^5.0.8"`, `src/stores/appStore.ts` (37KB) |
| 构建工具 | electron-vite 3 + electron-builder 26 | `package.json`, `electron.vite.config.ts` |
| 数据库 | better-sqlite3 12 (WAL mode) | `electron/memory/memoryStore.ts`: `this.db.pragma('journal_mode = WAL')` |
| 测试 | Vitest 4 | `package.json`: `"vitest": "^4.1.6"`, `vitest.config.ts` |
| 样式 | UnoCSS | `uno.config.ts`, `@unocss/preset-uno` |
| 国际化 | i18next 26 | `package.json`: `"i18next": "^26.3.3"` |
| 自动更新 | electron-updater | `package.json`: `"electron-updater": "^6.8.3"` |
| Python 侧车 | FastAPI-style HTTP server | `python/lumina_node/server.py` (13KB), `electron/pythonManager.ts` |

### 2.2 进程架构

```
┌─────────────────────────────────────────────┐
│ Electron Main Process (electron/)           │
│  ├── AgentRunner (ReAct 循环, 153KB)       │
│  ├── DelegationManager (团队委派, 43KB)     │
│  ├── ProactiveEngine (主动引擎, 61KB)       │
│  ├── MemoryStore (SQLite, 41KB)            │
│  ├── SecurityGuard (安全审查, 22KB)         │
│  ├── Tool Registry (工具注册, 26KB)         │
│  ├── ProviderManager (LLM 配置, 33KB)      │
│  └── PetWindow (桌宠窗口, 70KB)            │
│                                            │
│ ┌──────────────────┐  ┌──────────────────┐ │
│ │ Main BrowserWindow │  │ Pet BrowserWindow │ │
│ │ (src/ React 19)   │  │ (Live2D 透明窗)   │ │
│ │ 23+ 面板          │  │ pet-live2d.html   │ │
│ └──────────────────┘  └──────────────────┘ │
└─────────────────────────────────────────────┘
           ↕ HTTP/WebSocket (port 18925/18926)
┌─────────────────────────────────────────────┐
│ Python Sidecar (python/lumina_node/)        │
│  ├── STT (Whisper)                         │
│  ├── TTS (Edge-TTS / IndexTTS)             │
│  └── Embedding (sentence-transformers)     │
└─────────────────────────────────────────────┘
```

### 2.3 模块划分统计

- **electron/**: 298 个 .ts 文件，约 74,467 行代码
- **src/**: 106 个 .ts/.tsx 文件（渲染进程）
- **tests/**: 45 个测试文件 + electron/__tests__/ 6 个 = 51 个测试文件
- **python/**: 1 个 sidecar server + 3 个独立服务（edge_tts_server, embedding_server, indextts_server）

---

## 3. 各核心系统实现状态评级

### 3.1 Agent 团队系统 — ✅ 已实现且成熟

| 子系统 | 状态 | 证据 |
|---|---|---|
| ReAct 循环 | ✅ | `electron/agentRunner.ts` (153KB, ~3000+行) — 完整 ReAct 循环，含工具调用解析（支持 OpenAI function calling + XML 格式 + 括号格式三种）、并行工具执行、错误重试 |
| 团队委派 | ✅ | `electron/delegationManager.ts` (43KB) — 每个 Agent 独立 Runner，支持直派(simple)/分阶段门控(complex)两种模式，60s 结果缓存 |
| 阶段门控 | ✅ | `electron/orchestration/phaseGate.ts` (17.9KB) — Research→Plan→Execute→Verify→Review 五阶段 |
| 自动验证闭环 | ✅ | `electron/orchestration/verifyLoop.ts` (11KB) — Yak 写完代码后自动跑测试/修复 |
| 团队社交 | ✅ | `electron/agentSocialEngine.ts` (30.5KB) — 自发话题库（早间签到/晚间回顾/午后茶歇/代码审查等），双轨道(Chat/Coding)分离 |
| 模式管理 | ✅ | `electron/agentTeamManager.ts` (8.5KB) — v5.0 迁移为单 Agent 模式管理（chat/developer/analyst 等），保留社交引擎兼容层 |
| 委托链流水线 | ✅ | `delegate_chain` 工具 — 写代码→自动审查→自动修复 |

**关键发现**: v5.0 后，多 Agent 从"多个独立 Agent 实例"演变为"单 Agent + 模式切换"，热茶/Yak 仍作为 Worker 通过 DelegationManager 存在，但用户可见的统一人格是 Lumina。关系数据（亲密度/信任度）在 `getAllRelationships()` 中是**硬编码常量**，非动态演化。

### 3.2 情感系统 — ✅ 已实现且设计精巧

| 子系统 | 状态 | 证据 |
|---|---|---|
| 统一情绪核心 | ✅ | `electron/pet/life/emotionCore.ts` (6.2KB) — 将三套情绪表示（团队五维/前端三维/桌宠9标签）统一为 valence/arousal + 五维 + affinity，含换算函数 |
| 连续情绪融合 | ✅ | `electron/pet/emotionFusion.ts` (6.8KB) — EMA 惯性(α=0.35) + 单步变化率限制(0.18) + 迟滞反查(0.06) + 基线漂移，纯函数可单测 |
| 前端情绪状态机 | ✅ | `src/services/agentEmotion.ts` (29.5KB) — 三维(mood/energy/affinity) + 正则触发规则库（每个 Agent 10-15 条规则）+ 情绪惯性/冷却/动量 |
| 情绪↔行为桥接 | ✅ | `electron/gamification/emotionBridge.ts` (2.7KB) — 情绪更新驱动游戏化系统 |
| 情绪可视化 | ✅ | `src/components/AgentEmotionBar.tsx` (23.5KB) |

**设计亮点**: `emotionCore.ts` 明确注释了"项目里原本有三套互不相通的情绪表示"，并将其收敛为统一换算层——这是一个有真实技术深度的架构决策。`emotionFusion.ts` 的 EMA + 迟滞设计确保了情绪不会"上一句超开心、被怼后下一句瞬间难过"。

### 3.3 记忆系统 — ✅ 已实现，分层丰富

| 子系统 | 状态 | 证据 |
|---|---|---|
| SQLite 持久化 | ✅ | `electron/memory/memoryStore.ts` (41.6KB) — WAL mode，5 张表（memory_fragments/conversation_history/facts/reflections/persona_traits） |
| 三层记忆模型 | ✅ | Facts(事实) / Reflection(反思) / Persona(人格五维度+标签+演化日志) |
| 混合检索 | ✅ | `electron/hybridMemoryRetrieval.ts` (7.5KB) — BM25 自研实现（中文按字符+短语分词），向量检索 fallback |
| 证据评分 | ✅ | `electron/memoryEvidence.ts` (13.9KB) — 五维评分(confidence 0.30 / recency 0.15 / frequency 0.15 / corroboration 0.10 / importance 0.30)，7天半衰期衰减 |
| 对话压缩 | ✅ | `electron/memory/summarizer.ts` (15.9KB) — 结构化压缩保留 Goal/Progress/Decisions/Context，每10轮触发 |
| Agent 独立记忆 | ✅ | `electron/agentIndependentMemory.ts` (17.4KB) — 每个 Agent 独立记忆空间，含记忆衰减（重要30天/普通7天/琐碎2天半衰期） |
| 记忆精炼 | ✅ | `electron/memoryRefiner.ts` (9.1KB) — 定时清理低质量记忆 |
| ReMe Light | ✅ | `electron/memory/remeLight.ts` (15.7KB) |
| 滚动上下文 | ✅ | `electron/memory/scrollContext.ts` (8.8KB) |

**注意**: README 声称"向量检索"，但实际实现中 `hybridMemoryRetrieval.ts` 的注释说"向量检索 + BM25 fallback"，代码中主要是 BM25 检索，向量部分依赖 Python sidecar 的 embedding_server（可选）。TF-IDF 本地向量化在 memoryStore.ts 注释中提及。

### 3.4 Computer Use — ✅ 已实现且成熟

| 子系统 | 状态 | 证据 |
|---|---|---|
| 截图 | ✅ | `electron/computerUse.ts` — screenshot-desktop 库 + PowerShell 回退 |
| VLM 分析 | ✅ | `electron/tools/impl/cuCore.ts` (25.7KB) — OpenAI 兼容多模态 API，归一化 0-100 坐标 |
| 键鼠原语 | ✅ | cuClick/cuType/cuScroll/cuDrag/cuPressKey — Windows 走 PowerShell，输入走剪贴板（支持中文） |
| 统一执行内核 | ✅ | `cuCore.ts` — agent 工具(desktop_act)与 IPC 引擎共用同一内核 |
| 高危硬拦截 | ✅ | `electron/tools/impl/cuSafety.ts` (1.7KB) — destructiveReason/isDestructive |
| 全局急停 | ✅ | Ctrl+Alt+X 急停信号 (requestCuAbort/isCuAborted) |
| 安全级别 | ✅ | auto/ask/strict 三级，maxSteps 默认10 |
| 屏幕感知(桌宠侧) | ✅ | `electron/pet/vision/screenAwareness.ts` (6.2KB) — dHash 差异哈希 + 场景分类（游戏/视频/代码/文档/社交/发呆），事件驱动而非每帧截图 |

**设计亮点**: `screenAwareness.ts` 的事件驱动设计非常精巧——旧实现每帧截图丢给 VLM（贵且低频），新实现用 dHash 汉明距离量化画面变化，仅在"画面显著变化/场景切换/低频兜底"时才调用 VLM，稳定画面不花钱。

### 3.5 安全沙箱 — ✅ 已实现，分层完整

| 子系统 | 状态 | 证据 |
|---|---|---|
| 分级安全审查 | ✅ | `electron/securityGuard.ts` (22.4KB) — 7级严重度(SAFE→CRITICAL) × 10类威胁(命令注入/路径穿越/数据泄露/敏感文件/凭证泄漏/Prompt注入/代码执行/提权/资源滥用/网络滥用) |
| 文件沙箱 | ✅ | `electron/sandbox.ts` (19KB) — 路径级安全区检查，系统关键路径黑名单，用户授权目录白名单，写操作审批 |
| 审批流 | ✅ | `electron/approvalService.ts` (14.4KB) — 4级执行级别(STRICT/SMART/AUTO/OFF)，心跳保持，Promise 等待机制 |
| 防注入(旧) | ⚠️ | `electron/injectionGuard.ts` (11.9KB) — 已标记 deprecated，功能并入 securityGuard |
| 密钥拦截 | ✅ | securityGuard 规则中含 CREDENTIAL_EXPOSURE 类别 |
| 进程沙箱 | ✅ | `electron/processSandbox.ts` (7.8KB) |
| 访问控制 | ✅ | `electron/accessControl.ts` (11.2KB) |

**注意**: README 声称"7级严重度"，代码中实际只有 6 级枚举（SAFE/INFO/LOW/MEDIUM/HIGH/CRITICAL），BLOCK 级别在 README 提及但未在代码中找到独立枚举。

### 3.6 主动陪伴引擎 — ✅ 已实现，功能丰富

| 子系统 | 状态 | 证据 |
|---|---|---|
| 8种触发类型 | ✅ | `electron/proactiveEngine.ts` (61.1KB) — time/idle/event/opportunity/screen_watch/hot_topic/personal_rhythm/daily_paper |
| 屏幕感知搭话 | ✅ | 截图→VLM分析→评估是否值得搭话→生成自然搭话内容 |
| 热搜感知 | ✅ | B站/微博热搜 → LLM 评估与用户相关性 |
| Daily Paper | ✅ | arXiv 论文 → LLM 筛选摘要 |
| 团队级主动 | ✅ | `electron/teamProactiveSystem.ts` (13.2KB) — 早安仪式/晚安仪式/团队自发聊天/用户空闲时团队自己聊 |
| 通知系统 | ✅ | Windows Notification 弹窗，点击聚焦主窗口 |
| 冷却控制 | ✅ | maxDailyProactive / minIntervalSeconds / 每个触发器独立 cooldown |

### 3.7 桌宠 / Live2D — ✅ 已实现，工程化程度高

| 子系统 | 状态 | 证据 |
|---|---|---|
| Live2D 渲染窗口 | ✅ | `electron/pet/petWindow.ts` (70.6KB) — 透明置顶副窗口，崩溃自动恢复(3次/2s冷却) |
| 表演运行时 | ✅ | `electron/pet/life/runtime.ts` (8KB) — PetPerformanceEngine：情绪姿态合成 + 五元音口型 + 分层动画混合器 + 自动眨眼 + 视线追踪 |
| 面部原语 | ✅ | `electron/pet/life/faceRig.ts` (4KB) — 标准姿态/元音/视线/呼吸 |
| 口型同步 | ✅ | `electron/pet/life/lipsync.ts` (5.3KB) — 文本转五元音段，支持真实音频 RMS 电平驱动 |
| 动画混合器 | ✅ | `electron/pet/life/animationMixer.ts` (5.5KB) — 多层参数混合(情绪/视线/手势)，最大角度/范数限制 |
| 表演 DSL | ✅ | `electron/pet/life/performanceDsl.ts` (6.4KB) |
| 参数 Profile | ✅ | `electron/pet/live2d/parameterProfile.ts` (6.6KB) — 模型发现 + 参数映射 |
| 全双工语音 | ✅ | `electron/pet/lifeSpeech/voiceClient.ts` (18.1KB) — Web Speech STT + Whisper 离线兜底 + edge-tts/indextts TTS + barge-in 打断 |
| 全双工控制器 | ✅ | `electron/pet/lifeSpeech/fullDuplexController.ts` (7.5KB) |
| 屏幕感知 | ✅ | `electron/pet/vision/screenAwareness.ts` (6.2KB) — 事件驱动 dHash |
| 模型导入 | ✅ | `electron/pet/modelImporter.ts` (6.7KB) + `modelLibrary.ts` (3.9KB) |
| 桌宠-记忆桥接 | ✅ | `electron/pet/petMemoryBridge.ts` (5.1KB) |

### 3.8 工具系统 — ✅ 已实现，数量充足

**实际注册工具数量: 约 90 个**（含 7 个内置 Skill 封装 + 4 个反幻觉占位工具）

从 `electron/tools/index.ts` 的 `registerAllTools()` 逐行统计：

| 分类 | 工具数 | 工具名 |
|---|---|---|
| 文件操作 | 7 | file_read, file_write, file_edit, file_list, file_search, disk_list, desktop_scan |
| Shell/终端 | 1 | shell_exec |
| 搜索/抓取 | 3 | web_search, web_fetch, browser |
| 浏览器控制 | 1 | browser_cdp |
| Git | 4 | git_status, git_commit, git_log, git_diff |
| 系统 | 5 | system_info, process_list, notification, open_file, datetime |
| 截图/剪贴板 | 4 | screenshot, clipboard_get, clipboard_set, image_generate |
| OCR/桌面 | 6 | ocr, desktop_click, desktop_type, desktop_key, desktop_screen_size, desktop_mouse_move(弃用) |
| 记忆 | 5+1 | memory_save, memory_get, memory_all, memory_summarize, memory_search, memory_chat_search |
| 任务/定时 | 4 | todo, cron_schedule, cron_list, cron_cancel |
| MCP | 4 | mcp_list_servers, mcp_connect, mcp_list_tools, mcp_call_tool |
| 团队协作 | 9 | delegate_to, delegate_chain, mode_switch, mode_status, team_context, write_notice, read_notices, save_context, load_context |
| 邮件 | 3 | mail_send, mail_list, mail_mark_read |
| 听觉 | 4 | hearing_start, hearing_stop, hearing_status, hearing_transcript |
| 主动对话 | 2 | proactive_status, proactive_trigger |
| Computer Use | 2 | desktop_see, desktop_act |
| LSP | 3 | ast_search, lsp_symbols, lsp_references |
| 创作 | 4 | creator_outline, creator_generate, creator_export, creator_enrich |
| 其他 | 6 | weather, daily_paper, deep_research, channel_send, channel_status, time_capsule |
| Skill 封装 | 7 | browser_click_smart, file_search_smart, web_search_multi, code_review_smart, quick_setup, proactive_check, install_skill |
| 反幻觉占位 | 4 | tavily_search, tavily_extract, serpapi_search, bing_search |
| 语音 | 2 | voice_speak, skill_run, use_skill |
| **合计** | **~90** | |

**三层工具加载策略**: chat(0工具) → agent(~25工具) → developer(~28工具)，按模式分档加载以控制 token 消耗。

### 3.9 多渠道接入 — ⚠️ 有骨架，成熟度不一

| 渠道 | 状态 | 证据 |
|---|---|---|
| QQ | ⚠️ 最成熟(23.7KB) | `electron/channels/adapters/qq.ts` — 最大的适配器文件 |
| Discord | ✅ | `electron/channels/adapters/discord.ts` (10.3KB) |
| 微信(wechat) | ✅ | `electron/channels/adapters/wechat.ts` (9.3KB) |
| 钉钉(dingtalk) | ✅ | `electron/channels/adapters/dingtalk.ts` (9.9KB) |
| Slack | ✅ | `electron/channels/adapters/slack.ts` (6.3KB) |
| Telegram | ✅ | `electron/channels/adapters/telegram.ts` (5.4KB) |
| OpenClaw | ⚠️ 骨架(2.3KB) | `electron/channels/adapters/openclaw.ts` — A2A 桥接，未配置时不启动，send 委托任务给外部 Gateway |
| Channel Manager | ✅ | `electron/channels/channelManager.ts` (9.7KB) — 统一生命周期管理 |

**注意**: `ChannelType` 枚举定义了 8 种类型（dingtalk/wechat/slack/telegram/qq/discord/openclaw/custom），但 README 完全未提及多渠道功能。这些适配器的实际可用性需运行时验证。

### 3.10 LLM 接入 — ✅ 已实现，提供商丰富

从 `electron/core/providerManager.ts` 的 `BUILT_IN_PROVIDERS` 列表：

| # | Provider ID | 名称 | 类型 | 协议 |
|---|---|---|---|---|
| 1 | lmstudio | LM Studio | 本地 | OpenAI 兼容 |
| 2 | ollama | Ollama | 本地 | OpenAI 兼容 |
| 3 | opencode-zen | OpenCode Zen (免费) | 云端 | OpenAI 兼容 |
| 4 | deepseek | DeepSeek | 云端 | OpenAI 兼容 |
| 5 | qwen | 通义千问 | 云端 | OpenAI 兼容 |
| 6 | openai | OpenAI | 云端 | OpenAI 兼容 |
| 7 | claude | Anthropic Claude | 云端 | Anthropic 原生 |
| 8 | gemini | Google Gemini | 云端 | Gemini 原生 |
| 9 | azure | Azure OpenAI | 云端 | Azure |
| 10 | zhipu | 智谱 GLM | 云端 | OpenAI 兼容 |
| 11 | siliconflow | 硅基流动 | 云端 | OpenAI 兼容 |
| 12 | custom | 自定义端点 | 用户自定义 | OpenAI 兼容 |

**安全设计**: API Key 使用 AES-256-CBC 加密存储在磁盘上（`providerManager.ts` line 95-125），密钥从 `lumina-provider-key-v1` 派生。

**模型档案系统**: `providerProfiles.ts` (14KB) 为每个模型建立能力档案——推理类型(reasoning/coding/chat/multimodal)、上下文长度、工具调用可靠性、推荐超时策略。本地模型标记 `isLocal=true` 触发渐进超时（600s→900s→1200s）。

---

## 4. 代码质量与工程化观察

### 4.1 测试覆盖

| 指标 | 数值 |
|---|---|
| 测试文件总数 | 51 个（tests/ 45 + electron/__tests__/ 6） |
| 被测模块覆盖 | 安全审查、记忆存储、情绪引擎、Computer Use、委托、LLM Provider、模型兼容、屏幕感知、社交引擎、团队管理等 |
| 测试类型 | 单元测试为主 + 少量 e2e（compactor.e2e.test.ts, longConversation.test.ts） |
| 主进程总行数 | ~74,467 行 |
| 测试代码总行数 | 约 150KB（粗估） |

**评价**: 测试覆盖在同类型开源项目中属于中上水平。情绪系统、Computer Use、安全审查等核心模块都有对应测试文件。但最大的 agentRunner.ts (153KB) 只有一个 4.1KB 的测试文件，覆盖不足。

### 4.2 技术债与超大文件

| 文件 | 大小 | 问题 |
|---|---|---|
| `electron/agentRunner.ts` | **153.8KB (~3000+行)** | 核心 ReAct 循环，文件头注释说"v2.5: 提示词构建已迁出到 systemPrompt.ts"，但仍极庞大。已部分抽取到 `core/reactEngine.ts` (33.9KB)，但主文件仍承担大量预处理逻辑（搜索意图检测、URL抓取、情绪更新、记忆注入等） |
| `src/panels/GroupChatView.tsx` | **266.6KB** | 渲染进程最大文件，团队群聊视图 |
| `electron/main.ts` | 74.7KB | 主入口，职责过重 |
| `electron/pet/petWindow.ts` | 70.6KB | 桌宠窗口管理，含大量 IPC 处理 |
| `electron/ipc/systemIpc.ts` | 66.7KB | IPC 处理器集中文件 |
| `electron/preload.ts` | 52.8KB | preload 脚本 |
| `electron/proactiveEngine.ts` | 61.1KB | 主动引擎 |

**观察**:
- 文件头注释显示经历了多次重构（v2.4→v3.8→v9.x），存在渐进式重构痕迹
- 多处使用 `require()` 动态调用而非静态 import（如 `require('../skills/skillsLoader')`），为了避免循环依赖
- `injectionGuard.ts` 已标记 deprecated 但仍被 agentRunner 导入
- `desktop_mouse_move` 工具已弃用但仍在注册代码中注释保留
- 存在"旧有子集保留以供向后兼容"的 TOOLSETS 定义（files/web/search/fetch 等旧版与新版并存）

### 4.3 类型安全

- `tsconfig.json` 启用了 `"strict": true`
- `package.json` 有 `"typecheck": "tsc --noEmit --strict"` 脚本
- 但代码中大量使用 `Record<string, any>` 和 `as any` 类型断言，类型安全在运行时层面有所妥协

### 4.4 错误处理

- 防御性编程模式广泛使用：`try { ... } catch { /* ignore */ }` 在多处出现
- 安全检查失败时不阻断工具执行（"防御性编程"注释明确说明）
- 工具执行有超时+重试+指数退避机制
- 网络级致命错误（ECONNREFUSED 等）不重试直接返回

---

## 5. 独特/创新点

1. **统一情绪核心换算层** (`emotionCore.ts`): 将三套互不相通的情绪表示（团队五维/前端三维/桌宠9标签）收敛为 valence/arousal 统一空间，并提供双向换算。这在同类桌面 AI 项目中罕见。

2. **连续情绪融合** (`emotionFusion.ts`): EMA 惯性 + 单步变化率限制 + 迟滞反查，确保情绪有"余韵"而非瞬切。纯函数设计便于测试。

3. **事件驱动屏幕感知** (`screenAwareness.ts`): 用 dHash 差异哈希替代每帧 VLM 调用，仅在画面显著变化/场景切换时才花钱调 VLM。从"贵且低频"优化为"事件驱动且省"。

4. **三层工具加载策略**: chat(0工具) → agent(~25) → developer(~28)，按模式分档加载控制 token 消耗，同时保留完整工具集供高级模式使用。

5. **反幻觉工具注册**: 主动注册 LLM 经常自创的工具名（tavily_search, serpapi_search 等），返回重定向提示而非报错，防止 ReAct 循环中 LLM 无限重试。

6. **搜索意图三层递进检测**: 显式搜索 → 实时信息需求 → 事实型问题，同时有陪伴闲聊拦截（"你是Lumina吗？"不会触发自动搜索）。

7. **OpenClaw A2A 桥接**: 将 OpenClaw 作为外部执行后端接入，连不上时优雅降级不崩溃——这是一个异构 Agent 互联的早期探索。

8. **桌宠表演运行时** (`runtime.ts`): 将 Live2D 参数控制封装为 PetPerformanceEngine——情绪姿态合成 + 五元音口型 + 分层动画混合 + 自动眨眼 + 视线追踪，纯 TS 零依赖可 esbuild 打包。

---

## 6. 明显短板/问题

1. **超大文件技术债**: `agentRunner.ts` 153KB、`GroupChatView.tsx` 266KB、`main.ts` 74.7KB 远超健康文件大小。虽然有渐进式重构（reactEngine 抽取），但主文件仍承担过多职责。

2. **关系数据硬编码**: `agentTeamManager.ts` 的 `getAllRelationships()` 返回的亲密度/信任度/合作次数是**硬编码常量**（lumina-recha affinity=85, collaborationCount=156 等），不是动态演化的。README 声称"亲密度演化"在代码层面是静态的。

3. **向量检索名不副实**: README 声称"向量检索/语义搜索"，但 `hybridMemoryRetrieval.ts` 实际主要是 BM25 关键词检索（中文按字符分词），向量部分依赖可选的 Python sidecar embedding_server。

4. **安全规则基于正则**: SecurityGuard 的威胁检测全部基于正则表达式模式匹配（`GUARD_RULES` 数组），而非语义分析。绕过成本低。

5. **injectionGuard 废弃但仍在用**: 文件头标记 deprecated，但 agentRunner.ts 仍 import 并调用 `getInjectionGuard()`，存在双轨并行。

6. **渠道适配器成熟度不均**: QQ 适配器 23.7KB（最成熟），而 OpenClaw 仅 2.3KB（骨架）。微信/钉钉等适配器是否真正可用需运行时验证。

7. **本地存储混用**: 前端情绪状态用 `localStorage`（`agentEmotion.ts`），主进程用 SQLite（`memoryStore.ts`）和 JSON 文件（`memory/team-notices.json`, `memory/team-context.json`），缺乏统一数据层。

8. **测试覆盖不均**: 核心 ReAct 循环（agentRunner.ts）只有一个 4.1KB 测试文件，而桌宠生命系统（emotionCore/emotionFusion/runtime 等）有完整测试套件。

9. **README 与代码版本不一致**: README 提到 "7级严重度"（含 BLOCK），代码中实际只有 6 级枚举。README 提到 "70+工具"，实际约 90 个注册（但含 4 个反幻觉占位 + 7 个 Skill 封装）。

10. **动态 require 滥用**: 多处使用 `require()` 动态加载模块（如 `require('./core/agentOrchestrator')`），破坏了静态分析和 tree-shaking，也增加了运行时错误风险。

---

## 附录: 关键文件索引

| 系统 | 主文件 | 大小 |
|---|---|---|
| ReAct 循环 | `electron/agentRunner.ts` | 153.8KB |
| ReAct 引擎(抽取) | `electron/core/reactEngine.ts` | 33.9KB |
| 团队委派 | `electron/delegationManager.ts` | 43KB |
| 团队社交 | `electron/agentSocialEngine.ts` | 30.5KB |
| 情绪核心 | `electron/pet/life/emotionCore.ts` | 6.2KB |
| 情绪融合 | `electron/pet/emotionFusion.ts` | 6.8KB |
| 前端情绪 | `src/services/agentEmotion.ts` | 29.5KB |
| SQLite 记忆 | `electron/memory/memoryStore.ts` | 41.6KB |
| 混合检索 | `electron/hybridMemoryRetrieval.ts` | 7.5KB |
| 证据评分 | `electron/memoryEvidence.ts` | 13.9KB |
| Computer Use | `electron/computerUse.ts` + `cuCore.ts` | 18.8+25.7KB |
| 安全审查 | `electron/securityGuard.ts` | 22.4KB |
| 文件沙箱 | `electron/sandbox.ts` | 19KB |
| 审批流 | `electron/approvalService.ts` | 14.4KB |
| 主动引擎 | `electron/proactiveEngine.ts` | 61.1KB |
| 桌宠窗口 | `electron/pet/petWindow.ts` | 70.6KB |
| 表演运行时 | `electron/pet/life/runtime.ts` | 8KB |
| 屏幕感知 | `electron/pet/vision/screenAwareness.ts` | 6.2KB |
| 工具注册 | `electron/tools/registry.ts` + `index.ts` | 26.1+14.2KB |
| LLM Provider | `electron/core/providerManager.ts` | 33.2KB |
| 模型档案 | `electron/providerProfiles.ts` | 14KB |
| Python 侧车 | `python/lumina_node/server.py` | 13.1KB |
| Python 管理器 | `electron/pythonManager.ts` | 10.3KB |
