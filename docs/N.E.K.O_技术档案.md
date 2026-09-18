# N.E.K.O（猫娘计划）深度技术档案

> 调研方式：`git clone --depth 1 --filter=blob:none` 浅克隆源码至临时目录，逐文件深读核心模块，并以 GitHub REST API 交叉核对社区数据。
> 调研时间：2026-09-18　|　调研基准 commit：`a3c82b5`（2026-09-17）　|　版本：**v0.9.0**（`config/application.py:22`）
> 所有结论均附源码路径或 URL 证据，未臆测。

---

## 1. 项目定位与产品形态

**一句话**：N.E.K.O = **N**etworked **E**motional **K**nowledging **O**rganism，一个**端到端集成、本地运行、有时间感知与持久记忆的 AI 数字生命伴侣**，而非通用任务 Agent 或纯 RP 前端。

代码证据支撑其自我定位（`README.MD:57-91`）：

- **是**：端到端集成的伴侣平台（实时语音/文字/视觉 + 持久记忆 + 多形态 Avatar + 主动陪伴 + 工具执行 + 角色卡分享 + 插件商城），核心 Apache-2.0 开源、本地运行。
- **不是**：任务自动化工具（干活只是"共同生活的手段"）、角色扮演皮肤（不靠手动喂世界书）、云端黑盒。
- 仓库 description（GitHub API）：*"A catgirl who lives with you in real time — reaching out first, sharing your media, and actually getting things done, powered by an embodied emotional engine."*

**产品形态**：桌面端（Electron 壳 + `launcher.py` 拉起多进程）+ Web UI（`http://localhost:48911`）+ Steam 免费版（appid **4099310**）+ Docker（Linux 服务器部署，nginx 反代 48911/48912）+ 移动端内测中。GitHub topics：`companion / digital-human / jarvis-assistant / proactive-agent / waifu / own-your-data`。

---

## 2. 技术栈与架构

### 2.1 技术栈（`pyproject.toml`、两份 `package.json` 实证）

| 层 | 技术 | 证据 |
|---|---|---|
| Python 版本 | **严格锁定 `==3.11.*`**，不支持其他版本 | `pyproject.toml:10` `requires-python = "==3.11.*"` |
| Web 后端 | FastAPI ~0.115.9 + uvicorn + websockets + ormsgpack + pyzmq | `pyproject.toml:13-17,59-60` |
| 数据层 | SQLAlchemy ≥2.0、JSON 文件持久化、FTS5 全文索引（sqlite） | `memory/timeindex.py`、`memory/facts.py:17-21` |
| 本地向量 | **ONNX Runtime + tokenizers**（本地 embedding，非云 API） | `pyproject.toml:84-85`、`memory/embeddings.py` |
| 包管理 | **uv**（`uv.lock` 完整锁版本） | `README.MD:547`、`pyproject.toml:164-187` |
| 主前端 | **React 18 + Vite 5 + TypeScript** + react-markdown/KaTeX（聊天窗） | `frontend/react-neko-chat/package.json` |
| 插件前端 | **Vue 3 + Element Plus + Pinia + Vite 7**（插件管理面板） | `frontend/plugin-manager/package.json` |
| 桌面壳 | Electron + PyInstaller/Nuitka 打包；`launcher.py` → `launcher_core/` | `launcher.py`、`scripts/check_dist_arch.py` |
| 屏幕/操控 | mss、dxcam(Win)、pyautogui、pywinauto、browser-use、playwright | `pyproject.toml:23,32-34,74,88-89` |
| 动捕 | python-osc（VMC 协议，OSC over UDP，默认 127.0.0.1:39539） | `pyproject.toml:103`、`main_logic/vmc_sender.py` |
| 测试/质量 | pytest + pytest-xdist + pytest-cov（`fail_under=80`）+ hypothesis + ruff | `pyproject.toml:189-246` |

### 2.2 服务架构：三进程 + 启动器

不是单进程应用，而是由 `launcher.py` 编排的**多进程服务架构**（`README.MD:583-588`、`launcher.py:64-171`）：

```
launcher.py / launcher_core/runtime.py   ← 一键入口：单实例锁、端口分配、进程拉起/关停
├── main_server    (app/main_server/)   FastAPI，对外 Web/WS，挂载 32+ 路由，默认 48911
├── memory_server  (app/memory_server/) 独立 uvicorn 进程，负责记忆抽取/反思/证据回路
└── agent_server   (app/agent_server/)  可选，Agent 工具执行（computer_use/browser_use/mcp/openclaw/user_plugin）
```

