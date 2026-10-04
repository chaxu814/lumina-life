// ============================================================
// panels/MemoryTrialBenchPanel.tsx — 记忆审判台
//
// 这是「我们反幻觉」对用户可见的那一面：把每条记忆的来源、证据、置信度、
// 被引用次数摊开，并且给用户一个能真的生效的「这条记错了」按钮。
//
// 【为什么不自己算置信度】
// 置信度的权威性只由 source 决定，这条铁律由 electron/memory/trialBench.ts 里的
// applyVerdictToConfidence 守着。本面板只 import 它的**类型**，
// 一个字的可信度数学都不在这里重写 —— 前端算出来的数字永远不作数。
//
// 【为什么所有 IPC 调用都包在 ?. 和 try/catch 里】
// memoryTrial* 这几个 preload 方法此刻还不存在（主线程负责接线）。
// 面板必须做到：接口没接线时**诚实显示「接口未接线」**，而不是整页白屏。
// 一个诚实报错的空面板，比一个假装成功然后什么都不做的面板强得多。
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { TrialRecord, TrialStats, TrialVerdict, TrialViewModel } from '../../electron/memory/trialBench'

// ── preload 桥（此刻尚未接线，所以全部可选）──────────────

interface MemoryTrialBridge {
  memoryTrialReview?: () => Promise<{ ok: boolean; items?: TrialViewModel[]; error?: string }>
  memoryTrialSubmit?: (params: { memoryKey: string; verdict: TrialVerdict; reason?: string }) =>
    Promise<{ ok: boolean; record?: TrialRecord; error?: string }>
  memoryTrialStats?: () => Promise<{ ok: boolean; stats?: TrialStats; error?: string }>
  memoryTrialHistory?: (memoryKey?: string) => Promise<{ ok: boolean; records?: TrialRecord[]; error?: string }>
}

/**
 * 取桥接对象。
 * 用 `as unknown as` 而不是 `as any`：全局 Window.luminaAPI 是在 src/types.d.ts 里
 * 写死的接口，main thread 还没把 memoryTrial* 加进去。整体收窄成上面这个
 * 最小接口，编译期就能守住「只用这四个方法」，也不会顺手用出别的 API。
 */
function bridge(): MemoryTrialBridge | null {
  const w = window as unknown as { luminaAPI?: MemoryTrialBridge }
  return w.luminaAPI ?? null
}

function errText(e: unknown): string {
  if (e instanceof Error) {return e.message}
  if (typeof e === 'string') {return e}
  return '未知错误'
}

// ── 展示辅助 ─────────────────────────────────────────────

const LIFECYCLE_TEXT: Record<TrialViewModel['lifecycle'], string> = {
  confirmed: '已确认',
  pending: '待核实',
  outdated: '已过时',
  contradicted: '被证伪',
}

const LIFECYCLE_CLASS: Record<TrialViewModel['lifecycle'], string> = {
  confirmed: 'bg-green-100 text-green-500',
  pending: 'bg-yellow-100 text-yellow-500',
  outdated: 'bg-surface-0-100 text-secondary',
  contradicted: 'bg-red-100 text-red-500',
}

const VERDICT_TEXT: Record<TrialVerdict, string> = {
  confirmed: '已确认',
  disputed: '记错了',
  pending: '待核实',
}

/** 三种来源必须一眼可分：绿色=最可信，蓝色=用户说的，黄色+警告=模型自己猜的 */
function sourceBadgeClass(source: TrialViewModel['source']): string {
  if (source === 'user_confirmed') {return 'bg-green-100 text-green-500'}
  if (source === 'user_stated') {return 'bg-accent-50 text-accent-600'}
  return 'bg-yellow-100 text-yellow-500'
}

