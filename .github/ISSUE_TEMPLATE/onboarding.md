---
name: 第一次使用 / 环境问题
about: 装不上、跑不起来、不知道怎么配置模型 —— 绝大多数首次问题都归这里
title: "[入门] "
labels: ["onboarding", "good first issue"]
assignees: []
---

<!--
 提问前建议先做（能省掉一大半来回）：
  1. 看 README 的「Quick Start」
  2. 在项目里跑 `lumina doctor`（或 `npm run doctor`），它会打印环境体检结果
-->

## 环境

- **操作系统**（Windows 10/11 / macOS / Linux）：
- **Node.js 版本**（`node -v`）：
- **Lumina 版本**（下载的安装包版本，或 `git log -1 --oneline`）：
- **模型来源**：LM Studio / Ollama / DeepSeek / OpenAI / 其他：

## 遇到了什么问题

（贴出完整报错，包括堆栈）

## 你已经试过什么

（装了哪些依赖、改了哪些配置）

## `lumina doctor` 的输出

```
（把 doctor 的输出贴上来，能直接看出环境问题）
```

---

**给维护者**：收到「装不上」类 issue 时，先确认对方是否在 Windows 平台。
目前只有 Windows 经过实机验证，macOS 标注 beta 且零实机验证，Linux 是 roadmap
（Wayland 禁止全局键鼠注入）。其他平台的限制请提前说明，避免对方按错误的预期排查。
