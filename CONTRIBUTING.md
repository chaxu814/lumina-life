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
| Node.js | ≥ 18.0.0 | 推荐 v20 LTS 或 v24 |
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

```
lumina-life/
├── electron/           # 主进程 (Node.js)
│   ├── agentRunner.ts          # Agent 执行引擎
│   ├── agentSocialEngine.ts    # 团队社交引擎
│   ├── memory/                 # 记忆系统（SQLite + 向量检索）
│   ├── tools/                  # 88+ 工具注册与执行
│   ├── securityGuard.ts        # 分级安全审查
│   ├── prompts/                # 提示词系统
│   ├── cli/                    # 命令行接口
│   └── ipc/                    # IPC 通信桥
├── src/                # 渲染进程 (React 19)
│   ├── panels/                 # 23 个功能面板
│   ├── components/             # 通用 UI 组件
│   ├── stores/                 # Zustand 状态管理
│   └── styles/                 # 样式文件
├── tests/              # 测试文件
├── skills/             # 技能目录（可安装扩展）
└── knowledge/          # 知识库
```

> 详细架构请阅读 [README.md](README.md)。

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
- **样式**: CSS Modules 或 Tailwind（如果项目已配置）

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

- **Bug 报告 / 功能请求** → [GitHub Issues](https://github.com/lumina-life/lumina-life/issues)
- **技术讨论 / 使用帮助** → [GitHub Discussions](https://github.com/lumina-life/lumina-life/discussions)
- **安全漏洞** → 请私信报告，不要公开提交 Issue

---

## 🙏 感谢贡献

每一个 PR、Issue、文档改进都在让 Lumina 变得更好。无论贡献大小，我们都感谢你！ 🐱

---

**Lumina Life** — 采用双许可证发布：[AGPL-3.0](LICENSE) 或 [Apache 2.0](LICENSE-APACHE)，用户可任选其一。详见 [CLA.md](CLA.md)。
