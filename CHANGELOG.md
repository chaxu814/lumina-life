# 📝 Changelog — Lumina Life

## [Unreleased] — feature/v02-comprehensive-upgrade 🚀 发布前深度改造第二轮（2026-09-24）

> 基于用户实机截图诊断的 8 大问题逐项修复。目标：Live2D 能显示、团队能干活、任务工作区是真的、三平台可用、英语能用、游戏有边界。

### 🐛 P0 修复（A）
- **Live2D 不显示根因**：`loadFile(getRendererHtmlPath())` 把含 `?model=` 的路径当文件路径，`?` 被编码为 `%3F` 导致 ERR_FAILED。拆为 `getRendererHtmlFilePath()` + `loadPetHtml()` 用 `loadFile(path,{query:{model}})`，4 处调用全替换
- **postinstall**：预编译二进制检测、分平台工具链指引、失败降级、exit 0 不阻塞安装
- **vite 告警清零**：6 模块 redundant dynamic import 改静态引用，"will not move module" 告警 6→0
- **teamAutonomy 降噪**：30s 冷却、真实崩溃检测、console.debug 守卫、持久化计数器

### 🎮 游戏增强（B）
- **焦点鲁棒性** `focusWindowRobust()`：平台 focus→150ms 校验→重试→AppActivate 兜底→ESC 关弹窗
- **反作弊护栏**：12 款竞技网游黑名单（CS2/CoD/Valorant/PUBG/Fortnite/Apex 等），autoPlay 每轮检测命中即硬停
- **新增 Profile**：Stardew Valley、Civilization VI、generic 完善；gaming 测试 9 文件 101 例
- **autoPlay 质量**：minRoundsBeforeStop、consecutiveNoOpLimit、defaultDecide 带历史+should_stop

### 🖱️ 托盘菜单（C）
- 原生右键→自定义圆角浮层（仿 ATK X1 Ultra）：头像+状态+5 菜单项、失焦自动关闭、9 测试

### 👥 团队协作（D）
- **根因**：委托 prompt 被截断 50 字、context 传入但 fork 路径不用
- **修复**：delegationPrompt.ts 完整首轮消息（任务+历史+工具+项目+铁则），验证闭环 3 轮上限

### 📋 任务工作区（E）
- **根因**：AsyncTaskManager 事件无 webContents.send 转发，preload 监听器是哑的
- **修复**：agentIpc 转发 5 类事件、preload 新通道、store upsertRemoteTask、running 自动弹出、实时时间线

### 🌐 英语 i18n（F）
- en-US/zh-CN key 对齐，外置 TopBar/SettingsModal/ChatInputBar/SettingsLLM/SettingsTTS 硬编码中文，6 测试

### 🖥️ Linux/macOS（G）
- macOS：cliclick 降级+键码映射表修复；Linux：grim 探测+Wayland 识别；三平台能力矩阵；69 平台测试

### 💡 8 创新提案（H）
- `docs/innovation-proposals-20260924.md`（744 行），推荐 P0 主动推送→P1 主题/云同步/安全治理→P2 商城/无障碍→P3 分成/联邦

### 🐛 透明窗口修复（P0 追加）
- **根因**：getPetHtmlPath() 只比 mtime，git checkout/分支切换后源码 mtime 变旧，导致含实色渐变的旧 pet.html 副本永不刷新 → 深色不透明盒子
- **复制逻辑**：加文件大小比对（dstStat.size !== srcStat.size 即强制复制）+ dev 模式强制刷新，保证 git 回退后旧副本也能更新
- **条件实色底**：body 默认透明；仅当平台能力判定透明被关闭时，
esolvePetLoadTarget() 传 ?solid=1，HTML 内 JS 才施加 #15101f 兜底
- **compact toolbar**：小窗模式下工具栏 3 秒自动收起，悬停展开，离开再收起
- **已立即刷新用户副本**：pet-assets/pet.html 189055→183263 字节，body 恢复透明

### 🖱️ 拟人化鼠标移动（v0.2 追加）
- **根因**：cuCore/PlatformAdapter 的 click/hover 直接 SetCursorPos 瞬移，光标从 A 跳到 B，不像人操作
- **实现**：humanMouse.ts — buildHumanPath(easeOutCubic 缓动 + ±1.5px 随机抖动 + 8-15 步自适应)、humanMoveTo/humanClick/humanHover/humanDrag
- **点击前停顿**：60-140ms 随机停顿后再按下；拖拽走 mousedown→路径→mouseup 分步原语
- **极速模式**：LUMINA_CU_INSTANT_MOUSE=1 退回原瞬移；适配器无 getCursorPos/mouseDown 时自动降级
- **接入**：cuCore 的 cuClick/cuHover/cuDrag 默认走拟人化路径
- **测试**：18 例覆盖路径生成/instant模式/光标回退/拖拽原语/降级

