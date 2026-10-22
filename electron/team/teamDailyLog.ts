// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// teamDailyLog.ts — 团队日志（v3.33）
//
// 同类项目的历史回放是给工程师调试用的冷数据；Lumina 把一天的任务板
// 事件、绩效、协作关系剪成「团队日记」，可接早安/晚会仪式与朋友圈。
//
// 纯函数 buildDigest 可单测；DailyLogStore 负责按天缓存。
// ============================================================

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { BoardEvent } from './teamSharedBoard'
import type { TraceEntry } from './llmTrace'
import type { WorkerStatsState, RoleProfile } from './workerStats'

export interface DigestInput {
  /** 这一天 00:00 起的任务板事件（本地时区） */
  events: BoardEvent[]
  /** 任务级 trace（end 条目） */
  traces: TraceEntry[]
  /** 工种画像（用于明星工种/成长） */
  stats: WorkerStatsState
  /** 当日成功/失败的协作对（可选，来自关系系统演化） */
  collabHighlights?: string[]
  /** 自治自领取次数 */
  autonomousClaims?: number
}

export interface Digest {
  date: string
  completed: number
  failed: number
  claimed: number
  created: number
  autonomy: number
  longRunning: number
  starRole: { role: string; done: number } | null
  lines: string[]
  markdown: string
}

function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 某一天的 00:00 与次日 00:00 时间戳（本地时区） */
export function dayRange(date: Date): { start: number; end: number; key: string } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  return { start, end: start + 24 * 3600 * 1000, key: dayKey(date) }
}

/** 纯函数：把一天的团队活动剪成日记 */
export function buildDigest(input: DigestInput, date = new Date()): Digest {
  const { start, end, key } = dayRange(date)
  const inDay = (ts: number) => ts >= start && ts < end
  const events = input.events.filter(e => inDay(e.ts))
  const traces = input.traces.filter(t => t.phase === 'end' && inDay(t.at))

  const completed = events.filter(e => e.to === 'done').length
  const failed = events.filter(e => e.to === 'failed').length
  const claimed = events.filter(e => e.to === 'claimed' || e.to === 'running').length
  const created = events.filter(e => e.from === 'created').length
  const autonomy = input.autonomousClaims ?? 0
  const longRunning = traces.filter(t => t.longRunning).length

  // 明星工种：当天完成最多
  const doneByRole = new Map<string, number>()
  for (const t of traces) {
    if (t.ok) {doneByRole.set(t.role, (doneByRole.get(t.role) || 0) + 1)}
  }
  let starRole: Digest['starRole'] = null
  for (const [role, done] of doneByRole) {
    if (!starRole || done > starRole.done) {starRole = { role, done }}
  }

  // 新沉淀的经验卡/成长（按画像 recent 当天成功失败统计）
  const growth: string[] = []
  const profiles: RoleProfile[] = Object.values(input.stats || {})
  for (const p of profiles) {
    const todayOk = p.recent.filter(r => r.ok && inDay(r.at)).length
    const todayFail = p.recent.filter(r => !r.ok && inDay(r.at)).length
    if (todayOk || todayFail) {
      growth.push(`· ${p.role}：今日 ${todayOk} 成 ${todayFail} 败，累计 ${p.jobs} 单，经验卡 ${p.cards.length} 张`)
    }
  }

  const lines: string[] = []
  lines.push(`今天团队共新挂 ${created} 个任务，认领/开工 ${claimed} 次，完成 ${completed} 个${failed ? `，失败 ${failed} 个` : ''}。`)
  if (autonomy) {lines.push(`其中 ${autonomy} 个任务是成员在任务板上自己看到、主动认领的（不用 Lumina 逐个派活）。`)}
  if (starRole) {lines.push(`最忙的是 ${starRole.role}，独立完成了 ${starRole.done} 单。`)}
  if (longRunning) {lines.push(`有 ${longRunning} 个长任务超过 2 分钟（已在任务追踪里留痕）。`)}
  if (growth.length) {lines.push('成长记录：\n' + growth.join('\n'))}
  if (input.collabHighlights?.length) {lines.push('协作片段：\n' + input.collabHighlights.map(h => `· ${h}`).join('\n'))}
  if (!created && !traces.length) {lines.push('今天任务板很安静，没有团队协作记录。')}

  const title = `团队日记 · ${key}`
  const markdown = `## ${title}\n\n${lines.join('\n\n')}`
  return {
    date: key, completed, failed, claimed, created, autonomy, longRunning,
    starRole, lines, markdown,
  }
}

// ═══════════════════════════════════════════════════════════
// 存储：按天缓存
// ═══════════════════════════════════════════════════════════

const LOG_CAP = 60

export class DailyLogStore {
  private cache: Record<string, Digest> = {}
  constructor(public readonly filepath: string | null = null) {
    if (filepath) {
      try {
        if (fs.existsSync(filepath)) {
          const raw = JSON.parse(fs.readFileSync(filepath, 'utf-8'))
          if (raw?.days) {this.cache = raw.days}
        }
      } catch { /* ignore */ }
    }
  }

  private persist(): void {
    if (!this.filepath) {return}
    try {
      fs.mkdirSync(path.dirname(this.filepath), { recursive: true })
      const keys = Object.keys(this.cache).sort()
      const trimmed: Record<string, Digest> = {}
      for (const k of keys.slice(-LOG_CAP)) {trimmed[k] = this.cache[k]}
      const tmp = this.filepath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, days: trimmed }, null, 2), 'utf-8')
      fs.renameSync(tmp, this.filepath)
    } catch { /* ignore */ }
  }

  save(digest: Digest): Digest {
    this.cache[digest.date] = digest
    this.persist()
    return digest
  }

  get(dateKey: string): Digest | undefined {return this.cache[dateKey]}
  recent(n = 7): Digest[] {return Object.values(this.cache).sort((a, b) => b.date.localeCompare(a.date)).slice(0, n)}
}

let _instance: DailyLogStore | null = null

function defaultPath(): string {
  const base = app?.getPath ? app.getPath('userData') : process.cwd()
  return path.join(base, 'team', 'daily-log.json')
}

export function getDailyLog(filepath?: string): DailyLogStore {
  if (!_instance || filepath) {
    _instance = new DailyLogStore(filepath || defaultPath())
  }
  return _instance
}
