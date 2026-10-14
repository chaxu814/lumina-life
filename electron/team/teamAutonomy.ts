// ============================================================
// teamAutonomy.ts — 内驱力驱动的自领取团队 + 崩溃恢复 (v3.33)
//
// 同类项目的 idle worker 是 1 秒一次的硬轮询进程，没活就 sleep。
// Lumina 不照搬定时器：待命 worker「闲不住」的主动性随待命时长升高，
// 且每个工种有自己的责任心基线（工程员/协作者更爱揽活，复核员等任务）。
//
// 机制：
//   - 仅对 keepAlive 留场、state=idle 的 worker 生效
//   - 抖动轮询（20~40s，省 token、不搞 1s 硬循环）；每次 tick 算主动性
//   - 主动 → claimNext 自己工种的任务（first-claim-wins）→ start → 干活
//     → 心跳续租 → complete/fail → 写绩效/关系/trace，再回待命
//   - 全局并发帽（默认 2 个自治任务），避免一拥而上
//   - 结果写任务板 + 私信 Lumina，前台仍只见 Lumina（星型出口不变）
//
// 启动恢复：recoverOnStartup() 回收重启前的孤儿任务、统计遗留 worktree。
// ============================================================

import { getSharedBoard, type BoardTaskKind, type BoardTask } from './teamSharedBoard'
import {
  listDynamicWorkers, runWorker, finalizeWorkerWorktree,
  type DynamicWorker,
} from './dynamicWorker'
import { getWorkerStats } from './workerStats'
import { getTaskTrace } from './llmTrace'
import { getRelationshipStore } from '../agentRelationships'
import { roleActorId } from './teamPolicy'
import { getTeamMailbox } from './teamMailbox'
import { listWorktrees } from './gitWorktree'
import * as fs from 'fs'
import * as path from 'path'

/** 工种 → 任务板 kind 映射（自定义工种不自动揽活，需显式派单） */
export const ROLE_KINDS: Record<string, BoardTaskKind[]> = {
  research: ['research'],
  search: ['search'],
  data: ['data'],
  code: ['code'],
  test: ['test'],
  review: ['review'],
  general: ['other'],
}

/** 各工种责任心基线（0~1，越高越爱主动揽活） */
export const ROLE_INITIATIVE: Record<string, number> = {
  general: 0.85,
  code: 0.8,
  data: 0.75,
  research: 0.7,
  search: 0.65,
  test: 0.6,
  review: 0.5,
}

/** 待命多久后主动性打满（ms） */
const IDLE_RAMP_MS = 3 * 60 * 1000
const HEARTBEAT_MS = 45 * 1000

/**
 * 同时最大并发任务数。
 *
 * 默认 2 是**刻意保守**的：桌宠常驻用户桌面，夜间自己跑一堆任务会烧 token、
 * 耗电、占 CPU，用户会直接卸载。专业用户做多项目时需要更高上限，
 * 所以允许通过环境变量 `LUMINA_MAX_CONCURRENT` 覆盖（1~8，防止手滑设成 100）。
 * 运行时 `teamAutonomy.start({ maxConcurrent })` 仍可再覆盖一次。
 */
function resolveDefaultMaxConcurrent(): number {
  const raw = process.env.LUMINA_MAX_CONCURRENT
  if (!raw) {return 2}
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) {
    console.warn(`[teamAutonomy] ⚠️ LUMINA_MAX_CONCURRENT="${raw}" 不是数字，回退默认 2`)
    return 2
  }
  return Math.max(1, Math.min(8, n))
}

const DEFAULT_MAX_CONCURRENT = resolveDefaultMaxConcurrent()

export interface AutonomyStatus {
  running: boolean
  intervalMs: number
  maxConcurrent: number
  inFlight: number
  totalClaims: number
  lastTickAt: number | null
  lastClaimAt: number | null
}

/** 纯函数：算某 worker 当前主动性 */
export function willingness(role: string, idleMs: number, rng: () => number = Math.random): number {
  const base = ROLE_INITIATIVE[role] ?? 0.6
  const ramp = Math.max(0, Math.min(1, idleMs / IDLE_RAMP_MS))
  return Math.max(0, Math.min(1, base * (0.4 + 0.6 * ramp) + (rng() - 0.5) * 0.05))
}

