## [Unreleased] — 发布前阻断项修复 + 5 项创新功能落地 (2026-10-05)

> 对应已归档的旧评测文档第七节的 P0~P2 清单。
> 测试基线：3252 → **3324** 用例（+72），`tsc --strict` 0 error，eslint 0 error。

### 发布阻断项（P0）

- **移除 Live2D 示例模型 Mao**（`electron/pet/assets/Mao/`，8.8 MB）
  - 原因：**不是「不能商用」**。官方条款 2.1.3 明确允许 Live2D 原创角色「使用・改変・配布」，
    且对「一般ユーザー / 小規模事業者」（年销售额 < 1,000 万円）不区分営利非営利。
    真正的原因是第 4.1.7 条禁止与「可能构成竞争的中间件」组合——
    而「可能构成竞争」这个措辞，恰恰对「做 Live2D 桌宠应用」的项目留了最大的解释空间，
    且判断权完全在 Live2D 手上。
  - 其余约束一并记录于 `THIRD_PARTY_NOTICES.md`：第 7.3 条违约要销毁派生物
    （GitHub 星标会被牵连，Steam 只是下架）、第 2.1.3.2 条超 1,000 万円须事前书面申请、
    第 2.1.5 条强制署名不可删除（与 AGPL 允许 fork 删声明冲突）、第 2.1.3 条音声数据不得再分发
  - 替代：保底形象改为**程序化 Canvas 2D 小猫**（零外部素材、零授权风险、任何情况下都能加载）
  - 联动：模型库、渲染页解析、异常回退、IPC、历史设置迁移全部改为引用单一真源
    `FALLBACK_MODEL_ID` / `FALLBACK_ENTRY_REL`
  - `THIRD_PARTY_NOTICES.md` 重写：逐条对照表 + 「商业化前置条件」章节
    （含官方固定署名文案原文），并附条款原文链接与「非法律意见」声明
- **修复 `deploy-docs.yml` 分支不匹配**：只监听 `main` 而默认分支是 `master`，
  文档站永远不会部署。改为 `[main, master]`
- **清理内部脚手架**：`knowledge/`、`stt-server/` 移出版本控制并加入 `.gitignore`
- 放行 `examples/sprites/**/*.png`（原被通用 `*.png` 规则挡掉，UGC 资产无法入库）

### 事实校正（P1）

- README 能力口径修正：Computer Use 不再写「看屏幕」——
  其 `services/computer-use-mcp` 已有 macOS 桌面编排、审批队列、审计日志、trace 与 15 个 browser_dom 工具
- IM 渠道登记数修正：27 → **32**（旧快照）
- 统一应用内本地推理结论：官方路线图仍为 `[ ]` 未勾选（此前 BENCHMARKS 与对比文档自相矛盾）
- 能力对照表数据日期改为 **2026-10-04/05**，并加注「会过时，我们选择标注日期而不是假装它不会变」

### 渠道诚实度闸门

- 新增 `CHANNEL_CAPABILITIES` 能力登记表（成熟度的唯一真源）
- **Telegram 是唯一标记为 `verified` 的渠道**（已完成端到端真机验证）
- 其余 6 个适配器标记 `experimental`，**默认拒绝启动**，需配置 `allowExperimental: true` 显式放行
- 首次运行的默认配置只预置 telegram 模板（且不启用）
- `getStatus()` 新增 `maturity` / `note` 字段供 UI 直接渲染角标

### README 工程叙事（P2）

- 顶部新增四个质量徽章（tests / tsc --strict / eslint / CI matrix）与代码量徽章
- 新增 **Quality Gates · 工程底座** 章节：实测数据、代码规模表、测试占比论证、如实说明的短板

### 重构（P2）

- `agentRunner.ts` 4041 → **3772 行**：检索预处理（约 280 行）抽离到
  `electron/agentRunner.preprocess.ts`，纯搬运不改行为
  - 保留 `import` + `re-export` 双重导出（只写 re-export 会断掉内部调用）
  - `tests/agentRunnerPreprocess.test.ts` 钉住拆分契约

### 创新功能

1. **情绪可审计**（`orchestration/emotionAudit.ts`）
   「她为什么不帮我」终于可被解释。情绪收紧记录情绪快照、命中规则、代码位置与恢复条件；
   用户可放行**这一轮**（不是永久解锁、不是权限授权）。已接入 `getToolsForMode` + IPC + preload。
