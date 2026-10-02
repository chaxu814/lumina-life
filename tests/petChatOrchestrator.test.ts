// tests/petChatOrchestrator.test.ts
//
// 桌宠聊天同步修复的核心单测（src/lib/petChatOrchestrator.ts）：
//   1. agentChat 失败后按指数退避重试（600ms → 1500ms），期间不发错误气泡
//   2. 连续失败耗尽重试后才上屏友好错误
//   3. 空 content / 抛错都视为可重试失败
//   4. 同一 pet 对话 agentChat 严格串行：第二条在第一条完成后才开始，不并发、不丢弃
//   5. selectForwardedMessages 双向同步去重：跳过 system 与桌宠注入的 id
//   6. deriveLocalIntent 关键词派生动作（不发 LLM）
import { describe, it, expect, vi } from 'vitest'
import {
  PetChatOrchestrator,
  messagesToForward,
  deriveLocalIntent,
  PET_RETRY_MAX,
  type PetChatDeps,
} from '../src/lib/petChatOrchestrator'

interface Captures {
  deps: PetChatDeps & { agentChat: ReturnType<typeof vi.fn>; sendToPet: ReturnType<typeof vi.fn>; addMessage: ReturnType<typeof vi.fn>; sleep: ReturnType<typeof vi.fn> }
  sent: Array<{ text: string; role: string }>
}

function makeDeps(): Captures {
  const sent: Captures['sent'] = []
  let idSeq = 0
  const deps: Captures['deps'] = {
    getHistory: vi.fn(() => []),
    addMessage: vi.fn((_role: string, _content: string) => `msg-${++idSeq}`),
    agentChat: vi.fn(),
    sendToPet: vi.fn((text: string, role: string) => sent.push({ text, role })),
    dispatchLocalIntent: vi.fn(),
    // 测试里退避立即 resolve，不真实等待 600/1500ms
    sleep: vi.fn(async () => {}),
  }
  return { deps, sent }
}

describe('PetChatOrchestrator — 失败重试与退避', () => {
  it('失败两次后成功：共调用 3 次 agentChat，退避 600/1500，最终上屏成功回复而非错误', async () => {
    const { deps, sent } = makeDeps()
    deps.agentChat
      .mockResolvedValueOnce({ success: false, error: 'ECONNRESET' })
      .mockResolvedValueOnce({ success: false, error: 'ECONNRESET' })
      .mockResolvedValueOnce({ success: true, content: '你好呀，我是 Lumina！' })

    const orch = new PetChatOrchestrator(deps)
    orch.handlePetMessage('你好呀')

    await vi.waitFor(() => expect(orch.agentCallCount).toBe(3))

    // 退避顺序与时长：600 → 1500
    expect(deps.sleep).toHaveBeenCalledTimes(2)
    expect(deps.sleep).toHaveBeenNthCalledWith(1, 600)
    expect(deps.sleep).toHaveBeenNthCalledWith(2, 1500)

    // 最后一条推给桌宠的是成功回复
    expect(sent[sent.length - 1]).toEqual({ text: '你好呀，我是 Lumina！', role: 'assistant' })
    // 期间绝不能出现错误气泡
    expect(sent.some(s => /抱歉|没答上/.test(s.text))).toBe(false)
    // 成功后本地派生动作
    expect(deps.dispatchLocalIntent).toHaveBeenCalledWith('你好呀，我是 Lumina！')
  })

  it('连续失败耗尽重试（1 + 2 次）后才上屏友好错误', async () => {
    const { deps, sent } = makeDeps()
    deps.agentChat.mockRejectedValue(new Error('connection refused'))

    const orch = new PetChatOrchestrator(deps)
    orch.handlePetMessage('hi')

    await vi.waitFor(() => expect(orch.agentCallCount).toBe(PET_RETRY_MAX + 1))
    // 退避 2 次
    expect(deps.sleep).toHaveBeenCalledTimes(PET_RETRY_MAX)
    // 最终一条是友好错误
    expect(sent[sent.length - 1].text).toMatch(/抱歉|没答上/)
    expect(sent[sent.length - 1].role).toBe('assistant')
  })

  it('success:true 但 content 为空 → 视为失败并重试', async () => {
    const { deps } = makeDeps()
    deps.agentChat
      .mockResolvedValueOnce({ success: true, content: '' })          // 空回复（旧 reactEngine 连续空回复）
      .mockResolvedValueOnce({ success: true, content: '真实回复来了' })

    const orch = new PetChatOrchestrator(deps)
    orch.handlePetMessage('x')
    await vi.waitFor(() => expect(orch.agentCallCount).toBe(2))
  })
})

