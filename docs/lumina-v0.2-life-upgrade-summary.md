# Lumina 生命智能体 v0.2 升级总结（第四阶段）

> 目标：把《生命智能体评估与增强路线看板》的 **P0 / P1 / P2** 全部落地，让 Lumina「更像活的、记得你、能被自由表达、并具备实时语音视觉的骨架」。
> 工程原则（沿用既定约定）：每个能力都是**零依赖 / 依赖可注入的纯 TS 模块** + **vitest 单测** + **最小接线**；需要真实麦克风 / 摄像头 / 在线模型的端到端，留清晰注入适配点并在本文标注边界。
> 验收：`npm run typecheck` ✅　`npm test` → **385 passed / 1 skipped**（本轮新增 **83** 个测试）✅　`npm run build` 三端成功且桌宠资产随构建拷贝 ✅

---

## 1. 本轮一句话总览

| 优先级 | 主题 | 状态 |
| --- | --- | --- |
| **P0** | 像活的、记得你：统一情绪、内驱力、记忆接入大脑、五元音口型、分层动作混合、AI 表演 DSL | ✅ 纯逻辑 + 渲染/大脑接线，端到端可用 |
| **P1** | 实时语音视觉：VAD、流式分句、全双工导演、事件化屏幕感知、摄像头在场隐私状态机 | ✅ 纯逻辑/状态机 + IPC 适配点；真实硬件管线见 §5 边界 |
| **P2** | 自由表达与生态：Live2D 全参数语义 profile、UGC 模型库、唤醒词、视觉情节记忆 | ✅ 模型库闭环可用；唤醒/自动发现留适配点 |

---

## 2. 新增模块地图（16 个纯逻辑模块）

### P0 — 心智与身体

| 模块 | 路径 | 职责 |
| --- | --- | --- |
| emotionCore | `electron/pet/life/emotionCore.ts` | 三套情绪（团队五维 / 前端三维 / 桌宠九 mood）的**权威换算层**；`MOOD_COORDS` 是 valence/arousal 单一事实源，含迟滞反查与混合 |
| drives | `electron/pet/life/drives.ts` | energy / social / curiosity / comfort **内驱力**随时间与互动消长，输出行为倾向 `behaviorUrges` / `dominantUrge` |
| parameterProfile | `electron/pet/live2d/parameterProfile.ts` | 模型无关的**标准语义通道**；内置 Mao 完整映射 `maoProfile()`，并能从任意模型 cdi3 `discoverProfile()` 自动发现参数 |
| faceRig | `electron/pet/life/faceRig.ts` | 情绪 / 视线 / 眨眼 / 呼吸 / 五元音 → 与模型无关的 `StandardPose` |
| lipsync | `electron/pet/life/lipsync.ts` | 文本→五元音时间轴（拉丁元音准确、中文覆盖高频语气词与「喵」、其余降级张嘴、标点停顿）+ RMS 能量包络 |
| animationMixer | `electron/pet/life/animationMixer.ts` | base/emotion/gaze/speech/action **五层加权软混合**、眨眼乘性、TTL 过期、淡入淡出 envelope、变化率限速 |
| performanceDsl | `electron/pet/life/performanceDsl.ts` | LLM 用高层表演指令（表情/视线/手势/头倾/motion/特效）而非裸参数；**全白名单 + 数值 clamp + 非法丢弃** |
| runtime | `electron/pet/life/runtime.ts` | 渲染侧高层引擎 `PetPerformanceEngine`（同构零依赖，esbuild 聚合入口） |
| petMemoryBridge | `electron/pet/petMemoryBridge.ts` | 结构化注入接口复用 `MemoryStore`，产出「你对用户的记忆」prompt 片段，并把看到的情节写回记忆 |

### P1 — 实时语音与视觉

| 模块 | 路径 | 职责 |
| --- | --- | --- |
| audioLevel | `electron/whisper/audioLevel.ts` | `analyzeFrame` 算 RMS / 峰值 / 过零率 + 自适应 `NoiseGate` |
| vad | `electron/whisper/vad.ts` | 起音确认 / 尾点判定 / 前置环形缓冲 / 最短有效语音，输出 start/end 事件 |
| sentenceSplitter | `electron/pet/lifeSpeech/sentenceSplitter.ts` | 中英流式分句（缩写与小数点保护、引号闭合归句尾、逗号长句切分） |
| liveSpeechDirector | `electron/pet/lifeSpeech/liveSpeechDirector.ts` | VAD→STT→LLM 分句→TTS 边生成边播的**全双工状态机**；generation 代际作废迟到 token，AI 说话时用户开口即打断 |
| screenAwareness | `electron/pet/vision/screenAwareness.ts` | dHash 帧差 + 活动窗口场景分类（游戏/视频/代码/文档/社交/发呆/其它）+ 节流决策（首帧/显著变化/场景切换/低频兜底才问 VLM） |
| presence | `electron/pet/vision/presence.ts` | 摄像头在场 / 注视 / 表情的**隐私优先状态机**：默认关、显式授权、强制 localOnly、采样期指示灯、撤销即停 |

