# cc-haha 深度调研报告

> 调研对象：https://github.com/NanmiCoder/cc-haha
> 抓取时间：2026-09-21（北京时间，Asia/Shanghai）
> 数据来源：GitHub 仓库主页 / GitHub REST API / Releases / README（中英双语）/ 第三方评测与作者公开内容

---

## 一、项目定位与一句话简介

**cc-haha（Claude Code Haha）= 一个本地优先、跨平台的「Claude Code 桌面工作台」**，本质上是把 Anthropic 官方的 Claude Code CLI 套上一个 Electron/Tauri 的 GUI 壳，并在壳里塞了多会话、多模型、多 Agent、Git Worktree、Diff 审阅、MCP/SubAgent 可视化管理、Computer Use、技能市场、IM 远程审批、H5 远程访问、定时任务、桌宠彩蛋等一整套周边。

- **官方 slogan**（仓库 description）：
  > Local-first cross-platform desktop workspace for Claude Code / agents: multi-agent, Git worktrees, code diffs, skill marketplace, multi-model, Computer Use, task-aware desktop pets, with WeChat, Feishu, DingTalk, Telegram, WhatsApp and H5 access.
  > 来源：https://github.com/NanmiCoder/cc-haha
- **不是什么**：它不是 Live2D 桌宠本体，不是通用 AI 助手，也不是 web 应用——桌宠只是其中一个 task-aware 反应型彩蛋功能。
- **作者**：NanmiCoder（GitHub 显示名「程序员阿江-Relakkes」，relakkes@gmail.com，新加坡，B 站 434377496），另一个知名项目是 **MediaCrawler**（自媒体爬虫，约 57k stars，2026-07 数据）。

来源：
- https://api.github.com/repos/NanmiCoder/cc-haha（抓取 2026-09-21）
- https://github.com/NanmiCoder?tab=repositories
- https://space.bilibili.com/434377496/video

---

## 二、实时数据（GitHub REST API，2026-09-21 抓取）

| 指标 | 数值 | 备注 |
|---|---|---|
| Stars | **14,454** | 半年项目（2026-03-31 创建） |
| Forks | **8,545** | fork/star ≈ 59%，异常高 |
| Watchers（真正订阅） | **56** | 远低于 star 数，典型「点完就跑」 |
| Open Issues | 122（UI）/ 172（API，含 PR） | 另 60 个开放 PR |
| Commits | 2,051 | 几乎全部由 NanmiCoder 单人提交 |
| 创建时间 | 2026-03-31 | 距今约 5 个半月 |
| 最新 Release | **v0.6.5**（2026-09-20） | 抓取前一天刚发 |
| 主语言 | TypeScript | 100% 前端/桌面技术栈 |
| 开源协议 | **MIT** | 仓库根目录 LICENSE |
| Homepage | cchaha.ai | 独立站，已从 cchaha.cc-haha 迁移 |
| Topics | agent, ai, ai-agent, anthropic, claude, claude-code, coding-agent, computer-use, desktop-app, **electron**, llm, mcp, react, typescript | |

来源：
- https://api.github.com/repos/NanmiCoder/cc-haha
- https://github.com/NanmiCoder/cc-haha/commits/main
- https://github.com/NanmiCoder/cc-haha/releases

**第三方交叉验证**（抓取时间）：
- skillsllm.com（2026-07-29）：14,457 stars
- ngjoo.com（2026-08-20）：14,652 stars
- repositorystats.com（2026-09-18）：14,609 stars
→ 近两个月 star 增速已明显放缓（约 +200/月），从早期「爆发期」进入「平台期」。

---

## 三、目录结构与应用形态

根目录关键项（来自 https://github.com/NanmiCoder/cc-haha）：

