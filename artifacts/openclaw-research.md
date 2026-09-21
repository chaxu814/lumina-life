# OpenClaw 深度调研报告

> 调研对象：https://github.com/openclaw/openclaw
> 抓取日期：2026-09-21（Asia/Shanghai, UTC+8）
> 调研背景：Lumina CHANGELOG 提及"OpenClaw 桥接：新增 A2A/MCP 客户端与 openclaw 渠道适配，作为可选外部执行后端"，需搞清 openclaw 定位。

---

## 0. 一句话定位

**OpenClaw 是一个自托管、跨设备的个人 AI Agent 网关（Gateway），通过 20+ 个现有聊天渠道（WhatsApp/Telegram/Slack/Discord/iMessage 等）把 LLM 接到用户已有的 IM 里，本身是无头 agent runtime，不是桌宠/陪伴产品。**

---

## 1. 仓库主页快照（2026-09-21 抓取）

| 项 | 值 | 来源 |
|---|---|---|
| 仓库 | `openclaw/openclaw` | https://github.com/openclaw/openclaw |
| 标语 | "The AI that really does things. Any OS. Any Platform. The lobster way. 🦞" | README |
| 副标题 | "Your personal AI assistant, running on your own devices." | README |
| 作者 | Peter Steinberger（@steipete），社区共建 | README 末尾致谢 |
| 前身 | Clawdbot → Moltbot → OpenClaw | https://openclaw.bz/blog/openclaw-rewriting-playbook（2026-04-02） |
| 吉祥物 | Molty，一只"太空龙虾"（logo 为红色圆球+触角） | README / 官网 |
| Commits | **97,805** | GitHub 主页 |
| Open Issues | **5,000+**（issue 创建已被 restrict） | GitHub 主页 |
| Open PRs | **3,000+**（每人上限 20 个 open PR，见 issue #84599） | GitHub 主页 / issue #38283 |
| Issue 编号水位 | **#154,549**（2026-09-21 当天仍在新增） | https://github.com/openclaw/openclaw/issues |
| Stars | 官网自述 **346k+**（2026-09-18）；第三方 2026-04-02 称 130k+，5 个月内冲成 GitHub 历史上 star 最快的仓库之一 | https://openclaw.ai/ ；https://openclaw.bz/blog/openclaw-rewriting-playbook |
| Fork / Watch | GitHub 页面未在本次抓取中直接给出精确数（被登录墙折叠） | — |
| License | **MIT**，Copyright (c) 2026 OpenClaw Foundation | https://github.com/openclaw/openclaw/blob/main/LICENSE |
| 治理 | OpenClaw Foundation（独立 501(c)(3)），雇佣核心团队并签名发版；**OpenAI 是捐赠方不是所有者** | README "Governance" |
| 捐赠方 | Amazon、Lobster Computer Company、Offline Holdings、OpenAI、Red Hat、University of Michigan | README "Donors and sponsors" |
| 基础设施赞助 | Blacksmith、Convex、GitHub、NVIDIA、Vercel | README |
| 付费版 / 托管 / Token | **无**（README 明确："no paid tier, hosted service, or token"） | README |

---

## 2. 技术栈

主语言与运行时：

- **TypeScript + Node.js** 为主。仓库是 pnpm workspace（根目录 `pnpm-workspace.yaml`、`pnpm-lock.yaml`、`package.json`、`tsconfig*.json`、`tsdown.config.ts`、`vitest.config.ts`、`.oxlintrc.jsonc`）。
- 入口为 ESM `.mjs`（`openclaw.mjs`、`cli-root-options.mjs`、`gateway-run-argv.mjs`、`node-host-launcher.mjs` 等）。
- 要求 **Node 24.16+ 或 26.1+，推荐 Node 26**。
- 构建工具：tsdown；测试：Vitest；Lint：Oxlint。

Rust 侧（`crates/`）：

- `openclaw-gateway-client`
- `openclaw-node-host`
- 作用：原生 node host（移动端/桌面 companion 的本地执行宿主），非主逻辑。

桌面/移动 app（`apps/`）：