/** 时间戳可能来自 SQLite 的 'YYYY-MM-DD HH:MM:SS'（无时区），统一兜成可读文本 */
function formatWhen(iso: string): string {
  if (!iso) {return '—'}
  let d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    // 无时区的本地时间字符串：Safari/部分引擎会判为 Invalid Date，补个空格分隔符
    d = new Date(iso.replace(' ', 'T'))
  }
  if (Number.isNaN(d.getTime())) {return iso}
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function pct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(v, 1)) * 100)}%`
}

// ── 组件 ─────────────────────────────────────────────────

export default function MemoryTrialBenchPanel() {
  const [items, setItems] = useState<TrialViewModel[]>([])
  const [stats, setStats] = useState<TrialStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [wired, setWired] = useState(true)
  const [busyKey, setBusyKey] = useState('')
  const [reasonFor, setReasonFor] = useState('')
  const [pendingKey, setPendingKey] = useState('')

  const refresh = useCallback(async () => {
    const api = bridge()
    if (!api?.memoryTrialReview) {
      // 诚实报「没接线」，而不是 setError 假装是数据问题
      setWired(false)
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const r = await api.memoryTrialReview()
      if (!r || r.ok === false) {
        setError(r?.error || '读取审判台失败（主进程未返回结果）')
        setItems([])
        return
      }
      setWired(true)
      setItems(Array.isArray(r.items) ? r.items : [])
      // 统计是独立的接口：它挂掉不该让整页没数据，所以单独兜一份
      try {
        const s = await api.memoryTrialStats?.()
        if (s && s.ok !== false) {setStats(s.stats ?? null)}
      } catch (e) {
        console.warn('[MemoryTrialBench] 统计读取失败，列表仍可用：', errText(e))
      }
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const submit = useCallback(async (memoryKey: string, verdict: TrialVerdict) => {
    const api = bridge()
    if (!api?.memoryTrialSubmit) {
      setError('接口未接线：memoryTrialSubmit 尚不可用，裁决没有被记录')
      return
    }
    setBusyKey(memoryKey)
    setError('')
    try {
      const r = await api.memoryTrialSubmit({
        memoryKey,
        verdict,
        ...(verdict === 'disputed' && reasonFor.trim() ? { reason: reasonFor.trim() } : {}),
      })
      if (!r || r.ok === false) {
        setError(r?.error || '裁决提交失败')
        return
      }
      // 落库失败必须显形：记忆可能只改了内存权重，库里没变
      if (r.record?.sinkError) {
        setError(`裁决已记录，但回写记忆库失败：${r.record.sinkError}`)
      }
      setReasonFor('')
      setPendingKey('')
      await refresh()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusyKey('')
    }
  }, [reasonFor, refresh])

  const topStats = useMemo(() => {
    const s = stats
    return [
      { label: '受审记忆', value: String(s?.total ?? items.length) },
      { label: '争议记忆', value: String(s?.disputedMemories ?? items.filter(i => i.verdict === 'disputed').length) },
      { label: '被纠正次数', value: String(s?.corrections ?? 0) },
      { label: '争议率', value: s ? pct(s.disputeRate) : '—' },
    ]
  }, [stats, items])

  // ── 加载 / 错误 / 未接线 ───────────────────────────
  if (!wired) {
    return (
      <div className="flex flex-col gap-3 p-3 text-sm text-secondary">
        <div className="card">
          <div className="text-md font-bold text-primary mb-1">⚖️ 记忆审判台</div>
          <div className="text-xs leading-relaxed">
            这是纠正 AI 记忆的入口：你看到的每条记忆都能看清来源、证据与置信度，
            发现记错的可以当场标「记错了」，反馈会真的回流到记忆权重。
          </div>
        </div>
        <div className="card border-yellow-500 text-xs text-yellow-500">
          接口未接线：<code>window.luminaAPI.memoryTrialReview</code> 尚不存在。
          主线程完成 preload / IPC 接线后，这里会自动开始工作。
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-3 text-sm text-secondary">
        <div className="card">正在把记忆摊开…</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-3 text-sm text-secondary">
      <div className="flex flex-col gap-2">
        <div className="text-md font-bold text-primary">⚖️ 记忆审判台</div>
        <div className="text-xs leading-relaxed">
          这是纠正 AI 记忆的入口。下面每一条都摊开了它的<b>来源</b>（谁说的决定了它有多可信）、
          <b>证据评分</b>、<b>置信度</b>、<b>被引用次数</b>。
          发现记错的，点「⚠️ 记错了」——你的纠正会真的下调它的记忆权重并标记为已被证伪，
          而不是简单删掉一条。
        </div>
        <div className="flex flex-row gap-2 flex-wrap">
          {topStats.map(s => (
            <div key={s.label} className="card flex-1 min-w-20 px-3 py-2">
              <div className="text-2xs text-secondary">{s.label}</div>
              <div className="text-md font-bold text-primary">{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="card border-red-500 text-xs text-red-500 flex flex-row items-center gap-2">
          <span className="flex-1">{error}</span>
          <button className="btn-sm bg-surface-0-100 text-primary" onClick={() => void refresh()}>重试</button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="card text-xs">
          还没有可审判的记忆。等 AI 记住一些东西之后，它们会出现在这里。
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map(item => (
            <div key={item.memoryKey} className="card flex flex-col gap-2">
              <div className="flex flex-row items-start gap-2">
                <div className="flex-1 flex flex-col gap-1">
                  <div className="text-sm text-primary break-words">{item.content || '（空内容）'}</div>
                  <div className="flex flex-row gap-1 flex-wrap items-center">
                    <span className={`tag ${sourceBadgeClass(item.source)}`}>
                      {item.source === 'model_inferred' ? '⚠️ ' : ''}{item.sourceLabel}
                    </span>
                    <span className={`tag ${LIFECYCLE_CLASS[item.lifecycle]}`}>{LIFECYCLE_TEXT[item.lifecycle]}</span>
                    {item.unverified && <span className="tag bg-yellow-100 text-yellow-500">未验证</span>}
                    {item.verdict && (
                      <span className={`tag ${item.verdict === 'disputed' ? 'bg-red-100 text-red-500' : 'bg-surface-0-100 text-secondary'}`}>
                        你的裁决：{VERDICT_TEXT[item.verdict]}
                        {item.disputeCount > 1 ? ` ×${item.disputeCount}` : ''}
                      </span>
                    )}
                    {!item.hasFactBinding && (
                      <span className="tag bg-surface-0-100 text-secondary">未落库（仅证据链）</span>
                    )}
                  </div>
                </div>

                <div className="flex flex-row gap-1 flex-shrink-0">
                  <button
                    className="btn-sm bg-green-100 text-green-500"
                    disabled={busyKey === item.memoryKey}
                    onClick={() => void submit(item.memoryKey, 'confirmed')}
                  >
                    ✅ 确认
                  </button>
                  <button
                    className="btn-sm bg-red-100 text-red-500"
                    disabled={busyKey === item.memoryKey}
                    onClick={() => {
                      if (pendingKey === item.memoryKey) {void submit(item.memoryKey, 'disputed')}
                      else {setPendingKey(item.memoryKey); setReasonFor('')}
                    }}
                  >
                    ⚠️ 记错了
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex flex-row items-center gap-2 text-2xs">
                  <span className="w-16 flex-shrink-0">置信度</span>
                  <div className="flex-1 h-2 rounded-full bg-surface-0-100 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: pct(item.confidence),
                        background: item.source === 'model_inferred' ? 'var(--yellow-500)' : 'var(--accent-500)',
                      }}
                    />
                  </div>
                  <span className="w-32 flex-shrink-0 text-right">
                    {pct(item.confidence)} / 上限 {pct(item.cap)}
                  </span>
                </div>
                <div className="flex flex-row gap-3 flex-wrap text-2xs">
                  <span>综合证据分 {pct(item.compositeScore)}</span>
                  <span>被引用 {item.mentionCount} 次</span>
                  <span>佐证来源 {item.sourceCount} 个</span>
                  <span>最后确认 {formatWhen(item.lastConfirmedAt)}</span>
                </div>
              </div>

              {pendingKey === item.memoryKey && (
                <div className="flex flex-col gap-1">
                  <textarea
                    className="w-full p-2 rounded-md border border-light bg-surface-0-0 text-primary text-xs"
                    rows={2}
                    autoFocus
                    placeholder="这条哪里错了？（可选。写下来的理由会跟着裁决一起留档）"
                    value={reasonFor}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReasonFor(e.target.value)}
                  />
                  <div className="flex flex-row gap-1">
                    <button
                      className="btn-sm bg-red-100 text-red-500"
                      disabled={busyKey === item.memoryKey}
                      onClick={() => void submit(item.memoryKey, 'disputed')}
                    >
                      确认记错
                    </button>
                    <button
                      className="btn-sm bg-surface-0-100 text-primary"
                      onClick={() => { setPendingKey(''); setReasonFor('') }}
                    >
                      取消
                    </button>
                    <span className="text-2xs self-center">
                      将把置信度下调（重复判错会累积更狠），并标记为已被证伪。
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
