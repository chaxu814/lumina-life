
<p align="center">
  <img src="https://img.shields.io/badge/版本-0.1.0--preview-ec4899?style=for-the-badge&labelColor=1a1a2e" alt="Version 0.1.0 preview">
  <img src="https://img.shields.io/badge/Agent%20Team-3%20personas-ff6b9d?style=for-the-badge&labelColor=1a1a2e" alt="3-Agent Team">
  <img src="https://img.shields.io/badge/Emotion-3%20continuous%20values%20%C2%B7%205%20expressions-ff4757?style=for-the-badge&labelColor=1a1a2e" alt="Emotion System">
  <img src="https://img.shields.io/badge/Tools-139%20registered%20%2F%20~32--50%20per%20turn-3b82f6?style=for-the-badge&labelColor=1a1a2e" alt="139 tools registered, ~32-50 exposed per turn">
  <img src="https://img.shields.io/badge/Computer%20Use-%E2%9C%85-00d2d3?style=for-the-badge&labelColor=1a1a2e" alt="Computer Use">
  <img src="https://img.shields.io/badge/license-AGPL_3.0_%7C_Apache_2.0-eccc68?style=for-the-badge&labelColor=1a1a2e" alt="License (AGPL-3.0 OR Apache-2.0)">
</p>

<p align="center">
  <a href="#-quality-gates"><img src="https://img.shields.io/badge/tests-4040%20passing%20%2F%20281%20files-4c1?style=flat-square&labelColor=1a1a2e" alt="4040 tests passing across 281 test files"></a>
  <a href="#-quality-gates"><img src="https://img.shields.io/badge/tsc--strict-0%20errors-4c1?style=flat-square&labelColor=1a1a2e" alt="tsc --strict: 0 errors"></a>
  <a href="#-quality-gates"><img src="https://img.shields.io/badge/eslint-0%20errors-4c1?style=flat-square&labelColor=1a1a2e" alt="eslint: 0 errors"></a>
  <a href="#-quality-gates"><img src="https://img.shields.io/badge/CI-3%20OS%20%C3%97%202%20Node-4c1?style=flat-square&labelColor=1a1a2e" alt="CI matrix: 3 OS x 2 Node versions"></a>
  <img src="https://img.shields.io/badge/code-236k%20lines-4c1?style=flat-square&labelColor=1a1a2e" alt="236k lines of code">
</p>

<h1 align="center">
  🌸 Lumina Life
</h1>

<p align="center">
  <b>你的桌面不再孤单。</b><br>
  <i>Your desktop just got a soul.</i>
</p>

<p align="center">
  <b>三个 AI 住在你的电脑里——有情绪、会说话、真的帮你做事。</b><br>
  <i>Three AI agents live on your desktop — they feel, they talk, and they actually do things for you.</i>
</p>

<br>

<p align="center">
  <a href="#-quick-start"><b>🚀 快速开始</b></a> ·
  <a href="#-features"><b>✨ 核心亮点</b></a> ·
  <a href="#-why-lumina"><b>💡 为什么选 Lumina</b></a> ·
  <a href="#-architecture"><b>🏗️ 架构</b></a> ·
  <a href="#-screenshots"><b>📸 截图</b></a> ·
  <a href="#-roadmap"><b>🗺️ 路线图</b></a>
</p>

---

## ⚠️ 已知问题（发布前如实告知）

我们不把已知问题藏进 Issue 列表。首次公开发布前，以下是**我们已知、且尚未解决**的问题：

| 严重度 | 问题 | 影响 | 计划 |
|---|---|---|---|
| 🟠 | **仅 Windows 实机验证** | macOS/Linux 代码已适配但**从未真机验收**；Computer Use 的键鼠注入、沙箱规则库强依赖 Windows API | v1.3.0 |
| 🟠 | **IM 渠道未经端到端真机验证** | 7 个适配器已接线，**仅 Telegram 默认开启**，其余需自配凭据 | v1.0 |
| 🟡 | **测试套件对负载敏感（flaky）** | 已修复一批「源码重构后测试未同步」的确定性失败（5 条，见下方 Quality Gates）；剩余个别时序测试在**慢机/并发下**仍可能间歇失败——套件不再声称「永远全绿」 | 持续收敛 |
| 🟡 | **无应用内本地推理** | 需外挂 LM Studio / Ollama；启动会探测但**不会自动安装** | 不计划（见「为什么」） |
| 🟡 | **无第三方技能生态** | 技能市场通道已通；`electron/skills/` 有 **13 个示例技能**、根 `skills/` 有 **7 个智能技能**，但**没有第三方技能可装** | 待社区 |
| 🟡 | **`agentRunner.ts` 单文件 4135 行** | LLM 调用 / ReAct 循环耦合在一起，外部贡献者可读性差（tool-selection 已抽离为独立模块） | 发布后重构 |
| 🔵 | **5351 条 `no-explicit-any` warning** | 不阻塞发布；由 lint 棘轮（`lint:ratchet`）管理，只减不增 | 持续 |
| 🔵 | **Chromium sandbox 为 `false`** | 渲染进程安全由**应用层**承担（rolePolicy + securityGuard + sandboxRules + 审批流），**不是**浏览器沙箱；文档已按此更正 | 已澄清 |

> 💡 **在 Windows + LM Studio 上遇到「很卡 / 首 token 很慢」？先跑 `lumina health`（或界面「更多设置 → 诊断工具 → 🩺 模型体检」）。**
> 它多半会直接告诉你原因：上下文窗口填得比模型实际能吃的大了。这是我们已经解决、但需要你看见的诊断能力。

---

## 🎬 她跟别的 AI 不一样

<blockquote>
  <i>"Most AI tools wait for you to ask.<br>
  <b>Lumina notices when you need help.</b>"</i>
</blockquote>

&nbsp;&nbsp;🧠 **她的身体由大模型实时「驱动」，而不是播放预设动画：**<br>
&nbsp;&nbsp;&nbsp;&nbsp;每一次思考都会同时产出动作、表情和台词（结构化 `{action, mood, speech}`），上一句还在笑、被你怼了会先顿一下再小声回话——情绪有连续余韵。<br>
&nbsp;&nbsp;&nbsp;&nbsp;<sub>Each thought emits action + mood + speech together: the body is driven by the model in real time, not a scripted loop.</sub>

&nbsp;&nbsp;❄️ **她会在你对着屏幕发呆时，主动说：**<br>
&nbsp;&nbsp;&nbsp;&nbsp;*"累了吗？要不要休息一下？"*<br>
&nbsp;&nbsp;&nbsp;&nbsp;<sub>She notices when you're zoning out and checks on you.</sub>

&nbsp;&nbsp;👥 **她不是一个人——她身后还有两个队友：**<br>
&nbsp;&nbsp;&nbsp;&nbsp;Yak 码代码、热茶做审查，你只跟 Lumina 聊天就好。<br>
&nbsp;&nbsp;&nbsp;&nbsp;<sub>Yak codes, Recha reviews code — you only talk to Lumina.</sub>

&nbsp;&nbsp;🖥️ **她不只"告诉你"，她真的会帮你操作电脑：**<br>
&nbsp;&nbsp;&nbsp;&nbsp;截图→理解屏幕→自己移动鼠标。你说"帮我保存这个文件"她就照做。<br>
&nbsp;&nbsp;&nbsp;&nbsp;<sub>Screenshots → understands → moves your mouse. She actually does it.</sub>

