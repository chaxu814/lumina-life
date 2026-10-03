# 竞品对比 · BENCHMARKS

> 采集时间：**2026-10-03**（GitHub REST API 实测）
> 方法：`api.github.com/repos/*` 取元数据，官方 docs 站与 README 取架构描述。
> 抓不到的字段一律标注「未获取到」，不做推测。
>
> **立场声明**：这份文档会主动写出「别人比我们强的地方」。夸大对标结论既不真实，
> 也容易在社区被拆穿。读者应该能据此判断我们要不要继续做这件事。

---

## 一、总览

| 项目 | Star | Fork | 语言 | 协议 | 周均提交 | 形态 |
|---|---:|---:|---|---|---:|---|
| [openclaw](https://github.com/openclaw/openclaw) | **391,213** | 82,236 | TypeScript | MIT | **2,004** | Gateway 服务 + 5 端原生 App |
| [AIRI](https://github.com/moeru-ai/airi) | 49,956 | 4,983 | TypeScript | MIT | 57 | Web + 桌面 + 移动 |
| [cc-haha](https://github.com/NanmiCoder/cc-haha) | 14,849 | 8,595 | TypeScript | MIT | 42 | Electron 桌面 + CLI |
| [N.E.K.O](https://github.com/Project-N-E-K-O/N.E.K.O) | 3,009 | 337 | Python | Apache-2.0 | 60 | Steam + 桌面 + Docker + 移动内测 |
| **Lumina（本文）** | — | — | TypeScript | AGPL-3.0 OR Apache-2.0 | ~30 | 仅 Windows 实机验证 |
| [MiniMax Code](https://agent.minimax.cn/docs/code/welcome) | 未获取到（闭源） | — | — | 商业闭源 | — | 桌面 + CLI + Headless + ACP |

**量级提示**：openclaw 成立不到 11 个月已达 39 万星、周均 2,004 次提交，由独立的
OpenClaw Foundation（501(c)(3)）治理，捐助方含 OpenAI / Amazon / NVIDIA / Red Hat。
cc-haha 成立不到 7 个月已达 1.5 万星，且 **fork/star = 0.58**（远高于同行，说明
大量用户在自建分支）。这是一个头部项目以每周数千次提交推进的赛道。

---

## 二、重叠度与竞争关系

| 项目 | 与 Lumina 的重叠 | 性质 | 一句话定性 |
|---|---:|---|---|
| **N.E.K.O** | **~85%** | 🔴 **唯一直接对手** | 同样是有主动性、有记忆、有形象的桌面 AI 伴侣 |
| **AIRI** | ~55% | 🟠 形象层竞争 | 形象工程更强，但它的记忆还没做完 |
| **MiniMax Code** | ~45% | 🟡 能力对标 + 注意力竞争 | 功能集最接近的闭源产品，但没有脸 |
| **openclaw** | ~30% | 🔵 **上游标准制定者** | 定义了「AI 助手可达性」的基础设施规范 |
| **cc-haha** | ~25% | 🔵 工程参考书 | 服务人群与我们几乎不重叠 |

---

## 三、逐个拆解

### 🔴 N.E.K.O —— 唯一真正的直接竞争对手

**它是什么**：Python 3.11 + FastAPI 后端，Electron 壳，五种 Avatar（Live2D / VRM /
MMD / PNGTuber / 猫咪桌宠），已上架 **Steam** 并开了创意工坊，Docker 一键部署，
移动端内测中。

**它最强的地方 —— 记忆系统的工程深度**：

`memory/` 目录有 **35+ 个 Python 模块**，不是概念演示：

| 能力 | 模块 |
|---|---|
| 证据链 | `evidence.py`、`evidence_handlers.py`、`evidence_analytics.py` |
| 混合召回 | `hybrid_recall.py` + 独立后台 `embedding_worker.py` + fallback |
| 人格自我修正 | `persona/refinement.py`、`persona/fusion.py`、`persona/corrections.py` |
| 说话人信任 | `speaker_trust.py`、`trust_store.py` |
| 复读治理 | `anti_repeat.py`、`anti_repeat_effects.py` |
| 记忆校对 UI | `/memory_browser` 供用户浏览与纠错 |

> 📌 **这直接影响我们的定位判断**：它的「证据链 + 混合召回 + 人格自我修正」
> 与我们的设计哲学**高度同构**。README 里「记忆系统」这一项**不是我们的护城河，
> 是行业共识**。真正的差异化只剩：多 Agent 团队结构 + 情绪数值建模。

**它比我们强**：
- Steam 已上架 + 创意工坊 —— **分发渠道已经跑通**，我们还在 preview
- 移动端内测、26 个 API 路由、独立 `memory_server` 进程
- 猫娘网络（AI 自主社交）、K.U.R.O. 独立游戏等衍生内容

**它比我们弱 / 我们领先**：
- **单角色**（猫娘 YUI 一个人做所有事），没有多 Agent 团队结构
- 没有 Agent 间关系记忆（亲密度/信任随真实委托演化）
- 没有分级沙箱（securityGuard 6 级 + sandboxRules 26 条）
- 已知工程债外显：README 用整段警告数据目录迁移（「直接拉新镜像会得到空数据
  目录」），`.git` 约 390 MB 塞满历史二进制，官方要求 `git clone --filter=blob:none`

**行动建议**：
- ✅ 守住「多 Agent + 情绪数值」差异化，不要在记忆赛道硬拼
- ⚠️ 盯 Steam 创意工坊的分发能力 —— 这是它当前最大的优势
- 💡 考虑接 openclaw adapter（N.E.K.O 已经做了 `brain/openclaw_adapter.py`）

### 🟠 AIRI —— 形象工程的巨人，记忆上的弱者

**它是什么**：pnpm monorepo（40+ packages），复刻 Neuro-sama 的「数字生命容器」。
Web（stage-web）+ 桌面（stage-tamagotchi, Electron）+ 移动（stage-pocket, Capacitor）。

**它最强**：同一份 domain 层驱动三端；5 种渲染后端（Live2D / VRM / MMD / Spine /
**Tachie 立绘**）；30+ 模型供应商；6 语言完整 i18n + Crowdin；`winget` / `brew` /
`nix` 全渠道分发；WebGPU / WASM 前瞻投入；浏览器内零依赖推理（xsai-transformers）。

**它最弱 —— 而且恰好是我们的强项**：

AIRI 自己的 Roadmap 原文：
```
- [ ] Memory
    - [x] Pure in-browser database support (DuckDB WASM | pglite)
    - [ ] Memory Alaya (WIP)          ← 没打勾
```

**一个主打「数字生命」的产品，「记得你」那一格还没做完。** 仓库里虽有
`packages/memory-pgvector`，但距离生产级的混合召回 + 证据链还有距离。

> ⚠️ **但这条领先有前提**：v3.34 之前我们的 `memoryEvidence.ts` 也是死代码。
> 现在接通了，领先才是真的。**领先一个「本该领先」的东西不算护城河**，
> 容易被 issue 指出。

**我们比它弱**：5 种渲染后端、5 万 star、6 语言 i18n、**WebGPU 真本地推理**、
三端形态。**我们只实测过 Windows。**

### 🟡 MiniMax Code —— 我们对比表里曾经的盲区

> v3.34 起已补入本表。补它的原因：它才是功能集**最接近**我们的对手，
> 漏掉它会让懂行的人怀疑我们的调研深度。

**它是什么**：MiniMax 出品的桌面端 AI Agent 应用，闭源商业产品。

**能力**（据官方 docs）：

| 分类 | 能力 |
|---|---|
| 模式 | Coding / Work 双模式 |
| 工作区 | 项目目录上下文、文件、变更、终端 |
| 桌面 | 内置浏览器预览、**电脑操控**、无限画布 |
| Agent | **Agent Team**（多 Agent 协作）、自定义 Agent、Mini App、插件市场、MCP |
| 记忆 | 主动记忆 + 记忆摘要管理 + 会话级双开关 |
| 自动化 | 定时任务（电脑唤醒时执行）|
| 远程 | 手机上看进度、补指令、**处理权限确认**；**IM：微信 / 飞书 / Telegram / Lark** |
| 形态 | 桌面 + `mcode` CLI + Headless(`mcode exec`) + **ACP 集成** |
| 模型 | MiniMax 托管 / 自带 Key / **BYOK 自定义供应商**；H3 Max 视频生成 |
| 独特 | **Goal 功能** —— 设定可验证的最终目标，任务持续推进直到达标或阻塞 |

**它最强**：厂商级资源（H3 Max、Mini App、无限画布）、四形态覆盖同时吃
「个人桌面 / 开发者终端 / CI 自动化 / 第三方编辑器宿主」四类用户。
**IM 直连微信**在国内是巨大优势。

**它最弱**：**完全没有形象 / 情绪 / 桌宠 / 陪伴层**。它做的是「能干活」，
不做「有陪伴感」。记忆机制只有产品说明书级描述（无向量库、无分层、无召回算法、
无证据链披露），闭源导致能力边界不可验证。

**重叠度 ~45%，不是定位竞争，是注意力竞争。**

**必须抄的四个设计**：
1. **Goal 功能** —— 「设定可验证的最终目标，持续推进直到达标或阻塞」
2. **记忆的会话级双开关** —— 「使用记忆」对话前设定、开始后不可改；「生成记忆」会话中可调
3. **明确的「不记什么」清单** —— 一次性状态 / 临时日志 / 敏感密钥 / 过期细节
4. **ACP 集成** —— 接入第三方编辑器/宿主的标准协议

### 🔵 openclaw —— 别当对手，当上游

**它是什么**：Gateway 单一控制面 + 27 个 IM 渠道 + 5 端原生 App。
定位语：「The AI that really does things. Any OS. Any Platform.」

**它最强**：
- **27 个渠道**（bundled / official plugin / external plugin 三档）
- **节点配对安全体系**：设备身份 + `connect.challenge` 签名 + 配对审批；
  Tailnet/LAN 连接即使同主机也必须显式批准
- ClawHub 技能市场（定义了技能的分发/审核/安全状态展示标准）
- TypeBox → JSON Schema → Swift 的同源代码生成
- 基金会化治理，核心团队由 501(c)(3) 雇用并发版

**它最弱**：**完全没有形象 / 人格 / 情感层**。记忆刻意做成纯 Markdown 文件
（`MEMORY.md` / `USER.md` / `memory/YYYY-MM-DD.md`）—— 对 agent 够用，
但没有任何情绪/关系/主动性建模。

**结论：不是竞争，是必须警惕的上游。**

**风险**：渠道能力、技能分发、远程设备接入这三件事已被它定义成事实标准。
我们若在这三件事上缺席，天花板会锁死在单机应用。

**两条路可选**：
1. 做 openclaw 的下游（A2A adapter，借它的渠道省三年功）
2. 在 IM 层做它做不到的差异化 —— **带表情、带语音、带桌宠状态的 IM 交互**

### 🔵 cc-haha —— 工程参考书

**它是什么**：Electron 桌面工作区，把 Claude Code 及其周边能力装进 GUI。
一句话描述：「Local-first cross-platform desktop workspace for Claude Code / agents」。

**它最强**：可视化多 Agent 工程工作台的完整度 ——
**Agent Teams 依赖泳道画布** · **动态 Workflow 现场编排**（并发/流水线 + 阶段视图
+ 中断恢复）· **模型 trace 面板** · **Worktree 隔离启动** · 逐文件 diff 审查 ·
内置带登录态的浏览器预览 · 5 级权限模式 · IM 8 渠道（微信/飞书/钉钉/Telegram/
WhatsApp/企微/QQ/Slack）+ H5 远程。

**它最弱**：
- **本质是 Claude Code 的 GUI 外壳，能力继承而非自研**。记忆 100% 依赖 Claude Code
  （自己没有记忆层），Agent 编排也建立在 Claude Code 之上
- ⚠️ **商业模式警示**：靠 API 中转站赞助（AruHub / Atlas Cloud / ApiSmart），
  Atlas Cloud 甚至被内置进 provider 列表。这是「帮别人卖 API」的利益绑定结构。
  **我们若要商业化应避开这条路径。**
- 桌宠是玩具属性且**默认关闭** —— 作者自己也认为它不是核心

**必须抄的五个设计**：
1. Agent Teams 依赖泳道画布（可视化多 Agent 依赖关系）
2. 动态 Workflow 编排（模型现场写编排脚本）
3. 模型 trace 面板（每次请求记录状态与耗时，可搜索过滤）
4. H5 远程访问（比原生 App 轻量）
5. `/remember` 复盘技能 —— **只提建议、不直接改文件、所有改动需批准**

---

## 四、我们真正的护城河在哪

按「可持续性」排序，不按「听起来多厉害」排序。

### 🥇 桌宠绑定真实 Agent 执行状态

> 这是 5 个对标项目里**唯一一个**「让干活的人自己被看见」的。

```
Yak 正在写代码  → 敲键盘循环 + 专注光晕 + 「Yak 正在写代码…」
热茶正在审查  → 审视表情 + 怀疑色 + 「热茶正在审查…」
等待你处理    → 踱步 + 「等你处理…」
验证失败重试  → 捂脸/黯淡 + 警示色（4 秒后隐去）
没人干活      → 不动 —— 交还给情绪系统自由表现
```

**零 LLM 调用**（纯状态机映射）· 1.2s 防抖 · 空闲不接管 · 可用
`LUMINA_PET_AGENT_STATE=0` 关闭。

对照：cc-haha 作者自己写明其桌宠「只是个状态提示和跳转入口，**不能替你批准权限**」；
AIRI 的表情来自模型输出但不绑定真实执行状态。**我们恰好越过了这条线** ——
审查员真的在审查代码产出，你也能直接在桌宠窗口对话。

### 🥈 「用户只看到一个 Lumina」的隐藏编排

后台三 Agent 协作，用户全程不知道。对比 openclaw 的多渠道多 session
（用户要自己管理 session 概念），这是不同的产品判断。

### 🥉 情绪参与系统决策

`delegationManager.ts:230-252` —— **情绪影响重试次数**。
`orchestration/emotionGating.ts` 让情绪参与工具收紧（且只能收紧不能放宽）。
多数项目的「情绪系统」只是换头像和语气词，我们是让它进了执行层。

### 🥉 反幻觉的工程化落地

- 记忆权威性**只由 `source` 决定**，模型无权自封 `confidence: 1.0`
- worker 只调工具不下结论的空产出**强制转失败**（防「空信封 → 主模型自己编一个结论」）
- 工具调用被解析器删光时返回诚实说明而非空串
- UI 标注 `来源: llm / 来源: template`，**绝不假装是大模型写的**

最后一条在开源项目里极其稀缺 —— 大量项目把模板兜底伪装成 AI 输出。

### ⑤ 精灵表 8×9 UGC：把做桌宠的门槛降下来

Live2D/VRM 需要会 Blender、会绑 3D 模型。精灵表把门槛从「掌握 Blender」
降到「会跟 AI 画画的普通人」：三条创建路径（单张静态图 1 分钟 / 提示词 10 分钟 /
已有图集直接导入），全程本地处理不消耗模型额度，有校验器
（尺寸/像素/体积/可执行文件拦截）。

---

## 五、被高估的地方（自我校正）

写下来是为了让读者据此判断，而不是只听好话。

| 被高估的说法 | 实际情况 |
|---|---|
| 「132 个工具」 | 132 是**已注册数**。`agent` 模式模型实际可见 **48** 个（v3.34 修复前是 34，47 个工具彻底不可达）。README 已改为双口径标注 |
| 「记忆证据链」 | v3.34 之前是 16 KB 死代码，只有测试在测。现在接通了，但**领先的是本该领先的东西** —— N.E.K.O 早就做了一整套 |
| 「5 维情绪」 | 团队侧 5 维（开心/疲劳/专注/焦虑/好奇）的底层是 **3 个连续数值**（mood/energy/affinity）。5 vs 3 不是碾压。README 已改为「3 个连续数值驱动 5 维表现」 |
| 「多 Agent 团队」 | v3.34 之前只有 `delegate_to` + `run_subagents` 两个工具真正可达；五阶段门控、对抗评审、临时工雇佣全是死代码。现在接通了，但**接线前用户一次也没体验过** |
| 「技能市场 / 装 App 一样简单」 | `use_skill` / `install_skill` / `skill_run` 此前不可达。v3.34 后可达，但**生态是空的**，没有第三方技能 |
| 「本地优先」 | 需要外挂 LM Studio。**没有应用内本地推理**。AIRI 有 WebGPU 真本地 |
| 「跨平台」 | **只有 Windows 实机验证**。macOS 代码有适配但从未在真机跑过 |

---

## 六、我们明确不如别人的地方

按严重度排序，放在这里是因为藏起来只会在 issue 里被挖出来。

| 维度 | 谁更强 | 差距 |
|---|---|---|
| **生态与社区体量** | openclaw | 39 万星 vs 0。差三个数量级 |
| **多端覆盖** | AIRI / N.E.K.O | 我们只实测 Windows；AIRI 三端，N.E.K.O 有 Steam + 移动内测 |
| **分发渠道** | N.E.K.O | Steam 已上架 + 创意工坊 |
| **形象渲染广度** | AIRI | 5 种后端 vs 我们的 Live2D/VRM/精灵表/MMD/猫咪（广度接近，但 VRM 情绪动作默认关）|
| **应用内本地推理** | AIRI | WebGPU 真本地 vs 我们需外挂 LM Studio |
| **多 Agent 可视化编排** | cc-haha / MiniMax Code | 依赖泳道画布、动态 Workflow、模型 trace |
| **IM 渠道** | openclaw(27) / cc-haha(8) / MiniMax Code(4) | 我们 0（`electron/channels/` 已写但未接线）|
| **记忆模块工程深度** | N.E.K.O | 35+ 模块 vs 我们的 13 个 |
| **i18n 完整度** | AIRI | 6 语言 + Crowdin vs 我们 zh/en |
| **人格厚度** | N.E.K.O | `persona/` 8 模块做融合与自我修正 vs 我们每人 55~75 行身份文件 |

---

## 七、结论：Lumina 填的是哪个空位

> **有形象的 AI 伴侣大多没有干活的 Agent 能力，有 Agent 能力的工具大多没有人格。**

| 项目 | 有形象 | 能干活 | 主动性 | 记忆就绪 |
|---|:---:|:---:|:---:|:---:|
| N.E.K.O | ✅ | ⚠️ 单角色 | ✅ | ✅ |
| AIRI | ✅✅ | ❌ | ❌ | ⚠️ WIP |
| openclaw | ❌ | ✅✅ | ⚠️ | ⚠️ 纯 Markdown |
| cc-haha | ⚠️ 玩具 | ✅✅ | ✅ | ✅ 继承 Claude Code |
| MiniMax Code | ❌ | ✅✅ | ✅ | ⚠️ 不可验证 |
| **Lumina** | ✅ | ✅ | ✅ | ✅ |

**「有身体的团队 Agent」这个交集目前是空的。** 这是我们要占的位置。

但要诚实地说清楚它有多小：Lumina 现在 0 star，而 openclaw 周均 2,004 次提交。
0 → 1,000 star 靠的不是功能，是**内容和分发**。

---

## 八、我们真正该抄的清单

| 来源 | 抄什么 | 优先级 |
|---|---|---|
| MiniMax Code | Goal 机制、记忆会话级双开关、「不记什么」清单、ACP 协议 | 高 |
| cc-haha | Agent Teams 泳道画布、动态 Workflow、模型 trace、H5 远程、`/remember` 审批式记忆 | 高 |
| N.E.K.O | `persona/` 的人格融合与自我修正、`/memory_browser` 记忆校对 UI | 中 |
| AIRI | 渲染后端抽象层、6 语言 i18n 工程、全渠道安装包分发 | 中 |
| openclaw | A2A adapter 借渠道、节点配对安全设计、Skill 分发标准 | 视资源 |

---

*本文档随代码一起维护。数据采集日 2026-10-03，重新采集请更新表格顶部日期。*