```
cc-haha/
├── adapters/            # 模型/Agent 适配器
├── bin/                 # CLI 入口（./bin/claude-haha）
├── desktop/             # ★ 桌面客户端（Tauri 2 + React）
│   ├── electron/        # 历史 Electron 壳（仍在）
│   ├── src-tauri/       # 新 Tauri 壳
│   ├── src/             # React 前端
│   ├── sidecars/        # 内嵌 CLI sidecar
│   └── build/scripts/   # 平台打包脚本
├── docs/                # 文档
├── native/cu-helper/   # ★ Computer Use 原生辅助（Rust/Native）
├── runtime/             # CLI/服务端运行时
├── src/                 # 主进程/共享 TS 代码
├── scripts/  tests/  fixtures/
├── release-notes/  site/
├── preload.ts           # Electron preload（遗留）
├── bun.lock / package-lock.json / pnpm-lock.yaml   # ★ 三套锁文件并存
└── package.json / tsconfig.json / .env.example
```

**应用形态判断**：
- 主形态是 **桌面 App**（macOS / Windows / Linux 全平台安装包，dmg/exe/AppImage/deb/rpm）
- 同时内嵌一个 **CLI**（`./bin/claude-haha`）和一个本地 sidecar 服务
- 提供 **H5 远程访问**（扫码后手机浏览器继续会话）
- 通过 IM 机器人提供 **远程审批/触发**（不是 IM 机器人本体）

**关键判断**：项目正处在 **Electron → Tauri 2 迁移期**——根目录 topics 还挂着 `electron`，但 `desktop/README.md` 明确写「基于 Tauri 2 + React 的桌面客户端」，且 `desktop/` 下同时存在 `electron/` 和 `src-tauri/` 两套目录。包管理也同时有 bun / npm / pnpm 三套锁文件，迁移未干净收尾。

来源：
- https://github.com/NanmiCoder/cc-haha/tree/main/desktop
- https://github.com/NanmiCoder/cc-haha（根目录文件列表）

---

## 四、技术栈细节

| 层 | 选型 |
|---|---|
| 桌面壳 | **Tauri 2**（新）+ Electron（旧/兼容） |
| 前端框架 | **React** + Vite + TypeScript |
| 测试 | Vitest + ESLint |
| 包管理 | **Bun** 为主（bun.lock），保留 npm / pnpm 锁文件 |
| 原生侧 | `native/cu-helper/`（Computer Use 原生辅助，Rust/Native） |
| 渲染/桌宠 | 普通 2D 动画精灵（**非 Live2D、非 3D**） |
| 模型接入 | OpenAI 兼容协议 + 各家 SDK；v0.6.5 新增「OpenCode Go 订阅」本地代理分流 GLM/Kimi/MiniMax/Qwen/Grok/GPT |
| 协议 | MIT |
| CI | GitHub Actions（release 由 github-actions bot 自动发布） |

**桌宠真相**：README/llms.txt 列出 4 个内置桌宠 **Dada / Huhu / Bubu / Huihui**，定位是「task-aware desktop pets that react to task state」——也就是随 Agent 任务状态（思考中/工具调用/完成/失败）切换表情与动作的 2D 小动画，**不是 Live2D 形象、不支持用户自定义模型、不带 STT/TTS 语音对话**。这一点和 Copiwaifu、Open-LLM-VTuber 那类「真·Live2D + 语音」桌宠是两条赛道。

来源：
- https://www.everydev.ai/tools/claude-code-haha/llms.txt
- https://desktop/README.md（desktop/ 目录）
- https://github.com/NanmiCoder/cc-haha/releases（v0.6.5）

---

## 五、核心功能矩阵

