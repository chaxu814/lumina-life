# Project AIRI 技术档案

> 调研时间：2026-09-18 ｜ 调研方式：`git clone --depth 1` 浅克隆源码 + GitHub REST API
> 仓库：https://github.com/moeru-ai/airi ｜ 版本：`0.12.0-beta.5`（2026-08-29 发布）
> 所有结论均标注源码路径或 API 证据；README 宣传与代码实际状态不一致处已单独指出。

---

## 1. 项目定位与产品形态（代码视角）

**自我定位**（`README.md:17`）：*"Re-creating Neuro-sama, a soul container of AI waifu / virtual characters"*，即"自托管的、你自己拥有的 Grok Companion"。GitHub 仓库描述（api.github.com 实测）：*"Self hosted, you-owned Grok Companion … wishing to achieve Neuro-sama's altitude. Capable of realtime voice chat, Minecraft, Factorio playing."*

**从代码看，它不是"一个 AI 老婆桌宠"，而是一个"虚拟角色运行时平台"**：

- **三端同一套渲染/对话内核**：浏览器（`apps/stage-web`）、Electron 桌面（`apps/stage-tamagotchi`）、Capacitor 移动（`apps/stage-pocket`）共享 `packages/stage-ui*`、`packages/core-agent`、`packages/pipelines-audio`。
- **桌面端是多窗口应用**，不是单窗口桌宠。`apps/stage-tamagotchi/src/main/windows/` 下有 15+ 个独立窗口：`chat / dashboard / settings / desktop-overlay / devtools / editor / inlay / onboarding / spotlight / widgets / beat-sync / caption / notice / about / main`。
- **带一套托管后端**：`server/apps/api`（Hono + Drizzle + PostgreSQL + Redis + OpenTelemetry + Langfuse）和 `server/apps/auth`（better-auth），用于账号、TTS 计费（最新 commit `0040675 feat(server): group TTS billing history by chat round`）、多人通道。
- **正在孵化第四个渲染端**：`engines/stage-tamagotchi-godot/` 是一个真正的 Godot 4 + C# 工程（`project.godot` / `*.csproj` / `*.slnx`），带 VRM addon 和 MToon shader，目标是替代 Electron 拿到原生性能。

**一句话定位**：一个以 Web 技术为核心、正在向原生引擎迁移的"AI 虚拟角色操作系统"——角色只是它的外壳，真正的产品是 agent 运行时 + 多端渲染 + 游戏/桌面/IM 连接器。

---

## 2. 技术栈与架构

### 2.1 工程底座

| 项 | 实际值（证据：根 `package.json` / `pnpm-workspace.yaml`） |
|---|---|
| 包管理器 | `pnpm@11.24.0`，`catalogMode: prefer`，集中 catalog 管理全部依赖版本 |
| 构建编排 | Turborepo 2.x（`turbo.json`） |
| 语言 | TypeScript 6.0，`"type": "module"` 全 ESM |
| 前端框架 | Vue 3.5 + Vite 8 + Vue Router 5（unplugin-vue-router）+ Pinia 4 + UnoCSS 66 |
| UI | Reka UI（shadcn-vue 无底层）+ reka-ui + 自家 `@proj-airi/ui` |
| 3D/2D | three.js 0.185 + TresJS 5（Vue 绑定）；PIXI 6（Live2D）；Spine；Rive |
| 桌面 | Electron 43 + electron-vite 5 + electron-builder 26 |
| 移动 | Capacitor 8（iOS/Android） |
| 新引擎 | Godot 4（C#，`engines/stage-tamagotchi-godot`） |
| 服务端 | Hono 4.13 + h3 + srvx + crossws（WebSocket）+ Drizzle ORM 0.45 + PostgreSQL + Redis + better-auth + OpenTelemetry |
| 浏览器推理 | `@huggingface/transformers` 3.8.1 + `onnxruntime-web` 1.27 + `kokoro-js` 1.2 |
| LLM 抽象层 | **xsai**（自研，`@xsai/*` 0.5.0，github.com/moeru-ai/xsai，657 stars） |
| 代码质量 | Vitest 4（含 Playwright 浏览器测试）+ histoire（Storybook 替代）+ antfu/eslint-config + oxlint + knip + cspell + publint |

