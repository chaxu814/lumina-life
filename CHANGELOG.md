# 📝 Changelog — Lumina Life

## [1.0.0] — 2026-07-03 🎉

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

> 完整的发布版本和下载链接见 [GitHub Releases](https://github.com/lumina-life/lumina-life/releases)。
