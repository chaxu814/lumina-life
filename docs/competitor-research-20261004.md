# 竞品深度调研：N.E.K.O / AIRI / openclaw / cc-haha / MiniMax Code

**调研日期**：2026-10-04（数据快照时间约 23:50 GMT+8）
**调研方式**：GitHub REST API（`api.github.com/repos/*`）+ 各项目官方 README / 官方文档站
**采集说明**：本机 hosts 文件屏蔽了 `raw.githubusercontent.com` 与 `github.com`（420 行广告过滤表），故 README 通过 `cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}` 镜像抓取，GitHub 元数据通过浏览器直连 `api.github.com` 获取（同一份数据，非二手转述）。
**标注约定**：`[官方]` = 官方文档或仓库代码/发布说明中明确写有；`[推断]` = 基于官方材料的合理推断；`[社区]` = 社区说法，未在官方材料中验证。

---

## 一、横向对比总表

### A. 硬数据

| 维度 | N.E.K.O | AIRI | openclaw | cc-haha | MiniMax Code |
|---|---|---|---|---|---|
| 仓库 | `Project-N-E-K-O/N.E.K.O` | `moeru-ai/airi` | `openclaw/openclaw` | `NanmiCoder/cc-haha` | **无公开仓库** |
| Star | **3,013** | **50,022** | **391,294** | **14,860** | — |
| Fork | 340 | 4,994 | 82,258 | 8,592 | — |
| Open Issues | 83 | 223 | 9,303 | 184 | — |
| Watcher（订阅） | 18 | 201 | 1,718 | 57 | — |
| License | Apache-2.0 | MIT | MIT | MIT | 闭源商业 |
| 主要语言 | Python | TypeScript | TypeScript | TypeScript | 未公开 |
| 创建时间 | 2025-06-29 | 2024-12-01 | 2025-11-24 | 2026-03-31 | — |
| 最后 Push | 2026-10-04 12:52Z | 2026-10-04 14:28Z | 2026-10-04 15:51Z | 2026-10-04 14:22Z | — |
| 最新 Release | `v0.9.0` 2026-08-20 | `v0.12.0-beta.5` 2026-08-29 | `v2026.9.8` 2026-10-03 | `v0.6.8` 2026-10-01 | `v3.1.0` 2026-09-30 |
| 仓库体积 | ~529 MB | ~549 MB | ~7.4 GB | ~170 MB | — |
| 官网 / 主页 | store.steampowered.com/app/4099310 | airi.moeru.ai | openclaw.ai | cchaha.ai | agent.minimax.cn |

来源：<https://api.github.com/repos/Project-N-E-K-O/N.E.K.O>、<https://api.github.com/repos/moeru-ai/airi>、<https://api.github.com/repos/openclaw/openclaw>、<https://api.github.com/repos/NanmiCoder/cc-haha>、各仓库 `/releases/latest`

**语言字节数明细**（来源：各仓库 `/languages` 接口）

| 项目 | 语言构成 |
|---|---|
| N.E.K.O | Python 55.57 MB · JavaScript 20.15 MB · TypeScript 4.28 MB · CSS 1.68 MB · HTML 1.59 MB · Vue 662 KB |
| AIRI | TypeScript 12.45 MB · Vue 3.70 MB · C# 351 KB · GDScript 281 KB · JS 126 KB |
| openclaw | TypeScript 418.1 MB · **Swift 19.35 MB** · **Kotlin 9.70 MB** · JS 6.57 MB · Shell 2.70 MB · Rust 1.99 MB · CSS 1.86 MB · Python 1.57 MB |
| cc-haha | TypeScript 57.99 MB · **Swift 1.38 MB** · CSS 208 KB · Python 168 KB · JS 145 KB · Shell 112 KB · Rust 102 KB |

> openclaw 的 Swift+Kotlin 合计 29 MB，佐证其拥有真实原生 iOS/Android 应用；其余三家桌面端为主。

### B. 技术栈与平台覆盖

| 维度 | N.E.K.O | AIRI | openclaw | cc-haha | MiniMax Code |
|---|---|---|---|---|---|
| 框架 | Python 后端 + React/Vue 前端 + Electron 端 | Vue 3 + TS，pnpm monorepo；Electron 桌面 + Capacitor 移动 | Node/TS + Gateway + Control UI/CLI/TUI + 原生 Swift/Kotlin | **Electron** + React + Vite | 桌面客户端（栈未公开） |
| Windows | ✅ exe 一键包 | ✅ winget `MoeruAI.AIRI` | ✅ 安装器 install.ps1 | ✅ win-x64 / win-arm64 exe | ✅ 64 位安装包 |
| macOS | ✅ .app（需手动解除隔离） | ✅ brew cask / dmg（darwin-arm64） | ✅ install.sh | ✅ dmg（已签名公证） | ✅ arm64 + Intel dmg |
| Linux | ✅ Docker + `.n.e.k.o` | ✅ releases 通用 | ✅ install.sh / Docker / Nix | ✅ AppImage / deb / rpm（x64+arm64） | ❌ 文档未提供 |
| 移动端 | 🚧 iOS/Android 内测中（project-neko.cn 预约） | ⚠️ `stage-pocket`（Capacitor，iOS，README 标注 experimental）；release 含 android apk | ✅ iOS + Android 原生应用 | ⚠️ 仅 H5 浏览器接入 | ⚠️ 无移动应用，手机端走 Remote Control 网页 |
| 本地推理 | ❌ 未见 WebGPU/Ollama；仅接云端 14+ 服务商（Realtime API + ChatCompletion） | ⚠️ 路线图里「纯浏览器 WebGPU 推理」**未勾选**；支持 Ollama / vLLM / SGLang；桌面端走 CUDA/Metal（candle） | ✅ 「local models 作为插件」；Docker 镜像装 libgomp1 以支持托管 llama.cpp | ✅ **LM Studio、Ollama** 明确支持 | ❌ 未提供本地模型；仅 BYOK 接云端供应商 |
| IM 渠道数 | 插件形态，非核心 Channel：QQ(OneBot)、微信、B 站、直播弹幕(B站/抖音/Twitch) | Discord(✅已实现)、Telegram(✅已实现)、微信 + QQ(社区入口) | ✅ **32 个**（见下） | ✅ **8 个** | ✅ **4 个**（见下） |
| Computer Use | ✅ `brain/computer_use.py` + `browser_use_adapter.py` | ⚠️ 游戏操控(Minecraft/Factorio)为主，非通用桌面操控 | ⚠️ 通过 nodes/companion apps 提供屏幕、摄像头、设备动作 | ✅ **macOS 原生运行时不占用真实鼠标键盘** | ✅ 作为**插件市场插件**提供，需授权鼠标/键盘/屏幕 |

**openclaw 32 个 Channel 清单** `[官方]`（来源 <https://docs.openclaw.ai/channels>）：
A2A、Buzz、ClickClack、Discord、Feishu(飞书)、Google Chat、iMessage、IRC、LINE、Matrix、Mattermost、Microsoft Teams、Nextcloud Talk、Nostr、QQ bot、Raft、Reef、Signal、Slack、SMS、Synology Chat、Telegram、Tlon、Twitch、WebChat、WeChat(微信)、WeCom(企业微信)、WhatsApp、Yuanbao、Zalo、Zalo ClawBot、Zalo personal