### 2.2 Monorepo 目录职责

| 目录 | 作用 |
|---|---|
| `apps/stage-web` | 浏览器版（PWA，airi.moeru.ai），纯前端，直连 xsai + WebGPU 音频 |
| `apps/stage-tamagotchi` | Electron 桌面版，多窗口，本地起 `server-runtime` 通道 |
| `apps/stage-pocket` | Capacitor 移动版（iOS/Android），experimental |
| `apps/component-calling` | 实时音频组件（Realtime API 样式） |
| `apps/ui-server-auth` | 托管账号登录 UI |
| `packages/core-agent` | **Agent 编排核心**：`agent.ts`、`chat-orchestrator-runtime.ts`、`builtin-tools.ts`、`reaction.ts`、`observer.ts`、`compaction.ts`（上下文压缩）、`context-registry.ts` |
| `packages/core-character` | 角色流水线：文本分段、情绪、延迟、可选 TTS（依赖 `clustr` 聚类） |
| `packages/pipelines-audio` | 音频流水线：采集 → VAD → 编码 → 流式 |
| `packages/stage-ui-three` | VRM 3D 场景（`@pixiv/three-vrm` + TresJS） |
| `packages/stage-ui-live2d` | Live2D 场景（`pixi-live2d-display`） |
| `packages/stage-ui-spine / -mmd / -tachie` | Spine 2D / MMD / 立绘静态图渲染器 |
| `packages/model-driver-lipsync / -magic-live2d / -mediapipe` | 唇形同步、Live2D 动捕、MediaPipe 动捕（实验） |
| `packages/motion-driver-magic` | MAGIC（Markovian Animation Generator）动作生成 |
| `packages/server-runtime` | 桌面端内嵌的 WebSocket 服务运行时（h3 + crossws） |
| `packages/server-sdk / -shared` | 连到 server-runtime / 托管后端的客户端 SDK |
| `packages/plugin-sdk / -protocol / -sdk-tamagotchi` | 插件协议与 SDK（manifest + permissions + extension-sessions） |
| `packages/memory-pgvector` | 记忆包（**当前是空壳，见 §3.5**） |
| `integrations/minecraft` | Minecraft bot（Mineflayer，废弃迁移中） |
| `integrations/discord-bot / telegram-bot / satori-bot / twitter-services` | IM/社交平台接入 |
| `services/computer-use-mcp` | 桌面自动化 MCP server（见 §6） |
| `plugins/` | 5 个官方插件：B站直播弹幕、Claude Code、国际象棋、Home Assistant、浏览器扩展 |
| `engines/stage-tamagotchi-godot` | Godot 原生渲染引擎（新方向） |
| `server/apps/api / auth` | 托管后端（API + 认证） |
| `docs/` | VitePress 文档站（多语言 Crowdin） |

### 2.3 架构图（README `:400` 的 mermaid + 代码验证）

```
stage-web / stage-tamagotchi / stage-pocket
        │  共享 stage-ui / core-agent / pipelines-audio / server-sdk
        ▼
   server-runtime（Electron 内嵌，h3+crossws WebSocket）
        │
   ┌────┴────┬──────────┬───────────┐
   ▼         ▼          ▼           ▼
discord-bot minecraft  telegram   plugins（isolated-vm 沙箱）
                                        │
                                        ▼
                              computer-use-mcp（CDP/PTY/AX tree/SSH）
```

托管侧（可选）：Caddy → api-server + auth-server → PostgreSQL / Redis。

---

## 3. 各核心系统实现状态评级

> 评级标准：✅ 成熟（有完整实现 + 测试 + 实际使用）｜⚠️ 部分实现（能跑但有明显缺口/过渡/停滞）｜❌ 仅声明（README 勾选但仓库无实质代码）

### 3.1 实时语音 — ✅ 成熟

