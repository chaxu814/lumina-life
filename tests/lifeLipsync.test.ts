import { describe, it, expect } from 'vitest'
import {
  textToVisemeSegments, sampleViseme, opennessFromRms,
} from '../electron/pet/life/lipsync'

describe('lipsync 五元音口型', () => {
  it('拉丁词映射元音：hello 含 E 与 O', () => {
    const segs = textToVisemeSegments('hello')
    const vowels = segs.filter(s => s.viseme !== 'rest').map(s => s.viseme)
    expect(vowels).toContain('E')
    expect(vowels).toContain('O')
  })

  it('中文语气词：啊→A，喵→I 再 A', () => {
    const a = textToVisemeSegments('啊').filter(s => s.viseme !== 'rest')
    expect(a.some(s => s.viseme === 'A')).toBe(true)
    const miao = textToVisemeSegments('喵').map(s => s.viseme).filter(v => v !== 'rest')
    expect(miao).toEqual(['I', 'A'])
  })

  it('标点产生停顿(rest)，时间轴单调递增，结尾闭合', () => {
    const segs = textToVisemeSegments('哦，好。')
    expect(segs.some(s => s.viseme === 'rest')).toBe(true)
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBeGreaterThanOrEqual(segs[i - 1].end - 1)
    expect(sampleViseme(segs, 10_000_000).viseme).toBe('rest')
  })

  it('空文本安全', () => {
    expect(textToVisemeSegments('')).toEqual([])
    expect(sampleViseme([], 0).viseme).toBe('rest')
  })

  it('能量包络：有声张开、无声闭合、张快闭慢', () => {
    let open = 0
    open = opennessFromRms(1, open)
    const afterAttack = open
    expect(afterAttack).toBeGreaterThan(0.4)
    let close = afterAttack
    close = opennessFromRms(0, close)
    expect(close).toBeLessThan(afterAttack)
    // 单次闭嘴衰减慢于张嘴
    expect(opennessFromRms(0, 0.5)).toBeGreaterThan(0.5 - 0.4)
  })
})