&nbsp;&nbsp;💬 **她在你看不见的地方有「朋友圈」：**<br>
&nbsp;&nbsp;&nbsp;&nbsp;Lumina、热茶、Yak 会在后台群聊、互道早安、发朋友圈。<br>
&nbsp;&nbsp;&nbsp;&nbsp;<sub>Lumina, Recha, and Yak have group chats, morning greetings, and Moments — you just don't see it all.</sub>

---

## ✨ Core Features · 核心亮点

### 🧠 Multi-Agent Team · 三 Agent 团队协作

不是"一个 AI 做所有事"，而是三个各有所长的 Agent 组成团队，各司其职、流水线作业。

| Agent | 角色 Role | 性格 Personality | 专长 Expertise |
|-------|-----------|-----------------|---------------|
| **Lumina** 🐱 | 团队老大 — 唯一对用户接口<br>Team leader, your only interface | 温暖可爱、偶尔迷糊<br>Warm, caring, sometimes adorably clumsy | 对话 · 情绪感知 · 日常陪伴<br>Chat, emotion sensing, companionship |
| **热茶 (Recha)** 🍵 | 毒舌技术宅 — 后台工作者<br>Sarcastic reviewer, behind-the-scenes | 外冷内热、毒舌但可靠<br>Cold on the outside, sharp but reliable | 代码审查 · 挑错 · 风险评估<br>Code review, critique, risk assessment |
| **Yak** 💻 | 代码工程师 — 后台工作者<br>Calm engineer, behind-the-scenes | 理性至上、工程狂<br>Logic-first, engineering-obsessed | 写代码 · 调试 · 重构 · 跑测试<br>Coding, debugging, refactoring, testing |

**如何协作？** How they work together:

```
你 "帮我查一下这个bug怎么修"
  │
  ▼
routingDecider 判定复杂度（规则高置信直接用 / 歧义调一次 LLM 仲裁 / 仲裁失败静默退回规则）
  │
  ├─ 简单 → delegate_to ──> Yak 💻 写修复方案 ──> 回来
  │
  └─ 复杂 → phase_gate_delegate
             Research → Plan → Execute → Verify → Review
                              │
                              └─> adversarial_review（多视角并发委托热茶）
                                        │
             Lumina 收到结果 → 整理→回复你
```

> 他们会在后台互相吐槽、讨论方案，但你看到的始终是一个统一、连贯的 Lumina。<br>
> <sub>They chat, debate, and banter behind the scenes — you always see one unified Lumina.</sub>

✅ `delegate_chain` 流水线：写代码 → 自动审查 → 自动修复<br>
✅ `phase_gate_delegate` 五阶段门控：复杂任务自动降级为简单派活（避免过度编排）<br>
✅ `hire_worker` 动态雇工：按需雇佣临时工种，并行执行后自动解散<br>
✅ `adversarial_review` 对抗评审：多视角**并发**（`Promise.all`）委托，漏检有完整性 critic 兜底<br>
✅ 每个 Agent 可独立配置 LLM（未配置则降级到 Lumina 的模型）<br>
✅ 每个 Agent 有工具硬边界（`rolePolicy.ts`，三层闸门：硬闸门 → 执行层校验 → 广告层过滤）

> ⚠️ **说清楚调度是「谁」在做**：**没有一个确定性的 dispatcher 会在你发一句话时
> 自动把活派给 Yak**。派不派、派给谁，是模型读完 system prompt 后的判断
> （routingDecider 只注入一句提示）。好处是灵活、不会误路由；代价是**不可预测** ——
> 同一个问题两次问，可能一次派给 Yak、一次 Lumina 自己答。

---

### 😊 Real Emotion System · 真实情感系统

不是表情包，不是冷冰冰的状态栏——**她真的有情绪。**

| 维度 | 说明 |
|------|------|
| **三维数值 → 五种表现** | 底层是 **3 个连续数值**：心情 mood / 精力 energy / 亲密度 affinity，带惯性与随机漂移；当前版本用"昼/夜"两档开关微调（`pet/life/drives.ts:75 isNight`），尚未做连续正弦调制；它们组合映射为 5 种主要可观察表现（底层 9 个情绪标签经迟滞最近邻选定）：🥰开心 · 😴疲劳 · 🎯专注 · 😰焦虑 · 🤔好奇<br>3 continuous values (mood/energy/affinity) with inertia and drift, plus a day/night two-state modifier (no continuous sine yet); they map to 5 primary expressions selected by hysteresis nearest-neighbor from 9 underlying mood labels |
| **实时可视化** | Lumina 的表情和语气随情绪实时变化<br>Her expression and tone shift in real time |
| **关系记忆** | Agent 之间的亲密度/信任/协作数随**真实委托与群聊事件**演化，并持久化到本地（重启后保留）<br>Inter-agent affinity/trust evolve from real delegation & group-chat events and persist locally |
| **主动搭话** | 不是冷通知——"主人你对着屏幕发呆好久了，要休息一下吗？"<br>Not a cold notification — "You've been staring at the screen for a while. Take a break?" |
| **桌宠双渲染** 🖼️ | 主线 Live2D；VRM 为 beta——情绪数值已接入 VRM（→ blendShape），但口型 / 视线跟随暂仍在 Live2D，VRM 情绪动作默认关（`pet.vrmExpressive`） |

> 💡 **情绪不只影响表情，它进了执行层**：重试次数会被当前情绪影响
> （`delegationManager.ts`），工具可用范围会被情绪**收紧**（`orchestration/emotionGating.ts`，
> 且只能收紧永不放宽）。多数项目的"情绪系统"只是换头像和语气词。

> ⚠️ **不夸大**：我们没有做过情绪建模的对照组实验，也没有用户留存数据。
> 「真实情感」指的是机制上真的有数值、有惯性、会衰减——**不是**指她有意识。

---

### 📚 Real Memory · 真正的记忆

不是"聊完就忘"的上下文窗口——**她真的记得你。**

| 能力 | 说明 |
|------|------|
| **短期记忆** | 当前对话上下文，支持自动压缩（按模型窗口分档，65%/60%/50% 触发率）|
| **长期记忆** | SQLite 持久化 + 结构化事实/反思/人格 |
| **混合召回** | **BM25 词法 + TF-IDF 向量余弦双路召回，RRF 融合（已实现、零依赖）。中文用 unigram+bigram 字符级分词（无词典，精度有限）**；dense 语义向量（Ollama / embedding 服务）可在记忆设置中开启，**默认关闭**<br>Hybrid recall: BM25 lexical + TF-IDF cosine fused by RRF (shipped, zero-dependency); dense semantic embeddings optional, **off by default** |
| **双层可信度** | ① 写入期：权威性**只由 `source` 决定**，模型无权自封 `confidence: 1.0`<br>② 读取期：五维证据评分（置信/新鲜/频率/佐证/重要，7 天半衰期）决定召回排序与生命周期，被证伪的记忆会沉底 |
| **自动精炼** | 定时清理低质量记忆，保留真正重要的 |
| **记忆剧场** | 可视化浏览你和 Lumina 的回忆 |

> <sub>Memory is the soul of companionship. Lumina remembers. That's what makes her different.</sub>