- `packages/pipelines-audio`：采集 → VAD（`@ricky0123/vad-web`）→ 编码 → 流式，有 Web Worker 隔离（`packages/stage-ui/src/workers/vad/vad.ts`）。
- STT：`@xsai/generate-transcription` + `@xsai/stream-transcription` + 本地 Whisper（`packages/stage-ui/src/libs/inference/adapters/whisper.ts`，WebGPU，~800MB）。
- TTS 多提供商：ElevenLabs / Azure / OpenAI 兼容 / 阿里云百炼 / 本地 Kokoro（`kokoro-local.vue` 设置项）；统一由 `unspeech`（独立项目，LiteLLM 风格的 ASR/TTS 代理）收口。
- 唇形同步：`packages/stage-ui-three/src/composables/vrm/lip-sync.ts` + `wlipsync` 库 + `packages/model-driver-lipsync`。
- 证据：`README.md:247-253` 全部勾选；`pnpm-workspace.yaml:327` `kokoro-js`、`:191` `@ricky0123/vad-web`、`:240-249` `@xsai-apple-speech/*`（macOS 原生语音转写）。

### 3.2 VRM — ✅ 成熟

- 基于 `@pixiv/three-vrm` 3.5 + `@tresjs/core` 5.8。
- 自动眨眼 / 视线追踪 / 空闲眼动：`packages/stage-ui-three/src/composables/vrm/utils/eye-motions.ts` 用**真实眼跳（saccade）概率分布**生成随机注视间隔（7.5% 概率在 800ms 内眼跳，其余指数化拉长），不是固定定时器。
- 视线追踪：`composables/eye-tracking.ts`（有 `eye-tracking.test.ts`）。
- VRM 动画：`composables/vrm/animation.ts`，自带 `idle_loop.vrma` 动画。
- 表情 / 交互 / IBL 环境光 / HDRI 天空盒 / 描边 outline 全套。
- 实例缓存：`components/Model/vrm-instance-cache.ts`（避免重复加载）。
- 证据：`packages/stage-ui-three/src/composables/vrm/*.test.ts` 多个测试文件。

### 3.3 Live2D — ✅ 成熟

- 基于 `pixi-live2d-display` 0.4（有 patch：`patches/pixi-live2d-display.patch`）+ PIXI 6。
- `packages/stage-ui-live2d/src/composables/live2d/`：expression-controller、eye-tracking、motion-manager、motion-control-spring（弹簧物理）、beat-sync（音乐节奏同步）。
- 模型加载：ZIP 加载器 + 校验器 + OPFS 持久化（`live2d-zip-loader.ts` / `live2d-validator.ts` / `live2d-opfs-registration.ts`）。
- 证据：`packages/stage-ui-live2d/src/**/*.test.ts` 覆盖表情、眼动、动作、弹簧。

### 3.4 游戏 AI — ⚠️ 过渡/分裂（详见 §4）

- Minecraft：⚠️ 部分实现（Mineflayer bot 完整但官方宣布废弃迁移到 Fabric mod）。
- Factorio：⚠️ 独立仓库、停滞（主仓库无代码，CV+LLM 路线，7 个月未更新）。
- KSP：⚠️ 仅独立实验仓库（`@proj-airi/game-playing-ai-kerbal-space-program`）。
- Helldivers 2：❌ 仅 README 勾选 WIP，主仓库无代码。
- 额外：国际象棋插件 ✅（`plugins/airi-plugin-game-chess` + `stockfish` 18 依赖）。

### 3.5 记忆系统 — ⚠️ 名不副实

- `packages/memory-pgvector/src/index.ts` 实测**只有 25 行**，只是启动了一个 `server-sdk` client 并 `runUntilSignal()`，**没有任何记忆逻辑、没有 schema、没有 embedding 写入**——是个空壳 stub。
- `packages/drizzle-duckdb-wasm` 和 `packages/duckdb-wasm` 主仓库里**只剩 README.md**，代码已迁出到 `@proj-airi/duckdb-wasm` 组织仓库（README `:387-388` 也指向那里）。
- 真正在跑的"记忆"只有 `core-character` 里的 `clustr` 聚类（用于把对话片段聚簇）和 `core-agent` 里的 `compaction.ts`（上下文压缩，不是长期记忆）。
- README 自己承认：`Memory Alaya (WIP)` 未勾选（`README.md:243-245`）。
- **结论**：浏览器纯数据库（DuckDB WASM / pglite）基础设施已就绪并开源，但"AI 角色长期记忆/人格连续性"这一层还没做出来。