| 能力 | 是否具备 | 说明 |
|---|---|---|
| 桌面应用 | ✅ | macOS / Windows / Linux 三端安装包 |
| 多会话 / 全局搜索 | ✅ | 多 session 工作台 |
| Git Worktree / 分支启动 / Diff Review | ✅ | 核心卖点之一 |
| 内置浏览器预览 | ✅ | 改完代码当场在 App 内验证 |
| GUI 权限审批 | ✅ | 把 CLI 的 y/n 提示换成按钮 |
| 多模型切换 | ✅ | Claude / ChatGPT / Grok / 自定义预设 / 本地端点；v0.6.5 新增国产模型订阅供应商 |
| 图片生成 | ✅ | README 明确列出 |
| MCP / SubAgent 可视化管理 | ✅ | GUI 管理 MCP server 与 SubAgent |
| 多 Agent（Agent Teams） | ✅ | 「Agent Teams 协作工作台」「Workflow 编排」 |
| Memory | ⚠️ 未在 README 突出 | 走 Claude Code 自身机制，没有看到独立 memory 产品化 |
| Skills / Plugins / MCP 市场 | ✅ | 「技能市场」展示来源与安全状态 |
| 模型请求 Trace | ✅ | model trace / 模型请求追踪面板 |
| Computer Use | ✅ | 有专门 native/cu-helper 目录 |
| 语音 STT/TTS | ❌ | README 未提及 |
| Live2D / 3D 形象 | ❌ | 仅 2D 动画精灵 |
| 桌宠（task-aware） | ✅ | 4 个内置 2D 角色 |
| 主动交互 | ⚠️ 被动为主 | 桌宠随任务反应，未见「主动开口找人」 |
| IM 集成 | ✅ | WeChat / Feishu / DingTalk / Telegram / WhatsApp |
| H5 远程访问 | ✅ | 扫码手机继续会话 |
| 定时任务 / 用量统计 | ✅ | README 明确列出 |
| 多主题 | ✅ | 6 套配色 |

来源：
- https://github.com/NanmiCoder/cc-haha（README 英文）
- https://github.com/NanmiCoder/cc-haha/blob/main/README.zh-CN.md
- https://www.everydev.ai/tools/claude-code-haha/llms.txt

---

## 六、活跃度与 commit 节奏

- **2051 commits / 5.5 个月** ≈ 日均 12 次提交，密度极高。
- 最近 commit（抓取当日前后）：
  - 2026-09-20：`fix: complete AruHub model mappings and limit sponsor star`
  - 2026-09-20：`feat: add AruHub sponsor and provider preset`
  - 2026-09-20：`release: v0.6.5`
  - 2026-09-19：`merge: integrate model selection race fix`
- **几乎所有 commit author 都是 NanmiCoder 本人**——bus factor = 1。
- Release 节奏：v0.6.4 → v0.6.5 在一周内，版本号仍在 0.x，未到 1.0。
- Issue 氛围：仓库已开启 **「Issue creation is restricted」**（不允许任意人提 issue），用户群被引导到「企业微信群」+ 飞书文档 + 邮件联系。第三方抓取到的常见抱怨集中在：
  - 依赖 npm 高危 CVE（fast-uri 路径穿越、fast-xml-builder 注入）——来源 skillsllm.com 扫描
  - Windows 未签名安装包触发 SmartScreen
  - 部分功能文档缺失、部署信息不全——来源 ngjoo.com 评测
  - 历史上曾因安全信任危机上过 B 站热门（作者视频《知名开源项目被骂有木马，我真的破防了》）

来源：
- https://github.com/NanmiCoder/cc-haha/commits/main
- https://skillsllm.com/skill/cc-haha
- https://www.ngjoo.com/en/trending/projects/cc-haha/
- https://www.bilibili.com/video/BV1NrNJ6yELW/

---

## 七、安装门槛评估

**对普通用户**：
- ✅ 有现成安装包（dmg / exe / AppImage / deb / rpm），覆盖 macOS arm64/x64、Windows x64/arm64、Linux x64/arm64
- ✅ 首次启动只需在 Settings 填模型提供商 + API Key + 默认模型
- ⚠️ Windows 安装包**未签名**，会触发 SmartScreen，需手动「更多信息 → 仍要运行」
- ⚠️ macOS 临时包需要 `xattr -cr` 放行
- ⚠️ 国内网络下，模型 API 仍然要用户自备 Key（或用赞助商 AruHub/Atlas/ApiSmart 这种中转）

**从源码跑**：
```
git clone https://github.com/NanmiCoder/cc-haha.git
cd cc-haha && bun install
./bin/claude-haha
```
桌面端开发：`bun run tauri dev`。**5 分钟装好可行**，但前提是用户已经懂 Claude Code CLI、知道 API Key 怎么来。**真·小白用户仍然过不去「API Key + 付费模型」这道门槛**。

