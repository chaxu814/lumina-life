# N.E.K.O.（Project N.E.K.O.）深度调研报告

> 抓取时间：**2026-09-21（周一，UTC+8）**
> 仓库：<https://github.com/Project-N-E-K-O/N.E.K.O>
> 所有 star / fork / issue / release 数据均为本次实时抓取，非缓存。

---

## 0. 一句话定位

**N.E.K.O.（Networked Emotional Knowledging Organism）= 一个以「AI 猫娘数字生命」为壳、端到端集成的开源 AI 伴侣平台**：实时语音 + 屏幕感知 + 五维记忆 + 多形态 Avatar（Live2D/VRM/MMD/PNGTuber/桌宠）+ 主动搭话 + Computer Use + 插件商城，走「GitHub 开源核心 + Steam 免费分发 + 创意工坊 UGC」双轨。

---

## 1. 仓库元数据（实时）

| 指标 | 数值 | 来源 |
|---|---|---|
| Stars | **2,903** | GitHub API `/repos/Project-N-E-K-O/N.E.K.O` |
| Forks | **321** | 同上 |
| Watchers / Subscribers（真实订阅） | **17** | 同上 |
| Open Issues（含 PR） | **72**（网页侧显示 Issues 49 + PR 38） | 同上 / 仓库页 |
| Commits 总数 | **3,125** | 仓库主页 |
| 主语言 | **Python** | GitHub API |
| License | **Apache-2.0** | GitHub API / 仓库页 |
| 创建时间 | **2025-06-29** | GitHub API |
| 最近 push | **2026-09-15 07:56 UTC** | GitHub API |
| 默认分支 | `main` | GitHub API |
| 仓库 size | ~530 MB（`.git` 历史约 390 MB，因早年二进制资产沉淀） | README 自述 |
| Topics | `companion`, `digital-human`, `harness`, `jarvis-assistant`, `own-your-data`, `personal`, `proactive-agent`, `proactive-ai`, `waifu` | GitHub API |
| Homepage | Steam 商店页 `app/4099310` | GitHub API |
| Discussions | **未开启**（`has_discussions: false`） | GitHub API |

> 节奏估算：创建至今 ~15 个月，3125 commits ≈ **208 commits/月**，属于高强度开发；近一周仍在 push（2026-09-15），Nightly Build 2026-09-16 已出。

---

## 2. 项目定位与 Slogan

- 英文名：**A catgirl who lives with you in real time — reaching out first, sharing your media, and actually getting things done, powered by an embodied emotional engine.**
- 中文 slogan：**听见你的心情，看见你的世界，陪你发现更多喜欢。**
- 自我定义（README 原文）：
  > "N.E.K.O. 不是帮你干活的 Agent，也不是陪你角色扮演的聊天前端——它是一个有现实时间感知、会主动找你、记得你、也能动手帮你的「数字生命」。"
- 与同类对比的官方划线：
  - 对比 **OpenClaw / Hermes 等通用 Agent**：它们以"完成任务"为目标；N.E.K.O. 以"关系与陪伴"为核心，可把这类 Agent 当手脚（A2A）来调用。
  - 对比 **SillyTavern 等 RP 前端**：它们是纯文字 RP、要自己拼模型/世界书；N.E.K.O. 是端到端集成、原生语音+视觉+外形+跨场景记忆。

来源：仓库 README.MD（<https://github.com/Project-N-E-K-O/N.E.K.O/blob/main/README.MD>），抓取 2026-09-21。

---

## 3. 技术栈与架构分层

来自 README「项目架构」段与仓库根目录列表：

### 3.1 进程 / 服务拆分（多服务）

```
app/
├── main_server/     # 主服务器（Web + Electron 后端）
├── agent_server/     # AI 智能体服务器（可选）
├── memory_server.py # 记忆服务器（独立进程）
└── monitor.py        # 独立观看端
```

开发者启动命令：
```
uv run python app/memory_server.py
uv run python -m app.main_server
uv run python -m app.agent_server   # 可选
```

### 3.2 关键模块

