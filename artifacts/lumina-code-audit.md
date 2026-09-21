# Lumina Life 本地代码库深度审计报告

> 审计日期：2026-09-21 ｜ 审计对象：`K:\2\Lumina AI`（v0.1.0-preview，未公开）
> 审计方法：只读。覆盖 `electron/` `src/` `python/` `skills/` `agents/` `tests/` `docs/` `.github/` 与根目录元文件；未跑测试、未改任何业务文件。
> 审计立场：不被 README 忽悠，逐模块到文件级证据。

---

## 0. TL;DR — 三句话结论

1. **这不是一个 PPT 项目，是一个真写了 16 万行代码的中型 Electron 应用**（electron 12.0 万行 + src 3.9 万行 + tests 0.8 万行），三 Agent、情绪连续态、BM25 混合召回、26 条沙箱规则、CU 链路、Live2D+VRM 双渲染**都在代码里有真实实现**，不是 UI 装饰。
2. **但 README 的宣传口径比代码能力激进 1.5 倍**：真实工具数约 50–60 个（不是 90+），"跨平台"目前是 Windows 优先（CHANGELOG 自己写"仅支持 Windows 10+"），"TF-IDF+BM25 混合召回"实际只有 BM25 真写了、向量分支是空接口，"安全沙箱"项目里其实有**两套并存但不一致**的规则模型（7×8 vs 6×10）。
3. **GitHub 发布 readiness 大约 70%**：LICENSE/CONTRIBUTING/CODE_OF_CONDUCT/SECURITY/CLA/CHANGELOG/三平台 CI workflow 都齐了，但**缺 issue/PR 模板、缺截图、缺真实 star 口径、根目录还躺着含真实 API Key 的 `agents/` 目录**（虽已 .gitignore 但仍在工作区）。竞品分析 v2 报告本身已经相当犀利，本审计在它基础上做了二次校验，确认它的自批大部分属实，少数结论需要修正。

---

## 1. 架构真相：代码规模与目录组织

### 1.1 真实代码规模（行数级别）

| 目录 | 文件数 | 行数（ts/tsx/js/py/md 汇总） | 备注 |
|---|---:|---:|---|
| `electron/`（主进程） | 392 | **120,362** | 核心战场；含主进程 IPC、Agent 引擎、工具、记忆、沙箱、桌宠 |
| `src/`（渲染进程） | 113 | **39,131** | React 面板 + Zustand store |
| `tests/` | 80 | 8,031 | Vitest，覆盖情绪/沙箱/团队/记忆/CU/主动/语音等 |
| `python/` | 12 | 1,047 | edge-tts / index-tts / embedding / whisper STT 四个 sidecar |
| `skills/`（用户技能） | 7 | 162 | 7 个 SKILL.md（browser_click/code_review/file_search/install_skill/proactive_check/quick_setup/web_search_multi） |
| `electron/skills/`（内置技能） | 9 | ~6 KB | files_core/git/mcp/memory/shell/system/tasks/team/web_search |

**总手写代码 ≈ 16.8 万行**（不含 node_modules / dist / 压缩后的 pet-vrm.js 1.3MB / pixi/live2d 第三方库）。

### 1.2 目录组织：理想 vs 现实

README 宣称的项目结构是干净的 `electron/ src/ tests/ skills/ knowledge/`，实际：

- `electron/` **根目录扁平地堆了 90+ 个 `.ts` 文件**（不是按子目录归类的），其中：
  - **上帝组件/上帝类**：`agentRunner.ts` **157 KB**（约 4000+ 行单文件）、`main.ts` 82 KB、`preload.ts` 60 KB、`proactiveEngine.ts` 47 KB、`delegationManager.ts` 45 KB、`agentSocialEngine.ts` 32 KB。
  - **已废弃但未删的空壳**：`rechaRunner.ts`（10 行，直接 `throw new Error('已废弃')`）、`yakRunner.ts`（4 行注释）——真正的 Recha/Yak Runner 是在 `main.ts` 里 new 出来的，这两个文件只是历史包袱。
  - **混在主目录的临时验证脚本**：`verify-p3-delegation.ts/js`、`verify-p3-static.js`、`_unlimit.js`（0 字节空文件）——**这些不应该出现在开源仓库根目录**。
- 真正组织良好的子目录：`electron/team/`（17 个文件，dynamicWorker/workflowScript/teamSharedBoard/teachRecorder 等）、`electron/tools/impl/`（~50 个工具实现）、`electron/pet/life/`（情绪/口型/动画/runtime）、`electron/proactive/`（orchestrator/generator/gate/backoff/unfinishedThread 模块化）。
- `src/panels/` 实际有 **29 个面板文件**（README 写"23 个"），其中 `GroupChatView.tsx` **273 KB**、`ChatPanel.tsx` **128 KB**、`SettingsPanel.tsx` **90 KB**——典型的"面板级上帝组件"。

### 1.3 Agent persona 是怎么定义的

不是代码里硬编码人格，而是**文件驱动的三件套**：

```
agents/<id>/{agent.json, SOUL.md, PROFILE.md, AGENTS.md, MEMORY.md}
```

- `agents/lumina/agent.json`：声明式配置（provider/endpoint/llm 参数/tools 白名单/social.mood/energy/affinity 初值）。
- `agents/lumina/SOUL.md`：60 行人格语气约束（"温暖干脆，像朋友聊天"、"正经问题切认真模式"）。
- `agents/recha/SOUL.md` / `agents/yak/SOUL.md`：热茶 = 毒舌审查员、Yak = 代码工程师，规则化"只审查不写代码 / 只写代码不聊天"。
- 这套"AGENTS.md 管操作、SOUL.md 管语气"的分层，**与 openclaw 的 SOUL 范式同构**（竞品报告已指出，不是 Lumina 原创）。