- `app/memory_server/__main__.py:68` 实证：`uvicorn.run(runtime.app, host="127.0.0.1", port=MEMORY_SERVER_PORT)`。
- 启动器负责端口冲突回退、root 模式（normal/maintenance-readonly）、storage 布局迁移、cloudsave 运行时准备（`launcher.py:64-171` 导入的符号名可见一斑）。
- 跨进程通信：`main_logic/cross_server.py`、插件侧 `pyzmq` + `ormsgpack` 的 message plane（`plugin/message_plane/`）。

### 2.3 顶层目录速览（`git clone` 实证）

`brain/`（Agent）、`memory/`（记忆）、`main_logic/`（核心对话/语音/活动/话题/TTS/ASR）、`main_routers/`（API）、`plugin/`（插件 SDK+服务端）、`app/`（三服务入口）、`config/`（配置+提示词）、`frontend/`（React+Vue 双子项目）、`static/`（Avatar 模型与静态资源）、`templates/`、`steamworks/`、`tests/`。

**规模量级**（源码统计）：`memory/` 66 个 py 文件、`main_logic/` 193 个、`main_routers/` 112 个、`plugin/` 644 个、`tests/`+`plugin/tests/` 共 **855 个测试文件**。这是一个工业级体量的项目，而非玩具 Demo。

---

## 3. 核心系统实现状态评级

评级标准：✅ 成熟（有完整实现 + 测试 + 真实数据流）/ ⚠️ 部分实现（有代码但依赖外部服务或仍标注"等待优化"）/ ❌ 仅声明。

| 系统 | 评级 | 证据 |
|---|---|---|
| **五维记忆系统** | ✅ **成熟（项目最强项）** | 见 §3.1，全部五维均有独立包/模块与成百上千行实现 |
| **实时语音对话** | ✅ 成熟 | `main_logic/omni_realtime_client/`（11 个文件：transport/audio/tools/responses/gemini_support/protocol_capabilities…），WebSocket Realtime API |
| **视觉理解** | ✅ 成熟 | `vision_model` 字段贯穿 `api_providers.json`；`main_routers/capture_router.py`、`activity/` 截图钩子、`computer_use.py` 截图→VLM |
| **多形态 Avatar** | ✅ 成熟 | `static/` 下 `live2d/ vrm/ mmd/ mao_pro/(猫桌宠) pngtuber-test/` 五目录齐备；对应 5 个 router + VMC 动捕 |
| **Agent 工具执行** | ⚠️ 部分实现 | 自研 CUA/browser_use 完整；但 OpenClaw 通道实为对接**外部 QwenPaw**，非内置自治 Agent（见 §4） |
| **插件生态** | ✅ 成熟 | 644 文件：SDK + FastAPI 插件服务 + ZMQ message plane + `neko-plugin` CLI + 12+ 内置插件 |
| **主动陪伴** | ✅ 成熟 | `activity/` 状态机 + `topic/` 异步话题流水线 + `proactive_chat/` 决策/候选/打断提醒/小游戏邀请 |

### 3.1 五维记忆系统逐一验证

| 维度 | 模块 | 实现真相 |
|---|---|---|
| **工作记忆** | `main_logic/core/manager.py` `LLMSessionManager` | 11 个 Mixin 组装的活会话对象（turn/streaming/tts/asr/proactive/greeting…），带定期上下文压缩与热切换；`main_logic/session_state.py` 状态机。对应"当前对话窗口"。 |
| **近期记忆** | `memory/recent.py`（**1835 行**） | 两阶段 LLM 摘要：Stage-1 压缩原始消息，Stage-2 仅在超限再压缩；末尾 K=3 条消息指纹去重；受 `RECENT_HISTORY_MAX_ITEMS`/token 预算硬约束。 |
| **事实记忆** | `memory/facts.py`（**5745 行**）`FactStore` | 自称"三层记忆层级的 Tier 1"：LLM 抽取原子事实 → SHA-256 去重 + FTS5 语义检索 → JSON 持久化；importance 1–10 钳制；7 天归档、冷却期。 |
| **反思记忆** | `memory/reflection/` 包 | `ReflectionEngine` 由 7 个 Mixin 组成（persistence/synthesis/refinement/evidence_flow/surfacing/promotion/promotion_merge），管理 pending→confirmed→auto_confirmed 生命周期，把事实综合成反思。 |
| **人格记忆** | `memory/persona/` 包 | `PersonaManager` 7 个 Mixin，核心实体 `master / neko / relationship`，按实体分节存 `{entity: {facts:[...]}}`，含 corrections 纠错队列与外部 Markdown 融合。 |

