// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// panels/features/RitualsPanel.tsx — 仪式感闭环面板 v1.0
//
// 两个仪式（各自独立开关 + 时间可配）：
//   🌙 睡前复盘（默认 23:00）：消费当天 Day Replay，LLM/模板口播，TTS 播报
//   🌅 晨间简报（默认 08:00）：聚合天气/日历/待办/任务看板
//
// IPC 通道由集成阶段挂载（主进程 registerRituals 已注册）：
//   rituals:getStatus / rituals:setConfig / rituals:runNight / rituals:runMorning
// 所有调用都做可选守卫——通道未挂载时面板不崩，显示「待集成」。
// ============================================================

import React, { useState, useEffect, useCallback } from 'react'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

type Source = 'llm' | 'template' | 'skipped'

interface RunRecord {
  kind: 'night' | 'morning'
  at: number
  source: Source
  text?: string
  reason?: string
  delivered: 'tts' | 'bubble' | 'none'
  manual?: boolean
}

interface RitualsStatus {
  config: { nightTime: string; morningTime: string }
  nightEnabled: boolean
  morningEnabled: boolean
  night?: RunRecord
  morning?: RunRecord
  history: RunRecord[]
}

// ═══════════════════════════════════════════════════════════
// IPC 守卫调用（preload 方法由集成阶段补充，这里全部可选链）
// ═══════════════════════════════════════════════════════════

function api(): any {
  return (window as any).luminaAPI
}

async function getStatus(): Promise<RitualsStatus | null> {
  try {return await api()?.ritualsGetStatus?.() ?? null} catch {return null}
}

async function runNow(kind: 'night' | 'morning'): Promise<void> {
  try {await kind === 'night' ? api()?.ritualsRunNight?.() : api()?.ritualsRunMorning?.()} catch {/* ignore */}
}

async function patchConfig(patch: Record<string, unknown>): Promise<void> {
  try {await api()?.ritualsSetConfig?.(patch)} catch {/* ignore */}
}

// ═══════════════════════════════════════════════════════════
// 小组件
// ═══════════════════════════════════════════════════════════

function SourceBadge({ source }: { source?: Source }) {
  if (!source) {return null}
  const map: Record<string, { label: string; bg: string; color: string }> = {
    llm: { label: '✨ AI 生成', bg: 'rgba(34,197,94,0.15)', color: '#22c55e' },
    template: { label: '模板', bg: 'rgba(107,114,128,0.12)', color: 'var(--text-secondary)' },
    skipped: { label: '已跳过', bg: 'rgba(245,158,11,0.15)', color: '#f59e0b' },
  }
  const s = map[source]
  if (!s) {return null}
  return (
    <span style={{ padding: '1px 8px', borderRadius: 6, fontSize: 10, background: s.bg, color: s.color }}>
      {s.label}
    </span>
  )
}

function DeliveredTag({ delivered }: { delivered?: RunRecord['delivered'] }) {
  if (!delivered) {return null}
  const map = { tts: '🔊 TTS 播报', bubble: '💬 文字气泡', none: '（无呈现通道）' } as const
  return <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{map[delivered]}</span>
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
        background: checked ? '#22c55e' : 'var(--surface-100)',
        position: 'relative', transition: 'background 0.15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: checked ? 21 : 3,
        width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.15s',
      }} />
    </button>
  )
}

// ═══════════════════════════════════════════════════════════
// 主面板
// ═══════════════════════════════════════════════════════════

