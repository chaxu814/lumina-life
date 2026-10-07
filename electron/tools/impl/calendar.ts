// ============================================================
// impl/calendar.ts — 本地日历工具组 v1.0
//
// 【为什么不读 Windows 系统日历】
// Windows 没有一个可以安全调用的系统日历 API：Outlook COM 要求装 Outlook 且常驻，
// win32 窗口遍历只能拿到 UI 文本，改写更是要注入 COM —— 副作用不可控，还会静默
// 破坏用户真实日程。所以这里走**本地优先**：一个单文件 ICS 落在 userData 下，
// 用户想进 Outlook / Google 日历 / 系统日历应用时，自己导入这个文件即可。
//
// 【四个坑，钉在注释里防止重犯】
//   1. 存储路径绝不能退回 process.cwd()：开发态 cwd == 项目根，会把用户日程写进
//      Git 工作区（与 mailStore.getStorePath() 同款约束）。
//   2. 写入必须原子：先写 .tmp 再 rename。直接覆盖写到一半断电，整个日历文件
//      就是一个坏 ICS，用户的全部日程一起没了。
//   3. 用户输入（title / location / notes）写进 ICS 前必须转义 , ; \ 和换行。
//      一个带逗号的标题就能让 VEVENT 解析失败。
//   4. RFC5545 规定内容行不超过 75 **字节**（UTF-8 字节数，不是字符数），
//      超长要折行、续行以单个空格开头。中文标题极容易超。
// ============================================================

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { stateFilePath } from '../../core/pathsFallback'
import type { ToolDef, ToolResult } from '../types'

const ICS_FILE_NAME = 'lumina-calendar.ics'
const CRLF = '\r\n'
/** RFC5545 §3.1：内容行上限 75 字节（不含行结束符） */
const MAX_LINE_OCTETS = 75
const DEFAULT_DAYS = 7
const MAX_DAYS = 90
const DEFAULT_DURATION_MINUTES = 60
const MAX_DURATION_MINUTES = 60 * 24 * 7
const DEFAULT_WORKDAY_START = 9
const DEFAULT_WORKDAY_END = 18
/** 90 天窗口内 daily 重复最多 90 条；2000 既是安全网也顺手挡掉了死循环 */
const MAX_OCCURRENCES = 2000
/** 月度重复向前跳步的上限（2400 步 = 200 年，够用且有界） */
const MAX_MONTH_STEPS = 2400
/** 单次 list 最多回显多少条，剩下的折叠成一句提示 */
const MAX_LIST_ITEMS = 50
const DAY_MS = 86_400_000

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly'

const RECURRENCE_LABEL: Record<Recurrence, string> = {
  none: '不重复',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
}

export interface CalendarEvent {
  uid: string
  summary: string
  start: Date
  end: Date
  location?: string
  description?: string
  recurrence: Recurrence
}

// ── 存储路径 ────────────────────────────────────────────

/**
 * 日历文件位置。优先 userData；app 不可用（vitest / 模块层初始化早于 Electron）时
 * 退到系统临时目录 —— 见 pathsFallback.ts 的统一出口。
 */
export function getCalendarFilePath(): string {
  try {
    const userData = app.getPath('userData')
    return path.join(userData, ICS_FILE_NAME)
  } catch {
    // ⚠️ 不要退回 process.cwd()：开发态 cwd 就是项目根，会把状态写进 Git 工作区
    return stateFilePath(ICS_FILE_NAME)
  }
}

// ── ICS 文本转义 / 折行 ──────────────────────────────────

/** RFC5545 §3.3.11 TEXT 转义。顺序不能反：反斜杠必须第一个转，否则 \\n 会被二次转义。 */
export function escapeIcsText(raw: string): string {
  return raw
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n')
}

export function unescapeIcsText(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i)
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw.charAt(i + 1)
      if (next === 'n' || next === 'N') { out += '\n'; i++; continue }
      if (next === '\\' || next === ';' || next === ',') { out += next; i++; continue }
    }
    out += ch
  }
  return out
}

/**
 * 折行：每行 ≤ 75 **字节**，续行以单个空格开头（这个空格占掉 1 字节预算）。
 * 按码点推进而不是按 charAt —— 否则会把多字节汉字劈成半个，产出的 ICS 直接是坏的。
 */
