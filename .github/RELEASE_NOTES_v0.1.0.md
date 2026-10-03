# v0.1.0 · 首个公开版本

有生命的 AI 桌宠 —— 三个 Agent 组成的团队，住在你的桌面上。

---

## 这是什么

一个 Electron 桌面应用。表面上是一只桌宠，实际上是一个**多 Agent 团队**：
Lumina（老板，你唯一的对话对象）、Yak（代码工程师）、热茶（审查员）。

用户全程只和 Lumina 说话，后台怎么分工是架构问题，不是用户问题。

## 核心能力

- **三 Agent 流水线** — Lumina 判断该谁干 → 派给 Yak 或热茶 → 汇总成一个连贯的回答
- **三视角对抗式评审** — 正确性 / 安全 / 可复现，各自独立挑刺，多数票 + 高危一票否决，再加一个专查评审遗漏的完整性批评员
- **自动验证-修复闭环** — 写完代码自动跑 `tsc` + 测试，不通过就自己修，最多 3 轮，错误模式没变化会提前收手
- **抗幻觉记忆** — 三层记忆（事实/反思/人格）+ BM25 与 TF-IDF 经 RRF 融合的零依赖混合召回。记忆的权威性由「谁说的」决定，不由模型随手传的 confidence 决定
- **真实 Computer Use** — 截图 → OCR → 定位元素 → 点击/输入，双层安全审查（26 条命令规则）+ 审批流
- **桌宠五形态** — Live2D / VRM / PNGTuber / MMD / 猫咪，表情实时由模型输出驱动
- **桌宠反映真实 Agent 状态** — Yak 写代码时敲键盘、热茶审查时皱眉、验证失败时捂脸
- **8×9 精灵表 UGC** — 不用会 Blender 也能做一只自己的桌宠，左跑由水平镜像自动补出
- **主动但不打扰** — 门控 + 每日配额 + 退避 + 夜间勿扰 + 精力兜底

## 诚实的边界

我们不夸大。**Windows 10/11 x64 是唯一经过实机验证的平台**；macOS 代码已适配但从未在真机跑过；Linux 是 roadmap（Wayland 禁止全局键鼠注入）。

按能力分三档：能稳定做好（写代码、审查、操作桌面、记忆管理）/ 尽力但不保证（开放式模糊任务、游戏陪伴）/ 目前做不到（跨端、应用内本地推理、云同步）。

详见 README 的「诚实能力边界」与 [ROADMAP](docs/ROADMAP.md)。

## 与同类项目的区别

| 项目 | 强在哪 | 缺什么 |
|---|---|---|
| [openclaw](https://github.com/openclaw/openclaw) | 生态规模（391k★） | 零人格 |
| [AIRI](https://github.com/moeru-ai/airi) | 多端 + WebGPU 本地推理 | 无 Agent 编排层 |
| [N.E.K.O](https://github.com/Project-N-E-K-O/N.E.K.O) | 五形态 + Steam 分发 | Agent 能力薄 |
| [cc-haha](https://github.com/NanmiCoder/cc-haha) | Agent 编排成熟 | 桌宠被作者自己写死为「状态提示」 |
| **Lumina** | 人格 + 真实 Agent 团队 + 桌面安全 | 多端与社区体量 |

> cc-haha 的作者原文：其桌宠「只是个状态提示和跳转入口，**不能替你批准权限**」。
> Lumina 恰好越过了这条线 —— 审查员真的在审查代码产出，你也能直接在桌宠窗口对话。

## 开始使用

```bash
git clone https://github.com/chaxu814/lumina-life.git
cd lumina-life
npm install
cp .env.example .env
npm run dev
```

**你需要自备一个模型** —— 这是当前版本最大的门槛，已列入 roadmap：

- **本地（免费 · 隐私好）**：装 [LM Studio](https://lmstudio.org)，加载一个模型，自动连接
- **云端（立刻可用 · 按量付费）**：填一个 API Key（DeepSeek 最便宜）

跑 `lumina doctor` 可以做环境体检。

## 许可

双许可：AGPL-3.0 **或** Apache-2.0，任选其一。