### 3.6 多平台 — ✅ 成熟（桌面/浏览器），⚠️ 移动实验

- 桌面：Electron 43，15+ 窗口，tray、bootkit、i18n 全套。
- 浏览器：PWA（`vite-plugin-pwa`），airi.moeru.ai 可直接用。
- 移动：Capacitor 8，README 标注 experimental。
- 分发：`winget install MoeruAI.AIRI`、`scoop bucket add airi`、`brew install --cask airi`、`nix run github:moeru-ai/airi`（`README.md:139-298`）。
- 证据：根 `package.json` scripts 有 `dev:tamagotchi / dev:web / dev:pocket:ios / dev:pocket:android`。

### 3.7 WebGPU 本地推理 — ⚠️ 只有音频，没有 LLM

- `packages/stage-shared/src/webgpu/detect.ts`：集中式 WebGPU 能力检测，封装 `gpuu` 库，探测 fp16 支持、估算 VRAM（`maxBufferSize * 4` 启发式，支持用户手动覆盖）。
- `packages/stage-ui/src/libs/inference/coordinator.ts`：**GPU 资源协调器**——按模型维护 VRAM 预算（Kokoro fp32 330MB / fp16 165MB / q8 82MB / q4 41MB；Whisper large-v3-turbo 800MB；MODNet 背景移除 25MB），全局加载队列保证一次只加载一个模型，内存压力事件回调。
- 实际跑的本地模型只有三类：
  1. **Kokoro TTS**（`workers/kokoro/worker.ts`）
  2. **Whisper STT**（`adapters/whisper.ts`）
  3. **MODNet 背景移除**（`workers/background-removal/worker.ts`）
  4. embedding：`@xsai-transformers/embed`
- **没有浏览器内 LLM 文本推理**。README 自己勾选 `[ ] Pure in-browser local (WebGPU) inference`（`README.md:246`）。桌面版才通过 HuggingFace candle（Rust，CUDA/Metal）跑本地大模型（`README.md:202`）。

### 3.8 插件系统 — ✅ 已可用

- `packages/plugin-sdk/` 是一套**类浏览器扩展模型**的插件框架：`manifest.ts`（清单）、`permissions.ts`（权限）、`resources.ts`（资源）、`extension-sessions.ts`（扩展会话）、`kits.ts` / `kit-api-bindings.ts`（API 绑定）、`fs.ts`、`dependencies.ts`、`local.ts` / `remote.ts`（本地/远程插件）、`core.ts`。
- 沙箱：`isolated-vm` 7（V8 隔离，见根 catalog）。
- 通信：`packages/plugin-protocol` 定义事件 + WebSocket 类型，基于 `@moeru/eventa`。
- 5 个官方插件（`plugins/`）：
  - `airi-plugin-bilibili-laplace`：B站直播弹幕经 LAPLACE Event Bridge 桥到 AIRI。
  - `airi-plugin-claude-code`：把 `@anthropic-ai/claude-code` CLI 接入为 AIRI 插件。
  - `airi-plugin-game-chess`：棋盘游戏小部件（stockfish 18）。
  - `airi-plugin-homeassistant`：Home Assistant 智能家居。
  - `airi-plugin-web-extension`：WXT 浏览器扩展（popup/background/content script）。

---

## 4. 游戏 AI 技术路线深度分析

### 4.1 Minecraft：Mineflayer bot + 四层认知架构（过渡方案）

**技术路线：不是 RCON，不是纯视觉，是 JS Bot API + LLM agent + 规则引擎。**

