// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// instructionEcho.test.ts — 「队友接话时对着指令说话」
//
// 【锁定的真实故障】（用户截图原话，逐字）
//   热茶：「……你说要「根据本轮对话」来回复，但这一轮里好像没有给我
//          提供具体的对话内容或搜索结果啊？是漏传了材料吗？」
//   Yak ：「……这一轮确实没有实际调用任何工具。因为按照规则，
//          只有在需要写文件、执行命令或搜索信息时才用工具。」
//
// 【根因】
//   群聊接话（火花 / 点名 / 不确定性接力）时，会构造一段
//   `nextContext` 当作 `text:` 传给 agentChat —— 在模型眼里它就是
//   **用户这一轮说的话**。而这段文本原文是第三人称旁白：
//     「热茶 刚说「…」——你听了觉得不对。用你的方式纠正一下…」
//   模型读完会困惑：这既不像提问，也不像陈述，最省力的解释就是
//   「有人在给我下指令」。加上链式接话时 Per-Agent 隔离后的
//   `conversationHistory` 可能几乎为空，没有可总结的内容，
//   模型就开始**评论这条指令本身**、索要"漏传的材料"。
//
// 【两层修法，本文件各锁一层】
//   源头：SPARK_CONTEXT 套「场记外框」（SPARK_NOTE_PREFIX/SUFFIX），
//         明确「这不是用户发言」，并禁止提及提示/材料/工具。
//   兜底：isInstructionEcho() 事后识别，宁可丢弃也不上屏。
//
// 【为什么必须单测】
//   这类故障不报错、不崩溃，只在「上下文很薄 + 小模型」时偶发；
//   而过度过滤又会误杀正常回答 —— 两个方向都得钉住。
// ============================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { isInstructionEcho, pickRecoverySummaryText } from '../electron/agent/recoveryText'
import {
  calculateSpark,
  calculateChainSpark,
  SPARK_NOTE_PREFIX,
  SPARK_NOTE_SUFFIX,
} from '../src/services/conversationDynamics'

// ─────────────────────────────────────────────
// 1. 用户截图原话：必须判为「复述指令」
// ─────────────────────────────────────────────
describe('isInstructionEcho — 截图里的两句原话', () => {
  it('热茶那句「你说要…来回复 / 是漏传了材料吗」', () => {
    expect(isInstructionEcho(
      '……你说要「根据本轮对话」来回复，但这一轮里好像没有给我提供具体的对话内容或搜索结果啊？是漏传了材料吗？我只是想确认一下……如果只是想让我随便说点什么，也可以直接告诉我哈～',
    )).toBe(true)
  })

  it('Yak 那句「这一轮确实没有实际调用任何工具 / 按照规则」', () => {
    expect(isInstructionEcho(
      '……这一轮确实没有实际调用任何工具。因为按照规则，只有在需要写文件、执行命令或搜索信息时才用工具。如果这轮不需要，我也可以直接凭已有信息回答～',
    )).toBe(true)
  })
})

// ─────────────────────────────────────────────
// 2. 强特征逐条覆盖（每条单独就能判定）
// ─────────────────────────────────────────────
describe('isInstructionEcho — 强特征单条命中', () => {
  const cases: Array<[string, string]> = [
    ['直接引述指令', '你说要按对话总结来回复，可是我没看到内容。'],
    ['引述指令原文', '根据本轮对话，我只能回答这些。'],
    ['抱怨漏传材料', '是漏传了材料吗？'],
    ['抱怨没给内容', '没有给我提供具体的对话内容。'],
    ['描述轮次机制', '本轮没有可用的工具。'],
    ['描述轮次机制（变体）', '这一轮没调用任何工具。'],
    ['引述工具规则', '按照规则，只有在需要时才用工具。'],
    ['指代指令本身', '这条系统指令要求我直接回答。'],
    ['指代提示词', '这个提示词让我先说结论。'],
    ['抄了场记外框', '【群聊场记 · 系统私下给你的提示，不是用户发言】好，那我接一句。'],
  ]
  for (const [name, text] of cases) {
    it(name, () => { expect(isInstructionEcho(text)).toBe(true) })
  }
})

// ─────────────────────────────────────────────
// 3. 反向：正常回答不能被误杀（过度过滤比漏过滤更伤）
// ─────────────────────────────────────────────
describe('isInstructionEcho — 正常回答必须放行', () => {
  const cases: Array<[string, string]> = [
    ['普通陈述', 'A股今天小幅上涨，成交量比昨天放大。'],
    ['主动示弱并转交', '这个我不太确定，你可以问问 Yak。'],
    ['朋友式反驳', '诶其实不是那样的，那个数据是去年的。'],
    ['关心', '你还好吗？听起来今天挺累的。'],
    ['正常解释自己没调工具', '我刚才没调用工具，因为这个问题我可以直接回答。'],
    ['带「本轮」但不谈机制', '这轮的行情我看了，属于震荡。'],
    ['长回答（即便有弱特征也不该砍）', '工具这块我可以帮你梳理一下。'.repeat(30)],
  ]
  for (const [name, text] of cases) {
    it(name, () => { expect(isInstructionEcho(text)).toBe(false) })
  }

  it('空串 / 纯空白 → false', () => {
    expect(isInstructionEcho('')).toBe(false)
    expect(isInstructionEcho('   \n ')).toBe(false)
  })
})