**cc-haha 8 个 IM** `[官方]`：Telegram、飞书、微信、钉钉、WhatsApp、企业微信、QQ、Slack

**MiniMax Code IM** `[官方]`（来源 <https://agent.minimax.cn/docs/code/automation/im>）：中文/国内 → 微信、飞书；英文/海外 → Telegram、WeChat、Lark。微信扫码绑定，飞书/Lark 走授权，Telegram 填 Bot Token。

### C. 记忆系统

| 项目 | 方案 | 可验证性 |
|---|---|---|
| **N.E.K.O** | **五维记忆**：工作记忆 / 近期记忆 / 事实记忆 / 反思记忆 / 人格记忆。仓库有独立目录 `memory/`：`facts.py`(事实)、`reflection.py`(反思)、`persona.py`(人格)，独立进程 `app/memory_server.py`。v0.9.0 增加：群聊记忆按会话作用域隔离 + 发言人信赖度；核心记忆按主体分 Token 预算；召回改为工具调用；记忆浏览器重做（Web 端 `/memory_browser` 可浏览校对近期记忆与摘要）。 | **高**。代码路径 + Web 记忆浏览器可人工校对；用户可用「忘记关于 XX 的记忆」使其删除 |
| **AIRI** | **浏览器内嵌数据库**：DuckDB WASM \| `pglite`，配套自研 `@proj-airi/drizzle-duckdb-wasm` Drizzle ORM 驱动。长线记忆项目「**Memory Alaya**」标注 WIP（未完成），独立仓库在 `@proj-airi` 组织下。 | **中**。README 路线图里 Memory 一栏 `[ ] Memory Alaya (WIP)` 明确未完成 |
| **openclaw** | README 未展开细节，但发布说明中可见记忆子系统是活跃开发对象（如 v2026.8.34 的「Doctor: Preserve per-agent memory search during upgrades」、「Memory: Resolve profile auth for compatible embeddings」）。存在 `memory_get` / `memory_search` 工具与 `MEMORY.md` + `memory/YYYY-MM-DD.md` 文件体系。 | **中**。本轮未拉取 `docs.openclaw.ai` 记忆专页细节，**标记为待补充**，不做臆测 |
| **cc-haha** | **完整继承并文档化 Claude Code 的文件记忆系统**。四种类型：User（用户画像）/ Feedback（行为反馈）/ Project（项目动态）/ Reference（外部引用）。存储为 `~/.claude/projects/{路径哈希}/memory/` 下的 Markdown 文件 + YAML frontmatter；`MEMORY.md` 为索引，**上限 200 行 / 25 KB**。自动提取由后台「记忆提取子 Agent」在每轮对话结束时执行；`/memory` 手动编辑，`/remember` 审查整理（不自动改，需批准）。**AutoDream**：距上次整合 ≥24 小时且累积 ≥5 个会话时，后台静默启动「做梦」子 Agent，四阶段：定向→收集→整合→修剪，状态栏显示 dreaming。**新鲜度管理**：超过 1 天的记忆附带陈旧警告，引用文件路径/函数名的记忆使用前先 grep 确认。 | **最高**。官方文档 <https://cchaha.ai> 的 `docs/internals/memory.md` 给出了完整目录结构、文件格式、生命周期图和开关（`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、`autoDreamEnabled: false`、`/dream`） |
| **MiniMax Code** | **记忆 / 主动记忆双开关**（设置 → 个性化）。Agent 在任务中主动识别有长期价值的信息（沟通偏好、工作习惯、项目约定、调试经验）。**记忆摘要**可查看/编辑/删除。会话级 `/memory` 开关「使用记忆」（对话开始前设定，不可改）与「生成记忆」（会话中可调）。 | **中**。官方文档给出用户可见行为，但**未公开底层存储实现**（未见向量库/BM25/SQLite/Markdown 的任何说明）。**明确标注：不可从公开文档验证技术选型** |

### D. 多 Agent 编排

| 项目 | 是否有编排层 | 机制 |
|---|---|---|
| N.E.K.O | ⚠️ 有 `agent_server` 与 `task_executor.py`，但**未公开团队/编排层设计** | v0.9.0 提供「动态记忆召回走工具调用」；README 明确「把 OpenClaw / Hermes 这类 Agent 当作手脚来调用（A2A）」，有 `openclaw_adapter.py` |
| AIRI | ❌ 未见多 Agent 编排层 | `core-agent` 包存在，但公开路线图聚焦游戏操控、语音、形象 |
| openclaw | ✅ 有团队部署形态 | README：同一个 Gateway 可作个人助理或「shared team deployment」，差别仅在配置。v2026.8.34 修复项含「Repair keyed multi-agent rosters」「Preserve requester MCP runtime ownership」「Agents: Preserve requester MCP runtime ownership」 |
| cc-haha | ✅ **三层** | 1) **SubAgent**：六种内置类型（general-purpose / Explore / Plan / verification / claude-code-guide / statusline-setup），各带独立工具池与模型绑定（Explore/Guide 走 Haiku，statusline 走 Sonnet）；支持 `run_in_background`、worktree 隔离、超 120 秒自动后台化（`tengu_auto_background_agents`）。2) **Agent Teams**：`TeamCreate` + `name`/`team_name` 加入团队 + `SendMessage` 定向/广播 + shutdown_request 协调协议；团队配置在 `~/.claude/teams/{name}/config.json`，共享任务目录 `~/.claude/tasks/{name}/`。3) **跨会话协作**（v0.6.6 新增）：`ListSessions`/`ReadSession`/`CreateSession`/`SendSessionMessage`/`WaitSessions`，Claude 可自建独立会话并行干活，每组协作最多同时跑 3 个工作会话，Git 项目用独立 worktree。另有**动态 Workflow 编排**：模型当场写编排脚本，并发或流水线调度子代理，支持阶段视图、中断、断点续跑 |
| MiniMax Code | ✅ 有 | **Agent Team**：按任务复杂度引入多个专家 Agent，自动拆解、分配、跟踪进度、汇总结果。v3.0.46（2026-06-14）起「切换为显式用户开关，需 `/team` 显式触发」。另有 SubAgent 独立对话入口（v3.0.72）、自定义 Agent（固定角色/指令/技能/工作区） |

### E. 人格 / 桌宠 / 形象

