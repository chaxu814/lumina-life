# 🔧 Lumina 修复报告 - 2026-06-11

## 📋 修复的两个核心问题

### 问题 1：群聊中出现"已执行1次工具操作，但由于模型响应超时未能整理成自然语言回复"

**根因分析：**
1. **主回复缺少 `socialMode: true`** - GroupChatView.tsx 中主回复没有设置无限超时，而链式火花回复有设置
2. **L2 恢复使用主循环超时** - 当主循环超时后，L2 总结恢复调用 `callLLM([])` 也使用相同的超时，注定失败
3. **L3 兜底消息不友好** - 直接显示"模型响应超时"，没有提供有用的建议

**修复方案：**
1. ✅ GroupChatView.tsx: 主回复添加 `socialMode: true`，与链式火花保持一致
2. ✅ agentRunner.ts: `callLLM()` 支持 `timeoutOverride` 参数
3. ✅ agentRunner.ts: L2 恢复使用独立的 120 秒短超时，不受主循环超时影响
4. ✅ agentRunner.ts: 改进 L3 兜底消息，提供更友好的建议

### 问题 2：普通模式中出现"刚才的回答没问题~还有什么想问的吗？"

**根因分析：**
1. **模型生成的填充性废话** - 模型在回答结尾添加"还有什么想问的吗？"等废话
2. **系统提示词缺少禁止指令** - 所有 Agent 的提示词都没有明确禁止这种模式
3. **缺少后处理过滤器** - 没有自动剥离模型输出中的填充文本
4. **自定义提示词未生效** - `initSystemPrompt()` 忽略了 `config.systemPrompt`

**修复方案：**
1. ✅ 所有提示词添加禁止模式：
   - SOUL_LUMINA.md
   - SOUL_RECHA.md
   - SOUL_YAK.md
   - systemPrompt.ts (BASE_SYSTEM_PROMPT, buildYakPrompt, buildRechaPrompt)
   - agentSouls.ts (buildAgentPromptLite)
2. ✅ agentRunner.ts: 添加 `stripFillerText()` 后处理过滤器，自动剥离 20+ 种填充模式
3. ✅ agentRunner.ts: 修复 `initSystemPrompt()` 使其尊重 `config.systemPrompt`

---

## 📝 详细改动清单

### 1. GroupChatView.tsx (1 处)
```typescript
// 位置：主回复的 agentChat 调用
// 改动：添加 socialMode: true
config: {
  // ... 其他配置
  socialMode: true,  // 🔧 v6.3: 群聊主回复也需要无限超时
}
```

### 2. agentRunner.ts (6 处)

#### 2.1 callLLM() 方法签名
```typescript
// 改动：添加 options 参数
private async callLLM(
  tools: any[], 
  options?: { timeoutOverride?: number }
): Promise<...>
```

#### 2.2 超时计算逻辑
```typescript
// 改动：支持外部覆盖超时
const effectiveTimeout = options?.timeoutOverride || slowTimeout || httpTimeoutSeconds
```

#### 2.3 L2 恢复调用
```typescript
// 改动：使用独立的 120 秒超时
const summaryResp = await this.callLLM([], { timeoutOverride: 120 })
```

#### 2.4 L3 兜底消息
```typescript
// 改动：更友好的错误消息
finalText = `抱歉，我执行了 ${toolMsgs.length} 次工具操作，但模型响应时间较长...`
```

#### 2.5 后处理过滤器
```typescript
// 新增：stripFillerText() 静态方法
private static FILLER_PATTERNS: RegExp[] = [
  /[。！!~～]*\s*(还有什么想问的吗[？?]?)\s*$/,
  /[。！!~～]*\s*(还有什么需要帮忙的吗[？?]?)\s*$/,
  // ... 20+ 种模式
]

private static stripFillerText(text: string): string {
  // 自动剥离填充性废话
}

// 在 sendMessage() 返回前调用
finalText = AgentRunner.stripFillerText(finalText)
```

#### 2.6 initSystemPrompt() 方法
```typescript
// 改动：追加自定义提示词
if (this.config.systemPrompt) {
  prompt += '\n\n## 自定义指令\n' + this.config.systemPrompt
}
```

### 3. 提示词文件 (5 处)