- `macos`、`ios`、`android`、`linux`、`mobile`、`shared`
- `macos-mlx-tts`：本地 MLX TTS（语音合成）
- `swabble`： Companion app
- 打包分发：`appcast.xml`（macOS Squirrel 更新）、`Dockerfile`、`docker-compose.yml`、`fly.toml`、`render.yaml`。

核心包（`packages/`，节选）：

| 包 | 推断职责 |
|---|---|
| `gateway-protocol` / `gateway-client` | Gateway 通信协议与 SDK |
| `agent-core` / `llm-core` / `ai` | Agent 循环与 LLM 适配层 |
| `acp-core` | ACP（IDE ↔ Agent）协议桥 |
| `memory-host-sdk` | 记忆宿主 SDK |
| `plugin-sdk` / `plugin-package-contract` | 插件开发 SDK |
| `terminal-core` | 终端执行 |
| `tool-call-repair` | 工具调用修复 |
| `net-policy` | 网络策略/沙箱 |
| `media-core` / `media-generation-core` / `media-understanding-common` | 媒体生成与理解 |
| `model-catalog-core` | 模型目录 |
| `mermaid-renderer` / `markdown-core` / `retry` / `normalization-core` | 工具型基础库 |

结论：**是一个 TS/Node monorepo 为主、Rust 做原生宿主的 agent 基础设施工程，不是 Electron/Tauri 桌面应用，也不是纯 Python 项目。**

---

## 3. 目录结构定性

根目录关键目录：

```
.agents/  .claude/  .github/  .openclaw/worktree-profiles/
apps/        # macOS/iOS/Android/Linux 原生 app + 移动端 node
crates/      # Rust: gateway-client, node-host
docs/        # 文档
examples/ai-chat/
extensions/
packages/    # TS 核心包（见上表）
skills/  custodian-skills/    # 内置 skills
src/         # 主源码
ui/          # Control UI 前端（需单独 pnpm ui:build）
deploy/  scripts/  qa/  test/  patches/  security/  config/
CHANGELOG.md  VISION.md  AGENTS.md  CONTRIBUTING.md  SECURITY.md
```

**产品形态判定：既是 CLI/SDK，也是 Gateway 服务端，外加各平台原生 companion app；不是单一桌面 GUI 应用。**

---

## 4. 核心功能矩阵

| 能力 | 是否具备 | 证据 |
|---|---|---|
| 桌宠 / 屏幕陪伴形象 | **否** | 无 Live2D/3D/VTuber 相关目录；logo 只是静态红色圆球；无屏幕悬浮窗产品形态 |
| 形象（Live2D/3D） | **否** | 仓库无任何 Live2D、Spine、VRM 资产目录 |
| 接入 LLM | **是** | 支持 Claude、Codex、本地模型；"Models and agent harnesses are plugins you can swap" |
| 多 Agent / 子 Agent | **是** | issue 中大量出现 subagent、agents.run()、WorkerTaskPool、ACP sessions_spawn |
| Memory | **是** | `packages/memory-host-sdk`；README 明确 "State, memory, and credentials live on your hardware" |
| Skills / Plugins | **是** | `skills/`、`custodian-skills/`、`packages/plugin-sdk`、ClawHub 插件市场 |
| MCP | **是** | `openclaw mcp set <name> --url ...`；可作为 MCP server 给 Claude/Cursor/Windsurf 用 |
| A2A | **是（社区插件为主）** | `@a2anet/openclaw-a2a-plugin` 提供 6 个 A2A 工具；官方 A2A 文档视为 planned/community demand |
| ACP（IDE↔Agent） | **是** | `packages/acp-core`；文档称 "Full Bridge Support" |
| 语音（TTS/STT） | **部分** | `apps/macos-mlx-tts` 本地 TTS；README 提 "voice" 在 companion nodes 里；未提完整 STT 管线 |
| Computer Use / 屏幕控制 | **部分** | companion nodes 提供 "camera, screen, device-local actions"；非主打 computer-use 产品 |
| 多渠道 IM 接入 | **是（核心卖点）** | Discord、iMessage、Slack、Teams、Telegram、WhatsApp、Signal、Google Chat、BlueBubbles、IRC、Matrix、Feishu、LINE、Mattermost、Nextcloud Talk、Nostr、Synology Chat、Tlon、Twitch、Zalo、WebChat 等 20+ |
| 自托管 / 本地优先 | **是** | 状态、记忆、凭证全在用户硬件；默认只做每日版本检查，匿名统计 opt-in |
| Web Dashboard / Control UI | **是** | `openclaw dashboard` 启动 Control UI |
| CLI / TUI | **是** | `openclaw` CLI + TUI |