| 项目 | 形象形态 | 情绪系统 | 是否绑定真实执行状态 |
|---|---|---|---|
| **N.E.K.O** | **5 种**：Live2D / VRM / MMD / PNGTuber / 猫咪桌宠。v0.9.0 新增「挂件模式」（从屏幕边缘探出半个身子）、Live2D 服装「洛丽塔」（默认皮肤）、PNGTuber 内置 YUI Origin/Sister/Lolita 三套形象 + 第三方分层工程导入 | 「**凝神模式**」（v0.8.3）：倾诉复杂心事时不急着回应，先深度思考，配「凝神中」指示灯与思考气泡。v0.9.0 补齐繁体中文的情绪提示词（此前对繁中零命中），并加 CI 门禁防回退。`config/prompts/prompts_chara.py` 角色提示词与 `prompts_sys.py` 系统提示词分离 | ✅ **是**。猫咪模式「能感知窗口并与桌面内容发生更多交互」；屏幕分享带来源过滤与记忆窗口；游戏副驾驶插件（战雷）跟踪战局状态解说；空闲降帧、启动导入 -37% 等性能优化说明形象层与执行层共用同一进程 |
| **AIRI** | **Live2D + VRM** 双栈，v0.12.0-beta.1 新增 **MMD** 模型与 **Tachie 立绘**（按情绪切换整张立绘）。v0.12.0-beta.5 新增 **MAGIC 驱动**生成 Neuro-sama 式「Neuro bump」动作，内置 Idle/calm 与 Speaking/excited 两档 profile，保持口型同步 | 自动眨眼 / 自动看向 / 空闲眼球移动（Live2D 与 VRM 均支持）；v0.11.3 新增控件岛（Controls Island）可静音/停止全部语音；v0.12.0-beta.1 新增 **Hearing playground** 可监控 ASR 管线并复盘每段语音 | ⚠️ **部分**。控件岛绑定真实语音/录音状态；麦克风输入会避免把自己的语音回灌进对话（防自听）。但**整体形象与 Agent 任务执行状态无绑定**——AIRI 的「任务」是打游戏/聊天，不是干活 |
| **openclaw** | ⚠️ 无 Live2D/VRM 桌宠。吉祥物是龙虾「Molty」，仓库有 `soul.md`，但**不是可交互形象** | 不适用 | 有「LobsterAI 皮肤包」式资产槽位概念，但那是本产品侧，非 openclaw 官方。**本轮未在 openclaw 官方仓库验证桌宠能力，标记为未见** |
| **cc-haha** | ✅ **桌面宠物**：搭搭、弧弧、补补、回回；支持自制宠物；**默认关闭** | 宠物动作随任务状态切换 | ✅ **明确绑定**。官方 README 原文：「搭搭、弧弧、补补、回回**随任务状态换动作**」。另有 OpenCode Go 订阅下的 Space Bunny 形象图（v0.6.7 修复图片丢失） |
| **MiniMax Code** | ❌ **未见任何 Live2D / VRM / 2D 形象或桌宠** | 不适用 | 不适用。官方文档通篇无形象层描述 |

### F. 安全沙箱

| 项目 | 权限模型 | 审批流 | 命令拦截 |
|---|---|---|---|
| N.E.K.O | 自建，README 未展开权限模型文档 | 未见桌面端审批 UI 描述 | 未见 |
| AIRI | 未见公开沙箱文档 | 未见 | 未见 |
| **openclaw** | **架构核心命题即「trusted gateway, untrusted execution, deterministic policy」**（README 原文）。工具默认在 host 上运行，**除非显式配置沙箱**。入站消息一律视为不可信输入 | DM 类渠道对未知发送者默认走配对（pairing），需 `openclaw pairing approve <channel> <code>` 显式批准 | 有独立的 security guide、exposure runbook、sandboxing guide、SECURITY.md、Doctor 修复系统。发布说明里持续出现「tighten remote filesystem mutation, plugin and skill scanning, browser authentication, channel reply identity, private skill ingress」「retain explicit cron tool allowlists」「remote filesystem mutation 边界收紧」等加固项 |
| **cc-haha** | **五档权限模式**，从「询问权限」到「跳过权限」。README 原文：危险命令、工具调用和 AI 反问都在桌面端审批 | 桌面端图形化权限审批；AskUserQuestion 卡片、权限请求会高亮置顶标签卡与侧边栏（v0.6.8 新增「等待处理的会话高亮」） | 工具参数非法 JSON 时不再静默降级为空参数执行，而是把明确错误回灌给模型让它重试（v0.6.7 修复）。v0.6.7 新增 **Agent Teams 启动前人工审核**：团队方案就绪后先出确认卡片，可逐个成员改 Agent 预设/服务商/模型/任务归属，确认后才真正启动——「启动前的成本由你把关」 |
| **MiniMax Code** | 权限确认制。需确认的操作：读取工作区外的文件、修改或删除文件、执行命令、使用可能产生外部影响的工具、**处理远程控制或 IM 入口发来的操作** | 桌面端弹窗确认。官方建议：首次用某项目保持保守授权；对删除/覆盖/上传/发消息保留人工确认。另有电脑操控插件的独立授权（鼠标/键盘/屏幕） | v3.0.30（2026-05-22）起优化：常见命令组合的权限判断更智能，弹窗明显减少 |

### G. 生态

| 项目 | 市场 / 扩展机制 |
|---|---|
| **N.E.K.O** | **插件 SDK（`plugin/sdk/`）+ 插件服务端（`plugin/server/`）+ 插件商城**，前端有独立的 `frontend/plugin-manager/`（Vue）。v0.9.0 新增：插件技能、可回滚本地升级、自启增强、市场本地账号、插件 UI 实时推送通道、**`plugin-cli publish`**。另有 **Steam 创意工坊**（UGC 上传角色/模型/语音包）、**MCP**（支持自定义 Headers）、外部记忆导入（**支持从 OpenClaw / Hermes 导入**） |
| **AIRI** | WIP 插件系统；**MCP Launcher**（"Ollama for MCP"，独立仓库）；`inventory`（集中模型目录与默认供应商配置后端服务）；`unspeech`（ASR/TTS 通用代理，类似 LiteLLM）；`xsai` LLM SDK；`@proj-airi` 组织下另有 Live2D 工具、embedded database、icons、RAG 等子项目。**没有面向大众的第三方技能市场** |
| **openclaw** | **ClawHub**（<https://clawhub.ai>）技能/插件市场 + **插件 SDK**（docs.openclaw.ai/plugins/building-plugins）。README 明确战略：「New capabilities usually belong in plugins built on the plugin SDK and shared through ClawHub」。模型与 agent harness（Claude、Codex、local models）本身就是插件，可热插拔。发布流程包含 plugin npm publish 与 plugin ClawHub submission 的 CI 阶段 |
| **cc-haha** | **技能市场**，接入 **ClawHub / SkillHub**。v0.6.8 起默认打开**内置精选目录：398 个技能、13 个分类**，不再实时请求注册表；「搜索全部市场」保留为显式范围，结果标注「未精选」。详情页含统计、安全报告、更新日志、能力与触发条件；未审计或有风险的技能需确认后才能安装；ClawHub 技能固定按卡片作者安装防顶替。**MCP 图形化管理**（STDIO / Streamable HTTP / SSE 三种传输 × 项目私有/共享/全局三种作用域）。另有 **Remotion 技能包**（官方 12 项技能） |
| **MiniMax Code** | **插件市场**，插件含三种能力类型：**Skill**（`skills/<name>/SKILL.md`）、**MCP**（`*.mcp.json`）、**应用/Connector**（OAuth 类，需联系 MiniMax 接入）。包结构固定 `.minimax-plugin/plugin.json`（schemaVersion / name / displayName / version / description / author / icon / category / exampleQueries / apps / mcpServers / skills）。支持 ZIP 包或公开 GitHub 仓库提交（可指定 branch/tag/commit/子目录），可选择启用端（桌面端 MiniMax Code / 云端 MiniMax Agent / 两端）。**明确禁止**在插件包内放 OAuth、token、client secret、API key，提交前需确认无密钥/个人数据/安装脚本/symlink/native binary。首批插件：恒生付费金融数据库、企查查、EverMe、北大法宝、Office 三件套，后续新增 WPS 金山文档、企业微信。另有 **Red Skill 搜索**（搜小红书热门 Skill）。**独立 MCP 服务文档页** |

