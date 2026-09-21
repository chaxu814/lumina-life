// ============================================================
// workerStats.ts — 临时工绩效画像 / 易错档案 / 经验卡 (v3.33)
//
// cc-haha 的 worker 是无名工牌，干完即焚，永远零成长。
// Lumina 的临时工虽然也解散，但「工种」是延续的：每个工种干过多少活、
// 成功率、平均耗时、被复核挑出的高频问题、散伙时留下的经验卡，都沉淀下来。
//
// 三个用途：
//   1. 派活路由：Lumina 雇佣时按历史表现挑工种/个体（rankRolesForKind）
//   2. 成长：开工时把「该工种常犯的错 + 最近的经验卡」注入系统提示（profileHint）
//   3. 可视化：团队面板看每个工种的成长曲线
//
// 纯状态变换函数全部可单测（不碰文件）；WorkerStatsStore 负责原子落盘。
// ============================================================

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

export interface OutcomeInput {
  ok: boolean
  durationMs: number
  /** 任务标题（日志/画像用） */
  title?: string
  /** 任务板 kind：research/search/data/code/review/test/other */
  kind?: string
  /** 具体 worker 实例 id（临时） */
  workerId?: string
  /** 失败原因 / 交付摘要 */
  note?: string
}

export interface OutcomeRecord {
  at: number
  ok: boolean
  title: string
  kind: string
  note?: string
}

export interface ExperienceCard {
  id: string
  role: string
  at: number
  /** 经验标题 */
  title: string
  /** 经验正文（下次雇佣注入系统提示） */
  body: string
  /** shutdown=散伙自动总结 / review=复核教训 / manual=主动沉淀 */
  source: 'shutdown' | 'review' | 'manual'
  kind?: string
}

export interface RoleProfile {
  role: string
  jobs: number
  success: number
  fail: number
  totalDurationMs: number
  /** 被复核/验证挑出问题的次数 */
  reviewFindings: number
  /** 高频错误标签 → 次数 */
  mistakes: Record<string, number>
  /** 最近结果（环形 30 条） */
  recent: OutcomeRecord[]
  /** 散伙/复核沉淀的经验卡（环形 20 张） */
  cards: ExperienceCard[]
}

export type WorkerStatsState = Record<string, RoleProfile>

const RECENT_CAP = 30
const CARDS_CAP = 20

// ═══════════════════════════════════════════════════════════
// 纯状态变换
// ═══════════════════════════════════════════════════════════

export function emptyStats(): WorkerStatsState {return {} as WorkerStatsState}

function ensure(state: WorkerStatsState, role: string): RoleProfile {
  let p = state[role]
  if (!p) {
    p = {
      role,
      jobs: 0, success: 0, fail: 0, totalDurationMs: 0,
      reviewFindings: 0, mistakes: {}, recent: [], cards: [],
    }
    state[role] = p
  }
  return p
}

/** 记录一次任务结果（成功/失败、耗时） */
export function recordOutcomeInState(
  state: WorkerStatsState,
  role: string,
  input: OutcomeInput,
  now = Date.now(),
): WorkerStatsState {
  const next: WorkerStatsState = { ...state }
  const p = ensure(next, role)
  const clone: RoleProfile = {
    ...p,
    mistakes: { ...p.mistakes },
    recent: [...p.recent],
    cards: [...p.cards],
  }
  clone.jobs += 1
  if (input.ok) {clone.success += 1} else {clone.fail += 1}
  clone.totalDurationMs += Math.max(0, Math.round(input.durationMs))
  const rec: OutcomeRecord = {
    at: now,
    ok: input.ok,
    title: input.title || '(未命名任务)',
    kind: input.kind || 'other',
    ...(input.note ? { note: input.note.slice(0, 500) } : {}),
  }
  clone.recent.push(rec)
  if (clone.recent.length > RECENT_CAP) {clone.recent.splice(0, clone.recent.length - RECENT_CAP)}
  next[role] = clone
  return next
}

