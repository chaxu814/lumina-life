import { describe, it, expect } from 'vitest'
import { WakeWordGate, DEFAULT_WAKE_KEYWORDS } from '../electron/whisper/wakeWord'

describe('wakeWord 唤醒词门控', () => {
  it('默认关闭：所有话直接放行', () => {
    const g = new WakeWordGate()
    expect(g.enabled).toBe(false)
    expect(g.shouldProcess('今天天气怎么样', 0)).toBe(true)
    expect(DEFAULT_WAKE_KEYWORDS).toContain('lumina')
  })

  it('开启后：未唤醒忽略，唤醒词触发并进入会话窗口', () => {
    const g = new WakeWordGate({ enabled: true, sessionMs: 10_000 })
    expect(g.shouldProcess('今天天气怎么样', 0)).toBe(false)
    expect(g.shouldProcess('Lumina！', 100)).toBe(true)
    expect(g.wakeCount).toBe(1)
    expect(g.isSessionActive(200)).toBe(true)
    // 会话窗口内普通对话放行
    expect(g.shouldProcess('那明天呢', 5000)).toBe(true)
    // 窗口结束后需重新唤醒
    expect(g.isSessionActive(11_000)).toBe(false)
    expect(g.shouldProcess('随便聊聊', 11_000)).toBe(false)
  })

  it('唤醒词在句首也能处理整句', () => {
    const g = new WakeWordGate({ enabled: true })
    expect(g.shouldProcess('小光，帮我看下时间', 0)).toBe(true)
    expect(g.wakeCount).toBe(1)
  })

  it('冷却期内不重复唤醒', () => {
    const g = new WakeWordGate({ enabled: true, cooldownMs: 2000 })
    expect(g.wake('lumina', 0).waked).toBe(true)
    expect(g.wake('lumina', 500).waked).toBe(false)
    expect(g.wake('lumina', 3000).waked).toBe(true)
  })

  it('自定义关键词与结束会话', () => {
    const g = new WakeWordGate({ enabled: true, keywords: ['喵喵'] })
    expect(g.matchKeyword('喵喵过来')).toBe('喵喵')
    expect(g.shouldProcess('喵喵', 0)).toBe(true)
    g.endSession()
    expect(g.isSessionActive(100)).toBe(false)
  })
})
