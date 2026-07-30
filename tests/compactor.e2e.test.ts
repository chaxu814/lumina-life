import { afterEach, describe, expect, it } from 'vitest'
import {
  buildStructuredSummary,
  compactMessages,
  needsCompaction,
} from '../electron/agentCompactor'
import { TokenEstimator } from '../electron/tokenEstimator'
import type { AgentMessage } from '../electron/tools/types'

const estimator = new TokenEstimator()

function makeMsg(opts: {
  role: 'system' | 'user' | 'assistant'
  content?: string
  ts?: number
}): AgentMessage {
  return {
    role: opts.role,
    content: opts.content ?? '',
    ts: opts.ts ?? Date.now(),
  } as AgentMessage
}

describe('agentCompactor', () => {
  afterEach(() => {
    estimator.clearCache?.()
  })

  it('buildStructuredSummary extracts asks / decisions / files / recent answers', () => {
    const msgs: AgentMessage[] = [
      makeMsg({ role: 'system', content: 'BASE' }),
      makeMsg({
        role: 'user',
        content: '请读取 J:\\LuminaLife2.0\\docs\\plan.md 这个文件并给出摘要',
      }),
      makeMsg({ role: 'assistant', content: '已读完，核心结论是：1）... 2）...' }),
      makeMsg({
        role: 'user',
        content: '我决定采用方案A，把系统提示词改掉。',
      }),
      makeMsg({ role: 'assistant', content: '好的，已更新。' }),
      makeMsg({
        role: 'user',
        content: '再检查一下 C:\\Users\\13510\\notes.txt',
      }),
      makeMsg({ role: 'assistant', content: '已处理。' }),
    ]
    const summary = buildStructuredSummary([msgs[0]], msgs.slice(1), null)
    expect(summary).toContain('对话摘要')
    expect(summary).toContain('J:\\LuminaLife2.0\\docs\\plan.md')
    expect(summary).toContain('C:\\Users\\13510\\notes.txt')
    expect(summary).toContain('决定')
  })

  it('needsCompaction triggers by token budget or message count', () => {
    const long = 'model response '.repeat(120)
    const longMsgs: AgentMessage[] = Array.from({ length: 61 }, (_, i) =>
      makeMsg({ role: i % 2 === 0 ? 'user' : 'assistant', content: long }),
    )
    expect(
      needsCompaction(estimator.estimateMessages(longMsgs), longMsgs.length),
    ).toBe(true)

    const shortMsgs: AgentMessage[] = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'hi' }),
    )
    expect(
      needsCompaction(estimator.estimateMessages(shortMsgs), shortMsgs.length),
    ).toBe(false)
  })

  it('compactMessages keeps system + recent pairs and injects summary', () => {
    const system = makeMsg({ role: 'system', content: 'BASE' })
    const mid: AgentMessage[] = Array.from({ length: 65 }, (_, i) =>
      makeMsg({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }),
    )
    const msgs = [system, ...mid]
    const out = compactMessages(msgs, null)
    expect(out).not.toBeNull()
    expect(out!.messages[0].role).toBe('system')
    const summaryMsg = out!.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('对话摘要'),
    )
    expect(summaryMsg).toBeTruthy()
    const recentStart = out!.messages.length - 10
    expect(out!.messages.slice(recentStart).length).toBeGreaterThanOrEqual(1)
  })
})