#### 3.1 SOUL_LUMINA.md
```markdown
## 🚫 绝对禁止的回复模式
- 不要在回答结尾加填充性反问，如「还有什么想问的吗？」
- 不要用「刚才的回答没问题」「希望这能解决你的问题」这类自我确认式废话
- 回答完就停。用户有问题会自己问。
```

#### 3.2 SOUL_RECHA.md
```markdown
## 🚫 禁止的回复模式
- 不要在回答结尾加填充性反问
- 不要用自我确认式废话
- 回答完就停，不要画蛇添足。
```

#### 3.3 SOUL_YAK.md
```markdown
## 🚫 禁止的回复模式
- 不要在回答结尾加填充性反问
- 不要用自我确认式废话
- 回答完就停，不要画蛇添足。
```

#### 3.4 systemPrompt.ts - BASE_SYSTEM_PROMPT
```typescript
## 🚫 禁止的回复模式
- **不要在回答结尾加填充性反问**
- **不要用自我确认式废话**
- 回答完就停。用户有问题会自己问。
```

#### 3.5 systemPrompt.ts - buildYakPrompt() & buildRechaPrompt()
```typescript
## 禁止的回复模式
- 不要在回答结尾加填充性反问
- 不要用自我确认式废话
- 回答完就停，不要画蛇添足。
```

### 4. agentSouls.ts (1 处)

#### 4.1 buildAgentPromptLite()
```typescript
parts.push(
  '',
  '🚫 绝对禁止：',
  '- 不要在回答结尾加填充性反问',
  '- 不要用自我确认式废话',
  '- 回答完就停，不要画蛇添足。',
)
```

---

## 🎯 借鉴 QwenPaw 的设计

### QwenPaw 的做法
1. **超时后自动总结** - 达到最大迭代次数时，强制模型生成文本回复
2. **不带工具** - 总结时不传递工具定义，强制模型只做文本生成
3. **清晰的提示词** - "respond directly by summarizing the current situation"

### Lumina 的改进
1. **分阶段恢复策略** - L1 聚合 → L2 短超时总结 → L3 兜底消息
2. **独立超时控制** - L2 使用 120 秒短超时，不受主循环超时影响
3. **后处理过滤** - 自动剥离模型生成的填充性废话
4. **更友好的错误消息** - 提供具体的建议而不是简单报错

---

## ✅ 验证清单

### 问题 1 验证
- [ ] 群聊主回复不再出现"已执行1次工具操作，但由于模型响应超时"
- [ ] 工具执行成功后，L2 总结能在 120 秒内完成
- [ ] 即使 L2 失败，L3 兜底消息也更友好

### 问题 2 验证
- [ ] Lumina 不再出现"刚才的回答没问题~还有什么想问的吗？"
- [ ] Yak 和 Recha 不再出现填充性废话
- [ ] 群聊中的 Agent 不再出现填充性废话
- [ ] 自定义 persona 提示词能正常生效

---

## 📊 影响范围

### 修改的文件 (8 个)
1. `src/panels/GroupChatView.tsx` - 1 处改动
2. `electron/agentRunner.ts` - 6 处改动
3. `electron/prompts/systemPrompt.ts` - 3 处改动
4. `src/data/agentSouls.ts` - 1 处改动
5. `SOUL_LUMINA.md` - 1 处改动
6. `SOUL_RECHA.md` - 1 处改动
7. `SOUL_YAK.md` - 1 处改动

### 影响的功能模块
- ✅ 普通聊天模式（所有 4 种模式）
- ✅ 团队群聊（主回复 + 链式火花）
- ✅ Agent 委托（Yak + Recha）
- ✅ 自定义 Persona

---

## 🚀 下一步建议

### 短期
1. 重新构建项目：`npm run build`
2. 重启应用测试两个问题
3. 观察日志确认修复效果

### 长期
1. 考虑添加更多的填充模式到 `FILLER_PATTERNS`
2. 监控 L2 恢复的成功率，如果失败率高可以考虑增加超时时间
3. 考虑添加用户反馈机制，让用户标记"废话回复"以便持续改进

---

## 📌 技术细节

### 超时配置对比

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| 群聊主回复 | 300s (默认) | 无限 (socialMode: true) |
| 链式火花 | 无限 (socialMode: true) | 无限 (保持不变) |
| L2 总结恢复 | 300s (继承主循环) | 120s (独立短超时) |
| 普通模式 | 300s (默认) | 300s (保持不变) |

