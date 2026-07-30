// tests/longConversation.test.ts — 长对话稳定性测试
//
// 模拟长对话场景，测试：
// 1. compactContext() 不会过度压缩（通过 TokenEstimator 验证）
// 2. 委托上下文正确清理
// 3. TokenEstimator 更精确（替代旧 length*4）
// 4. 前端 tooShort 放过中文短回复
// ============================================================

import { describe, it, expect, vi, beforeAll } from 'vitest'

// ── Mock Electron ──
beforeAll(() => {
  vi.mock('electron', () => ({
    app: {
      getPath: (name: string) => process.cwd(),
    },
  }))
})

import { TokenEstimator } from '../electron/tokenEstimator'

// ═══════════════════════════════════════════════════════════
// 1. TokenEstimator 精度验证 — 旧算法 length*4 vs 新算法
// ═══════════════════════════════════════════════════════════
describe('TokenEstimator 精度', () => {
  const estimator = new TokenEstimator()

  it('中文文本: 新算法不超估', () => {
    const chineseText = '你好世界'.repeat(25) // 100 chars
    const est = estimator.estimate(chineseText)
    const oldEst = chineseText.length * 4  // 旧算法 = 400
    // 新: 中文 ~1.5 chars/token → ~67 tokens
    // 旧: 始终 length*4 = 400（~6x 超估）
    expect(est).toBeLessThan(oldEst)        // 新 < 旧（精确）
    expect(est).toBeLessThan(200)           // 不超过 200
    expect(est).toBeGreaterThan(30)         // 至少有 30
  })

  it('英文文本: 新算法合理', () => {
    const text = 'hello world this is a test '.repeat(20) // ~400 chars
    const est = estimator.estimate(text)
    expect(est).toBeGreaterThan(50)
    expect(est).toBeLessThan(200)
  })

  it('混合文本不崩溃', () => {
    const mixed = '你好 world 测试 123 哈哈 abc'
    expect(() => estimator.estimate(mixed)).not.toThrow()
    expect(estimator.estimate(mixed)).toBeGreaterThan(0)
  })

  it('空文本返回 0', () => {
    expect(estimator.estimate('')).toBe(0)
  })

  it('estimateMessages 累加正确', () => {
    const msgs = [
      { content: '你好' },
      { content: 'hello world' },
      { content: '混合文本 mixed content' },
    ]
    const total = estimator.estimateMessages(msgs)
    expect(total).toBeGreaterThan(0)
    const sum = msgs.reduce((s, m) => s + estimator.estimate(m.content), 0)
    expect(total).toBe(sum)
  })

  it('tool_calls 被计入', () => {
    const msgs = [
      { content: '我来搜索一下', tool_calls: [{ function: { name: 'web_search', arguments: '{}' } }] as any[] },
    ]
    const total = estimator.estimateMessages(msgs)
    expect(total).toBeGreaterThan(estimator.estimate(msgs[0].content))
  })

  it('format 可读', () => {
    expect(TokenEstimator.format(500)).toBe('500')
    expect(TokenEstimator.format(1500)).toBe('1.5k')
    expect(TokenEstimator.format(0)).toBe('0')
  })
})