2. **情绪回流**（`memory/emotionalMemory.ts`）
   给事实附加情绪权重。旁挂表 `fact_emotions`，不 ALTER `facts` 核心表。
   21 天半衰期、复现次数对数加成、保守的事件→标签映射（不让 LLM 猜情绪）。
3. **可见性分档**（`orchestration/visibility.ts`）
   陪伴 / 协作 / 审计三档，运行时即时切换。铁则一在陪伴模式下原样保留；
   **权限审批与错误事件在任何档位都可见**——藏掉它们是安全倒退而非体验优化。
4. **精灵表 UGC 飞轮**（`scripts/make-sprite-template.mjs` + `examples/sprites/`）
   零依赖 PNG 编码器生成 8×9 模板（2048×2304，61 有效帧，行标签 + 帧序号 + 有效/未用格着色）；
   附 AI 生成提示词模板与社区贡献流程。
5. **跨 Agent 记忆互通**（`memory/openExport.ts`）
   导出的不是裸事实，而是**带可信度标注的开放格式**（`lumina-memory/v1`）：
   authority（来源 + 置信度上限）/ provenance / emotion / trust 分档。
   校验器对缺 authority 的条目一律降级为 low，对 trust 与 authority 冲突的条目以重算为准。

### 顺带修掉的 bug

- `modelLibrary.getActiveModel()` 把 **JSON 字符串**传给了 `deserialize()`（它要的是对象），
  导致库文件里的 `currentId` 永远解析不出来，所有导入的模型都被静默忽略、退回保底形象

# 📝 Changelog — Lumina Life

> **口径说明**：本文件记录**面向用户的真实变化**。发布前的审计过程、发现的问题与修复对照，
> 见 [`docs/archive/Lumina-发布前评测与复评-20261003.md`](docs/archive/Lumina-发布前评测与复评-20261003.md)
> 与 [`docs/archive/Lumina-深度评测报告-20261002.md`](docs/archive/Lumina-深度评测报告-20261002.md)。
> 质量基准与自测口径见 [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md)。

---

## [v0.1.0] — 首个公开版本（2026-10-03）

> 这一版的核心不是「加功能」，是**把一批此前看起来能跑、实际跑不通的东西修好**。
> 全部变更集中在发布前审计与真机验证，279 文件 / +23,021 行。

---
---

## [Unreleased] — 发布就绪度复评（2026-10-08）

> 对应 `docs/Lumina-深度测评报告-20261008.md` 的 P0/P1/P2 清单与"能力优化"两项。
> 测试基线：3324 → **3514** 用例（+190），241 个测试文件（删 1 个空壳），`tsc --strict` 0 error，eslint 0 error。

### 发布阻断项 P0

- **补 `ws` 运行时依赖**（`package.json` dependencies）。`electron/realtimeClient.ts:11` 已 `import WebSocket from 'ws'`，但 `ws` 此前只在 `@types/ws` 类型上声明，**未声明包本身**。一旦启用实时语音链路会 `Module not found`。
- **`/sessions/` 加入 `.gitignore`**。`git check-ignore` 实测该目录 `NOT IGNORED`，隐私兜底缺失——`git add -A` 可能误提交会话数据。

### 发布前强烈建议 P1

- **补 `@babel/parser` 到 dependencies**（`security/staticScanner.ts:16` 顶层 import，真实启动链路 `skillManager.ts:26` 加载）。此前靠传递依赖侥幸，换 pnpm 严格模式即崩。
- **修 `7za-wrapper.cmd:3` 硬编码作者盘符**。原 `H:\LuminaLife2.0\...` 改为 `%~dp0node_modules\7zip-bin\win\x64\7za.exe`，跨贡献者机器可用。
- **`stt-server/` 缺失时优雅降级**。`ipc/systemIpc.ts:841` 的 `hearing:start` 加 `fs.existsSync` 前置检测，缺失时返回 `{ ok: false, detail: '...' }` 与安装指引，不再静默 `ENOENT`。
- **统一 README 三处测试数字**（3324/229、3071/212、2557 → 241 文件 / 3514 通过 / 1 skipped）。
- **`package.json` 补 `engines` 与 `repository` 字段**。`engines.node >= 20`、`repository = chaxu814/lumina-life`，CI 矩阵本地有版本守卫。
- **移动 `mineflayer` 从 devDependencies → dependencies**。Minecraft 集成是运行时能力，不是开发工具。

