// ============================================================
// sandboxAudit.ts — 沙箱透明审计（I5，内存环形 buffer，零 electron 依赖）
//
// 记录每次命令安全评估的结果：
//   时间 / 命令摘要 / severity / 命中规则 / 处置（passed|degraded|blocked|approved）
// 环形 buffer 保留最近 200 条，供 SandboxPanel 实时展示「透明玻璃房」。
//
// 本模块不 import electron，主进程/渲染进程均可安全 import。
// IPC 暴露见 electron/ipc/sandboxAuditIpc.ts。
// ============================================================

import { evaluateCommand, type RuleHit } from './sandboxRules'

/** 处置结果：放行 / Low IL 降级 / 硬拦截 / 人工批准后放行 */
export type SandboxDisposition = 'passed' | 'degraded' | 'blocked' | 'approved'

export interface SandboxAuditEntry {
  /** 自增 id */
  id: number
  /** ISO 时间戳 */
  at: string
  /** 命令摘要（已截断，避免长命令撑爆 UI） */
  command: string
  /** 最高严重度（数值，见 Severity 枚举） */
  severity: number
  /** 中文级别名 */
  severityLabel: string
  /** 命中规则（id/类别/描述） */
  hits: Array<Pick<RuleHit, 'id' | 'category' | 'description'>>
  /** 本次处置 */
  disposition: SandboxDisposition
  /** 来源：shell_exec / cu_type / cu_key / cu_set_value */
  source: string
}

const MAX_ENTRIES = 200
const MAX_CMD_LEN = 200

let _buffer: SandboxAuditEntry[] = []
let _nextId = 1
// 今日统计（按本地自然日重置）
let _todayKey = todayKey()
let _stats = { intercepted: 0, degraded: 0, approved: 0, total: 0 }

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function maybeRotateDay(): void {
  const k = todayKey()
  if (k !== _todayKey) {
    _todayKey = k
    _stats = { intercepted: 0, degraded: 0, approved: 0, total: 0 }
  }
}

export interface RecordAuditOptions {
  /** 实际处置；不传则根据评估结果自动判定 */
  disposition?: SandboxDisposition
  /** 来源标签，默认 shell_exec */
  source?: string
}

/**
 * 评估并记录一条命令。
 * @returns 写入的审计条目
 */
export function recordSandboxAudit(command: string | undefined | null, opts: RecordAuditOptions = {}): SandboxAuditEntry | null {
  if (!command) {return null}
  const ev = evaluateCommand(command)
  maybeRotateDay()

  let disposition: SandboxDisposition
  if (opts.disposition) {
    disposition = opts.disposition
  } else if (ev.blocked) {
    disposition = 'blocked'
  } else if (ev.degraded) {
    disposition = 'degraded'
  } else {
    disposition = 'passed'
  }

  const entry: SandboxAuditEntry = {
    id: _nextId++,
    at: new Date().toISOString(),
    command: String(command).slice(0, MAX_CMD_LEN),
    severity: ev.severity,
    severityLabel: ((): string => {
      // 内联避免再 import severityLabel 的循环；与 sandboxRules.severityLabel 保持一致
      const labels = ['安全', '信息', '低', '中', '高', '严重', '阻断']
      return labels[ev.severity] || '未知'
    })(),
    hits: ev.hits.map(h => ({ id: h.id, category: h.category, description: h.description })),
    disposition,
    source: opts.source || 'shell_exec',
  }

  _buffer.push(entry)
  if (_buffer.length > MAX_ENTRIES) {_buffer.shift()}

  _stats.total += 1
  if (disposition === 'blocked') {_stats.intercepted += 1}
  else if (disposition === 'degraded') {_stats.degraded += 1}
  else if (disposition === 'approved') {_stats.approved += 1}

  return entry
}

/** 拉取审计日志（默认倒序，最新在前） */
export function getAuditLog(limit = MAX_ENTRIES): SandboxAuditEntry[] {
  maybeRotateDay()
  return _buffer.slice(-limit).slice().reverse()
}

/** 今日统计 */
export function getAuditStats(): { day: string; intercepted: number; degraded: number; approved: number; total: number; buffered: number } {
  maybeRotateDay()
  return {
    day: _todayKey,
    intercepted: _stats.intercepted,
    degraded: _stats.degraded,
    approved: _stats.approved,
    total: _stats.total,
    buffered: _buffer.length,
  }
}

/** 测试用：清空 */
export function _resetAuditForTest(): void {
  _buffer = []
  _nextId = 1
  _stats = { intercepted: 0, degraded: 0, approved: 0, total: 0 }
}