### 填充模式覆盖

支持的填充模式类型：
- 中文反问：`还有什么想问的吗？`、`还有什么需要帮忙的吗？` 等
- 英文反问：`Is there anything else?`、`Let me know if you need anything else` 等
- 自我确认：`刚才的回答没问题`、`希望这能解决你的问题` 等
- 通用结尾：`Hope this helps!` 等

总计覆盖 **20+ 种** 常见的填充模式。

---

---

## 🔧 v6.4 补充修复 — L3 恢复输出的错误文本污染

### 问题 3：L3 恢复将错误提示与正常生成文本混合输出

**根因分析：**
1. **流式超时丢弃部分内容** — `callLLM` 流式超时时，`streamText` 已有模型生成的内容，但代码丢弃它转而走非流式回退。非流式也可能超时，导致好内容丢失
2. **错误消息注入技术细节** — `callLLM` 非流式回退的错误消息包含 `LUMINA_LLM_TIMEOUT=600/900`、`GPU Offload`、API 地址等内部细节
3. **L2 总结提示污染** — L2 提示包含 `已执行了 X 次工具调用，但未能生成最终回复`，LLM 会复述这个错误描述
4. **恢复提示引导 LLM 提及超时** — 慢速思考恢复提示包含 `之前的请求因超时被中断了 3 次`，引导 LLM 在回复中复述"超时"
5. **ReAct 循环多处 set finalText 为冗长错误** — 连接断开、非超时错误、异常捕获等分支都设置包含技术排查步骤的 `finalText`

### v6.4 修复清单 (11 处)

| # | 文件 | 位置 | 改动 |
|---|------|------|------|
| 1 | agentRunner.ts | `callLLM` 流式超时处理 | 若 `streamText` 已有 >20 字有效内容 → 直接返回，不再降级非流式 |
| 2 | agentRunner.ts | 非流式回退错误消息 | `LUMINA_LLM_TIMEOUT=600...` → `模型响应超时，请稍后重试或简化问题` |
| 3 | agentRunner.ts | 连接断开错误 | 去掉 model 名称暴露 |
| 4 | agentRunner.ts | ReAct 连接断开 finalText | 去掉 baseUrl 暴露和编号排查步骤 |
| 5 | agentRunner.ts | ReAct 非超时错误 finalText | 去掉排查建议和 model 名称 |
| 6 | agentRunner.ts | 异常捕获 finalText | 去掉 `err.message` 原始错误暴露 |
| 7 | agentRunner.ts | 慢速思考「总结」提示 | 去掉"之前的请求因超时被中断了 3 次" |
| 8 | agentRunner.ts | 慢速思考「继续」提示 | 去掉"上一个请求因超时被中断" |
| 9 | agentRunner.ts | L2 总结提示 | "对话轮次已用尽...未能生成最终回复" → 中性提示 |
| 10 | agentRunner.ts | L3 兜底消息 | 去掉编号排查建议 |
| 11 | GroupChatView.tsx | `isTimeoutRecovery` 正则 | 更新匹配模式以适配简化后的错误消息 |

**修复完成时间：** 2026-06-11  
**修复者：** AI Agent  
**版本号：** v6.3 → v6.4

---

## 🔧 v6.4.1 追加修复 (2026-06-11 晚)

### 问题 3：社交引擎初始化崩溃 — `TypeError: Cannot read properties of undefined (reading 'split')`

**根因：** `TeamProactiveSystem.scheduleRitual()` 被调用时 `timeStr` 参数为 `undefined`（`TeamConfig` 接口没有 `morningRitualTime`/`eveningRitualTime` 字段）。

**修复：** `teamProactiveSystem.ts` → `scheduleRitual()` 开头添加空值防御。

### 问题 4：IPC handler 重复注册导致社交引擎初始化失败

**根因：** `initTeamSocialEngineWithConfig()` 每次调用都注册 3 个 IPC handler（`agent:get-available-providers`、`agent:use-global-config`、`agent:force-auto-detect`）。初始化失败后重试触发 `Attempted to register a second handler` 错误。

**修复：** `agentIpc.ts` → 提取 `registerAgentIpcHandlers()` 函数，使用 `agentIpcHandlersRegistered` 标志确保只注册一次。