> ⚠️ **密钥泄露雷区**：`agents/lumina/agent.json` 第 10 行**硬编码了一个真实 LM Studio API Key** `***REMOVED_API_KEY***` 和内网地址 `http://127.0.0.1:1234/v1`。好在 `.gitignore:161` 已经 `agents/` 整个排除，CHANGELOG 也明说"导出脱敏模板到 `src/assets/agentTemplates/`"。**发布前必须确认 `git ls-files agents/` 为空**，否则上线即泄露。

---

## 2. 创新点证据：逐项去代码里找

### 2.1 三 Agent 团队协作 — **真 LLM 多 Agent，不是 prompt 拼装**

| 证据 | 文件 | 实证 |
|---|---|---|
| 编排器单例 | `electron/core/agentOrchestrator.ts` | `AgentOrchestrator` 持有 `delegation / modeManager / teamContext / socialEngine`，静态 import 解循环依赖 |
| 委托管理器 | `electron/delegationManager.ts`（45 KB） | 独立 Runner 注册表 + 委托流水线 |
| 团队社交引擎 | `electron/agentSocialEngine.ts`（32 KB） | `SPONTANEOUS_TOPICS` 数组定义 9 个自发话题（早间签到/晚间回顾/午后茶歇/互相鼓励/分享趣事/代码审查/性能脑暴/架构评审/Bug 狩猎），每个带 `initiator / participants / maxRounds / weight / condition(team)` |
| 团队信箱/共享板 | `electron/team/teamMailbox.ts`、`teamSharedBoard.ts` | 跨 Agent 异步消息 + 共享白板 |
| 动态工人/对抗评审 | `electron/team/dynamicWorker.ts`（27 KB）、`adversarialReview.ts` | 真有"写完→另一 Agent 挑刺"的对抗循环 |
| LLM 协调器 | `electron/llmCoordinator.ts` | 优先级队列（PRIORITY 枚举） |

**结论**：是真多 Agent——每个 Agent 独立 `AgentRunner`、独立 LLM endpoint、独立 SOUL，通过信箱/共享板通信。不是"一个 LLM 里塞三个 system prompt"。但**三 Agent 之间的消息是自由文本**，没有 AIRI 那种 `intent/priority/risk/fallback` 结构化协议（竞品报告 3.2 节已正确指出）。

### 2.2 情绪系统 — **真有数值驱动 + 连续融合**

**两层情绪，互相换算**：

1. **桌宠表情层（9 个离散 mood 标签 → 连续 valence/arousal）**：
   - `electron/pet/emotionFusion.ts`：EMA 惯性（α=0.35）+ 单步变化率限制（maxStepV/A=0.18）+ 标签迟滞（hysteresis=0.06）+ 无输入时向基线漂移（baselineDrift=0.05）。
   - 9 个 mood 标签在二维平面上有坐标（`emotionFusion.ts:47-57`），LLM 给"开心"→ 平滑拉过去，不会"上句笑下句哭"。
2. **团队五维层（joy/fatigue/focus/anxiety/curiosity）**：
   - `electron/pet/life/emotionCore.ts`：把"团队五维 / 前端三维(mood/energy/affinity) / 9 标签"三套历史表示统一成 `CoreEmotion`，提供 `teamFiveToCore / frontendThreeToCore / moodToCore / coreToMood` 四个换算函数。
   - 启发式加权（`emotionCore.ts:100-101`）：`valence = joy*1.05 - anxiety*0.9 - fatigue*0.35`，`arousal = (joy*0.5 + curiosity*0.55 + focus*0.25 + anxiety*0.35) * (1 - fatigue*0.6)`。

**情绪如何影响行为**：
- 影响 Live2D blendShape：`pet/life/runtime.ts` 的 `PetPerformanceEngine.setMood()` → `faceRig.ts` 生成表情参数。
- 影响 VRM：`pet/vrm/vrmRenderer.ts:30-41` 的 `VrmEmotionInput {valence, arousal, anxiety, fatigue, energy}` → 逐帧 lerp 到目标 blendShape。
- 影响主动搭话门控：`proactive/gate.ts` 按 `energy < 0.2` 退化睡觉、按场景放行率（game 0.5 / private 0 / idle 0.7）。
- 影响审查语气：`agentRelationships.ts` 亲密度事件驱动热茶审查语气软硬。

**结论**：README 宣称的"5 维情绪 + 连续融合 + 迟滞"**全部在代码里真有**，参数都硬编码可测。这是全项目原创度最高的一块。

### 2.3 团队社交（群聊/早安/Moments）— **真有调度器，不是 UI 装饰**

- `agentSocialEngine.ts:45` 的 `SPONTANEOUS_TOPICS` 是真调度：每条带 `condition(team: TeamState)` 函数，例如"早间签到"要求 `7 ≤ hour ≤ 10`，"分享今日趣事"是 `Math.random() < 0.18`。
- 输出**只进 Moments 朋友圈**（`moments/autoPoster.ts` 的 `postObservation/postThought/postChatSummary`），不进用户聊天窗——这是真剧场感设计。
- `moments/momentsStore.ts`：真 SQLite 三张表（`moments / moment_comments / moment_likes`），外键 + UNIQUE(moment_id, agent_id) 防重复点赞，WAL 模式。
- `tools/impl/socialEngine.ts` 是个薄 Skill 包装，调 `orchestrator.socialEngine.triggerConversation(topic)`——但**用了 `(engine as any).triggerConversation || startSocialChat || globalEventBus.emit` 三层鸭子类型 fallback**，说明接口还在漂移，没稳定。

