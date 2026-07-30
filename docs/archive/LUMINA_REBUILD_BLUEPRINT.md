# Lumina 群聊 Agent 重建 · 第一批执行蓝图

> 对应 B 方案第 3+4 步。**目标：群聊 agent 效果对齐 QwenPaw + 保留现有三 agent 协作。**
> 本批只动"根因点"，**不动协作架构**。本文档为主管/老板可读版，代码片段在附录供技术团队落地。

---

## 一、这一批要解决什么（大白话）

群聊里那两个后台干活的（写代码、做审查），**脑子是空的**——被叫去干活时，只接到一句"你是写代码的"，没带任何工作手册。所以要么说"我不会"，要么瞎答。

QwenPaw 的做法是：每个干活的员工**天生带着自己的手册**。这一批就把这件事补上，同时**不动**现有的"总管派活"协作方式。

---

## 二、改哪里、保哪里（战略清单）

**保（协作性，一律不动）：**
- Lumina 总管调度、委派路由
- 三条铁则（用户只跟 Lumina、后台不直接对用户、后台不互说）
- AGENTS.md 底座、1v1 对话、社交引擎

**改（根因点，3 处）：**
1. 后台 agent 的"群聊发言模板"——从三句话空模板，升级为"完整工作指引 + 常驻技能手册"
2. 技能库——给每个技能标上"归谁用"（写代码用 / 审查用），让各自只带自己的
3. 委派时的补充说明——加"禁止说不会、失败要分级说"的规矩

---

## 三、具体三处改动（概述）

1. **群聊发言模板（核心修复）**：后台 agent 在群聊里被叫到时，prompt 包含：
   - 它的完整工作指引（怎么干活、禁止什么）
   - 它该用的技能手册（**常驻**，不用等总管临时塞）
   - 协作铁则（结果只给 Lumina，不乱说话）
2. **技能归属**：技能库每个技能标 owner，写代码的只带代码类手册，审查的只带审查类手册（像 QwenPaw 各 agent 用各的技能）
3. **委派补充**：在原有委派注入基础上，补"禁止免责声明 + 失败分级输出"

---

## 四、怎么算成功（checkpoint）

- 群聊里让"写代码"改个 bug、"审查"查个问题 → 不再回"我不会/无法"，能按手册干活
- Lumina 仍是唯一出口，后台结果照样只汇给 Lumina
- 原有 1v1 对话、社交引擎、朋友圈不受影响

---

## 附录：技术团队专用（精确改造点 + 代码片段）

### 改动 1：`electron/prompts/systemPrompt.ts`

**问题**：`buildYakPrompt` / `buildRechaPrompt` 在 `skipSoul=true`（群聊）时返回三句话空 prompt；非群聊时只注入技能**列表**（名称+触发词），非 workflow 全文。

**做法**：新增 `buildGroupChatAgentPrompt(agentId)`，群聊场景改用它。加载 SOUL 工作指引段 + 常驻该 agent 相关 SKILL 的 workflow 全文 + 协作铁则。

```ts
// 🆕 群聊场景：后台 agent 常驻技能手册（对齐 QwenPaw，根治"空脑子"）
function buildGroupChatAgentPrompt(agentId: 'yak' | 'recha'): string {
  const root = getLuminaRoot()
  const soulFile = agentId === 'yak' ? 'SOUL_YAK.md' : 'SOUL_RECHA.md'
  const soulMd = loadMdFile(root, soulFile)
  // 取工作指引（去纯人格闲聊段，留执行/禁止段）
  const guidance = soulMd
    ? soulMd.replace(/^#.*persona[\s\S]*?(?=## |$)/i, '').trim()
    : (agentId === 'yak' ? '你是 Yak 📊，后台代码工程师。' : '你是热茶 🍵，后台审查员。')

  // 常驻该 agent 的相关 skill workflow（像 QwenPaw 常驻 SKILL.md）
  const { SKILLS } = require('../agentSkills')
  const owned = Object.values(SKILLS || {}).filter((s: any) => (s.owners || []).includes(agentId))
  const skillBlocks = owned.map((s: any) =>
    `### ${s.name}\n${s.description}\n${s.executeConstraints || ''}\n${s.workflow || ''}`)

  return [
    guidance,
    `## 你的技能手册（常驻，随时可用）\n${skillBlocks.join('\n\n') || '（无）'}`,
    `## 协作铁则（不可违反）
- 你是后台成员，结果只给 Lumina，绝不直接对用户说话
- 禁止说"作为 AI 我无法/我不会"；做不到时分级说明：已做了什么 / 卡在哪 / 建议下一步
- 不确定就停下读更多上下文，不乱改`,
  ].join('\n\n')
}
```

并在 `buildSystemPrompt` 中路由群聊场景：
```ts
if (agentId === 'yak') return _options?.skipSoul ? buildGroupChatAgentPrompt('yak') : buildYakPrompt(config, options)
if (agentId === 'recha') return _options?.skipSoul ? buildGroupChatAgentPrompt('recha') : buildRechaPrompt(config, options)
```

### 改动 2：`electron/agentSkills.ts`

给 `SkillDef` 增加 `owners` 字段，并给各技能标注归属：
```ts
export interface SkillDef {
  id: string
  name: string
  description: string
  workflow: string
  executeConstraints?: string
  triggers?: string[]
  owners?: ('yak' | 'recha')[]   // 🆕 技能归属
}
```
- 写代码类（write_code / modify_code / debug / fix_bug / api_design）→ `owners: ['yak']`
- 审查类（code_review / analyze）→ `owners: ['recha']`
- 通用类（web_search / data_analysis / file_ops）→ `owners: ['yak', 'recha']`

### 改动 3：`electron/delegationManager.ts`（`_buildWorkerInput`）

保留现有 `matchSkill` 注入（workflow 全文），仅在"执行铁则"中补一条：
```
⑧ 禁止说"作为 AI 我无法/我不会"；做不到时分级说明：已做/卡哪/建议下一步
```
委派路由、`delegate()` 结构、三条铁则一律不动（保协作性）。

---

## 落地顺序建议

1. 先改 `agentSkills.ts`（加 owners，纯数据结构，零风险）
2. 再改 `systemPrompt.ts`（群聊富 prompt，核心修复）
3. 最后补 `delegationManager.ts` 一条铁则
4. 每改一步，打开群聊让 Yak 改 bug / 热茶审查验证 checkpoint