证据（`integrations/minecraft/package.json`）：依赖 `mineflayer` 4.37 全家桶——`mineflayer-pathfinder`（寻路）、`mineflayer-pvp`（战斗）、`mineflayer-auto-eat`、`mineflayer-armor-manager`、`mineflayer-collectblock`、`mineflayer-tool`，加上 `prismarine-*`（block/entity/item/recipe/viewer/windows）和 `minecraft-data`。这是直接以 JS 机器人身份登录 Minecraft 服务器，读游戏数据包、直接控制 bot。

**四层认知架构**（`integrations/minecraft/README.md` 自述 + `src/cognitive/` 目录验证）：

| 层 | 目录 | 机制 |
|---|---|---|
| A. Perception 感知 | `cognitive/perception/` | Mineflayer 事件 → `events/definitions/*` 规范化 → EventRegistry 发 `raw:*` 事件 → `rules/engine.ts` 跑 **YAML 规则**（`rules/danger/damage.yaml`、`rules/danger/low-health.yaml`、`rules/attention/movement.yaml`、`rules/attention/punch.yaml`、`rules/social/teabag.yaml`）→ 派生 `signal:*` 事件 |
| B. Reflex 反射（潜意识） | `cognitive/reflex/` | 有限状态机（FSM），快速本能反应，**可以抑制意识层** |
| C. Conscious 意识（推理） | `cognitive/conscious/` | `brain.ts`（**2239 行**）事件队列编排 + LLM 回合生命周期；`llm-agent.ts`、`llm-logic.ts`、`context-view.ts`、`history-query.ts`、`patterns/runtime.ts`（模式库） |
| D. Action 执行 | `cognitive/action/` | `task-executor.ts` + `action-registry.ts` + `llm-actions.ts` |

**最具特色的设计：JS Planner**（`cognitive/conscious/js-planner.ts`）——LLM 不输出固定 JSON action，而是**直接生成 JavaScript 代码**，在 `isolated-vm` 沙箱里执行。沙箱暴露一个 Query DSL（链式 `whereIncludes()` 查询 bot 周围的实体/物品），有动作预算（`maxActionsPerTurn`）、桥接调用上限（`maxBridgeCalls`）、内存限制（`memoryLimitMb`）、超时（`timeoutMs`）。这是"代码即动作"的 agent 模式，比 function calling 灵活得多。

**成熟度警告（关键）**：`integrations/minecraft/README.md` 顶部明确写：

> *"This service is on a deprecation path. The current Mineflayer-based bot is expected to be replaced by a **Fabric mod based runtime**, which will become the primary Minecraft integration surface going forward."*

即：当前这套漂亮的认知架构是**过渡实现**，未来要换成 Fabric mod（直接注入 Minecraft 客户端进程）。安全警告也很严厉：*"Do not connect this bot to public servers you do not trust."*

### 4.2 Factorio：YOLO 视觉 + LLM，独立仓库，已停滞

- **主仓库里没有 Factorio 代码**（全仓 `Get-ChildItem -Filter *factorio*` 无结果）。
- 代码在独立仓库 `github.com/moeru-ai/airi-factorio`（GitHub API 实测）：
  - 描述：*"🎮🏭 AI plays the game Factorio with CV & LLM combined. Powered by YOLO / LLM."*
  - **技术路线：计算机视觉（YOLO 目标检测）+ LLM 决策，纯视觉/屏幕感知，不用 RCON 控制游戏**。
  - 100 stars，语言 TypeScript，**最后 push 2026-02-25，至调研日已近 7 个月无更新**。
  - 生态子包：`autorio`（Factorio 自动化库）、`tstl-plugin-reload-factorio-mod`（mod 热重载）。
- README `:238` 勾选 `[x] Play Factorio (WIP, but PoC and demo available)`——即 PoC 阶段。
- 另有 `Factorio RCON API` 第三方 REST 封装（`nekomeowww/factorio-rcon-api`）作为底层辅助，但主路线是视觉。

### 4.3 其他游戏

