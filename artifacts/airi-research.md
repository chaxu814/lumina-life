# AIRI 深度调研报告

> 调研对象：[moeru-ai/airi](https://github.com/moeru-ai/airi)
> 抓取时间：**2026-09-21（UTC+8）**
> 数据来源：GitHub 仓库主页 / apps / packages / issues 页面、官方文档 quickstart、第三方趋势与评测站点

---

## 0. 一句话定位

**AIRI 是一个 MIT 协议、自托管、"你拥有的" Neuro-sama 复刻版——一个跑在 Web / macOS / Windows / iOS 上的开源 AI VTuber / 电子生命容器，主打实时语音聊天 + 能自己玩 Minecraft / Factorio 游戏，而不是一个"桌面小助手"。**

---

## 1. 仓库基本面（实时抓取）

| 指标 | 数值 | 来源 |
|---|---|---|
| Stars | **49.3k** | GitHub 仓库页（apps/ 页头部，2026-09-21） |
| Forks | **4.9k** | 同上 |
| Open Issues | **98** | Issues 页 tab |
| Open PRs | **133** | Pull requests tab |
| 总 Commits | **4,454** | 仓库 History |
| 创建时间 | 2024-12 | 第三方趋势站 |
| 主语言 | TypeScript（Vue 系） | GitHub Languages |
| License | **MIT** | 仓库页 / LICENSE |
| Issue 创建 | **已对普通用户关闭**（"Issue creation is restricted"） | Issues 页 |
| 版本阶段 | v0.7 已发布（2025-08），v0.8 alpha（2025-11），Roadmap v0.9（2025-12） | DevLogs |

Star 增长曲线（第三方观测）：
- 2026-03 初 ≈ 29.1k（CSDN 日报）
- 2026-03 中旬一周 +10,249 至 32.2k（Shareuhack 周报，爆发期）
- 2026-07 底 ≈ 45.4k（Trending Reader）
- 2026-09-11 ≈ 49.1k（repo.uno）
- 2026-09-21 ≈ **49.3k**（本次抓取）

结论：**2026 年 3 月是爆发拐点，之后增速放缓，进入"高位冷却期"**（heatdrop 原话 "currently cooling off"）。

---

## 2. 项目定位与 Slogan

- 仓库 headline：*"Self hosted, you-owned Grok Companion, a container of souls of waifu, cyber livings to bring them into our worlds, wishing to achieve Neuro-sama's altitude. Capable of realtime voice chat, Minecraft, Factorio playing."*
- README 正文：*"Re-creating Neuro-sama, a soul container of AI waifu / virtual characters to bring them into our world."*
- 对标对象非常明确：**Neuro-sama**（Twitch 知名 AI VTuber，闭源）。AIRI 的核心叙事是"Neuro-sama 下播后你也能拥有自己的版本"。
- 对标项目（README 自列）：kimjammer/Neuro、z-waif、amica、eliza、Open-LLM-VTuber、Streamer-Sales。

---

## 3. Monorepo 结构

是典型的 **pnpm workspace + Turborepo monorepo**（`pnpm-workspace.yaml` + `turbo.json` + `.prototools` + `flake.nix`）。

### `apps/` 下四个端
| App | 形态 | 说明 |
|---|---|---|
| `stage-web` | Web / PWA | 浏览器版，线上 `airi.moeru.ai` |
| `stage-tamagotchi` | 桌面端（**Electron**） | 2025-10 DevLog 确认从 Tauri 迁移到 Electron；Windows/macOS 安装包 |
| `stage-pocket` | 移动端（**Capacitor / iOS**） | "AIRI Pocket"，手机版 |
| `ui-server-auth` | 服务端 UI | 自托管面板 |
| `component-calling` | 实验性 | 组件调用实验 |

另有独立 `server/`、`services/computer-use-mcp/`、`engines/stage-tamagotchi-godot/`（Godot 游戏引擎实验）、`integrations/`、`plugins/`、`deploy/openpanel/`。

### `packages/` 关键包（按职责分组）
- **角色 / Agent**：`core-agent`、`core-character`
- **舞台渲染**：`stage-ui-live2d`、`stage-ui-mmd`（MMD/3D）、`stage-ui-spine`、`stage-ui-tachie`（立绘）、`stage-ui-three`（Three.js）、`stage-pages`、`stage-layouts`
- **模型驱动**：`model-driver-lipsync`、`model-driver-magic-live2d`、`model-driver-mediapipe`（MediaPipe 面部追踪）、`motion-driver-magic`
- **语音管线**：`pipelines-audio`、`audio`、`stream-kit`
- **推理**：`provider-inference`（基于自研 `xsai`）
- **记忆 / 数据**：`duckdb-wasm`、`drizzle-duckdb-wasm`、`memory-pgvector`
- **插件系统（WIP）**：`plugin-sdk`、`plugin-sdk-tamagotchi`、`plugin-protocol`
- **桌面胶水**：`electron-eventa`、`electron-screen-capture`、`electron-vueuse`
- **输入**：`input-gamepad`、`input-playstation-dualsense-5`（手柄 / PS5 DualSense 支持）
- **服务端**：`server-runtime`、`server-sdk`、`server-shared`

---

## 4. 技术栈细节

| 层 | 选型 |
|---|---|
| 语言 | **TypeScript** 为主；Rust（`candle` 本地推理）；Godot（游戏引擎实验） |
| 前端框架 | **Vue 3**（不是 React；README 明确欢迎 React/Svelte/Solid 贡献者另起子目录） |
| 构建 | Vite + pnpm + Turborepo |
| 桌面端 | **Electron**（2025-10 从 Tauri 迁过来） |
| 移动端 | **Capacitor**（iOS） |
| Web 能力 | WebGPU、WebAudio、Web Workers、WebAssembly、WebSocket |
| 2D 渲染 | **Live2D Cubism**（`stage-ui-live2d`） |
| 3D 渲染 | **VRM**（基于 pixiv/ChatVRM）+ **Three.js** + MMD + Spine |
| 本地推理 | 桌面端默认走 **HuggingFace candle**（Rust），可调用 **NVIDIA CUDA / Apple Metal**；浏览器端 **WebGPU** 推理（WIP） |
| LLM SDK | 自研 **`xsai`**（"像 Vercel AI SDK 但更小"） |
| 数据库 | **DuckDB WASM** / **pglite**（浏览器内）/ **pgvector**（服务端记忆） |
| ORM | Drizzle ORM |
| 样式 | UnoCSS |
| 国际化 | Crowdin 社区翻译（中/日/俄/越/法/韩） |
| Nix | 提供 flake.nix 一键跑 `nix run github:moeru-ai/airi` |

---

## 5. 核心功能矩阵

| 能力 | AIRI 是否支持 | 备注 |
|---|---|---|
| 桌宠 / 桌面陪伴 | ✅ | stage-tamagotchi（电子鸡命名） |
| Live2D | ✅ | Cubism，自动眨眼 / 注视 / 眼球微动 |
| VRM / 3D | ✅ | ChatVRM 路线 + Three.js + MMD |
| 立绘 / Spine | ✅ | `stage-ui-tachie` / `stage-ui-spine` |
| LLM Provider | ✅ **30+** | OpenAI / Anthropic / Azure / Bedrock-ish / DeepSeek / Qwen / Gemini / xAI / Grok / Groq / Mistral / DeepSeek / Moonshot / Kimi / Zhipu / SiliconFlow / Stepfun / Baichuan / Minimax / ModelScope / 腾讯混元 / 火山引擎（PR welcome）/ 小米 MiMo / OpenRouter / AIHubMix / 302.AI / vLLM / SGLang / Ollama / Cloudflare Workers AI / Together / Fireworks / Novita / Player2 |
| 本地 LLM | ✅ | Ollama + 桌面 candle（CUDA/Metal） |
| 多 Agent | ⚠️ 部分 | `core-agent` 存在，但**没有像 Lumina 那样的多人格组队**叙事；更偏"一个角色 + 工具" |
| Memory | ⚠️ WIP | DuckDB WASM / pglite 已可用；长期反思记忆 "**Memory Alaya**" 明确标 WIP |
| Skills / Plugins / MCP | ⚠️ WIP | Plugin system 是 open proposal #255（2025-07 开），plugin-sdk 包已在；独立子项目 **MCP Launcher**（"像 Ollama 管理模型一样管 MCP server"） |
| STT（语音输入） | ✅ | 客户端侧 + 浏览器音频输入 + Discord 音频输入；自研 `unspeech`（ASR/TTS 统一代理） |
| TTS（语音输出） | ✅ **多 provider** | ElevenLabs / Azure Speech / OpenAI 兼容 / 阿里云百炼 / 本地 **Kokoro TTS** |
| VAD / 说话检测 | ✅ | 客户端 |
| Computer Use | ✅ | 独立目录 `services/computer-use-mcp/` + `electron-screen-capture` |
| 主动交互 | ⚠️ 弱 | 主要是"她在那等你聊天 / 玩游戏"，没有 Lumina 那种"她会主动察觉你发呆来关心你"的设计 |
| 游戏能力 | ✅ **主打** | Minecraft（可玩）、Factorio（PoC + demo）、Kerbal Space Program（announce TBD）、Helldivers 2（WIP co-play）、Dome Keeper（数据收集 + 训练管线） |
| IM 接入 | ✅ | Telegram、Discord（含语音频道） |
| 面部追踪 / 动作捕捉 | ✅ | MediaPipe 包 |
| 手柄输入 | ✅ | DualSense / Gamepad |
| PWA / 离线 | ✅ | stage-web 已是 PWA |

---

## 6. Issue / Discussion 氛围

Issues 页只暴露了少量 pinned / 高讨论帖：

- **#840 Roadmap v0.9**（2025-12-29，nekomeowww 作者本人）
- **#255 proposal: Plugin system & Plugin API**（2025-07-02，作者本人，9 条讨论，**挂了一年多仍在 proposal 阶段**——说明插件系统是长期债务）
- **#2117 "Before opening an issue: please search first"**（2026-07-27，普通用户抱怨 issue 重复）

关键信号：
- **Issue 创建已对普通用户关闭**（"Issue creation is restricted"）——社区大到必须限流，典型的"太火、维护者扛不住"。
- 第三方评测（heatdrop, 2026-07-30）总结吐槽点：
  1. README "下载按钮很长，架构说明很短"——LLM/语音/游戏客户端如何编排**没讲清楚**。
  2. 多个 DevLog 日期混乱，release 状态难解析。
  3. **更像一个有热情的粉丝项目，而不是一个平台**——"如果你要 production 级、文档清晰的 agent 框架，这里还不是"。
  4. 本地推理吃 GPU/CUDA/Metal 资源重，多模态管线复杂，环境差异容易崩。
- 官方 quickstart 文档（mintlify）专门列了 troubleshooting：**慢响应**、**桌面 app 打不开**（macOS Gatekeeper / Windows SmartScreen / Linux AppImage chmod）——说明普通用户踩坑不少。

---

## 7. 安装门槛

**普通用户路径（5 分钟内可跑）：**
- Windows：`winget install MoeruAI.AIRI` 或 `scoop install airi/airi`
- macOS：`brew install --cask airi`
- 浏览器：直接打开 `airi.moeru.ai`（PWA）

**开发者路径：**
```
git clone https://github.com/moeru-ai/airi
pnpm i
pnpm dev              # stage-web
pnpm dev:tamagotchi   # 桌面端
pnpm dev:pocket:ios   # iOS
```

**门槛判断：**
- 普通用户：**桌面安装包体验合格**，但要自己配 LLM API key、TTS provider key，文档说"需要模型/语音 provider 密钥"。
- 开发者：**monorepo 巨大**（50+ packages），pnpm + turbo + Rust candle + Nix 可选，对新人不友好。
- 不是"双击即用"——**仍需折腾 API key 和模型选择**，quickstart 里专门写了"慢响应请换 GPT-3.5 / Haiku"。

---

## 8. 目标用户

从 README 语气、招聘字段（Live2D modeller、VRM modeller、CV、RL、ASR、TTS、ONNX、Transformers.js、vLLM、WebGPU、Three.js、WebXR）、issue 氛围判断：

- **核心受众：二次元 / VTuber 文化圈的极客与开发者**——不是小白。
- **次要受众：想自己跑 Neuro-sama 平替的主播 / 内容创作者**（游戏能力是核心卖点）。
- **不是给"想要一个桌面小助手帮我干活"的普通用户**——那是 Lumina 的叙事。

---

## 9. 商业化 / 开源姿态

- **License：MIT**（极度宽松，无 copyleft）。
- 作者明确声明：**没有官方加密货币 / 代币**（README Warning 框，说明被诈骗仿冒过）。
- 收入来源：**OpenCollective / Patreon / Ko-fi** 众筹，无付费版、无 SaaS 闭源组件。
- 社区：官方 **Discord** 为主；Crowdin 翻译社区；组织级仓库 `@proj-airi` 把 RAG、memory、Live2D utilities、icons 等子项目拆出去。
- 衍生子项目（17+）：`unspeech`（ASR/TTS 代理）、`xsai-transformers`、`WebAI: Realtime Voice Chat`、`AIRI Factorio`、`autorio`（Factorio 自动化）、`Velin`（Vue SFC 写 prompt）、`demodel`（模型拉取加速）、`inventory`（模型目录）、`MCP Launcher`、`SAD`（浏览器跑 LLM 笔记）。

---

## 10. 明显短板 / 争议

1. **架构叙事不清**：第三方明确吐槽"下载按钮长，架构图短"，LLM/语音/游戏客户端的编排机制没文档化。
2. **插件系统 WIP 超过一年**：#255 proposal 从 2025-07 挂到现在，plugin-sdk 虽在但 API 未稳定。
3. **长期记忆未完成**：Memory Alaya 仍 WIP，当前只是 DuckDB WASM/pglite 持久化，没有反思 / 人格连续性。
4. **本地推理重**：桌面端吃 CUDA/Metal，浏览器 WebGPU 推理未完成；quickstart 要用户自己换小模型。
5. **Issue 关闭注册**：98 open issues + 133 open PR，维护压力大，普通用户只能去 Discord。
6. **早期阶段**：README 自己写 "We are still in the early stage of development"，v0.8 alpha，v0.9 roadmap 刚开。
7. **游戏能力演示性 > 实用性**：Minecraft 可玩、Factorio 是 PoC、KSP/Helldivers 2 都是 WIP/announce TBD。
8. **"粉丝项目 vs 平台"**：第三方定性——"passionate fan project, not a platform"，缺清晰的对外 agent API（assay.tools 指出要接 agent 得 reverse-engineer 内部 endpoint）。
9. **桌面端从 Tauri 迁到 Electron**（2025-10）——说明性能 / 工程权衡上吃过亏，Electron 包体和内存占用会是老问题。

---

## 11. 相对 Lumina 的核心差异点（3-5 条）

> Lumina 定位（据其 README）：中文优先、三人格组队（Lumina/热茶/Yak）、情绪系统 5D、90+ Tools/Skills、Computer Use、主动察觉用户状态、后台朋友圈、AGPL-3.0/Apache-2.0 双协议的桌面 Electron 应用。

### 差异 1：**架构哲学——"灵魂容器" vs "人格小队"**
AIRI 是 **"一个 waifu 的灵魂容器"**：单一角色 + 30+ LLM provider + 2D/3D 多模型渲染 + 游戏引擎，核心是"把 Neuro-sama 这个角色复刻出来给你"。Lumina 是 **"三个 AI 住在你电脑里的协作小队"**：Lumina 对外、热茶写码、Yak 调度，主打多人格分工和后台群聊。一个是"养一只电子宠物"，一个是"雇一个小团队"。

### 差异 2：**交互范式——"一起玩游戏" vs "主动照顾你"**
AIRI 的杀手锏是 **AI 自己玩 Minecraft / Factorio / Helldivers**，VTuber 式"看她直播/陪她玩"，被动陪伴。Lumina 的杀手锏是 **她察觉你发呆主动来关心你 + 真的帮你操作电脑**（截图→理解→动鼠标），是"工作伙伴 + 情绪陪伴"。一个是娱乐向 streamer，一个是 productivity 向 companion。

### 差异 3：**技术栈与平台野心——"全端 Web 原生 monorepo" vs "单桌面深度集成"**
AIRI 是 **50+ 包的 pnpm monorepo**，Vue 3 + Vite + Electron + Capacitor(iOS) + PWA(Web) + Godot 游戏引擎，跨 4 端，自研 xsai LLM SDK、自研 unspeech ASR/TTS 代理、MCP Launcher——**在造基础设施**。Lumina 是 **单个 Electron 应用**（electron.vite）+ 本地 stt-server + 自研 skills/memory/quests 体系，**在做一个产品**。AIRI 更像"AI VTuber 界的 Linux 发行版"，Lumina 更像"一个有性格的 Alfred"。

### 差异 4：**目标用户与语言——"全球极客二次元" vs "中文陪伴向"**
AIRI 英文优先，招聘字段全是 CV/RL/WebGPU/vLLM，社区在 Discord + Crowdin 6 语言，**面向全球开发者和 VTuber 主播**。Lumina 中文优先、slogan 中英双语、情绪系统 + 朋友圈 + 毒舌队友这种设计非常贴中文互联网陪伴向审美，**面向中文独立开发者 / 桌面用户**。

### 差异 5：**开源姿态与商业化——"MIT 基础设施众筹" vs "AGPL/Apache 双协议产品"**
AIRI 用 **MIT** 把 monorepo 全开放，靠 Patreon/OpenCollective 众筹，明确不做代币，鼓励 fork 出子项目（@proj-airi 组织 17+ 衍生）。Lumina 用 **AGPL-3.0 OR Apache-2.0** 双协议——AGPL 是有 copyleft 的，说明作者**不希望被闭源 SaaS 白嫖**，产品化意图更强。一个是"把种子撒出去"，一个是"把房子盖好但保留产权"。

---

## 12. 给 Lumina 的可借鉴点

1. **LLM provider 列表**：AIRI 列了 30+，Lumina 可以对照补全（特别是 vLLM/SGLang/Ollama/CF Workers AI 这类自托管 endpoint）。
2. **TTS 多 provider**：ElevenLabs/Azure/OpenAI 兼容/阿里/Kokoro 本地，Lumina 的 stt-server 路线可以参考。
3. **MCP Launcher 思路**："像 Ollama 管模型一样管 MCP server"——Lumina 已有 skills 目录，可以借鉴做一个统一 MCP/skill 注册中心。
4. **插件系统教训**：AIRI 的 #255 proposal 挂了一年多说明插件 API 一旦开放就要冻结，Lumina 早期定 plugin-protocol 时要慎重。
5. **桌面端别再走 Tauri→Electron 回头路**：AIRI 已经踩过坑，Lumina 直接 Electron 是对的。

---

## 来源

- https://github.com/moeru-ai/airi （仓库主页，2026-09-21 抓取）
- https://github.com/moeru-ai/airi/tree/main/apps
- https://github.com/moeru-ai/airi/tree/main/packages
- https://github.com/moeru-ai/airi/issues
- https://moeru-ai-airi.mintlify.app/quickstart
- https://heatdrop.ai/repo/moeru-ai/airi （2026-07-30）
- https://www.questie.ai/open-source-ai-companion （2026-08-25）
- https://www.repo.uno/o/moeru-ai/ （2026-09-11）
- https://blog.csdn.net/xiaoquqi/article/details/158768085 （2026-04-07）
- https://www.shareuhack.com/en/posts/github-trending-weekly-2026-03-11
- https://refft.com/en/trending-2026-07-30-daily.html