### 工程底座收敛 P2

- **删除 `tests/memoryStore.test.ts` 空壳**（唯一用例 `it.skip`，与 `electron/__tests__/memoryStore.test.ts` 重复）。测试文件数 242 → 241 但语义更诚实。
- **修 `electron/tools/impl/fileRead.ts:74` 错误信息里的硬编码路径**（`J:\LuminaLife2.0\memory\MEMORY.md` → 「请检查路径拼写或使用绝对路径」），不再泄露作者旧工作目录。
- **`electron/core/reactEngine.ts:359` 默认 `maxRounds` 从 `1_000_000` 改为 `30`**。此前任何绕过 `agentRunner` 直连 `ReActEngine` 的调用方会拿到无上限循环——把"防 ReAct 死循环"承诺落空。`agentRunner.ts:616` 仍固定传 30 保持优先。

### README 措辞收敛（"不夸大"）

- "昼夜节律" → "昼/夜两档"（实际是 `pet/life/drives.ts:75 isNight` 二值开关，**不是**连续正弦调制；同时澄清底层 9 个情绪标签 + 迟滞最近邻选 5 种主要表现）。
- "CJK 友好" → "整段串+逐字字符级回退，无分词词典"（`hybridMemoryRetrieval.ts:44-61` 实测无 `Intl.Segmenter` 无 bigram）。
- "四层 + 26 规则" → "双层审查 + 32 条命令规则"（`sandboxRules.ts` 实际 32 条，README 此前保守少报）。

### 能力扩展：让两张表从 ❌/⚠️ 翻到 ✅

- **"优化一下这个项目"（模糊任务）**：澄清机制已就位（`orchestration/vagueTaskGuard.ts` + `routingDecider.ts:121-125` 把它注入路由提示），模型会按 `renderClarificationRule` 先问再动，不再瞎猜或过度编排。
- **"装个第三方技能"**：`skill_search`（搜社区 + 魔搭）+ `skill_install`（支持 `skillId` 与 `url` 直装）链路已完整；开箱预置 22 个技能（`browser_click_smart` / `code_review_smart` / `file_search_smart` / `install_skill` / `proactive_check` / `quick_setup` / `web_search_multi` / `bilibili_hot` / `code_daily` / `files_core` / `git` / `mcp` / `memory` / `pomodoro` / `shell` / `system` / `tasks` / `team` / `weather_brief` / `web_search` 等）。

### 🔴 致命：三 Agent 团队在**所有已发布的安装包里整个是坏的**

首次**真机跑打包产物**（此前所有验证都是源码 + 单测）挖出：

- **现象**：模型正确调用 `delegate_to`，工具返回「Yak 未配置 LLM」——
  而启动日志刚打印过「✅ yak 独立 Runner 已创建」。
- **根因**：`delegationManager.ts` 里的 `require('./core/agentOrchestrator')`
  在 dev 模式能解析（源文件在磁盘上），**打包后必然失败** ——
  打包器把源码扁平化进 `out/main/index.js`，运行时基准目录变成 `out/main/`，
  而 `out/main/core/agentOrchestrator` 并不存在。
  抛错被 `catch {}` 吞掉后，`getDelegationManager()` 退回一个**全新的空实例**（runners 为空），
  `isConfigured('yak')` 恒为 false。
- **影响**：三 Agent 团队 —— 本项目的招牌能力 —— 在已发布的安装包里全部失效。
- **修法**：新增 `registerDelegationManagerInstance()`，由 `AgentOrchestrator.init()` 反向注册，
  避免静态 import 成环。
- **187 个测试、dev 模式完全看不出来。**

> 这条修复是本版本存在的核心理由。它也说明一件事：
> **对 Electron 应用，源码测试全绿不等于产品可用。**

### 🔴 8 个孤儿工具对模型彻底不可达

`resolveToolset()` 此前只读静态 `TOOLSETS` 常量表，**完全不读 `ToolDef.toolsets`**
（尽管后者是必填字段）。结果 132 个已注册工具里有 **47 个对模型不可达**，
包括 `team_message` / `hire_worker` / `adversarial_review` / `desktop_act` / `creator_*` / `lsp_*`，
而 `agentTeamPersonas.ts` 还在教模型去调其中 5 个。