class TeamAutonomy {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private intervalMs = 30_000
  private maxConcurrent = DEFAULT_MAX_CONCURRENT
  private inFlight = 0
  private totalClaims = 0
  private lastTickAt: number | null = null
  private lastClaimAt: number | null = null
  private ticking = false

  start(opts: { intervalMs?: number; maxConcurrent?: number; immediate?: boolean } = {}): void {
    if (this.running) {return}
    this.running = true
    if (opts.intervalMs) {this.intervalMs = opts.intervalMs}
    if (opts.maxConcurrent) {this.maxConcurrent = opts.maxConcurrent}
    this.schedule(5000)
    if (opts.immediate) {void this.tick()}
    console.log('[teamAutonomy] 🧭 内驱力自领取已启动（抖动轮询，留场 idle 成员会自己找活）')
  }

  stop(): void {
    this.running = false
    if (this.timer) {clearTimeout(this.timer); this.timer = null}
  }

  isRunning(): boolean {return this.running}

  status(): AutonomyStatus {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      maxConcurrent: this.maxConcurrent,
      inFlight: this.inFlight,
      totalClaims: this.totalClaims,
      lastTickAt: this.lastTickAt,
      lastClaimAt: this.lastClaimAt,
    }
  }

  private schedule(delay?: number): void {
    if (!this.running) {return}
    // 抖动：±35%，避免所有 worker 节拍一致
    const jitter = 0.65 + Math.random() * 0.7
    const d = delay ?? this.intervalMs * jitter
    this.timer = setTimeout(() => { void this.tick().finally(() => this.schedule()) }, d)
  }

  /** 单次 tick：让每个有空闲名额的 idle worker 决定是否揽活 */
  async tick(): Promise<{ claimed: number }> {
    if (this.ticking) {return { claimed: 0 }}
    this.ticking = true
    this.lastTickAt = Date.now()
    let claimed = 0
    try {
      const board = getSharedBoard()
      const workers = listDynamicWorkers()
        .filter(w => w.keepAlive && !w.busy && w.state === 'idle' && ROLE_KINDS[w.role])
      for (const w of workers) {
        if (this.inFlight >= this.maxConcurrent) {break}
        const idleMs = Date.now() - (w.idleSince || w.hiredAt)
        const roll = Math.random()
        const will = willingness(w.role, idleMs, () => roll)
        // 主动性达到阈值才去看板（阈值随待命时长降低：ramp 已体现在 will 里）
        if (roll > will) {continue}
        const task = await board.claimNext(w.id, { kinds: ROLE_KINDS[w.role] })
        if (!task) {continue}
        claimed += 1
        this.totalClaims += 1
        this.lastClaimAt = Date.now()
        this.inFlight += 1
        // 不阻塞 tick：后台干活
        void this.runAutonomous(w, task).finally(() => {this.inFlight -= 1})
      }
    } catch (e) {
      console.warn('[teamAutonomy] tick 异常:', (e as Error)?.message)
    } finally {
      this.ticking = false
    }
    return { claimed }
  }

  /** 自治执行一个已认领任务的完整生命周期 */
  private async runAutonomous(w: DynamicWorker, task: BoardTask): Promise<void> {
    const board = getSharedBoard()
    const stats = getWorkerStats()
    const trace = getTaskTrace()
    const title = task.title
    const started = Date.now()
    let hb: ReturnType<typeof setInterval> | null = null
    trace.start({
      source: 'autonomy', role: w.role, workerId: w.id, title,
      modelTier: w.modelTier || 'unknown',
    })
    try {
      await board.start(task.id, w.id)
      // 心跳续租（长任务防被当成僵死回收）
      hb = setInterval(() => {
        void board.heartbeat(task.id, w.id).catch(() => undefined)
      }, HEARTBEAT_MS)
      // 私信 Lumina：我自己看到活、接了（星型出口）
      await this.notifyLumina(`🫡 ${w.icon} ${w.name} 主动认领了任务 ${task.id}「${title}」`,
        `${w.name} 在任务板上看到可做的 ${task.kind} 任务，已自己认领开工。`)

      const prompt = this.buildTaskPrompt(task)
      const result = await runWorker(w, prompt, 6 * 60 * 1000)
      const durationMs = Date.now() - started

      // code worker 收尾 worktree（成功合并，失败保留现场）
      let checkpoint: string | undefined
      if (w.worktree) {
        const fin = await finalizeWorkerWorktree(w, true)
        checkpoint = fin.checkpoint
      }
      const summary = String(result || '').slice(0, 2000)
      await board.complete(task.id, w.id, summary)
      await stats.recordOutcome(w.role, {
        ok: true, durationMs, title, kind: task.kind, workerId: w.id, note: summary.slice(0, 300),
      })
      try {
        getRelationshipStore().recordInteraction('lumina', roleActorId(w.role), 'delegation_ok', 'autonomy')
      } catch { /* ignore */ }
      trace.end({ source: 'autonomy', role: w.role, workerId: w.id, title },
        { ok: true, durationMs, modelTier: w.modelTier || 'unknown' })
      await this.notifyLumina(`✅ ${w.icon} ${w.name} 完成了任务 ${task.id}「${title}」`,
        `耗时 ${Math.round(durationMs / 1000)}s${checkpoint ? `，合并前检查点 ${checkpoint}（可回滚）` : ''}`)
    } catch (e: any) {
      const durationMs = Date.now() - started
      const error = e?.message || String(e)
      try {
        await board.fail(task.id, w.id, error)
        if (w.worktree) {await finalizeWorkerWorktree(w, false).catch(() => null)}
        await stats.recordOutcome(w.role, {
          ok: false, durationMs, title, kind: task.kind, workerId: w.id, note: error,
        })
        getRelationshipStore().recordInteraction('lumina', roleActorId(w.role), 'delegation_fail', 'autonomy')
        trace.end({ source: 'autonomy', role: w.role, workerId: w.id, title },
          { ok: false, durationMs, error, modelTier: w.modelTier || 'unknown' })
        await this.notifyLumina(`⚠️ ${w.icon} ${w.name} 做任务 ${task.id}「${title}」时失败`, error)
      } catch { /* 失败路径的兜底不抛 */ }
    } finally {
      if (hb) {clearInterval(hb)}
      // runWorker 已把 worker 置回 idle；刷新待命计时
      w.idleSince = Date.now()
    }
  }

  private buildTaskPrompt(task: BoardTask): string {
    return `【共享任务板 · 你主动认领的任务 ${task.id}】
标题：${task.title}
类型：${task.kind}
详情：
${task.detail || task.title}
${task.workdir ? `\n工作目录：${task.workdir}（只在这里面操作）` : ''}
完成后输出交付摘要：做了什么、关键结果、遗留问题。`
  }

  private async notifyLumina(subject: string, body: string): Promise<void> {
    try {
      await getTeamMailbox().send({ from: 'lumina', to: 'lumina', subject, body, kind: 'system' })
    } catch { /* 信箱未就绪不阻塞 */ }
  }
}