/**
 * 从一段评审/失败文本里提取错误标签（关键词归类，确定性，不依赖 LLM）。
 * 这是「热茶把错误教给工程员」的写入端。
 */
export function extractMistakeTags(text: string): string[] {
  const t = (text || '').toLowerCase()
  const rules: Array<[string, RegExp]> = [
    ['空值/边界', /(null|undefined|nan|空指针|越界|边界|空数组|空字符串|没有考虑|遗漏)/],
    ['类型错误', /(类型|typeerror|类型不匹配|string|number|boolean)/],
    ['并发/竞态', /(并发|竞态|race|死锁|异步顺序|await|promise)/],
    ['安全/权限', /(安全|注入|xss|越权|权限|敏感|密钥|token|密码|sql注入|路径穿越)/],
    ['错误处理', /(异常|未捕获|try|catch|错误处理|reject|超时|timeout)/],
    ['资源泄漏', /(泄漏|未关闭|未释放|dispose|close|内存|句柄)/],
    ['测试缺失', /(测试|test|覆盖率|回归|用例)/],
    ['逻辑错误', /(逻辑|条件判断|取反|off-by-one|计算错误|公式|排序)/],
    ['性能', /(性能|复杂度|n\+1|重复计算|死循环|卡顿|慢查询)/],
    ['依赖/环境', /(依赖|版本|环境|兼容|安装|import|require|路径)/],
    ['可复现性', /(复现|确定性|随机|flaky|硬编码|临时文件)/],
    ['文档/命名', /(命名|文档|注释|拼写|readme|接口契约)/],
  ]
  const tags: string[] = []
  for (const [tag, re] of rules) {
    if (re.test(t)) {tags.push(tag)}
  }
  if (tags.length === 0 && t.trim()) {tags.push('其他问题')}
  return tags
}

/** 记录一次复核发现（写易错档案） */
export function recordReviewInState(
  state: WorkerStatsState,
  role: string,
  findings: string[],
  now = Date.now(),
): WorkerStatsState {
  const next: WorkerStatsState = { ...state }
  const p = ensure(next, role)
  const clone: RoleProfile = { ...p, mistakes: { ...p.mistakes }, recent: [...p.recent], cards: [...p.cards] }
  const tags = findings.flatMap(f => extractMistakeTags(f))
  for (const tag of tags) {
    clone.mistakes[tag] = (clone.mistakes[tag] || 0) + 1
  }
  if (tags.length) {clone.reviewFindings += 1}
  void now
  next[role] = clone
  return next
}

let cardSeq = 0
/** 沉淀一张经验卡 */
export function addCardInState(
  state: WorkerStatsState,
  role: string,
  card: { title: string; body: string; source?: ExperienceCard['source']; kind?: string },
  now = Date.now(),
): { state: WorkerStatsState; card: ExperienceCard } {
  const next: WorkerStatsState = { ...state }
  const p = ensure(next, role)
  const full: ExperienceCard = {
    id: `card_${now.toString(36)}_${++cardSeq}`,
    role,
    at: now,
    title: card.title,
    body: card.body,
    source: card.source || 'manual',
    ...(card.kind ? { kind: card.kind } : {}),
  }
  const cards = [...p.cards, full]
  if (cards.length > CARDS_CAP) {cards.splice(0, cards.length - CARDS_CAP)}
  next[role] = { ...p, cards }
  return { state: next, card: full }
}

/**
 * 临时工散伙时，从画像自动生成一张经验卡（确定性，不调 LLM）：
 * 汇总本工种累计成绩 + 高频错误 + 最近教训，作为留给下一批同工种的遗产。
 */
