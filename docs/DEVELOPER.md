# 🛠️ 开发者指南 — Lumina Life

> 给想了解 Lumina 内部机制、做二次开发或贡献代码的你。  
> 目标读者：有一定 Node.js / TypeScript / Electron 基础的开发者。

---

## 📋 目录

1. [开发环境要求](#-开发环境要求)
2. [一步启动](#-一步启动)
3. [项目结构深度解析](#-项目结构深度解析)
4. [核心架构](#-核心架构)
5. [开发工作流](#-开发工作流)
6. [配置文件详解](#-配置文件详解)
7. [数据库 Schema](#-数据库-schema)
8. [测试指南](#-测试指南)
9. [打包与发布](#-打包与发布)
10. [常见开发问题](#-常见开发问题)

---

## ✅ 开发环境要求

| 依赖 | 最低版本 | 推荐版本 | 用途 |
|------|---------|---------|------|
| Node.js | 18.x | 22.x | 运行时 |
| npm | 9.x | 10.x | 包管理 |
| Git | 2.30+ | 2.40+ | 版本控制 |
| Python | 3.10（可选） | 3.12 | 语音/向量功能 |
| 编辑器 | — | VS Code | 推荐 |

**Windows 额外：**
- Windows 10+（推荐 Windows 11）
- 构建工具：`npm install -g windows-build-tools`（如遇 native 模块编译失败）

**macOS 额外：**
- Xcode Command Line Tools：`xcode-select --install`
- 如遇签名问题，开发环境可跳过：`export CSC_IDENTITY_AUTO_DISCOVERY=false`

**Linux 额外：**
```bash
sudo apt-get install -y libappindicator1 libayatana-appindicator3-1 libnss3 libfuse2
```

---

## 🚀 一步启动

```bash
# 1. 克隆
git clone https://github.com/lumina-life/lumina-life.git
cd lumina-life

# 2. 安装依赖
npm install

# 3. 配置文件
cp .env.example .env
# 编辑 .env 填入 LLM 配置（默认 LM Studio 已预配）

# 4. 启动开发模式
npm run dev

# 5. 可选：安装 Python 依赖（语音/向量）
pip install -r python/requirements.txt
```

> 💡 第一次启动后，在设置面板中配置 LLM 连接即可开始对话。

---

## 📁 项目结构深度解析

```
lumina-life/
├── electron/                    # 👈 核心：主进程（Node.js 层）
│   ├── main.ts                  #    入口：BrowserWindow、IPC、tray
│   ├── preload.ts               #    预加载脚本（contextBridge）
│   ├── lumina-core/             #    Agent 引擎核心
│   │   ├── agent.ts             #       Agent 生命周期
│   │   ├── agent-pool.ts        #       Agent 池管理
│   │   ├── chat-engine.ts       #       LLM 对话引擎
│   │   ├── emotion-system.ts    #       5维情绪系统
│   │   └── intimacy-system.ts   #       亲密度系统
│   ├── services/                #    后台服务
│   │   ├── memory/              #       记忆系统（SQLite + 向量）
│   │   ├── security/            #       沙箱 + 审批流
│   │   ├── cron/                #       定时任务
│   │   └── mcp/                 #       MCP 协议集成
│   ├── tools/                   #    🔧 工具系统
│   │   ├── registry.ts          #       工具注册表
│   │   ├── index.ts             #       工具路由
│   │   ├── schema.ts            #       参数 Schema
│   │   └── impl/                #       88+ 工具实现
│   │       ├── file.ts          #       · 文件读写
│   │       ├── web.ts           #       · 搜索 / 抓取
│   │       ├── tool_agent.ts    #       · Agent 间通信
│   │       └── whisper.ts       #       · 语音识别
│   ├── ipc/                     #    进程间通信
│   └── utils/                   #    通用工具
│
├── src/                         # 👈 渲染进程（React 19）
│   ├── App.tsx                  #    根组件
│   ├── main.tsx                 #    入口
│   ├── components/              #    23 个面板组件
│   │   ├── ChatWindow/          #       聊天窗口
│   │   ├── AgentPanel/          #       Agent 面板
│   │   ├── MemoryPanel/         #       记忆面板
│   │   ├── EmotionDisplay/      #       情绪显示
│   │   └── SecurityPanel/       #       安全中心
│   ├── store/                   #    Zustand 状态管理
│   ├── hooks/                   #    自定义 Hooks
│   └── styles/                  #    样式（Tailwind?）
│
├── tests/                       # 🧪 测试
│   ├── unit/                    #    单元测试
│   ├── integration/             #    集成测试
│   └── e2e/                     #    E2E 测试
│
├── skills/                      # 📦 技能商店
│   └── ...                      #    社区技能包
│
├── knowledge/                   # 📚 知识库
│
├── docs/                        # 📖 文档站（VitePress）
│   ├── .vitepress/
│   ├── index.md
│   ├── API.md                   #    REST API 文档
│   ├── ARCHITECTURE.md          #    架构设计
│   ├── DEVELOPER.md             #    👈 你在这里
│   ├── FAQ.md                   #    常见问题
│   └── TROUBLESHOOTING.md       #    故障排除
│
├── dist/                        # 打包输出
├── out/                         # 编译输出
│
├── package.json
├── tsconfig.json
├── electron-vite.config.ts
└── electron-builder.yml
```

---

## 🧠 核心架构

### 三 Agent 协作模型

```
┌─────────────────────────────────────────────┐
│             用户                              │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│           Lumina 🐱 (BOSS)                   │
│   角色：团队主理人                             │
│   职责：接收用户请求、协调团队、情感交互         │
└───────┬──────────────────────┬───────────────┘
        │                      │
┌───────▼──────────┐  ┌───────▼──────────────┐
│  热茶 🍵 (DEV)   │  │  Yak 📊 (ANAL)       │
│ 角色：开发者 Agent │  │ 角色：分析 Agent      │
│ 职责：写代码、查错 │  │ 职责：数据分析、研究   │
│ 工具：文件、终端   │  │ 工具：搜索、可视化    │
└──────────────────┘  └──────────────────────┘
```

### Agent 委托流程

```
用户请求 → Lumina 判断 → 需要开发？→ 委托热茶
                        → 需要分析？→ 委托 Yak
                        → 普通对话 → Lumina 自己回答
```

### 情绪系统

5 维情绪模型：
- **Valence**（愉悦度）：−1 ~ +1
- **Arousal**（激活度）：0 ~ 1
- **Dominance**（支配度）：0 ~ 1
- 情绪状态：`happy` · `sad` · `angry` · `surprised` · `fearful` · `neutral` · `excited` · `calm`
- 亲密度：0 ~ 100（随交互增长）

### 记忆系统

```
用户输入 → 短期记忆（当前会话）
         → 重要？→ 长期记忆（SQLite）
                → 向量化 → 语义检索（向量数据库）
                → 摘要 → 每日记忆（MMR）
```

---

## 🔧 开发工作流

### 添加新工具

```typescript
// electron/tools/impl/my-tool.ts
import { ToolDefinition } from '../registry';

export const MyTool: ToolDefinition = {
  name: 'my_tool',
  description: '我的自定义工具',
  category: 'utility',
  parameters: {
    input: { type: 'string', required: true, description: '输入内容' },
  },
  handler: async (params: { input: string }) => {
    return { result: `你输入了: ${params.input}` };
  },
};
```

在 `electron/tools/impl/index.ts` 中导出并注册。

### 添加新技能

参考 [技能开发文档]（待完善），技能是一个独立的目录，包含 `SKILL.md` 描述文件。

### 运行测试

```bash
# 全部测试
npm test

# 监听模式
npm run test:watch

# 指定文件
npx vitest run tests/unit/emotion.test.ts

# 覆盖率
npx vitest run --coverage
```

### 代码检查

```bash
# TypeScript 类型检查
npx tsc --noEmit

# ESLint（如已安装）
npx eslint electron/ src/ --ext .ts,.tsx
```

---

## ⚙️ 配置文件详解

### `.env`

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LUMINA_API_PORT` | `3456` | API 端口 |
| `LUMINA_API_ENABLED` | `false` | 是否启用 REST API |
| `LUMINA_API_KEY` | — | API 鉴权 Key |
| `LLM_PROVIDER` | `lm-studio` | LLM 提供商 |
| `LLM_BASE_URL` | `http://127.0.0.1:1234/v1` | API 地址 |
| `LLM_MODEL` | — | 模型名 |
| `MEMORY_DB_PATH` | `~/.lumina/memory.db` | 记忆数据库路径 |
| `LOG_LEVEL` | `info` | 日志级别 |

### 用户配置（`~/.lumina/config.json`）

```json
{
  "llm": {
    "provider": "lm-studio",
    "baseUrl": "http://127.0.0.1:1234/v1",
    "model": "qwen-2.5-7b"
  },
  "language": "zh-CN",
  "theme": "light",
  "api": {
    "port": 3456,
    "enabled": true,
    "key": ""
  },
  "security": {
    "sandbox_level": "medium",
    "auto_approve": false
  }
}
```

---

## 🗄️ 数据库 Schema

### 记忆表（memory）

```sql
CREATE TABLE memory (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  embedding   BLOB,              -- 向量嵌入
  agent_id    TEXT NOT NULL,
  importance  REAL DEFAULT 0.5,  -- 重要性 0~1
  tags        TEXT,              -- JSON 数组
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_memory_agent ON memory(agent_id);
```

### 会话表（sessions）

```sql
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  messages    TEXT,              -- JSON 数组
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 情绪日志（emotion_log）

```sql
CREATE TABLE emotion_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL,
  emotion     TEXT NOT NULL,
  valence     REAL,
  arousal     REAL,
  dominance   REAL,
  intimacy    INTEGER,
  reason      TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 📦 打包与发布

### 本地打包

```bash
# Windows
npm run pack:win

# macOS
npm run pack:mac

# Linux
npm run pack:linux

# 全部平台
npm run pack:all
```

输出目录：`dist/`

### CI/CD 自动发布

推送 Tag `v*` 会自动触发 GitHub Release（详见 `.github/workflows/test.yml`）：

```bash
git tag v1.0.1
git push origin v1.0.1
```

CI 会构建三平台安装包并创建 Draft Release。

### 版本号规范

遵循 [SemVer](https://semver.org/)：

```
v<major>.<minor>.<patch>
  ↑ 破坏性变更  ↑ 新功能  ↑ Bug 修复
```

---

## ❓ 常见开发问题

### `npm install` 报 native 模块编译错误

```bash
# Windows
npm install -g windows-build-tools

# macOS
xcode-select --install

# Linux
sudo apt-get install build-essential python3
```

### 开发时 Electron 白屏

确认 `electron-vite dev` 正在运行，且没有端口冲突（默认 5173）。

### 修改了 electron/ 下的代码未生效

主进程代码修改后需要重启 Electron（`electron-vite dev` 会自动重启）。

### 如何查看日志

日志输出在终端中。设置 `LOG_LEVEL=debug` 可查看详细日志。

### 需要调试主进程

```bash
# VSCode: 在 .vscode/launch.json 中添加
{
  "type": "node",
  "request": "attach",
  "name": "Attach to Electron",
  "port": 9229
}
```

启动后在主进程代码中加 `debugger;` 即可断点调试。

---

## 🔗 参考链接

- [Electron 官方文档](https://www.electronjs.org/docs/latest)
- [React 19 文档](https://react.dev/)
- [Zustand](https://github.com/pmndrs/zustand)
- [VitePress](https://vitepress.dev/)
- [electron-vite](https://electron-vite.org/)
- [electron-builder](https://www.electron.build/)

---

> 最后更新：2026-07-28 · 如有疑问欢迎提交 Issue。