> ⚠️ **说实话**：证据链（尤其是佐证维度）不是什么独门秘技——「检索 + 证据打分 + 融合排序」
> 是记忆系统里已经比较成熟的工程思路，我们把它落在了自己的记忆工具与记忆剧场里。
> **记忆是入场券，不是护城河。** 我们真正在意的差异，写在 [为什么选 Lumina](#-why-lumina--为什么选-lumina) 里。

---

### 🖥️ Computer Use · 真正的桌面操控

不只是"告诉你该怎么做"——**她真的会操作你的电脑。**

```
你: "帮我把这个文件拖到桌面上"
                │
                ▼
  ① 截图当前屏幕
  ② VLM 分析画面内容
  ③ 定位文件 + 桌面位置
  ④ 移动鼠标 → 拖拽 → 完成 ✅
```

💡 **屏幕感知**：你在写代码？热茶会自发提出优化建议<br>
💡 **看得见你的操作**：不只是聊天窗口，是整个屏幕

🎮 **游戏陪伴（可选扩展）**：她能看画面、操作键鼠陪你玩——视觉路线（截图→理解→操作键鼠）开箱即用，基于 GameProfile 框架可接入新游戏（已适配 **Minecraft**、**Factorio** 等）；**Minecraft 的 Mineflayer 程序化控制作为可选扩展，需额外安装，首发安装包不含**。支持自主游玩闭环 `game_auto`，但**请勿用于带反作弊的竞技网游**（封号风险）。详见 [docs/gaming-overview.md](docs/gaming-overview.md) 与 [docs/game-safety.md](docs/game-safety.md)。

---

### 🛡️ Smart Sandbox · 智能沙箱

不用害怕 AI 会乱动你的电脑 — **Lumina 的沙箱模式让她做任何敏感操作前都会先问你。**

| 等级 | 说明 |
|------|------|
| **双层安全审查** | ① 消息/参数级：securityGuard 6 级×10 类，审查 LLM 输入和工具参数；② 命令级：sandboxRules 32 条命令规则（按 BLOCK/CRITICAL/WARN 4 档分级），审查即将执行的 shell 命令（含 BLOCK 级硬拦截：格式化/rm -rf 根/fork 炸弹/删系统目录） |
| **🔍 沙箱玻璃房** | 侧栏「沙箱玻璃房」面板实时显示每条命令命中的级别 / 威胁类别 / 处置（放行 · 降级 · 拦截 · 审批），安全过程对你透明 |
| **审批流** | 危险操作先弹窗问你，你点头她才做 |
| **密钥拦截** | Token/Key 自动检测，阻止外泄 |
| **🆕 沙箱模式** | 一键开启 → 中高风险操作全部需确认；关闭 → 仅拦截严重风险 |

> <sub>She's powerful, but she always asks first.</sub>

---

### 💬 Team Social Life · 团队社交生活

Agent 之间不是机械的任务分配——**他们有真实的"社交"。**

| 功能 | 说明 |
|------|------|
| **群聊** 💬 | Lumina、热茶、Yak 在后台自发聊天（你可以旁观） |
| **早安仪式** 🌅 | 每天早上团队互道早安，同步日程 |
| **Moments 朋友圈** 📱 | Agent 记录自己的状态和想法，像真人朋友圈 |
| **关系演化** ❤️ | 委托成功 / 失败、群聊参与、建设性分歧会改变彼此的亲密度、信任与协作数并持久化（数值驱动，非剧情化"吵架和好"） |
| **亲密度影响审查语气** 🔊 | 热茶的代码审查语气随她与 Lumina 的亲密度变：亲密度高 → 先肯定再提建议；低 → 硬邦邦直接指出问题 |

---

### 🎭 4 种人格模式 · 4 Personality Modes

| 模式 | 风格 | 适合场景 |
|------|------|---------|
| **Lumina（默认）** 🐱 | 活泼可靠 Lively & reliable | 日常使用，全能型 |
| **工作助手** 💼 | 干练高效 Professional & efficient | 写代码、分析数据、项目管理 |
| **闲聊伙伴** ☕ | 温暖随和 Warm & casual | 放松聊天、情感陪伴 |
| **创意助手** 🎨 | 发散思维 Creative & divergent | 头脑风暴、写作、设计 |

切换人格时，Lumina 的语气、回复深度、工具使用倾向都会改变——她真的"变身"了。

---

### 🎭 桌宠反映真实 Agent 状态 · 不只是状态灯

<sub>很多桌宠的动画只是「状态灯」——表情由模型文本决定，与真实任务是否在跑、跑到哪一步无关。Lumina 的桌宠状态来自真实看板：谁在干活、跑到哪个阶段、是被卡住还是等审批，她都如实演出来。**干活的人自己被看见。**</sub>

| 真实状态 | 桌宠表现 |
|---|---|
| 💻 Yak 正在写代码 | 敲键盘循环 + 专注光晕 + 「Yak 正在写代码…」 |
| 🍵 热茶正在审查 | 审视表情 + 怀疑色 + 「热茶正在审查…」 |
| ⏳ 等待你处理 | 踱步 + 「等你处理…」 |
| ❌ 验证失败重试中 | 捂脸/黯淡 + 警示色（4 秒后自动隐去） |
| ✅ 刚完成 | 挥手庆祝 + 「搞定啦！」 |
| 😴 没人干活 | **不动**——交还给情绪系统自由表现 |

零 LLM 调用（纯状态机映射，不花 token 不加延迟）· 1.2s 防抖防抖动 · 空闲不接管 · 可用 `LUMINA_PET_AGENT_STATE=0` 关闭。

---

### 🎨 8×9 精灵表 UGC · 让「做一只自己的桌宠」变简单

Live2D / VRM 需要会 Blender、会绑 3D 模型 —— 这把绝大多数想画桌宠的人挡在门外。**精灵表不需要。**

| 行走 | 动画组 | 帧数 |
|------|--------|------|
| 1 | 待机 idle | 6 |
| 2 | 向右跑（**左跑由本行水平镜像自动补出**） | 8 |
| 3 | 挥手 wave | 4 |
| 4 | 跳跃 jump | 5 |
| 5 | 失败 fail | 8 |
| 6 | 等待 wait | 6 |
| 7 | 工作 work ← 绑定真实 Agent 状态 | 8 |
| 8 | 视线向上 look-up | 8 |
| 9 | 视线向下 look-down | 8 |

**三条创建路径**：① 单张静态图（1 分钟，自动生成呼吸浮动） ② 把内置的规格提示词发给会画画的 AI（~10 分钟） ③ 已有图集直接导入

全程本地处理，不上传、不消耗任何模型额度。导入有校验器（尺寸/像素/体积/可执行文件拦截）。

---

### 🔧 139 Built-in Tools · 按需筛选（另可经 MCP / 技能市场扩展）

<sub>**三个口径都给你，不合并**：注册表实际注册并通过校验 **139** 个。
按模式分档：`developer` 档候选 **139** 个（全开）、`agent`（日常）档候选 **135** 个、
`chat` 档静态 TOOLSETS 表为 0，但实际经 `CHAT_MODE_TOOLS` 注入 **11** 个（文件只读 / 记忆 / 搜索 / 委托）。

但**每一轮真正发给模型的只有一小撮** —— `electron/tools/toolRouter.ts` 会按
你这一句在说什么，从候选集里挑出相关的子集：**常驻核心 `CORE_TOOLS` 约 32 个**
（文件 / 终端 / 搜索 / 记忆 / 时间 / 待办 / 技能 / 团队基础），其余按能力组的关键词按需附加
（电脑操控 / 浏览器 / 日程 / 定时 / 桌面整理 / 系统 / 记忆深化 / 团队进阶 /
MCP / 语音 / 天气 / 邮件 / 社交 / 创作 / 资讯 / 游戏 / 番茄钟 / 深研 / 版本控制 …）。
`developer` 档再叠加约 15 个写代码专用常驻（git 系列 / LSP / 浏览器细操作）。
经验区间：chat 档 11 个；agent 档无按需命中时约 32 个，命中 1–2 个能力组后通常 **30–50 个**。
裁剪后若少于 8 个会自动退回全量（失败开放，宁可多花 token 也不让模型没工具用）。

**为什么这么做**：修复前每轮把整档工具**全量**塞进 function list ——
agent 档近万 tokens、developer 档 1.2 万 tokens，**每一次模型调用都重发一遍**
（包括「现在几点」）。实测 601 次真实工具调用里，只有 22 个工具被用过，
前 7 个占 95%。现在每轮只发相关子集，且工具能力一个没少。

启动日志会打印实际注册数与各档可达数，并对「任何 toolset 都够不到的工具」告警
（当前 **0** 个）。
</sub>

<details>
<summary>为什么报两个数字？</summary>

因为「工具数量」曾经是个误导性数字。v3.34 之前，`registry.ts:resolveToolset()`
只读静态 `TOOLSETS` 常量表，**完全不读 `ToolDef.toolsets`**（尽管后者是必填字段、
58 个文件都在声明）。结果是当时 132 个已注册工具里有 **47 个**对模型彻底不可达 ——
包括 `hire_worker` / `adversarial_review` / `desktop_act` / `creator_*` / `lsp_*`，
而 `agentTeamPersonas.ts` 还在花 20 行教模型去调其中 5 个。

修复分两层：**模式层**（chat/agent/developer）保持静态表独占，因为「这一档给用户
多少能力」是产品决策；**能力层**（team/lsp/browser/computer_use/creator/…）改为
声明式自动解析，新加工具只要写对 `toolsets` 就能被看见，不会再静默沉底。
</details>

`搜索` · `浏览器` · `文件操作` · `代码审查` · `终端` · `截图` · `桌面控制` · `定时任务` · `天气` · `邮件` · `日历` · `OCR` · `语音输入` · `TTS` · `通知` · `记忆管理` · `番茄钟` · `游戏` · `MCP` · `LSP/AST` · `技能系统` · ……

<sub>⚠️ **勘误（2026-10-07）**：此列表此前包含「翻译」，但注册表里**没有翻译工具** ——
翻译是模型原生能力，不需要工具（给它一个翻译工具纯属多余）。
另外「LSP/AST」只在 `developer` 档可用，`agent` 档拿不到。</sub>

技能可经内置商店安装 / 卸载 —— 但 **生态目前是空的**，没有第三方技能。<br>
<sub>Skills installable via the built-in store — but the ecosystem is currently empty (no third-party skills yet).</sub>

---

## 💡 Why Lumina? · 为什么选 Lumina

Lumina 想填的是一个具体的空位：**有形象的 AI 伴侣大多没有干活的 Agent 能力，有 Agent 能力的工具大多没有人格。**

把这句话拆开看，就是市面上两类常见产品的形态：

- **有形象的 AI 伴侣 / 桌宠**：能聊天、能卖萌、能换表情，但你让它「把这个文件整理好、把这个 bug 修掉、盯着这个任务跑完」，它做不到——表情与真实的执行过程是脱节的，她只是在「演」一个在干活的角色。
- **有 Agent 能力的工具 / 编码工作台**：能调用工具、能执行命令、能跑子任务，但没有形象、没有情绪、没有「她在你桌面上陪着你」的感觉，任务之外对你这个人一无所知。

Lumina 要做的，是把这两件事合在同一个常驻桌面进程里：**她的表情与动作来自真实的任务执行状态，她的情绪能真实收紧她手里的权限，而她干活的全过程对你透明可见。**

> 💡 **还有一个更硬的论据，藏在「桌宠」这个形态里。**
>
> 一个要「在你电脑上按计划执行、远程可控」的 Agent，天然强依赖桌面端 App 常驻；
> 而桌宠本来就是必须常驻的。想让 Agent「长在用户电脑上陪着你」需要单独做一套常驻架构，
> Lumina 从第一天就有。当主动性、情绪系统与 IM 渠道接在一起时，
> 你得到的是一个**天然常驻 · 有情绪 · 有团队 · 能干活**的代理，
> 而不是一个「需要保活、没有人格的代理」。
>
> **这不是功能优势，是架构优势。**

Lumina 现在能做到的事（完整清单见 [能力速查](#-能力速查)）：

| 能力 | 状态 |
|------|------|
| 多 Agent 团队编排 | ✅ 3 人团队 + 五阶段门控 + 对抗评审 + 动态雇工 |
| 拟人情感 | ✅ 3 个连续数值 + 亲密度 + 昼/夜两档 |
| 桌宠绑定真实执行状态 | ✅ 复杂编排与简单委托均接入（见 [能力速查](#-能力速查)） |
| 桌宠形象形态 | ✅ Live2D / VRM / 精灵表 / MMD / 猫咪 |
| 多端支持 | ⚠️ Windows 实机验证；macOS/Linux 仅 CI 覆盖、未实机验收 |
| IM 渠道 | ⚠️ 多个适配器已接线，仅 Telegram 默认开启，其余需自配凭据、未经真机验证 |
| 本地推理 | ❌ 无应用内推理，需外挂 LM Studio（详见 [FAQ](docs/FAQ.md)） |
| Computer Use | ✅ 键鼠 / OCR / UIA，情绪可收紧权限 |
| 桌面安全 | ✅ 双层审查 + 命令规则 + 三层角色闸门 |
| 团队社交 | ✅ 群聊 + 朋友圈 + 早安问候 |
| 记忆系统 | ✅ BM25 + RRF + 证据评分（记忆工具与记忆剧场内生效） |

**诚实说在前面：我们还不够好的地方。**

- **多端与分发**：目前只有 Windows 被真实使用过，macOS/Linux 没有实机验收；没有上架任何应用商店。
- **本地推理**：无应用内推理，离线使用必须自行安装 LM Studio 并配置模型。
- **IM 渠道**：适配器已接线，但除 Telegram 外都没有真机验证。
- **人格厚度**：每个角色的身份文件还比较精简，人格样例仍在补充（见 [ROADMAP](docs/ROADMAP.md)）。
- **技能生态**：技能商店引擎已就绪，但目前没有第三方技能，目录是空的。
- **社区体量**：这是一个尚未发布的个人项目，没有用户、没有 star 基线——这一点没有任何包装。

Lumina 的赌注是：**先做实「有身体的团队 Agent」这件事，再补多端与生态。**

> <sub>There are AI tools. There are AI companions. **There's nothing quite like Lumina.**</sub>

---

## 🔬 Quality Gates · 工程底座

我们不靠 star 数说话，靠能跑的东西说话。**下面每一项都是我们本机实测跑出来的，
不是 CI 徽章上的转述。**（数据采样：2026-10-14）

| 闸门 | 命令 | 实测结果 |
|---|---|---|
| 测试套件 | `npm test` | **281 个测试文件 · 4040 个用例通过 / 1 skipped · 0 失败**（本机实测；⚠️ 套件对负载敏感，见下方说明） |
| 类型检查 | `npm run typecheck` | **`tsc --noEmit --strict` · 0 error**（稳定复现） |
| 代码规范 | `npm run lint` | **0 error / 5351 warning**（warning 由 `lint:ratchet` 棘轮管理，只减不增） |
| CI 矩阵 | `.github/workflows/test.yml` | **3 平台 × 2 Node 版本** = 6 组合 |
| 打包 | `.github/workflows/release.yml` | Windows / macOS / Linux 三平台；**无签名证书时降级出包而不失败** |

> ⚠️ **关于"全绿"的诚实说明**：本次采样前，套件里有 5 条**确定性失败**——
> 都是「源码重构后测试没同步」造成的陈旧断言（独立聊天窗剥离、provider 密钥
> 加解密集中化、群聊就绪变量改名），**已全部修正**，现为 281 文件 / 4040 通过 / 0 失败。
> 仍需诚实说明：少数时序类测试（`testTimeout` 30s）在**慢机或并发跑其它重型任务时**
> 可能间歇失败。我们把它列为已知问题并持续收敛，**不声称"永远全绿"**。

**代码规模**（不含依赖与构建产物，2026-10-11 实测）：

| 模块 | 行数 | 占比 |
|---|---:|---:|
| `electron/` 主进程 | 141,985 | 60% |
| `src/` 渲染进程 | 53,747 | 23% |
| `tests/` | 40,128 | **17%** |
| 其余（python / scripts / agents / skills） | ~2,900 | 1% |
| **合计** | **~236,000** | 100% |

> 📌 **测试代码占全仓约 17%**。同赛道的头部项目靠社区规模或基金会输血，
> Lumina 在发布时什么都没有，只能靠自己写的测试。
> 这是我们最想让你看的一个数字——它比上面任何功能列表都更能说明工程质量。

**为什么我们把这块写进 README 而不是藏在 CONTRIBUTING 里**：
一个 0 star 的开源项目，专业用户判断能不能信的唯一客观依据就是**质量闸门**，
因为他们搜不到任何 issue、discussion 或第三方评测。如果你正在考虑用 Lumina
跑真任务，这张表应该比功能列表更能帮你做决定。

**我们也如实说明短板**：`tsc --strict` 是绿的，但 `eslint` 仍有 5351 条
`no-explicit-any` warning（集中在测试与 LLM 消息边界）。它不阻塞发布——
因为有棘轮机制管着只会减少；但我们不假装它是零。

### 📊 我们的诚实能力边界

不夸大，能做什么就写什么：

| 状态 | 能力 |
|------|------|
| ✅ **能稳定做好** | 写/改/调试/重构代码（自动跑 tsc + 测试，不通过自己修）· 代码审查与风险评估（多视角对抗评审）· 跨会话记忆（BM25+RRF 混合召回 + 证据链重排）· 长对话不失忆（压缩器 + Scroll 双保险）· 桌面点击/输入/快捷键/截图 OCR · 文件与搜索 · git · 网页抓取 · 定时任务 · 团队社交旁观 · 主动关心（话头未完、久坐提醒）· 分级沙箱与审批流 |
| ⚠️ **尽力但不保证** | 开放式模糊任务（「优化一下这个项目」）· 多轮复杂重构 · 需要品味的任务（UI 设计、文案润色）· 跨文件依赖图展开（`phase_gate_delegate` 刚接线，**未经真实任务验证**）· 游戏陪伴（需额外安装插件） |
| ❌ **做不到** | macOS / Linux 桌面操控（代码已适配但**从未在真机验证**）· 应用内本地模型推理（需外挂 LM Studio）· 云同步 / 多设备 / 移动端 |

**为什么「问到什么就能解决什么」做不到，但「问具体的事基本都能干」是成立的**：

| 问法 | 结果 |
|---|---|
| 「把这个函数的异步 bug 修了」 | ✅ 能，会派 Yak、会跑测试 |
| 「写个爬虫」 | ✅ 能 |
| 「审一下这段代码」 | ✅ 能，热茶只读审查 |
| 「优化一下这个项目」（模糊） | ⚠️ 尽力，可能过度编排 |
| 「顺便在浏览器里点两下」 | ✅ 能（developer 模式）|
| 「发封邮件」 | ✅ 能（v3.34 起 `mail_*` 已进入 agent 模式）|
| 「帮我装个第三方技能」 | ❌ 没有第三方技能可装（`electron/skills/` 有 13 个示例技能，根 `skills/` 有 7 个智能技能） |
| 「发个 Telegram 给我」 | ⚠️ 适配器已实现（7 个渠道）但需自行配置凭据；**Telegram 可用 `node scripts/verify-telegram.cjs <TOKEN>` 一键验证**，其余渠道未经端到端真机验证 |

<sub>**验证状态**：Windows 10/11 x64 为**唯一实机验证**平台；macOS 标注 beta；
Linux 为 roadmap。**测试规模：281 文件 · 4040 用例通过 / 1 skipped / 0 失败**（本机实测；
⚠️ 少数时序测试在慢机/并发下仍可能间歇失败，见「已知问题」）；
`tsc --noEmit --strict` 零错误（且 CI 已强制，不再是摆设）；ESLint error 级
零违规，warning 用棘轮制只允许变小。

复现命令（在仓库根目录执行）：

```bash
npx tsc --noEmit --strict   # 预期：0 错误
npx vitest run             # 预期：281 文件 / 4040 passed / 1 skipped
node scripts/verify-telegram.cjs <BOT_TOKEN> [CHAT_ID]   # 可选：Telegram 渠道端到端验证
```</sub>

> ⚠️ **一句实话**：本项目 90% 的能力描述来自**代码与测试**，而不是**真人使用数据**。
> 我们没有做过可用性测试，没有留存数据，团队单人格开发。
> 这是「工程上做得扎实」与「产品上被验证过」的区别——我们只做到了前者。

> 📋 **想看完整的能力审计？** 见 [docs/Lumina-发布前全方位测评-20261013.md](docs/Lumina-发布前全方位测评-20261013.md)
> —— 发布前查出的问题（不可达工具、五阶段门控零调用方、证据链死代码等）以及它们是怎么被修的，
> 都在里面附了修复前后实测对照。

---

## 🚀 Quick Start · 快速开始

### 方式一：下载安装包（推荐）

> 首个公开版本（v0.1）即将发布；发布后可从 [Releases](https://github.com/chaxu814/lumina-life/releases) 下载安装包，双击安装、3 分钟上手。在此之前请用下方「开发者模式」运行。

### 方式二：开发者模式

```bash
# Prerequisites: Node.js 18+ · Python 3.10+（可选）
git clone https://github.com/chaxu814/lumina-life.git
cd lumina-life
npm install
npm run dev                     # 启动！
```

> 💡 **可选：安装 Python 依赖**（语音输入/输出需要；dense 语义向量也是可选增强，
> 默认的 BM25 + TF-IDF 混合召回无需 Python）
> ```bash
> pip install -r python/requirements.txt
> ```
> 如果只用文本聊天，可跳过此步骤。

### 连接 LLM（两分钟）

> 💡 **默认就是云端优先**：开箱时 Lumina 的三个 Agent 已预填云端 Provider
> （Lumina→硅基流动、Yak→DeepSeek、Recha→智谱），填好对应 API Key 即可用，
> **新手无需装任何本地推理软件**。只有你主动选择"完全本地"时才需要 LM Studio / Ollama。
>
> 🪶 **弱模型自动降级**：若你坚持用本地小模型（≤7B），Lumina 会检测到并自动进入
> "轻量模式"——只保留记忆 / 搜索 / 只读文件等安全工具，并提示模型直接简洁回答、
> 不要跑团队编排。这样 1.9B~7B 的小模型也能稳定当"陪伴 + 检索"用，而不是频繁空回复。
> 真正要写代码 / 调团队，仍建议 ≥14B 本地或云端大模型。

**第 1 步：选一条路（普通用户选 A）**

| | A. 云端 API（推荐新手）| B. 完全本地（推荐隐私党）|
|---|---|---|
| 做什么 | 拿一个 API Key 粘进去 | 装 LM Studio / Ollama，下个模型 |
| 花费 | 按量计费（DeepSeek 很便宜）| 免费、完全离线 |
| 隐私 | 对话内容发到服务商 | 数据不出本机 |
| 适合 | 不想折腾的人 | 在意隐私 / 网络不好 |

**A. 云端**：打开应用 → 设置 → LLM 配置 → 填 baseUrl + API Key + 模型名。

| 提供商 | baseUrl | 说明 |
|--------|---------|------|
| **DeepSeek** | `https://api.deepseek.com/v1` | **超低价，中文好 —— 新手首选** |
| **通义千问** | 阿里云百炼 | 国产强模型 |
| **硅基流动** | `https://api.siliconflow.cn/v1` | 多模型聚合，一张 Key 多个模型 |
| **OpenAI** | `https://api.openai.com/v1` | GPT-4o 等 |
| **Anthropic / Gemini / Grok** | 官方 baseUrl | 需对应 provider 配置 |

**B. 本地**：应用启动时会**自动探测** LM Studio（`127.0.0.1:1234`）与
Ollama（`127.0.0.1:11434`）；探到就自动推荐一个合适尺寸的模型，探不到会给出
下载引导。也可以用 `npm run dev` 后看启动日志里的探测结果。

> 🔒 **Key 安全**：`.env` 已在 `.gitignore` 中；仓库内的密钥扫描是 0 真实命中
> （扫 833 文件的 `sk-*` / `Bearer` / `ghp_` / `AKIA` 等模式）。

### 💰 持续运行的 token 成本（诚实披露）

Lumina 不是「开了就不花钱」的工具：**主动搭话、桌宠情绪、团队社交在后台会定期调 LLM**。
下面按 2026-10 DeepSeek 官方计价给出估算（[官方计价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)，最终以官方为准）：

| 模型 | 输入（缓存未命中） | 输出 |
|---|---|---|
| `deepseek-v4-flash` | ¥1 / 百万 tokens | ¥2 / 百万 tokens |
| `deepseek-v4-pro` | ¥12 / 百万（非高峰 2.5 折 = ¥3） | ¥24 / 百万（非高峰 ¥6） |

**token 假设**（读代码后估算，非实测账单）：
- 一次主动搭话 = 2 次 LLM 调用（内心独白 + 现场生成台词），约 **8k input / 300 output**；
- 一次团队社交轮次（早安/午后/晚间回顾）= 1 次调用，约 **2.5k input / 150 output**；每个仪式 3 轮；
- 纯对话一轮 ≈ **13k input**（系统人格 + 约 30 个工具 schema + 记忆注入 + 上下文）/ **400 output**。

**三档每日估算（按 flash 档 ¥1/¥2 计）：**

| 用法 | 每日事件量假设 | 估算日费 |
|---|---|---|
| **仅主动陪伴**（早安/久坐/屏幕感知/健康提醒，社交关） | 5–20 次搭话 + 1 次日报 + 若干次屏幕/热搜评估 | **¥0.08 – 0.25 / 天** |
| **主动 + 社交全开**（加早安/午后/晚间仪式 + 朋友圈后台群聊） | 上述 + 9–15 次社交轮次 | **¥0.15 – 0.40 / 天** |
| **纯对话对照**（30–50 轮/天，不主动打扰） | 40 轮 × 13k input | **¥0.4 – 0.9 / 天** |

> 也就是说：**就算把主动与社交全部开满，flash 档一天也不到 4 毛钱**；真正吃 token 的是你和她的对话本身。
> 若用 `deepseek-v4-pro`，上表乘 12–24 倍（非高峰可压到 3–6 倍）。建议在 DeepSeek 后台设**余额告警 / 预算上限**，避免忘记关时账单失控。

**想把持续消耗降到 0？** 全部开关路径：

| 想关的 | 在哪里关 |
|---|---|
| 主动搭话整体 | 设置 → 主动陪伴 / Proactive 侧栏，关掉主动引擎（`proactive`）；或环境变量 `LUMINA_FF_MODE_MINIMAL=1` 进精简模式 |
| 团队社交（早安/午后/晚间/朋友圈后台群聊） | 设置 → 团队社交；feature flag `social.deepTeam`、`team.relationshipDrama`（环境变量 `LUMINA_FF_SOCIAL_DEEPTEAM=0`） |
| 梦境日记 LLM 生成 | feature flag `dream.llmGeneration`（`LUMINA_FF_DREAM_LLM_GENERATION=0`） |
| 屏幕感知（截图→VLM） | 设置 → 屏幕感知 / `screenWatchEnabled`；健康提醒（喝水/眼/坐姿）各有独立开关 |
| 桌宠状态灯 | `LUMINA_PET_AGENT_STATE=0`（这只是状态映射，不省 LLM） |
| 记忆读写 | 设置 → 记忆与进化：「使用记忆」「生成记忆」可分别关 |

> 关掉主动/社交后，只剩你主动发消息时才产生 token，成本就和普通聊天机器人一样。

---

## 🖥️ 系统要求与平台支持

> **当前 v0.1.0-preview 仅支持 Windows 10/11 (x64)**。macOS 和 Linux 支持在 Roadmap 中（见下文）。

| 平台 | 状态 | 说明 |
|------|------|------|
| 🟢 **Windows 10/11 x64** | ✅ 当前唯一支持 | NSIS 安装包 / 便携版 |
| 🟡 **macOS** | 🔜 Roadmap (v1.3.0) | 代码有初步适配但未验证，CU/键鼠走 PowerShell 需重写 |
| 🟡 **Linux** | 🔜 Roadmap (v1.3.0) | 同上 |

> ⚠️ **为什么当前只有 Windows？**<br>Computer Use 的键鼠注入、沙箱规则库、托盘集成都深度依赖 Windows API（PowerShell、UIA、IL 降级）。macOS/Linux 支持需要重写这些模块，计划在 v1.3.0 完成。

---

## 📊 性能与资源占用

> 基于 [docs/performance.md](docs/performance.md) 的真实基准采样（i5-12490F / 48GB / RTX 5060 Ti / Win11）。

| 场景 | 内存 (RSS) | CPU | 说明 |
|------|-----------|-----|------|
| 纯 Node 脚本 idle | ~28 MB | ~0% | 仅基准进程自身 |
| **应用空载（桌宠运行中）** | **~775 MB（5 进程合计）** | **~4%（整机）** | 主进程 ~200MB + 多个渲染/GPU 进程 |

- **建议配置**：**8GB 内存以上**；4GB 内存可能紧张（尤其加载本地 ONNX 模型时）。
- **想更省资源**：启用 `mode.minimal` 精简模式、关闭 VRM、把 Live2D 帧率从 30 降到 15、不加载本地模型而改用云端 API——可把整机占用压到 ~500MB 量级。
- 📖 完整基准表、各模块占用分析与复现方法见 **[docs/performance.md](docs/performance.md)**。

---
---

## 🖥️ CLI & API

Lumina 提供完整的命令行工具和 REST API，无需启动 GUI 即可使用。

### 命令行

```bash
lumina doctor       # 系统诊断
lumina chat "你好"  # 直接对话
lumina tool list    # 列出工具
lumina agent status # 查看 Agent 状态
lumina memory search "上次聊的..." # 搜索记忆
```

> 💡 确保 `lumina.cmd` 所在目录已加入系统 PATH：
> ```cmd
> setx PATH "%PATH%;C:\Program Files\Lumina Life\resources"
> ```

### REST API

```bash
# 健康检查
curl http://localhost:3456/api/health

# 发送消息
curl -X POST http://localhost:3456/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你好","agent_id":"lumina"}'
```

支持 10+ 端点：聊天 · 工具执行 · Agent 管理 · 记忆检索 · 技能管理 · 配置读写 · 定时任务 · 审批队列

### 📱 手机远程访问（H5）

> 桌宠本来就是「必须常驻」的形态——所以「人不在电脑前也能管它」是刚需。
> Lumina 复用上面的 REST API，内置了一个手机可访问的 H5 页面：**看消息、发指令、批准权限**，不用装 App、不用上架商店。

```bash
# 1) 启动 API（或直接跑 `npm run api:dev`）
LUMINA_API_ENABLED=1 LUMINA_API_PORT=3456 electron .
```

把 API 的 `host` 设为 `0.0.0.0`（设置里改，或启动日志会提示），然后在**同一局域网**用手机浏览器打开：

```
http://<电脑局域网IP>:3456/m
```

启动日志会自动打印可用的局域网地址。页面支持：

- 💬 与 Lumina 对话（走 `/api/chat`）
- ✅ 手机上批准 / 拒绝待审批的敏感操作（走 `/api/approvals`）—— 这正是「桌宠绑定真实执行状态」在远程场景的延伸
- 🔑 若开启了 API Key 认证，页面上填一次即可（仅存本机 localStorage）

> ⚠️ 安全提示：H5 页面默认仅在**局域网**可用；如需公网访问，请自行加反代 + HTTPS + API Key，**不要**直接把端口暴露到公网。

### 🎯 确定性派活命令（跳过自动路由）

默认路由由模型裁量，同一句话两次问可能派活不同。专业用户想要确定性时，用这三条命令**一次性**指定谁干活：

```
/yak   帮我给这个函数补单元测试      # 强制派给 Yak（代码工程师）
/recha 审一下这段代码有没有并发问题   # 强制派给 热茶（审查员）
/lumina 解释一下这个报错是什么意思     # 强制由 Lumina 自己答
```

它们在聊天框内前置拦截、不发给模型自己判断，直接把这一条消息交给指定角色（不影响后续消息）。

### 🧠 记忆会话级双开关

把「读记忆」和「写记忆」分开管，并给出一份明确的**「不记什么」清单**：

| 开关 | 作用 | 何时可改 |
|---|---|---|
| **使用记忆** | 是否在回答前检索并参考长期记忆 | 建议新对话前设定（进行中改动对下一对话生效） |
| **生成记忆** | 是否把本轮对话沉淀为新记忆 | 随时可改，立即生效 |

在「设置 → 记忆与进化」里。关掉后相关接口会**如实告知未生效**，不会假装存了 / 检索了。

---

## ⚖️ 设计哲学 · 铁则

> Lumina Life 的开发遵循几条「铁则」——它们是这个项目的灵魂和底线。理解它们，就理解了 Lumina 为什么是 Lumina。

### 🥇 铁则一：用户只看到 Lumina

用户全程只与 Lumina 🐱 对话。热茶 🍵 和 Yak 💻 在后台隐身工作，用户感知不到他们的存在。

```
用户：帮我算一下这个月的开支
Lumina：好的，我这就帮你理一下↗
        （内部 → 后台整理账目数据）
Lumina：本月开支共 ¥3,280，比上月少 12% 哦！主要节省在餐饮上 👍
```

**为什么？** 真实用户不需要知道"系统里有几个 agent"。一个可信赖的助手就够了，后台分工是架构问题，不是用户问题。

### 🥈 铁则二：Lumina 有情绪，且情绪影响行为

Lumina 不是冷冰冰的 API 返回器。底层是 **3 个连续数值**（心情 mood / 精力 energy /
亲密度 affinity），带惯性与随机漂移；当前用"昼/夜"两档开关微调，尚未做连续正弦调制；它们组合映射为 5 种主要可观察表现（底层 9 个情绪标签）
（开心 / 疲劳 / 专注 / 焦虑 / 好奇）。桌宠表情则由大模型每帧实时输出。

关键在于**情绪进了执行层**，不只是换表情：重试次数会被当前情绪影响
（`delegationManager.ts`），工具可用范围会被情绪**收紧**（`orchestration/emotionGating.ts`，
且只能收紧永不放宽 —— 情绪永远不能突破角色权限边界）。

| 情绪状态 | 效果 |
|---------|------|
| 😊 happy | 主动关心你、回复更活泼 |
| 😢 sad | 话变少、需要安慰 |
| 😠 angry | 语气冲、但会道歉 |
| 😐 neutral | 正常工作状态 |
| ❤️ 亲密度高 | 更有默契、愿意敞开心扉 |

### 🥉 铁则三：记忆是连续的，不是一次性的

Lumina 记得你。每次对话都是你们关系的延续，不是从头开始的 API 调用。

```
短期记忆（当前会话）→ 是否重要？→ 长期记忆（SQLite）
                                    → BM25 + TF-IDF 混合召回（默认，已实现）· dense 语义向量（可选进阶）
                                    → 摘要 → 每日记忆
```

每次回复时，Lumina 会自动检索相关记忆，让对话有「延续感」——她记得你上周说过想去日本看樱花，今天会主动问"签证办好了吗？"

### 🏅 铁则四：安全不是选项，是默认值

| 安全机制 | 说明 |
|---------|------|
| 🛡️ 沙箱模式 | 双层审查：消息/参数级（6×10）+ 命令级（32 条规则，4 档分级） |
| 📋 审批流 | 高风险操作需要用户手动确认 |
| 🔒 隐私优先 | 所有数据本地存储，不上传云端 |
| 🔑 API Key 隔离 | LLM Key 与应用权限分离 |
| 🚚 数据导出/导入 | 本机记忆一键打包为 zip（manifest + 人读 memory.md + 每表 JSON），导入时按主键去重、绝不覆盖现有数据 |
| 🎛️ 功能开关 | 设置页可逐项开关全部新能力（实验项默认关）；`mode.minimal` 精简模式只露「会主动找你 · 真记得你 · 安全帮你干一件事」 |

### 🏅 铁则五：开源是承诺，不是营销

Lumina Life 采用 **双许可证（AGPL-3.0 OR Apache-2.0）**。你可以永远自由地使用、修改、分发它，不必担心「开源陷阱」。[了解更多](#🔓-open-source--开源说明)

---

## 🏗️ Architecture · 架构一览

```
┌─────────────────────────────────────────────────────────────┐
│                     Electron Shell                            │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │               Multi-Agent System                         │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐               │ │
│  │  │  Lumina  │  │   热茶   │  │   Yak    │               │ │
│  │  │  🐱 BOSS  │  │  🍵 REV  │  │  💻 DEV   │               │ │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘               │ │
│  │       └──────────────┼──────────────┘                     │ │
│  │              Team Social Engine                           │ │
│  │         (自发聊天 · 早安仪式 · 朋友圈)                     │ │
│  └──────────────────────┬──────────────────────────────────┘ │
│  ┌──────────────────────┼──────────────────────────────────┐ │
│  │     Tool Registry    │    Skill Ecosystem               │ │
│  │  139 tools · MCP          │  Plugin SDK · Skill Store      │ │
│  └──────────────────────┼──────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Memory · Security · Session · Approval · Cron          │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 项目结构

```
lumina-life/
├── electron/       # 主进程 — Agent 引擎 · 记忆 · 工具 · 安全
├── src/            # 渲染进程 — 23 个面板 · React 19 · Zustand
├── tests/          # 测试文件 — Vitest · 单元+集成+E2E
├── skills/         # 技能目录
├── knowledge/      # 知识库
└── dist/           # 安装包输出
```

---

## 📸 Screenshots · 截图

> Lumina 的界面充满活力和温度——这里是她在日常工作中的样子。

| 功能 | 预览 |
|------|------|
| 💬 **聊天面板**<br>与 Lumina 日常对话，支持流式输出、情绪显示 | ![Chat Panel](docs/images/chat-panel.png) |
| 🐾 **Live2D 桌宠**<br>桌面上的 Lumina，呼吸/眨眼/表情随情绪变化 | ![Pet Live2D](docs/images/pet-live2d.png) |
| 📱 **Moments 朋友圈**<br>旁观 Lumina、热茶、Yak 的自发动态 | ![Moments](docs/images/moments.png) |

---

## 🧪 Tech Stack · 技术栈

| 层 Layer | 技术 Technology |
|----------|----------------|
| 桌面框架 Desktop Framework | **Electron 40** |
| 前端 Frontend | **React 19** + TypeScript + Vite |
| 状态管理 State Management | **Zustand 5** (persist) |
| 构建打包 Build | electron-vite + electron-builder (NSIS) |
| 数据库 Database | better-sqlite3 |
| 测试 Testing | Vitest |
| 自动更新 Auto Update | electron-updater (GitHub Releases) |
| 协议支持 Protocols | MCP (Model Context Protocol) |
| 桌宠 UGC Pet UGC | 自定义 8×9 精灵表（无需会 Blender，AI 可生成） |
| 测试规模 Tests | **281 文件 / 4040 用例通过 / 1 skipped / 0 失败**（本机实测；少数时序测试负载敏感见「已知问题」）· `tsc --strict` 零错误（CI 强制）· ESLint error 级 0 + warning 棘轮 · CI 含原生 ABI 门禁 |

---

## 🗺️ Roadmap · 路线图

完整版见 **[docs/ROADMAP.md](docs/ROADMAP.md)**（含已知缺口表与认领指引）。

**✅ 当前开发版（v0.1.0-preview）**
三 Agent 团队（流水线 + 对抗式评审 + 动态雇工）+ 情感系统（5 主要表现 + 亲密度 + 昼/夜两档，底层 9 标签）+ 记忆系统（BM25/TF-IDF 混合召回 + 防幻觉固化）+ 139 个工具 + 真·屏幕视觉 + Computer Use + 🛡️ 智能沙箱 + 精灵表 8×9 UGC 规格 + 桌宠绑定真实 Agent 状态

**✅ 已完成的发布加固**
- [x] 原生模块 ABI 与 Electron 对齐（CI 有门禁，不再出现「测试绿、真机炸」）
- [x] 自动验证-修复闭环收敛为**单一实现**（消除双份逻辑）
- [x] 路由仲裁接线到真实调用方（歧义任务才调 LLM，1.2s 硬超时不阻塞）
- [x] 死代码清理：并行引擎接入阶段门控、亲密度审查语气接入真实提示词
- [x] 文档数字与代码对齐 + 诚实能力矩阵

**🔜 v0.1.0** — Windows 安装包签名 · 发布演示视频 · 新手模式一键体检
**🔜 v0.2.0** — 精灵表本地图集导入工具链 + 校验器
**🔜 v0.3.0** — 桌宠情绪动作与执行状态的更细粒度绑定（卡点焦虑、审批等待、收工轻松等情绪反应）
**🔜 v0.4.0** — macOS 实机验证与签名公证 · Linux 键鼠方案
**🔜 v1.0** — IM 渠道端到端真机验证（接线已完成，7 个适配器）· 技能市场生态 · 多端记忆同步

### 🧪 实验性 / 彩蛋功能（非主线，请勿当真）

- **梦境日记、Agent 真人秀**：已接 LLM 真实生成（在设置里配好 LLM 后即走真实模型）；未配置时回退到 **9 个情绪锚点模板 + 记忆片段关键词**，UI 用 `来源: llm / 来源: template` 诚实标注，绝不假装是大模型写的。
- **记忆检索**：默认 BM25 + TF-IDF 双路 RRF 混合召回（已实现、零依赖；中文用 unigram+bigram 字符级分词，无词典）；dense 语义向量（Ollama nomic-embed-text 或外部 embedding 服务）可在记忆设置中开启，提供更强语义匹配。
- **副人格觉醒（实验）**：最小真实机制已上线——基于长期记忆 + 情绪状态的人格漂移 / 副视角，触发条件为「高亲密度 + 累计约 200 轮对话」或「持续高焦虑」，置于 `personality.subPersona` 开关后**默认关闭**、可随时关；仍属实验性，不代表核心陪伴能力。

---

## 🔓 Open Source · 开源说明

Lumina Life 采用 **双许可证（Dual-License）** 发布，您可在以下两者中选择其一：

### 选项一：AGPL-3.0（社区版）

适合个人用户、开源项目和教育用途。

| ✅ 你可以 | 📋 需要遵守 |
|----------|------------|
| 自由使用、修改、分发 | 分发修改版时需公开源代码 |
| 创建自定义角色/人格 | 保留版权声明 |
| 开发新技能并分享 | 网络交互视为分发（AGPL-3.0 标准条款） |
| 提出 Issue 和 Feature Request | — |
| 免费用于个人用途 | — |

> **为什么保留 AGPL-3.0？** 我们希望 Lumina 的核心能永远开放，让社区可以自由定制和改进。选择 AGPL-3.0 的用户，您的改进也会回馈给整个社区。

### 选项二：Apache 2.0（商业版）

适合企业集成、商业产品嵌入和闭源部署。

| ✅ 你可以 | 📋 需要遵守 |
|----------|------------|
| 自由使用、修改、分发 | 保留版权声明 |
| 集成到商业闭源产品中 | 无"开源传染"要求 |
| 创建衍生作品（包括闭源） | 修改处需显著标注 |
| 用于商业目的 | — |

> **选择权在你手中。** 两个许可证都附在项目根目录中：
> - [`LICENSE`](LICENSE) — AGPL-3.0
> - [`LICENSE-APACHE`](LICENSE-APACHE) — Apache 2.0

---

## 💬 Community · 社区

| 途径 | 用途 |
|------|------|
| 💡 [GitHub Issues](https://github.com/chaxu814/lumina-life/issues) | Bug 反馈 & 功能建议 |
| 📖 [GitHub Discussions](https://github.com/chaxu814/lumina-life/discussions) | 技术讨论 & 使用技巧 |
| 🎨 [贡献指南](CONTRIBUTING.md) | 参与开发的完整指引 |
| 📝 [更新日志](CHANGELOG.md) | 版本发布记录 |

---

<p align="center">
  <br>
  <b>Made with ❤️ by the Lumina team. And by Lumina herself. 🐱</b><br>
  <sub>She helped write this README. No, really.</sub>
  <br><br>
  <sub>⭐ 如果 Lumina 给你带来了快乐，请给仓库一个 Star ⭐</sub>
  <br>
  <sub>If Lumina brought a smile to your face, give the repo a star ✨</sub>
</p>
