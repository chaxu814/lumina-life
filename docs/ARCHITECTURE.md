# Lumina Life 架构概览

![Lumina Life 架构图](../media/architecture-overview.png)

## 总体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Electron Shell                                │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                   主进程 (Main Process)                         │   │
│  │                   electron/ 目录                                │   │
│  │                                                                  │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │   │
│  │  │  Agent 引擎  │  │  工具系统    │  │  记忆系统    │              │   │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │   │
│  │         │                │                │                       │   │
│  │  ┌──────┴──────┐  ┌─────┴──────┐  ┌──────┴──────┐              │   │
│  │  │  安全层     │  │  技能系统   │  │  MCP/API   │              │   │
│  │  └─────────────┘  └────────────┘  └─────────────┘              │   │
│  │                                                                  │   │
│  │  ┌──────────────────────────────────────────────────────────┐   │   │
│  │  │               IPC 通信层 (ipc/)                            │   │   │
│  │  └──────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────┬───────────────────────────────┘   │
│                                 │                                    │
│  ┌──────────────────────────────┴───────────────────────────────┐   │
│  │                   渲染进程 (Renderer Process)                    │   │
│  │                   src/ 目录                                     │   │
│  │                                                                  │   │
│  │  23+ 面板 · React 19 · Zustand 5 · UnoCSS · i18next             │   │
│  │                                                                  │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │   │
│  │  │ 聊天面板  │ │ 团队群聊  │ │ 设置面板  │ │ 更多面板  │          │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## 核心模块

### 1. Agent 引擎 (`electron/`)

Agent 引擎是 Lumina 的大脑，负责 LLM 调用、工具执行、上下文管理等核心逻辑。

| 文件 | 职责 |
|------|------|
| `agentRunner.ts` | Agent 执行循环（ReAct 模式）：接收消息 → 调用 LLM → 执行工具 → 生成回复 |
| `agentPool.ts` | Agent 实例池管理，生命周期控制 |
| `agentConfig.ts` | 每个 Agent 独立的 LLM 配置（模型、Endpoint、参数） |
| `agentSkills.ts` | Agent 可用的技能注册与匹配 |
| `core/llmProvider.ts` | 统一的 LLM API 调用层，支持流式/非流式 |
| `core/providerManager.ts` | 多 Provider 管理（兼容 QwenPaw 配置格式） |
| `core/providerAdapter.ts` | Provider 接口适配器 |
| `core/reactEngine.ts` | ReAct 循环引擎：工具调用解析、结果注入、自动继续 |

### 2. 三 Agent 团队 (`electron/agents/`)

每个 Agent 有独立的 prompt 文件（AGENTS.md + SOUL.md）和配置：

| Agent | 角色 | 对外可见 | 专长 |
|-------|------|---------|------|
| **Lumina** 🐱 | 团队老大 — 唯一对用户接口 | ✅ 是用户看到的全部 | 对话 · 情绪感知 · 日常陪伴 |
| **热茶 (Recha)** 🍵 | 毒舌技术宅 — 后台工作者 | ❌ 用户不可见 | 代码审查 · 挑错 · 风险评估 |
| **Yak** 📊 | 冷静工程师 — 后台工作者 | ❌ 用户不可见 | 写代码 · 调试 · 重构 · 跑测试 |

**委托流程：**
```
用户提问 → Lumina 判断 → 需要写代码？→ 委托 Yak → 委托热茶审查 → 返回 Lumina → 回复用户
```

| 文件 | 职责 |
|------|------|
| `agentTeamManager.ts` | 模式管理（工作/学习/娱乐/空闲）+ 团队状态 |
| `agentTeamPersonas.ts` | Agent 角色定义和模式配置 |
| `agentSocialEngine.ts` | 团队社交引擎（群聊、早安仪式、朋友圈） |
| `delegationManager.ts` | 任务委托、验证闭环、阶段门控 |
| `rechaRunner.ts` | 热茶执行器（代码审查工作流） |
| `yakRunner.ts` | Yak 执行器（编码/调试工作流） |

### 3. 工具系统 (`electron/tools/`)

88+ 内置工具，覆盖搜索、文件操作、代码执行、桌面操控等场景。

| 文件/目录 | 职责 |
|-----------|------|
| `tools/registry.ts` | 工具注册中心，所有工具的元数据和执行函数注册 |
| `tools/index.ts` | 工具系统入口，导出注册表和类型 |
| `tools/types.ts` | 工具定义类型（ToolDef, ToolResult 等） |
| `tools/impl/` | 每个工具的具体实现（约 40 个文件） |

核心工具示例：
- `browser.ts` — 浏览器操控（Playwright）
- `computerUse.ts` — 桌面操控（截图 → VLM → 键鼠执行）
- `webSearch.ts` / `webFetch.ts` — 网络搜索与页面抓取
- `fileRead.ts` / `fileWrite.ts` / `fileEdit.ts` / `fileList.ts` — 文件操作
- `shell.ts` — 终端命令执行
- `memory.ts` / `memory_v2.ts` — 记忆检索与存储
- `mcp.ts` — MCP 协议工具调用

### 4. 记忆系统 (`electron/memory/`)

真正的长期记忆，不是上下文窗口。