---

## 5. 架构（来自 README "How it fits together"）

1. **Gateway**：本地控制平面，管理 sessions、tools、events、channel connections（一个 WebSocket server）。
2. **Control UI / CLI / TUI**：连 Gateway 的客户端。
3. **Channels**：把 assistant 接到 WhatsApp/Telegram/Slack/Discord/… 等消息服务。
4. **Companion apps and nodes**：在受支持平台上提供 voice、Canvas、camera、screen、设备本地动作。
5. **Tools / Skills / Plugins**：通过 plugin SDK 扩展，ClawHub 分发。

架构口号（README "Why OpenClaw"）：**trusted gateway, untrusted execution, deterministic policy**——可信网关 + 不可信执行 + 确定性策略。

安全模型（README "Security"）：

- 入站消息一律按不可信输入处理；DM 渠道默认对陌生发送方做配对审批（`openclaw pairing approve <channel> <code>`）。
- **工具默认直接在 host 上跑**，除非自己配 sandbox；暴露 Gateway 到公网前必须读 security guide / exposure runbook / sandboxing guide。

---

## 6. 安装门槛

README Quickstart 三条路径：

```bash
# 1) 一键脚本（macOS / Linux / WSL2）
curl -fsSL https://openclaw.ai/install.sh | bash

# 2) Windows PowerShell
iwr -useb https://openclaw.ai/install.ps1 | iex

# 3) 已自管 Node（Node 24.16+ / 26.1+）
npm install -g openclaw@latest --allow-scripts=openclaw
```

初始化：

```bash
openclaw onboard --install-daemon   # 跑引导向导，装 daemon
openclaw gateway status              # 看 Gateway 状态
openclaw dashboard                   # 开 Control UI
```