**结论**：是真调度器，但接口尚未完全收敛，仍有版本兼容垫片。

### 2.4 沙箱：7 级×8 类规则库 — **真有 26 条规则，但项目里并存第二套**

`electron/tools/impl/sandboxRules.ts:106-248` 我数了一遍，**正好 26 条**：

| Severity | 条数 | 规则 id |
|---|---:|---|
| BLOCK（硬拦截） | 9 | BLOCK-001 到 009（格式化/rm -rf 根/fork 炸弹/删系统目录/dd 写盘/改账户/删注册表…） |
| CRITICAL（强审批） | 6 | CRIT-001 到 006（删密钥/远程脚本管道/eval+base64/关机/递归 -Force/外传私钥） |
| HIGH（Low IL 降级+审批） | 4 | HIGH-001 到 004（静默删除/读密钥/表单上传/777 权限） |
| MEDIUM（记录审计） | 5 | MED-001 到 005（多级 ../ / 出站下载/提权/写系统配置/疑似 prompt 注入） |
| LOW（放行+记录） | 2 | LOW-001 到 002（命令拼接/find -exec） |
| INFO | **0** | enum 里定义了但 RULES 数组没规则命中——**README 说"7 级"实际生效只有 6 级** |

**但项目里还有第二套**：`electron/securityGuard.ts:28-48` 定义了 **6 级（无 BLOCK）× 10 类（多 RESOURCE_ABUSE / NETWORK_ABUSE）**，注释明说"借鉴 QwenPaw tool_guard"。

**这是真正的文档/代码混乱**：
- README 第 158 行说"7 级×8 类 26 条" → 对应 `sandboxRules.ts`。
- 竞品报告 v2 第 197 行说"实测 6 级×10 类" → 对应 `securityGuard.ts`。
- **两份都对，因为项目里就是两套并存**，没有哪个是"唯一事实源"。`registry.ts:12` 同时 import 了 `getSecurityGuard`，`cuCore.ts` 又用 `sandboxRules` 的 `evaluateCommand`。

### 2.5 记忆系统 — **SQLite 真、BM25 真自写、TF-IDF 名不副实、向量是空壳**

**Schema（`memory/memoryStore.ts:128-176`）**：6 张表真实存在
```
memory_fragments / conversation_history / facts / reflections /
persona_traits / semantic_memories
```
WAL 模式 + 索引 + `facts.category` 迁移脚本（从 5 类扩到 6 类含 `agent_memory`）。

**BM25（`hybridMemoryRetrieval.ts:34-112`）**：真自己实现
- k1=1.5, b=0.75 标准公式
- 中文分词 = 单字 + 短语双重索引（`/[\u4e00-\u9fa5]+/g`），英文按空格
- 有内存缓存（`_bm25Cache` 按 agentId + note 数量做 key）

**TF-IDF**：`memoryStore.ts` 注释提了"TF-IDF 本地向量化"，但 `hybridMemoryRetrieval.ts` 里**实际只跑 BM25**，`RetrievalResult.source` 枚举里有 `'vector' | 'bm25' | 'hybrid'` 三种，函数体里**只 push `source: 'bm25'`**。向量分支是预留接口，没真接。

**证据链/置信度（`memoryEvidence.ts:69-75`）**：真 5 维加权
```
composite = confidence*0.30 + recency*0.15 + frequency*0.15
          + corroboration*0.10 + importance*0.30
```
7 天半衰期，>0.6 注入 system prompt，<0.3 可清理。注释明说"借鉴 N.E.K.O."。

**结论**：README 宣称"TF-IDF + BM25 混合召回"**有夸大**——真实是"BM25 单一召回 + 预留向量接口"。注释自己也承认"借鉴 N.E.K.O 三层模型"和"Stanford Generative Agents 记忆流"（`agentIndependentMemory.ts:16`）。

### 2.6 Computer Use — **链路真、Windows-only 假设明显**

`electron/tools/impl/cuCore.ts`（42 KB）把 CU 拆成 6 层，注释写得很清楚：
1. `getCuVlmConfig()`：环境变量 → agent 配置 → 兜底 OpenAI
2. `captureScreen()`：`screenshot-desktop` + PowerShell 回退
3. `callVisionModel()`：OpenAI 兼容多模态
4. 键鼠原语 `cuClick/cuType/cuScroll/cuDrag/cuPressKey`——**Windows 走 PowerShell，中文输入走剪贴板**（`cuCore.ts:9` 自承）
5. `executeCuAction()`：归一化 0–100 坐标 → 像素换算
6. 急停 `requestCuAbort/isCuAborted`

配套：`cuPermissions.ts`（25 KB，4 级×4 分区）、`cuInputGuard.ts`（11 KB）、`cuVerify.ts`（dHash 帧差验证画面是否真变了）、`cuUia.ts`（Windows UI Automation 树）、`cuGeometry.ts`（多显示器虚拟桌面偏移）。

**跨平台证据**：`cuCore.ts` 里 19 处 `process.platform` 分支，`keyboard.ts` 4 处，`shellFileWall.ts` 5 处。有 `pet/platformCaps.ts` 做能力抽象。**但键鼠注入的主路径是 PowerShell 脚本**，macOS/Linux 真能跑通要打问号。

### 2.7 双渲染（Live2D + VRM）— **Live2D 主线完成度高，VRM 是真 beta**