### 问题 5：团队 Agent 搜索不工作

**根因：** `preExecuteSearch()` 调用 `webSearch()` 时参数格式错误 — 传入三个独立参数 `(query, 'bing', searchCount)` 而不是对象 `{ query, engine: 'bing', count: searchCount }`。

**修复：** `agentRunner.ts` → `preExecuteSearch()` 中 `webSearch` 调用改为传入对象参数。

### 问题 6：团队 Agent 回答重复近义内容

**根因：** 提示词中缺少反重复规则，LLM 倾向于用换句式/同义词复述之前说过的话。

**修复：**
- `SOUL_LUMINA.md` / `SOUL_RECHA.md` / `SOUL_YAK.md` → 禁止规则部分新增反重复指令
- `systemPrompt.ts` → `BASE_SYSTEM_PROMPT` 禁止规则部分新增反重复指令

### v6.4.1 修复清单 (7 处)

| # | 文件 | 改动 |
|---|------|------|
| 1 | teamProactiveSystem.ts | `scheduleRitual()` 添加 `undefined` 防御 |
| 2 | agentIpc.ts | 提取 `registerAgentIpcHandlers()` + `agentIpcHandlersRegistered` 守卫 |
| 3 | agentRunner.ts | `preExecuteSearch()` 中 `webSearch` 调用改为对象参数 |
| 4 | SOUL_LUMINA.md | 禁止规则新增反重复指令 |
| 5 | SOUL_RECHA.md | 禁止规则新增反重复指令 |
| 6 | SOUL_YAK.md | 禁止规则新增反重复指令 |
| 7 | systemPrompt.ts | `BASE_SYSTEM_PROMPT` 禁止规则新增反重复指令 |

**修复完成时间：** 2026-06-11  
**版本号：** v6.4 → v6.4.1

---

## 🔧 v6.5 大改：Agent 回答质量严重下降（"牛头不对马嘴"）

### 问题根因

对比 QwenPaw 的实现，发现 Lumina 有三个致命问题：

**问题 1：对话历史截断太狠**
- `GroupChatView.tsx`: 每条消息只保留 **200 字**，最后 10 条
- `agentRunner.ts`: `setHistory()` 只保留 4 对消息，每条 1000 字
- QwenPaw 不截断历史（依赖 compaction），Lumina 截断过狠导致 agent 丢失上下文

**问题 2：用户消息被奇怪地嵌套**
```typescript
// 之前：用户问题被包在元信息里
text: `[${responder.name}，用户在 Lumina 团队群聊中对你说话。你是 ${responder.name}，不是 AI 助手。记住你的身份。]\n\n${fullText}`
```
这种格式让 LLM 困惑 — 用户问的问题被包在一堆指令里。

**问题 3：提示词过度工程化，规则互相矛盾**
- "30-150字" + "复杂话题展开说" = LLM 不知道该怎么回
- "回答完就停" + "不要画蛇添足" + "追问时正常补充" = 自相矛盾
- 5 条禁止规则 vs 3 条正面规则 = LLM 被"不要做什么"淹没

### 修复方案

**1. 放宽历史截断**
| 位置 | 改前 | 改后 |
|------|------|------|
| `GroupChatView.tsx` 主回复 | 200字/10条 | 800字/20条 |
| `GroupChatView.tsx` 链式火花 | 150字/8条 | 800字/20条 |
| `agentRunner.ts` setHistory | 1000字/4对 | 2000字/8对 |

**2. 简化用户消息格式**
```typescript
// 改后：直接传用户问题，system prompt 已经说明了身份
text: fullText
```

**3. 大幅简化提示词** — 借鉴 QwenPaw 风格

| 文件 | 改前 | 改后 |
|------|------|------|
| `agentSouls.ts` | 12 条规则（字数限制+禁止规则+接话要点...） | 3 条核心原则 |
| `systemPrompt.ts` | 4 条禁止规则 + 互相矛盾的指示 | 2 条正面原则 |
| `SOUL_LUMINA.md` | 4 条禁止规则 | 2 条原则 |
| `SOUL_RECHA.md` | 4 条禁止规则 | 2 条原则 |
| `SOUL_YAK.md` | 4 条禁止规则 | 2 条原则 |