**召回机制**（`memory/recall.py:16-58`，设计非常工程化）：
1. 硬过滤（evidence_score<0、被抑制、终态反思、受保护人格条目）；
2. **向量粗排**——本地 ONNX embedding 算余弦，过采样 3×；
3. **LLM 精排**——小模型在候选集里挑 top-N，evidence_score 作为辅助信号喂给 LLM 而非混入排序公式。
> 设计理由写得很清楚：余弦相似度分不清"主人喜欢猫/讨厌猫"（≈0.78），所以向量只做"省 token 的预筛"，LLM 才是最终裁决。无 embedding 时优雅降级为 `evidence_score DESC`。

记忆由独立的 `memory_server` 进程在每轮对话后异步跑（`app/memory_server/post_turn.py`、`evidence_loops.py`、`refine_loops.py`），**不阻塞主对话**——这正是 `topic/pipeline.py:1-7` 强调的"普通聊天绝不等候话题筛选/在线富化/建 prompt"。

---

## 4. 与 OpenClaw 的关系（关键纠偏）

README 宣称"调用 OpenClaw A2A"，**源码揭示真相**（`brain/openclaw_adapter.py:16-23` 原文）：

> "In this project, 'OpenClaw' is **the compatibility name for the external QwenPaw service**. The adapter keeps the existing OpenClaw-facing interface for N.E.K.O, while supporting both QwenPaw's legacy Responses-compatible API and its v2 console streaming API."

也就是说：
- **"OpenClaw" 是对外的兼容代号，后端实际对接的是独立的 QwenPaw 服务**（一个外部 Agent/自动化引擎，默认 `http://127.0.0.1:8088`，`openclaw_adapter.py:43`）。
- 集成方式是**自定义 HTTP**，不是 Google A2A 协议：
  - `/api/agent/process`、`/api/agent/compatible-mode/v1/responses`（Responses 兼容）、`/api/console/chat`（v2 控制台流式）、`/api/agent/health`（`openclaw_adapter.py:46-51`）。
- 内置**魔法命令** `/clear /new /stop /daemon approve`（`openclaw_adapter.py:53-65`），并用一个 LLM 分类器判断自由文本里是否真含系统控制意图——代码里记录了踩坑：旧的子串匹配会把"雨停下来了""领导批准了我的申请"误判成 `/stop`、`/daemon approve`，还会误撞仓库自己 4257 条 i18n 文案（`openclaw_adapter.py:143-149`）。
- **高风险动作需人工批准**：`/daemon approve`（"daemon 授权"）是一个独立的二次确认闸门，`app/agent_server/channels/openclaw.py` 负责派发、取消、使能探测与原因码。

**结论**：所谓"A2A"在本项目里 = N.E.K.O 作为"身体+关系"层，把 QwenPaw 当作"手脚/任务执行"层的一个通道；它与 computer_use、browser_use、mcp、user_plugin 并列，在 `brain/task_executor.py` 里由 `DirectTaskExecutor` 并行评估可行性后择优路由。**不是一个开放的标准 A2A 协议实现，而是对 QwenPaw 的专有 HTTP 适配。**

> 备注：这与你之前关注的 QwenPaw 代理式协作直接相关——N.E.K.O 把 QwenPaw 当成可插拔的"干活手脚"，自己专注陪伴与记忆。

---

## 5. 实际支持的 AI 服务商（`config/api_providers.json` 实证）

README 称"14+"，实测**远超此数**：

**核心 Realtime（WebSocket 实时语音，8 个）**：
`free`（阶跃星辰赞助，无需 Key）、`qwen`/`qwen_intl`（阿里百炼 Qwen-Omni）、`openai`（gpt-realtime）、`step`（Step-2，免费）、`gemini`（Gemini Live）、`glm`（智谱 Realtime）、`grok`（xAI Voice）。

**辅助 ChatCompletion（20 个）**：
`free`、`qwen`/`qwen_intl`、`openai`、`glm`、`step`、`silicon`（硅基流动）、`gemini`、`kimi`/`kimi_code`、`deepseek`、`doubao`（火山方舟）、`minimax`/`minimax_intl`、`mimo`（小米）、`claude`（Anthropic）、`grok`、`openrouter`、`orcarouter`、`vllm_omni`（本地 vLLM TTS）。

