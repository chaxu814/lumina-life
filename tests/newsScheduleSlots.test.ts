// ============================================================
// tests/newsScheduleSlots.test.ts
// 覆盖「改造 1」的间隔调度逻辑与配置归一化
// ============================================================
import { describe, it, expect } from 'vitest'
import {
  generateIntervalSlots, normalizeHour, normalizeIntervalHours,
  isHourInQuietRange, resolveActiveSlots, sanitizeSlots,
  describeSlot, normalizeCooldownHours,
  DEFAULT_INTERVAL_HOURS, DEFAULT_ANCHOR_HOUR,
} from '../electron/news/scheduleSlots'

describe('generateIntervalSlots — 间隔模式时段生成', () => {
  it('默认每 3 小时一次，从 0 点开始 → 0,3,6,...,21', () => {
    expect(generateIntervalSlots(DEFAULT_INTERVAL_HOURS, DEFAULT_ANCHOR_HOUR))
      .toEqual([0, 3, 6, 9, 12, 15, 18, 21])
  })

  it('需求文档里给的默认配置就是 3 小时 / 起点 0', () => {
    expect(DEFAULT_INTERVAL_HOURS).toBe(3)
    expect(DEFAULT_ANCHOR_HOUR).toBe(0)
  })

  it('每 2 小时 → 一天 12 个时段', () => {
    const slots = generateIntervalSlots(2, 0)
    expect(slots).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22])
    expect(slots).toHaveLength(12)
  })

  it('起点偏移生效：每 2 小时从 1 点开始', () => {
    expect(generateIntervalSlots(2, 1)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23])
  })

  it('非整除的间隔也能正确回绕到 0-23', () => {
    // 7 小时：0,7,14,21 —— 20 之后是 27 → 回绕成 3，但 3 已在集合外
    const s7 = generateIntervalSlots(7, 0)
    expect(s7).toEqual([0, 7, 14, 21])
    for (const h of s7) expect(h).toBeGreaterThanOrEqual(0)
    for (const h of s7) expect(h).toBeLessThanOrEqual(23)
  })

  it('每 5 小时 → 0,5,10,15,20', () => {
    expect(generateIntervalSlots(5, 0)).toEqual([0, 5, 10, 15, 20])
  })

  it('间隔 24 → 每天只有起点那一个时段', () => {
    expect(generateIntervalSlots(24, 6)).toEqual([6])
  })

  it('间隔 1 → 覆盖全部 24 个整点', () => {
    const s = generateIntervalSlots(1, 0)
    expect(s).toHaveLength(24)
    expect(s[0]).toBe(0)
    expect(s[23]).toBe(23)
  })

  it('结果始终升序且无重复', () => {
    for (const step of [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 17, 24]) {
      const s = generateIntervalSlots(step, 5)
      expect(new Set(s).size).toBe(s.length)
      expect([...s].sort((a, b) => a - b)).toEqual(s)
    }
  })
})

describe('normalizeIntervalHours — 非法间隔兜底', () => {
  it('0 / 负数 → 1', () => {
    expect(normalizeIntervalHours(0)).toBe(1)
    expect(normalizeIntervalHours(-5)).toBe(1)
  })

  it('> 24 → 24', () => {
    expect(normalizeIntervalHours(100)).toBe(24)
  })

  it('NaN / undefined → 默认 3', () => {
    expect(normalizeIntervalHours(NaN)).toBe(3)
    expect(normalizeIntervalHours(undefined)).toBe(3)
    expect(normalizeIntervalHours('abc')).toBe(3)
  })

  it('小数向下取整', () => {
    expect(normalizeIntervalHours(2.9)).toBe(2)
  })
})

describe('normalizeHour', () => {
  it('24 → 0（次日零点）', () => {
    expect(normalizeHour(24)).toBe(0)
  })

  it('负数与越界回绕', () => {
    expect(normalizeHour(-1)).toBe(23)
    expect(normalizeHour(30)).toBe(6)
  })

  it('NaN → 0', () => {
    expect(normalizeHour(NaN)).toBe(0)
  })
})