### H. 商业模式

| 项目 | 性质 | 付费档 / 收入来源 |
|---|---|---|
| N.E.K.O | **开源核心 + 商业发行**。Apache-2.0，README 强调「核心驱动器基于 Apache 2.0 **始终开源**，本地运行，数据在你自己手里」 | **Steam 免费上架**（app/4099310）+ **Steam 创意工坊 UGC 生态**。规划中提「你的每一次贡献都将有机会实装到 Steam 和 App 商店的正式版本中」，移动端 iOS/Android 适配进行中（内测）→ 隐含 App 商店变现路径。赞助渠道：QQ 群 / Discord。**目前无付费墙** |
| AIRI | **完全开源 MIT** + 母公司 Moeru AI 运营 | README「Supporters」段：OpenCollective、Patreon、Ko-fi 三方赞助。**README 未列出任何付费订阅**。仓库同时存在**托管后端**（Caddy + api-server + auth-server + PostgreSQL + Redis）与 Stripe 结账分析埋点（v0.11.3：「records AI generation, LLM usage, Stripe identity, and checkout-related analytics」），`airi.moeru.ai` 为托管 Web 服务 → **开源代码 + 官方托管服务**的 open-core 形态，但官方未明确公布托管服务定价 |
| openclaw | **完全开源，且明确拒绝商业化** | README 原文：「has **no paid tier, hosted service, or token**」。由 **OpenClaw Foundation（独立 501(c)(3)）** 托管，基金会雇佣核心团队并签署发布。捐助方含 Amazon、Lobster Computer Company、Offline Holdings、**OpenAI（捐助者，非所有者）**、Red Hat、密歇根大学；基础设施赞助 Blacksmith、Convex、GitHub、**NVIDIA**、Vercel。**5 个项目中商业化最淡的一个** |
| cc-haha | **完全开源 MIT + 个人主导商业化** | 三条线：1) **API 中转商赞助**（AruHub、Atlas Cloud、ApiSmart，均带推广链接）；2) **商业合作**：「企业定制 / 私有化部署 / Agent 定制需求请联系作者」，联系邮箱 relakkes@gmail.com；3) **个人打赏**（微信赞赏 / 支付宝 / Buy Me a Coffee）。README 明确「本项目由个人利用业余时间维护」。**无功能付费墙** |
| **MiniMax Code** | **闭源商业订阅** | **M Plan**（承接并拓展 Token Plan）：分 **Go / Explore / Build** 三档，用量额度相对 Go 为 **1× / 3× / 12×**。Go 档仅文本模型 M3.1 Flash Preview；**Explore 与 Build 额外可用 H3 视频模型**；三档均含图像与音频模型。M Plan 同时可作为 API Key 接入 Claude Code、Codex、Cursor、OpenCode、Hermes Agent、OpenClaw 等外部工具。**积分体系**：每日签到领 400 积分，第 4/7 天加码至 1000，一周累计 4000，**积分自到账起 30 天内有效**。促销：首月五折（至 2026-10-14）、国庆七日 M3.1-Flash-Preview 不限量（10/1–10/7）。**官方页面未公布绝对价格**，仅给相对倍数 |

### I. 2026 年内最新动向（最近 3 个月）

**N.E.K.O**（v0.9.0 / 2026-08-20 + nightly 2026-10-02）`[官方]`
- 喵宇宙社区上线，对话中自然掉落卡片，可融合/铸造/收藏/分享
- PNGTuber 形象正式上线（内置 YUI Origin/Sister/Lolita）
- 挂件模式 + 猫咪模式增强（感知窗口、与桌面内容交互）
- 主动搭话新增来源：贴吧、YouTube、小黑盒、Twitch、B 站 + 个性化音乐推荐，未被回应时自动收敛
- 直播插件（人猫同播/猫猫独播，接 B 站/抖音/Twitch 弹幕）+ 战雷副驾驶插件
- **外部记忆导入：支持从 OpenClaw / Hermes 导入**，带预估时间与实时进度
- 声纹识别与独立语音识别进入 Beta
- 记忆系统升级：群聊记忆按会话作用域隔离 + 发言人信赖度、核心记忆按主体分 Token 预算、召回改工具调用、记忆浏览器重做
- 路线图：v0.7/v0.8/v0.9 第一阶段均已完成，**v1.0 预计 9 月底上线正式版**；自研大模型计划已延期

**AIRI**（v0.12.0-beta.1 ~ beta.5 / 2026-08-24 ~ 08-29）`[官方]`
- v0.12.0-beta.1：桌面端支持 **MMD 模型**与 **Tachie 立绘**（按情绪切整张立绘）；VRM 角色可点击头/臂/手/脚产生反应；Live2D 导入支持 CJK 路径与旧编码文件名；新增 Hearing playground 监控 ASR 管线；长对话渲染开销下降
- v0.12.0-beta.3：macOS 26+ **端侧 Apple Speech 转写**（无需 API key）；移动端可长按输入框上拖成紧凑气泡；Linux Wayland 稳定性修复；宿主认证 UI 不再打包 Stage 渲染器、模型资产与本地推理运行时（**瘦身**）
- v0.12.0-beta.5：Live2D 新增 **MAGIC 驱动**生成 Neuro-sama 式动作；Live2D 导入前置检查报告（列出模型数据、缺失引用、未引用资源与修复步骤）；新增 VOICEVOX / AivisSpeech 本地语音引擎；**新增内部 gamepad 包**（PS5 DualSense USB/蓝牙）
- v0.11.3（2026-07-18）：桌面伴侣支持语音输入；角色卡可导入/导出为 AIRI .zip 包

**openclaw**（v2026.9.5 → v2026.9.8 / 2026-09-19 ~ 10-03）`[官方]`
- 发布节奏极高：v2026.9.7 单个版本 **518 个直接 commit、2,818 个 PR、334 位贡献者**；v2026.9.8 为 58 commits / 43 PR / 21 contributors
- 双轨发布：main 线（2026.9.x）+ **extended-stable 稳定线**（2026.8.35、2026.8.34），后者自称「equivalent to LTS」，向 8 月底版本回合 113 个审计选定修复单元
- 模型跟进：GPT-6.1 Sol 接入（2026.8.35）
- 重点投入方向：插件/技能扫描与私域技能入口加固、远程文件系统变更边界收紧、secret-store 轮换稳定性、cron 工具白名单、Doctor 修复系统（认证迁移收据、per-agent 记忆检索保留、共享凭据迁移）、Gmail/IMAP watcher 与 Matrix 映射修复、托管 llama.cpp 在干净 Windows 主机启动
- 发行可验证性：每个版本附 npm integrity sha512、release SHA、完整 release CI 报告链接；**另发布面向 AI Agent 的纯 Markdown CHANGELOG**（`CHANGELOG/{version}.md`）
- v2026.9.8 中 Android APK 被 skip（`apps/android/version.json` 版本落后于 release train）——**移动端发版节奏落后于桌面 Gateway**，属已知摩擦点

