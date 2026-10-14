# Lumina 仓库治理 & 主进程拆分路线图（战略项 ④）

> 目标：让仓库"对外看起来专业、改起来不踩雷、发版不把草稿打进去"。
> 原则：**先锁边界、再拆大块；每一步都可独立验证、随时可停，不做伤筋动骨的一次性大重构。**

---

## 一、发布树治理：现状核查（2026-09-09）

### 1. 安装包里到底会打进什么（已核查，结论：基本干净）

`package.json → build.files` 白名单只有两项：

```
out/**/*      ← electron-vite 构建产物
public/**/*   ← 静态资源
```

外加 `extraResources` 显式列出的 Live2D 模型、resources、三个 pet html、pet/assets。

**结论：根目录的原型和草稿（`pet-poc/`、`.cowork-temp/`、`_runtime/`、`collected/`、`userData/`、`.tmp-diag/`、`data/`、`memory/`）都不会被打进安装包。** 这一点已经安全，不需要为了发版去删你的在途工作。

### 2. Git 跟踪情况（已核查）

| 目录/文件 | 是否被 git 跟踪 | 处置 |
|---|---|---|
| `electron/`（266 文件）、`src/`（95）、`tests/`（18）、`python/`（12）、`docs/`、`skills/`、`scripts/`、`knowledge/` | 跟踪（正常源码） | 保留 |
| `pet-poc/`、`.cowork-temp/`、`userData/`、`.tmp-diag/`、`_runtime/`、`collected/` | **未跟踪** | 已补进 `.gitignore`，防止误提交 |
| `"启动 Lumina.bat`（注意文件名**开头多了一个双引号**） | **已被跟踪，疑似误命名** | 见下方"待你确认执行" |

### 3. 本次已经完成的治理动作（已落盘）

1. **`.gitignore` 补漏**：新增忽略 `.tmp-diag/`、`.cowork-temp/`、`userData/`、`.tmp-*/`、`*.before_*_fix` 等本地调试残留。
2. **CI 门禁收紧**：`.github/workflows/test.yml` 里主类型检查 `tsc --noEmit` 从"报错也放行（continue-on-error）"改为**合入门禁**——以后类型不过直接红，不许带病合并；`--strict` 严格检查和 ESLint 仍保留为"参考项"，避免一次性冒出大量历史告警卡住开发。
3. 现有 CI 已具备：三系统 × Node 18/20/22 测试矩阵、三系统构建、打 `v*` tag 自动出安装包并建草稿 Release——**发版流水线是齐的**，⑤ 直接用。

### 4. 待你确认后执行（我没有擅自改 git 索引）

根目录有一个文件名带前引号的批处理被 git 跟踪：`"启动 Lumina.bat`，同时还存在一个正常的 `启动 Lumina.bat`。确认后在仓库根目录执行即可清掉误命名版本：

```powershell
git rm --cached '"启动 Lumina.bat'   # 仅移出 git 跟踪，不删磁盘文件；确认无用后再手动删
```

---

## 二、主进程"单体"拆分路线图

### 现状（实测数据，2026-09-09）

主进程 `electron/` 共 266 个文件，最大的几个文件已经到了"改一处怕三处"的体量：

| 文件 | 行数 | 职责 | 风险 |
|---|---|---|---|
| `agentRunner.ts` | 约 2900 | Agent 执行循环、工具调度、搜索拦截全在一起 | 最高 |
| `pet/pet-live2d.html` | 约 2730 | 桌宠全部 UI+行为+Live2D 驱动内联在一个 html | 高 |
| `main.ts` | 约 1650 | 应用启动、窗口、托盘等全生命周期 | 高 |
| `pet/petWindow.ts` | 约 1510 | 桌宠窗口、主动秘书、感知、配置解析 | 高 |
| `ipc/systemIpc.ts` | 约 1570 | 大量系统类 IPC 处理器 | 中高 |
| `proactiveEngine.ts` | 约 1440 | 主动行为引擎 | 中 |
| `preload.ts` | 约 850 | 全部桥接 API | 中 |

### 拆分原则

