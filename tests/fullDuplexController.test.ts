// ============================================================
// tests/fullDuplexController.test.ts — 全双工对话编排器
// 用真实 LiveSpeechDirector 做 sendEvent 后端，假 bridge 模拟 LLM/TTS/打断
// ============================================================

import { describe, it, expect } from 'vitest'
import { FullDuplexController, cleanSpokenReply, type FullDuplexBridge, type DirectorEventResult } from '../electron/pet/lifeSpeech/fullDuplexController'
import { LiveSpeechDirector } from '../electron/pet/lifeSpeech/liveSpeechDirector'

function makeBridge(overrides: Partial<FullDuplexBridge> = {}) {
  const director = new LiveSpeechDirector()
  const spoken: string[] = []
  const states: string[] = []
  let cancelCount = 0
  const errors: string[] = []
  const callLlm = overrides.callLlm || (async () => '你好呀。今天天气不错。')

  const bridge: FullDuplexBridge = {
    sendEvent: async (p): Promise<DirectorEventResult> => {
      let actions: any[] = []
      switch (p.type) {
        case 'user_start': actions = director.userSpeechStart(); break
        case 'user_utterance': actions = director.userUtterance(String(p.text || '')); break
        case 'assistant_chunk': actions = director.assistantChunk(String(p.text || ''), p.generation); break
        case 'assistant_end': actions = director.assistantEnd(p.generation); break
        case 'sentence_spoken': actions = director.sentenceSpoken(); break
        case 'reset': director.reset(); actions = []; break
      }
      return { actions, generation: director.currentGeneration, queueSize: director.queueSize }
    },
    callLlm: (text, gen) => callLlm(text, gen),
    speakSentence: async (text) => { spoken.push(text) },
    cancelSpeech: () => { cancelCount++ },
    onState: (s) => states.push(s),
    onError: (m) => errors.push(m),
  }
  return {
    bridge,
    spoken,
    states: () => states,
    cancelCount: () => cancelCount,
    errors,
    director,
  }
}

const tick = () => new Promise(r => setTimeout(r, 0))

describe('FullDuplexController 正常全双工流', () => {
  it('用户说话 → LLM → 逐句 TTS → 回到聆听', async () => {
    const env = makeBridge()
    const ctrl = new FullDuplexController(env.bridge)
    ctrl.setEnabled(true)
    await ctrl.userStarted()
    await ctrl.userUtterance('你好')

    const joined = env.spoken.join('')
    expect(joined).toContain('你好呀')
    expect(joined).toContain('今天天气不错')
    // 队列播完后回到聆听
    expect(env.states().slice(-1)[0]).toBe('listening')
  })

  it('禁用时不处理任何输入', async () => {
    const env = makeBridge()
    const ctrl = new FullDuplexController(env.bridge)
    ctrl.setEnabled(false)
    await ctrl.userStarted()
    await ctrl.userUtterance('你好')
    expect(env.spoken).toHaveLength(0)
  })

  it('空识别不触发 LLM', async () => {
    let called = 0
    const env = makeBridge({ callLlm: async () => { called++; return 'x' } })
    const ctrl = new FullDuplexController(env.bridge)
    ctrl.setEnabled(true)
    await ctrl.userStarted()
    await ctrl.userUtterance('   ')
    expect(called).toBe(0)
  })
})

describe('FullDuplexController 打断（barge-in）', () => {
  it('AI 说话时用户开口：cancel_speech 触发，后续句子不再播', async () => {
    let gate: () => void = () => {}
    const env = makeBridge({
      callLlm: async () => '第一句。第二句。',
    })
    // 第一句卡住，期间模拟用户开口打断
    env.bridge.speakSentence = async (text) => {
      env.spoken.push(text)
      if (text.includes('第一句')) {
        await ctrl.userStarted()
        await new Promise<void>(r => { gate = r })
      }
    }
    const ctrl = new FullDuplexController(env.bridge)
    ctrl.setEnabled(true)
    const done = ctrl.userUtterance('说两句')
    await tick(); await tick()
    gate()
    await done
    await tick()

    expect(env.cancelCount()).toBeGreaterThanOrEqual(1)
    expect(env.spoken.join('')).not.toContain('第二句')
  })
})

describe('FullDuplexController 代际作废', () => {
  it('上一轮迟到的 LLM 回复被丢弃，不会串台', async () => {
    let resolve1: (s: string) => void = () => {}
    const p1 = new Promise<string>(r => { resolve1 = r })
    let n = 0
    const env = makeBridge({
      callLlm: async () => {
        n++
        if (n === 1) return p1
        return '好的。'
      },
    })
    const ctrl = new FullDuplexController(env.bridge)
    ctrl.setEnabled(true)
    const u1 = ctrl.userUtterance('在吗')
    await tick(); await tick()
    // 用户改主意，开新一轮
    await ctrl.userStarted()
    await ctrl.userUtterance('再帮我')
    resolve1('旧回复。')
    await u1
    await tick()

    expect(env.spoken.join('')).not.toContain('旧回复')
    expect(env.spoken.join('')).toContain('好的')
  })
})

describe('cleanSpokenReply', () => {
  it('去掉 markdown、舞台提示、列表符号', () => {
    expect(cleanSpokenReply('**好的**，我来帮你。')).toBe('好的，我来帮你。')
    expect(cleanSpokenReply('（挥手）你好呀')).toBe('你好呀')
    expect(cleanSpokenReply('- 第一点\n- 第二点')).toBe('第一点\n第二点')
  })
})