let _autonomy: TeamAutonomy | null = null
export function getTeamAutonomy(): TeamAutonomy {
  if (!_autonomy) {_autonomy = new TeamAutonomy()}
  return _autonomy
}

// ═══════════════════════════════════════════════════════════
// 启动崩溃恢复
// ═══════════════════════════════════════════════════════════

/** 崩溃恢复冷却：30s 内不重复触发（registerTeamCollabIpc 被多次调用/热重载时防刷屏） */
const RECOVERY_COOLDOWN_MS = 30_000
let _lastRecoveryRunAt = 0

/** 持久化恢复计数文件（避免重启后计数器归零导致反复把"正常启动"当崩溃报） */
function recoveryStateFile(basePath: string): string {
  return path.join(basePath, '.lumina-recovery.json')
}
function readRecoveryState(basePath: string): { lastRecoveryAtMs: number; totalRecovered: number } {
  try {
    const p = recoveryStateFile(basePath)
    if (fs.existsSync(p)) {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'))
      return {
        lastRecoveryAtMs: Number(s.lastRecoveryAtMs) || 0,
        totalRecovered: Number(s.totalRecovered) || 0,
      }
    }
  } catch { /* ignore */ }
  return { lastRecoveryAtMs: 0, totalRecovered: 0 }
}
function writeRecoveryState(basePath: string, next: { lastRecoveryAtMs: number; totalRecovered: number }): void {
  try {
    fs.writeFileSync(recoveryStateFile(basePath), JSON.stringify(next, null, 2), 'utf8')
  } catch { /* 数据目录不可写不阻塞 */ }
}