### P2 — 自由表达与生态

| 模块 | 路径 | 职责 |
| --- | --- | --- |
| modelLibrary | `electron/pet/modelLibrary.ts` | 已导入模型清单 / 注册 / 切换 / 序列化；内置 Mao 恒定不可删；复用 modelImporter 的名字消毒与路径安全校验 |
| wakeWord | `electron/whisper/wakeWord.ts` | STT partial 文本关键词唤醒门控（冷却 + 聆听会话窗口；本地热词模型留适配点） |

> 视觉情节记忆的**写入**由 `petMemoryBridge.recordObservedEpisode()` 承担，已被屏幕感知 tick 调用。

**构建产物**：`electron/pet/assets/pet-life.js`（esbuild IIFE，全局 `window.LuminaLife`，约 27 KB），随 `copyPetAssets` 自动拷到 `out/main/assets`。
复现命令：`npm run build:pet-life`（已写入 package.json，且 `npm run build` 会先执行它）。

---

## 3. 接线说明（三处）

### 3.1 渲染页 `electron/pet/pet-live2d.html`

- 引入 `pet-life.js`，`boot()` 后初始化 `PetPerformanceEngine`。
- **零回归关键决策**：引擎每帧只接管现有 focus / idle motion / 旧表情逻辑**完全没驱动的「软组织」**（眉 8 个、眼笑 2、五元音 A/I/U/E/O、嘴角 Up/Down/Angry、脸颊、左右肩）；**绝不写** `ParamAngle*` / `ParamBodyAngle*` / `EyeLOpen/ROpen` / `EyeBallX/Y` / `ParamBreath`，眨眼交给模型 motion。头角、眼球、呼吸仍走原链路。
- **五元音口型接真实音频**：`playAudioDataUrl(url, text)` 解码后经 `AnalyserNode` 每帧算 RMS，喂 `engine.setSpeechLevel()`——**元音形状按文本、张度按真实能量、停顿自动闭合**；播放结束 `stopSpeak()`。
- **表演 DSL**：`execIntent` 读取 `it.performance` 调 `lifePerform()`；内置手势桥到现有 `doWave/doNod/.../setSleep/setWake`，参数化手势（耸肩/歪头/难过/生气）落到肩/头/眉，特效映射到 Mao 真实开关参数（heart/heal/aura/sparkle/smoke/ink/rabbit），1.6s 后复位；`ParamExplosionOn` 故意不接。
- **模型库**：设置面板模型下拉动态填充 `pet:models:list`，新增「📥 导入 Live2D 模型」按钮；`boot()` 改为从 `pet:models:current` 取当前模型 URL 加载，失败回退内置 Mao。

### 3.2 桌宠大脑 `electron/pet/intentDispatcher.ts`

- 对话与自主心跳的 system prompt 注入：**长期记忆片段**（`buildPetMemoryContext`）+ **当前情绪**（保持连贯、不无理由突变）+ **内驱力倾向**（自主时）+ **表演 DSL 指南**。
- 用户对话推进社交内驱力；自主心跳按「距上次互动分钟数」推进内驱力。
- 意图**出口统一** `safePerformance()` 白名单清洗，非法 / 越界表演字段直接丢弃，不可信结构到不了渲染层。
- LLM 不可用时，自主行为由**内驱力指导**（困了去睡、想被理就撒娇、好奇就走动、有精力就玩、安心就安静陪伴），仅保留 15% 随机多样性，替代原来的纯随机抽签。

### 3.3 主进程 `electron/pet/petWindow.ts` + 新装配层 `electron/pet/lifeServices.ts`

- **屏幕感知节流**：`pet:perception:tick` 截屏后先 dHash 帧差 + 活动窗口场景判定，**稳定画面 / 未到间隔直接跳过，不再每次都花钱问 VLM**；真正发问并得到反应后，`rememberScreenEpisode()` 把「看到用户在做什么」写回长期记忆。
- `PetPrefs` 新增 `life` 隐私开关：`screenGate`（默认开）、`presence` / `wakeWord` / `fullDuplex`（**默认关**）。
- `lifeServices.ts` 注册 IPC（见 §4），并负责模型库持久化（`userData/pet-model-library.json`）与 UGC 模型导入（复制进 `userData/pet-models`）。

---

## 4. 新增 IPC 一览

| 通道 | 方向 | 作用 |
| --- | --- | --- |
| `pet:models:list / current / select / remove` | invoke | 模型库查询 / 切换 / 删除 |
| `pet:models:import` | invoke | 选 `.model3.json` → 校验 → 安全复制进 userData → 注册 |
| `pet:presence:status / authorize / sample-tick / detection` | invoke | 在场隐私状态机：授权、是否该采样、回喂人脸检测结果 |
| `pet:wake:status / enable / feed` | invoke | 唤醒词开关与 STT 文本门控 |
| `pet:live-speech:event` | invoke | 全双工导演事件注入（user_start / user_utterance / assistant_chunk / assistant_end / sentence_spoken / reset），返回应执行动作与代际号 |