// ─────────────────────────────────────────────
// 4. 与总结轮取舍接线
// ─────────────────────────────────────────────
describe('pickRecoverySummaryText — 复述指令不再当回复', () => {
  it('复述指令 → 空串（交给下一级兜底）', () => {
    expect(pickRecoverySummaryText({
      text: '这一轮确实没有实际调用任何工具。因为按照规则，只有在需要时才用工具。',
    })).toBe('')
  })

  it('正常总结文本仍然采用', () => {
    expect(pickRecoverySummaryText({ text: ' A股今天小幅上涨。 ' })).toBe('A股今天小幅上涨。')
  })
})

// ─────────────────────────────────────────────
// 5. 源头修复：场记外框
// ─────────────────────────────────────────────
describe('火花上下文带「场记外框」', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('外框必须写明「不是用户发言」且禁止提及提示/材料/工具', () => {
    expect(SPARK_NOTE_PREFIX).toMatch(/不是用户发言/)
    expect(SPARK_NOTE_PREFIX).toMatch(/不要在回复里提到/)
    expect(SPARK_NOTE_SUFFIX).toMatch(/提示/)
    expect(SPARK_NOTE_SUFFIX).toMatch(/指令/)
    expect(SPARK_NOTE_SUFFIX).toMatch(/工具/)
    expect(SPARK_NOTE_SUFFIX).toMatch(/材料/)
    // 没有可接话头时的出口，避免模型转而去索要材料
    expect(SPARK_NOTE_SUFFIX).toMatch(/自然短句带过/)
  })

  it('calculateSpark 产出的 contextForLLM 首尾都有外框', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0) // 0 < probability → 必触发；类型取权重第一项
    const spark = calculateSpark({
      firstAgentId: 'recha',
      firstReply: '这个数据我查过了，没问题。',
      userText: '帮我看看',
      recentTurnCount: 0,
      agentCount: 3,
    })
    expect(spark).not.toBeNull()
    expect(spark!.contextForLLM.startsWith(SPARK_NOTE_PREFIX)).toBe(true)
    expect(spark!.contextForLLM.endsWith(SPARK_NOTE_SUFFIX)).toBe(true)
    // 原始旁白内容仍在（不能为了加框把话头弄丢）
    expect(spark!.contextForLLM).toContain('这个数据我查过了')
  })

  it('calculateChainSpark 产出的 contextForLLM 首尾都有外框', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const spark = calculateChainSpark({
      lastSpeakerId: 'lumina',
      lastReply: '喵～我觉得还行吧。',
      alreadySpokenIds: ['recha', 'lumina'],
    })
    expect(spark).not.toBeNull()
    expect(spark!.contextForLLM.startsWith(SPARK_NOTE_PREFIX)).toBe(true)
    expect(spark!.contextForLLM.endsWith(SPARK_NOTE_SUFFIX)).toBe(true)
  })
})

// ─────────────────────────────────────────────
// 6. 接线：三处 nextContext 都必须套外框，agentRunner 必须有事后兜底
// ─────────────────────────────────────────────
describe('接线检查', () => {
  const gc = fs.readFileSync(
    path.join(process.cwd(), 'src', 'panels', 'GroupChatView.tsx'),
    'utf-8',
  )
  const runner = fs.readFileSync(
    path.join(process.cwd(), 'electron', 'agentRunner.ts'),
    'utf-8',
  )

  it('GroupChatView 里三条接话路径都用 SPARK_NOTE_PREFIX 包裹', () => {
    // 火花（含链式）走 contextForLLM，另两条（点名 / 不确定性）在本地拼
    expect(gc).toMatch(/nextContext = SPARK_NOTE_PREFIX/)
    // 点名路径
    expect(gc).toMatch(/点了你，TA 说的是/)
    // 不确定性接力路径
    expect(gc).toMatch(/你接着往下说/)
    // 防回退：不能再出现裸拼的「@了你」
    expect(gc).not.toMatch(/nextContext = `\$\{responder\.name\} @了你/)
  })

  it('agentRunner 在清洗链之后还有一道 isInstructionEcho 兜底', () => {
    expect(runner).toMatch(/import \{[^}]*isInstructionEcho[^}]*\} from '\.\/agent\/recoveryText'/)
    expect(runner).toMatch(/if \(finalText && isInstructionEcho\(finalText\)\)/)
    // 必须真的把它清空，而不是只打日志
    expect(runner).toMatch(/finalText = ''[\s\S]{0,80}丢弃「复述指令」|丢弃「复述指令」[\s\S]{0,160}finalText = ''/)
  })

  it('总结轮提示词禁止模型提及内部机制', () => {
    expect(runner).toMatch(/严禁提到「本轮对话」「系统指令」「工具」「材料」「漏传」「上下文」/)
    expect(runner).toMatch(/本条是系统给你的内部指令，不是用户说的话/)
  })
})