**Live2D（主线，production）**：
- 模型是 `electron/pet/assets/Mao/mao_pro.moc3`（870 KB）+ 8 表情 + 8 motion + 4K 贴图（8.2 MB）。
- 运行时 `pet/life/runtime.ts` 打包成 `pet-life.js`（31 KB），呼吸 ~4s / 眨眼 1.8–5s 随机 / 五元音口型 / 视线分层 / AnimationMixer 多图层混合。
- `pet-live2d.html` **170 KB**（单文件 HTML，含内联 JS）。

**VRM（beta，可用但未完成）**：
- `pet/vrm/vrmRenderer.ts`（12 KB）：three.js + `@pixiv/three-vrm` v3.4.1，正交相机 + 三灯布光（环境/主/补/轮廓）。
- 已接 `setEmotionCore({valence, arousal, anxiety, fatigue, energy})` → blendShape lerp。
- 但 README 自己承认："口型 / 视线跟随暂仍在 Live2D，VRM 情绪动作默认关（`pet.vrmExpressive`）"。
- 第三方版权头在 `pet-vrm.js` 里完整保留（pixiv MIT），合规。

**结论**：Live2D 是 production，VRM 是真 beta（不是 fake，但口型/视线没接）。

---

## 3. 跟随 vs 原创：到底借鉴了谁

| 关键词 | 代码证据 | 性质 |
|---|---|---|
| **N.E.K.O** | `memoryStore.ts:9` "架构借鉴 N.E.K.O 三层模型"；`memoryEvidence.ts:4` "借鉴 N.E.K.O 证据评分"；`agentIndependentMemory.ts:16` "借鉴 N.E.K.O evidence.py + Stanford Generative Agents" | **明确跟随**：三层记忆（Facts/Reflection/Persona）、证据评分权重、冷落退避，都是 N.E.K.O 先做的 |
| **QwenPaw** | `securityGuard.ts:4` "借鉴 QwenPaw tool_guard"、`:8` "借鉴 QwenPaw GuardThreatCategory" | **明确跟随**：第二套安全模型整个抄了分类枚举 |
| **OpenClaw** | `channels/openclaw/openclawClient.ts`（5.6 KB）是 A2A/MCP 客户端，把 OpenClaw 当**外部执行后端**桥接，不是抄代码 | **集成而非跟随**：可选桥接，未配置自动回退 |
| **AIRI** | grep 无代码引用；`docs/AIRI-技术档案.md` 是分析文档不是代码 | **竞品分析对象，未直接复用** |
| **Live2D Cubism** | `pet/assets/libs/live2d.min.js`（129 KB，pixi/live2d 官方 SDK） | **官方 SDK，合规** |
| **three-vrm** | `pet-vrm.js` 内 pixiv MIT 版权头完整 | **官方库，合规** |
| **Stanford Generative Agents** | `agentIndependentMemory.ts:16` 注释 | **架构灵感，不是代码复制** |

**真正自己造的轮子**：
- 情绪连续融合层（`emotionFusion.ts` EMA+迟滞+基线漂移）——在 4 个竞品里少见。
- 三 Agent 只在朋友圈社交、不打扰用户的剧场感设计（`agentSocialEngine.ts` + `momentsStore.ts`）——独家结构。
- `proactive/` 模块化主动管线（12 类触发源 → gate → innerThoughts → generator → dispatchIntent）。
- CU 的 dHash 画面变化验证（`cuVerify.ts`）+ 归一化坐标 + 急停信号。
- 7 级×8 类 26 条正则规则库（虽然分类借鉴了 QwenPaw，但规则内容是自己写的）。

---

## 4. 短板与雷区

### 4.1 测试覆盖：真有，但 CI 是否真绿未验证

- `tests/` 有 **80 个测试文件**，覆盖 emotionEngine / emotionFusion / sandboxRules / teamManager / teamMailbox / teamSharedBoard / computerUse / cuCoreTokens / cuGeometry / cuInputGuard / cuPermissions / cuSafety / cuVerify / memoryEvidence / relationshipMemory / layeredMemory / proactiveBackoff / proactiveGate / proactiveFollowup / dreamEngine / socialEngine / live2dWiring / vrmLayout / fullDuplexController / bargeIn / wakeWord 等。
- `coverage/` 目录真实存在（`coverage-final.json` 311 KB + `clover.xml` 64 KB + HTML 报告），说明本地跑过覆盖率。
- `.github/workflows/test.yml`：三平台（win/mac/linux）× Node 20/22 + `tsc --noEmit` + `vitest run` + coverage gate（注释说"核心模块 70% 行/55% 分支"）+ ESLint + build + 三平台 Release 签名流程。**CI 配置本身是完整的、工业级的**。
- **但**：本地没跑 vitest，覆盖率阈值是否真过、CI 是否真绿，未验证。竞品报告 v2 第 200 行也承认"测试是否在 CI 实际跑绿未查证"。

### 4.2 TODO/FIXME 密度：低

```
TODO|FIXME|XXX|HACK|placeholder|未实现|占位 → 36 处 / 23 文件（在 12 万行里）
mock|stub|fake → 40 处 / 12 文件（大部分在 __tests__ 和压缩后的 pet-vrm.js）
```

36 处 TODO 在 12 万行代码里密度约 0.03%，**不算技术债堆积**。但 `rechaRunner.ts` / `yakRunner.ts` 两个空壳、`verify-p3-*.ts/js` 三个临时脚本、`_unlimit.js` 0 字节文件，**这些是发布前必须删的**。

### 4.3 平台支持：Windows-only 假设仍然很重

