// ============================================================
// moodstats/exporter.ts — 快照明细 + 聚合统计的导出
//
// 两种格式：
//   · CSV：带 UTF-8 BOM（防 Excel 打开中文乱码），RFC4180 转义；
//   · JSON：快照明细 + 聚合报告原样序列化。
//
// 纯函数，不碰 fs —— 写盘由调用方（IPC / register）负责，
// 这样单测可以直接断言字符串内容。
// ============================================================

import type { MoodSnapshot } from './types'
import type { StatsReport } from './stats'

/** UTF-8 BOM —— Excel 的中文 csv 没它必乱码（显式写出，不依赖编辑器是否保留字符） */
export const UTF8_BOM = '\uFEFF'

// ═══════════════════════════════════════════════════════════
// CSV
// ═══════════════════════════════════════════════════════════

export const SNAPSHOT_CSV_HEADER = [
  'ts', 'ts_iso', 'kind', 'agent_id', 'target_agent', 'action',
  'mood', 'energy', 'affinity', 'gate_on', 'gate_suppressed', 'gate_rules',
  'group', 'ok', 'error_summary', 'retries', 'duration_ms',
]

/** RFC4180 转义：含逗号 / 引号 / 换行 → 双引号包裹，内部双引号翻倍 */
export function escapeCsvCell(v: unknown): string {
  let s: string
  if (v === null || v === undefined) {s = ''}
  else if (typeof v === 'number') {s = Number.isFinite(v) ? String(v) : ''}
  else {s = String(v)}
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

function snapshotToRow(s: MoodSnapshot): string {
  return [
    s.ts,
    new Date(s.ts).toISOString(),
    s.kind,
    s.agentId,
    s.targetAgent ?? '',
    s.action,
    s.mood ?? '',
    s.energy ?? '',
    s.affinity ?? '',
    s.gateOn ? 1 : 0,
    s.gateSuppressed.join(';'),
    s.gateRules.join(';'),
    s.group,
    s.ok ? 1 : 0,
    s.errorSummary ?? '',
    s.retries,
    Math.round(s.durationMs),
  ].map(escapeCsvCell).join(',')
}

/** 快照明细 CSV（带 BOM） */
export function snapshotsToCsv(snaps: MoodSnapshot[]): string {
  const lines = [SNAPSHOT_CSV_HEADER.join(',')]
  for (const s of snaps) {
    lines.push(snapshotToRow(s))
  }
  return UTF8_BOM + lines.join('\r\n')
}

// ═══════════════════════════════════════════════════════════
// JSON
// ═══════════════════════════════════════════════════════════

export interface ExportBundle {
  kind: 'moodstats-export'
  exportedAt: number
  report: StatsReport
  snapshots: MoodSnapshot[]
}

export function buildExportJson(snaps: MoodSnapshot[], report: StatsReport): string {
  const bundle: ExportBundle = {
    kind: 'moodstats-export',
    exportedAt: Date.now(),
    report,
    snapshots: snaps,
  }
  return JSON.stringify(bundle, null, 2)
}
