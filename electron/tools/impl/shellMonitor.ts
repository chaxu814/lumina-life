// ============================================================
// shellMonitor.ts — 🔐 B. 资源配额监控（进程级）
//
// 第三层 → ③ 资源配额
//   每 3 秒轮询: 内存 > 500MB / CPU > 50% 持续 15s / 子进程 > 50
//   超限 → killProcessTree + reject
//
// 姊妹模块（第三层纵深防御）:
//   A | processSandbox.ts — 进程树隔离（杀灭整棵树）
//   C | shellNetCage.ts   — 网络铁笼（HTTP_PROXY 白名单）
//   D | shellFileWall.ts  — 文件围墙（OS Integrity Level）
//
// 集成入口: shell.ts → executeSandboxed()
//
// 设计原则：
//   - 零额外依赖：只用 Node.js 内置模块 + OS 命令
//   - 非侵入式：不修改 spawn 逻辑，在外部轮询检查
//   - 即插即用：给 PID + 阈值 → 自动监控 → 超限回调
//   - 轻量：3 秒间隔，PowerShell 调用 ≈ 100ms 开销
//
// Windows 实现：
//   - powershell Get-Process → WorkingSet64 (内存) / TotalProcessorTime (CPU 累计时间)
//   - wmic process where ParentProcessId= → 子进程数量
//   - CPU% = (当前累计时间 - 上次累计时间) / 时间差 / 核心数 * 100
//
// 跨平台预留：
//   - Unix: ps -o rss=,etime=,pcpu= -p <pid> + /proc/<pid>
//   - 当前版本专注于 Windows，Unix 使用时要补充实现
// ============================================================

import { exec } from 'child_process'
import * as os from 'os'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface MonitorThresholds {
  /** 内存软上限 (MB) — 超限立即 kill，默认 500 */
  maxMemoryMB: number
  /** CPU 软上限 (%) — 持续超限 maxCpuDurationSec 秒后 kill，默认 50 */
  maxCpuPercent: number
  /** CPU 超限容忍秒数，默认 15 */
  maxCpuDurationSec: number
  /** 子进程数量上限 — 超限立即 kill 整棵树，默认 50 */
  maxChildProcesses: number
  /** 检查间隔 (ms)，默认 3000 */
  checkIntervalMs: number
}

export interface ProcessMetrics {
  pid: number
  memoryMB: number
  cpuPercent: number
  childProcessCount: number
  sampledAt: number
}

export interface ViolationEvent {
  type: 'memory' | 'cpu' | 'childProcess'
  pid: number
  metrics: ProcessMetrics
  threshold: number
  message: string
}

export type ViolationCallback = (event: ViolationEvent) => void

// ═══════════════════════════════════════════════════════════
// 默认阈值
// ═══════════════════════════════════════════════════════════

const DEFAULTS: MonitorThresholds = {
  maxMemoryMB: 500,
  maxCpuPercent: 50,
  maxCpuDurationSec: 15,
  maxChildProcesses: 50,
  checkIntervalMs: 3000,
}

// ═══════════════════════════════════════════════════════════
// 跨平台命令构建
// ═══════════════════════════════════════════════════════════

function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * 获取单进程的内存 & CPU 累计时间
 *
 * Windows: 用 powershell 一次性获取所有字段
 *   $p.WorkingSet64      → 物理内存 (bytes)
 *   $p.TotalProcessorTime.TotalMilliseconds → CPU 累计时间 (ms)
 *
 * Unix (预留): ps -o rss=,cputime= -p <pid>
 */
