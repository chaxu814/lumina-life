# Lumina Life 全面产品总结 · v0.1.0-preview

> 整理时间：2026-09-15　｜　状态：**首个公开预览版（未发布，已做到「一键可发」）**
> 配套材料：竞品深度对比看板 `docs/lumina-vs-3-projects-2026-09-15.html`、发布计划 `docs/release-v0.1-plan.md`、生命体设计 `docs/lumina-living-body-design.md`、工程治理 `docs/engineering-governance.md`

---

## 0. 30 秒速览（给刚出差回来的你）

- **Lumina 是什么**：一个跑在桌面上的「有生命的 AI」——Electron + React + TS 的多 Agent 桌宠。不是聊天框，而是**身体（Live2D）、情绪、记忆、工具手脚同时在线**的数字生命；前台是 Lumina 一只猫，后台是 Lumina + 热茶 + Yak 三 Agent 团队真的在干活。
- **和三个开源项目的关系**：四者不是平铺竞品，而是**三层物种**——OpenClaw 是底层「执行/渠道网关」（不做人格），AIRI / N.E.K.O / Lumina 是上层「数字生命」。N.E.K.O 是最直接对手，AIRI 强在游戏陪玩与全端工程，Lumina 的差异点是 **LLM 同帧驱动身体 {action,mood,speech} + 三 Agent 团队群像 + 伙伴里罕见的安全纵深**。
- **本轮（第三阶段）一次性交付**：你拍板的 3 件事 + P0/P1/P2 共 6 个工程问题**全部落地为真实代码**，新增 6 个独立可测模块、6 个测试文件；**严格类型检查 0 错、303 个单测 302 通过/1 跳过、三端打包构建成功**；分 6 个本地提交，工作区干净，**已跟踪代码树零密钥零内网地址**。
- **还需要你本人做的只有两件**：① 决定本地 key 要不要轮换；② 用你自己的 GitHub 账号建仓并 push（环境无 remote / gh 凭据，我已把命令备好）。其余真实硬件/外部实例的端到端联调在文末列明。

---

## 1. 产品定位

**一句话**：Lumina Life = 有情绪、有记忆、有身体、有一整个后台团队的本地优先 AI 桌宠。

| 维度 | Lumina 的选择 |
| --- | --- |
| 形态 | 透明置顶桌面 Live2D 桌宠，而非网页聊天框 |
| 智能体 | 三 Agent 团队：Lumina(boss，唯一对用户) + 热茶(代码审查) + Yak(分析)，背靠背 delegate_chain 流水线 |
| 驱动方式 | LLM 同帧产出 `{action, mood, speech}`，身体/情绪/台词一体驱动 |
| 执行能力 | 70+ 工具 + Computer Use + 沙箱/审批/访问控制等安全纵深 |
| 隐私 | 本地优先（LM Studio / Ollama 可全离线），SQLite 持久化记忆 |
| 许可 | AGPL-3.0 OR Apache-2.0 双许可 |

---

## 2. 架构总览