### 🔌 LM Studio 实测发现（v0.2 追加）
- LM Studio 服务器开启了 LM_API_TOKEN 认证（/v1/models 返回 401），非"任意占位 key"
- lms chat CLI 可绕过 HTTP 认证直连模型（QwenPaw Flash 4B Q4 正常响应）
- onboarding 探测器已优化：401 时给出"关闭 API Key 认证或填入 Key"的友好提示
- Minecraft 已安装（26.1.2-Fabric，PCL2 启动器，LittleSkin 认证），但 VLM HTTP API 因认证阻断，完整视觉路线待用户关闭 LM Studio 认证后实测

### 🔬 6 项目对比新增（v0.2 追加）
- **LobsterAI**（网易有道，6068★）：Electron 桌面办公 Agent，外包 OpenClaw runtime，11 渠道 IM 远程控制，28 技能含 skin-creator 桌宠皮肤生成；无游戏/无 VLM 桌面操控/无社交引擎
- **minimax-code**（MiniMax，1815★）：纯终端 TUI coding agent，fork pi-mono，沙箱执行+BYOK 三协议+ACP；桌面 App 不开源，外部 PR 通道关闭

### 📊 验证
- tsc 0 错误 / 108 文件 1297 测试通过
---

## v0.2.0 — 8 创新提案全量落地（2026-09-24）

> 分支 feature/v02-comprehensive-upgrade，约 20 个 commit，新增 114 个单测

### 1. Live2D 配件商城
- 本地模型库扫描+热切换+model3.json 校验+恶意脚本扫描
- ModelStorePanel 卡片列表+导入+离线模式
- 后端模板 docs/templates/live2d-store-worker.js（Workers+R2）
- 支付预留 501 占位

### 2. 技能创作者运行时
- .lumina-skill 包格式（zip: skill.json+SKILL.md+index.js）
- vm 沙箱+白名单 API+越权拦截+路径防穿越
- 安装审批+动态注册工具+示例技能
- 支付/分成预留 pricing 字段

### 3. 团队记忆共享 Federation
- Level 1：手动导出/导入 JSON，来源标签+可信度 0-1
- Level 2：memory-pool-worker.js 模板（Workers+KV）
- Level 3：E2EE/P2P 仅架构文档（隐私红线，未实现）

### 4. 跨设备云同步 WebDAV
- 纯 fetch WebDAV 客户端（PROPFIND/PUT/GET/DELETE/MKCOL）
- SHA-256+mtime 增量同步+AES-256-GCM 客户端加密
- SQLite VACUUM 备份+冲突检测（本机/云端/合并）
- safeStorage 加密存储密码+设置 UI

### 5. 插件 Marketplace 治理
- @babel/parser AST 静态扫描（6 类规则，block/warn/pass 三级）
- RSA+SHA256 签名校验+离线威胁情报+typosquatting 检测
- 接入技能安装和模型导入流程

### 6. AI 主动推送（P0）
- 三维状态：fatigue/intimacy/luminaEnergy，衰减恢复曲线
- 欲望值决策（亲密度35%+精力25%+抗疲劳25%+时段15%）
- 冷却30min+每日上限5次+未响应降频+静默时段
- 只走桌宠气泡+侧边栏，不弹系统通知
- 设置 UI：开关/状态可视化/频率/时段/类型/立即触发

### 7. 无障碍语音交互
- PTT 语音闭环状态机（idle→recording→recognizing→speaking），支持打断
- Ctrl+Space 快捷键+冲突检测
- ARIA 标签+焦点陷阱+高对比度主题(≥7:1)+字号缩放(100/125/150%)
- Porcupine 唤醒词接入占位

### 8. 主题皮肤生态
- CSS 变量体系（bg/text/accent/border/shadow/bubble）
- .lumina-theme 格式+5 个内置预设
- 可视化主题编辑器（原生色盘+实时预览+保存导出）
- 桌宠气泡+托盘菜单跟随主题

### 📊 验证
- tsc 0 错误 / 121 文件 1410 测试通过（autoPlay 时序偶发波动，重跑通过）/ build 成功无告警
- 新增 114 个单测：推送20 + 数据同步22 + 无障碍19 + 市场生态38 + 主题15

