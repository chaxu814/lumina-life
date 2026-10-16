---
title: 架构概览
---

# Lumina Life 架构

> ⚠️ **本文档已于 v3.34 重写。** 旧版本描述的文件路径与工具数量大量对不上实际代码
> （例如把三 Agent 团队写在 `electron/agents/` 下、把工具数写成 88+），已全部按当前
> HEAD 校正。**如果你在旧文档里看到 `electron/agents/agentTeamManager.ts` 这类路径，
> 那是错的** —— 真实位置见下表。

---

## 总体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Electron Shell                                │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                   主进程 (Main Process)                         │   │
│  │                   electron/  (约 14.4 万行)                    │   │
│  │                                                              │   │
│  │  ┌────────────┐  ┌──────────────┐  ┌──────────────────┐      │   │
│  │  │ Agent 引擎  │  │  工具系统     │  │  记忆系统         │      │   │
│  │  │ agentRunner│  │ tools/ (77)  │  │ memory/ (13)     │      │   │
│  │  │ delegation │  │ registry     │  │ hybridRecall     │      │   │
│  │  │ team/ (17) │  │ impl/        │  │ evidenceBridge   │      │   │
│  │  │ orchest.(11)│  └──────────────┘  └──────────────────┘      │   │
│  │  └────────────┘                                                │   │
│  │  ┌────────────────────────────────────────────────────────┐   │   │
│  │  │  安全层：rolePolicy（唯一事实源）· securityGuard ·       │   │   │
│  │  │  sandboxRules · shell 四层沙箱 · accessControl（设置面板）│   │   │
│  │  └────────────────────────────────────────────────────────┘   │   │
│  │  ┌────────────────────────────────────────────────────────┐   │   │
│  │  │  能力层：orchestration/（编排）· team/（团队）·           │   │   │
│  │  │  proactive/（主动性）· skills/ · mcp/ · ipc/（27）       │   │   │
│  │  └────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│                             │ IPC                                    │
│  ┌──────────────────────────┴───────────────────────────────────┐   │
│  │              渲染进程 (Renderer)  src/ (约 4.6 万行)            │   │
│  │              47 个面板 · React 19 · Zustand 5 · UnoCSS        │   │
│  │              另有 electron/pet/ (53) 承载桌宠渲染（多窗口）    │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## 目录规模（v3.34 实测）

| 目录 | 文件数 | 行数 | 职责 |
|---|---:|---:|---|
| `electron/` | 501 | 144,341 | 主进程全部逻辑 |
| `src/` | 146 | 46,239 | 渲染进程 UI |
| `tests/` | 187 | 26,557 | Vitest 单测 + 集成 |
| `python/` | 12 | 1,055 | 语音 / 可选 dense embedding |
| `docs/` | 60 | 8,179 | 文档站点（VitePress） |
| **合计（不含 node_modules）** | **~1,030 跟踪文件** | **~218,000** | |

子目录细分：

| 目录 | 文件 | 行 | 说明 |
|---|---:|---:|---|
| `electron/tools/impl/` | 77 | — | 工具实现 |
| `electron/pet/` | 53 | — | 桌宠渲染（Live2D / VRM / 精灵表 / MMD / 猫咪）|
| `electron/ipc/` | 27 | — | 主进程 ↔ 渲染通道 |
| `electron/gaming/` | 21 | — | 游戏陪伴（视觉路线 + Mineflayer 可选）|
| `electron/team/` | 17 | 4,574 | 团队能力（对抗评审 / 临时工 / 自治 / 邮箱 / 看板…）|
| `electron/proactive/` | 16 | — | 主动性引擎（门控 / 退避 / 未完话题）|
| `electron/core/` | 25 | — | LLM provider、ReAct 引擎、路径解析 |
| `electron/memory/` | 13 | — | 记忆存储与检索 |
| `electron/orchestration/` | 11 | 3,731 | 编排（路由 / 阶段门控 / 复杂度 / 验证闭环）|
| `electron/api/` | 11 | — | REST API 路由 |
| `electron/channels/` | 11 | — | IM 渠道适配（**已接线**，但需用户自配凭据，见「已知缺口」）|
| `electron/stt-server` `whisper/` | 13 | — | 本地语音输入 |

---

## 核心模块

### 1. Agent 引擎

> ⚠️ 旧文档把这些文件写在 `electron/agents/` 下 —— **该目录实际只有
> `customAgentManager.ts` 和三个 `agent.json`**，引擎本体全在 `electron/` 根目录。