源码构建（开发者）：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw && pnpm install && pnpm build && pnpm ui:build
```

门槛判断：

- **终端用户**：curl 一键脚本即可，但要配模型 API key、配至少一个 channel、跑 onboarding wizard；且 README 自己承认 "A non-technical user is blocked" 类 issue 是真实存在的痛点。
- **开发者**：`npm i -g openclaw` 就能用 CLI；二次开发需要 pnpm workspace + Node 26 + Rust 工具链（要改 node-host 时）。
- **部署形态**：本地 laptop 个人 assistant，或共享 team deployment（README 称"configuration is the only difference"）；Docker / Nix / fly.io / Render 都支持。

---

## 7. Issue / Discussion 氛围（2026-09-21 当天 open bug 抽样）

直接打开 https://github.com/openclaw/openclaw/issues 可见：

- **Issue 创建已被 restricted**（"New issue creation is restricted in this repository"），说明社区涌入速度远超维护方处理能力。
- issue 编号已到 **#154,549**，且当天仍有 2h/3h/5h/6h/10h/11h/14h/16h/18h/19h 前新开的 bug。
- 维护方用机器人 **ClawSweeper / roboclaw-bot** 自动分类、打分（issue-rating: 🦞 diamond lobster / 🐚 platinum hermit / 🦪 silver shellfish）、标优先级（P0/P1/P2）、impact（crash-loop / security / session-state / message-loss / ux-friction）。
- 作者 **@steipete 本人当天仍在提 issue**（如 #154373 "Subagent updates trigger full registry reloads"）。

抽样 issue 标题（2026-09-21 当日 open）：

| # | 标题 | 性质 |
|---|---|---|
| 154549 | Plain status waits a minute when local Gateway is deliberately absent | 状态/UX |
| 154474 | Completion batch republished to top-level session; operator stop dropped mid-loop | 会话状态/P1 |
| 154381 | 2026.9.4 updater cannot reach 2026.9.5 timeout fix (candidate validation capped at 300s) | 自动更新/P0 |
| 154373 | Subagent updates trigger full registry reloads across temporary scopes | 子agent性能 |
| 154325 | First-time plugin install fails due to install race (regression, P1, crash-loop) | 插件安装 |
| 154157 | Updater repeats post-plugin completion when model retirement deferred | 更新器 |
| 154104 | Idle Gateway with 4 Matrix E2EE accounts: ~50% CPU + ~52 MB/min writes (regression) | 资源占用 |
| 153959 | agents.run() can return not_owner after creating correctly owned collector child | 竞态 |
| 153859 | Single ACP sessions_spawn causes two wake events | ACP/回归 |
| 153770 | WorkerTaskPool: task that never settles pins a worker thread at ~100% CPU forever | 线程泄漏 |
| 153743 | Provider tool-schema hooks recurse into untrusted external tool schemas with no depth budget (DoS) | 安全/DoS |
| 153724 | Deeply nested reasoning replay payload crashes reasoning sanitizer with RangeError | 崩溃 |

氛围判断：

- **极度工程化、内部化**。用户在抱怨的不是"AI 不够聪明"，而是 Gateway 生命周期、updater 超时、插件安装竞态、Matrix E2EE CPU 占用、ACP 双唤醒、线程泄漏、DoS 等——典型的基础设施运维问题。
- **迭代极快、回归频发**。版本号按天推进（2026.9.4 → 2026.9.5），自动更新器本身反复出 P0/P1 bug。
- **社区治理压力大**：issue 创建被限、每人 PR 上限 20、机器人自动分诊。
- 几乎看不到"桌宠/陪伴/形象"类需求——再次印证它不是陪伴产品。

---

## 8. 目标用户

从 README 语气 + issue 内容 + 一键脚本/README 文档量综合判断：

- **主力用户**：开发者、极客、自托管爱好者、想把 LLM 接到自己 IM 里做"数字员工"的人。
- **次要用户**：想要 team deployment 的小团队（共享 Gateway）。
- **非技术终端用户**：README 想争取（"Your personal AI assistant"），但实际 issue 证据表明这条路径仍被工程问题阻塞。

---

## 9. 商业化 / 开源姿态

- **License**：MIT（极宽松）。
- **法律主体**：OpenClaw Foundation，501(c)(3) 非营利。
- **收入模式**：无付费版、无托管 SaaS、无 token、无商业插件商店分成（ClawHub 是插件分发，未提及抽成）。
- **资金**：捐赠 + 基础设施赞助（Amazon/OpenAI/Red Hat/UMich 等）。
- **姿态**：典型的"Foundation 托管 + 全社区共治 + 全本地优先"路线，刻意避免云锁定。README 明确："OpenClaw itself phones home for nothing but a daily version check, anonymous feature statistics are opt-in"。

---

## 10. 明显短板 / 争议

1. **不是桌宠，名字和定位容易让陪伴类产品混淆**。它是 agent runtime，没有任何形象/UI/屏幕陪伴层。"OpenClaw" 与 "Claude" 形近，且前身 Clawdbot/Moltbot 改名频繁，品牌资产不稳定。
2. **复杂度对非技术用户不友好**。Gateway + 20+ Channels + Nodes + Plugins + 模型路由 + 沙箱配置，组合空间巨大；README 自己列了 security guide / exposure runbook / sandboxing guide 三份"暴露前必读"。
3. **issue/PR 爆炸，治理承压**。5k+ open issues、3k open PRs、issue 创建被 restrict、每人 PR 上限 20——维护方在用流程硬扛社区涌入。
4. **版本迭代过快导致回归**。updater 按天发版却反复出 P0/P1（#154381、#154157、#154325），自动更新器本身成了 bug 源。
5. **资源占用问题真实存在**。#154104：4 个 Matrix E2EE 账号就让 idle Gateway 吃 50% CPU、每分钟写 52MB；#153770 线程泄漏可把 worker 钉死在 100% CPU。
6. **安全模型默认激进**。工具默认在 host 上跑，不主动沙箱；入站 DM 默认配对但一旦通过就是 host 级执行权限——对把它当"聊天机器人"的普通用户是危险默认。
7. **A2A 支持主要靠社区插件**（`@a2anet/openclaw-a2a-plugin`），官方文档把 A2A 列为 planned/community demand；ACP 和 MCP 才是官方一等公民。这对 Lumina 这种"想通过 A2A/MCP 接它"的集成方意味着：A2A 路径不是官方承诺稳定性的接口。
8. **与 Claude Desktop / Cursor 类工具不是直接竞品**，它更像"self-hosted 版的 ChatOps bot + agent runtime"，不要按桌面助手产品的预期去评估它。

---

## 11. 相对 Lumina 的核心差异点（3–5 条）

1. **产品形态根本不同：无头 agent 网关 vs 桌面陪伴形象**。OpenClaw 没有 Live2D/3D、没有屏幕桌宠、没有悬浮窗 UI，它的"脸"是 WhatsApp/Telegram 里的一个聊天对象；Lumina 的核心价值恰恰是屏幕上的角色与陪伴感。
2. **交互入口相反：进入用户已有的 IM vs 占据用户的桌面**。OpenClaw 把 assistant 推到 20+ 个用户已经在用的 IM 渠道里；Lumina 是用户主动打开桌面窗口去看的角色。两者在"用户注意力争夺"上不构成竞争。
3. **OpenClaw 本身就是执行后端，不需要再套一个 runtime**。它自带 Gateway、agent loop、tool/sandbox、memory、MCP/ACP——Lumina CHANGELOG 里"把 openclaw 当可选外部执行后端"的集成思路是合理的：Lumina 做形象/对话/陪伴前端，openclaw 做重活（跑命令、调工具、跨渠道）。
4. **成熟度与用户群错位**。OpenClaw 346k+ star、issue 数量 15 万+、P0 bug 频发，是"高速演进的基础设施"；Lumina 面向终端陪伴用户，对稳定性、形象、情绪价值要求更高，不能直接把 openclaw 的工程成熟度当成 Lumina 的产品成熟度。
5. **治理与商业化路径不同**。OpenClaw 是 MIT + 501(c)(3) 非营利 + 无付费版，刻意走 Foundation 路线；Lumina 是商业产品，集成 openclaw 时要注意：它本身不会替你做商业分发、计费、SLA、企业合规——这些都要 Lumina 自己兜。

---

## 12. 给 Lumina 集成侧的一句话建议

**把 OpenClaw 定位成"可插拔的执行后端 / 跨渠道出口"，而不是"桌宠竞品"或"陪伴引擎"：前端形象、对话人格、记忆产品化全部由 Lumina 自己持有；通过 MCP（官方一等公民）或 ACP（官方一等公民）对接最稳，A2A 路径目前依赖社区插件，需自行评估稳定性。**

---

## 附：来源清单

- https://github.com/openclaw/openclaw （README、目录、Commits/Issues/PRs 计数）
- https://github.com/openclaw/openclaw/blob/main/LICENSE （MIT）
- https://github.com/openclaw/openclaw/issues （issue 氛围、编号水位、当日 open bug）
- https://github.com/openclaw/openclaw/tree/main/apps / crates / packages （目录结构）
- https://openclaw.ai/ （346k+ star 自述，2026-09-18）
- https://openclaw.bz/blog/openclaw-rewriting-playbook （前身 Clawdbot/Moltbot，2026-04-02 130k star）
- https://a2a-mcp.org/blog/OpenClaw-supports-ACP-protocol （ACP/MCP/A2A 对比）
- https://www.npmjs.com/package/@a2anet/openclaw-a2a-plugin （社区 A2A 插件）
- https://clankercloud.ai/blog/openclaw-claude-code-mcp-ai-agent-stack （MCP 使用示例）
- https://learnopenclaw.org/ （第三方独立教程定位"agent，不是 chatbot"）

> 所有 star/fork/issue 计数均为 2026-09-21 抓取时点数据；GitHub 页面未登录态未直接显示精确 star/fork/watch 数字，star 数采用官网 2026-09-18 自述 346k+，issue/PR/commit 数来自 GitHub 主页实时渲染。
