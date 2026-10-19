---
layout: home

hero:
  name: LuminaLife
  text: 有身体的团队 Agent · 多模态 · 全栈
  tagline: 常驻桌面的三 Agent 团队（Lumina / Yak / 热茶）——拟人形象 + 真实执行 + 安全审批，让 LLM 在桌面上「活」过来并且真的干活。
  image:
    src: /logo.png
    alt: LuminaLife
  actions:
    - theme: brand
      text: 快速上手
      link: /FAQ
    - theme: alt
      text: 故障排除
      link: /TROUBLESHOOTING
    - theme: alt
      text: GitHub
      link: https://github.com/chaxu814/lumina-life

features:
  - icon: 🖥️
    title: Electron 桌面
    details: 基于 Electron 40 构建，Windows 10/11 x64 为**唯一实机验证**平台；macOS 标注 beta，Linux 为 roadmap。托盘常驻。
  - icon: 👥
    title: 多 Agent 团队
    details: Lumina（老板）+ Yak（代码工程师）+ 热茶（审查员）。流水线委派、三视角对抗式评审、动态雇实习生、无依赖任务并行。
  - icon: 😊
    title: 情感系统
    details: 5 维情绪 + 心情/精力/亲密度连续值，带惯性、随机漂移与昼夜节律。亲密度由真实委派事件驱动并持久化。
  - icon: 🎭
    title: 桌宠五形态
    details: Live2D / VRM / PNGTuber / MMD / 猫咪。表情实时由模型输出驱动，并可绑定**真实 Agent 执行状态**。
  - icon: 🧠
    title: 真实记忆
    details: 三层记忆（事实/反思/人格）+ BM25 与 TF-IDF 经 RRF 融合的零依赖混合召回，含**防幻觉固化**的来源置信度机制。
  - icon: 🛠️
    title: 139 个工具
    details: 三档模式按需加载，支持 MCP 扩展与技能商店。
  - icon: 🛡️
    title: 智能沙箱
    details: 双层安全审查（消息/参数级 + 命令级 32 条规则）、审批流、权限白名单、隐私遮罩。
  - icon: 🎤
    title: 语音交互
    details: 麦克风录音 + Whisper ONNX 本地识别 + 多 provider TTS 输出。
  - icon: 🔄
    title: MCP 集成
    details: 支持通过 MCP 协议扩展工具，接入外部 Agent 服务。
---

## 项目结构

```
lumina-life/
├── electron/                  # 主进程 —— Agent 引擎
│   ├── main.ts                # 入口（窗口、IPC、tray）
│   ├── agentRunner.ts         # Agent 主循环（ReAct）
│   ├── delegationManager.ts   # 委派编排 + 自动验证修复闭环
│   ├── tools/                 # 139 个工具（registry + impl/）
│   ├── team/                  # 团队：动态雇工 / 对抗评审 / 自主性 / 教学
│   ├── orchestration/         # 任务看板 / 阶段门控 / 路由 / 并行引擎
│   ├── memory/                # 三层记忆 + 混合召回 + 防幻觉
│   ├── proactive/             # 主动发言门控（打扰预算）
│   ├── pet/                   # 桌宠：五形态 + 精灵表 + 状态桥接
│   ├── security/              # 双层安全审查
│   └── core/platform/         # Windows / macOS / Linux 适配层
├── src/                       # 渲染进程（React 19 + Zustand）
├── tests/                     # 308 文件 / 4607 用例（Vitest）
├── agents/                    # 三个 Agent 的配置（工具白/黑名单）
├── skills/                    # 技能目录
├── docs/                      # 文档站（VitePress）
└── package.json
```

## 功能一览

| 模块 | 状态 | 说明 |
|------|------|------|
| 基础对话 | ✅ | 多 provider LLM（LM Studio / Ollama / 云端 API），流式输出 |
| 三 Agent 团队 | ✅ | 流水线委派 + 三视角对抗评审 + 动态雇工 + 无依赖任务并行 |
| 桌宠五形态 | ✅ | Live2D / VRM / PNGTuber / MMD / 猫咪 |
| 桌宠绑定 Agent 状态 | ✅ | 写代码敲键盘、审查皱眉、失败捂脸；零 LLM 开销 |
| 精灵表 UGC | ✅ | 8×9 规格 + AI 生成提示词 + 导入校验器 |
| 长期记忆 | ✅ | 三层 + BM25/TF-IDF RRF 混合召回 + 防幻觉固化 + 证据链 |
| 主动发言 | ✅ | 门控 + 配额 + 退避 + 夜间勿扰 + 精力兜底 |
| Computer Use | ✅ | 截图 / OCR / 键鼠 / UIA 元素树 / 隐私遮罩 |
| 安全沙箱 | ✅ | 双层审查（26 条命令规则）+ 审批流 + 权限白名单 |
| 工具系统 | ✅ | 139 个工具，三档模式按需加载 + MCP + 技能商店 |
| 桌面自动化 | ✅ | 跨平台适配层（**仅 Windows 实机验证**） |
| 游戏陪伴 | ⚠️ 可选扩展 | Minecraft / Factorio，需额外安装插件 |
| 语音输入输出 | ✅ | Whisper ONNX 本地识别 + 多 provider TTS |
| REST API / CLI | ✅ | 10+ 端点 + `lumina` 命令行 |
| 团队社交 | ✅ | 群聊 + Moments 朋友圈 + 早安仪式 |
| 定时任务 | ✅ | Cron 风格调度 |
| macOS 桌面操控 | ⚠️ beta | 代码已适配，**从未在真机验证** |
| Linux | 🔜 | Roadmap（Wayland 禁止全局键鼠注入） |
| 应用内本地推理 | 🔜 | 当前需外挂 LM Studio |

---

> 有问题？先看 [FAQ](/FAQ) 和 [故障排除](/TROUBLESHOOTING)。
