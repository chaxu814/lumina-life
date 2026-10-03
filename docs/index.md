---
layout: home

hero:
  name: LuminaLife
  text: Agent 桌宠 · 多模态 · 全栈
  tagline: 基于 Electron + React 的 AI Agent 多模态桌宠 —— 让 LLM 在桌面上「活」过来。
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
    details: 基于 Electron 构建，支持 Windows/Mac/Linux，可通过 tray 常驻系统托盘。
  - icon: 🧠
    title: 多 Agent 协作
    details: 内置 Agent 池，支持主 Agent 委托子 Agent，协作完成任务。
  - icon: 🎮
    title: Live2D 桌宠
    details: 集成 Live2D 看板娘（Kanban），支持交互反馈与表情切换。
  - icon: 🛠️
    title: 工具系统
    details: 可扩展的 Tool 系统，支持 MCP、搜索、编码等能力的灵活组合。
  - icon: 🎤
    title: 语音交互
    details: 支持麦克风录音、Whisper ONNX 本地语音识别、Edge-TTS 语音输出。
  - icon: 🔄
    title: MCP 集成
    details: 支持通过 MCP 协议扩展工具与模型服务，灵活接入外部 AI 能力。
---

## 项目结构

```
<项目目录>
├── electron/           # Electron 主进程
│   ├── main.ts         # 入口（BrowserWindow、IPC、tray）
│   ├── tools/          # 工具注册与实现
│   │   ├── index.ts         # 工具路由 + 注册
│   │   ├── registry.ts      # 工具定义、类型、schema
│   │   ├── impl/            # 工具实现
│   │   │   ├── file.ts      # 文件读写相关
│   │   │   ├── tool_agent.ts # Agent 间通信工具
│   │   │   ├── web.ts       # 搜索 / fetch 工具
│   │   │   └── whisper.ts   # 语音识别工具
│   ├── whisper/        # Whisper ONNX 语音模块
│   │   ├── index.ts         # 对外接口
│   │   ├── transcriber.ts   # ONNX 推理封装
│   │   └── recorder.ts      # 麦克风录音
│   └── services/       # 后台服务
├── src/                # React 前端
│   ├── App.tsx
│   ├── components/
│   └── hooks/
├── public/
│   └── kanban/         # Live2D 模型
├── docs/               # VitePress 文档站
│   ├── .vitepress/
│   ├── index.md
│   ├── FAQ.md
│   └── TROUBLESHOOTING.md
├── package.json
├── tsconfig.json
├── vite.config.ts      # Vite + React + Electron
└── electron-builder.yml
```

## 功能一览

| 模块 | 状态 | 说明 |
|------|------|------|
| 基础对话 | ✅ | WebSocket 连接 LLM，即时对话 |
| Agent 池 | ✅ | 主 Agent + 子 Agent 委托机制 |
| 拖拽文件 | ✅ | IPC 拖拽文件到 Agent |
| Live2D 桌宠 | ✅ | Kanban 看板娘 + 表情交互 |
| 文件工具 | ✅ | 读写、搜索、编辑 |
| Web 搜索 | ✅ | DuckDuckGo + Sogou |
| 定时任务 | ✅ | Cron Agent 计划任务 |
| MCP 工具 | ✅ | MCP Server 集成 |
| 语音输入 | 🚧 | Whisper + ONNX 本地识别 |
| TTS 输出 | 🚧 | Edge-TTS / 本地 TTS |
| 文档站 | ✅ | VitePress + GitHub Pages |
| 群聊模式 | 🚧 | 多 Agent 群聊 |

---

> 有问题？先看 [FAQ](/FAQ) 和 [故障排除](/TROUBLESHOOTING)。