- `setup.bat` 硬编码 `C:\Program Files\nodejs`，是 Windows 批处理。
- `cuCore.ts:9` 注释自承"Windows 走 PowerShell，输入走剪贴板"。
- `shellFileWall.ts` / `shellMonitor.ts` / `shellNetCage.ts` 的规则大量针对 Windows 路径（`C:\Windows\System32`、`reg delete`、`diskpart`）。
- CHANGELOG 第 96 行白纸黑字："**仅支持 Windows 10+**（macOS/Linux 在 Roadmap）"。
- 但 README 第 265 行说"主要面向 Windows，但也支持 macOS 和 Linux"，第 478 行 Roadmap 又写"v1.3.0 macOS/Linux 支持"。

**口径矛盾**：CHANGELOG 说"仅 Windows"，README 说"主要 Windows 但三平台都支持"，Roadmap 说"v1.3 才支持"。**三处说法不一致**。CI 矩阵虽然跑三平台，但那是跑测试，不代表桌宠窗口/CU/托盘在 mac/linux 真能开箱即用。

### 4.4 安装门槛

- `setup.bat`：检查 node → 临时加 PATH → `npm install`。**没跑 electron-rebuild**，better-sqlite3 这种原生模块大概率要手动 `npm run rebuild:electron`。
- `setup.sh` 存在但未读，假设是 bash 版本。
- `Dockerfile` 真实可用：node:22-bookworm-slim + xvfb + Electron headless API 模式（`--no-sandbox --api`），3456 端口。**这是个加分项**，README 没怎么提。
- `python/requirements.txt` 1.5 KB，edge-tts / indextts / whisper / embedding 四个 sidecar 都是可选。

### 4.5 文档完整性

| 文档 | 状态 |
|---|---|
| README.md（28 KB） | 详细但口径激进（90+ 工具 / 跨平台 / TF-IDF+BM25） |
| CHANGELOG.md | 真实，承认 v0.1 preview + Windows-only |
| CONTRIBUTING.md / CODE_OF_CONDUCT.md / SECURITY.md / CLA.md | **齐全** |
| LICENSE（AGPL-3.0）+ LICENSE-APACHE | **齐全**，双协议真实 |
| docs/API.md（12.7 KB，16 端点） | 完整 |
| docs/ARCHITECTURE.md / DEVELOPER.md / FAQ.md / TROUBLESHOOTING.md | 齐全 |
| docs/RELEASE_CHECKLIST.md | 诚实，列了一堆 ☐ 待外部条件 |
| docs/vitepress 文档站 | 有构建产物，但只 build 了 index/architecture/FAQ/TROUBLESHOOTING 4 页 |
| **插件 SDK 文档** | `pluginSDK.ts` 12 KB 存在，但 `docs/` 里没有独立 Plugin SDK 文档 |
| **Issue/PR 模板** | **缺失**（`.github/` 下只有 workflows/，无 ISSUE_TEMPLATE/、PULL_REQUEST_TEMPLATE.md） |

### 4.6 其他雷区

- `PROFILE.md` / `SOUL_RECHA.md` / `SOUL_YAK.md` 用 PowerShell 读出来是 **GBK 乱码**（编码声明问题），但 `.gitignore:143-147` 已排除，不会发布。
- `docs/_ref/attach-v331.bin`（37 KB 二进制）和 `docs/_shots/` 一堆截图被提交进了仓库——`_shots/` 在 .gitignore 里但 `docs/_shots/` 不在。
- `lumina-quests.json` / `async-tasks.json` 在根目录，是运行时产物，`.gitignore:167-168` 已排除。
- 竞品分析 HTML 报告（50–95 KB）散落在根目录和 `docs/`，**不应该出现在开源仓库**——这些是内部分析材料。

---

## 5. 已有竞品分析文件的批判性核对

审计对象：`Lumina-竞品对比分析-v2-20260921.md`（46 KB）+ 根目录两个 HTML + docs/ 下 6 个 HTML。

### 5.1 仍然成立的结论（我独立验证为真）

| 结论 | 我的验证 |
|---|---|
| "主动系统已模块化进 `electron/proactive/`，不再是单一上帝文件" | ✅ 真：`proactive/` 下有 orchestrator/generator/gate/backoff/unfinishedThread/followupTopics/resolveProactiveLLM 8 个文件 |
| "冷落退避方向写反：`social>0.7 && idle>5min → 强制搭话`" | ✅ 真：`proactive/driveHardTrigger.ts:18` 原文就是这个逻辑，注释自承"她坐不住了必须搭话" |
| "真人秀约 65% 仍是剧本" | ⚠️ 未直接验证 realityShowEngine 内部，但 `realityShowEngine.ts` 15.8 KB 规模合理 |
| "agentRunner.ts 157KB 单体可维护性未查证" | ✅ 真：我实测 157,574 字节 |
| "BM25 是真自写、向量召回需另起本地 embedding server" | ✅ 真：`hybridMemoryRetrieval.ts` 只有 BM25 |
| "Live2D 情绪长在脸上 + 迟滞防抖是独家" | ✅ 真：`emotionFusion.ts` 参数齐全 |
| "三 Agent 朋友圈只进 Moments 不进用户窗" | ✅ 真：`agentSocialEngine.ts:6-7` 注释明说 |
| "docs/RELEASE_CHECKLIST.md 列了一堆 ☐ 待外部条件" | ✅ 真：我读了，Steam/Docker/签名都标 ☐ |

### 5.2 已经过时或需要修正的结论

