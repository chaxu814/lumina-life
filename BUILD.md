# Lumina Life — 构建与开发指南

## 环境要求

| 组件 | 版本要求 | 说明 |
|------|---------|------|
| **Node.js** | ≥ 18.x | 运行时（已安装到 `C:\Program Files\nodejs\`） |
| **npm** | ≥ 9.x | 随 Node.js 自带 |
| **Git** | 可选 | 版本管理 |

## ⚡ 快速开始

### 1. 设置环境

双击 **`setup.bat`** 自动完成：
- 检测 Node.js 位置
- 临时添加到 PATH
- 检查 node_modules 依赖
- 显示可用命令

### 2. 启动开发模式

```bash
npm run dev
```

启动后：
- 主进程 → `electron-vite` 自动编译 + 热重载
- 渲染进程 → Vite React HMR（保存即刷新）
- 修改 `electron/` 下的源码 → 自动重新构建

### 3. 生产构建

```bash
npm run build
```

输出到 `out/` 目录。

### 4. 打包安装程序

```bash
npm run pack:win
```

生成 Windows 安装包到 `dist/` 目录。

## 🔧 常用命令

| 命令 | 作用 |
|------|------|
| `npm run dev` | 开发模式（热重载） |
| `npm run build` | 生产构建 |
| `npm run preview` | 预览构建结果 |
| `npm run pack:win` | 打包 Windows 安装程序 |
| `npm run test` | 运行单元测试 |
| `npx tsc --noEmit` | 只检查类型错误（不输出文件） |
| `npm run doctor` | 运行环境诊断 |

## 🧱 项目架构

```
H:\LuminaLife2.0\
├── electron/              # 主进程源码 (TypeScript)
│   ├── main.ts            # 入口 — 窗口、IPC 注册
│   ├── preload.ts         # preload 桥接 — 渲染↔主进程
│   ├── ipc/               # IPC 处理器
│   │   ├── computerUseIpc.ts   # 桌面操控
│   │   ├── teamIpc.ts          # 团队/实时语音/角色同步
│   │   └── ...
│   ├── agentTeamPersonas.ts    # Agent 角色定义
│   ├── agentTeamManager.ts     # 团队管理
│   └── ...
├── src/                   # 渲染进程 (React + TypeScript)
│   ├── App.tsx            # 应用根组件 + 面板路由
│   ├── panels/            # 功能面板
│   │   ├── ToolboxPanel.tsx    # 🧰 工具箱（记录→整理→回顾）
│   │   └── GroupChatView.tsx   # 团队群聊 + 实时语音
│   ├── components/        # 通用组件
│   ├── stores/            # Zustand 状态管理
│   └── types.d.ts         # Window.luminaAPI 全局类型
├── out/                   # 构建输出（自动生成）
│   ├── main/index.js      # 编译后的主进程
│   └── preload/index.js   # 编译后的 preload
├── package.json           # 项目配置 + 依赖
├── tsconfig.json          # TypeScript 配置
├── setup.bat              # 环境设置脚本
└── BUILD.md               # 本文件
```

## ❓ 常见问题

### Q: `node` 命令找不到？
运行 `setup.bat`，或将 `C:\Program Files\nodejs` 加入系统环境变量 PATH。

### Q: 修改了 `electron/` 下的源码，但没生效？
因为 `out/main/index.js` 是预编译的，需要重新构建：
```bash
npm run build
```
或者用 `npm run dev`（自动监听变化）。

### Q: 无法运行 `npx tsc --noEmit`？
先运行 `setup.bat` 确保 Node.js 在 PATH 中。

### Q: 打包后体积太大？
`electron-builder` 默认打包整个 Electron 运行时（~150MB），这是正常的。
