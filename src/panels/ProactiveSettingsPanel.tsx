// src/panels/ProactiveSettingsPanel.tsx — AI 主动推送设置
import React, { useState, useEffect } from 'react'

interface PushState {
  fatigue: number
  intimacy: number
  luminaEnergy: number
  todayPushCount: number
  consecutiveIgnored: number
}

interface PushSettings {
  enabled: boolean
  maxPerDay: number
  cooldownMinutes: number
  quietHoursStart: string
  quietHoursEnd: string
  allowedTypes: string[]
}

const PUSH_TYPES = [
  { key: 'greeting', label: '问候' },
  { key: 'care', label: '关心' },
  { key: 'share', label: '分享' },
  { key: 'reminder', label: '提醒' },
  { key: 'chat', label: '闲聊' },
]

export default function ProactiveSettingsPanel() {
  const [state, setState] = useState<PushState | null>(null)
  const [settings, setSettings] = useState<PushSettings | null>(null)
  const [lastResult, setLastResult] = useState<string>('')

  useEffect(() => {
    load()
  }, [])

  async function load() {
    try {
      const s = await (window as any).luminaAPI?.proactiveGetState?.()
      const cfg = await (window as any).luminaAPI?.proactiveGetSettings?.()
      setState(s)
      setSettings(cfg)
    } catch { /* ignore */ }
  }

  async function save(patch: Partial<PushSettings>) {
    if (!settings) return
    const next = { ...settings, ...patch }
    setSettings(next)
    try {
      await (window as any).luminaAPI?.proactiveUpdateSettings?.(patch)
    } catch { /* ignore */ }
  }

  async function toggle(enabled: boolean) {
    try {
      await (window as any).luminaAPI?.proactiveToggle?.(enabled)
      await load()
    } catch { /* ignore */ }
  }

  async function pushNow() {
    try {
      const r = await (window as any).luminaAPI?.proactivePushNow?.()
      setLastResult(r.should_speak ? `已推送：${r.reason}` : `未推送：${r.reason}`)
      await load()
    } catch (e: any) {
      setLastResult(`错误：${e?.message || e}`)
    }
  }

  function toggleType(type: string) {
    if (!settings) return
    const has = settings.allowedTypes.includes(type)
    const next = has
      ? settings.allowedTypes.filter(t => t !== type)
      : [...settings.allowedTypes, type]
    save({ allowedTypes: next })
  }

  function Bar({ label, value, color }: { label: string; value: number; color: string }) {
    return (
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
          <span>{label}</span>
          <span style={{ opacity: 0.7 }}>{Math.round(value * 100)}%</span>
        </div>
        <div style={{ height: 8, background: 'rgba(255,255,255,0.1)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${value * 100}%`, background: color, borderRadius: 4, transition: 'width 0.3s' }} />
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 20, maxWidth: 560 }}>
      <h2 style={{ fontSize: 18, marginBottom: 16 }}>AI 主动推送</h2>

      {/* 总开关 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, padding: 12, background: 'rgba(255,255,255,0.05)', borderRadius: 8 }}>
        <div>
          <div style={{ fontWeight: 600 }}>启用主动推送</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>Lumina 会在合适的时候主动跟你说话</div>
        </div>
        <button
          onClick={() => toggle(!settings?.enabled)}
          style={{
            padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
            background: settings?.enabled ? '#4ade80' : '#6b7280', color: '#fff', fontWeight: 600,
          }}
        >
          {settings?.enabled ? '已开启' : '已关闭'}
        </button>
      </div>

      {/* 三维状态 */}
      <div style={{ marginBottom: 20, padding: 12, background: 'rgba(255,255,255,0.05)', borderRadius: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>当前状态</div>
        {state && (
          <>
            <Bar label="用户疲劳度" value={state.fatigue} color="#f87171" />
            <Bar label="亲密度" value={state.intimacy} color="#f472b6" />
            <Bar label="Lumina 精力" value={state.luminaEnergy} color="#60a5fa" />
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
              今日已推送 {state.todayPushCount} 次 · 连续未响应 {state.consecutiveIgnored} 次
            </div>
          </>
        )}
      </div>

      {/* 频率设置 */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>频率控制</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
          <label style={{ fontSize: 13, width: 100 }}>每日上限</label>
          <input
            type="number" min={1} max={20} value={settings?.maxPerDay ?? 5}
            onChange={e => save({ maxPerDay: parseInt(e.target.value) || 5 })}
            style={{ width: 60, padding: 4, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 4, color: '#fff' }}
          />
          <span style={{ fontSize: 12, opacity: 0.7 }}>次</span>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
          <label style={{ fontSize: 13, width: 100 }}>最小间隔</label>
          <input
            type="number" min={5} max={240} value={settings?.cooldownMinutes ?? 30}
            onChange={e => save({ cooldownMinutes: parseInt(e.target.value) || 30 })}
            style={{ width: 60, padding: 4, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 4, color: '#fff' }}
          />
          <span style={{ fontSize: 12, opacity: 0.7 }}>分钟</span>
        </div>
      </div>

      {/* 静默时段 */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>静默时段（不推送）</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="time" value={settings?.quietHoursStart ?? '23:00'}
            onChange={e => save({ quietHoursStart: e.target.value })}
            style={{ padding: 4, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 4, color: '#fff' }}
          />
          <span>~</span>
          <input
            type="time" value={settings?.quietHoursEnd ?? '08:00'}
            onChange={e => save({ quietHoursEnd: e.target.value })}
            style={{ padding: 4, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 4, color: '#fff' }}
          />
        </div>
      </div>

      {/* 推送类型 */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>允许的推送类型</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {PUSH_TYPES.map(t => (
            <button
              key={t.key}
              onClick={() => toggleType(t.key)}
              style={{
                padding: '4px 12px', borderRadius: 16, border: '1px solid',
                borderColor: settings?.allowedTypes.includes(t.key) ? '#f472b6' : 'rgba(255,255,255,0.2)',
                background: settings?.allowedTypes.includes(t.key) ? 'rgba(244,114,182,0.2)' : 'transparent',
                color: '#fff', cursor: 'pointer', fontSize: 13,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* 手动触发 */}
      <div style={{ marginBottom: 16, padding: 12, background: 'rgba(255,255,255,0.05)', borderRadius: 8 }}>
        <button
          onClick={pushNow}
          style={{ padding: '8px 20px', background: '#f472b6', border: 'none', borderRadius: 6, color: '#fff', fontWeight: 600, cursor: 'pointer' }}
        >
          立即触发一次决策
        </button>
        {lastResult && <div style={{ fontSize: 12, opacity: 0.8, marginTop: 8 }}>{lastResult}</div>}
      </div>

      <div style={{ fontSize: 11, opacity: 0.5, lineHeight: 1.6 }}>
        推送只走桌宠气泡和侧边栏，不会弹系统通知打断你。连续未响应会自动降频。
      </div>
    </div>
  )
}