**架构亮点**：每个辅助服务商都按**职责拆分模型**——`conversation / summary / correction / emotion / vision / agent` 六个槽位可分别配不同模型（如 `api_providers.json:77-88`），即"记忆用便宜模型、对话用强模型、情感用小模型"的分层路由，而非单一模型打天下。

**TTS 对偶**（`main_logic/tts_client/workers/`，16 个 worker）：qwen/openai/minimax/gemini/elevenlabs/doubao/gptsovits/cosyvoice/local_cosyvoice/vllm_omni/cogtts/grok/mimo/step/free/dummy。
**ASR**（`main_logic/asr_client/workers/`，8 个 worker）：qwen/openai/gemini/glm/grok/step/soniox/dummy，并自带本地 Silero VAD 端点检测与 CAM++ 声纹（`speaker_shadow/`）。

---

## 6. 工程化观察

**优点（工程素养明显高于同类开源项目）**：
- **测试密度极高**：855 个 `test_*.py`，且 `pyproject.toml` 用 `pytest-xdist` 按文件分发、`pytest-randomly` 打乱顺序抓隐藏的用例间依赖、coverage 硬门槛 `fail_under=80`。注释里明说"Windows CI 单跑 19 分钟逼近 25 分钟 job 上限"——这是真实在跑的 CI。
- **有强制代码规范守门**：ruff 自定义 `ASYNC210/220/221/222/251` 禁止 async 里出现阻塞调用（`time.sleep`/`requests`/`subprocess`），另配 `check_no_loguru.py`、`check_async_blocking.py`、`check_dist_arch.py` 等脚本（`pyproject.toml:57-58,219-241`）。
- **依赖治理用心**：`pyncm-async` 已从 PyPI 下架，改本地 wheel 存档（`deps/`）；Intel Mac 的 onnxruntime 无 wheel 问题用 `required-environments` 分叉锁版本（`pyproject.toml:178-187`）。
- **隐私/遥测透明**：默认开 token 用量遥测，但 `DO_NOT_TRACK=1` 一键关，README 用表格逐项列明收集/不收集，并解释假名化设备 ID 的 SHA-256 算法（`README.MD:711-732`）。
- **多形态代码复用**：CUA 子系统明确 derived from `simular-ai/Agent-S` 并保留 AGPL/Apache 归属（`brain/cua/core/engine.py:1-17`）；computer_use 明确改编自 Kimi/OSWorld 模式（`brain/computer_use.py:16-22`）。

**门槛/成本**：
- **Python 锁死 3.11**（`==3.11.*`），不支持 3.12+；前端需 Node ≥20.19。
- **安装链条长**：`uv sync` → `build_frontend.bat/sh`（要先 `npm install && npm run build` 两个前端子项目）→ 起 memory_server + main_server（+ 可选 agent_server）。一键包/Steam 版为普通用户屏蔽了这些。
- **原生依赖重**：pyautogui/pywinauto(Win)、pyobjc(mac)、pyrnnoise、onnxruntime、av、soxr 等，跨平台 wheel 是持续维护负担。
- **单体 FastAPI**：`app/main_server/web_app.py` 一个文件 import 32+ 个 router（实际比 README 宣称的"26 个路由"还多），虽已按域分包，但主服务仍是庞然大物。
- 若干上游依赖脆弱（pyncm 下架、TwitchIO 不暴露 device flow 只能自带实现——`pyproject.toml:44-46` 注释）。

---

## 7. 社区与成熟度（GitHub API 实时核对）

| 指标 | 数值 | 来源 |
|---|---|---|
| Stars | **2,903** | `api.github.com/repos/...` |
| Forks | 321 | 同上 |
| Open Issues | 72 | 同上 |
| 创建时间 | 2025-06-29 | 同上 |
| 最近 push | 2026-09-15（HEAD commit 2026-09-17） | API + `git log` |
| 当前版本 | **v0.9.0** | `config/application.py:22` |
| 活跃强度 | 极高，PR 编号已到 **#3127** | HEAD commit `(#3127)` |
| 许可证 | Apache-2.0 | API |
| Steam | 免费上架，appid **4099310**，创意工坊已上线 | `steam_appid.txt`、README |
| 语言 | Python 为主 | API |