### 诚实披露
- WebDAV/语音/麦克风真实环境未实机验证（mock+静态检查）
- 在线商城/记忆池需部署 Workers 模板
- 支付/签名需用户提供资质和密钥
- 部分边缘组件硬编码颜色未逐一迁移
（autoPlay 时序测试偶发波动，重跑通过）/ build 成功 / 25 commits

### ⚠️ 未实机验证
- Live2D 白屏、VLM 真实画面、焦点 AttachThreadInput、团队委托端到端、任务工作区 UI 滚动、mac/Linux 实机、dmg/AppImage 打包
## [Unreleased] — feature/crossplatform-gaming-onboarding 🚀 发布前大型改造（2026-09-23）

> 本分支将 Roadmap v1.1.0/v1.3.0 的多个特性提前实现，目标是发布前大幅提升竞争力。

### 🖥️ Computer Use 跨平台延伸（Linux + macOS）
- **平台适配器层**：`electron/core/platform/` 含 WindowsAdapter / MacAdapter（AppleScript+screencapture）/ LinuxAdapter（xdotool+Wayland 降级+grim/scrot 回退）
- **cuCore 全量走适配器**：click/hover/type/keyPress/scroll/drag/screenshot/openApp 全部委托 `getPlatformAdapter()`
- **能力矩阵**：`platformCapabilities.ts` 声明各平台 ✅/⚠️/❌，IPC `platform:get-features` 暴露前端
- **CI 三平台矩阵**：windows/macos/ubuntu × Node 20/22，含能力矩阵打印 step
- **测试**：平台相关 178 例全过（含新增 Mac 19例 / Linux 14例）
- **文档**：`docs/cross-platform-status.md`、`docs/INSTALL.md`

### 🎮 Minecraft 游戏能力（对标 AIRI）
- **双路线**：视觉路线（截图+VLM+CU 操作）+ 程序化路线（Mineflayer bot，可选动态 import）
- **4 个新工具**：`game_status` / `game_action`（14种动作）/ `game_look` / `game_chat`
- **安全双保险**：游戏护栏拦截危险命令 + SecurityGuard + cuCore 权限门
- **测试**：`tests/gaming/` 4 文件 53 例全过；文档 `docs/gaming-minecraft.md`

