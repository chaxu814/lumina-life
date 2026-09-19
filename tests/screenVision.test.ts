import { describe, it, expect } from 'vitest'
import {
  dhash, hammingDistance, changeScore, classifyScene, ScreenAwareness,
} from '../electron/pet/vision/screenAwareness'
import { PresenceMonitor } from '../electron/pet/vision/presence'

describe('screenAwareness 屏幕感知', () => {
  it('dhash / 汉明距离 / 变化分数', () => {
    const same = new Array(72).fill(100)
    const decreasing: number[] = []
    for (let y = 0; y < 8; y++) {for (let x = 0; x < 9; x++) {decreasing.push(200 - x * 20)}}
    const h1 = dhash(same, 9, 8)
    const h2 = dhash(decreasing, 9, 8)
    expect(changeScore(h1, h1)).toBeCloseTo(0)
    expect(changeScore(h1, h2)).toBeCloseTo(1)
    expect(hammingDistance(h1, h2)).toBe(64)
    expect(changeScore(null, h2)).toBe(1)
  })

  it('活动窗口场景分类', () => {
    expect(classifyScene('原神', 'GenshinImpact.exe')).toBe('game')
    expect(classifyScene('main.ts — Visual Studio Code')).toBe('code')
    expect(classifyScene('某视频 - bilibili')).toBe('video')
    expect(classifyScene('微信', 'WeChat.exe')).toBe('social')
    expect(classifyScene('报告.pdf', 'Acrobat')).toBe('doc')
    expect(classifyScene('', '')).toBe('idle')
    expect(classifyScene('一个普通窗口', 'SomeApp')).toBe('other')
  })

  it('决策：首帧抓、稳定不抓、显著变化且到点抓、场景切换抓、低频兜底', () => {
    const a = new ScreenAwareness()
    a.noteWindow('main.ts — Visual Studio Code', 'Code.exe')
    expect(a.decide(0).reason).toBe('first')
    a.noteFrame(new Array(72).fill(100), 9, 8, 100)
    expect(a.decide(1000).capture).toBe(false) // 稳定且未到间隔

    const b = new ScreenAwareness()
    b.noteWindow('Code')
    b.decide(0)
    const decreasing: number[] = []
    for (let y = 0; y < 8; y++) {for (let x = 0; x < 9; x++) {decreasing.push(200 - x * 20)}}
    b.noteFrame(decreasing, 9, 8, 100)
    const changed = b.decide(20_000)
    expect(changed.capture).toBe(true)
    expect(changed.reason).toBe('change')

    const c = new ScreenAwareness()
    c.noteWindow('Code')
    c.decide(0)
    c.noteWindow('原神', 'GenshinImpact.exe')
    expect(c.decide(5_000).reason).toBe('scene_change')

    const d = new ScreenAwareness()
    d.noteFrame(new Array(72).fill(100), 9, 8, 0) // 建立基线
    d.decide(0)
    d.noteFrame(new Array(72).fill(100), 9, 8, 100) // 无变化
    expect(d.decide(130_000).reason).toBe('interval')
  })

  it('显著变化但间隔不足时被节流', () => {
    const a = new ScreenAwareness()
    a.decide(0)
    const decreasing: number[] = []
    for (let y = 0; y < 8; y++) {for (let x = 0; x < 9; x++) {decreasing.push(200 - x * 20)}}
    a.noteFrame(decreasing, 9, 8, 100)
    expect(a.decide(2_000).reason).toBe('stable')
  })
})

describe('presence 摄像头隐私状态机', () => {
  it('默认关闭，不能采样也不接受检测', () => {
    const p = new PresenceMonitor()
    expect(p.state).toBe('disabled')
    expect(p.shouldSample(0)).toBe(false)
    expect(p.indicatorOn).toBe(false)
    expect(p.feedDetection({ present: true }, 0)).toBe(false)
  })

  it('授权后手动开启：按间隔采样、亮灯、记录在场/注视/表情', () => {
    const p = new PresenceMonitor()
    p.authorize()
    expect(p.state).toBe('off')
    expect(p.enable(0)).toBe(true)
    expect(p.indicatorOn).toBe(true)
    expect(p.shouldSample(0)).toBe(true)
    p.markSampled(0)
    expect(p.shouldSample(500)).toBe(false)
    expect(p.shouldSample(2000)).toBe(true)
    expect(p.feedDetection({ present: true, lookingAtScreen: true, expression: 'happy' }, 2000)).toBe(true)
    expect(p.isUserPresent(2500)).toBe(true)
    expect(p.isLookingAt(2500)).toBe(true)
    expect(p.expression).toBe('happy')
    p.disable()
    expect(p.state).toBe('off')
    expect(p.indicatorOn).toBe(false)
  })

  it('非本地处理被拒绝', () => {
    const p = new PresenceMonitor({ localOnly: false })
    p.authorize()
    expect(p.enable(0)).toBe(false)
    expect(p.state).toBe('off')
    expect(p.blockedReason).toContain('本地')
  })

  it('撤销授权立即停止熄灯', () => {
    const p = new PresenceMonitor({ authorized: true })
    p.enable(0)
    p.revoke()
    expect(p.state).toBe('disabled')
    expect(p.indicatorOn).toBe(false)
    expect(p.shouldSample(9999)).toBe(false)
  })
})