来源：
- https://cchaha.ai/en/
- https://github.com/NanmiCoder/cc-haha/releases

---

## 八、目标用户画像

从 README 语气、双语支持、企业微信群、飞书文档、赞助商结构判断：

1. **中文开发者**（核心盘）——已经在命令行用 Claude Code / Codex，但嫌 CLI 太糙，想要 GUI、Diff、多会话、远程审批。
2. **用国产模型 / API 中转的人**——v0.6.5 的「OpenCode Go 订阅供应商」、三家赞助商（AruHub / Atlas Cloud / ApiSmart）全是 API 聚合/中转，说明作者非常清楚用户是「买不起官方便宜订阅、要靠中转」的中国开发者。
3. **AI Coding 重度用户**——Agent Teams、Workflow、Computer Use、技能市场这些功能不是给新手用的。
4. **不是**：纯二次元桌宠爱好者、普通办公族、Live2D/VTuber 圈子。桌宠是「工程师的小彩蛋」，不是产品核心。

---

## 九、商业化与开源姿态

- **协议**：MIT，完全开源，桌面端 + CLI kernel 都免费。
- **没有付费版**：README 未提 Pro / 订阅，作者在 everydev 上的口径也是「Open Source / Free」。
- **收入模型**（从 README 推断）：
  1. **API 中转赞助**：AruHub、Atlas Cloud、ApiSmart 三家都是 AI API 聚合服务，README 直接给专属注册链接 + 推荐返佣，本质是「API 分销」。
  2. **企业定制**：README 末尾明确「企业定制 / 私有化部署 / Agent 定制需求，请联系作者」。
  3. **打赏**：中文 README 末尾有「☕ 请作者喝杯咖啡」。
  4. 作者另站 `yunagent.ai`，以及 MediaCrawler（57k stars）带来的个人品牌变现。
- **作者调性**：典型中文独立开发者 + B 站知识区 UP 主路线，作品密集出视频讲解，强运营、强社群（企业微信群）、强赞助位。

来源：
- https://github.com/NanmiCoder/cc-haha（赞助表）
- https://www.everydev.ai/developers/nanmicoder
- https://www.yunagent.ai（作者主页）

---

## 十、明显短板与争议

1. **合规 / 法律风险（最大雷）**：第三方文章 teum.io 直接称其为「Claude Code 泄露源码反向工程」，README 自己也写「原代码版权归 Anthropic，仅供学习研究」。MIT 协议能保护自己写的壳，但**底层 CLI 是否合法再分发，完全取决于 Anthropic 的态度**——随时可能被 DMCA 下架，或被要求删除重写。
2. **bus factor = 1**：2051 commits 几乎全是 NanmiCoder 一人，Issue 又设了准入门槛，社区贡献通道窄。一旦作者停更，项目会立刻失速。
3. **Windows 安装包未签名**：v0.6.5 仍因 SignPath 审批未完成而未签名，普通用户面对 SmartScreen 警告会直接劝退，也放大「是不是有木马」的信任成本。
4. **数据层早期 bug 严重**：v0.6.5 release note 自曝「542 MB 响应压到 40 MB」「DeepSeek 会话被统计成 4000 万 tokens」「Unexpected end of JSON input」——说明 0.5.x ~ 0.6.x 之前的版本在大会话上是不可用的。
5. **工程一致性差**：Electron → Tauri 迁移未收尾，根目录同时存在 `bun.lock` / `package-lock.json` / `pnpm-lock.yaml` 三套锁文件，topics 里还挂着 electron。
6. **依赖安全债**：fast-uri 路径穿越、fast-xml-builder 注入等高危 npm CVE 仍未清理（第三方扫描结果）。
7. **fork/star 比异常高（59%）**：正常开源项目该比例在 5–10%。这种「Fork 比 Star 涨得快」的形态，典型出现在**用户拿 fork 改配置 / 接自己 API Key / 二次分发**的项目上——既说明产品有真实使用粘性，也说明中心化的版本治理压力大。
8. **信任史**：作者曾公开抱怨「知名开源项目被骂有木马」，说明项目在 Windows 未签名阶段经历过一轮安全舆论危机。
9. **功能堆砌但深度存疑**：桌宠、IM、H5、定时任务、技能市场、Agent Teams、Computer Use……半年内铺得极广，但第三方评测（ngjoo）已经指出「部分功能缺详细文档、部署信息有限」——有「功能列表好看、用起来要靠群里问」的风险。