**路线图状态**（`README.MD:701-709`）：v0.7（Agent）、v0.8（记忆+桌宠+双人小游戏）、v0.9（多系统适配+猫娘网络基础设施）均"第一阶段完成"；**v1.0 原定 9 月底正式版**，但**自研大模型计划已延期到正式版之后**。也就是说项目仍在快速迭代，未到 1.0 稳定期。

---

## 8. 独特 / 创新点

1. **把"记忆"当成一等公民工程来做**：五维记忆 + 本地 ONNX embedding + 向量预筛/LLM 精排 + 独立 memory_server 异步回路 + FTS5 全文 + evidence_score 确认次数加权——这套记忆架构在开源 AI 伴侣里属于最系统、最不"套壳 prompt"的一档。
2. **"陪伴优先、干活为辅"的架构哲学**：主动搭话由 `activity/` 状态机（屏幕/空闲/CPU/语音 RMS）驱动，话题在后台异步富化，绝不阻塞对话主链路——代码注释里反复强调这一点。
3. **多 Avatar × 动捕外连**：Live2D/VRM/MMD/PNGTuber/猫桌宠五形态齐备，且通过 VMC/OSC 协议把骨骼流推给 VSeeFace/waidayo/iFacialMocap/Warudo（`pyproject.toml:99-103`），打通了既有 VTuber 工具链。
4. **插件生态做到了"真平台"**：ZMQ message plane、SDK v2（decorators/hooks/bus）、`neko-plugin` CLI、插件商城桥接、12+ 内置插件（QQ 自动回复经 NapCat、微信集成、网易云、Minecraft 陪玩、MCP 适配器、生活工具 Lifekit…），远超"留个 hook"水平。
5. **多服务商职责拆分**：六个模型槽位可独立配，且有"免费版"（阶跃赞助 `lanlan.tech`）真正零 Key 开箱。
6. **Steam 创意工坊 UGC**：角色/模型/语音包可上传分享，`main_routers/workshop_router/` 13 个文件支撑发布/审核/订阅。

---

## 9. 明显短板 / 风险

1. **"OpenClaw A2A"名不副实**：实为对接外部 QwenPaw 的专有 HTTP，N.E.K.O 自身的通用 Agent 执行依赖外部进程；无 QwenPaw 时该通道不可用。文档与代码措辞易让人误以为是开放 A2A 协议。
2. **Python 3.11 单版本锁定**，生态演进受限；原生依赖跨平台 wheel 维护成本高（代码里为此写了大量平台条件与本地 wheel）。
3. **主服务单体化**：`web_app.py` 聚合 32+ router，虽然按域分包，但边界仍在持续膨胀。
4. **成熟度未到 1.0**：路线图自认 v0.7–v0.9 均"第一阶段完成，等待优化"，自研模型延期，移动端仍内测。
5. **强依赖外部模型 API**：虽然本地有 embedding/ASR/VAD，但"她"的智能本体完全依赖各家云 Realtime/ChatCompletion，断 Key 即空壳（免费版由阶跃赞助，存在供给方风险）。
6. **自动化权限面大**：pyautogui/pywinauto + 截图 + CUA 意味着她能操作你整台电脑，虽有 `/daemon approve` 高风险闸门，但默认开启此类能力的攻击面/误用风险需要用户自行评估。

---

### 附：关键证据文件索引

- 架构/启动：`launcher.py`、`launcher_core/runtime.py`、`app/main_server/web_app.py`、`app/memory_server/__main__.py`
- 记忆：`memory/facts.py`、`memory/recent.py`、`memory/reflection/manager.py`、`memory/persona/manager.py`、`memory/recall.py`、`memory/embeddings.py`
- 对话：`main_logic/core/manager.py`、`main_logic/omni_realtime_client/`、`main_logic/omni_offline_client/`
- Agent：`brain/task_executor.py`、`brain/computer_use.py`、`brain/openclaw_adapter.py`、`brain/cua/core/engine.py`、`app/agent_server/channels/`
- 主动陪伴：`main_logic/activity/`、`main_logic/topic/`、`main_logic/proactive_chat/`
- 语音：`main_logic/tts_client/`、`main_logic/asr_client/`
- 配置：`config/api_providers.json`、`config/application.py`
- 插件：`plugin/sdk/`、`plugin/server/`、`plugin/message_plane/`、`plugin/neko_plugin_cli/`