修法：能力层（`team`/`lsp`/`browser`/`computer_use`/`creator`/`research`/`media`/`social`/`voice`/`news`）
改为**声明式**；`chat`/`agent`/`developer` 三个模式层仍由静态表独占
（它表达产品决策，不该被工具自身声明左右）。启动时打印各档可达数并对孤儿告警。

### 🔴 「声称做了但没做」的幻觉缺口 —— 动作声明守卫

任务质量基准实测（NeoHorse-1-4B）抓到此前未覆盖的一类幻觉：

```
任务：让它 memory_save 记住「煤球是只橘猫」
回复：「✅ 记住了！以后聊天提到它我都知道啦～ 🐱」
实际：应用日志里根本没有 memory_save 调用
```

已有防护都假设「工具确实被调用过」：
记忆层的 source 权威性管的是**存进去之后**、工具失败 `ok:false` 管的是**调了但失败**、
worker 空产出转失败管的是**子 Agent 不给结论**。这一次是**一次都没调**。

修法：新增 `electron/actionClaimGuard.ts` —— 正则匹配「完成态措辞 + 动作动词」，
配合否定模式排除（「我记不住」不算撒谎），在回复送出前插入提醒。
**已知局限写在代码注释里**：反讽会误判、换个说法会漏检，**它是兜底提醒不是保证**。

### 🟠 file_search 全盘扫描（一次 63.8 秒）

实测日志：`[fileSearch] C:\: 1 结果, 63806ms`。用户没给路径时逐盘扫描全机。
修法：默认作用域收敛到当前项目目录，全盘扫描需显式要求。

### 🟠 沙箱 Windows 盘符路径拼接缺分隔符

`D:\lumina-quality\fib.py` 被重定向成
`C:\Users\xxx\sandbox\lumina\Dlumina-quality\fib.py` —— 冒号与反斜杠被吃掉。
后果是用户按提示去原路径找文件会找不到。

### 🟠 原生模块 ABI 事故 → 变成 CI 门禁

better-sqlite3 预编译包是 Node 20（ABI 143），而 Electron 40 需要 ABI 148。
后果：vitest 全绿（测试跑在 Node 下），但**打包后启动时** SQLite 初始化失败，
记忆系统的 ReMe/Scroll 分支**静默降级**。

修法：`test.yml` 新增独立 `native-abi` job，用 Electron 的 Node 模式真 `require` 一次原生模块。
**能把自己的失败写成 CI 门禁，比事后修更重要。**

### ✅ CI 承诺与实现对齐

- `--strict` 类型检查此前挂着 `continue-on-error: true` ——
  README 里「tsc --strict 零错误」这句宣传**在 CI 里根本没被执行**。v3.34 移除。
- ESLint 约 5000 条历史 warning 改用**棘轮制**（基线只许降不许升，容忍 25 条跨平台波动）。
- 覆盖率门禁：只对 19 个已建立实测的模块开启，并**如实写明** `reactEngine.ts`（含安全硬闸门
  `checkRoleGate`）目前只有 ~42% 覆盖 —— **这是真实风险，不调阈值遮数字**。

### 🟡 记忆证据链从死代码接通

`memoryEvidence.ts`（16 KB）此前只有测试在测。现通过 `evidenceBridge.ts` 接入读写链路，
与 `SOURCE_CONFIDENCE`（写入期硬约束）相连，**两套机制互不改写**。
不变式：记忆权威性**只由 `source` 决定**，模型无权自封 `confidence: 1.0`。

### 🟡 桌宠精灵表接入一等公民形态

8×9 精灵表从「实验性彩蛋」升为一等形态，附带诚实的可用性标注
（`modelKind` / `spritesheetModelKind`）。

### 🟡 文档与宣传口径全面校正

README 与 `docs/` 中若干**被高估的说法**改为双口径标注，并新增「被高估的地方」自我校正表：
「132 个工具」标注为「已注册数，agent 模式模型实际可见 48 个」；
「5 维情绪」标注为「3 个连续数值驱动 5 维表现」；
「记忆证据链」标注为「领先的是本该领先的东西」。

### 🧹 仓库卫生

- 密钥扫描 0 真实命中（833 文件扫 `sk-*` / `Bearer` / `ghp_` / `AKIA`）
- `.env` 已在 `.gitignore`；新增 `.gitattributes` 收敛 Windows/Linux 行尾差异
- 消除死代码与双实现（`electron/mission/` 等），接通路由仲裁