**cc-haha**（v0.6.1 → v0.6.8 / 2026-09-10 ~ 10-01，22 天 8 个版本）`[官方]`
- v0.6.5：OpenCode Go 订阅供应商（一个 Key 打通 GLM/Kimi/MiniMax/Qwen/Grok/GPT，本地代理自动分流协议）；Composer 能力菜单可搜索（Skills/连接器/Agents/工作流/Agent Teams/Computer Use 统一入口）；**批准计划时可切换执行模型**（同供应商原地切，跨供应商自动重启并继续）
- v0.6.6：**跨会话协作**（Claude 自建独立会话并行干活，`ListSessions`/`ReadSession`/`CreateSession`/`SendSessionMessage`/`WaitSessions`）；`@` 引用历史会话（不复制全量上下文，按需读取）；每组协作最多 3 个工作会话并发，Git 项目用独立 worktree
- v0.6.7：**侧边对话**（`/btw 问题`，继承父会话上下文与模型但独立运行，追问不打断主任务）；**Agent Teams 启动前人工审核**；超时自动回答（1/5/10/30 分钟可配）；Claude Opus 5.5、GPT-6 Astra/Sol/Luna
- v0.6.8：**本地语音听写**（16 kHz 单声道 PCM16 WAV，引擎与模型下载到本地并校验 sha256/sha512、支持断点续传与国内镜像）；工作区文档预览（PDF/Word/Excel 侧边打开、按文件记忆滚动位置与当前工作表、被改写自动刷新）；**技能市场内置 398 个精选技能 / 13 分类**；等待处理的会话高亮；按扩展名着色的文件图标
- 性能攻坚：大会话打不开（subagent 记录不再内联，542 MB 响应降到 40 MB）、>20 MB 会话压缩按供应商真实 token 上限计算、超大 transcript（>8 MiB）不触发索引降级、`scheduled_tasks.json` UTF-8 BOM 容错

**MiniMax Code**（v3.0.46 → v3.1.0 / 2026-06-14 ~ 09-30，changelog 共 36 个版本，近 3 个月 19 个）`[官方]`
- v3.0.46（06-14）：Agent Team 切换为显式用户开关，深度研究 Skill 退役（需 `/team` 显式触发）
- v3.0.52（07-20）：**远程控制**（手机连桌面端 Agent，看进度、发指令、处理权限审批）；内置浏览器；**Coding / Work 双模式**；BYOK 模型配置
- v3.0.68（08-27）：**记忆管理**（设置页新增记忆管理，新建对话时可选是否使用/生成记忆）；**Goal 模式**优化（长任务重复回复、循环执行、中断问题）；Browser Use 增强；Remote Control 产物下载与任务通知卡片
- v3.0.69（09-08）：**无限画布**（集中对话与工作区图片视频）；**端云同步**（桌面端会话列表同时展示本地与云端会话，可从桌面端发起、查看、下载云端产出）；**H3 Max 视频模型**（文生视频/图生视频/480p·768p/同步生成声音）；**自定义 Mini App**（自然语言搭可视化工作台）；AI 水印可关
- v3.0.72（09-14）：**端云任务接力**（本地任务交接云端继续执行，确认交接文件，云端完成后下载产物或对比本地文件差异后同步）；无限画布 HTML 预览与标注；**语音输入**；**Subagent 独立对话**；站内信
- v3.0.74（09-28）：**M3.1-Flash-Preview** 首发接入
- v3.1.0（09-30）：产品视觉焕新；Computer Use / Mini App / Git Graph 面板 / Agent 实时执行动态优化；**M Plan 正式上线**（承接 Token Plan，订阅价格与文本额度不变，部分档位可用 H3）

---

## 二、各项目详细说明

### 1. N.E.K.O（猫娘计划）

**是什么**：一个 Python 3.11 驱动的实时语音 + 视觉数字生命体平台，核心差异点不是「能干活」而是「有主动性」。N.E.K.O 全称 Networked Emotional Knowing Organism，默认角色 YUI。它明确把 OpenClaw / Hermes 这类通用 Agent 定位为「手脚」——通过 `brain/openclaw_adapter.py` 做 A2A 调用，任务执行期间它依然在关注用户；同时又拿 SillyTavern 这类纯文字 RP 前端做对比，宣称自己端到端集成原生语音、视觉感知、角色动作与跨场景持久记忆。

**技术底座**：`app/` 下三个独立进程——`main_server`（Web UI，48911/48912 端口）、`agent_server`（Agent）、`memory_server.py`（记忆）。`main_logic/` 有 26 个 API 路由，`core.py` 核心对话 + `omni_realtime_client.py`（Realtime API，语音）+ `omni_offline_client.py`（ChatCompletion，文字/视觉）双客户端对偶。`brain/` 下 `computer_use.py`、`browser_use_adapter.py`、`task_executor.py` 构成工具执行层。记忆是本项目最厚的一块：`memory/` 目录实装事实/反思/人格三类，配合独立的记忆服务器进程，v0.9.0 又把召回从隐式改成了工具调用——这意味着模型必须主动决定「要不要回忆」，而不是被动注入。

**形象层是它真正的护城河**：五种形态（Live2D/VRM/MMD/PNGTuber/猫咪桌宠）+ 挂件模式 + 猫咪模式能感知窗口。「凝神模式」把情绪系统做成了可见的：思考气泡 + 「凝神中」指示灯，让用户看到她在认真听。形象与执行状态确实绑定——战雷副驾驶插件跟战局解说，空闲降帧与启动导入优化说明渲染层和执行层跑在同一进程。Steam 免费发行 + 创意工坊 UGC 是它区别于纯技术项目的商业设计：让画师、建模师、配音演员通过创意工坊分发自己的角色，而不是等官方合并 PR。

**短板**：3013 star、83 open issues，规模在五者中最小；安全沙箱与权限审批在 README 中几乎没提；本地推理缺失，核心 API 必须支持 Realtime API（推荐阿里云百炼）；遥测默认开启（匿名 token 用量），可 `DO_NOT_TRACK=1` 关闭，但上报 Steam64 user ID 的行为在文档中占了相当篇幅说明其触发条件。

### 2. AIRI

**是什么**：目标是复刻 Neuro-sama。项目 2024-12 起步，是五者中历史最长的开源项目（AIRI 50k star vs N.E.K.O 3k），社区体量最大。

**技术底座与其说是桌面应用不如说是一个 Web 技术实验场**：从第一天就构建在 WebGPU / WebAudio / Web Workers / WebAssembly / WebSocket 之上。桌面端用 Electron（Stage Tamagotchi）包装，同时通过 HuggingFace candle 直接调用原生 NVIDIA CUDA 与 Apple Metal 补齐算力——README 明确说不会完全依赖 Web 栈，「Web 负责图形、布局、动画，以及那个还在 WIP 的插件系统」。pnpm monorepo 下三个 app：`stage-web`（浏览器/PWA）、`stage-tamagotchi`（桌面）、`stage-pocket`（Capacitor 移动，README 标注 experimental）。Vue 3 + TypeScript，代码里 C# 与 GDScript 的存在来自游戏插件（Factorio / DomeKeeper）。