export function autoShutdownCard(
  state: WorkerStatsState,
  role: string,
  now = Date.now(),
): { state: WorkerStatsState; card: ExperienceCard } | null {
  const p = state[role]
  if (!p || p.jobs === 0) {return null}
  const rate = successRate(p)
  const topMistakes = topMistakesOf(p, 3)
  const recentFail = [...p.recent].reverse().find(r => !r.ok)
  const lines: string[] = []
  lines.push(`工种累计 ${p.jobs} 单，成功率 ${(rate * 100).toFixed(0)}%，平均耗时 ${formatDuration(avgDurationMs(p))}。`)
  if (topMistakes.length) {
    lines.push(`最容易犯的错：${topMistakes.map(([t, n]) => `${t}×${n}`).join('、')}。下次开工先自查这些方向。`)
  }
  if (recentFail) {
    lines.push(`最近一次失败：${recentFail.title}${recentFail.note ? `（${recentFail.note}）` : ''}。`)
  }
  if (p.reviewFindings === 0 && p.jobs >= 3) {
    lines.push('近期没有被复核挑出问题，保持当前工作习惯。')
  }
  return addCardInState(state, role, {
    title: `散伙经验卡 · ${role} · 第 ${p.jobs} 单后`,
    body: lines.join('\n'),
    source: 'shutdown',
  }, now)
}

// ═══════════════════════════════════════════════════════════
// 派生指标（路由/提示用）
// ═══════════════════════════════════════════════════════════

/** 成功率（拉普拉斯平滑，避免干 1 单成功就 100%） */
export function successRate(p: RoleProfile): number {
  return (p.success + 1) / (p.jobs + 2)
}

export function avgDurationMs(p: RoleProfile): number {
  return p.jobs ? p.totalDurationMs / p.jobs : 0
}

export function topMistakesOf(p: RoleProfile, n = 3): Array<[string, number]> {
  return Object.entries(p.mistakes).sort((a, b) => b[1] - a[1]).slice(0, n)
}

/**
 * 给候选工种打分排序，用于派活路由：
 *   - 成功率是主信号（平滑后）
 *   - 干过的单数给置信度（最多 +0.15）
 *   - 平均耗时过长轻微扣分（相对同组，封顶 -0.1）
 * 没干过活的工种给中性分 0.5，不会因为「新」被彻底埋没。
 */
export function rankRolesForKind(state: WorkerStatsState, candidateRoles: string[]): Array<{ role: string; score: number; fresh: boolean }> {
  const withDurations = candidateRoles.map(role => {
    const p = state[role]
    if (!p || p.jobs === 0) {return { role, p: null as RoleProfile | null, avg: 0 }}
    return { role, p, avg: avgDurationMs(p) }
  })
  const maxAvg = Math.max(1, ...withDurations.map(x => x.avg))
  return withDurations.map(({ role, p, avg }) => {
    if (!p) {return { role, score: 0.5, fresh: true }}
    const confidence = Math.min(0.15, p.jobs * 0.02)
    const speedPenalty = p.jobs >= 2 ? (avg / maxAvg) * 0.1 : 0
    return { role, score: Math.max(0, Math.min(1, successRate(p) + confidence - speedPenalty)), fresh: false }
  }).sort((a, b) => b.score - a.score)
}

/**
 * 生成开工注入提示（易错档案 + 最新经验卡）。
 * 没有画像时返回空串（新工种不说教）。
 */
export function profileHint(state: WorkerStatsState, role: string): string {
  const p = state[role]
  if (!p || p.jobs === 0) {return ''}
  const parts: string[] = []
  const mistakes = topMistakesOf(p, 3)
  if (mistakes.length) {
    parts.push(`【工种历史易错点（本工种已累计 ${p.jobs} 单）】\n` +
      mistakes.map(([t, n], i) => `${i + 1}. ${t}（历史上踩过 ${n} 次）`).join('\n') +
      '\n开工前先针对这些方向自查，别再踩同一个坑。')
  }
  const latestCards = [...p.cards].reverse().slice(0, 2)
  if (latestCards.length) {
    parts.push('【前任同工种留下的经验卡】\n' +
      latestCards.map(c => `· ${c.title}：${c.body.replace(/\n/g, ' ')}`).join('\n'))
  }
  return parts.join('\n\n')
}

