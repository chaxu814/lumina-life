import { describe, it, expect } from 'vitest'
import { SentenceSplitter } from '../electron/pet/lifeSpeech/sentenceSplitter'
import { LiveSpeechDirector } from '../electron/pet/lifeSpeech/liveSpeechDirector'

describe('SentenceSplitter 流式分句', () => {
  it('中文强终止切句', () => {
    const s = new SentenceSplitter()
    expect(s.push('你好呀。今天天气不错！')).toEqual(['你好呀。', '今天天气不错！'])
    expect(s.flush()).toBeNull()
  })

  it('增量到达也能正确切', () => {
    const s = new SentenceSplitter()
    expect(s.push('你好')).toEqual([])
    expect(s.push('呀。今天')).toEqual(['你好呀。'])
    expect(s.push('不错！')).toEqual(['今天不错！'])
  })

  it('长句在逗号处切以降低延迟', () => {
    const s = new SentenceSplitter()
    const out = s.push('今天我想和你一起去公园散步，好吗')
    expect(out[0]).toContain('公园散步，')
    expect(s.flush()).toBe('好吗')
  })

  it('英文缩写与小数点不误切，引号闭合归句尾', () => {
    const s = new SentenceSplitter()
    const out = s.push('It is 3.14 and Mr. Smith arrived. Next.')
    expect(out[0]).toBe('It is 3.14 and Mr. Smith arrived.')
    expect(out[1]).toBe('Next.')
    const q = new SentenceSplitter()
    const qo = q.push('他说：“好。”然后走了。')
    expect(qo[0]).toBe('他说：“好。”')
    expect(qo[1]).toBe('然后走了。')
  })
})

describe('LiveSpeechDirector 全双工编排', () => {
  it('正常一轮：聆听→思考→边生成边播→回到聆听', () => {
    const d = new LiveSpeechDirector()
    expect(d.userSpeechStart().some(a => a.type === 'start_listening')).toBe(true)
    const u = d.userUtterance('你好')
    expect(d.state).toBe('thinking')
    expect(u.some(a => a.type === 'call_llm')).toBe(true)
    const c = d.assistantChunk('你好呀。今天也要加油哦！')
    expect(c.filter(a => a.type === 'enqueue_speak')).toHaveLength(2)
    expect(d.state).toBe('speaking')
    expect(d.queueSize).toBe(2)
    d.sentenceSpoken()
    const back = d.sentenceSpoken()
    expect(d.queueSize).toBe(0)
    expect(back.some(a => a.type === 'start_listening')).toBe(true)
  })

  it('AI 说话时被打断：取消播放、清空队列，旧代际 token 作废', () => {
    const d = new LiveSpeechDirector()
    d.userUtterance('讲个故事')
    d.assistantChunk('从前有一条龙。它住在山里。', 1)
    expect(d.queueSize).toBe(2)
    const gen = d.currentGeneration
    const cut = d.userSpeechStart()
    expect(cut.some(a => a.type === 'cancel_speech')).toBe(true)
    expect(d.queueSize).toBe(0)
    expect(d.state).toBe('listening')
    // 旧一轮迟到的 token 必须被丢弃
    expect(d.assistantChunk('故事继续……', gen)).toEqual([])
    // 新一轮正常
    d.userUtterance('算了')
    expect(d.assistantChunk('好的。', d.currentGeneration).length).toBeGreaterThan(0)
  })

  it('assistantEnd 吐出残余半句', () => {
    const d = new LiveSpeechDirector()
    d.userUtterance('嗯')
    const acts = d.assistantChunk('好的我知道了')
    expect(acts).toEqual([])
    const end = d.assistantEnd()
    expect(end.some(a => a.type === 'enqueue_speak')).toBe(true)
  })
})