| 文件 | 行/大小 | 职责 |
|---|---:|---|
| `agentRunner.ts` | **173 KB** | ReAct 主循环：消息 → LLM → 工具 → 结果 → 继续。见下方「已知技术债」|
| `delegationManager.ts` | 47 KB | 委托主流程、重试收敛、**五阶段门控** `phaseGatedDelegate` |
| `agentCompactor.ts` | 34 KB | 上下文压缩（按模型窗口分档，65%/60%/50% 触发率）|
| `agentConfig.ts` | 30 KB | 每 Agent 独立 LLM 配置、`buildRunConfig`、工具禁用集计算 |
| `agentSocialEngine.ts` | 31 KB | 群聊、早安仪式、朋友圈 |
| `agentSkills.ts` | 24 KB | 技能注册与匹配 |
| `agentTeamPersonas.ts` | 22 KB | 三个 Agent 的人格、system prompt、角色边界（**人格真实来源**）|
| `agentTeamTypes.ts` | 15 KB | 团队类型定义 |
| `agentPool.ts` | 11 KB | Agent 实例池与生命周期 |
| `agentProfileManager.ts` | 11 KB | 读 `agents/<id>/agent.json` |
| `agentTeamContext.ts` | 11 KB | 共享上下文 |
| `teamProactiveSystem.ts` | 13 KB | 团队级主动性协调 |
| `agentRelationships.ts` | 8 KB | Agent 间亲密度/信任演化 |
| `core/reactEngine.ts` | 37 KB | 工具调用解析（XML + JSON 双路径）+ 角色闸门 |
| `core/llmProvider.ts` | — | 统一 LLM 调用、看门狗、能力降级 |

### 2. 三 Agent 团队

| Agent | 角色 | 对用户可见 | 工具边界 | 职责 |
|---|---|---|---|---|
| **Lumina** 🐱 | `boss` | ✅ 唯一接口 | 全量放行 | 对话 · 情绪感知 · 派活 · 整理结果 |
| **热茶 (Recha)** 🍵 | `worker` | ❌ | 只读（`RECHA_ALLOW` 12 项）| 代码审查 · 挑错 · 风险评估 |
| **Yak** 💻 | `worker` | ❌ | 可写可执行可提交（`YAK_ALLOW` 27 项），禁二次委托 | 写码 · 调 bug · 重构 · 跑测试 |

**人格来源**（重要）：`agents/<id>/agent.json` 只管 LLM 与工具配置，**人格在两处**：
1. `electron/agentTeamPersonas.ts` —— 角色定义与 system prompt（主）
2. `electron/agents/<id>/{AGENTS,SOUL,PROFILE,MEMORY}.md` —— 每人 4 件套身份文件

委托流程：
```
用户提问
  → routingDecider 判定复杂度（规则高置信直接用 / 歧义调一次 LLM 仲裁 / 失败静默退回规则）
  → 简单 → delegate_to 直派
  → 复杂 → phase_gate_delegate → Research→Plan→Execute→Verify→Review
                              → 每个产出交 adversarial_review（多视角并发委托热茶）
  → Lumina 整理 → 回复用户
```

**团队能力模块**（`electron/team/`，4,574 行）：

| 文件 | 能力 |
|---|---|
| `adversarialReview.ts` | 多视角并发对抗评审（`Promise.all` 同时委托）|
| `dynamicWorker.ts` | 动态雇佣临时工种、并行执行、独立黑名单 |
| `teamAutonomy.ts` | Worker 内驱力自领取（主动性随待命时长爬升）|
| `teamSharedBoard.ts` | 团队共享任务看板 |
| `workflowScript.ts` | 脚本化工作流（批处理并发）|
| `teamMailbox.ts` `teamPolicy.ts` `teamCheckpoint.ts` `teamDailyLog.ts` | 邮箱 / 审批 / 快照 / 日报 |
| `workerStats.ts` `llmTrace.ts` `relationshipDrama.ts` `modelTier.ts` | 画像 / 追踪 / 关系演化 / 模型分级 |
| `gitWorktree.ts` `cuCrew.ts` `teachRecorder.ts` `agentMarkdown.ts` | 隔离工作树 / Computer Use 班组 / 教学录制 / Markdown Agent |

**编排模块**（`electron/orchestration/`，3,731 行）：

| 文件 | 能力 |
|---|---|
| `phaseGate.ts` | 五阶段状态机（由 `phase_gate_delegate` 工具触达）|
| `complexityAnalyzer.ts` | 任务复杂度评分 |
| `routingDecider.ts` | 三档路由仲裁（动态 `require()` 以避开循环依赖）|
| `internPool.ts` | 实习生池 |
| `verifyLoop.ts` `yakParallel.ts` `taskBoard.ts` | 验证闭环 / 并行批次 / 任务板 |
| `emotionGating.ts` | 情绪参与工具收紧（**只能收紧，不能放宽**）|
| `delegationPrompt.ts` `theater.ts` `theaterBridge.ts` | 委托 prompt / 剧场 |

### 3. 工具系统

**注册表**：`electron/tools/registry.ts` + `electron/tools/index.ts`（注册入口）+ `impl/`（77 个实现文件）