/** 格式化画像为可读文本（工具/面板用） */
export function formatProfiles(state: WorkerStatsState): string {
  const roles = Object.keys(state).sort()
  if (!roles.length) {return '📊 团队还没有任务履历（临时工干完第一批活后开始沉淀）。'}
  return roles.map(role => {
    const p = state[role]!
    const rate = (successRate(p) * 100).toFixed(0)
    const top = topMistakesOf(p, 3).map(([t, n]) => `${t}×${n}`).join('、') || '无'
    const cards = p.cards.length
    return `▸ ${role}：${p.jobs} 单（✅${p.success}/❌${p.fail}）成功率≈${rate}%，平均 ${formatDuration(avgDurationMs(p))}，经验卡 ${cards} 张\n` +
      `  易错点：${top}`
  }).join('\n')
}

export function formatDuration(ms: number): string {
  if (!ms) {return '0s'}
  const s = Math.round(ms / 1000)
  if (s < 60) {return `${s}s`}
  const m = Math.floor(s / 60)
  return `${m}m${s % 60}s`
}

// ═══════════════════════════════════════════════════════════
// 持久化存储
// ═══════════════════════════════════════════════════════════

let _chain: Promise<unknown> = Promise.resolve()
function chain<T>(fn: () => T): Promise<T> {
  const run = _chain.then(() => fn(), () => fn())
  _chain = run.catch(() => undefined)
  return run
}

export class WorkerStatsStore {
  private state: WorkerStatsState
  constructor(public readonly filepath: string) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true })
    this.state = this.load()
  }

  private load(): WorkerStatsState {
    try {
      if (fs.existsSync(this.filepath)) {
        const raw = JSON.parse(fs.readFileSync(this.filepath, 'utf-8'))
        if (raw && typeof raw === 'object' && raw.profiles && typeof raw.profiles === 'object') {
          return raw.profiles as WorkerStatsState
        }
      }
    } catch (e) {
      console.warn('[workerStats] 读取失败，重置空画像:', (e as Error)?.message)
    }
    return emptyStats()
  }

  private persist(): void {
    const tmp = this.filepath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: this.state }, null, 2), 'utf-8')
    fs.renameSync(tmp, this.filepath)
  }

  async recordOutcome(role: string, input: OutcomeInput): Promise<RoleProfile> {
    return chain(() => {
      this.state = recordOutcomeInState(this.state, role, input)
      this.persist()
      return this.state[role]!
    })
  }

  async recordReview(role: string, findings: string[]): Promise<RoleProfile> {
    return chain(() => {
      this.state = recordReviewInState(this.state, role, findings)
      this.persist()
      return this.state[role]!
    })
  }

  async addCard(role: string, card: { title: string; body: string; source?: ExperienceCard['source']; kind?: string }): Promise<ExperienceCard> {
    return chain(() => {
      const r = addCardInState(this.state, role, card)
      this.state = r.state
      this.persist()
      return r.card
    })
  }

  /** 散伙时自动沉淀经验卡（没有画像则跳过） */
  async shutdownCard(role: string): Promise<ExperienceCard | null> {
    return chain(() => {
      const r = autoShutdownCard(this.state, role)
      if (!r) {return null}
      this.state = r.state
      this.persist()
      return r.card
    })
  }

  getState(): WorkerStatsState {return this.state}
  getProfile(role: string): RoleProfile | undefined {return this.state[role]}
  hint(role: string): string {return profileHint(this.state, role)}
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: WorkerStatsStore | null = null

function defaultPath(): string {
  const base = app?.getPath ? app.getPath('userData') : process.cwd()
  return path.join(base, 'team', 'worker-stats.json')
}

export function getWorkerStats(filepath?: string): WorkerStatsStore {
  if (!_instance || filepath) {
    _instance = new WorkerStatsStore(filepath || defaultPath())
  }
  return _instance
}
