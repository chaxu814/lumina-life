import { describe, it, expect } from 'vitest'
import { analyzeFrame, NoiseGate } from '../electron/whisper/audioLevel'
import { VoiceActivityDetector, type VadEvent } from '../electron/whisper/vad'

describe('audioLevel 电平与噪声门', () => {
  it('静音/有声帧特征正确', () => {
    expect(analyzeFrame(new Array(100).fill(0)).rms).toBe(0)
    const loud = analyzeFrame(new Array(100).fill(0).map((_, i) => (i % 2 ? 0.6 : -0.6)))
    expect(loud.rms).toBeCloseTo(0.6, 1)
    expect(loud.peak).toBeCloseTo(0.6)
    expect(loud.zcr).toBeGreaterThan(0.5)
    expect(analyzeFrame([]).rms).toBe(0)
  })

  it('噪声门区分安静/语音，安静时地板下调', () => {
    const gate = new NoiseGate()
    for (let i = 0; i < 50; i++) {gate.update({ rms: 0.001, peak: 0.002, zcr: 0.02 })}
    expect(gate.isVoiced({ rms: 0.001, peak: 0.002, zcr: 0.02 })).toBe(false)
    expect(gate.isVoiced({ rms: 0.3, peak: 0.6, zcr: 0.1 })).toBe(true)
  })
})

describe('VAD 语音活动检测', () => {
  const FRAME = 30
  const voiced = { rms: 0.35, peak: 0.6, zcr: 0.12 }
  const silent = { rms: 0.001, peak: 0.003, zcr: 0.04 }

  function run(seq: Array<'v' | 's' | 'vshort'>, cfg = {}) {
    const vad = new VoiceActivityDetector(cfg)
    const events: VadEvent[] = []
    let t = 0
    for (let i = 0; i < 10; i++) { vad.feed(silent, t); t += FRAME } // 稳定噪声地板
    for (const kind of seq) {
      const n = kind === 'v' ? 20 : kind === 'vshort' ? 5 : 25
      for (let i = 0; i < n; i++) { const e = vad.feed(kind === 's' ? silent : voiced, t); if (e) {events.push(e);} t += FRAME }
    }
    return events
  }

  it('完整一段话产生 start/end，时长合理且非过短', () => {
    const events = run(['v', 's'])
    const start = events.find(e => e.type === 'start')
    const end = events.find(e => e.type === 'end')
    expect(start).toBeTruthy()
    expect(end).toBeTruthy()
    if (end && end.type === 'end') {
      expect(end.tooShort).toBe(false)
      expect(end.durationMs).toBeGreaterThan(250)
    }
    if (start && start.type === 'start') {expect(start.preRoll.length).toBeGreaterThan(0)}
  })

  it('极短一声被标记 tooShort', () => {
    const events = run(['vshort', 's'])
    const end = events.find(e => e.type === 'end')
    expect(end).toBeTruthy()
    if (end && end.type === 'end') {expect(end.tooShort).toBe(true)}
  })

  it('持续安静不产生事件，reset 归零', () => {
    const vad = new VoiceActivityDetector()
    let any = false
    for (let t = 0; t < 3000; t += FRAME) {if (vad.feed(silent, t)) {any = true}}
    expect(any).toBe(false)
    expect(vad.state).toBe('silent')
  })
})