export default function RitualsPanel() {
  const [status, setStatus] = useState<RitualsStatus | null>(null)
  const [busy, setBusy] = useState<'night' | 'morning' | null>(null)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const s = await getStatus()
    setStatus(s)
    setLoaded(true)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleRun = async (kind: 'night' | 'morning') => {
    setBusy(kind)
    await runNow(kind)
    await refresh()
    setBusy(null)
  }

  const handleToggle = (kind: 'night' | 'morning', v: boolean) => {
    if (kind === 'night') {setStatus(s => s ? { ...s, nightEnabled: v } : s)}
    else {setStatus(s => s ? { ...s, morningEnabled: v } : s)}
    void patchConfig(kind === 'night' ? { nightEnabled: v } : { morningEnabled: v })
  }

  const handleTime = (kind: 'night' | 'morning', time: string) => {
    if (!/^\d{2}:\d{2}$/.test(time)) {return}
    setStatus(s => s ? {
      ...s,
      config: kind === 'night'
        ? { ...s.config, nightTime: time }
        : { ...s.config, morningTime: time },
    } : s)
    void patchConfig(kind === 'night' ? { nightTime: time } : { morningTime: time })
  }

  const ritualCard = (kind: 'night' | 'morning') => {
    const isNight = kind === 'night'
    const rec = isNight ? status?.night : status?.morning
    const enabled = isNight ? !!status?.nightEnabled : !!status?.morningEnabled
    const time = isNight ? status?.config.nightTime || '23:00' : status?.config.morningTime || '08:00'

    return (
      <div style={{
        padding: 16, borderRadius: 12, marginBottom: 12,
        background: 'var(--surface-0)', border: '1px solid var(--border-light)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>{isNight ? '🌙' : '🌅'}</span>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{isNight ? '睡前复盘' : '晨间简报'}</span>
            <Toggle checked={enabled} onChange={(v) => handleToggle(kind, v)} />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="time"
              value={time}
              onChange={(e) => handleTime(kind, e.target.value)}
              style={{
                padding: '4px 8px', borderRadius: 6, fontSize: 12,
                border: '1px solid var(--border-light)', background: 'var(--surface-100)',
                color: 'var(--text-primary)',
              }}
            />
            <button
              onClick={() => handleRun(kind)}
              disabled={busy === kind}
              style={{
                padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
                background: busy === kind ? 'var(--surface-100)' : (isNight ? '#8b5cf6' : '#f59e0b'),
                color: busy === kind ? 'var(--text-secondary)' : '#fff', fontSize: 12,
              }}
            >
              {busy === kind ? '播口中…' : '▶ 现在试一次'}
            </button>
          </div>
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          {isNight
            ? '消费当天 Day Replay 时间线，挑 2-3 个高光与一个小遗憾，30 秒温柔口播道晚安。'
            : '聚合天气、今日日程、待办与任务看板未完成项，组织成早安口播。'}
        </div>

        {/* 上次运行 */}
        <div style={{
          marginTop: 10, padding: 10, borderRadius: 8, fontSize: 11,
          background: 'var(--surface-100)', color: 'var(--text-secondary)',
          minHeight: 30,
        }}>
          {rec ? (
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <span>上次：{new Date(rec.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}{rec.manual ? '（手动）' : ''}</span>
                <SourceBadge source={rec.source} />
                <DeliveredTag delivered={rec.delivered} />
              </div>
              {rec.reason && <div style={{ color: '#f59e0b' }}>⚠ {rec.reason}</div>}
              {rec.text && rec.source !== 'skipped' && (
                <div style={{ color: 'var(--text-primary)', lineHeight: 1.6, marginTop: 4 }}>{rec.text}</div>
              )}
            </div>
          ) : (
            <div>还没有运行记录。打开开关，到点自动播；或点「现在试一次」立即体验。</div>
          )}
        </div>
      </div>
    )
  }

  if (!loaded) {
    return (
      <div style={{ padding: 20, display: 'flex', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
        加载仪式感配置中…
      </div>
    )
  }

  return (
    <div style={{ padding: 20, height: '100%', overflowY: 'auto' }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px 0' }}>✨ 仪式感闭环</h2>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 16px 0' }}>
        每天早晚各一次陪伴口播。预算超限时自动跳过（面板可见原因），不打扰你。
      </p>

      {ritualCard('night')}
      {ritualCard('morning')}

      <div style={{ fontSize: 10, color: 'var(--text-secondary)', opacity: 0.7, marginTop: 8 }}>
        口播标注「✨ AI 生成」为模型真实生成；「模板」为 LLM 未配置/失败时的离线兜底。
      </div>
    </div>
  )
}
