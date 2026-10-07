// ============================================================
// tests/calendarTool.test.ts — 本地日历工具组
//
// 【这个文件在钉什么】
// 日历工具看起来只是"读写一个文本文件"，但真正会伤到用户的是格式层面的东西：
//   1. 用户标题里一个逗号/分号/换行就能让整个 VEVENT 解析失败 —— 一次误输入，
//      丢的是全部日程。所以转义必须往返无损。
//   2. 非原子写：写到一半断电 = 全量日程变坏文件。所以写入是 .tmp + rename。
//   3. RFC5545 的 75 **字节**折行：按字符数折会把汉字劈成半个，产出的 ICS 也是坏的。
//   4. 重复删除必须 ok:false，而不是抛异常把整轮 Agent 打断。
// ============================================================

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => tmp.dir },
}))

import {
  calendarAdd,
  calendarList,
  calendarRemove,
  calendarFree,
  calendarAddDef,
  calendarListDef,
  calendarRemoveDef,
  calendarFreeDef,
  escapeIcsText,
  unescapeIcsText,
  foldIcsLine,
  unfoldIcsLines,
  parseIcs,
  getCalendarFilePath,
} from '../electron/tools/impl/calendar'

/** 固定"现在" = 本地时间 2026-10-05 12:00。用 Date 构造函数而非 ISO 串，
 *  这样断言在任何时区下都成立。 */
const NOW = new Date(2026, 9, 5, 12, 0, 0)

beforeAll(() => {
  tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-cal-'))
})