| 目录 | 作用 |
|---|---|
| `brain/` | Agent 智能体模块：`computer_use.py`、`browser_use_adapter.py`、`openclaw_adapter.py`、`task_executor.py`、`cua/`（Computer Use Agent 子系统） |
| `memory/` | **五维记忆**：`facts.py`（事实）、`reflection.py`（反思）、`persona.py`（人格），外加工作/近期记忆 |
| `main_logic/` | 核心对话：`core.py`、`omni_realtime_client.py`（Realtime API）、`omni_offline_client.py`（ChatCompletion）、`activity/`（系统/用户状态）、`topic/`（主动话题）、`tts_client/`（多 TTS 对偶） |
| `main_routers/` | 26 个 API 路由 |
| `frontend/react-neko-chat/` | **React** 聊天窗口 |
| `frontend/plugin-manager/` | **Vue** 插件管理面板 |
| `plugin/sdk/` + `plugin/server/` | 插件 SDK + 插件服务端 |
| `steamworks/` | Steamworks SDK 集成（成就、云存档、创意工坊） |
| `local_server/` | 本地服务 + 独立的遥测服务端 `telemetry_server/` |
| `docker/` | Docker Compose / Dockerfile |
| `pkgbuild/` | Linux 打包（Arch AUR 风格） |
| `.agent/` | 遵循 Google Antigravity 规范的 AI 编程助手技能集 |
| `templates/` | 24 个 HTML 页面 |
| `static/` | 前端构建产物 + 用户上传的 Live2D/VRM/MMD 模型 |

### 3.3 运行时

- 后端：**Python 3.11（明确不支持其他版本）** + **uv** 包管理器
- 前端：**Node.js ≥ 20.19**，React + Vue 双前端，构建脚本 `build_frontend.bat/sh`
- 桌面壳：**Electron**（Nightly 发布 Windows x64 / macOS Intel / macOS ARM / Linux AppImage & deb）
- 部署：Docker 镜像 `ghcr.io/project-n-e-k-o/n.e.k.o:latest`，HTTP 48911 / HTTPS 48912，自签证书 1000 年
- 包管理：`uv.lock`，测试 `pytest.ini` + ruff，CI 还跑异步阻塞、禁 logging import、prompt/i18n、LLM 预算、API 尾斜杠、模块分层等门禁

来源：仓库 README.MD、`project-neko.online/guide/dev-setup`，抓取 2026-09-21。

---

## 4. 核心功能矩阵

| 能力 | 状态 | 证据 |
|---|---|---|
| 桌宠 | ✅ | 五种形态之一就是"猫咪桌宠"；v0.9.0 新增挂件模式（屏幕边缘探身）+ 猫咪模式可感知窗口 |
| Live2D | ✅ | 默认角色 YUI，已上线「洛丽塔」服装；支持拖拽/滚轮调位置 |
| 3D Avatar（VRM / VRM 语义动作 + VMC 输出） | ✅ | v0.9.0 release notes |
| MMD | ✅ | v0.7.2 "MMD Support and Meme Spamming" |
| PNGTuber | ✅ | v0.9.0 正式上线，内置 YUI Origin/Sister/Lolita 三套 |
| 接 LLM | ✅ | 14+ 服务商（OpenAI / Gemini / Qwen / DeepSeek / GLM / Step / 硅基流动等），含免费模型开箱即用 |
| 多 Agent | ⚠️ 单角色 + 工具调用 + A2A 调外部 Agent | `brain/` 下有 task_executor / cua / openclaw_adapter，但官方明确"我们不是多 Agent 团队产品"；通过 A2A 调 OpenClaw/Hermes |
| Memory（五维） | ✅ | 工作 / 近期 / 事实 / 反思 / 人格；v0.9.0 升级为按主体分 Token 预算 + 工具调用召回；支持从 OpenClaw/Hermes 导入 |
| Skills / Plugins | ✅ | 插件 SDK（装饰器 API、异步生命周期、插件间通信）+ 插件市场 + Steam 创意工坊；已内置 QQ / 微信 / B 站 / 抖音 / Twitch / 网易云 / QQ 音乐 / 米家 / 战雷 / 直播 / 伴学等插件 |
| STT（语音识别） | ✅ Beta | v0.9.0 "声纹识别与独立语音识别进入 Beta（独立 ASR 默认关闭）" |
| TTS | ✅ | 多 provider 对偶（含豆包 TTS、OpenAI 兼容 TTS、vLLM-Omni 声音克隆、5 秒样本克隆自定义音色） |
| 实时语音对话 | ✅ | Realtime API（推荐阿里云百炼），与 ChatCompletion 双通道 |
| Computer Use | ✅ | `brain/computer_use.py` + `cua/` 子系统 + 浏览器自动化 + 键鼠接管 |
| 主动交互 | ✅ 主打 | 主动搭话开关、最低间隔可调、屏幕分享/新闻网站/视频网站/个人动态/音乐推荐/表情包/小游戏邀请 7 个信号源；v0.9.0 新增贴吧/YouTube/小黑盒/Twitch/B 站；未被回应会自动收敛 |
| 屏幕理解 / 视觉 | ✅ | 实时视觉理解，`qwen3-vl-plus` 等视觉模型 |
| 跨设备记忆同步 | 🚧 | 桌面已上线；iOS/Android 内测中（官网预约）；K.U.R.O. 独立游戏开发中 |
| 遥测 | ✅ 默认开 | Token 用量匿名上报，`DO_NOT_TRACK=1` 可关；Steam 版在 Steamworks 可用时会带 Steam64 |