- **KSP**（Kerbal Space Program）：README `:239` 勾选 `[x]`，但代码在独立仓库 `@proj-airi/game-playing-ai-kerbal-space-program`，主仓无代码。
- **Helldivers 2**：README `:240` 勾选 `[ ]`（未完成），主仓无代码。
- **Dome Keeper / Balatro / 2D playground**：`@proj-airi` 组织下有 `game-playing-ai-dome-keeper`、`game-playing-ai-balatro`、`game-playing-ai-playground-2d` 独立实验仓库（对应 README DevLog `2026.02.16 Dome Keeper data collection and training pipeline`）。
- **国际象棋**：主仓 `plugins/airi-plugin-game-chess` + `stockfish` 18，✅ 可用。

---

## 5. 实际支持的 LLM 提供商

**统一由自研 xsai 库接入**（`packages/core-agent/package.json` 依赖 `@xsai/generate-text / stream-text / generate-speech / generate-transcription / tool / model / shared-chat` + `@xsai-ext/providers` + `@xsai-ext/responses`）。

README `:345-378` 实测勾选：

**已支持（29 家）**：AIHubMix、OpenRouter、vLLM、SGLang、Ollama、302.AI、OpenAI（含 Azure）、Anthropic Claude、DeepSeek、Qwen（阿里）、Google Gemini、xAI、Groq、Mistral、Cloudflare Workers AI、Together.ai、Fireworks.ai、Novita、智谱 Zhipu、SiliconFlow、Stepfun 阶跃、Baichuan 百川、Minimax、Moonshot 月之暗面、ModelScope、Player2、腾讯云、小米 MiMo。

**未支持（PR welcome）**：AWS Bedrock Claude、讯飞星火、火山引擎。

浏览器侧还有 `@xsai-transformers/*`（Transformers.js 提供商，用于本地 embedding/STT）和 `unspeech`（统一音频代理）。

---

## 6. computer-use-mcp 深度观察

`services/computer-use-mcp/` 是整个仓库**最被低估的生产级模块**，不是玩具。实测源码树：

- **浏览器控制**：`browser-dom/cdp-bridge.ts`（Chrome DevTools Protocol）、`browser-dom/extension-bridge.ts`、`browser-action-router.ts`、`chrome-session-manager.ts`、`chrome-semantic-adapter.ts`。
- **桌面截图/定位**：`desktop-grounding.ts` + `display/enumerate.ts`（显示器枚举）+ `utils/screenshot.ts`。
- **无障碍树**：`accessibility/ax-tree.ts`（AX tree，比纯像素定位可靠）。
- **终端**：`terminal/pty-runner.ts` + `@lydell/node-pty` + `executors/macos-local.ts` / `executors/linux-x11.ts`。
- **远程**：`remote/ssh.ts`、`runner/client.ts` / `service.ts`。
- **工作流编排**：`workflows/` 下有 `dev-run-tests.ts`、`dev-open-workspace.ts`、`dev-inspect-failure.ts`、`app-browse-and-act.ts`、`engine.ts`。
- **对话状态**：`transcript/`（block-parser / compactor / projector / store）+ `task-memory/`。
- **安全**：`policy.ts`、`preflight.ts`、`support-matrix.ts`、`transparency.ts`。
- 基于 `@modelcontextprotocol/sdk` 1.30，是标准 MCP server。
- 描述写的是 "macOS desktop orchestration"，但实际 executor 同时有 macOS 和 Linux X11。

---

## 7. 工程化观察

### 7.1 Monorepo 组织

- 约 **70+ workspace 包**（packages 50 + apps 5 + server 4 + integrations 6 + services 1 + engines 1 + plugins 5）。
- pnpm catalog 集中锁版本，`minimumReleaseAge: 4320`（3 天稳定期后才允许升级），有 `minimumReleaseAgeExclude` 白名单（`@proj-airi/*`、`@xsai/*` 自家包和紧急修复的 electron-builder）。
- `patchedDependencies` 有 6 个本地 patch：`@xsai-ext/responses`、`mineflayer-pathfinder`、`pixi-live2d-display`、`sponsorkit`、`tab-electron`、`uiohook-napi`——说明上游库有实际 bug 被他们修。
- `overrides` 用 `@nolyfill/*` 替换了一批 shim 包（array-flatten / isarray / safe-buffer 等），axios 换成 feaxios——很激进的去 node 兼容垫片策略。