export interface RecoveryReport {
  /** 被回收回 pending 的任务 id */
  reapedTasks: string[]
  /** 遗留的 worktree 数量（可能是上次崩溃的现场） */
  orphanWorktrees: number
  /** 遗留 worktree 路径 */
  worktreePaths: string[]
  notice: string
}

/**
 * 应用启动时调用：
 *   1. 任务板上 claimed/running 但进程已不存在 → 强制回收回 pending
 *   2. 对账 git worktree，遗留现场只报告不自动删（保护用户改动）
 *
 * 降噪：
 *   - 30s 冷却：同一会话内重复调用直接返回空报告，不再 reap/打印
 *   - 真实崩溃检测：只有真有中断任务或遗留 worktree 时才 console.log + 发信箱；
 *     干净启动（无崩溃现场）走 console.debug，不刷控制台
 *   - 恢复计数持久化：跨重启累加，不让计数器归零把每次正常启动当崩溃重复报
 */
export async function recoverOnStartup(basePath = process.cwd()): Promise<RecoveryReport> {
  const now = Date.now()
  // 冷却：30s 内不重复触发
  if (now - _lastRecoveryRunAt < RECOVERY_COOLDOWN_MS) {
    return { reapedTasks: [], orphanWorktrees: 0, worktreePaths: [], notice: '团队崩溃恢复：冷却中，跳过。' }
  }
  _lastRecoveryRunAt = now

  const prev = readRecoveryState(basePath)
  const board = getSharedBoard()
  const reapedTasks = await board.reapOrphans(true)

  let orphanWorktrees = 0
  const worktreePaths: string[] = []
  try {
    const wts = await listWorktrees(basePath)
    for (const wt of wts) {
      if (wt.path.includes('.lumina-worktrees')) {
        orphanWorktrees += 1
        worktreePaths.push(wt.path)
      }
    }
  } catch { /* 非 git 仓库忽略 */ }

  const bits: string[] = []
  if (reapedTasks.length) {bits.push(`回收 ${reapedTasks.length} 个中断任务（${reapedTasks.join(', ')}）回待认领池`)}
  if (orphanWorktrees) {bits.push(`发现 ${orphanWorktrees} 个遗留隔离工作区（保留未删，可用 git_worktree 检查）`)}
  const hadRealCrash = bits.length > 0
  const notice = hadRealCrash
    ? `团队崩溃恢复：${bits.join('；')}。`
    : '团队崩溃恢复：无中断任务，无遗留工作区。'

  // 持久化恢复计数（仅在真有恢复动作时累加）
  const recoveredNow = reapedTasks.length + orphanWorktrees
  writeRecoveryState(basePath, {
    lastRecoveryAtMs: now,
    totalRecovered: prev.totalRecovered + recoveredNow,
  })

  if (hadRealCrash) {
    try {
      await getTeamMailbox().send({
        from: 'lumina', to: 'lumina',
        subject: '系统：团队启动恢复',
        body: notice + (worktreePaths.length ? `\n${worktreePaths.join('\n')}` : ''),
        kind: 'system',
      })
    } catch { /* ignore */ }
    console.log(`[teamAutonomy] ${notice}`)
  } else if (process.env.DEBUG) {
    // 干净启动：不刷控制台，仅 DEBUG 守卫下可见
    console.debug(`[teamAutonomy] ${notice}`)
  }
  return { reapedTasks, orphanWorktrees, worktreePaths, notice }
}