---

## 5. 活跃度与版本节奏

- **最近 release**：v0.9.0《The Beginning of NekoVerse》，发布于 **2026-08-20**（wehos 发布）。
- **Nightly**：2026-09-16 自动构建，tag `20260916-bf65bef5`，31 个产物（Win/Mac×2/Linux AppImage+deb+tar.gz，另含纯 Python 后端包）。
- **版本路线图**（README「开发计划」段）：
  - v0.7 ✅ Agent 功能第一阶段完成
  - v0.8 ✅ 记忆 + 桌宠 + 双人小游戏
  - v0.9 ✅ 多系统适配（Linux/手机）+ 猫娘网络基础设施
  - v1.0 🚧 计划 9 月底正式版，**自研大模型计划已延期至正式版之后**
- **Steam 侧**：2026-01-30 上线 Early Access，发行商「喵可智能」。截至抓取日：
  - 总评测 **457 篇，89% 好评**（特别好评）
  - 近 30 天 **93 篇，94% 好评**（特别好评）
  - 免费开玩
- **Star 增长参照点**：TechNode 2026-07-20 报道时"超过 2,000 GitHub stars"；本次抓取 2026-09-21 为 **2,903** → 约 2 个月 +900 star，增速仍在爬坡。

来源：GitHub releases 页、Steam 商店页、TechNode 报道，抓取 2026-09-21。

---

## 6. Issue / 社区氛围

**重要信号：仓库已关闭公开建 Issue 权限**——issues 页面顶部明确写着 `Issue creation is restricted in this repository`。这是一个相对封闭的运营姿态，用户反馈主要被引导到 QQ 群（1092413003）、Discord、TapTap 论坛、Steam 评测。

仍能从公开索引看到的 open issue 样本：
- `#477 [Bug Report]: 无法启动 Steam 版猫娘计划`（2026-03-14，Open）
- `[Bug Report]: Debian+KDE 下 nightly 版本的 appimage 启动无法点击穿透`（Open）

外部社区抱怨点（来自搜索）：
- **NGA**：有用户发"启动出现致命错误"帖子，多人反馈 Windows/Mac 同 Steam 账号切换时云存档导致启动失败，换存档可解。
- **TapTap 官方论坛**（2026-08-28）："许多按钮还得自己鼓捣……扫了半天没找到声音暂停在哪，操作有点别扭"——官方回复"开发猫猫已经在优化中"。
- **Steam 评价**：整体好评率 89%/94%，负面集中在 Early Access 常见的启动/兼容性问题与 UI 不直观，没有大规模"骗钱/跑路"性质骂声。

**氛围判断**：核心团队响应快（TapTap 官方号当场回复），但**公开 issue 通道被收窄**，外部观察者难以看到真实 bug 全貌；社区活跃度主要沉淀在 QQ/Discord/Steam 评测，而非 GitHub。

---

## 7. 安装门槛

| 用户类型 | 路径 | 5 分钟能否装好 |
|---|---|---|
| 普通 Windows/macOS 用户 | Steam 商店页点安装（Early Access 免费） | ✅ 可以，Steam 一键装 |
| 普通用户（非 Steam） | GitHub Release 下载 zip / dmg / AppImage，解压双击 | ✅ 基本可以；macOS 需手动 `xattr -cr` 去隔离 |
| Linux 服务器用户 | Docker Compose 一行 `docker-compose up -d` | ✅ 可以，但 SSL / 端口 / 旧数据迁移文档非常长 |
| 开发者 | 克隆 + `uv sync` + Node ≥20.19 跑 `build_frontend.bat` + 起 3 个 Python 进程 | ❌ 明显超过 5 分钟；README 自己警告 `.git` 390 MB、推荐 `--filter=blob:none` 部分克隆 |