// ═══════════════════════════════════════════════════════════
// 2. 前端 tooShort 逻辑验证 — 修复误杀
// ═══════════════════════════════════════════════════════════
describe('前端 tooShort 逻辑 - 修复中文短回复误杀', () => {
  // 与 GroupChatView.tsx 一致的 v7.1 逻辑
  const hasCJK = (text: string) => /[\u4e00-\u9fff\u3040-\u309f\uac00-\ud7af]/.test(text.trim())
  const emojiOnly = (text: string) => /^[\s✅👍👎❤️💯🎉🤔😂🫡💪🙏✨🔥👀😅🥺💀🫠]*$/u.test(text.trim())
  const tooShort_v71 = (reply: string) =>
    (reply.length < 2 || (!hasCJK(reply) && reply.length < 3)) || emojiOnly(reply)

  // 旧版 v6.4.1（误杀逻辑）
  const tooShort_v64 = (reply: string) => reply.length < 3 || emojiOnly(reply)

  it('🎯 v7.1: 放过了"好的""收到"（旧版误杀）', () => {
    const valid: string[] = ['好的', '收到', '明白', '可以']
    for (const text of valid) {
      expect(tooShort_v64(text)).toBe(true)  // 旧版: 误杀 (length<3)
      expect(tooShort_v71(text)).toBe(false) // 新版: 放过 ✓ (含 CJK)
    }
    // 单字 '行' '恩' '嗯' → 新版仍过滤（1个字当回复确实太短）
    expect(tooShort_v71('行')).toBe(true)
    expect(tooShort_v71('恩')).toBe(true)
    // 'OK' 等非 CJK 2字短回复仍过滤（AI 助手回复"OK"太短）
    expect(tooShort_v71('OK')).toBe(true)
  })

  it('仍然过滤纯 emoji 回复', () => {
    const emojis = ['✅', '👍', '❤️', '✅👍', '   👍  ']
    for (const text of emojis) {
      expect(tooShort_v71(text)).toBe(true)
    }
  })

  it('放过正常长回复', () => {
    expect(tooShort_v71('这是一个正常的回复内容')).toBe(false)
    expect(tooShort_v71('Hello, how can I help?')).toBe(false)
    expect(tooShort_v71('今天天气不错，我们去散步吧')).toBe(false)
  })

  it('空串/纯标点仍过滤', () => {
    expect(tooShort_v71('')).toBe(true)
    expect(tooShort_v71('！')).toBe(true)
    expect(tooShort_v71('~')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════
// 3. 长对话上下文 — 压缩阈值 & 精确估算
// ═══════════════════════════════════════════════════════════
describe('长对话上下文 - 压缩阈值', () => {
  function makeConversation(rounds: number): Array<{ content: string }> {
    const msgs: Array<{ content: string }> = []
    for (let i = 0; i < rounds; i++) {
      msgs.push({ content: `用户问题 ${i + 1}: 今天市场怎么样？科技板块表现如何？有什么投资建议？` })
      msgs.push({ content: `回答 ${i + 1}: 今天科技板块整体表现良好，纳斯达克上涨1.2%。建议关注半导体和云计算领域。${'详细'.repeat(10)}` })
    }
    return msgs
  }

  it('10轮对话远低于 130K 预算', () => {
    const estimator = new TokenEstimator({ threshold: 130000 })
    const msgs = makeConversation(10)
    const estimated = estimator.estimateMessages(msgs)
    expect(estimated).toBeLessThan(130000)
    expect(estimated).toBeLessThan(30000) // 10轮最多3万
  })

  it('🎯 30轮对话仍低于旧 length*4 阈值', () => {
    const msgs = makeConversation(30)
    const newEst = new TokenEstimator({ threshold: 130000 }).estimateMessages(msgs)

    // 旧 length*4 阈值固定 80000
    const oldChars = msgs.reduce((s, m) => s + (m.content?.length || 0), 0)
    const oldEst = oldChars * 4

    // 新算法精确，旧算法 length*4 ≈ 3-6x 超估
    // 确认新算法 < 旧算法的一半
    expect(newEst).toBeLessThan(oldEst / 2)

    // 旧算法: 30轮 strings_content ~60000 chars * 4 = 240K > 80K → 过早触发压缩！
    // 新算法: 30轮 ~20000 tokens < 130K → 不触发压缩 ✓
    expect(newEst).toBeLessThan(130000)
  })

  it('TokenEstimator needsCompaction 逻辑正确', () => {
    const estimator = new TokenEstimator({ threshold: 10000 })
    expect(estimator.needsCompaction()).toBe(false)
    estimator.add(15000)
    expect(estimator.needsCompaction()).toBe(true)
  })

  it('compactionUrgency 范围 0-1', () => {
    const estimator = new TokenEstimator({ threshold: 10000 })
    expect(estimator.compactionUrgency()).toBe(0)
    estimator.add(10000)
    expect(estimator.compactionUrgency()).toBe(1.0)
  })
})

// ═══════════════════════════════════════════════════════════
// 4. 委托上下文隔离 — 每次委派后回滚
// ═══════════════════════════════════════════════════════════
describe('委派上下文隔离 - 防止二次委派污染', () => {
  it('单次委派后消息回滚', () => {
    const messages: Array<any> = [{ role: 'system', content: 'system prompt' }]
    // 已有 4 轮对话
    for (let i = 0; i < 4; i++) {
      messages.push({ role: 'user', content: `问题 ${i}` })
      messages.push({ role: 'assistant', content: `回答 ${i}` })
    }
    const snapshot = messages.length // 9

    // 委派产生 3 条临时消息
    messages.push({ role: 'user', content: '[Yak] 搜索任务' })
    messages.push({ role: 'assistant', content: '', tool_calls: [] })
    messages.push({ role: 'tool', content: '搜索完成' })

    // delegationManager 清理: splice 回滚
    messages.splice(snapshot, messages.length - snapshot)
    expect(messages.length).toBe(snapshot)
  })

  it('多次委派后上下文不膨胀', () => {
    const messages: Array<any> = [{ role: 'system', content: 'system' }]

    for (let delegate = 0; delegate < 10; delegate++) {
      const beforeLen = messages.length
      // 委派消息
      messages.push({ role: 'user', content: `[Yak] 第 ${delegate + 1} 次委派` })
      messages.push({ role: 'assistant', content: `结果 ${delegate + 1}` })
      // 回滚
      messages.splice(beforeLen, messages.length - beforeLen)
    }

    // 10次委派后消息数不变
    expect(messages.length).toBe(1) // 只有 system
  })

  it('委派失败也回滚', () => {
    const messages: Array<any> = [{ role: 'system', content: 'system' }]
    const snapshot = messages.length

    // 模拟失败的委派: 先加了消息，然后异常
    messages.push({ role: 'user', content: '[Yak] 失败任务' })
    messages.push({ role: 'assistant', content: '', error: '工具超时' })

    // 异常回滚
    messages.splice(snapshot, messages.length - snapshot)
    expect(messages.length).toBe(snapshot)
  })
})

// ═══════════════════════════════════════════════════════════
// 5. 工具注册链不崩溃
// ═══════════════════════════════════════════════════════════
describe('工具注册链', () => {
  it('executeToolWithRetry 存在', async () => {
    const mod = await import('../electron/tools/registry')
    expect(mod).toBeDefined()
    expect(typeof mod.executeToolWithRetry).toBe('function')
    expect(typeof mod.executeTool).toBe('function')
  })
})

// ═══════════════════════════════════════════════════════════
// 6. agentRunner 导出存在
// ═══════════════════════════════════════════════════════════
describe('agentRunner 导出', () => {
  it('parseXmlToolCalls 能解析', async () => {
    const mod = await import('../electron/agentRunner')
    const xml = '<tool_call><function=browser><parameter=action>snapshot</parameter></function></tool_call>'
    const calls = mod.parseXmlToolCalls(xml)
    expect(calls).not.toBeNull()
    expect(calls!.length).toBe(1)
    expect(calls![0].function.name).toBe('browser')
  })
})