describe('PetChatOrchestrator — 串行排队（不并发、不丢弃）', () => {
  it('第一条未完成时第二条排队等待，完成后自动接着跑', async () => {
    const { deps } = makeDeps()
    let releaseFirst: (v: any) => void = () => {}
    let firstStarted = false
    let secondStarted = false

    deps.agentChat
      .mockImplementationOnce(async () => {
        firstStarted = true
        // 挂起，模拟本地模型正在生成
        return new Promise((res) => { releaseFirst = res })
      })
      .mockImplementationOnce(async () => {
        secondStarted = true
        return { success: true, content: 'reply-b' }
      })

    const orch = new PetChatOrchestrator(deps)
    orch.handlePetMessage('a')
    await vi.waitFor(() => expect(firstStarted).toBe(true))

    // 第一条还挂着时，再发第二条
    orch.handlePetMessage('b')
    // 此刻第二条绝不能开始（不并发），且在队列里（不丢弃）
    expect(secondStarted).toBe(false)
    expect(orch.pendingCount).toBe(1)

    // 释放第一条
    releaseFirst({ success: true, content: 'reply-a' })
    await vi.waitFor(() => expect(secondStarted).toBe(true))

    // 两条用户消息都进了对话历史（旧实现会把 b 静默丢掉）
    expect(deps.addMessage).toHaveBeenCalledWith('user', 'a')
    expect(deps.addMessage).toHaveBeenCalledWith('user', 'b')
    expect(orch.pendingCount).toBe(0)
  })
})

describe('messagesToForward — 双向同步去重', () => {
  it('注入期（injectedByUs=true）→ 一律不回推（桌宠侧自己发的，避免回声）', () => {
    const newMsgs = [
      { id: 'u1', role: 'user', content: '你好' },       // 桌宠注入的用户消息
      { id: 'a1', role: 'assistant', content: '在的哦' }, // 桌宠注入的回复
    ]
    // zustand subscribe 同步触发时注入标志为 true → 全部跳过
    expect(messagesToForward(newMsgs, true)).toEqual([])
  })

  it('非注入期（injectedByUs=false）→ 转发主窗新消息，但跳过 system', () => {
    const newMsgs = [
      { id: 'u2', role: 'user', content: '主窗新消息' },
      { id: 's1', role: 'system', content: 'sys-prompt' },
      { id: 'a2', role: 'assistant', content: '主窗回复' },
    ]
    const out = messagesToForward(newMsgs, false)
    expect(out.map(m => m.id)).toEqual(['u2', 'a2'])
  })
})

describe('deriveLocalIntent — 回复文本本地派生动作（不发 LLM）', () => {
  it('按关键词映射动作', () => {
    expect(deriveLocalIntent('今天过得怎么样？')).toMatchObject({ action: 'think' })
    expect(deriveLocalIntent('哈哈哈太好玩了 🎉')).toMatchObject({ action: 'happy' })
    expect(deriveLocalIntent('晚安，早点休息')).toMatchObject({ action: 'sleep' })
    expect(deriveLocalIntent('抱歉，这次没答上来')).toMatchObject({ action: 'sad' })
    expect(deriveLocalIntent('好的，没问题，交给我吧')).toMatchObject({ action: 'nod' })
  })
})