async function queryProcessMetrics(pid: number): Promise<{ memoryMB: number; cpuMs: number } | null> {
  try {
    if (isWindows()) {
      const stdout = await execPromise(
        `powershell -NoProfile -NonInteractive -Command "` +
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
        `if ($p) { Write-Output (\\"$($p.WorkingSet64)|$($p.TotalProcessorTime.TotalMilliseconds)\\" ) }"`
      )
      const trimmed = stdout.trim()
      if (!trimmed || trimmed.includes('|NaN') || trimmed === '|') return null

      const parts = trimmed.split('|')
      if (parts.length < 2) return null

      const memBytes = parseInt(parts[0], 10)
      const cpuMs = parseFloat(parts[1])

      if (isNaN(memBytes) || isNaN(cpuMs)) return null

      return {
        memoryMB: memBytes / (1024 * 1024),
        cpuMs,
      }
    } else {
      // 🔧 Unix 占位：ps 输出格式
      // rss 以 KB 为单位，需要除 1024 得到 MB
      // cputime 格式 [dd-]hh:mm:ss 需要解析
      const stdout = await execPromise(`ps -o rss=,cputime= -p ${pid} 2>/dev/null || true`)
      const trimmed = stdout.trim()
      if (!trimmed) return null

      const [rssKb, cputime] = trimmed.split(/\s+/)
      const memoryMB = parseInt(rssKb, 10) / 1024
      const cpuMs = parseCpuTime(cputime)

      if (isNaN(memoryMB) || isNaN(cpuMs)) return null
      return { memoryMB, cpuMs }
    }
  } catch {
    return null
  }
}

/**
 * 获取子进程数量：通过 ParentProcessId 匹配
 *
 * Windows: wmic process where "ParentProcessId=<pid>" get ProcessId
 * Unix: pgrep -P <pid> | wc -l
 */
async function queryChildCount(pid: number): Promise<number> {
  try {
    if (isWindows()) {
      const stdout = await execPromise(
        `wmic process where "ParentProcessId=${pid}" get ProcessId /format:csv`
      )
      // wmic csv 输出格式: Node,ProcessId\n<hostname>,<pid>\n...
      const lines = stdout.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('Node') && !l.startsWith('ProcessId'))
      return lines.length
    } else {
      const stdout = await execPromise(`pgrep -P ${pid} 2>/dev/null | wc -l || echo 0`)
      return parseInt(stdout.trim(), 10) || 0
    }
  } catch {
    return 0
  }
}

/**
 * 解析 Unix ps cputime 格式 [dd-]hh:mm:ss → ms
 */
function parseCpuTime(input: string): number {
  if (!input || input === '-') return 0
  const match = input.match(/^(?:(\d+)-)?(\d+):(\d+):(\d+)$/)
  if (!match) return 0
  const days = parseInt(match[1] || '0', 10)
  const hours = parseInt(match[2], 10)
  const minutes = parseInt(match[3], 10)
  const seconds = parseInt(match[4], 10)
  return ((days * 86400) + (hours * 3600) + (minutes * 60) + seconds) * 1000
}

/**
 * exec 的 Promise 包装
 */
function execPromise(cmd: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 }, (err, stdout) => {
      if (err) {
        // 非零退出码不一定意味着失败（比如 wmic 找不到进程）
        // 有 stdout 内容就算成功
        if (stdout && stdout.trim()) {
          resolve(stdout)
        } else {
          reject(err)
        }
      } else {
        resolve(stdout)
      }
    })
  })
}

// ═══════════════════════════════════════════════════════════
// ShellMonitor 类
// ═══════════════════════════════════════════════════════════

export class ShellMonitor {
  private thresholds: MonitorThresholds
  private previousCpuSample: Map<number, { cpuMs: number; sampledAt: number }> = new Map()
  private highCpuSince: Map<number, number> = new Map()    // pid → timestamp (ms)
  private timer: ReturnType<typeof setInterval> | null = null
  private trackedPids: Set<number> = new Set()
  private violationCallbacks: Map<number, ViolationCallback> = new Map()
  private cpuCoreCount: number

  constructor(thresholds?: Partial<MonitorThresholds>) {
    this.thresholds = { ...DEFAULTS, ...thresholds }
    this.cpuCoreCount = os.cpus().length || 1
  }