**前置条件**：
- 无论哪条路，都需要自备 LLM API Key（推荐阿里云百炼，新用户有免费额度）才能真正对话；开箱"免费模型"只是兜底。
- 实时语音要求核心 API 支持 Realtime API。
- 源码部署要求 Python **严格 3.11**，其他版本不支持。

**判断**：对"奶奶也能唤醒"的 slogan 而言，Steam 一键包确实做到了；但**真要用起来仍要过 API Key 这一关**，且 Docker 部署文档里那一大段"旧版挂载迁移"说明历史上已经踩过一次数据丢失坑。

---

## 8. 目标用户

从 README 语气、Steam 标签（实用工具 / 动漫 / 人工智能 / 声控 / 休闲 / 独立）、TapTap 板块、内置插件（QQ / 微信 / B 站 / 抖音 / 战雷 / 米家 / 网易云）综合判断：

- **主力用户**：中文互联网的二次元 / VTuber / AI 伴侣爱好者，18–30 岁，愿意为"陪伴感"付费时间而非付费软件。
- **次级用户**：想做桌宠 / AI 助手二次开发的极客与独立开发者（插件 SDK、角色卡导出、A2A 接入）。
- **明显不是**：企业用户、纯生产力 Agent 用户（官方主动划线"我们不是任务自动化工具"）。

---

## 9. 商业化与开源姿态

- **License**：核心 **Apache-2.0**（宽松，可商用、可闭源衍生）。
- **商业实体**：发行商「**喵可智能**」，组织 `Project-N-E-K-O` 运营 GitHub 与 Steam。
- **收入模型**：
  - Steam 本体**免费开玩**（Free to Play），Early Access。
  - **Steam 创意工坊 UGC**：用户上传角色 / 模型 / 语音包，官方未抽成（未看到分成说明）。
  - **喵宇宙社区（NekoVerse）**：v0.9.0 上线对话掉落卡片、融合、铸造、收藏——有明显的"数字收藏 / 元宇宙"叙事，但未看到付费点。
  - **独立游戏 K.U.R.O.**：基于 N.E.K.O. 生态的 AI Native 游戏，开发中，Demo 可下载——这是最像"付费产品"的方向。
  - **移动端**：iOS/Android 内测预约中，尚未定价。
- **姿态**：README 写"开源为驱动、charity-oriented UGC 平台"，强调"核心驱动器始终开源，你的贡献会实装到 Steam 和 App 商店正式版"。**未看到付费功能 / 高级订阅 / 云端黑盒服务**。
- **遥测争议点**：默认开 Token 用量遥测 + Steam64 上报，虽有 `DO_NOT_TRACK=1` 一键关，但"默认开"这一点在开源圈是会被挑的；README 用了一整段透明化说明（收集/不收集什么、HMAC 签名、限流）来公关，说明团队意识到了。

---

## 10. 明显短板 / 争议

1. **Issue 通道关闭**：`Issue creation is restricted`，外部贡献者和用户无法直接报 bug，只能进 QQ 群——对一个开源项目来说，这是把社区治理往私域搬，长期不利于外部贡献者上手。
2. **多服务架构 + 严格版本锁**：Python 3.11 一刀切、要起 3 个进程、要单独 build 前端、`.git` 390 MB——开发体验比"一个 Electron 壳"重得多。
3. **数据迁移坑**：Docker 部署 README 里用了巨大篇幅讲旧版双挂载导致数据丢失的迁移流程，说明历史上出过一次影响用户的事故。
4. **默认遥测**：即使透明化做得很好，"默认开 + Steam64" 仍会触发部分极客敏感。
5. **自研大模型延期**：v1.0 路线图里"自研大模型和智能体系统"已延期到正式版之后，目前完全依赖第三方 API（阿里/OpenAI/Google/Qwen 等），**模型层不握在自己手里**。
6. **Early Access 质量波动**：Steam 差评集中在启动失败、云存档冲突、UI 不直观；NGA / TapTap 都有对应帖子。
7. **多 Agent 叙事 vs 实现**：README 提"multi-agent technologies"，但架构上仍是**单角色 YUI + 工具调用 + A2A 调外部 Agent**，并没有内部多 Agent 并行编排——营销话术略超前于代码现实。
8. **星数与订阅比**：2903 star 但真正 watch/subscribe 只有 17，star/watch 比 ≈170:1，说明大量 star 是"赛博赛博收藏"，真正持续跟踪仓库的人很少。
9. **移动端 / 猫娘网络 / 独立游戏**都还在 🚧 状态，愿景（"AI 原生元宇宙""猫娘们自主社交"）远大于当前落地。