| 文件 | 职责 |
|------|------|
| `memoryStore.ts` | 基于 SQLite + 向量检索的记忆存储 |
| `base-memory-manager.ts` | 记忆管理器基类 |
| `unified.ts` | 统一记忆接口（短期 + 长期 + 向量） |
| `summarizer.ts` | 记忆摘要生成 |
| `memoryEvidence.ts` | 证据链管理（置信度评分） |
| `memoryRefiner.ts` | 记忆精炼（定时清理低质量记忆） |
| `memoryStructured.ts` | 结构化记忆（事实、反思、人格） |

### 5. 安全体系 (`electron/`)

多层安全防护，确保 AI 不会误操作。

| 层 | 文件 | 职责 |
|----|------|------|
| 1️⃣ 权限控制 | `accessControl.ts` | 谁可以用什么工具 |
| 2️⃣ 威胁检测 | `securityGuard.ts` | 命令注入 / 路径穿越 / 数据泄露等 8 类检测 |
| 3️⃣ 路径隔离 | `sandbox.ts` | 文件操作重定向 + 安全区检查 |
| 4️⃣ 审批流 | `approvalService.ts` | 中高风险操作弹窗确认 |
| 5️⃣ 进程沙箱 | `processSandbox.ts` | shell 命令执行隔离 |
| 6️⃣ 密钥拦截 | `injectionGuard.ts` | Token/Key 自动检测 + 阻止外泄 |

### 6. 技能系统 (`electron/skills/` + 用户 `skills/`)

可插拔的能力扩展，像安装 App 一样安装技能。

| 文件 | 职责 |
|------|------|
| `skillLoader.ts` | 技能目录扫描与加载 |
| `skillScanner.ts` | 技能元数据提取 |
| `skillInstaller.ts` | 技能安装/卸载/升级 |
| `skillMarket.ts` | 技能商店（远程技能索引） |
| `skillPool.ts` | 技能执行池管理 |
| `skillPipeline.ts` | 技能流水线编排 |
| `skills/` | 内置技能（files_core, git, mcp, memory, shell, system, tasks, team, web_search） |

### 7. 渲染进程 (`src/`)

React 19 + TypeScript + Zustand 5 构建的桌面 UI。

| 目录 | 职责 |
|------|------|
| `src/panels/` | 23+ 功能面板（聊天、群聊、设置、记忆剧场、安全中心等） |
| `src/components/` | 可复用 UI 组件（情绪条、朋友圈、任务面板等） |
| `src/stores/` | Zustand 状态管理（appStore, agentRuntimeStore 等） |
| `src/services/` | 前端服务（情绪系统、语音、TTS、主动聊天等） |
| `src/i18n/` | 国际化（中文、英文） |

### 8. API 与 CLI

| 入口 | 文件 | 说明 |
|------|------|------|
| REST API | `api/server.ts` | 10+ 端点：聊天、工具、Agent 管理、记忆、技能 |
| CLI | `cli/index.ts` | 命令行：`lumina chat`, `lumina doctor`, `lumina tool` 等 |
| 频道 | `channels/` | 多渠道适配器（钉钉、QQ、Slack、Telegram、企业微信） |

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 40 |
| 前端 | React 19 + TypeScript + Vite |
| 状态管理 | Zustand 5 (persist) |
| 样式 | UnoCSS |
| 构建 | electron-vite + electron-builder |
| 数据库 | better-sqlite3 |
| 测试 | Vitest |
| 自动更新 | electron-updater (GitHub Releases) |
| 国际化 | i18next + react-i18next |
| 协议 | MCP (Model Context Protocol) |

## 数据流 (一次典型对话)

```
用户发送消息
    │
    ▼
渲染进程 (ChatPanel.tsx)
    │  IPC invoke
    ▼
主进程 (agentIpc.ts → agentRunner.ts)
    │
    ├─ 安全审查 (securityGuard.ts)
    ├─ 意图识别 (模式检测)
    ├─ 上下文构建 (systemPrompt.ts + 历史消息)
    ├─ LLM 调用 (llmProvider.ts)
    │     │
    │     ├─ 需要搜索? → webSearch → 注入结果 → 继续 LLM
    │     ├─ 需要写代码? → 委托 Yak → 热茶审查 → 收集结果
    │     └─ 需要审批? → approvalService → 等待用户确认
    │
    └─ 回复流式输出 → IPC 推送到渲染进程
         │
         ▼
    渲染进程流式打字 (animateTyping) → TTS 播报 → 记忆持久化
```

## 模块间依赖关系

```
agentIpc.ts (IPC 入口)
  ├── agentRunner.ts (核心执行引擎)
  │     ├── llmProvider.ts (LLM 通信)
  │     │     └── providerManager.ts (多 Provider 路由)
  │     ├── reactEngine.ts (ReAct 循环)
  │     ├── tools/registry.ts (工具调用)
  │     │     └── tools/impl/* (工具实现)
  │     ├── securityGuard.ts (安全检查)
  │     ├── sandbox.ts (路径隔离)
  │     ├── memory/ (记忆读写)
  │     └── delegationManager.ts (团队委托)
  │           ├── yakRunner.ts
  │           └── rechaRunner.ts
  ├── agentSocialEngine.ts (社交引擎)
  ├── approvalService.ts (审批流)
  └── skillPool.ts (技能执行)
```

---

> ⚡ **设计理念:** Lumina 不是"一个 AI 做所有事"，而是三个各有所长的 Agent 组成团队，通过明确的委托流程和阶段门控，实现质量可控的自动化。
>
> 🛡️ **安全优先:** 所有工具调用和代码执行都经过多层安全检查，确保 AI 能力再强也不会失控。