### 7.2 测试与质量

- 每个核心包都有 `.test.ts`（VRM eye-tracking / animation / expression、Live2D expression / motion-control、minecraft 认知层大量测试、computer-use-mcp 几乎每个文件都有对应 test）。
- 浏览器测试：`@vitest/browser-playwright` 4.11 + `vitest-browser-vue`。
- 音频测试专用：`packages/testing-audio`、`packages/vitest-plugin-fakemic`（假麦克风测试运行时）。
- 视觉回归：`@vishot/cli`（自家截图工具），根 script `capture:tamagotchi` 用 vishot 捕获 Electron 场景。
- 代码检查：antfu/eslint-config 8 + oxlint + perfectionist（import 排序）+ eslint-plugin-slop（检测 AI 生成垃圾代码）+ knip（死代码）+ cspell（拼写）。

### 7.3 子项目生态（衍生包）

- **@proj-airi 组织**（github.com/proj-airi）实测 **21 个仓库**：`duckdb-wasm`、`drizzle-orm-browser`、`kokoro`、`chromatic`（配色）、`iconify-lobe-icons`、`iconify-meteocons`、`unplugin-fetch`、`unplugin-live2d-sdk`、`recorder-minecraft`、`candle-examples`、`airi-android`、`knoway`、`webai-example-realtime-voice-chat`、`webai-examples`、`awesome-ai-vtubers`，以及 4 个 game-playing-ai-* 实验仓库。
- **@moeru-ai 组织**：`xsai`（657 stars，自研 LLM SDK）、`unspeech`（ASR/TTS 统一代理）、`hfup`（HF Spaces 部署）、`mcp-launcher`（"Ollama for MCP"）、`inventory`（模型目录）、`sad`（自托管 LLM 文档）、`demodel`（模型加速下载）。

---

## 8. 社区与成熟度（GitHub API 实测，2026-09-18）

| 指标 | 数值 |
|---|---|
| Stars | **49,235** |
| Forks | 4,892 |
| Watchers | 194 |
| Open issues + PR | 223（≈ 92 issues + 131 PR，与用户给的数据吻合） |
| 贡献者 | **约 193 人**（contributors API Link header `page=193`） |
| 创建时间 | 2024-12-01 |
| 最近 push | **2026-09-18（调研当天）** |
| 最新 Release | `v0.12.0-beta.5`（2026-08-29） |
| 主语言 | TypeScript |
| License | MIT |
| 话题标签 | ai-companion, ai-vtuber, digital-life, grok-companion, live2d, neuro-sama, vrm, vtuber, openclaw |
| 分发渠道 | winget / Scoop / Homebrew Cask / Nix flake / GitHub Releases（Win exe / macOS dmg / Linux） |

**成熟度判断**：star 量级和提交活跃度（当天仍有 push）说明社区热度极高，但版本号仍是 `0.12.0-beta`，131 个 open PR 说明维护压力大、功能在快速翻滚。这是一个"明星项目但远未稳定"的状态。

---

## 9. 独特/创新点

1. **全栈 Web 技术押注**：从第一天就用 WebGPU / WebAudio / Web Workers / WebAssembly / WebSocket，浏览器版完整可用（PWA），同时桌面版用 Electron 兜底、Godot 4 原生引擎在孵化——三层渲染策略清晰。
2. **四层认知游戏 Agent 架构**（Minecraft）：Perception（事件+YAML 规则）→ Reflex（FSM 潜意识，可抑制意识层）→ Conscious（LLM 推理）→ Action（执行），受认知科学启发，在开源 VTuber 项目里很少见。
3. **LLM 生成 JavaScript 在 V8 沙箱执行**：`isolated-vm` + Query DSL + 动作预算 + 超时 + 内存限制，比传统 function calling 灵活一个数量级。
4. **纯浏览器数据库双栈**：DuckDB WASM + pglite（PostgreSQL wasm）+ pgvector，用户数据零后端、纯浏览器持久化（OPFS）。
5. **自研轻量 LLM SDK xsai**：对标 Vercel AI SDK 但小得多，统一 29 家提供商 + 本地 Transformers.js + 音频代理 unspeech。
6. **GPU 资源协调器**：VRAM 启发式估算 + 单模型加载队列 + 内存压力事件——这是浏览器多模型推理里少见的工程化考虑。
7. **生产级 computer-use-mcp**：CDP 浏览器控制 + AX tree 无障碍 + PTY 终端 + SSH 远程 + 工作流编排，能力接近 Claude Computer Use 开源版。
8. **Godot 原生引擎孵化**：跳出 Electron 性能瓶颈，VRM + MToon shader 已就绪。