describe('isHourInQuietRange — 静默时段', () => {
  it('null / undefined → 不静默', () => {
    expect(isHourInQuietRange(3, null)).toBe(false)
    expect(isHourInQuietRange(3, undefined)).toBe(false)
  })

  it('不跨午夜：start<end', () => {
    const q = { start: 22, end: 7 }
    expect(isHourInQuietRange(23, q)).toBe(true)
    expect(isHourInQuietRange(3, q)).toBe(true)
    expect(isHourInQuietRange(12, q)).toBe(false)
  })

  it('跨午夜：start > end', () => {
    const q = { start: 23, end: 6 }
    expect(isHourInQuietRange(23, q)).toBe(true)
    expect(isHourInQuietRange(2, q)).toBe(true)
    expect(isHourInQuietRange(12, q)).toBe(false)
  })

  it('start === end 视为未设置', () => {
    expect(isHourInQuietRange(8, { start: 8, end: 8 })).toBe(false)
  })

  it('边界：含 start、不含 end', () => {
    const q = { start: 22, end: 7 }
    expect(isHourInQuietRange(22, q)).toBe(true)
    expect(isHourInQuietRange(7, q)).toBe(false)
  })
})

describe('resolveActiveSlots — 两种模式的真相来源', () => {
  it('interval 模式按间隔推导，忽略 enabledSlots', () => {
    const slots = resolveActiveSlots({
      mode: 'interval',
      enabledSlots: [8, 12, 18, 22],
      intervalHours: 3,
      intervalAnchorHour: 0,
      quietHours: null,
    })
    expect(slots).toEqual([0, 3, 6, 9, 12, 15, 18, 21])
  })

  it('slots 模式用用户手挑的整点', () => {
    const slots = resolveActiveSlots({
      mode: 'slots',
      enabledSlots: [9, 15, 21],
      intervalHours: 3,
      intervalAnchorHour: 0,
      quietHours: null,
    })
    expect(slots).toEqual([9, 15, 21])
  })

  it('slots 模式丢弃越界值（这是 v1.0 硬编码 bug 的修复点）', () => {
    const slots = resolveActiveSlots({
      mode: 'slots',
      enabledSlots: [8, 25, -3, 12, 99] as number[],
      intervalHours: 3,
      intervalAnchorHour: 0,
      quietHours: null,
    })
    expect(slots).toEqual([8, 12])
  })

  it('slots 模式去重并升序', () => {
    const slots = resolveActiveSlots({
      mode: 'slots',
      enabledSlots: [18, 8, 18, 12] as number[],
      intervalHours: 3,
      intervalAnchorHour: 0,
      quietHours: null,
    })
    expect(slots).toEqual([8, 12, 18])
  })
})

describe('sanitizeSlots', () => {
  it('去重 + 升序 + 丢弃越界', () => {
    expect(sanitizeSlots([3, 1, 3, 99, -2, 2])).toEqual([1, 2, 3])
  })

  it('非数组输入 → 空数组（不抛错）', () => {
    expect(sanitizeSlots(null)).toEqual([])
    expect(sanitizeSlots(undefined)).toEqual([])
    expect(sanitizeSlots('abc')).toEqual([])
  })
})

describe('normalizeCooldownHours — 防「时段永久失效」', () => {
  it('> 24 被夹到 24', () => {
    // 同一时段每天只回来一次，冷却 > 24h 会让该时段永远不再推送
    expect(normalizeCooldownHours(48)).toBe(24)
    expect(normalizeCooldownHours(999)).toBe(24)
  })

  it('负数 / 非法 → 0（不冷却）', () => {
    expect(normalizeCooldownHours(-1)).toBe(0)
    expect(normalizeCooldownHours(NaN)).toBe(0)
  })

  it('正常值原样保留', () => {
    expect(normalizeCooldownHours(23)).toBe(23)
    expect(normalizeCooldownHours(0)).toBe(0)
  })
})

describe('describeSlot — 时段文案', () => {
  it('保留 v1.0 的四个固定文案', () => {
    expect(describeSlot(8)).toContain('早间')
    expect(describeSlot(12)).toContain('午间')
    expect(describeSlot(18)).toContain('傍晚')
    expect(describeSlot(22)).toContain('晚间')
  })

  it('新增整点有可用文案（不再出现 undefined）', () => {
    for (let h = 0; h < 24; h++) {
      const label = describeSlot(h)
      expect(label).toBeTruthy()
      expect(label).not.toContain('undefined')
      expect(label).not.toContain('NaN')
    }
  })

  it('通用文案带具体时刻', () => {
    expect(describeSlot(3)).toContain('03:00')
  })
})