### v6.5 修复清单 (10 处)

| # | 文件 | 改动 |
|---|------|------|
| 1 | GroupChatView.tsx | 主回复历史：200字/10条 → 800字/20条 |
| 2 | GroupChatView.tsx | 主回复消息格式：去掉嵌套元信息 |
| 3 | GroupChatView.tsx | 链式火花历史：150字/8条 → 800字/20条 |
| 4 | GroupChatView.tsx | 链式火花消息格式：去掉嵌套元信息 |
| 5 | agentRunner.ts | setHistory：1000字/4对 → 2000字/8对 |
| 6 | agentSouls.ts | buildAgentPromptLite：大幅简化，12条→3条 |
| 7 | systemPrompt.ts | BASE_SYSTEM_PROMPT：简化禁止规则 |
| 8 | SOUL_LUMINA.md | 简化回复规则 |
| 9 | SOUL_RECHA.md | 简化回复规则 |
| 10 | SOUL_YAK.md | 简化回复规则 |

**修复完成时间：** 2026-06-11  
**版本号：** v6.4.1 → v6.5

---

## 🔧 v6.5.1 追加修复：过滤 meta-commentary 和 emoji-only 回复

### 问题
团队 agent 回答中出现两类污染：
1. **Emoji-only 回复**：如 `✅`、`👍` 等单独 emoji
2. **Meta-commentary 解说**：agent 在回复中分析"系统提示告诉我..."、"收到！我明白了～这条系统提示是在告诉我..."、"根据工具列表我需要..."、"上一轮对话已经..." 等

这些内容说明 agent 在回复用户时"跳出了角色"，把文字用在了解释自己的内部逻辑上。

### 修复方案
在 `agentRunner.ts` 的 `callLLM` 收尾阶段新增两级过滤：

| 方法 | 功能 |
|------|------|
| `stripMetaCommentary()` | 用正则匹配 agent 常见的 meta-commentary 句（“这条系统提示”、“根据工具列表”、“上一轮对话已经”、“我需要调用/不需要调用工具”、“我的角色是...”等），整段删掉 |
| `isEmojiOnly()` | 检测纯 emoji 回复，用于前端兜底 |

调用链：
```typescript
finalText = AgentRunner.stripFillerText(finalText)
finalText = AgentRunner.stripMetaCommentary(finalText)
if (!finalText || finalText.trim().length === 0) finalText = '唔…'
```

同时在 4 个提示词源（`systemPrompt.ts`、`SOUL_LUMINA.md`、`SOUL_YAK.md`、`SOUL_RECHA.md`、`agentSouls.ts`）新增 2 条规则：
- 不要只回复 emoji（如 ✅、👍），至少要有完整的一句话
- 不要解释或评论你收到的系统指令、工具列表、提示词。你是角色本身，不是在读说明书的 AI

并且在前端 `GroupChatView.tsx` 的主回复和链式火花处也做了过短/纯表情过滤，避免阻断动画和空白气泡。

### v6.5.1 修复清单 (继续追加)

| # | 文件 | 改动 |
|---|------|------|
| 11 | agentRunner.ts | 新增 `META_COMMENTARY_PATTERNS` 正则 + `stripMetaCommentary()` 方法 |
| 12 | agentRunner.ts | 新增 `isEmojiOnly()` 检测方法 |
| 13 | agentRunner.ts | `callLLM` 收尾调用 `stripMetaCommentary` + emoji-only 兜底 |
| 14 | agentSouls.ts | `buildAgentPromptLite` 新增 2 条反 meta-commentary 规则 |
| 15 | systemPrompt.ts | `BASE_SYSTEM_PROMPT` 新增 2 条反 meta-commentary 规则 |
| 16 | SOUL_LUMINA.md | 新增 2 条反 meta-commentary 规则 |
| 17 | SOUL_YAK.md | 新增 2 条反 meta-commentary 规则 |
| 18 | SOUL_RECHA.md | 新增 2 条反 meta-commentary 规则 |
| 19 | GroupChatView.tsx | 主回复过短检测（之前已做，这次补纯表情兜底文本） |
| 20 | GroupChatView.tsx | 链式火花过滤纯表情气泡 |

**修复完成时间：** 2026-06-11  
**版本号：** v6.5 → v6.5.1