  // ─── 公共方法 ────────────────────────────────────────────

  /**
   * 开始监控一个进程
   *
   * @param pid 要监控的进程 PID
   * @param onViolation 资源超限时的回调
   */
  start(pid: number, onViolation: ViolationCallback): void {
    if (this.trackedPids.has(pid)) {
      console.log(`[ShellMonitor] ⚠️ PID ${pid} 已在监控中，跳过重复注册`)
      return
    }

    this.trackedPids.add(pid)
    this.violationCallbacks.set(pid, onViolation)

    console.log(`[ShellMonitor] 🔍 开始监控 PID ${pid} (阈值: 内存≤${this.thresholds.maxMemoryMB}MB, CPU≤${this.thresholds.maxCpuPercent}%×${this.thresholds.maxCpuDurationSec}s, 子进程≤${this.thresholds.maxChildProcesses})`)

    // 立即采样一次作为 baseline（为 CPU 差值做准备）
    this.sampleProcess(pid).catch(() => {})

    if (!this.timer) {
      this.timer = setInterval(() => this.checkAll(), this.thresholds.checkIntervalMs)
      // 允许进程正常退出时停止 timer
      this.timer.unref()
    }
  }

  /**
   * 停止监控指定进程（进程正常结束时调用）
   */
  stop(pid: number): void {
    this.trackedPids.delete(pid)
    this.previousCpuSample.delete(pid)
    this.highCpuSince.delete(pid)
    this.violationCallbacks.delete(pid)
    console.log(`[ShellMonitor] ✅ PID ${pid} 监控已停止`)

    // 没有进程在监控了，停止 timer
    if (this.trackedPids.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 停止所有监控
   */
  stopAll(): void {
    this.trackedPids.clear()
    this.previousCpuSample.clear()
    this.highCpuSince.clear()
    this.violationCallbacks.clear()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    console.log(`[ShellMonitor] 🛑 所有监控已停止`)
  }

  /**
   * 获取当前正在监控的 PID 列表
   */
  getTrackedPids(): number[] {
    return [...this.trackedPids]
  }

  /**
   * 获取当前阈值配置（副本）
   */
  getThresholds(): MonitorThresholds {
    return { ...this.thresholds }
  }

  // ─── 内部方法 ────────────────────────────────────────────

  /**
   * 轮询所有被跟踪的进程
   */
  private async checkAll(): Promise<void> {
    const deadPids: number[] = []

    for (const pid of this.trackedPids) {
      try {
        const metrics = await this.sampleProcess(pid)
        if (!metrics) {
          // 进程已结束，不需要再检查
          deadPids.push(pid)
          continue
        }

        await this.evaluateViolations(pid, metrics)
      } catch (err) {
        // 采样异常 → 可能是进程已死，下次清理
        deadPids.push(pid)
      }
    }

    // 清理已结束的进程
    for (const pid of deadPids) {
      this.stop(pid)
    }
  }

  /**
   * 采样单个进程的当前资源用量
   */
  private async sampleProcess(pid: number): Promise<ProcessMetrics | null> {
    const base = await queryProcessMetrics(pid)
    if (!base) return null

    const memoryMB = base.memoryMB

    // ── CPU 百分比计算 ──
    let cpuPercent = 0
    const prev = this.previousCpuSample.get(pid)
    const now = Date.now()

    if (prev) {
      const dtMs = now - prev.sampledAt
      if (dtMs > 0 && base.cpuMs >= prev.cpuMs) {
        const dcpuMs = base.cpuMs - prev.cpuMs
        // CPU% = (CPU 时间增量 / 实际时间增量) / 核心数 * 100
        cpuPercent = (dcpuMs / dtMs) / this.cpuCoreCount * 100
        // 将很小的值归零
        if (cpuPercent < 0.5) cpuPercent = 0
      }
    }

    this.previousCpuSample.set(pid, { cpuMs: base.cpuMs, sampledAt: now })

    // ── 子进程数量 ──
    const childProcessCount = await queryChildCount(pid)

    return { pid, memoryMB, cpuPercent, childProcessCount, sampledAt: now }
  }

  /**
   * 评估资源是否超限
   */
  private async evaluateViolations(pid: number, metrics: ProcessMetrics): Promise<void> {
    const cb = this.violationCallbacks.get(pid)
    if (!cb) return
    const now = metrics.sampledAt

    // 1️⃣ 内存超限 → 立即 kill
    if (metrics.memoryMB > this.thresholds.maxMemoryMB) {
      cb({
        type: 'memory',
        pid,
        metrics,
        threshold: this.thresholds.maxMemoryMB,
        message:
          `📊 内存超限: ${metrics.memoryMB.toFixed(0)}MB > ${this.thresholds.maxMemoryMB}MB` +
          ` | PID ${pid} 已强制终止`,
      })
      return
    }

    // 2️⃣ 子进程超限 → 立即 kill（fork 炸弹信号）
    if (metrics.childProcessCount > this.thresholds.maxChildProcesses) {
      cb({
        type: 'childProcess',
        pid,
        metrics,
        threshold: this.thresholds.maxChildProcesses,
        message:
          `🔱 子进程数量超限: ${metrics.childProcessCount} 个 > ${this.thresholds.maxChildProcesses} 个` +
          ` | 疑似 fork 炸弹，PID ${pid} 整树已杀灭`,
      })
      return
    }

    // 3️⃣ CPU 持续超限 → 等待 maxCpuDurationSec 后 kill
    if (metrics.cpuPercent > this.thresholds.maxCpuPercent) {
      const since = this.highCpuSince.get(pid)
      if (!since) {
        // 首次检测到 CPU 超限
        this.highCpuSince.set(pid, now)
        console.log(
          `[ShellMonitor] ⚠️ PID ${pid} CPU ${metrics.cpuPercent.toFixed(0)}% > ${this.thresholds.maxCpuPercent}%` +
          ` (持续 ${this.thresholds.maxCpuDurationSec}s 后 kill)`
        )
      } else {
        const elapsedSec = (now - since) / 1000
        if (elapsedSec >= this.thresholds.maxCpuDurationSec) {
          cb({
            type: 'cpu',
            pid,
            metrics,
            threshold: this.thresholds.maxCpuPercent,
            message:
              `🔥 CPU ${metrics.cpuPercent.toFixed(0)}% > ${this.thresholds.maxCpuPercent}%` +
              ` 持续 ${elapsedSec.toFixed(0)}s >= ${this.thresholds.maxCpuDurationSec}s` +
              ` | PID ${pid} 已强制终止`,
          })
          return
        }
        // 持续但没到上限——记录日志（每 5 次 only）
        if (Math.floor(elapsedSec * 10) % 5 === 0) {
          console.log(
            `[ShellMonitor] 🔥 PID ${pid} CPU ${metrics.cpuPercent.toFixed(0)}% (已持续 ${elapsedSec.toFixed(0)}s / ${this.thresholds.maxCpuDurationSec}s)`
          )
        }
      }
    } else {
      // CPU 恢复正常，清除超限计时
      if (this.highCpuSince.has(pid)) {
        console.log(`[ShellMonitor] ✅ PID ${pid} CPU 已恢复正常 (${metrics.cpuPercent.toFixed(0)}%)`)
        this.highCpuSince.delete(pid)
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let _globalMonitor: ShellMonitor | null = null

/**
 * 获取全局 ShellMonitor 单例
 */
export function getShellMonitor(): ShellMonitor {
  if (!_globalMonitor) {
    _globalMonitor = new ShellMonitor()
  }
  return _globalMonitor
}

export function resetShellMonitor(): void {
  if (_globalMonitor) {
    _globalMonitor.stopAll()
    _globalMonitor = null
  }
}
