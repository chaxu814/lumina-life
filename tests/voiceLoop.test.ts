import { describe, it, expect, vi } from 'vitest'
import { VoiceLoop, type VoiceLoopDeps, type VoiceLoopState } from '../electron/voice/voiceLoop'

/** 构造一个可控的 mock 依赖：所有动作记录到日志，异步可 await */
function makeDeps(overrides: Partial<VoiceLoopDeps> = {}) {
  const log: string[] = []
  let speakResolve: (() => void) | null = null
  const deps: VoiceLoopDeps = {
    startRecording: vi.fn(() => {log.push('startRecording')}),
    stopRecording: vi.fn(async () => {
      log.push('stopRecording')
      return { audioPath: '/tmp/a.wav' }
    }),
    transcribe: vi.fn(async () => {
      log.push('transcribe')
      return '今天天气怎么样'
    }),
    dispatch: vi.fn(async () => {
      log.push('dispatch')
      return '今天晴，二十度喵'
    }),
    speak: vi.fn(async () => {
      log.push('speak')
      // 返回一个不立即 resolve 的 promise，模拟播报中
      return new Promise<void>((r) => {speakResolve = r})
    }),
    cancelSpeak: vi.fn(() => {log.push('cancelSpeak')}),
    cancelPending: vi.fn(() => {log.push('cancelPending')}),
    ...overrides,
  }
  return {
    deps,
    log,
    finishSpeak: () => speakResolve?.(),
  }
}

function makeLoop(deps: VoiceLoopDeps) {
  const states: VoiceLoopState[] = []
  const loop = new VoiceLoop(deps, {
    onStateChange: (s) => states.push(s),
  }, { errorRecoverMs: 50 })
  return { loop, states }
}

describe('VoiceLoop 状态机', () => {
  it('初始状态为 idle', () => {
    const { deps } = makeDeps()
    const { loop } = makeLoop(deps)
    expect(loop.state).toBe('idle')
    expect(loop.busy()).toBe(false)
  })

  it('PTT 按下→recording，松开→recognizing→speaking→idle 完整闭环', async () => {
    const { deps, log, finishSpeak } = makeDeps()
    const { loop, states } = makeLoop(deps)

    loop.handlePTTDown()
    expect(loop.state).toBe('recording')
    expect(deps.startRecording).toHaveBeenCalledTimes(1)

    loop.handlePTTUp()
    expect(loop.state).toBe('recognizing')

    // 等 transcribe + dispatch 跑完进入 speaking
    await vi.waitFor(() => expect(loop.state).toBe('speaking'))
    expect(loop.lastTranscript).toBe('今天天气怎么样')
    expect(loop.lastReply).toBe('今天晴，二十度喵')

    // 播报结束 → idle
    finishSpeak()
    await vi.waitFor(() => expect(loop.state).toBe('idle'))

    expect(log).toEqual([
      'cancelSpeak', 'cancelPending', 'startRecording',
      'stopRecording', 'transcribe', 'dispatch', 'speak',
    ])
    expect(states).toEqual([
      'recording', 'recognizing', 'speaking', 'idle',
    ])
  })

  it('idle 时松开 PTT 无效果', () => {
    const { deps } = makeDeps()
    const { loop } = makeLoop(deps)
    loop.handlePTTUp()
    expect(loop.state).toBe('idle')
    expect(deps.stopRecording).not.toHaveBeenCalled()
  })

  it('录音中重复按下 PTT 不会重复 startRecording', () => {
    const { deps } = makeDeps()
    const { loop } = makeLoop(deps)
    loop.handlePTTDown()
    loop.handlePTTDown()
    loop.handlePTTDown()
    expect(deps.startRecording).toHaveBeenCalledTimes(1)
  })

  it('speaking 中再次按 PTT：打断播报并立即开始新录音', async () => {
    const { deps } = makeDeps()
    const { loop } = makeLoop(deps)
    loop.handlePTTDown()
    loop.handlePTTUp()
    await vi.waitFor(() => expect(loop.state).toBe('speaking'))

    // 播报中按下 → 打断
    loop.handlePTTDown()
    expect(loop.state).toBe('recording')
    expect(deps.cancelSpeak).toHaveBeenCalled()
    expect(deps.startRecording).toHaveBeenCalledTimes(2)
  })

  it('recognizing 中按 PTT：取消进行中的识别并重新录音', async () => {
    let releaseTranscribe!: (v: string) => void
    const transcribeStarted = vi.fn()
    const { deps } = makeDeps({
      transcribe: vi.fn(() => {
        transcribeStarted()
        return new Promise<string>((r) => {releaseTranscribe = r})
      }),
    })
    const { loop } = makeLoop(deps)
    loop.handlePTTDown()
    loop.handlePTTUp()
    expect(loop.state).toBe('recognizing')
    // 等 transcribe 真正开始
    await vi.waitFor(() => expect(transcribeStarted).toHaveBeenCalled())

    // 识别途中按下打断
    loop.handlePTTDown()
    expect(loop.state).toBe('recording')
    expect(deps.cancelPending).toHaveBeenCalled()
    // 让挂起的 transcribe 返回；由于 gen 已变，结果不应推进状态
    releaseTranscribe('不应被采用')
    await new Promise((r) => setTimeout(r, 10))
    expect(loop.state).toBe('recording')
    expect(loop.lastTranscript).toBe('')
  })

  it('STT 返回空文字 → 直接回 idle，不 dispatch 不 speak', async () => {
    const { deps } = makeDeps({ transcribe: vi.fn(async () => '   ') })
    const { loop } = makeLoop(deps)
    loop.handlePTTDown()
    loop.handlePTTUp()
    await vi.waitFor(() => expect(loop.state).toBe('idle'))
    expect(deps.dispatch).not.toHaveBeenCalled()
    expect(deps.speak).not.toHaveBeenCalled()
  })

  it('dispatch 返回空 → 不播报，回 idle', async () => {
    const { deps } = makeDeps({ dispatch: vi.fn(async () => '') })
    const { loop } = makeLoop(deps)
    loop.handlePTTDown()
    loop.handlePTTUp()
    await vi.waitFor(() => expect(loop.state).toBe('idle'))
    expect(loop.state).toBe('idle')
    expect(deps.speak).not.toHaveBeenCalled()
  })

  it('异常 → error 态，定时自动恢复 idle', async () => {
    const { deps } = makeDeps({
      transcribe: vi.fn(async () => {throw new Error('麦克风被占用')}),
    })
    const { loop, states } = makeLoop(deps)
    loop.handlePTTDown()
    loop.handlePTTUp()
    await vi.waitFor(() => expect(loop.state).toBe('error'))
    expect(states).toContain('error')
    // 50ms 后自动恢复
    await vi.waitFor(() => expect(loop.state).toBe('idle'))
  })

  it('reset() 打断一切并回到 idle', async () => {
    const { deps } = makeDeps()
    const { loop } = makeLoop(deps)
    loop.handlePTTDown()
    loop.handlePTTUp()
    await vi.waitFor(() => expect(loop.state).toBe('speaking'))
    loop.reset()
    expect(loop.state).toBe('idle')
    expect(deps.cancelSpeak).toHaveBeenCalled()
  })
})