### 🎮 多游戏 Profile 框架（Minecraft + Factorio）
- **GameProfile 抽象**：`electron/gaming/profiles/` 把游戏逻辑从硬编码拆为 Profile 对象（窗口匹配/动作映射/安全规则/VLM 提示词/冷却）
- **Minecraft Profile 提取**：原硬编码逻辑 1:1 迁移为 `minecraftProfile`，行为完全一致
- **Factorio Profile（新）**：视觉路线，WASD/左键采矿建造/R 旋转/E 制作/` 聊天/Tab 地图；`/c` 执行 Lua 等危险命令被拦截
- **自动探测**：按窗口标题/进程名识别当前游戏，`LUMINA_GAME_PROFILE` 可显式指定
- **自主游玩闭环** `autoPlay.ts`：感知→VLM 决策→安全审查→执行，支持 maxRounds/超时/stopSignal/连续危险拦截
- **温馨安全提示** `safetyPrompt.ts`：首次开启游戏/自动游玩时友好提醒反作弊/多人礼仪/人在旁照看
- **第 5 个工具** `game_auto`：AI 限时自主游玩
- **文档**：`docs/gaming-overview.md` / `game-profiles-guide.md` / `game-safety.md`
- **测试**：新增 profiles/autoPlay/safetyPrompt 3 文件 32 例；gaming 总计 7 文件 85 例全过

### 👋 首次启动引导向导（Setup Wizard）
- **6 步引导**：欢迎→选 provider→配 Key/本地探测→可选 VLM→人格→完成
- **本地模型自动发现**：LM Studio(1234)/Ollama(11434) 探测，3s 超时
- **零门槛**：LM Studio 在线跳过 Key；云端内嵌免费 Key 指引；VLM 自动检测
- **测试**：`tests/onboarding/` 2 文件 23 例

### 🧩 自定义 Agent 创建（提前 v1.1.0）
- **配置格式**：`agents/custom/<id>/agent.json` + SOUL.md + PROFILE.md + MEMORY.md
- **管理器**：CRUD + 路径穿越防护 + 注册到 teamManager
- **团队角色**：leader（对用户可见）/ member（后台可委托）/ solo（独立）
- **完整 UI**：`CustomAgentPanel.tsx`（列表/创建/编辑/删除/设默认）
- **测试**：`tests/customAgent/` 3 文件 21 例；文档 `docs/custom-agent-guide.md`

### 📦 跨平台部署与原生依赖优化
- macOS hardenedRuntime + entitlements（辅助功能/屏幕录制）；Linux AppImage+deb
- postinstall 失败时输出分平台工具链指引；mineflayer 标记 optional+external
- `docs/TROUBLESHOOTING.md` §16 原生依赖编译指南

### 🔤 UTF-16 → UTF-8 转码
- 6 个文件全部转 UTF-8（AGENTS/MEMORY/PROFILE/SOUL_LUMINA/SOUL_RECHA/SOUL_YAK）
- `loadMdFile()` 已有编码自动检测，无需代码修改

### 📊 验证
- 类型检查零错误 / 97 文件 1170 测试通过 / `npm run build` 成功 / 16 commits

### ⚠️ 未实机验证
- macOS 授权流程、Mac 键码映射、Linux Wayland 抓屏、dmg/AppImage 打包
- Minecraft 真实画面 VLM 识别、Mineflayer 真实连接
- onboarding 真实 Electron 渲染、自定义 Agent 端到端委托

## [0.1.0] — 2026-09-15 🌱 首个公开预览版（开发中）

### 本次收口（v0.1 发布准备）
- 🫀 **连续情绪融合**：LLM 逐帧情绪与连续情绪状态做指数平滑 / 变化率限制 / 迟滞，避免上一句笑、下一句哭的硬切
- 🔌 **OpenClaw 桥接**：新增 A2A/MCP 客户端与 `openclaw` 渠道适配，作为可选外部执行后端；未配置时自动回退现有实现
- 🎙️ **可打断实时语音（barge-in）最小闭环**：TTS 播放中检测用户插话即停播转听（能量阈值 + 连续帧确认 + 冷却防抖）
- 🐱 **Live2D 形象 UGC 导入器**：校验 `*.model3.json`、复制注册自定义模型
- 🔀 **统一模型调用层**：归一多供应商消息 / 错误 / 模型列表，一处接入多家
- 🔒 **密钥治理**：忽略本地 `agents/`（含 API Key/内网地址），导出三套脱敏角色模板到 `src/assets/agentTemplates/`
- 📝 文档口径对齐代码：情绪分层表述、工具数按注册表核准为 70+、版本状态标注

### 🐾 v6.2 互动性 / 视觉 / 记忆增强（发布前）
- 👁️ **真·屏幕视觉恢复**：屏幕观看从 v6.1 的“只读窗口标题粗分类”恢复为 **截图 → VLM 识别具体游戏/应用名**（dHash 节流，画面不变不产生调用）；她现在知道你在打什么游戏、看什么视频，而不只是“在打游戏”。
- 💬 **精彩瞬间快速反应**：VLM 判定画面值得搭话时，用桌宠脑模型生成 20 字即时反应并带 Live2D 动作 / 口型（原有秘书通道保留）。
- 👀 **全屏注视**：主进程每 100ms 推送全局鼠标位置，Live2D 与 VRM 的眼睛**持续跟随**（窗口外也能看），静止时偶尔飘眼、回中；`fullscreenTrack` 默认开启。
- 🗣️ **主动更勤**：主动搭话最小间隔 10 分钟 → 2 分钟，日上限 20 → 80；游戏场景搭话概率 0.5 → 0.85，打一局游戏不再只说一句。
- 🧠 **真·混合记忆召回**：`hybridMemoryRetrieval` 从“仅 BM25、向量分支为空”补齐为 **BM25 词法 + TF-IDF 向量余弦双路召回、RRF 融合**（零依赖、CJK 友好）；dense 语义向量仍为可选进阶。
- 🎭 **VRM 对齐 Live2D**：补齐五元音口型（A/I/U/E/O → aa/ih/ou/ee/oh）与 `lookAt` 视线跟随（原仅单一 `aa`、无眼动）。
- 🎙️ **可打断实时语音**：barge-in 全双工链路已完整（本地能量 VAD + 回声消除 + 即时打断），开启 AI 语音时给出全双工引导；真正的 Realtime API 双向流（≈200ms）列入 Roadmap。

> 下方 [1.0.0] 为 2026-07 的内部开发里程碑编号；首个对外公开版本改按语义化版本从 **0.1.0** 起步。

## [1.0.0] — 2026-07-03 🎉（内部开发里程碑）

> **正式版发布！** 三 Agent 团队协作桌宠，带着情感、记忆和 Computer Use 与你见面。

### ✨ 核心功能

#### 🧠 三 Agent 团队协作
- **Lumina 🐱** — 团队老大，用户唯一交互入口，温暖可爱
- **热茶 🍵** — 毒舌技术宅，代码审查与调试
- **Yak 📊** — 冷静分析师，搜索与研究
- Agent 背靠背协作：用户只和 Lumina 对话，Yak/热茶在后台工作
- `delegate_chain` 流水线：写代码 → 自动审查 → 自动修复

#### 😊 情感系统
- 5 维情绪追踪：开心 · 疲劳 · 专注 · 焦虑 · 好奇
- 情绪可视化：表情和状态随对话实时变化
- Agent 间亲密度系统，互动自然演化
- 主动搭话：在你发呆/长时间工作后主动关心

#### 📚 记忆系统
- SQLite 持久化（事实/反思/人格/对话）
- 向量语义检索（支持本地 embedding 服务）
- 证据链 + 置信度评分
- 自动精炼（定时清理低质量记忆）
- 记忆剧场：可视化浏览回忆

#### 🖥️ Computer Use
- 屏幕截图 → VLM 理解 → 鼠标/键盘操作
- 屏幕感知：看到你在写代码 → 自动提出优化建议
- "帮我把这个文件拖到桌面上" → 她真的会操作

#### 🛡️ 分级安全审查
- 7 级严重度 × 8 类威胁
- 密钥/Token 泄露拦截
- 破坏性操作确认（rm、格式化等）
- 外部发布审核（邮件、推文需确认）

#### 💬 团队社交生活
- Agent 群聊：Lumina、热茶、Yak 自发聊天
- 早安仪式：每天早上同步日程
- Moments（朋友圈）：记录 Agent 状态和想法
- 亲密度演化：关系随互动自然变化

#### 🎭 4 种人格模式
| 模式 | 风格 | 场景 |
|------|------|------|
| Lumina（默认）🐱 | 活泼可靠 | 日常使用 |
| 工作助手 💼 | 干练高效 | 编码/分析/项目管理 |
| 闲聊伙伴 ☕ | 温暖随和 | 放松聊天 |
| 创意助手 🎨 | 发散思维 | 头脑风暴/写作 |

### 🔧 工具与集成

- **88+ 内置工具**: 搜索、浏览器、文件操作、代码审查、终端、截图、定时任务、天气、邮件、翻译、OCR、语音输入、TTS、通知、记忆管理
- **MCP 协议支持**: 兼容 Model Context Protocol
- **Skill 系统**: 内置 7 个技能，支持商店安装/卸载
- **CLI 命令行**: 9 个子命令（chat、tool、agent、memory、config、skill、cron、doctor）
- **REST API**: 零依赖 HTTP 服务，支持健康检查、聊天、工具执行
- **Plugin SDK**: 插件开发支持

### 🖥️ UI 面板（23 个）

聊天 · 邮件 · 设置 · Agent · 安全 · 技能 · 用量 · 任务 · 桥接 · 个人资料 · 书签 · 知识库 · 技能市场 · 深度研究 · 梦境 · 真人秀 · 技能开发 · 社交 · 家谱 · 测试覆盖 · 团队 · Bridge · GroupChat

### 🏗️ 技术栈

| 层 | 技术 |
|---|------|
| 桌面框架 | Electron 40 |
| 前端 | React 19 + TypeScript + Vite |
| 状态管理 | Zustand 5 |
| 构建打包 | electron-vite + electron-builder (NSIS) |
| 数据库 | better-sqlite3 |
| 测试 | Vitest |
| 自动更新 | electron-updater (GitHub Releases) |
| 协议 | MCP (Model Context Protocol) |
| 开源协议 | AGPL-3.0 |

### ✅ 已知问题

- **仅支持 Windows 10+**（macOS/Linux 在 Roadmap）
- 测试导入兼容性：`teamManager.test.ts` / `delegation.test.ts` 需要 Persona 常量导出
- `tokenEstimator.needsWarning()` 阈值测试需显式传入 `warningRatio`

---

## [1.0.0-beta] — 2026-06

> 内部测试版本，核心引擎验证

### 新增
- Agent Runner v3.8 重构完成
- 记忆系统统一入口（unified.ts）
- 社交引擎首次上线

---

## [0.x] — 开发阶段

> 早期原型与迭代，不做详细记录

### 里程碑
- ✅ 单 Agent 对话
- ✅ 多 Agent 协作框架
- ✅ 工具系统 v1
- ✅ Electron 基础壳
- ✅ 情感系统原型
- ✅ 记忆系统初版
- ✅ 安全审查体系
- ✅ NSIS 安装包打包

---

> 完整的发布版本和下载链接见 [GitHub Releases](https://github.com/chaxu814/lumina-life/releases)。
