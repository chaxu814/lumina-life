// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// panels/features/MoodProductivityPanel.tsx — Mood × Productivity 看板
//
// 【这个面板回答的问题】
//   情绪门控（焦虑/疲劳时收紧工具名单）到底有没有用？
//   用用户自己的真实数据说话：情绪分桶 × 成功率、按天趋势、A/B 对照。
//
// 【诚实原则（与 stats.ts 同一套纪律，面板不许粉饰）】
//   · 每格都带样本量；样本 < 30 的格子显示「数据不足」，不显示百分比；
//   · A/B 对照只列数字，不写「门控有效/无效」；
//   · 对照组会**临时关闭情绪门控这个安全收紧机制** —— 红色警告亮出来。
//
// 【依赖】
//   数据走 IPC（moodstats: 前缀，见 electron/moodstats/ipc.ts）。
//   preload 白名单由集成阶段接入；未接线时面板显示「未启用」而不是白屏。
//   图表用纯 SVG，不引任何图表库。
// ============================================================

import React, { useCallback, useEffect, useState } from 'react'

// ── 样式（与 TheaterPanel 同一套 CSS 变量）─────────────────────────

const card: React.CSSProperties = {
  borderRadius: 12,
  border: '1px solid var(--border-light)',
  padding: 20,
  marginBottom: 16,
  background: 'var(--surface-0)',
  fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
}