---

## 十一、一句话定位

> **cc-haha 是「Claude Code 的国产 GUI 皮 + 周边工具集」：用 Tauri/React 把官方 CLI 包装成一个多会话、多模型、多 Agent、可远程审批的桌面工作台，并靠 API 中转赞助和企业定制变现，桌宠只是彩蛋。**

---

## 十二、相对 Lumina 的核心差异点

> 以下对比基于本仓库调研，Lumina 侧按你方项目语境（桌面 AI 助手 / 桌宠方向）做推断。

1. **核心定位不同**：cc-haha 是「**编码 Agent 的工作台外壳**」，桌宠是附属彩蛋；Lumina 若以桌宠/陪伴为中心，则 cc-haha 反而是「Lumina 想要的桌宠 + 编码 Agent」的反面——它把编码当主菜、桌宠当调味。
2. **形象深度不同**：cc-haha 的桌宠是 4 个 2D 精灵、无 Live2D、无语音、无自定义模型；Lumina 若押注 Live2D/3D + 语音 + 人格，这是 cc-haha 完全没做的纵深。
3. **模型中立 vs 模型依附**：cc-haha 强绑定 Claude Code CLI，本质是「官方 CLI 的 GUI 化」，合规风险高；Lumina 若走模型中立、本地优先、可替换，长期可控性更强。
4. **商业化路径不同**：cc-haha 走「开源免费 + API 中转赞助 + 企业定制」的开发者路线，收入高度依赖三家 API 赞助商；Lumina 若面向 C 端陪伴/桌宠，商业模式（订阅、角色 DLC、皮肤）和它完全不撞车。
5. **社区与工程成熟度**：cc-haha 半年做到 14.4k star、2051 commits、全平台安装包，工程节奏和传播能力极强，但 bus factor = 1、Windows 未签名、数据层刚修大 bug；Lumina 可以借鉴它的「双语 README + 企业微信群 + 高频 Release + 赞助位排版」运营打法，但要避免「功能堆得快、签名/安全/文档跟不上」的坑。

---

## 附录：关键来源清单

- 仓库主页：https://github.com/NanmiCoder/cc-haha （抓取 2026-09-21）
- GitHub API：https://api.github.com/repos/NanmiCoder/cc-haha （抓取 2026-09-21，stars=14454, forks=8545, created_at=2026-03-31）
- 中文 README：https://github.com/NanmiCoder/cc-haha/blob/main/README.zh-CN.md
- 桌面端 README（Tauri 2 + React）：https://github.com/NanmiCoder/cc-haha/tree/main/desktop
- 最新 Release v0.6.5：https://github.com/NanmiCoder/cc-haha/releases （2026-09-20）
- 官网：https://cchaha.ai/en/
- 作者主页（NanmiCoder / 程序员阿江-Relakkes）：https://github.com/NanmiCoder?tab=repositories
- 作者 B 站：https://space.bilibili.com/434377496/video
- 争议报道（teum.io）：https://teum.io/en/stories/692f0c01-9cce-486c-a6df-bb8557f618ea
- 第三方评测（everydev）：https://www.everydev.ai/developers/nanmicoder
- 第三方功能清单（everydev llms.txt）：https://www.everydev.ai/tools/claude-code-haha/llms.txt
- 安全/依赖扫描（skillsllm）：https://skillsllm.com/skill/cc-haha
- 第三方数据交叉（ngjoo, 2026-08-20）：https://www.ngjoo.com/en/trending/projects/cc-haha/
