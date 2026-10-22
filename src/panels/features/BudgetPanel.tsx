// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// src/panels/features/BudgetPanel.tsx — 预算守护者设置区
//
// 展示：总开关、档位/自定义预算、今日花费与剩余、各功能花费列表、
//       审计日志、手动「本轮放行」。
// 数据来源：window.luminaAPI.budget*（electron/billing/billingIpc.ts）
// 诚实原则：估算调用在界面上显式标注「估算」。
// ============================================================

import { useEffect, useState } from 'react'

interface BudgetSummary {
  level: 'ok' | 'warn' | 'degrade' | 'hard'
  costYuan: number
  budgetYuan: number
  ratio: number
  remainingYuan: number
  dateKey: string
  actions: string[]
  tokens: { prompt: number; completion: number; total: number; calls: number; estimatedCalls: number }
  byPurpose: Record<string, { cost: number; totalTokens: number; calls: number; estimatedCalls: number }>
  byProvider: Record<string, { cost: number }>
  config: {
    enabled: boolean
    dailyBudgetYuan: number
    warnRatio: number
    degradeRatio: number
    hardRatio: number
    dailyTokenBudget?: number | null
  }
}

interface AuditItem {
  id: string
  ts: number
  level: string
  costYuan: number
  ratio: number
  threshold: number
  actions: string[]
  status: string
  overrideReason?: string
}

const PURPOSE_LABEL: Record<string, string> = {
  chat: '用户对话',
  proactive: '主动搭话/简报',
  social: '社交引擎',
  review: '审查',
  decision: '决策',
  ritual: '仪式',
  delegate: '委托子 Agent',
  other: '其他',
}

const LEVEL_LABEL: Record<string, string> = {
  ok: '正常',
  warn: '精打细算（≥80%）',
  degrade: '已降级（≥95%）',
  hard: '硬限制（≥100%）',
}

const TIERS = [0.5, 1, 2, 5]