| 报告原文 | 问题 | 修正 |
|---|---|---|
| "`.github/workflows/test.yml` 存在但未读内容"（5.2 节） | **过时** | 我读了：三平台 × Node 20/22 + typecheck + vitest + coverage gate + lint + build + release 签名流程，**CI 配置是工业级完整的**，这点比报告说的好 |
| "实测安全模型是 6 级×10 类"（5.2 节） | **片面** | 项目里**两套并存**：`securityGuard.ts` 是 6×10，`sandboxRules.ts` 是 7×8 26 条。README 宣称的 7×8 对应后者。报告只抓了 securityGuard，没讲清双轨 |
| "N.E.K.O 2949 star / AIRI 49295 / openclaw 390167 / cc-haha 14662" | **会过期** | star 数是 2026-09-21 当天 GitHub API 抓的，一周后就变。报告自己也标了日期，但读者容易当成永久事实 |
| "工具生态 ~116 真实工具 + 16 技能" | **口径混乱** | 我 grep `name: 'xxx'` 全仓库 166 处匹配（含 CLI 命令/skill/tool），`registry.ts` 自己注释"agent 模式 ~25 工具"。README 说 90+、CHANGELOG 说 70+ 和 88+、竞品报告说 116——**四个数字四个口径**，没有一个准 |
| "README 说 23 个面板" | **过时** | 实际 `src/panels/` 有 **29 个** .tsx 文件（含 TeamCollabSection / TeamTopologyView / MoreSettingsPanel 等） |

### 5.3 自嗨/双标嫌疑的地方

1. **贬低竞品时证据严谨，吹自己时模糊**：报告对 cc-haha 逐条引用 `petSessionModel.ts:23-39`、`useProactive.ts` 空 stub、`docs/en/desktop/pets.md:12` 原话，证据链扎实；但吹 Lumina 时用"独家最深"、"别人短期抄不走"这种定性词，没有对标竞品的具体行数/复杂度对比。
2. **"Lumina ≈ N.E.K.O 并列第一"是主场作战**：报告自己也承认 N.E.K.O 在"冷落权重经济、Steam 分发、UGC 生态、记忆工程体量（recent.py 88KB/facts.py 293KB）"上反超 Lumina，但结论仍然给"并列第一"。客观讲**分发和生态上 Lumina 是落后方**，主动管线精细度也是 N.E.K.O 略胜，"并列第一"更像作者希望的排位而非客观排位。
3. **"openclaw 39 万 star 是不同物种"**：这个定性是对的，但报告花了大量篇幅论证"它不是桌宠所以不构成威胁"，**部分动机是在缓解 Lumina 在工具/渠道/cron 生态上被 openclaw 碾压的事实**（报告 3.3 节自己也列了"161 extensions / 20+ IM 频道 / cron 100+ 文件子系统"这些 Lumina 完全没有的东西）。
4. **"双协议 AGPL-3.0 OR Apache-2.0"被当作卖点反复提**：这确实是优点，但报告把它列入"护城河第 3 条"略牵强——双协议是法律选择，不是技术护城河。

### 5.4 报告漏掉的我这次新发现的问题

- **密钥硬编码在 `agents/lumina/agent.json`**（虽然 .gitignore 排除了）。
- **`rechaRunner.ts` / `yakRunner.ts` 是空壳废弃文件**，发布前应删。
- **`verify-p3-delegation.ts/js` / `verify-p3-static.js` / `_unlimit.js` 临时脚本混在主目录**。
- **`GroupChatView.tsx` 273 KB / `ChatPanel.tsx` 128 KB / `SettingsPanel.tsx` 90 KB** 三个渲染进程上帝组件，比 `agentRunner.ts` 还夸张。
- **`docs/_shots/` 10+ 张 PNG 截图（每张 0.5–2.5 MB）被提交进仓库**，仓库体积会膨胀。
- **根目录两个 HTML 竞品报告 + docs/ 下 6 个 HTML**，共 ~500 KB 内部分析材料不应该公开。
- **两套安全模型并存**（sandboxRules 7×8 vs securityGuard 6×10），报告只讲了一半。

---

## 6. Lumina 真实功能矩阵