**实测规模（v3.34）**：

| 口径 | 数量 |
|---|---:|
| 已注册并通过校验 | **132** |
| 任何 toolset 都够不到的孤儿 | **0** |
| `chat` 模式可见 | 0 |
| `agent` 模式可见 | **48** |
| `developer` 模式可见 | **69** |
| `full` 全量（新增） | 132 |

**分档机制**（v3.34 重写，务必读）：
- **模式层**（`chat` / `agent` / `developer`）由 `MODE_TOOLSETS` 标记，**静态表独占**。
  它表达「这一档给用户多少能力」的产品决策，不被工具自身的声明左右。
- **能力层**（`team` / `lsp` / `browser` / `computer_use` / `creator` / `research` /
  `media` / `social` / `voice` / `news`）改为**声明式**：所有 `ToolDef.toolsets`
  里写了该名字的工具自动并入。新加工具只要写对 `toolsets` 就能被看见。
- `full` = 全部已注册工具，供高级用户 / 调试。
- 启动日志会打印各档可达数，并对「任何 toolset 都够不到的工具」告警。

> **为什么改**：v3.34 之前 `resolveToolset()` 只读静态 `TOOLSETS` 常量表，
> **完全不读 `ToolDef.toolsets`**（尽管后者是必填字段、58 个文件都在声明）。
> 结果 132 个已注册工具里有 **47 个**对模型彻底不可达 —— 包括
> `team_message` / `hire_worker` / `adversarial_review` / `desktop_act` /
> `creator_*` / `lsp_*`，而 `agentTeamPersonas.ts` 还在教模型去调其中 5 个。
> 详见 `docs/BENCHMARKS.md` 与 CHANGELOG v3.34。

**工具定义范式**（`ToolDef`，`electron/tools/types.ts`）：
```ts
{ name, description, params, toolsets: string[], dangerous?, blockedInChild? }
```

### 4. 记忆系统

存储：SQLite（better-sqlite3）。`electron/memory/`，13 个文件。

| 文件 | 职责 |
|---|---|
| `memoryStore.ts` | 63 KB 核心存储。事实/反思/人格/画像/配置/摘要六层 |
| `hybridRecall.ts` | **BM25 + TF-IDF 余弦，RRF 融合**（零依赖、CJK 友好）|
| `evidenceBridge.ts` | v3.34 新增：把 `memoryEvidence.ts` 的五维评分接进读写链路 |
| `scrollContext.ts` | Scroll 模式：长上下文淘汰改为索引化而非压缩 |
| `layeredMemory.ts` `layeredMemoryAdapter.ts` | 分层记忆 |
| `relationshipEvents.ts` | 关系事件流（受 feature flag 控制）|
| `remeLight.ts` | ReMeLight 索引（Electron ABI 不可用时静默降级，不影响主流程）|
| `summarizer.ts` `unified.ts` `federation.ts` `base-memory-manager.ts` `affinityDecay.ts` | 摘要 / 统一接口 / 联邦 / 基类 / 亲密度衰减 |

**两套可信度机制（v3.34 已接通）**：

| 机制 | 位置 | 作用 | 状态 |
|---|---|---|---|
| `SOURCE_CONFIDENCE` | `memoryStore.ts:55` | 写入期硬约束 —— 记忆权威性**只由 `source` 决定**，模型无权自封 `confidence: 1.0` | 一直在线 |
| 五维证据评分 | `memoryEvidence.ts` | 读取期排序与生命周期（confirmed/pending/outdated/contradicted）| **v3.34 接通**（此前 16 KB 死代码）|

两者通过 `evidenceBridge.ts` 相连，**不改写任一套**。不变式：新增第二套不会引入
第二个「谁说了算」。

默认检索是 BM25 + TF-IDF 双路 RRF 融合（零依赖）。dense 语义向量（Ollama
nomic-embed-text 或外部 embedding 服务）为**可选且默认关闭**。

### 5. 安全体系

| 层 | 文件 | 职责 |
|---|---|---|
| **角色硬闸门** | `rolePolicy.ts` | 唯一事实源。`isToolAllowedForRole()`，deny 优先 |
| 执行层校验 | `core/reactEngine.ts:133` | `checkRoleGate()`，XML 与 JSON 两条解析路径**都**调用 |
| 广告层过滤 | `agentRunner.ts:3313` | 再按 rolePolicy 过滤一遍后才把 schema 给 LLM |
| 消息/参数级 | `securityGuard.ts` | 6 级 × 10 类规则库，CRITICAL 默认 `blockCritical` |
| 命令级 | `sandboxRules.ts` | 7 级 × 8 类，26 条规则 |
| shell 四层沙箱 | `tools/impl/shell.ts` | ① 进程树隔离 ② 网络铁笼（HTTP_PROXY 劫持 + 域名白名单）③ 文件围墙（OS Integrity Level 降权）④ 规则库 |
| 审批流 | `agentRunner.ts` 三处 | `requestApproval()`，危险操作先问用户 |
| 设置面板 | `accessControl.ts` | 用户可查可调的路径/域名/命令级权限 |
| 崩溃兜底 | `crashGuard.ts` | `unhandledRejection` 记日志不退出；`uncaughtException` 存快照再退 |