export function foldIcsLine(line: string): string {
  if (Buffer.byteLength(line, 'utf-8') <= MAX_LINE_OCTETS) {return line}
  const parts: string[] = []
  let cur = ''
  for (const ch of Array.from(line)) {
    const limit = parts.length === 0 ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1
    if (Buffer.byteLength(cur + ch, 'utf-8') > limit) {
      parts.push(cur)
      cur = ch
    } else {
      cur += ch
    }
  }
  if (cur) {parts.push(cur)}
  return parts.join(`${CRLF} `)
}

/** 折行的逆操作：把以单空格开头的续行接回上一行。 */
export function unfoldIcsLines(text: string): string[] {
  const raw = text.split(/\r\n|\n|\r/)
  const out: string[] = []
  for (const line of raw) {
    if (out.length > 0 && line.startsWith(' ')) {
      out[out.length - 1] += line.slice(1)
    } else {
      out.push(line)
    }
  }
  return out.filter(l => l.length > 0)
}

// ── ICS 序列化 / 反序列化 ────────────────────────────────

function toIcsDate(d: Date): string {
  // 2026-10-05T02:00:00.000Z → 20261005T020000Z
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function parseIcsDate(raw: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(raw.trim())
  if (!m) {return null}
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || 'Z'}`)
  return Number.isNaN(d.getTime()) ? null : d
}

export function serializeIcs(events: CalendarEvent[]): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lumina AI//Lumina Calendar 1.0//CN',
    'CALSCALE:GREGORIAN',
  ]
  for (const ev of events) {
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${ev.uid}`)
    lines.push(`DTSTAMP:${toIcsDate(new Date())}`)
    lines.push(`DTSTART:${toIcsDate(ev.start)}`)
    lines.push(`DTEND:${toIcsDate(ev.end)}`)
    lines.push(`SUMMARY:${escapeIcsText(ev.summary)}`)
    if (ev.location) {lines.push(`LOCATION:${escapeIcsText(ev.location)}`)}
    if (ev.description) {lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`)}
    if (ev.recurrence !== 'none') {lines.push(`RRULE:FREQ=${ev.recurrence.toUpperCase()}`)}
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldIcsLine).join(CRLF) + CRLF
}

function splitProperty(line: string): { name: string; value: string } | null {
  const idx = line.indexOf(':')
  if (idx <= 0) {return null}
  const name = line.slice(0, idx).split(';')[0].toUpperCase()
  if (!name) {return null}
  return { name, value: line.slice(idx + 1) }
}

function eventFromProps(props: Map<string, string>): CalendarEvent | null {
  const uid = props.get('UID')
  const startRaw = props.get('DTSTART')
  if (!uid || !startRaw) {return null}
  const start = parseIcsDate(startRaw)
  if (!start) {return null}
  const endRaw = props.get('DTEND')
  const end = (endRaw ? parseIcsDate(endRaw) : null) || new Date(start.getTime() + 3_600_000)
  const rrule = (props.get('RRULE') || '').toUpperCase()
  let recurrence: Recurrence = 'none'
  if (rrule.includes('FREQ=DAILY')) {recurrence = 'daily'}
  else if (rrule.includes('FREQ=WEEKLY')) {recurrence = 'weekly'}
  else if (rrule.includes('FREQ=MONTHLY')) {recurrence = 'monthly'}
  const location = props.get('LOCATION')
  const description = props.get('DESCRIPTION')
  const summary = props.get('SUMMARY')
  return {
    uid,
    summary: summary === undefined ? '(无标题)' : unescapeIcsText(summary),
    start,
    end,
    location: location ? unescapeIcsText(location) : undefined,
    description: description ? unescapeIcsText(description) : undefined,
    recurrence,
  }
}

export function parseIcs(text: string): CalendarEvent[] {
  const events: CalendarEvent[] = []
  let current: Map<string, string> | null = null
  for (const line of unfoldIcsLines(text)) {
    if (line === 'BEGIN:VEVENT') { current = new Map(); continue }
    if (line === 'END:VEVENT') {
      if (current) {
        const ev = eventFromProps(current)
        if (ev) {events.push(ev)}
      }
      current = null
      continue
    }
    if (!current) {continue}
    const prop = splitProperty(line)
    if (prop && !current.has(prop.name)) {current.set(prop.name, prop.value)}
  }
  return events
}

// ── 读 / 写 ─────────────────────────────────────────────

function readEvents(): CalendarEvent[] {
  const file = getCalendarFilePath()
  if (!fs.existsSync(file)) {return []}
  return parseIcs(fs.readFileSync(file, 'utf-8'))
}

/** 原子写：先写 .tmp 再 rename。中途断电/崩溃时旧文件完好无损。 */
function writeEvents(events: CalendarEvent[]): void {
  const file = getCalendarFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, serializeIcs(events), 'utf-8')
  fs.renameSync(tmp, file)
}

// ── 重复日程展开 ────────────────────────────────────────

function addMonths(d: Date, n: number): Date {
  const next = new Date(d.getTime())
  const day = next.getUTCDate()
  next.setUTCDate(1)
  next.setUTCMonth(next.getUTCMonth() + n)
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()
  next.setUTCDate(Math.min(day, lastDay))
  return next
}

/** 把一条 VEVENT 展开成 [windowStart, windowEnd] 内的所有实例。 */
function expandOccurrences(ev: CalendarEvent, windowStart: Date, windowEnd: Date): CalendarEvent[] {
  const duration = Math.max(0, ev.end.getTime() - ev.start.getTime())
  const out: CalendarEvent[] = []
  const emit = (start: Date): void => {
    const end = new Date(start.getTime() + duration)
    if (end.getTime() > windowStart.getTime() && start.getTime() <= windowEnd.getTime()) {
      out.push({ ...ev, start, end })
    }
  }

  if (ev.recurrence === 'none') {
    emit(new Date(ev.start.getTime()))
    return out
  }

  // 先跳到窗口附近。一个三年前的 daily 日程要一天一天迭代几千次，没人等得起。
  let cursor = new Date(ev.start.getTime())
  if (ev.recurrence === 'monthly') {
    let steps = 0
    while (cursor.getTime() + duration <= windowStart.getTime() && steps < MAX_MONTH_STEPS) {
      cursor = addMonths(cursor, 1)
      steps++
    }
  } else {
    const stepMs = ev.recurrence === 'daily' ? DAY_MS : 7 * DAY_MS
    if (cursor.getTime() + duration <= windowStart.getTime()) {
      const jump = Math.ceil((windowStart.getTime() - (cursor.getTime() + duration)) / stepMs)
      cursor = new Date(cursor.getTime() + jump * stepMs)
    }
  }

  for (let i = 0; i < MAX_OCCURRENCES && cursor.getTime() <= windowEnd.getTime(); i++) {
    emit(cursor)
    if (ev.recurrence === 'daily') {
      cursor = new Date(cursor.getTime() + DAY_MS)
    } else if (ev.recurrence === 'weekly') {
      cursor = new Date(cursor.getTime() + 7 * DAY_MS)
    } else {
      cursor = addMonths(cursor, 1)
    }
  }
  return out
}

// ── 时间格式化 ──────────────────────────────────────────

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function hm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function fmtDateTime(d: Date): string {
  return `${ymd(d)} ${hm(d)}`
}

function formatDurationMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) {return `${m} 分钟`}
  if (m === 0) {return `${h} 小时`}
  return `${h} 小时 ${m} 分钟`
}

/** 「今天起 days 天（含今天）」的本地时间窗口。 */
function windowForDays(days: number, now: Date): { from: Date; to: Date } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (days - 1), 23, 59, 59, 999)
  return { from, to }
}

// ── 参数读取（不使用裸 any，unknown 逐个收窄）────────────

function readString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v.trim() : ''
}

function readNumber(args: Record<string, unknown>, key: string): number | null {
  const v = args[key]
  if (v === undefined || v === null || v === '') {return null}
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function parseRecurrence(v: unknown): Recurrence | null {
  if (v === undefined || v === null || v === '') {return 'none'}
  const s = String(v).trim().toLowerCase()
  if (s === 'none' || s === 'daily' || s === 'weekly' || s === 'monthly') {return s}
  return null
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fail(error: string): ToolResult {
  return { callId: '', ok: false, content: '', error }
}

function matchesQuery(ev: CalendarEvent, query: string): boolean {
  const haystack = `${ev.summary}\n${ev.location || ''}\n${ev.description || ''}`.toLowerCase()
  return haystack.includes(query)
}

function describeOccurrence(ev: CalendarEvent, index: number): string {
  const sameDay = ymd(ev.start) === ymd(ev.end)
  const when = sameDay
    ? `${ymd(ev.start)} ${hm(ev.start)}-${hm(ev.end)}`
    : `${fmtDateTime(ev.start)} ~ ${fmtDateTime(ev.end)}`
  const lines = [`${index}. ${when}  ${ev.summary}`, `   id: ${ev.uid}`]
  if (ev.location) {lines.push(`   📍 ${ev.location}`)}
  if (ev.description) {lines.push(`   📝 ${ev.description.replace(/\n/g, ' / ')}`)}
  if (ev.recurrence !== 'none') {lines.push(`   🔁 ${RECURRENCE_LABEL[ev.recurrence]}`)}
  return lines.join('\n')
}

// ── 工具 1: calendar_list ───────────────────────────────

export const calendarListDef: ToolDef = {
  name: 'calendar_list',
  description: `列出本地日历里从今天起未来若干天的日程（含今天）。日程存在用户数据目录的
lumina-calendar.ics 里，可导入 Outlook / Google 日历。

参数:
- days: 未来天数（含今天，1-90，默认 7）
- query: 可选关键词，对标题/地点/备注做不区分大小写的包含匹配`,
  params: {
    days: { type: 'number', description: '未来天数（含今天，1-90，默认 7）', required: false, default: DEFAULT_DAYS },
    query: { type: 'string', description: '关键词，过滤标题/地点/备注（不区分大小写）', required: false },
  },
  toolsets: ['productivity'],
}

export async function calendarList(args: Record<string, unknown>): Promise<ToolResult> {
  const rawDays = readNumber(args, 'days')
  const days = rawDays === null ? DEFAULT_DAYS : Math.round(rawDays)
  if (days < 1 || days > MAX_DAYS) {
    return fail(`days 必须在 1-${MAX_DAYS} 之间，收到: ${rawDays}`)
  }
  const query = readString(args, 'query').toLowerCase()

  try {
    const { from, to } = windowForDays(days, new Date())
    const expanded = readEvents()
      .flatMap(ev => expandOccurrences(ev, from, to))
      .sort((a, b) => a.start.getTime() - b.start.getTime())
    const hits = query ? expanded.filter(ev => matchesQuery(ev, query)) : expanded

    const head = query
      ? `📅 ${ymd(from)} ~ ${ymd(to)}，关键词「${query}」命中 ${hits.length} 个日程`
      : `📅 ${ymd(from)} ~ ${ymd(to)} 共 ${hits.length} 个日程`
    if (hits.length === 0) {
      const hint = readEvents().length === 0
        ? '日历还是空的，用 calendar_add 添加一条吧。'
        : '这个时间段没有日程。'
      return { callId: '', ok: true, content: `${head}\n\n${hint}` }
    }

    const shown = hits.slice(0, MAX_LIST_ITEMS).map((ev, i) => describeOccurrence(ev, i + 1))
    const rest = hits.length - shown.length
    const tail = rest > 0 ? `\n\n… 还有 ${rest} 条，可用 query 或缩短 days 进一步筛选。` : ''
    return { callId: '', ok: true, content: `${head}\n\n${shown.join('\n')}${tail}` }
  } catch (err) {
    return fail(`读取日历文件失败: ${messageOf(err)}`)
  }
}

// ── 工具 2: calendar_add ────────────────────────────────

export const calendarAddDef: ToolDef = {
  name: 'calendar_add',
  description: `往本地日历添加一条日程（写入 lumina-calendar.ics，不改动 Windows 系统日历）。

参数:
- title: 标题（必填）
- start: 开始时间，ISO 8601（必填），如 "2026-10-05T14:00:00"（本地时区）或 "2026-10-05T14:00:00+08:00"
- durationMinutes: 时长分钟数（默认 60）
- location: 地点（可选）
- notes: 备注（可选）
- recurrence: 重复规则，none / daily / weekly / monthly（默认 none）`,
  params: {
    title: { type: 'string', description: '日程标题', required: true },
    start: { type: 'string', description: '开始时间（ISO 8601）', required: true },
    durationMinutes: { type: 'number', description: `时长分钟数（1-${MAX_DURATION_MINUTES}，默认 ${DEFAULT_DURATION_MINUTES}）`, required: false, default: DEFAULT_DURATION_MINUTES },
    location: { type: 'string', description: '地点', required: false },
    notes: { type: 'string', description: '备注', required: false },
    recurrence: { type: 'string', description: '重复规则', enum: ['none', 'daily', 'weekly', 'monthly'], required: false, default: 'none' },
  },
  toolsets: ['productivity'],
}

export async function calendarAdd(args: Record<string, unknown>): Promise<ToolResult> {
  const title = readString(args, 'title')
  if (!title) {return fail('需要提供 title 参数（日程标题）')}

  const startRaw = readString(args, 'start')
  if (!startRaw) {return fail('需要提供 start 参数（ISO 8601 时间，如 "2026-10-05T14:00:00"）')}
  const start = new Date(startRaw)
  if (Number.isNaN(start.getTime())) {return fail(`start 不是合法的 ISO 8601 时间: ${startRaw}`)}

  const rawDuration = readNumber(args, 'durationMinutes')
  if (rawDuration !== null && (rawDuration <= 0 || rawDuration > MAX_DURATION_MINUTES)) {
    return fail(`durationMinutes 必须在 1-${MAX_DURATION_MINUTES} 之间，收到: ${rawDuration}`)
  }
  const durationMinutes = rawDuration === null ? DEFAULT_DURATION_MINUTES : Math.round(rawDuration)

  const recurrence = parseRecurrence(args.recurrence)
  if (recurrence === null) {return fail('recurrence 只能是 none / daily / weekly / monthly')}

  const location = readString(args, 'location')
  const notes = readString(args, 'notes')

  try {
    const events = readEvents()
    const ev: CalendarEvent = {
      uid: `lumina-${randomUUID()}`,
      summary: title,
      start,
      end: new Date(start.getTime() + durationMinutes * 60_000),
      location: location || undefined,
      description: notes || undefined,
      recurrence,
    }
    events.push(ev)
    writeEvents(events)
    const lines = [
      '✅ 已添加日程',
      `· ${fmtDateTime(ev.start)} ~ ${hm(ev.end)}  ${ev.summary}`,
      `· 重复: ${RECURRENCE_LABEL[ev.recurrence]}`,
    ]
    if (ev.location) {lines.push(`· 地点: ${ev.location}`)}
    if (ev.description) {lines.push(`· 备注: ${ev.description.replace(/\n/g, ' / ')}`)}
    lines.push(`id: ${ev.uid}`)
    return { callId: '', ok: true, content: lines.join('\n') }
  } catch (err) {
    return fail(`写入日历文件失败: ${messageOf(err)}`)
  }
}

// ── 工具 3: calendar_remove ─────────────────────────────

export const calendarRemoveDef: ToolDef = {
  name: 'calendar_remove',
  description: `按 id 从本地日历删除一条日程。id 来自 calendar_list / calendar_add 的返回。

参数:
- id: 日程 id（必填）`,
  params: {
    id: { type: 'string', description: '日程 id（calendar_list 返回的 id）', required: true },
  },
  toolsets: ['productivity'],
}

export async function calendarRemove(args: Record<string, unknown>): Promise<ToolResult> {
  const id = readString(args, 'id')
  if (!id) {return fail('需要提供 id 参数（日程 id）')}

  try {
    const events = readEvents()
    const idx = events.findIndex(ev => ev.uid === id)
    if (idx === -1) {
      return fail(`找不到 id 为 ${id} 的日程（可能已经被删除，或 id 属于重复日程的某个实例）`)
    }
    const removed = events[idx]
    events.splice(idx, 1)
    writeEvents(events)
    return {
      callId: '',
      ok: true,
      content: `🗑️ 已删除日程「${removed.summary}」(${fmtDateTime(removed.start)})`,
    }
  } catch (err) {
    return fail(`写入日历文件失败: ${messageOf(err)}`)
  }
}

// ── 工具 4: calendar_free ───────────────────────────────

export const calendarFreeDef: ToolDef = {
  name: 'calendar_free',
  description: `查询某一天工作时间段内的空闲时段，用于"我什么时候有空"这类排期。

参数:
- date: 日期 YYYY-MM-DD（必填）
- workdayStart: 工作时间开始，整点小时（默认 9）
- workdayEnd: 工作时间结束，整点小时（默认 18）`,
  params: {
    date: { type: 'string', description: '日期 YYYY-MM-DD', required: true },
    workdayStart: { type: 'number', description: `工作开始小时（默认 ${DEFAULT_WORKDAY_START}）`, required: false, default: DEFAULT_WORKDAY_START },
    workdayEnd: { type: 'number', description: `工作结束小时（默认 ${DEFAULT_WORKDAY_END}）`, required: false, default: DEFAULT_WORKDAY_END },
  },
  toolsets: ['productivity'],
}

interface Span {
  from: number
  to: number
}

function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from)
  const out: Span[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.from <= last.to) {
      last.to = Math.max(last.to, s.to)
    } else {
      out.push({ from: s.from, to: s.to })
    }
  }
  return out
}

export async function calendarFree(args: Record<string, unknown>): Promise<ToolResult> {
  const dateRaw = readString(args, 'date')
  if (!dateRaw) {return fail('需要提供 date 参数（YYYY-MM-DD）')}
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateRaw)
  if (!parts) {return fail(`date 必须是 YYYY-MM-DD 格式，收到: ${dateRaw}`)}
  const dayStart = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 0, 0, 0, 0)
  if (Number.isNaN(dayStart.getTime()) || ymd(dayStart) !== dateRaw) {
    return fail(`date 不是一个真实存在的日期: ${dateRaw}`)
  }

  const rawStart = readNumber(args, 'workdayStart')
  const rawEnd = readNumber(args, 'workdayEnd')
  const workStartHour = rawStart === null ? DEFAULT_WORKDAY_START : Math.round(rawStart)
  const workEndHour = rawEnd === null ? DEFAULT_WORKDAY_END : Math.round(rawEnd)
  if (workStartHour < 0 || workEndHour > 24 || workEndHour <= workStartHour) {
    return fail(`工作时间不合法: ${workStartHour}:00 - ${workEndHour}:00（要求 0 ≤ 开始 < 结束 ≤ 24）`)
  }

  const workStart = new Date(dayStart.getTime())
  workStart.setHours(workStartHour, 0, 0, 0)
  const workEnd = new Date(dayStart.getTime())
  workEnd.setHours(workEndHour, 0, 0, 0)

  try {
    const occ = readEvents()
      .flatMap(ev => expandOccurrences(ev, workStart, workEnd))
      .sort((a, b) => a.start.getTime() - b.start.getTime())
    const busy = mergeSpans(
      occ
        .map(ev => ({
          from: Math.max(ev.start.getTime(), workStart.getTime()),
          to: Math.min(ev.end.getTime(), workEnd.getTime()),
        }))
        .filter(s => s.to > s.from),
    )

    const free: Span[] = []
    let cursor = workStart.getTime()
    for (const b of busy) {
      if (b.from > cursor) {free.push({ from: cursor, to: b.from })}
      cursor = Math.max(cursor, b.to)
    }
    if (cursor < workEnd.getTime()) {free.push({ from: cursor, to: workEnd.getTime() })}

    const at = (ms: number): string => hm(new Date(ms))
    const head = `🕘 ${dateRaw} 工作时间 ${workStartHour}:00-${workEndHour}:00`
    if (free.length === 0) {
      return { callId: '', ok: true, content: `${head}\n\n这一天没有任何空闲时段。` }
    }

    const freeLines = free.map((f, i) => {
      const mins = Math.round((f.to - f.from) / 60_000)
      return `${i + 1}. ${at(f.from)}-${at(f.to)}（${formatDurationMinutes(mins)}）`
    })
    const busyLines = occ.map(ev => `· ${hm(ev.start)}-${hm(ev.end)}  ${ev.summary}`)
    const busyBlock = busyLines.length > 0 ? `\n\n已占用:\n${busyLines.join('\n')}` : '\n\n已占用: 无'
    const total = free.reduce((sum, f) => sum + (f.to - f.from), 0)
    return {
      callId: '',
      ok: true,
      content: `${head} 空闲时段\n\n${freeLines.join('\n')}\n\n合计空闲 ${formatDurationMinutes(Math.round(total / 60_000))}${busyBlock}`,
    }
  } catch (err) {
    return fail(`读取日历文件失败: ${messageOf(err)}`)
  }
}