export default function BudgetPanel() {
  const [summary, setSummary] = useState<BudgetSummary | null>(null)
  const [audit, setAudit] = useState<AuditItem[]>([])
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(true)

  async function refresh() {
    const [s, a] = await Promise.all([
      window.luminaAPI.budgetSummary(),
      window.luminaAPI.budgetAudit(),
    ])
    if (s.ok && s.summary) {setSummary(s.summary)}
    if (a.ok && a.audit) {setAudit(a.audit)}
    setLoading(false)
  }

  useEffect(() => {refresh()}, [])

  async function setConfig(patch: Record<string, unknown>) {
    const r = await window.luminaAPI.budgetSetConfig(patch)
    if (r.ok && r.summary) {setSummary(r.summary)}
    setMsg(r.ok ? '已保存' : `保存失败：${r.error}`)
    setTimeout(() => setMsg(''), 2500)
  }

  async function override() {
    const r = await window.luminaAPI.budgetOverride('用户在设置面板手动本轮放行')
    setMsg(r.ok ? '已放行本轮（一次性，下一轮仍超阈值会继续收紧）' : `放行失败：${r.error}`)
    if (r.summary) {setSummary(r.summary)}
    await refresh()
    setTimeout(() => setMsg(''), 4000)
  }

  if (loading || !summary) {
    return <div style={{ padding: 16, color: 'var(--text-secondary)' }}>加载预算数据…</div>
  }

  const cfg = summary.config
  const ratioPct = Math.round(summary.ratio * 100)
  const barColor = summary.level === 'ok' ? '#22c55e' : summary.level === 'warn' ? '#eab308' : summary.level === 'degrade' ? '#f97316' : '#ef4444'

  return (
    <div style={{ padding: 16, maxWidth: 720 }}>
      <h3 style={{ margin: '0 0 4px' }}>💰 预算守护者</h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-secondary)' }}>
        每天的 LLM 花费都从这里看起。原则：只收紧不放宽——花到阈值只会更省，不会自动放开；次日 0 点（本地时区）重置。
      </p>

      {/* 总开关 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <label style={{ fontSize: 13 }}>
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={e => setConfig({ enabled: e.target.checked })}
          />{' '}
          启用预算守护
        </label>
        <span style={{
          fontSize: 12, padding: '2px 8px', borderRadius: 10,
          background: barColor + '22', color: barColor,
        }}>
          {LEVEL_LABEL[summary.level] || summary.level}
        </span>
      </div>

      {/* 今日花费 */}
      <div style={{
        background: 'var(--surface-0)', border: '1px solid var(--border-light)',
        borderRadius: 10, padding: 14, marginBottom: 14,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
          <span>今日花费</span>
          <span>
            <b style={{ fontSize: 18 }}>¥{summary.costYuan.toFixed(4)}</b>
            {' / ¥'}{summary.budgetYuan.toFixed(2)}
            {' · 剩 '}¥{summary.remainingYuan.toFixed(4)}
          </span>
        </div>
        <div style={{ height: 8, background: 'var(--border-light)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ width: `${Math.min(ratioPct, 100)}%`, height: '100%', background: barColor }} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>
          占比 {ratioPct}% · 今日 {summary.tokens.calls} 次调用
          {summary.tokens.estimatedCalls > 0 && (
            <span>（其中 <b style={{ color: '#eab308' }}>{summary.tokens.estimatedCalls}</b> 次 token 数为字符估算，费用仅作参考）</span>
          )}
        </div>
        {summary.actions.length > 0 && (
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: barColor }}>
            {summary.actions.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        )}
      </div>

      {/* 档位 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>每日预算档位（元/天）</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {TIERS.map(t => (
            <button
              key={t}
              onClick={() => setConfig({ dailyBudgetYuan: t, dailyTokenBudget: null })}
              style={{
                padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
                border: '1px solid var(--border-light)',
                background: cfg.dailyBudgetYuan === t ? '#3b82f622' : 'transparent',
                fontWeight: cfg.dailyBudgetYuan === t ? 700 : 400,
              }}>
              ¥{t}/天
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>
          默认 ¥1/天（保守档）。
        </div>
      </div>

      {/* 各功能花费 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>今日各功能花费</div>
        {Object.keys(summary.byPurpose).length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>今天还没有调用记录</div>
        )}
        {Object.entries(summary.byPurpose).map(([p, a]) => (
          <div key={p} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' }}>
            <span>{PURPOSE_LABEL[p] || p}</span>
            <span>¥{a.cost.toFixed(4)}（{a.calls} 次）</span>
          </div>
        ))}
      </div>

      {/* 审计日志 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
          <span>收紧审计</span>
          <button
            onClick={override}
            style={{
              fontSize: 12, padding: '3px 10px', cursor: 'pointer',
              border: '1px solid #3b82f6', borderRadius: 6, background: 'transparent', color: '#3b82f6',
            }}>
            本轮放行
          </button>
        </div>
        {audit.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>今天还没触发过收紧。</div>
        )}
        {audit.map(r => (
          <div key={r.id} style={{
            fontSize: 12, padding: '8px 10px', marginBottom: 6,
            border: '1px solid var(--border-light)', borderRadius: 8,
            background: r.status === 'overridden' ? 'var(--surface-0)' : 'transparent',
            opacity: r.status === 'overridden' ? 0.7 : 1,
          }}>
            <div>
              <b>{LEVEL_LABEL[r.level] || r.level}</b>
              {' · 累计 ¥'}{r.costYuan.toFixed(4)} / ¥{r.costYuan > 0 ? (r.costYuan / Math.max(r.ratio, 0.0001)).toFixed(2) : '?'}
              {' · 占比 '}{Math.round(r.ratio * 100)}%（阈值 {Math.round(r.threshold * 100)}%）
              {r.status === 'overridden' && <span style={{ color: '#3b82f6' }}> · 已本轮放行{r.overrideReason ? `（${r.overrideReason}）` : ''}</span>}
            </div>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: 'var(--text-secondary)' }}>
              {r.actions.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
          </div>
        ))}
      </div>

      {msg && <div style={{ fontSize: 12, color: '#3b82f6' }}>{msg}</div>}
    </div>
  )
}