**分发做得比同行都全**：winget（`MoeruAI.AIRI`）、Scoop、Homebrew Cask 三套包管理，加上直接下载 dmg/exe/deb。

**记忆是它最弱的一环，这点必须讲清楚**。README 路线图的 Brain → Memory 一栏里，「纯浏览器数据库支持（DuckDB WASM | pglite）」已勾选，但「**Memory Alaya (WIP)**」是未勾选状态——也就是说长期记忆系统至今没做完。它有 30+ 家 LLM 供应商（xsai 统一接入，含 MiniMax、Moonshot、SiliconFlow 等），本地能接 Ollama / vLLM / SGLang，但「纯浏览器 WebGPU 本地推理」这一项同样未勾选。

**能力重心在「玩」不在「干活」**：Minecraft ✅、Factorio ✅（PoC 与 demo 可用）、Kerbal Space Program ✅、Helldivers 2 进行中；Discord 与 Telegram 聊天已实现，IM 侧另有微信与 QQ 的社区入口。v0.12.0-beta.5 的 MAGIC 驱动能生成 Neuro-sama 式动作，形象质量是它压倒性的优势——但没有任务编排层，也没有与 Agent 执行状态绑定的形象反馈。

### 3. openclaw

**是什么**：五者中唯一的基金会治理项目，也是体量断层第一（391k star / 82k fork / 9303 open issues，仓库 7.4 GB 含 Swift 19 MB + Kotlin 9.7 MB 的原生应用）。架构命题写得很直白：**trusted gateway, untrusted execution, deterministic policy**。

**核心抽象是 Gateway**——本地控制平面，管会话、工具、事件与渠道连接；Control UI / CLI / TUI 都是它的客户端。32 个渠道（含 A2A、Reef、Tlon、ClickClack 这些 Agent 间协议）让它成为「无处不在」层级的存在。模型与 agent harness（Claude、Codex、本地模型）本身是**插件**，可热插拔而不动其他任何东西——这是它架构上最聪明的一点。

**安全是它投入最重的方向**。默认把入站消息当不可信输入；DM 类渠道对未知发送者强制走 pairing 审批（`openclaw pairing approve <channel> <code>`）；工具默认跑在 host 上但明确「unless you configure sandboxing」；有独立的 security guide、exposure runbook、sandboxing guide、SECURITY.md，还有一整套 Doctor 修复系统。从 v2026.8.34 的 113 个回合修复单元能直接读出加固重点：插件与技能扫描、远程文件系统变更边界、浏览器认证、渠道回复身份、私域技能入口、cron 显式工具白名单。

**商业模式最淡**：OpenClaw Foundation（独立 501(c)(3)）托管，README 明确「无付费档、无托管服务、无代币」。捐助方名单里有 OpenAI、NVIDIA、Amazon、Red Hat、密歇根大学——值得注意的是 OpenAI 被明确定位为「donor, not an owner」。

**弱点**：没有桌宠/形象层，人格表达完全缺席；发布节奏激进到 v2026.9.7 一个版本合入 2818 个 PR，质量风险由 9,303 个 open issues 承接；v2026.9.8 的 Android APK 被 skip，说明移动端发版链条跟不上桌面 Gateway。

### 4. cc-haha

**是什么**：把 Claude Code 装进一个自己做的 Electron 桌面工作台，围绕它加了一整圈工作流能力。2026-03-31 建仓，**6 个月做到 14,860 star / 8,592 fork**——fork/star 比 0.58，是五者中最高的（AIRI 0.10、openclaw 0.21、N.E.K.O 0.11），说明大量用户是 fork 下来自己改的。个人项目（NanmiCoder），MIT 协议。

**技术栈务实**：Electron + React + Vite + Bun 做本地运行时，终端 UI 用 React + Ink，CLI 解析 Commander.js，API 走 Anthropic SDK，协议层 MCP + LSP。Swift 1.38 MB 说明有原生模块（语音听写、桌面宠物这类）。发布矩阵齐全到 mac/win/linux × x64/arm64 共 11 个包；macOS 已签名公证，**Windows 因 SignPath 未开通而全部未签名**（README 与每次 release 都重复这条）。

**它真正的差异化不是功能数量，而是把 Claude Code 那些「藏在文档里的机制」全部可视化和产品化了**：

- **记忆**是五个里做得最深的——四类型划分（User/Feedback/Project/Reference）、Markdown + YAML frontmatter、`MEMORY.md` 索引 200 行/25 KB 上限、后台记忆提取子 Agent、**AutoDream**（≥24h 且 ≥5 会话后启动「做梦」子 Agent，四阶段定向→收集→整合→修剪）、以及**新鲜度管理**（超 1 天附陈旧警告、引用路径前先 grep 确认）。这不是它自研的，是继承 Claude Code，但它把这套机制完整文档化并做了 UI。
- **多 Agent 三层叠加**：六个内置 SubAgent 类型各带工具池与模型绑定（Explore/Guide 走 Haiku）；Agent Teams 有 `TeamCreate`/`SendMessage`/shutdown 协调协议、配置文件与共享任务目录；再加上 v0.6.6 的跨会话协作（Claude 可自建会话并行干活，每组最多 3 个并发，Git 项目自动独立 worktree）。还有动态 Workflow——模型当场写编排脚本跑并发或流水线，支持中断与断点续跑。
- **Computer Use** 是差异化最狠的一条：**macOS 原生运行时不占用你的真实鼠标和键盘**。README 用加粗强调这句。配套有实时预览面板。
- **技能市场接 ClawHub / SkillHub**，v0.6.8 起内置 398 个精选技能 / 13 分类，不实时请求注册表；未审计或有风险的技能需确认后安装；ClawHub 技能固定按卡片作者安装防同名顶替。
- **桌面宠物**（搭搭、弧弧、补补、回回）明确「随任务状态换动作」，默认关闭。
- 权限是五档梯度，危险命令、工具调用、AI 反问都在桌面端审批；v0.6.7 加了 **Agent Teams 启动前人工审核**——可以逐成员改预设、服务商、模型、任务归属才放行。

**商业模式**：MIT 全开源，收入靠 API 中转商赞助（AruHub / Atlas Cloud / ApiSmart）、企业定制与私有化部署（relakkes@gmail.com）、个人打赏。无功能付费墙。

### 5. MiniMax Code

**是什么**：**闭源商业桌面 Agent 应用**，官方文档站 <https://agent.minimax.cn/docs/> 提供 `llms.txt` 全量索引（本轮所有页面均通过该索引发现并抓取 `.md` 原文）。**未找到公开 GitHub 仓库**，因此 A 维度硬数据缺失。