> ⚠️ `rolePolicy.ts` 与 `accessControl.ts` 描述同一件事却各写各的。
> `tests/rolePolicyAccessControlParity.test.ts` 是 v3.34 新增的一致性守卫：
> 任何一边单独改动而另一边没跟上，测试立刻红并指出差在哪。**这是防漂移，
> 不是消除重复** —— 真正的两表合并应作为独立任务，届时差集应恒为空。

### 6. 主动性

`electron/proactiveEngine.ts`（56 KB）+ `electron/proactive/`（16 个文件）

8 类定时器：常规触发（60s）· 屏幕感知（10min）· 热搜感知（30min）· 每日重置 ·
作息学习（30min）· Daily Paper · 机会感知（60s）· 健康关怀（3 项独立）

数据源是真实网络请求（B 站 + 微博 + arXiv 并发拉取）。门控齐全：
`gate.ts`（触发门）· `backoff.ts`（指数退避）· `notificationPolicy.ts` ·
`unfinishedThread.ts`（未完话题）· `followupTopics.ts` · `innerThoughts.ts`。

`team/teamAutonomy.ts` 的 Worker 自领取：主动性随待命时长爬升（3 分钟到顶）
+ 抖动，全局并发帽默认 2（`LUMINA_MAX_CONCURRENT` 可调 1~8），心跳续租 45s。
默认保守是刻意的 —— 该文件 57-70 行注释解释了原因：桌宠常驻用户桌面，
夜间自己跑任务会烧 token、耗电、占 CPU，用户会直接卸载。

---

## 已知技术债

诚实地列出来，比藏着被 issue 挖出来好。

| 债务 | 规模 | 状态 |
|---|---:|---|
| `agentRunner.ts` 单文件巨大 | 173 KB | 单文件承载 ReAct 主循环，对外部贡献者是劝退级别。已拆出 `agentRunner.constants.ts`，主文件仍需进一步拆分 |
| 循环依赖已断一处 | — | v3.34 已把 `registerAllTools()` 从 `agentRunner` 模块顶层移入构造函数（`registrationFlag.ts` 承载标志位）。建议引入 `madge` / `dependency-cruiser` 做持续检测 |
| `electron/channels/adapters/` 默认关闭、未经真机验证 | 11 文件 | **接线是存在的**（`main.ts` 用 `await import()` 动态装载桥接器，打包器会内联，7 个适配器都有真实实现）。真实缺口是：适配器仅在配置 `enabled: true` 时启动，用户必须自己配凭据；且未做过端到端真机验证。**2026-10-04 更正**：此前这里写的是「未接线」，是因为项目里有一批检查 grep 静态 import，而这里用的是动态 import —— 扫不到就误判成没接线了 |
| `electron/mission/` 零引用 | 5 文件 / 767 行 | 完整无引用 |
| `electron/mcp/mcpConfigLoader.ts` 未接线 | 4 KB | 声明式 MCP 配置未接入 |
| `electron/persona/subPersona.ts` 无消费者 | 9 KB | feature flag `personality.subPersona` 开了也没人读 |
| `tools/impl/duo` 类工具的 `dangerous` 标记 | — | 建议随 CI 加静态检查 |
| 覆盖率门禁范围窄 | 17 文件 | `agentRunner` / `delegationManager` / `memoryStore` 三大核心均在门禁之外 |
| macOS / Linux 桌面操控未实机验证 | — | 代码有适配，**从未在真机跑过**。Windows 是唯一实机验证平台 |

---

## 相关文档

- [API.md](API.md) —— REST API
- [custom-agent-guide.md](custom-agent-guide.md) —— 自定义 Agent
- [skill-tutorial.md](skill-tutorial.md) —— 技能开发
- [BENCHMARKS.md](BENCHMARKS.md) —— 质量基准与自测口径（三道门禁、代码与测试规模、核心机制自核）
- [ROADMAP.md](ROADMAP.md) —— 路线图与已知缺口认领
- [gaming-overview.md](gaming-overview.md) —— 游戏陪伴

> ℹ️ 发布前的历史审计报告收在本地 `archive/`（不随仓库分发），
> 因此这里不再给出指向它的链接 —— 一个在 GitHub 上点不开的链接，
> 比没有链接更伤信任。当前口径以本文件的「已知技术债」表与 [BENCHMARKS.md](BENCHMARKS.md) 为准。