| 功能 | README 宣称 | 代码实证 | 真实完成度 |
|---|---|---|---|
| Electron 40 + React 19 + TS + Vite 桌面壳 | ✅ | `package.json` 实钉版本 | **production** |
| 三 Agent 团队（Lumina/热茶/Yak） | ✅ 独立人格 | `agents/` 三件套 + `delegationManager.ts` 45KB + 独立 Runner | **production** |
| `delegate_chain` 写码→审查→修复 | ✅ | `team/dynamicWorker.ts` + `adversarialReview.ts` + `teamCollab.ts` 58KB | **production** |
| 5 维情绪（开心/疲劳/专注/焦虑/好奇） | ✅ | `pet/life/emotionCore.ts` 真 5 维 + 启发式加权 | **production** |
| 连续情绪融合（EMA/迟滞/漂移） | ✅ | `pet/emotionFusion.ts` α=0.35 + hysteresis=0.06 | **production** |
| 情绪影响 Live2D 表情 | ✅ | `pet/life/runtime.ts` + `faceRig.ts` | **production** |
| 情绪影响 VRM blendShape | beta | `pet/vrm/vrmRenderer.ts` setEmotionCore 已接 | **beta** |
| SQLite 长期记忆（事实/反思/人格） | ✅ | 6 张表 + WAL + 迁移脚本 | **production** |
| TF-IDF + BM25 混合召回 | ✅ | BM25 真自写；**TF-IDF 未真实现**，向量分支是空接口 | **prototype（BM25 真，TF-IDF 吹）** |
| 证据链 + 置信度评分 | ✅ | `memoryEvidence.ts` 5 维加权 + 7 天半衰期 | **production** |
| 自动精炼（定时清理低质记忆） | ✅ | `memoryRefiner.ts` 13KB + `autoRefineManager.ts` | **beta** |
| 记忆剧场可视化 | ✅ | 有面板（具体完成度未验证） | **beta** |
| Computer Use（截图→VLM→鼠标） | ✅ | `cuCore.ts` 42KB + 5 个配套模块 | **production（Windows）** |
| 屏幕感知（写代码时主动建议） | ✅ | `pet/vision/screenAwareness.ts` dHash 帧差 | **beta** |
| 7 级×8 类沙箱 26 条规则 | ✅ | `sandboxRules.ts` 正好 26 条 | **production** |
| 审批流（危险操作弹窗确认） | ✅ | `approvalService.ts` 15KB + `approvalUI.ts` | **production** |
| 沙箱玻璃房面板 | ✅ | `SandboxPanel.tsx` 9KB | **beta** |
| 团队群聊（Agent 自发聊天） | ✅ | `agentSocialEngine.ts` 32KB + 9 个话题模板 | **production** |
| 早安仪式 | ✅ | `SPONTANEOUS_TOPICS` 早间签到（7–10 点） | **production** |
| Moments 朋友圈 | ✅ | `momentsStore.ts` 3 张 SQLite 表 + 点赞/评论 | **production** |
| 亲密度演化（影响审查语气） | ✅ | `agentRelationships.ts` + `relationshipEvents.ts` | **beta** |
| 4 种人格模式（工作/闲聊/创意） | ✅ | `modeManager.ts` 22KB | **beta** |
| 90+ 内置工具 | ⚠️ 口径混乱 | 实测注册名 ~50–60 个；registry 自注"agent 模式 ~25" | **beta（数字注水）** |
| MCP 协议 | ✅ | `mcpServer.ts` 19KB + `mcp/mcpConfigLoader.ts` | **beta** |
| 7 个内置 Skill + 商店 | ✅ | `electron/skills/` 9 个 SKILL.md + `skillMarket.ts` 38KB | **beta** |
| CLI 9 个子命令 | ✅ | `cli/` 10 个文件（chat/tool/agent/memory/config/skill/cron/doctor） | **production** |
| REST API 10+ 端点 | ✅ | `api/server.ts` 12KB + 10 个 route 文件 + docs/API.md 16 端点 | **production** |
| Plugin SDK | 部分 | `pluginSDK.ts` 12KB 存在，但无独立文档 | **prototype** |
| Live2D 主线 | ✅ | Mao 模型 + 8 表情 + 8 motion + 31KB runtime | **production** |
| VRM beta | ✅ | three.js + three-vrm，已接情绪，未接口型/视线 | **beta** |
| 主动搭话（12 类触发） | ✅ | `proactive/` 8 文件模块化 + `proactiveEngine.ts` 47KB | **production** |
| 梦境日记 | ✅ | `dreamEngine.ts` 20KB，LLM 优先 + 25 条模板兜底 | **beta** |
| Agent 真人秀 | ⚠️ 65% 剧本 | `realityShowEngine.ts` 16KB | **prototype** |
| 副人格觉醒 | 实验默认关 | `persona/subPersona.ts` 8.7KB | **prototype** |
| 跨平台（Win/mac/Linux） | ⚠️ 宣称三平台 | CI 三平台矩阵；但 CU/沙箱规则大量 Windows 路径假设；CHANGELOG 自承"仅 Windows 10+" | **prototype（mac/Linux 未真验证）** |
| Docker 镜像 | 未提 | `Dockerfile` 真可用（xvfb + headless API） | **beta** |
| 自动更新（electron-updater） | ✅ | `autoUpdater.ts` + electron-builder github publisher | **beta** |
| 测试覆盖 | 未承诺 | 80 个测试文件 + coverage gate 70%/55% | **beta（未验证是否真绿）** |

---

## 7. 原创度评分（5 分制，1=跟随主流，5=独家）

| 模块 | 评分 | 理由 |
|---|---|---|
| 情绪连续融合（EMA+迟滞+基线漂移） | **4.5** | 在陪伴桌宠赛道少见；N.E.K.O 是离散状态机，AIRI 无情绪层，openclaw/cc-haha 无 |
| 三 Agent 朋友圈剧场感（不进用户窗） | **4.5** | 别的项目多 Agent 全是任务分工，没有"背着用户生活" |
| 主动管线五件套（gate/退避/话头/反思/内心 OS） | **3.5** | N.E.K.O 有同类管线但 Lumina 加了"挂话头"和"4 点异步反思"，细节原创 |
| 双层情绪统一换算层（5 维/3 维/9 标签互通） | **3.5** | 工程整合原创，理论不新（PAD 情绪模型是 1992 年的） |
| 记忆三层 + 证据评分 | **2.5** | 架构直接借鉴 N.E.K.O，权重公式自己调了 |
| 沙箱规则库 | **2.5** | 分类枚举抄 QwenPaw，26 条正则自己写 |
| BM25 中文混合索引 | **2.0** | 标准 BM25 + 中文单字/短语双重索引，工程实现原创但算法教科书 |
| CU 链路（截图→VLM→键鼠+dHash 验证） | **2.5** | Anthropic Computer Use 范式，dHash 验证是小创新 |
| Live2D 表演 runtime | **3.0** | 基于 Live2D Cubism SDK 二次开发，表情/口型/视线分层是自己写的 |
| SOUL/AGENTS/MEMORY 三件套 | **2.0** | 与 openclaw SOUL 范式同构 |
| Docker headless 模式 | **2.0** | 标准 xvfb + Electron 模式 |

