# 🎉 贡献指南 — Lumina Life

感谢你对 Lumina Life 感兴趣！无论你是修 Bug、加功能、写文档还是提建议，都欢迎。

---

## 📋 目录

1. [行为准则](#-行为准则)
2. [快速开始](#-快速开始)
3. [开发环境](#-开发环境)
4. [项目结构](#-项目结构)
5. [编码规范](#-编码规范)
6. [提交 PR](#-提交-pr)
7. [测试指南](#-测试指南)
8. [提问与讨论](#-提问与讨论)

---

## 📜 行为准则

本项目采用 [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) 行为准则。简而言之：**友善、尊重、包容**。

---

## 🚀 快速开始

```bash
# 1. Fork 本仓库
# 2. 克隆到本地
git clone https://github.com/<你的用户名>/lumina-life.git
cd lumina-life

# 3. 安装依赖
npm install

# 4. 复制环境配置
cp .env.example .env
# 编辑 .env 填入 LLM API 配置（至少一个提供商）

# 5. 启动开发模式
npm run dev
```

> 💡 **需要 Node.js v18+**。推荐使用 [nvm-windows](https://github.com/coreybutler/nvm-windows) 管理 Node 版本。

---

## 🛠️ 开发环境

### 必要工具

| 工具 | 版本要求 | 说明 |
|------|---------|------|
| Node.js | ≥ 20.0.0 | 推荐 v20 LTS 或 v22（package.json `engines` 口径） |
| npm | ≥ 9 | 随 Node 自带 |
| Git | ≥ 2.30 | 版本管理 |
| Windows | 10+ | 目前仅支持 Windows |

### 推荐工具

- **VS Code** — 项目自带 `.vscode/` 配置（如有）
- **ESLint** — 代码风格检查
- **Vitest** — 测试运行器

### 可用命令

```bash
npm run dev          # 启动开发模式（Electron + Vite HMR）
npm run build        # 构建生产版本
npm run pack:win     # 构建 + 打包 NSIS 安装包
npm test             # 运行测试
npm run test:watch   # 监听模式
npm run cli          # CLI 模式（无 GUI）
npm run api          # REST API 服务
npm run doctor       # 系统诊断
```

---

## 📁 项目结构

> 2026-10-19 按 HEAD 实测校正。完整版（含每个目录的职责）见
> [docs/DEVELOPER.md](docs/DEVELOPER.md#-项目结构深度解析)。

```
lumina-life/
├── electron/           # 主进程（约 14.8 万行）
│   ├── agentRunner.ts          # ReAct 主循环（4,171 行）
│   ├── delegationManager.ts    # 委托 + 五阶段门控
│   ├── agentTeamPersonas.ts    # 三 Agent 人格（唯一事实源）
│   ├── rolePolicy.ts           # 角色工具硬闸门
│   ├── securityGuard.ts        # 分级安全审查
│   ├── memory/                 # 记忆（SQLite + BM25/TF-IDF RRF）
│   ├── tools/                  # 139 个已注册工具（registry + impl/）
│   ├── team/                   # 对抗评审 / 动态雇工 / 任务板
│   ├── orchestration/          # 路由 / 复杂度 / 阶段门 / 验证闭环
│   ├── pet/                    # 桌宠五形态 + 独立聊天窗
│   ├── cli/  api/  channels/   # CLI / REST API / IM 渠道
│   └── ipc/                    # 27 个 IPC 通道
├── src/                # 渲染进程（React 19 + Zustand 5 + UnoCSS）
│   ├── panels/                 # 47 个功能面板
│   ├── components/             # 通用 UI 组件
│   ├── stores/                 # Zustand 状态管理
│   └── styles/                 # UnoCSS / 全局样式
├── tests/              # Vitest（305 文件 / 4,575 用例，扁平命名）
├── skills/             # 7 个智能技能（SKILL.md 目录式）
├── python/             # 可选语音/向量服务
└── docs/               # VitePress 文档站
```

---

## 📐 编码规范

### TypeScript

- **风格**: 严格模式（`strict: true`）
- **缩进**: 2 空格
- **引号**: 单引号优先
- **分号**: 必须
- **命名**: `camelCase`（变量/函数）、`PascalCase`（类型/类）、`UPPER_CASE`（常量）
- **文件头部**: 每个文件应有模块说明注释块（参考已有文件风格）

### React

- **函数组件** + Hook，不使用 Class 组件
- **状态管理**: Zustand（全局）/ useState（局部）
- **样式**: UnoCSS（`uno.config.ts`）+ 组件内联样式，不使用 Tailwind

### UI 改动：先出对照稿，再提交

界面微调**不要**直接改 CSS 就提交。同一个「为你推荐」气泡在 2026-10-20 返工了三次
（文字链 → 整宽卡片 → 随文字宽的小胶囊），根因是只凭文字描述猜需求。

建议流程：

1. 用无头浏览器把改动渲染成截图（`msedge --headless --screenshot`，或本地起一个最小 HTML 复用真实 CSS）；
2. 与需求方给的参考图**并排**确认「宽度/边框/排列方向」这三个最容易理解错的部分；
3. 确认后再改组件、跑门禁、提交，并在 PR 描述里贴出改动前后的截图。

文字描述里的「去个框」「太大了」有歧义：可能是条目本身的框，也可能是外层容器的框。
用一张对照图换掉一轮返工，是值得的。

### 提交信息

参考 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 添加朋友圈表情回应功能
fix: 修复记忆检索时的空指针
docs: 更新 README 截图
test: 添加安全审查边界测试
refactor: 提取工具注册逻辑到独立模块
```

---

## 📝 贡献者许可协议（CLA）

**重要：在提交第一个 Pull Request 之前，您需要签署我们的 CLA。**

Lumina Life 采用**双许可证发布**（AGPL-3.0 和 Apache 2.0），这要求每一位贡献者授予项目将贡献用于两种许可证的权利。

### 如何签署

**方式一：自动签署（推荐）**

当您提交第一个 Pull Request 时，[CLA Assistant](https://github.com/contributor-assistant/github-action) 机器人会自动提示您点击按钮签署。

**方式二：在 Commit 信息中签名**

在 PR 的 commit 信息中包含以下行：

```
Signed-off-by: 您的姓名 <您的邮箱@example.com>
```

提交即表示您同意 [CLA.md](CLA.md) 中的条款。

> 💡 只需签署一次，后续所有 PR 自动生效。

---

## 🔄 提交 PR

1. **先开 Issue** — 讨论你要做的事情，避免重复工作
2. **从 main 分支创建 feature 分支**：
   ```bash
   git checkout main
   git pull upstream main
   git checkout -b feat/my-feature
   ```
3. **提交代码** — 遵循编码规范，确保测试通过
4. **写 PR 描述** — 说明改了什么、为什么改、怎么测试的
5. **等待 Review** — 维护者会尽快 Review

### PR Checklist

- [ ] 代码遵循项目编码规范
- [ ] 新增功能有对应的测试
- [ ] 所有测试通过（`npm test`）
- [ ] 文档已更新（如需要）
- [ ] 添加了 CHANGELOG 条目
- [ ] 本 PR 的贡献已按 [CLA.md](CLA.md) 授权

---

## 🚦 维护者推送安全（Maintainer Push Safety）

> 这一节只对仓库 owner / 有推送权限的维护者有效。外部贡献者走 Fork + PR，不受影响。

**只允许显式推送主分支：**

```bash
git push origin master
```

**严禁：**

- `git push --all` —— 会把本地所有分支（含历史快照/备份分支）一次性推上去。
- `git push --mirror` —— 会用本地 refs 覆盖远端，最危险。
- 推送任何本地备份/快照分支：`tmp-backup`、`*-backup`、`legacy-init-snapshot`、
  以及任何名字像 `archive/*`、`init-*`、`*-snapshot` 的本地分支。这些分支里可能含
  早期的内部人格/提示词文档（非 API key，但不公开），仅供本地回滚参考。

**推送前自检：**

```bash
git branch --list            # 看清楚本地有哪些分支
git push origin master       # 只推 master，推完到 GitHub 核对远端分支列表
```

如果不小心推了备份分支：到 GitHub 仓库 → Branches 删掉该远端分支，并视为该分支内容
已公开（内部提示词等敏感设计应按整改记录走 filter-repo 清理历史，而非仅删分支）。

---

## 🧪 测试指南

```bash
npm test              # 运行所有测试
npm run test:watch    # 监听模式（开发时使用）
npx vitest run        # 单次运行（CI 使用）
```

### 测试范围

- **单元测试**: 核心逻辑（Agent Runner、记忆系统、安全审查）
- **集成测试**: 跨模块协作（委托系统、社交引擎）
- **E2E 测试**: 长对话、记忆持续性

### 写测试

- 测试文件放在 `tests/` 目录，命名为 `*.test.ts`
- 使用 `vitest` + `describe/it/expect`
- 需要 mock Electron 时，在文件顶部调用 `vi.mock('electron', ...)`

---

## 💬 提问与讨论

- **Bug 报告 / 功能请求** → [GitHub Issues](https://github.com/chaxu814/lumina-life/issues)
- **技术讨论 / 使用帮助** → [GitHub Discussions](https://github.com/chaxu814/lumina-life/discussions)
- **安全漏洞** → 请私信报告，不要公开提交 Issue

---

## 🙏 感谢贡献

每一个 PR、Issue、文档改进都在让 Lumina 变得更好。无论贡献大小，我们都感谢你！ 🐱

---

**Lumina Life** — 采用双许可证发布：[AGPL-3.0](LICENSE) 或 [Apache 2.0](LICENSE-APACHE)，用户可任选其一。详见 [CLA.md](CLA.md)。