1. **先抽纯逻辑、后拆 UI**：无副作用、可单测的模块最先搬，风险最低、收益立竿见影。
2. **一次只搬一个边界，搬完就 `tsc + build + 冒烟`**，不攒大 PR。
3. **对外行为零变化**：拆分是"搬家"不是"重写"，函数签名和 IPC 通道名一律不动。
4. 每个阶段控制在 1 个工作日内可完成、可回滚。

### 阶段 0：护栏（0.5 天，发首个 Release 前做完）

- [x] CI 主 tsc 成为阻断门禁（本次已做）
- [ ] 补一份"冒烟清单"到 `docs/`：启动→桌宠出现→对话一句→主动搭话一次→设置保存→Team Agent 派单一次（每次拆分后照单走 3 分钟）
- [ ] 给 `agentRunner`、`intentDispatcher`、`petWindow` 这三条命脉补最小单测（各 3–5 条黄金路径），`tests/` 里已有 vitest 骨架

### 阶段 1：抽"大脑层"（1–2 天，优先级最高——直接服务于"生命体"卖点）

把"LLM 输出 JSON → 容错解析 → 身体指令"这条命脉从各文件里收敛成一个独立模块：

```
electron/pet/brain/
  petBrainConfig.ts   ← resolvePetBrainConfig / createPetLLM（本次已先在 petWindow 落地，后续搬到这里）
  bodyProtocol.ts     ← {action,mood,speech} / {speech,options,kind} 的类型、schema、容错解析
  intentDispatcher.ts ← 迁入，只负责"决策"
  secretary.ts        ← runSecretaryTick 迁入，只负责"主动搭话"
  perception.ts       ← perception tick 迁入，只负责"看屏幕"
```

收益：**"生命体"机制变成一处可讲清、可测试、可演进的代码**，以后加情绪分层、动作粒度都在这里改，不碰窗口代码。

### 阶段 2：拆 agentRunner（2–3 天）

按职责切成 4 个文件，`agentRunner.ts` 只保留编排：

```
electron/agent/
  runner.ts            ← 主循环编排（原 agentRunner 瘦到 500 行内）
  toolExecutor.ts      ← 工具调用执行
  chatGuards.ts        ← 陪伴闲聊识别、自动搜索拦截（本次修复已在雏形，集中收口）
  resultAssembler.ts   ← 最终回复拼装、去重
```

### 阶段 3：拆 main.ts 与 IPC（2 天）

- 启动引导留 `main.ts`（目标 < 400 行）
- 窗口创建 → `windows/`；托盘 → `tray.ts`；生命周期 → `lifecycle.ts`
- `ipc/systemIpc.ts` 按域拆：`ipc/system/`、`ipc/files/`、`ipc/window/`，用一个 `registerAllIpc()` 汇总注册，通道名不变

### 阶段 4：桌宠渲染页瘦身（2–3 天，可放公开 Release 之后）

`pet-live2d.html` 2700 行内联脚本拆成外部 ES 模块（`assets/js/` 下：live2d-driver、chat-ui、autobehavior、ipc-bridge…），html 只留骨架。注意：拆分后必须同步验证 `copy-pet-assets` 拷贝规则和打包 `extraResources`。

### 每阶段统一的"完工定义"

1. `npx tsc --noEmit` 零错误；`npm run build` 通过；
2. 冒烟清单全过；
3. 被拆文件的旧路径保留一个 re-export 壳（一个版本周期），避免内部引用一次性全改；
4. commit 信息写明"纯搬家、无行为变化"，出问题可直接 revert。

---

## 三、CI 后续加固（按优先级，不急着一次做完）

1. **本次已做**：主 tsc 阻断。
2. 建议下一步：PR 模板加"冒烟清单勾选"；CI 增加 `npm run build` 产物体积快照（防止主包失控增长，目前 main bundle 已约 11.4 MB）。
3. 发版前：CI 在 tag 构建后自动算安装包 SHA256 写进 Release（现在已有草稿 Release 作业，补一步校验值即可）。
4. 公开仓库后：Dependabot 开启，每周汇总依赖更新，不自动合并。

---

*本文件只做规划与记录；除已落盘的 .gitignore / test.yml 外，所有拆分与 git 操作都等你确认后再动手。*