beforeEach(() => {
  for (const suffix of ['', '.tmp']) {
    try { fs.rmSync(`${getCalendarFilePath()}${suffix}`, { force: true }) } catch { /* 文件本来就不在 */ }
  }
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

function rawIcs(): string {
  return fs.readFileSync(getCalendarFilePath(), 'utf-8')
}

function idOf(result: { ok: boolean; content: string; error?: string }): string {
  const m = /^id: (\S+)$/m.exec(result.content)
  expect(m, `add 返回里没有 id 行: ${result.content}`).not.toBeNull()
  return m![1]
}

async function addAt(title: string, start: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await calendarAdd({ title, start, ...extra })
  expect(r.ok, r.error).toBe(true)
  return idOf(r)
}

// ── ICS 转义 ────────────────────────────────────────────

describe('ICS 文本转义', () => {
  it('逗号/分号/反斜杠/换行全部转义且可往返', () => {
    const raw = '周会, 复盘; 预算\\成本\n第二行'
    const escaped = escapeIcsText(raw)
    // 每一个裸的 , ; \ 和换行都必须消失
    expect(escaped).toBe('周会\\, 复盘\\; 预算\\\\成本\\n第二行')
    expect(escaped.includes('\n')).toBe(false)
    expect(unescapeIcsText(escaped)).toBe(raw)
  })

  it('反斜杠必须先转，否则 \\n 会被二次转义', () => {
    // 原文里已经有一个字面的 "\n" 两个字符
    expect(unescapeIcsText(escapeIcsText('a\\nb'))).toBe('a\\nb')
  })

  it('带逗号/分号/换行的标题写进文件后仍能原样读回（不产生坏 ICS）', async () => {
    const title = '周会, 复盘; 预算\\成本\n第二行'
    const r = await calendarAdd({
      title,
      start: '2026-10-05T14:00:00',
      location: '3楼, A区;B',
      notes: '要点: a,b; c\\d',
    })
    expect(r.ok, r.error).toBe(true)

    const text = rawIcs()
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true)

    // SUMMARY 行上不能出现未转义的逗号/分号
    const summary = unfoldIcsLines(text).filter(l => l.startsWith('SUMMARY:'))
    expect(summary).toHaveLength(1)
    expect(summary[0]).toBe('SUMMARY:周会\\, 复盘\\; 预算\\\\成本\\n第二行')

    // 往返：写进去的 title / location / notes 一字不差
    const events = parseIcs(text)
    expect(events).toHaveLength(1)
    expect(events[0].summary).toBe(title)
    expect(events[0].location).toBe('3楼, A区;B')
    expect(events[0].description).toBe('要点: a,b; c\\d')
  })

  it('转义失败会毁掉结构 —— 所以反例钉住：裸逗号确实是非法的', () => {
    // 说明为什么必须转义：未转义的逗号会在属性值里制造第二个伪属性
    const broken = 'SUMMARY:周会, 复盘'
    expect(splitHead(broken)).toBe('SUMMARY')
    expect(broken.slice('SUMMARY:'.length)).toContain(',')
    // 转义后就不再是分隔符
    expect(splitHead('SUMMARY:周会\\, 复盘').slice('SUMMARY:'.length)).not.toContain(',')
  })
})

/** 复刻 ICS 的 NAME;PARAM:VALUE 切分，只为在测试里表达"逗号是分隔符"这件事 */
function splitHead(line: string): string {
  const idx = line.indexOf(':')
  return line.slice(0, idx).split(';')[0]
}

// ── ICS 行折叠 ──────────────────────────────────────────

describe('ICS 行折叠', () => {
  it('超过 75 字节的行被折开，续行以单空格开头，每行 ≤ 75 字节', () => {
    const long = `SUMMARY:${'长'.repeat(60)}`
    expect(Buffer.byteLength(long, 'utf-8')).toBeGreaterThan(75)

    const folded = foldIcsLine(long)
    const parts = folded.split('\r\n')
    expect(parts.length).toBeGreaterThan(1)
    for (let i = 0; i < parts.length; i++) {
      expect(Buffer.byteLength(parts[i], 'utf-8')).toBeLessThanOrEqual(75)
      if (i > 0) {expect(parts[i].startsWith(' ')).toBe(true)}
    }
  })

  it('折行不劈开多字节汉字，unfold 后与原文逐字节相同', () => {
    for (const ch of ['长', '，', '😀']) {
      const long = `DESCRIPTION:${ch.repeat(40)}`
      const folded = foldIcsLine(long)
      for (const part of folded.split('\r\n')) {
        // 半个 UTF-8 字符会被 replacement char 污染
        expect(part).not.toContain('\uFFFD')
      }
      expect(unfoldIcsLines(`${folded}\r\n`)).toEqual([long])
    }
  })

  it('短行不折', () => {
    expect(foldIcsLine('SUMMARY:周会')).toBe('SUMMARY:周会')
  })

  it('unfold 能吃 CRLF / LF 混合输入', () => {
    expect(unfoldIcsLines('A:1\r\n B\r\nC:2\n')).toEqual(['A:1B', 'C:2'])
  })

  it('超长标题落盘后仍能读回（折行 → 读时展开）', async () => {
    const title = `很长的会议标题${'甲乙丙丁戊己庚辛'.repeat(12)}`
    expect(Buffer.byteLength(title, 'utf-8')).toBeGreaterThan(75)
    await addAt(title, '2026-10-05T14:00:00')
    expect(foldIcsLine(`SUMMARY:${escapeIcsText(title)}`).includes('\r\n')).toBe(true)
    const list = await calendarList({ days: 1 })
    expect(list.ok, list.error).toBe(true)
    expect(parseIcs(rawIcs())[0].summary).toBe(title)
  })
})

// ── 增删查往返 ──────────────────────────────────────────

describe('add → list → remove 往返', () => {
  it('新增后能被列出，删除后查不到', async () => {
    const id = await addAt('项目周会', '2026-10-05T14:00:00', { location: '3楼会议室', notes: '带材料' })

    const afterAdd = await calendarList({ days: 1 })
    expect(afterAdd.ok, afterAdd.error).toBe(true)
    expect(afterAdd.content).toContain('项目周会')
    expect(afterAdd.content).toContain(id)
    expect(afterAdd.content).toContain('3楼会议室')

    const removed = await calendarRemove({ id })
    expect(removed.ok, removed.error).toBe(true)

    const afterRemove = await calendarList({ days: 1 })
    expect(afterRemove.ok).toBe(true)
    expect(afterRemove.content).not.toContain('项目周会')
    expect(parseIcs(rawIcs())).toHaveLength(0)
  })

  it('删除只影响目标那一条，其他日程原样保留', async () => {
    const a = await addAt('A 会议', '2026-10-05T09:00:00')
    await addAt('B 会议', '2026-10-05T15:00:00')
    expect((await calendarRemove({ id: a })).ok).toBe(true)
    const events = parseIcs(rawIcs())
    expect(events).toHaveLength(1)
    expect(events[0].summary).toBe('B 会议')
  })

  it('原子写入：成功后不留 .tmp 残留', async () => {
    await addAt('X', '2026-10-05T10:00:00')
    expect(fs.existsSync(`${getCalendarFilePath()}.tmp`)).toBe(false)
    expect(fs.existsSync(getCalendarFilePath())).toBe(true)
  })

  it('连续多次新增，文件始终可解析（不会因为追加而损坏）', async () => {
    for (let i = 0; i < 12; i++) {
      await addAt(`日程 ${i}, 带逗号`, `2026-10-05T${String(8 + i).padStart(2, '0')}:00:00`)
    }
    const events = parseIcs(rawIcs())
    expect(events).toHaveLength(12)
    expect(events[3].summary).toBe('日程 3, 带逗号')
  })

  it('落盘位置在 userData 下，不会写进 Git 工作区', () => {
    expect(getCalendarFilePath()).toBe(path.join(tmp.dir, 'lumina-calendar.ics'))
    expect(path.isAbsolute(getCalendarFilePath())).toBe(true)
  })
})

// ── 跨天边界 ────────────────────────────────────────────

describe('跨天查询边界', () => {
  it('days 窗口右端不含下一天 00:00 之后开始的日程', async () => {
    // 本地 10-05 23:30 —— 属于今天
    const late = await addAt('今天深夜', '2026-10-05T23:30:00')
    // 本地 10-06 00:30 —— 属于明天
    const early = await addAt('明天凌晨', '2026-10-06T00:30:00')
    // 本地 10-04 23:00 ~ 23:30 —— 完全落在昨天
    const yesterday = await addAt('昨天深夜', '2026-10-04T23:00:00', { durationMinutes: 30 })

    const one = await calendarList({ days: 1 })
    expect(one.ok, one.error).toBe(true)
    expect(one.content).toContain(late)
    expect(one.content).not.toContain(early)
    expect(one.content).not.toContain(yesterday)

    const two = await calendarList({ days: 2 })
    expect(two.content).toContain(late)
    expect(two.content).toContain(early)
    expect(two.content).not.toContain(yesterday)
  })

  it('跨 00:00 的长日程在两天里都能查到', async () => {
    const id = await addAt('通宵部署', '2026-10-05T22:00:00', { durationMinutes: 240 })
    const one = await calendarList({ days: 1 })
    expect(one.content).toContain(id)
    const two = await calendarList({ days: 2 })
    expect(two.content).toContain(id)
  })

  it('昨天开始、今天凌晨才结束的日程，今天依然要出现', async () => {
    // 边界最容易写错的地方：窗口按「开始时间」过滤会漏掉仍在进行的会议
    const id = await addAt('跨夜值班', '2026-10-04T23:00:00', { durationMinutes: 180 })
    const today = await calendarList({ days: 1 })
    expect(today.ok, today.error).toBe(true)
    expect(today.content).toContain(id)
  })

  it('days=0 / days=91 被拒（而不是悄悄夹到边界）', async () => {
    const tooSmall = await calendarList({ days: 0 })
    expect(tooSmall.ok).toBe(false)
    expect(tooSmall.error).toContain('1-90')

    const tooBig = await calendarList({ days: 91 })
    expect(tooBig.ok).toBe(false)
    expect(tooBig.error).toContain('1-90')

    const okEdge = await calendarList({ days: 90 })
    expect(okEdge.ok).toBe(true)
  })

  it('query 过滤只留命中的日程', async () => {
    await addAt('牙医预约', '2026-10-05T11:00:00')
    await addAt('项目评审', '2026-10-05T16:00:00', { notes: '顺便提一下牙医' })
    const hit = await calendarList({ days: 7, query: '牙医' })
    expect(hit.ok, hit.error).toBe(true)
    expect(hit.content).toContain('牙医预约')
    expect(hit.content).toContain('项目评审')

    const miss = await calendarList({ days: 7, query: '不存在的关键词' })
    expect(miss.ok).toBe(true)
    expect(miss.content).not.toContain('牙医预约')
  })
})

// ── 重复日程 ────────────────────────────────────────────

describe('重复日程', () => {
  it('weekly 在 7 天后再次出现', async () => {
    await addAt('周会', '2026-10-05T10:00:00', { recurrence: 'weekly' })
    const seven = await calendarList({ days: 7 })
    const eight = await calendarList({ days: 8 })
    // 10-05 + 7 = 10-12，在 days=8 窗口内
    expect(eight.content).toContain('10-12 10:00-11:00  周会')
    expect(seven.ok).toBe(true)
  })

  it('daily 在窗口内每天出现一次', async () => {
    await addAt('晨会', '2026-10-05T09:00:00', { recurrence: 'daily', durationMinutes: 15 })
    const three = await calendarList({ days: 3 })
    expect(three.ok, three.error).toBe(true)
    expect(three.content).toContain('10-05 09:00-09:15  晨会')
    expect(three.content).toContain('10-06 09:00-09:15  晨会')
    expect(three.content).toContain('10-07 09:00-09:15  晨会')
  })

  it('非法 recurrence 被拒，不静默当成 none', async () => {
    const r = await calendarAdd({ title: 'X', start: '2026-10-05T10:00:00', recurrence: 'yearly' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('none / daily / weekly / monthly')
  })

  it('RRULE 真的写进了 ICS', async () => {
    await addAt('月报', '2026-10-05T10:00:00', { recurrence: 'monthly' })
    expect(unfoldIcsLines(rawIcs())).toContain('RRULE:FREQ=MONTHLY')
  })
})

// ── 删除的诚实错误 ──────────────────────────────────────

describe('删除的错误处理', () => {
  it('重复删除同一个 id 返回 ok:false，不抛异常', async () => {
    const id = await addAt('一次性日程', '2026-10-05T10:00:00')
    expect((await calendarRemove({ id })).ok).toBe(true)

    const again = await calendarRemove({ id })
    expect(again.ok).toBe(false)
    expect(again.error).toContain('找不到')
    expect(again.content).toBe('')
    // 关键：文件没被二次写坏
    expect(parseIcs(rawIcs())).toHaveLength(0)
  })

  it('删除不存在的 id 同样返回 ok:false', async () => {
    const r = await calendarRemove({ id: 'lumina-根本不存在' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('找不到')
  })

  it('缺少 id 参数 → ok:false', async () => {
    const r = await calendarRemove({})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('id')
  })

  it('日历文件为空时删除不会崩', async () => {
    const r = await calendarRemove({ id: 'lumina-anything' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('找不到')
  })
})

// ── 参数校验 ────────────────────────────────────────────

describe('参数校验', () => {
  it('calendar_add 缺 title / start 被拒', async () => {
    const noTitle = await calendarAdd({ start: '2026-10-05T10:00:00' })
    expect(noTitle.ok).toBe(false)
    expect(noTitle.error).toContain('title')

    const noStart = await calendarAdd({ title: 'X' })
    expect(noStart.ok).toBe(false)
    expect(noStart.error).toContain('start')
  })

  it('start 不是合法 ISO 时间 → ok:false 且不写文件', async () => {
    const r = await calendarAdd({ title: 'X', start: '明天下午三点' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ISO 8601')
    expect(fs.existsSync(getCalendarFilePath())).toBe(false)
  })

  it('durationMinutes 越界被拒', async () => {
    const zero = await calendarAdd({ title: 'X', start: '2026-10-05T10:00:00', durationMinutes: 0 })
    expect(zero.ok).toBe(false)
    const huge = await calendarAdd({ title: 'X', start: '2026-10-05T10:00:00', durationMinutes: 999999 })
    expect(huge.ok).toBe(false)
  })

  it('durationMinutes 默认 60', async () => {
    await addAt('默认时长', '2026-10-05T10:00:00')
    const list = await calendarList({ days: 1 })
    expect(list.content).toContain('10-05 10:00-11:00  默认时长')
  })

  it('带时区偏移的 start 也能解析（换算后落库为 UTC）', async () => {
    await addAt('东京会议', '2026-10-05T14:00:00+09:00')
    const events = parseIcs(rawIcs())
    expect(events).toHaveLength(1)
    expect(events[0].start.toISOString()).toBe('2026-10-05T05:00:00.000Z')
    expect(unfoldIcsLines(rawIcs())).toContain('DTSTART:20261005T050000Z')
  })
})

// ── 空闲时段 ────────────────────────────────────────────

describe('calendar_free', () => {
  it('默认 9-18，中间一段会议被切出两个空档', async () => {
    await addAt('项目周会', '2026-10-05T10:00:00', { durationMinutes: 60 })
    const r = await calendarFree({ date: '2026-10-05' })
    expect(r.ok, r.error).toBe(true)
    expect(r.content).toContain('09:00-10:00')
    expect(r.content).toContain('11:00-18:00')
    expect(r.content).toContain('项目周会')
  })

  it('一整天没安排 → 整天空闲', async () => {
    const r = await calendarFree({ date: '2026-10-05' })
    expect(r.ok, r.error).toBe(true)
    expect(r.content).toContain('09:00-18:00')
    expect(r.content).toContain('9 小时')
  })

  it('重叠的日程被合并，不产生负数空档', async () => {
    await addAt('A', '2026-10-05T10:00:00', { durationMinutes: 120 })
    await addAt('B', '2026-10-05T10:30:00', { durationMinutes: 60 })
    const r = await calendarFree({ date: '2026-10-05' })
    expect(r.ok, r.error).toBe(true)
    expect(r.content).toContain('09:00-10:00')
    expect(r.content).toContain('12:00-18:00')
  })

  it('工作时间外的日程不占用工作时段', async () => {
    await addAt('深夜加班', '2026-10-05T23:00:00', { durationMinutes: 60 })
    const r = await calendarFree({ date: '2026-10-05' })
    expect(r.ok, r.error).toBe(true)
    expect(r.content).toContain('09:00-18:00')
  })

  it('支持自定义工作时段', async () => {
    await addAt('午休外出', '2026-10-05T12:00:00', { durationMinutes: 60 })
    const r = await calendarFree({ date: '2026-10-05', workdayStart: 8, workdayEnd: 20 })
    expect(r.ok, r.error).toBe(true)
    expect(r.content).toContain('08:00-12:00')
    expect(r.content).toContain('13:00-20:00')
  })

  it('date 非法 / 缺失 / 工作时段倒置都返回 ok:false', async () => {
    const missing = await calendarFree({})
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('date')

    const badFormat = await calendarFree({ date: '2026/10/05' })
    expect(badFormat.ok).toBe(false)
    expect(badFormat.error).toContain('YYYY-MM-DD')

    const notADay = await calendarFree({ date: '2026-02-30' })
    expect(notADay.ok).toBe(false)
    expect(notADay.error).toContain('真实存在的日期')

    const inverted = await calendarFree({ date: '2026-10-05', workdayStart: 18, workdayEnd: 9 })
    expect(inverted.ok).toBe(false)
    expect(inverted.error).toContain('工作时间')
  })

  it('重复日程的实例也占用对应日期的空档', async () => {
    await addAt('每日站会', '2026-10-05T10:00:00', { recurrence: 'daily', durationMinutes: 30 })
    const d5 = await calendarFree({ date: '2026-10-05' })
    const d6 = await calendarFree({ date: '2026-10-06' })
    expect(d5.ok, d5.error).toBe(true)
    expect(d6.ok, d6.error).toBe(true)
    expect(d5.content).toContain('每日站会')
    expect(d6.content).toContain('每日站会')
    expect(d5.content).not.toBe(d6.content)
  })
})

// ── 工具定义 ────────────────────────────────────────────

describe('ToolDef 元数据', () => {
  it('四个工具都声明了 productivity 能力层', () => {
    // ⚠️ 不要再改成 ['agent','chat']：agent/chat/developer 属 MODE_TOOLSETS
    // （静态表独占），工具自己声明进不去，只写这两个会让工具变成
    // 「注册了但模型永远看不到」的孤儿 —— tests/delegationSafety.test.ts 有守卫。
    // 正确做法是挂在能力层，并把它接进 agent 模式的 includes。
    for (const def of [calendarListDef, calendarAddDef, calendarRemoveDef, calendarFreeDef]) {
      expect(def.toolsets).toEqual(['productivity'])
    }
  })

  it('工具名唯一且为 snake_case', () => {
    const names = [calendarListDef, calendarAddDef, calendarRemoveDef, calendarFreeDef].map(d => d.name)
    expect(new Set(names).size).toBe(4)
    for (const n of names) {expect(n).toMatch(/^[a-z_]+$/) }
  })

  it('必填参数在 schema 里标了 required', () => {
    expect(calendarAddDef.params?.title.required).toBe(true)
    expect(calendarAddDef.params?.start.required).toBe(true)
    expect(calendarRemoveDef.params?.id.required).toBe(true)
    expect(calendarFreeDef.params?.date.required).toBe(true)
    expect(calendarAddDef.params?.recurrence.enum).toEqual(['none', 'daily', 'weekly', 'monthly'])
  })
})