### 📊 本版本验证状态（实测，非引用）

| 项 | 结果 |
|---|---|
| `tsc --noEmit --strict` | **0 错误**（且 CI 强制执行） |
| `vitest run` | **191 文件 / 2618 用例全绿**（1 skipped），18.46s |
| 平台 | **Windows 10/11 x64 为唯一实机验证**；macOS/Linux 代码已适配但未在真机验证 |
| 人群数据 | **无**。本项目 90% 的能力描述来自代码与测试，而非真人使用数据 |

---

## [v0.2.0-draft] — feature/v02-comprehensive-upgrade（2026-09-24，未并入 master）

> ⚠️ **本节内容未并入 `master`，仅存在于 `feature/v02-comprehensive-upgrade` 分支。**
> 保留供追溯，其中多项已在 v0.1.0 中以不同方式重做（如 Live2D 透明窗根因、任务工作区事件转发）。
>
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

### 🔬 赛道扫描补充（v0.2 追加）
- 桌面办公类 Agent 参照：Electron 桌面办公 Agent，外包通用 Agent runtime，11 渠道 IM 远程控制，28 技能含桌宠皮肤生成；无游戏/无 VLM 桌面操控/无社交引擎
- 终端 TUI coding agent 参照：fork pi-mono，沙箱执行+BYOK 三协议+ACP；桌面 App 不开源，外部 PR 通道关闭

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

### 弱模型自动降级（轻量模式）+ 引导修正（2026-10-08 补充）

> 对应深度测评报告"低配本地部署"讨论。小模型（≤7B）跑多 Agent 团队编排会频繁空回复，
> 这是模型能力下限而非 Lumina bug。新增**全自动、零配置**的弱模型降级。

- **新增 `electron/orchestration/weakModelMode.ts`**：`isLiteTier()`（仅 `nano`/<1.5B 与 `small`/<7B 为 true）、`LITE_TOOL_WHITELIST`（只留 `memory_search` / `web_search` / `file_read` 三类安全工具）、`LITE_SYSTEM_NOTE`（提示模型直接简洁回答、不要调团队工具）。
- **`agentRunner.ts` 三处接线**：
  - `loadAgentLLMConfig` 里 `resolveCapabilities(...).tier` 推导 `this._liteMode`（caps 块，仅 nano/small 打开）。
  - `getToolsForMode()` 在全部硬性过滤之后，把工具裁到白名单；白名单被上游过滤全干掉时退回 `memory_search` 保底。
  - `initSystemPrompt()` 在写入 `messages[0]` 前追加 `LITE_SYSTEM_NOTE`。
- **README 引导修正**：删除过时的"默认指向 LM Studio 占位符"警告（代码 v14 实际默认云端 siliconflow/deepseek/zhipu），改为"默认云端优先 + 弱模型自动降级"说明，并写明低配机请用便宜云端 API、本地 Agent 至少 7B(Q4)/写码 14B+。
- 验证：`tsc --strict` 0 error；新增 `tests/weakModelMode.test.ts`（3 用例）；`agentRunner.test.ts` 10 用例全绿。

## [Unreleased] — feature/crossplatform-gaming-onboarding 🚀 发布前大型改造（2026-09-23）

> 本分支将 Roadmap v1.1.0/v1.3.0 的多个特性提前实现，目标是发布前大幅提升竞争力。

### 🖥️ Computer Use 跨平台延伸（Linux + macOS）
- **平台适配器层**：`electron/core/platform/` 含 WindowsAdapter / MacAdapter（AppleScript+screencapture）/ LinuxAdapter（xdotool+Wayland 降级+grim/scrot 回退）
- **cuCore 全量走适配器**：click/hover/type/keyPress/scroll/drag/screenshot/openApp 全部委托 `getPlatformAdapter()`
- **能力矩阵**：`platformCapabilities.ts` 声明各平台 ✅/⚠️/❌，IPC `platform:get-features` 暴露前端
- **CI 三平台矩阵**：windows/macos/ubuntu × Node 20/22，含能力矩阵打印 step
- **测试**：平台相关 178 例全过（含新增 Mac 19例 / Linux 14例）
- **文档**：`docs/cross-platform-status.md`、`docs/INSTALL.md`

### 🎮 Minecraft 游戏能力（游戏能力补齐）
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