**能力清单**（全部 `[官方]`，来源 agent.minimax.cn/docs）：Coding / Work 双模式；工作区（选项目目录建立上下文）；内置浏览器；电脑操控（**以插件市场插件形式提供**，需授权鼠标/键盘/屏幕，可预览桌面或指定应用）；文件/变更/终端三面板；无限画布（图片视频集中，支持 HTML 拖入并排预览、滚动、元素级评论交回 Agent 修改）；插件/记忆/Mini App；H3 Max 视频生成；Coding 模式下的 Git Graph 面板；内置代码审查；对话协作（引用、评论、评价）；应用更新与问题反馈。

**四个机制值得单独拆**：

- **Goal 机制**：与普通 Prompt 的区别文档写得很清楚——普通 Prompt 是「提出要求→执行→返回→等待」，Goal 是「设定最终目标→执行→检查结果；未达标时选择下一步继续推进，达标后完成，遇到阻塞时汇报并等待」。只有关键词 `/` 命令菜单或 `+` 菜单能进入 Goal 模式（直接敲 `/goal` 无效）。文档甚至给了 Goal 模板：「实现【最终状态】，并通过【具体测试、报告或产物】验证 / 工作过程中保持【不能退步的条件】/ 只使用或修改【允许的范围】/ 每轮尝试后记录【改动、结果和下一项实验】/ 出现【阻塞条件】时停止并汇报」。**这就是本产品 Goal 机制的对标物**——差别在于 MiniMax 要求用户手写验收标准，且明确警告 Goal 连续多轮执行会明显消耗额度。
- **Agent Team**：按任务复杂度引入多个专家 Agent，自动拆解、分配、跟踪、汇总。v3.0.46 起改为显式用户开关，需 `/team` 触发。
- **定时任务**：设置名称、指令、执行 Agent、执行时间与会话模式；**官方明确警告依赖桌面端运行环境，电脑休眠或应用未运行时任务可能无法按时执行**。
- **远程控制**：手机连桌面端，查看进度、发补充指令、**处理权限确认**、查看产物与部分文件内容。

**安全模型**：权限确认制，覆盖读取工作区外文件、修改删除文件、执行命令、外部影响工具，以及**远程控制或 IM 入口发来的操作**（这条意味着 IM 是明确的攻击面，官方自己承认）。官方建议首次用某项目保持保守授权。

**商业模式**：M Plan 三档（Go 1× / Explore 3× / Build 12× 用量），Go 档仅 M3.1 Flash Preview 文本模型，Explore 与 Build 解锁 H3 视频模型，三档均含图像与音频。积分体系每日签到 400 分（第 4/7 天 1000），一周 4000，30 天有效。M Plan 同时可作 API Key 接入 Claude Code / Codex / Cursor / OpenCode / Hermes Agent / OpenClaw——**这意味着 MiniMax Code 与 openclaw 是竞合关系**：MiniMax 既做 Agent 客户端，又把模型卖给 openclaw 的用户。另有 BYOK（Base URL + API Key + 模型名）与独立 CLI（`mcode`，支持 headless/CI 与 ACP 集成，可接入支持 Agent Client Protocol 的编辑器）。**官方页面未公布绝对价格**。

---

## 三、2026 年趋势观察

**1. 「Agent」这个词正在分裂成两个互不兼容的品类。**
一边是 openclaw / cc-haha / MiniMax Code——以「交付可验证结果」为核心，cc-haha 的标题就是「让 Claude 能够跨越多次对话」，MiniMax 的 Goal 模板第一行就是「实现【最终状态】，并通过【具体测试、报告或产物】验证」。另一边是 N.E.K.O / AIRI——以「关系与陪伴」为核心，N.E.K.O 在 README 里直接把这两条路线列成对比表并说自己属于后者。有意思的是 N.E.K.O 又反过来把 openclaw / Hermes 接成自己的执行器（`openclaw_adapter.py`、从 OpenClaw 导入记忆），AIRI 也把 `openclaw` 加进了自己的 GitHub topics。**品类边界清晰，但依赖关系是单向的：陪伴层消费执行层。**

**2. 记忆从「存起来」升级为「可验证、可自净、可失效」。**
2026 年这批项目的记忆系统都不再是简单存向量。三种可验证性路径：
- **可校验**：cc-haha / Claude Code 路线——记忆是 Markdown + YAML frontmatter 的纯文件，人能直接读、能 `/memory` 编辑、能 `忘记关于 XX 的记忆`；**新鲜度管理**（超 1 天附陈旧警告、引用路径前先 grep）是关键设计，防止过期记忆毒化上下文；**AutoDream** 用「≥24h + ≥5 会话」做后台整合。
- **可观测**：N.E.K.O 提供 Web 端记忆浏览器（`/memory_browser`）供人工校对近期记忆与摘要，v0.9.0 又把召回从隐式注入改成工具调用，让模型显式决定要不要回忆。
- **可导入**：N.E.K.O v0.9.0 支持从 OpenClaw / Hermes 导入外部记忆，带预估时间与实时进度——**记忆开始成为跨 Agent 的可迁移资产**。

反过来，AIRI 的「Memory Alaya」到 2026-08 仍是 WIP 未勾选，说明这条赛道的完成度分化极大。

**3. 权限模型从「要不要弹窗」转向「弹窗出现在哪一层」。**
所有人都在做确认，但确认点位置不同：openclaw 放在**入站**（未知发送者默认 pairing，未知 inbound message 一律不可信）；cc-haha 放在**编排**（Agent Teams 启动前人工审核，可逐成员改预设/服务商/模型/任务归属）；MiniMax Code 放在**渠道**（明确把「远程控制或 IM 入口发来的操作」列为需确认项——等于承认 IM 是攻击面）；openclaw 还把 cron 做成**显式工具白名单**。趋势很清楚：审批点正从「执行前」前移到「协作前」和「接入前」。

**4. 原生移动端是分水岭，不是可选项。**
openclaw 是唯一有真 Swift（19.35 MB）+ Kotlin（9.70 MB）原生应用的，cc-haha 的 Swift 只有 1.38 MB（原生辅助模块）。其余：AIRI 的 `stage-pocket` 标注 experimental，N.E.K.O 移动端「内测中」，cc-haha 只有 H5，MiniMax Code 没有移动应用（手机端走 Remote Control 网页）。**但 openclaw 自己的 v2026.9.8 release 里 Android APK 被 skip**（`apps/android/version.json` 版本落后于 release train）——原生移动端做起来难，跑顺了也未必跟得上桌面发版节奏。

**5. 「本地推理」的口号与现实的落差。**
AIRI 把「纯浏览器 WebGPU 推理」写在路线图上但**至今未勾选**；真正落地本地模型的是 cc-haha（LM Studio / Ollama 明确支持）和 openclaw（local models 作为插件，Docker 镜像装 libgomp1 支持托管 llama.cpp）。AIRI 走的是另一条路——桌面端用 candle 直连 CUDA / Metal 拿算力，而不是浏览器内推理。N.E.K.O 和 MiniMax Code 完全没有本地推理选项。**「本地优先」在这批项目里指的是「本地运行 + 云端推理」，不是「本地推理」。**