---

## 10. 明显短板与风险

1. **记忆系统名不副实**：`packages/memory-pgvector/src/index.ts` 只有 25 行空壳 stub；duckdb 驱动已迁出主仓；"Memory Alaya" WIP；README 把 Memory 整个勾成 `[ ]`。长期人格连续性目前不存在。
2. **WebGPU 本地 LLM 推理未实现**：浏览器端只能跑 Kokoro TTS / Whisper STT / MODNet 背景移除 / embedding，不能跑 LLM 文本。README 自己承认。
3. **Minecraft bot 正处于废弃迁移期**：Mineflayer 实现虽精巧，但官方明确说要换 Fabric mod，基于现状做二次开发有踩空风险。
4. **Factorio AI 停滞**：独立仓库 `airi-factorio` 最后 push 2026-02-25，纯视觉 YOLO 路线成熟度未知，README 仍标 WIP。
5. **Helldivers 2 / KSP 等游戏宣称与代码不符**：KSP 主仓无代码（在独立实验仓），Helldivers 2 完全无代码。
6. **版本未到 1.0**：`0.12.0-beta.5`，131 个 open PR，API 不稳定；桌面版仍 Electron（内存/性能开销），Godot 替代早期。
7. **安全模型粗糙**：Minecraft bot 能跑 LLM 生成的 JS，官方警告不要连公共服务器；插件系统权限模型虽有 manifest/permissions，但生态刚起步。
8. **重度依赖外部 SaaS**：TTS/STT/LLM 默认走云端 API，本地模型仅音频；TTS 计费已经进入 server 端（最新 commit），说明有商业化托管意图。
9. **主仓复杂度极高**：70+ 包、pnpm catalog、Turbo、多渲染端、Godot/Godot C# 混合——新人上手门槛不低，文档站虽全但架构仍在快速演进。

---

## 附：关键证据文件索引

| 结论 | 证据路径 |
|---|---|
| 版本/技术栈 | `package.json`、`pnpm-workspace.yaml` |
| 三端划分 | `apps/stage-web`、`apps/stage-tamagotchi`、`apps/stage-pocket` |
| Agent 编排 | `packages/core-agent/src/{agent,chat-orchestrator-runtime,builtin-tools,compaction}.ts` |
| VRM 眼动 | `packages/stage-ui-three/src/composables/vrm/utils/eye-motions.ts` |
| Live2D | `packages/stage-ui-live2d/src/composables/live2d/*` |
| WebGPU 检测 | `packages/stage-shared/src/webgpu/detect.ts` |
| GPU 资源协调 | `packages/stage-ui/src/libs/inference/coordinator.ts` |
| 记忆空壳 | `packages/memory-pgvector/src/index.ts`（25 行） |
| 游戏认知架构 | `integrations/minecraft/README.md`、`integrations/minecraft/src/cognitive/` |
| JS Planner | `integrations/minecraft/src/cognitive/conscious/js-planner.ts` |
| Minecraft 废弃通告 | `integrations/minecraft/README.md` 顶部 Deprecation Notice |
| Factorio 独立 | api.github.com/repos/moeru-ai/airi-factorio |
| computer-use | `services/computer-use-mcp/src/` |
| 插件框架 | `packages/plugin-sdk/src/`、`plugins/*` |
| Godot 引擎 | `engines/stage-tamagotchi-godot/project.godot` |
| 社区数据 | api.github.com/repos/moeru-ai/airi |