---

## 11. 与 Lumina（Electron 多 Agent 桌宠 + 三 Agent 团队 + 情感 + 记忆 + Computer Use + 沙箱）的核心差异点

> 对照对象：Lumina AI（用户当前项目，K:\2\Lumina AI）。

1. **Agent 编排范式不同**：N.E.K.O. 是"**单角色人格 + 工具调用 + A2A 调外部 Agent**"，本质上还是一个 YUI 在对你说话，干活时叫外部手脚；Lumina 是"**三 Agent 团队并行**"，内部就有多个 Agent 分工——这是架构哲学级差异，也是 Lumina 最该守住的叙事高地。
2. **技术栈与进程模型**：N.E.K.O. = Python 多服务（main_server / agent_server / memory_server 三进程）+ React/Vue 双前端 + Electron 壳，部署重；Lumina 若走 Electron 一体化，分发和调试成本会低一个数量级，但要承担"单进程内存/模型调度"的工程复杂度。
3. **主动性路线已经被 N.E.K.O. 跑通并做成卖点**：屏幕理解 + 热搜 + 个人动态 + 表情包 + 小游戏邀请，7 个信号源、可配最低间隔、未被回应自动收敛——**这正是"主动找你玩"的标准答案**。Lumina 若要做主动交互，不能只做"定时弹一句话"，必须对齐这一套信号源 + 收敛策略。
4. **生态位与商业化路径**：N.E.K.O. 已经踩过"GitHub 开源核心 + Steam 免费 + 创意工坊 UGC + 喵宇宙社区 + 独立游戏 K.U.R.O."这条完整路径，并且 Steam 457 评 / 89% 好评、2903 star 验证了需求真实存在；Lumina 作为后来者，**正面硬刚"猫娘"叙事没意义**，差异化应放在"三 Agent 团队协作"这一 N.E.K.O. 明确没做的点上（它自己都说"我们不是任务自动化工具"）。
5. **工程债与姿态可借鉴 / 可规避**：
   - 可借鉴：五维记忆的分层命名（工作/近期/事实/反思/人格）、Realtime + ChatCompletion 双通道、插件 SDK 装饰器 API、遥测透明化文档写法。
   - 要规避：关闭公开 issue 通道、`.git` 历史 390 MB、Docker 挂载变更导致数据丢失、默认开遥测——这四个坑 N.E.K.O. 都踩过，Lumina 早期就该在 CI 和文档上提前防。

---

## 附：主要来源

- 仓库主页：<https://github.com/Project-N-E-K-O/N.E.K.O>
- README.MD：<https://github.com/Project-N-E-K-O/N.E.K.O/blob/main/README.MD>
- GitHub API 元数据：<https://api.github.com/repos/Project-N-E-K-O/N.E.K.O>
- Releases：<https://github.com/Project-N-E-K-O/N.E.K.O/releases>
- 开发者文档：<https://project-neko.online/zh-CN/>、<https://project-neko.online/guide/dev-setup>、<https://project-neko.online/guide/install-options>
- 官方中文站：<https://project-neko.cn/>
- Steam 商店：<https://store.steampowered.com/app/4099310/>
- SteamDB：<https://steamdb.info/app/4099310/>
- TechNode 报道（2026-07-20）：<https://technode.com/2026/07/20/bilibili-showcases-n-e-k-o-an-ai-companion-that-can-interpret-desktop-content-and-initiate-conversations/>
- TapTap 官方论坛：<https://www.taptap.cn/app/881696/topic>
- NGA 启动报错帖：<https://bbs.nga.cn/read.php?tid=46468207>

> 全部数据抓取于 **2026-09-21 UTC+8**。