**6. 商业模式出现三种泾渭不同的路径。**
openclaw 走到极端——基金会 501(c)(3)、**明确声明无付费档无托管服务无代币**，靠 Amazon / OpenAI / NVIDIA / Red Hat 等捐助方和 Blacksmith / Vercel / Convex 的基础设施赞助运转，README 特别点明 OpenAI 是捐助者而非所有者。cc-haha 是个人项目的典型变现——MIT 全开，靠 API 中转商赞助 + 企业私有化定制 + 打赏。MiniMax Code 是纯闭源订阅——M Plan 三档 + 积分体系 + 首月五折促销。而 N.E.K.O 和 AIRI 走 open-core：代码全开源，**变现放在分发渠道而非功能**（N.E.K.O 上 Steam 创意工坊，AIRI 有托管后端 + Stripe 埋点但未公布定价）。**开源 ≠ 免费，但开源项目的钱几乎都不从功能墙上收。**

---

## 四、这些项目最近 3 个月在猛攻什么方向

### openclaw —— 猛攻「规模化发布 + 安全边界 + 多端发版」
- v2026.9.7 单版本 **518 commits / 2818 PRs / 334 contributors**，v2026.9.8 为 58 commits / 43 PR / 21 contributors——两个月内跑出双轨（main + extended-stable/LTS）发布体系
- 安全加固是持续主题：插件与技能扫描、远程文件系统变更边界、浏览器认证、渠道回复身份、私域技能入口、cron 显式工具白名单、secret-store 轮换稳定性
- Doctor 修复系统持续扩容（认证迁移收据校验、per-agent 记忆检索保留、共享凭据迁移修复）
- 移动端发版链条是已知痛点（v2026.9.8 Android APK skipped）
- 发行可验证性做到极致：npm integrity sha512、release SHA、完整 release CI 报告、**面向 AI Agent 的纯 Markdown CHANGELOG**

### cc-haha —— 猛攻「会话级协作 + 本地化能力 + 性能」
- **会话是新的编排单位**：跨会话协作（v0.6.6，`CreateSession`/`SendSessionMessage`/`WaitSessions`，每组 3 并发 + worktree 隔离）、`@` 引用历史会话、侧边对话 `/btw`（v0.6.7，继承父上下文但不打断主任务）
- **本地化替代云依赖**：v0.6.8 本地语音听写（引擎与模型下载到本地，sha256/sha512 校验，断点续传，国内镜像源）；v0.6.5 OpenCode Go 订阅供应商（本机代理自动分流协议，一个 Key 打通六家模型）
- **成本可控性**：Agent Teams 启动前人工审核（逐成员改模型才放行）、批准计划时可切换执行模型、上下文用量面板以「剩余窗口」为主
- **性能是硬指标**：大会话 542 MB → 40 MB、>20 MB 会话压缩修复、>8 MiB transcript 不触发索引降级、`scheduled_tasks.json` BOM 容错

### MiniMax Code —— 猛攻「端云协同 + 长任务自治 + 订阅商业化」
- **端云任务接力**（v3.0.72）：本地任务交云端继续执行，确认交接文件，云端完成后下载产物或对比本地文件差异后同步；v3.0.69 已有端云同步（桌面端同时展示本地与云端会话）
- **Goal 机制**（v3.0.68 优化）：解决长任务的重复回复、循环执行、中断三类问题，并支持随时补充要求、调整目标、查看状态
- **无限画布 + HTML 预览标注**（v3.0.69/72）：把多媒体创作拉进 Agent 上下文，页面元素级评论直接交回 Agent 改
- **商业化收口**：M3.1-Flash-Preview 首发（v3.0.74）→ M Plan 正式上线（v3.1.0），首月五折至 10-14
- **发版节奏**：changelog 共 36 个版本，近 3 个月 19 个，平均 4–5 天一版

### N.E.K.O —— 猛攻「社区化 + 生态闭环 + 跨 Agent 记忆迁移」
- **喵宇宙社区上线**（v0.9.0）：对话掉落卡片，可融合/铸造/收藏/分享——从单机应用走向 UGC 社交
- **Steam 创意工坊 + K.U.R.O. 独立游戏 + App 商店**三件事指向同一目标：让外部创作者（画师/建模/配音）通过市场分发，而非 PR
- **从 OpenClaw / Hermes 导入记忆**：记忆成为跨 Agent 可迁移资产
- **形态扩张**：PNGTuber 上线、挂件模式、猫咪模式感知窗口
- **插件生态工程化**：`plugin-cli publish`、可回滚本地升级、插件 UI 实时推送通道、市场本地账号
- **v1.0 预计 9 月底上线正式版**（自研大模型计划已延期至正式版之后）

### AIRI —— 猛攻「形象表现力 + 移动端 + 导入健壮性」
- **Live2D MAGIC 驱动**生成 Neuro-sama 式动作；**MMD 模型**与 **Tachie 立绘**（按情绪切整张立绘）加入，形成 Live2D + VRM + MMD + Tachie 四栈
- **导入体验**持续打磨：CJK 路径、旧编码文件名、macOS 生成的 ZIP 也能正确导入、导入前置检查报告（列出缺失引用与未引用资源及修复步骤）
- **移动端**：macOS 26+ 端侧 Apple Speech 转写（无 API key）、输入框上拖成紧凑气泡、iOS 系统权限弹窗不再直接退出 app、Wayland 稳定性
- **宿主瘦身**：认证 UI 不再打包 Stage 渲染器、模型资产与本地推理运行时；`server-runtime` 改为每端口单监听并禁用 reusePort 修跨平台 socket 错误
- **输入设备扩展**：新增内部 gamepad 包，支持 PS5 DualSense USB/蓝牙
- **记忆仍是短板**——Memory Alaya 至今 WIP

---

## 五、数据可信度与未覆盖项说明

**全部标注为「未验证 / 待补充」的项目**：

1. **openclaw 的记忆系统技术选型**——本轮只从发布说明中看到记忆子系统的活跃改动痕迹（per-agent 记忆检索保留、embeddings 认证解析），未拉取 `docs.openclaw.ai` 记忆专页。**不做臆测**。
2. **openclaw 的桌宠 / 2D 形象能力**——在官方 README 与 channels 文档中未发现。**标记为「未见」，不等于确定没有**（可能存在于 plugin 生态中）。
3. **AIRI 的托管服务（airi.moeru.ai）定价**——README 提到 Stripe 结账与云端用量埋点，但未公布任何价格。**留空**。
4. **MiniMax Code 的绝对价格**——官方 M Plan 页只给 Go/Explore/Build 三档的相对用量倍数（1×/3×/12×），未给具体金额。
5. **MiniMax Code 的底层记忆存储实现**——官方文档只描述用户可见行为（记忆/主动记忆开关、记忆摘要编辑），**未披露**是否使用向量库、BM25、SQLite 或 Markdown。
6. **MiniMax Code 的技术栈与硬数据**——未找到公开仓库，A 维度（star/fork/语言构成/仓库体积）整体缺失。

**方法论备注**：本机 hosts 文件屏蔽了 `github.com` 与 `raw.githubusercontent.com`，shell 层无外网（curl / git / DNS 全部失败），因此所有抓取通过浏览器完成——GitHub 元数据直连 `api.github.com`，README 与内部文档通过 `cdn.jsdelivr.net/gh/` CDN 镜像读取同一份 `@main` 分支内容。数据均为 2026-10-04 当日实时抓取，未使用任何缓存或记忆。