```
┌──────────────────────────── Renderer（React 19 + Zustand + Live2D）────────────────────────────┐
│  桌宠透明窗 · 情绪/表情渲染 · 聊天与团队面板 · 设置（9 家供应商配置/加密） · TTS/STT 前端        │
└───────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                         │ IPC（preload 桥，contextIsolation）
┌───────────────────────────────────────┴──────────────────────── Main（Electron 主进程）──────┐
│ pet/            意图决策 intentDispatcher → 动作/情绪/台词；emotionFusion 连续情绪；modelImporter│
│ agent/agentRunner  ReAct 循环 · 工具调用 · XML/function-calling · 后处理（toolNoise 已抽离）    │
│ core/           llmProvider · providerAdapter(请求归一) · unifiedChat(统一调用层) · reactEngine │
│ agentTeam       三 Agent 编排/委派/团队五维情绪                                                 │
│ memory/         SQLite：事实/反思/人格/对话 + 向量检索                                          │
│ channels/       dingtalk/wechat/slack/telegram/qq/discord/openclaw 七渠道 + ChannelManager     │
│ tools/impl      70+ 工具（文件/shell/git/浏览器/Computer Use/…）+ sandbox + securityGuard       │
│ whisper/        STT + bargeIn 可打断语音                                                        │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

技术栈：Electron 40 · React 19 · TypeScript(strict) · electron-vite/Vite · Zustand 5 · better-sqlite3；脚本 `typecheck / test(vitest) / build / pack:win|mac|linux`。

---

## 3. 能力清单（完成度自评）

| 领域 | 能力 | 状态 |
| --- | --- | --- |
| 生命体表现 | Live2D 形象、动作/表情、AI 意图决策、主动搭话、昼夜节律 | ✅ 可用（形象目前仅 Mao 一款） |
| 情绪 | 前端三维 + 团队五维 + 12 具名情绪 + 惯性/冷却/动量/漂移；**新增连续情绪融合** | ✅ 本轮补齐「连续性」 |
| 多 Agent | 三角色团队、背靠背委派、delegate_chain（写→审→修） | ✅ 可用 |
| 记忆 | SQLite 四类记忆、向量语义检索、证据链 | ✅ 可用 |
| 工具/执行 | 70+ 工具、Computer Use、沙箱、审批级、访问控制、工具噪声过滤 | ✅ 可用，广度强 |
| 模型接入 | 9 家供应商配置加密、请求体归一；**新增统一调用层（响应/错误/超时/模型列表归一）** | ✅ 本轮收口 |
| 渠道 | 6 个 IM 渠道 + **新增 OpenClaw 桥接** | ✅/🟡 真实联调待做 |
| 语音 | TTS、STT；**新增 barge-in 打断最小闭环** | ✅ 逻辑层完成，UI 接线待做 |
| 形象扩展 | **新增 Live2D UGC 导入器（校验/消毒/防穿越）** | ✅ 逻辑层完成，UI 待接 |
| 工程化 | 严格类型、303 单测、三端构建、打包脚本、脱敏模板、密钥治理 | ✅ 本轮显著加强 |

图例：✅ 完成且验证　🟡 逻辑就绪、差真实环境/UI 端到端

---

## 4. 与三开源项目的差异化（2026-09-15 GitHub 实测）

> 数值为当日 GitHub API 实测，会随时间变化；详细矩阵见对比看板 HTML。

| 项目 | 生态位 | 体量/许可 | 王牌 | 对 Lumina 的启示 |
| --- | --- | --- | --- | --- |
| **OpenClaw** | 底层执行/渠道网关 | 389,708★ / TS | 通用 Agent 运行时、多渠道、A2A/MCP | 当「手脚」复用而非对打 → **本轮已加桥接** |
| **AIRI** (moeru-ai/airi) | 上层数字生命/VTuber | 48,910★ / MIT / TS | AI 玩游戏、Live2D+VRM、WebGPU、全端工程 | 学工程化与多端；**游戏陪玩线明确不跟进** |
| **N.E.K.O** | 上层消费级陪伴 | 2,903★ / Apache / Python，已上 Steam | 实时语音视觉、五维记忆、主动搭话、产品化 | **最直接对手**，重点对标其鲜活度与发布 |
| **Lumina** | 上层团队型数字生命 | 未发布 / 双许可 / TS | 同帧驱动身体 + 三 Agent 群像 + 安全纵深 | 守住差异、补鲜活度与发布 |

**Lumina 的优点**：多 Agent 群像独一无二；LLM 同帧驱动身体；安全纵深（沙箱/审批/访问控制/密钥加密）在陪伴类项目里罕见；本地优先、工具生态广；TS 全栈工程一致。

**Lumina 的短板（诚实版）**：① 尚未公开发布，N.E.K.O 已上 Steam；② 广度 > 深度，存在 6 个千行单体（agentRunner 约 2900 行等）；③ 形象仅 Mao 一款 Live2D；④ 实时语音/视觉弱于 N.E.K.O；⑤ 三套对外口径曾不一致（本轮已对齐）。

---

## 5. 本轮（第三阶段）变更明细

### 5.1 你拍板的 3 件事

1. **密钥治理**：全仓扫描确认——会开源的已跟踪代码树**零真实密钥、零内网 IP**（真实 key 只存在于被 `.gitignore` 忽略的本地 `agents/*.json`）；清理注释里的示例内网段；新增忽略运行时产物 `async-tasks.json`。
2. **版本统一 0.1.0**：`package.json` / `package-lock.json`（两处）/ README 徽章 / CHANGELOG 全部对齐为 0.1.0-preview；顺手修复了 `package.json` description 的 GBK 乱码；旧 1.0.0 在 CHANGELOG 标注为内部里程碑。
3. **脱敏角色模板**：`src/assets/agentTemplates/` 导出 Lumina/热茶/Yak 三套 `example.agent.json` + 说明，占位 `127.0.0.1`，保留各角色温度/工具白名单/TTS 音色差异，可安全随仓库分发。

### 5.2 P0 / P1 / P2 六个模块（均为独立、纯逻辑、依赖可注入、带单测）

| 优先级 | 模块 | 解决的问题 | 接入点 |
| --- | --- | --- | --- |
| P0-a | `electron/pet/emotionFusion.ts` | 情绪逐帧硬切 → EMA 惯性 + 单步限幅 + 迟滞反查的连续情绪 | 已接入 `intentDispatcher.dispatchIntent` |
| P0-b | `electron/channels/openclaw/*` + `adapters/openclaw.ts` | 不重复造执行网关，A2A/MCP 委托 OpenClaw，失败安全回退 | 已注册进 `ChannelType`/`ChannelManager` |
| P1-a | `electron/whisper/bargeIn.ts` | TTS 说话时用户插话能立即停播转听（阈值+连续帧+冷却防抖） | 逻辑就绪，待渲染层接麦克风 |
| P1-b | `electron/pet/modelImporter.ts` | 用户可导入自有 Live2D（校验 model3、名字消毒、防目录穿越） | 逻辑就绪，待文件选择器 UI |
| P1-c | `electron/core/unifiedChat.ts` | 统一三供应商调用/响应/错误/超时/模型列表，复用 providerAdapter | 可被各调用方逐步替换 |
| P2 | `electron/agent/toolNoise.ts` | 从 2900 行 agentRunner 抽出纯模块（行为不变，减单体） | agentRunner 已改 import |

附带健壮性修复：`providerAdapter.identifyProvider` 的 Ollama 识别兼容 `127.0.0.1:11434`（原先只认 `localhost:11434`）。

### 5.3 验证结果（交付前实测）

- `npm run typecheck`（tsc --noEmit --strict）：**退出码 0**。
- `npm test`（vitest）：**24 文件通过 / 1 跳过，303 用例 302 通过 / 0 失败**。
  - 过程中发现并修复一个**既有脆弱点**：重型 `agentRunner` 冷加载约 5~8s，撞 vitest 默认 5s 超时会连锁误报「AgentRunner is not a constructor」；已在 `vitest.config.ts` 统一放宽超时（不改任何断言）。
- `npm run build`（electron-vite，main/preload/renderer）：**三端构建成功**，产物含新 `openclaw` chunk 与融合后的 intentDispatcher chunk。
- 提交后安全复核：HEAD 树 `git grep` 真实 key / 内网 IP **均为空**，跟踪 542 文件。

### 5.4 六个本地提交（未 push、未打 tag）

```
4c89eef chore(release): 统一版本到 0.1.0 首个公开预览版
bc7bac9 chore(security): 导出三套脱敏角色配置模板
b76a8a9 feat(pet): 连续情绪融合与 Live2D 形象 UGC 导入器
c1e6133 feat: OpenClaw 桥接、统一模型调用层与语音打断最小闭环
ff90b60 refactor(agent): 抽取工具噪声过滤为独立纯模块
34f0acc test+docs: 放宽重型模块测试超时并记录路线 Non-goals
```

---

## 6. 仍需跟进的问题与风险（按优先级）

### 6.1 需要你本人拍板 / 提供凭据

1. **本地 key 是否轮换**：被忽略的 `agents/*.json` 内有一个 LM Studio 代理 key 与两个内网 endpoint。判断为本地代理 key、风险低；是否轮换由你决定。
2. **建公开仓并 push**：当前仓库无 remote、环境无 gh 登录态，必须用你本人账号操作（命令见 §8）。

### 6.2 逻辑已就绪、差「真实环境/UI」端到端（非阻塞，属下一步接线）

- **OpenClaw 真实联调**：客户端按 A2A/MCP 通用约定实现（`/health`、`/mcp/*`、`/a2a/*`），对接时需以**你部署的 OpenClaw 实际 API 路径/鉴权**为准做一次校准，并用真实任务跑通回退路径。
- **barge-in 麦克风接线**：状态机与单测已完成，需在渲染层把 AnalyserNode 电平喂给 `observe()`、把 `stop()` 接到 TTS 播放器。
- **Live2D 导入 UI**：导入器与单测已完成，需加「选择模型文件夹」入口与导入后的列表注册；同时建议补 1~2 款默认形象，缓解「只有 Mao」。

### 6.3 长期技术债（不影响 v0.1 发布，建议排期）

- 6 个千行单体渐进拆分（本轮已先把 toolNoise 从 agentRunner 剥离作为样板，后续可照此模式继续）。
- `better-sqlite3` 是原生模块：命令行 node 跑测试会有 ABI 告警（已被代码 try/catch 兜住、不影响测试）；**打包/分发前需按 Electron ABI 做 electron-rebuild**（既有事项，发布清单里要带）。
- 实时语音视觉（N.E.K.O 强项）仍是相对短板。

### 6.4 明确不做（已写入 roadmap Non-goals）

- 不跟进 AIRI 的 AI 玩游戏/游戏陪玩主线（同质化、与安全可控目标有张力）。
- 不做第二个通用执行/渠道网关（经 OpenClaw 复用）。
- 不堆砌供应商数量（经 unifiedChat 归一）。

---

## 7. 建议的下一步路线

1. **发布 v0.1.0-preview**（§8 命令），先把「未发布」这个最大短板补上。
2. 完成 barge-in / 模型导入的 UI 接线 + 一款新默认形象，把「鲜活度与可扩展」补齐。
3. 起一个 OpenClaw 实例做一次真实委托联调，验证「Lumina 出大脑、OpenClaw 出手脚」。
4. 对标 N.E.K.O 排「主动搭话 / 屏幕理解 / 实时语音」的深度打磨。
5. 按 toolNoise 样板继续拆千行单体，每个抽取都配单测、保持行为不变。

---

## 8. 发布操作（需你本人 GitHub 账号；代码已备到一键可发）

```powershell
# 1) 在 GitHub 网页新建一个空仓库（不要勾选 README/gitignore），假设名为 lumina-life
# 2) 在项目目录关联并推送（已确认提交树无密钥、agents/ 已忽略）
git remote add origin https://github.com/<你的用户名>/lumina-life.git
git branch -M main
git push -u origin main

# 3) 本地打包 Windows 安装包（发布前先按 Electron ABI 重建原生模块）
npm rebuild better-sqlite3        # 或 npx electron-rebuild -f -w better-sqlite3
npm run pack:win                  # mac/linux 对应 pack:mac / pack:linux
```

> 推送前可再自查一次：`git grep -nE "sk-[A-Za-z0-9]{12,}" HEAD` 与 `git ls-files agents/`（两者都应为空）。

---

## 9. 本轮新增/修改文件一览

- 新增：`electron/pet/emotionFusion.ts`、`electron/pet/modelImporter.ts`、`electron/channels/openclaw/openclawClient.ts`、`electron/channels/adapters/openclaw.ts`、`electron/whisper/bargeIn.ts`、`electron/core/unifiedChat.ts`、`electron/agent/toolNoise.ts`
- 新增测试：`tests/{emotionFusion,openclawClient,bargeIn,modelImporter,unifiedChat,toolNoise.module}.test.ts`
- 新增模板：`src/assets/agentTemplates/{lumina,recha,yak}.example.agent.json` + README
- 修改：`electron/pet/intentDispatcher.ts`、`electron/channels/{types,channelManager}.ts`、`electron/core/providerAdapter.ts`、`electron/agentRunner.ts`、`vitest.config.ts`、`tests/reproduceDegen.test.ts`、`.gitignore`、`package.json`、`package-lock.json`、`README.md`、`CHANGELOG.md`、`docs/lumina-pet-roadmap.md`
