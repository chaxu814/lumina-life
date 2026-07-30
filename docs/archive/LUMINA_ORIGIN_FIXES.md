# Lumina “不会”的真因与可修复点（基于源码）

## 1. 已确认的两大真伪问题

### 真问题：Team Agent 能力被包装，但实际调用没打透
- `delegationManager.ts` 只负责“把任务文本发给另一个 AgentRunner”。
- 它**不**把“你应该使用哪个 skill、按什么步骤执行”塞给 Yak / 热茶。
- 且 `SOUL_YAK.md / SOUL_RECHA.md` 主要是人格，不是“工具执行手册”。

结果：模型多数时候只摸到人格，摸不到工作流，就越界回“不会”。

### 伪问题：技能目录（skills/*）不直接控制 Team Agent
- 这些 `SKILL.md` 像是操作手册。
- 但 Team Agent 在运行时的 system prompt 来自 `systemPrompt.ts + SOUL_*.md`。
- 也就是说 `web_search_multi` 写得再完整，Yak 的头脑里没有这份手册，等于存在于硬盘，不存在于大脑。

## 2. 本次可做的稳定修复（不动主线程、不删核心接口）

### A. 在 soul 和 system prompt 中“内化技能工作流”
把 `skills/web_search_multi/SKILL.md`、`skills/file_search_smart/SKILL.md` 等核心工作流，拆成“可执行步骤”贴在 Yak / 热茶 prompt 里：
- 明确规定“先列出文件/搜索、再读取、再验证”
- 明确失败时输出可行动信息（步骤在什么阶段卡点），禁止空泛“我无法”

### B. 提示词加“禁止免责 + 失败分级输出”
- 不允许说“作为 AI，我无法...”
- 失败必须包含：已做了什么 / 卡在什么位置 / 建议下一步

### C. 委托时补上下文注入
在 `delegationManager.delegate()` 前，把“当前相关的文件路径/已有上下文/历史错误”打包进 context（不扩展太多 token，只给关键句子）。

### D. 不扩 API 暴露面的前提下，加强错误信息穿透
优先通过 prompt 让模型把错误暴露到 content；二阶段失败信息通过 `DelegationResult` 增强，只用来让人话转述，不泄露密钥。

## 3. 不会动你的东西
- 不新增外部 API 暴露
- 不删除已有 `skills/*`
- 不拆重构核心 engine
- 只改文本型 prompt 和几处逻辑包装