---

## 5. 真实硬件 / 在线模型的边界（诚实标注）

**已经端到端可用（不依赖新硬件/在线服务）**

- 统一情绪软组织微表情、五元音口型（TTS 真实电平）、五层分层混合、表演 DSL（LLM 输出经白名单落地）。
- 记忆与内驱力注入大脑、自主行为内驱力指导、表演字段安全清洗。
- 屏幕感知 **dHash 节流**与**视觉情节记忆写入**（截屏与 VLM 通道沿用现有 `pet:perception:tick`，受隐私模式与 Pet Handling 门控）。
- 模型库注册 / 持久化 / 列表 / 切换，UGC 模型文件安全导入，渲染页动态加载（内置 Mao 失败兜底）。

**状态机 / IPC 已就绪，需接真实管线数据（注入适配点已留好）**

1. **全双工实时语音**：`LiveSpeechDirector` 与 `pet:live-speech:event` 已通，但还需要——
   - 渲染页把**麦克风流**（`getUserMedia` + `AnalyserNode`）接到 `audioLevel` / `vad`（现有 `electron/whisper/recorder.ts` 是文件式 WAV，非流式）；
   - 接入**流式 STT partial** 与 **TTS 逐句播放回调**。现有 Whisper 默认 `Xenova/whisper-tiny.en`，**不支持中文**，需更换（见 §7）。
2. **摄像头在场**：授权 / 采样 / 指示灯状态机与 IPC 已通；`getUserMedia` 采集帧与**本地人脸检测**（在场 / 注视 / 表情）通过 `pet:presence:detection` 回喂即可，模块本身不绑定任何模型，且强制仅本地处理。
3. **唤醒词**：STT 文本门控 IPC 已通，需在连续聆听时把 STT final 文本喂给 `pet:wake:feed`；本地神经网络热词（如 openWakeWord / sherpa-kws）作为未来适配。
4. **UGC 模型全参数自动发现**：`runtime` 已支持 `new PetPerformanceEngine(cdi3)` 自动发现，渲染页当前默认用 `maoProfile()`；后续让渲染页读取新模型 cdi3 传入即可对任意模型做全参数语义驱动。若 `file://` 加载 UGC 模型被 webSecurity 拦截，兜底方案是注册自定义 app protocol（当前未启用）。

---

## 6. 验证结果

- `npm run typecheck`（`tsc --noEmit --strict`）：**通过**。
- `npm test`（vitest 全量）：**385 passed / 1 skipped**，其中本轮新增 83 个测试，覆盖情绪换算、内驱力、面部姿态、五元音、参数 profile、分层混合、表演 DSL、记忆桥、运行时、VAD、流式分句/全双工、屏幕/在场、模型库、唤醒词。
- `npm run build`：main / preload / renderer 三端构建成功，`[copy-pet-assets]` 已把 `pet-life.js` 拷入 `out/main/assets`（src/out 均 27,737 字节，含 `setSpeechLevel` 等符号）。
- 测试中 `better-sqlite3` 在命令行 node（ABI 127）与 Electron（ABI 143）的 `ERR_DLOPEN_FAILED` 为**已知无害**环境差异，相关初始化均有 try/catch 兜底，不影响 Electron 运行与测试结果。
- 提交前已扫描新增文件，**无密钥 / 内网地址泄漏**；本轮分 4 个本地提交（P0 / P1 / P2 / 接线），未 push、未 tag。

---

## 7. 剩余跟进项与待你拍板

**建议的下一步（P3）**
1. 打通「麦克风流 → VAD → 中文流式 STT → LiveSpeechDirector → 流式 TTS」全双工闭环（当前最大的体验增量）。
2. 摄像头采集 + 本地人脸（注视 / 表情）接入 presence，配合设置面板开关 UI（`prefs.life` 字段已就绪，UI 待加）。
3. UGC 模型 cdi3 自动发现传入 runtime；按需注册自定义 protocol 兜底 file:// 加载。
4. 内驱力 / 情绪状态跨会话持久化（目前 drives 为主进程内存单例，重启回基线）。
5. 设置面板补齐 presence / wakeWord / fullDuplex 开关。

**待你决定**
- 中文流式 STT 选型：换 `whisper base/small`、还是上 `sherpa-onnx` / `faster-whisper`（tiny.en 不支持中文）。
- 摄像头 / 屏幕感知默认策略：当前按「默认关、显式授权、仅本地处理」实现，是否维持。
- 本地 LM Studio 的 key 是否轮换。
- 是否 / 何时建立公开仓并 push（当前仓库无 remote，push 需要你本人的 GitHub 凭据，本轮只做本地提交）。