const title: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }
const desc: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 12 }
const warn: React.CSSProperties = {
  fontSize: 11.5, color: '#991b1b', background: '#fef2f2',
  border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', marginBottom: 12, lineHeight: 1.6,
}
const okBox: React.CSSProperties = {
  fontSize: 12, color: '#166534', background: '#f0fdf4',
  border: '1px solid #bbf7d0', borderRadius: 8, padding: '6px 12px', marginBottom: 12,
}
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }
const th: React.CSSProperties = { padding: '6px 8px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: 600, borderBottom: '1px solid var(--border-light)' }
const td: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid var(--border-light)', color: 'var(--text-primary)' }

// ── 运行时类型（与主进程 Shape 一致即可，不引入 electron 类型）────────

interface BucketRow {
  moodBucket: string
  energyBucket: string
  n: number
  successRate: number | null
  avgRetries: number | null
  avgDurationMs: number | null
  trustworthy: boolean
}
interface TrendPoint { date: string; n: number; successRate: number | null }
interface GroupComparison {
  group: 'treatment' | 'control' | 'off'
  n: number; ok: number; fail: number
  successRate: number | null
  avgRetries: number | null; avgDurationMs: number | null
  trustworthy: boolean
}
/**
 * 分组对照的「真实形态」。
 *
 * 【为什么这里要有一个面板侧类型】
 * 主进程的 `stats.ts` 已经把标题和免责声明做成了**由数据决定的输出**
 * （`comparisonDesign()`），面板只负责原样渲染、不许自己编标题。
 * 但 preload 尚未接入的旧版本会返回没有这个字段的报告，
 * 所以这里用可选字段 + 兜底文案，保证降级时也只是文案退化，不会白屏。
 */
interface ComparisonDesign {
  kind: 'none' | 'observation' | 'single-arm' | 'crossover'
  title: string
  disclosure: string
  twoArms: boolean
}
interface StatsReport {
  generatedAt: number
  totalSnapshots: number
  buckets: BucketRow[]
  trend: TrendPoint[]
  groups: GroupComparison[]
  /** ⚠️ 这**不是** A/B 对照 —— 单机单用户下两臂无法同时存在 */
  groupsDesign?: ComparisonDesign
  honesty: { minSample: number; note: string }
}

// 防御性取 API：preload 白名单接入前也不报错
function api(): any {
  return (window as any).luminaAPI ?? {}
}

const GROUP_LABEL: Record<string, string> = {
  treatment: '实验组（门控正常）',
  control: '对照组（门控关闭）',
  off: '未分组（仅观测）',
}

export default function MoodProductivityPanel() {
  const [report, setReport] = useState<StatsReport | null>(null)
  const [degraded, setDegraded] = useState(false)
  const [notRegistered, setNotRegistered] = useState(false)
  const [ab, setAb] = useState<any>(null)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api().moodstatsReport?.()
      if (r?.ok) {
        setReport(r.report)
        setDegraded(!!r.degraded)
        setNotRegistered(false)
      } else {
        setNotRegistered(true)
      }
      const a = await api().moodstatsAbGet?.()
      if (a?.ok) {setAb(a)}
    } catch {
      setNotRegistered(true)
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      await load()
      if (!alive) {return}
    })()
    return () => { alive = false }
  }, [load])

  const setExperiment = useCallback(async (on: boolean) => {
    setBusy(true)
    try {
      const a = await api().moodstatsAbSetEnabled?.(on)
      if (a?.ok) {setAb(a)}
      await load()
    } finally {
      setBusy(false)
    }
  }, [load])

  const optOut = useCallback(async () => {
    setBusy(true)
    try {
      const a = await api().moodstatsAbOptOut?.()
      if (a?.ok) {setAb(a)}
      await load()
    } finally {
      setBusy(false)
    }
  }, [load])

  const doExport = useCallback(async () => {
    setBusy(true)
    setExportMsg(null)
    try {
      const r = await api().moodstatsExport?.()
      if (r?.ok) {
        setExportMsg(`已导出：${r.csvPath}（${r.rows} 行）`)
      } else {
        setExportMsg(r?.error ?? '导出失败')
      }
    } finally {
      setBusy(false)
    }
  }, [])

  // ── 渲染 ──────────────────────────────────────────────

  if (notRegistered) {
    return (
      <div style={card}>
        <div style={title}>Mood × Productivity 看板</div>
        <div style={desc}>
          采集钩子尚未接线（moodstats 未注册）。接线后这里会显示情绪分桶 × 成功率、
          按天趋势与 A/B 对照。
        </div>
      </div>
    )
  }

  const minSample = report?.honesty?.minSample ?? 30

  // 趋势 SVG：每天一根柱，高度 = 成功率；样本不足的点画空心
  const trend = report?.trend ?? []
  const W = 560, H = 140, pad = 24
  const barW = trend.length > 0 ? Math.max(6, (W - pad * 2) / Math.max(trend.length, 1) - 4) : 0

  return (
    <div>
      {exportMsg && <div style={okBox}>{exportMsg}</div>}
      {degraded && (
        <div style={warn}>
          存储降级：better-sqlite3 不可用，当前数据只存在内存（可能有 JSONL 兜底），
          重启后历史可能丢失。
        </div>
      )}

      {/* ── 总览 + 诚实说明 ── */}
      <div style={card}>
        <div style={title}>Mood × Productivity 看板</div>
        <div style={desc}>
          共 {report?.totalSnapshots ?? 0} 条快照（委托 + 工具执行）。
          {report?.honesty?.note ?? ''}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={doExport} disabled={busy}
            style={{ fontSize: 12, padding: '6px 14px', borderRadius: 8, cursor: busy ? 'default' : 'pointer' }}>
            导出 CSV + JSON
          </button>
        </div>
      </div>

      {/* ── 情绪分桶表 ── */}
      <div style={card}>
        <div style={title}>情绪分桶 × 成功率</div>
        <div style={desc}>
          每格格式：成功率%（n = 样本量）。样本不足 {minSample} 的格子显示「数据不足」——
          小样本下的百分比只是噪声，不构成结论。
        </div>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>情绪档</th>
              <th style={th}>能量档</th>
              <th style={th}>成功率</th>
              <th style={th}>样本量</th>
              <th style={th}>平均重试</th>
              <th style={th}>平均耗时 ms</th>
            </tr>
          </thead>
          <tbody>
            {(report?.buckets ?? []).map((b, i) => (
              <tr key={i}>
                <td style={td}>{b.moodBucket}</td>
                <td style={td}>{b.energyBucket}</td>
                <td style={{ ...td, color: b.trustworthy ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                  {b.successRate === null
                    ? (b.n === 0 ? '—' : `数据不足（${b.n}/${minSample}）`)
                    : `${b.successRate}%`}
                </td>
                <td style={td}>{b.n}</td>
                <td style={td}>{b.avgRetries ?? '—'}</td>
                <td style={td}>{b.avgDurationMs ?? '—'}</td>
              </tr>
            ))}
            {(report?.buckets ?? []).length === 0 && (
              <tr><td style={td} colSpan={6}>还没有快照数据，用一阵就有了。</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── 按天趋势（纯 SVG）── */}
      <div style={card}>
        <div style={title}>按天成功率趋势</div>
        <div style={desc}>实心柱 = 当天样本 ≥ {minSample}；空心柱 = 样本不足，仅供参考。</div>
        {trend.length === 0
          ? <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>暂无按天数据</div>
          : (
            <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: 640 }}>
              <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="var(--border-light)" />
              {trend.map((t, i) => {
                const x = pad + i * ((W - pad * 2) / Math.max(trend.length, 1))
                const rate = t.successRate ?? 0.5
                const h = Math.max(4, (H - pad * 2) * (rate / 100))
                const y = H - pad - h
                const solid = t.successRate !== null
                return (
                  <g key={t.date}>
                    <rect x={x} y={y} width={barW} height={h}
                      fill={solid ? 'var(--accent, #3b82f6)' : 'none'}
                      stroke={solid ? 'none' : 'var(--text-secondary)'}
                      strokeDasharray="3 2" />
                    <text x={x + barW / 2} y={H - 8} fontSize={9}
                      fill="var(--text-secondary)" textAnchor="middle">
                      {t.date.slice(5)}
                    </text>
                    <title>{`${t.date}：n=${t.n}${t.successRate === null ? '（样本不足）' : `，成功率 ${t.successRate}%`}`}</title>
                    {!solid && <text x={x + barW / 2} y={y - 4} fontSize={9} fill="var(--text-secondary)" textAnchor="middle">n={t.n}</text>}
                  </g>
                )
              })}
            </svg>
          )}
      </div>

      {/* ── 分组对照（**不是** A/B 实验，见下方说明）── */}
      <div style={card}>
        <div style={title}>{report?.groupsDesign?.title ?? '门控前后对比（非对照实验）'}</div>
        <div style={desc}>
          {report?.groupsDesign?.disclosure ??
            '这是「门控关闭 vs 门控开启」的前后对比，不是严格对照实验：单个安装里两组无法同时存在，中间还混着你作息与任务难度的变化。'}
        </div>
        {report?.groupsDesign && !report.groupsDesign.twoArms && (
          <div style={desc}>
            ⚠️ 当前只有 {report.groupsDesign.kind === 'observation' ? '「未开启」一档' : '一臂'}数据，
            并排展示两列会让人误以为存在对照组 —— 所以这里只按实际有的分组列数字。
          </div>
        )}
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>分组</th>
              <th style={th}>样本量</th>
              <th style={th}>成功</th>
              <th style={th}>失败</th>
              <th style={th}>成功率</th>
              <th style={th}>平均重试</th>
              <th style={th}>平均耗时 ms</th>
            </tr>
          </thead>
          <tbody>
            {(report?.groups ?? []).map((g) => (
              <tr key={g.group}>
                <td style={td}>{GROUP_LABEL[g.group] ?? g.group}</td>
                <td style={td}>{g.n}</td>
                <td style={td}>{g.ok}</td>
                <td style={td}>{g.fail}</td>
                <td style={td}>
                  {g.successRate === null
                    ? (g.n === 0 ? '—' : `数据不足（${g.n}/${minSample}）`)
                    : `${g.successRate}%`}
                </td>
                <td style={td}>{g.avgRetries ?? '—'}</td>
                <td style={td}>{g.avgDurationMs ?? '—'}</td>
              </tr>
            ))}
            {(report?.groups ?? []).length === 0 && (
              <tr><td style={td} colSpan={7}>暂无分组数据。</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── 实验开关 ── */}
      <div style={card}>
        <div style={title}>实验设置</div>
        <div style={desc}>
          当前分组：<b>{ab?.currentGroup ?? '未知'}</b>
          （实验未开启 / 已退出时全部记为 off，只观测不干预）
        </div>
        <div style={warn}>
          ⚠️ 对照组会<b>临时关闭情绪门控</b>这一安全收紧机制——焦虑或疲劳时也会执行
          删文件、发邮件、桌面操控等高风险动作。如果你分到对照组并在意这一点，
          请立即退出实验。
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button onClick={() => setExperiment(!ab?.state?.enabled)} disabled={busy || ab?.state?.optedOut}
            style={{ fontSize: 12, padding: '6px 14px', borderRadius: 8 }}>
            {ab?.state?.enabled ? '关闭实验（回到仅观测）' : '开启实验'}
          </button>
          {!ab?.state?.optedOut
            ? (
              <button onClick={optOut} disabled={busy}
                style={{ fontSize: 12, padding: '6px 14px', borderRadius: 8, color: '#991b1b' }}>
                我要退出实验
              </button>
            )
            : (
              <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                已退出：停止干预，分组保留不重洗。
              </span>
            )}
        </div>
      </div>
    </div>
  )
}