**整体原创度估算：3.0/5.0**。不是全抄，也不是从零发明——是"把 N.E.K.O 的记忆范式 + openclaw 的 SOUL 范式 + QwenPaw 的沙箱分类 + Anthropic 的 CU 范式，用一个'会过日子的三 Agent 桌宠'产品视角重新组装，并且在情绪连续融合和朋友圈剧场感上做了真正自己的增量"。

---

## 8. GitHub 发布 Readiness 清单

### 8.1 已齐全 ✅

- [x] `LICENSE`（AGPL-3.0，34 KB）+ `LICENSE-APACHE`（11 KB）
- [x] `LICENSE.electron.txt` + `THIRD_PARTY_NOTICES.md`
- [x] `README.md`（28 KB，中英双语）
- [x] `CHANGELOG.md`
- [x] `CONTRIBUTING.md`
- [x] `CODE_OF_CONDUCT.md`
- [x] `SECURITY.md`
- [x] `CLA.md`
- [x] `.github/workflows/test.yml`（三平台 CI + coverage gate + release 签名）
- [x] `.github/workflows/deploy-docs.yml`（VitePress 文档部署）
- [x] `docs/ARCHITECTURE.md` / `DEVELOPER.md` / `FAQ.md` / `TROUBLESHOOTING.md` / `API.md`
- [x] `Dockerfile`（headless 模式）
- [x] `setup.bat` / `setup.sh`
- [x] `package.json` 双协议字段正确（`"license": "(AGPL-3.0 OR Apache-2.0)"`）

### 8.2 必须补 ⛔（发布前）

- [ ] **删除含真实 API Key 的 `agents/` 目录**（虽然 .gitignore 排除了，但要跑 `git ls-files agents/` 确认未被历史提交；建议 `git filter-repo` 清历史）
- [ ] **删除废弃空壳**：`electron/rechaRunner.ts`、`electron/yakRunner.ts`、`electron/_unlimit.js`、`electron/verify-p3-delegation.{ts,js}`、`electron/verify-p3-static.js`
- [ ] **删除内部分析材料**：根目录 `Lumina-竞品对比分析-v2-*.md`、`Lumina竞品深度对比分析*.html`、`docs/lumina-*.html`（约 10 个内部报告）、`docs/_ref/attach-v331.bin`、`docs/_shots/` 大截图
- [ ] **补 Issue/PR 模板**：`.github/ISSUE_TEMPLATE/bug_report.md`、`feature_request.md`、`config.yml`、`.github/PULL_REQUEST_TEMPLATE.md`
- [ ] **补 README 截图**（README 第 446–454 行现在全是"*（即将添加截图）*"占位）
- [ ] **统一工具数口径**：README "90+" / CHANGELOG "70+/88+" / registry 注释 "~25" 四处不一致，建议改成"运行时按模式加载 25–60 个工具，另可经 MCP 扩展"
- [ ] **统一平台口径**：CHANGELOG "仅 Windows 10+" vs README "三平台支持" vs Roadmap "v1.3 才支持 mac/linux"，三选一
- [ ] **补 Plugin SDK 文档**（`pluginSDK.ts` 有代码但 docs/ 无独立章节）
- [ ] **补 ROADMAP.md**（Roadmap 现在只在 README 末尾，没有独立文件）
- [ ] **跑一次 `npm run test:coverage`**，确认 70%/55% 阈值真过；不过要么提阈值要么补测试
- [ ] **确认 `.gitignore` 里的 `agents/` 真的从未进过 git 历史**（`git log --all -- agents/`）
- [ ] **清理 `docs/archive/`**（12 个历史修复报告，不应公开）

### 8.3 强烈建议补 💡

- [ ] `FUNDING.yml`（GitHub Sponsors / 爱发电）
- [ ] `CITATION.cff`（学术引用格式）
- [ ] `CODEOWNERS`
- [ ] 把 `GroupChatView.tsx`（273 KB）/ `ChatPanel.tsx`（128 KB）/ `SettingsPanel.tsx`（90 KB）拆成子组件
- [ ] 把 `agentRunner.ts`（157 KB）拆成多个文件
- [ ] 统一两套安全模型（`sandboxRules.ts` vs `securityGuard.ts`），留一个删一个
- [ ] 修正 `driveHardTrigger.ts` 的"冷落方向写反"问题（竞品报告已指出）

---

## 9. 最终判断

**Lumina 是一个"代码量真实、架构有想法、但产品宣传口径比代码能力激进"的 0.1 版本开源桌宠项目。**

- **真东西**：三 Agent 真独立、情绪连续融合真有 EMA+迟滞、BM25 真自己写、26 条沙箱规则真在、CU 链路真通、Moments 真 SQLite、Live2D 真能用。16.8 万行代码不是吹牛。
- **吹的成分**：90+ 工具（实际 50–60）、TF-IDF+BM25 混合（实际只有 BM25）、跨平台（实际 Windows-only）、"独家"（情绪融合和朋友圈剧场感是真独家，但记忆/沙箱/CU 都是跟随范式）。
- **最大风险**：不是竞品，是**自己的工程债**——agentRunner 157KB 上帝类、GroupChatView 273KB 渲染组件、两套安全模型并存、README 与代码四处口径不一致。这些在内部开发时能忍，开源后会被第一个 PR 打脸。
- **发布 readiness ~70%**：法律文件齐、CI 完整、文档站有雏形，但密钥历史清理、Issue 模板、真实截图、口径统一这四件事不做完，贸然公开会出洋相。

> 一句话：**这不是一个 PPT 项目，但它现在的 README 比它的代码还会讲故事。** 建议先把第 8.2 节的 ⛔ 全部补完，再按 v0.1 preview 发布；把工具数、平台、安全模型三个口径和代码对齐，否则第一个 issue 就会是"README 又骗人"。
