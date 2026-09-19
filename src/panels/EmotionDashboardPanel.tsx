// ============================================================
// EmotionDashboardPanel.tsx — 情绪仪表盘 (P2)
// 展示所有 Agent 的情绪状态、趋势和互动关系
// ============================================================

import React, { useState, useEffect, useMemo } from 'react'

interface EmotionData {
  agentId: string
  agentName: string
  agentIcon: string
  mood: number      // -1 ~ +1
  energy: number    // 0 ~ 1
  affinity: number  // 0 ~ 1
  label: string
  history: Array<{ time: number; mood: number; energy: number }>
}

const AGENT_META: Record<string, { name: string; icon: string; color: string }> = {
  lumina: { name: 'Lumina', icon: '🐱', color: '#FF6B6B' },
  recha:  { name: '热茶',   icon: '🍵', color: '#448AFF' },
  yak:    { name: 'Yak',    icon: '📊', color: '#43A047' },
}

export default function EmotionDashboardPanel() {
  const [emotions, setEmotions] = useState<Record<string, EmotionData>>({})
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)

  // 加载情绪数据
  useEffect(() => {
    const loadEmotions = async () => {
      try {
        const api = (window as any).luminaAPI
        if (!api?.teamEmotions) {return}
        const data = await api.teamEmotions()
        if (data?.emotions) {
          const mapped: Record<string, EmotionData> = {}
          for (const [id, emo] of Object.entries(data.emotions)) {
            const meta = AGENT_META[id] || { name: id, icon: '🤖', color: '#999' }
            mapped[id] = {
              agentId: id,
              agentName: meta.name,
              agentIcon: meta.icon,
              mood: (emo as any).mood ?? 0.3,
              energy: (emo as any).energy ?? 0.7,
              affinity: (emo as any).affinity ?? 0.5,
              label: (emo as any).label || '平静',
              history: (emo as any).history || [],
            }
          }
          setEmotions(mapped)
        }
      } catch {}
    }
    loadEmotions()
    const interval = setInterval(loadEmotions, 5000)
    return () => clearInterval(interval)
  }, [])

  // 监听情绪变化
  useEffect(() => {
    const handler = (e: any) => {
      const { agentId, emotion } = e.detail || {}
      if (!agentId || !emotion) {return}
      setEmotions(prev => ({
        ...prev,
        [agentId]: {
          ...prev[agentId],
          mood: emotion.mood ?? prev[agentId]?.mood ?? 0.3,
          energy: emotion.energy ?? prev[agentId]?.energy ?? 0.7,
          affinity: emotion.affinity ?? prev[agentId]?.affinity ?? 0.5,
          label: emotion.label || prev[agentId]?.label || '平静',
        }
      }))
    }
    window.addEventListener('agent:emotion-auto', handler)
    window.addEventListener('agent:emotion-manual', handler)
    return () => {
      window.removeEventListener('agent:emotion-auto', handler)
      window.removeEventListener('agent:emotion-manual', handler)
    }
  }, [])

  const agentIds = useMemo(() => Object.keys(emotions).sort(), [emotions])
  const selected = selectedAgent ? emotions[selectedAgent] : null

  const getMoodColor = (mood: number) => {
    if (mood > 0.6) {return '#10b981'}
    if (mood > 0.2) {return '#3b82f6'}
    if (mood > -0.3) {return '#f59e0b'}
    return '#ef4444'
  }

  const getMoodEmoji = (mood: number) => {
    if (mood > 0.6) {return '😄'}
    if (mood > 0.2) {return '😊'}
    if (mood > -0.3) {return '😐'}
    if (mood > -0.6) {return '😔'}
    return '😢'
  }

  const getEnergyEmoji = (energy: number) => {
    if (energy > 0.7) {return '⚡'}
    if (energy > 0.4) {return '🔋'}
    if (energy > 0.2) {return '🪫'}
    return '😴'
  }

  const getAffinityEmoji = (affinity: number) => {
    if (affinity > 0.7) {return '❤️'}
    if (affinity > 0.4) {return '💛'}
    if (affinity > 0.2) {return '💙'}
    return '🩶'
  }

  return (
    <div style={{ padding: 20, height: '100%', overflowY: 'auto' }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>🎭 情绪仪表盘</h2>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 20 }}>
        实时追踪 Agent 们的心情、精力和亲密度
      </p>

      {/* Agent 卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, marginBottom: 24 }}>
        {agentIds.map(id => {
          const emo = emotions[id]
          if (!emo) {return null}
          const moodColor = getMoodColor(emo.mood)
          const moodPercent = Math.round((emo.mood + 1) / 2 * 100)
          const energyPercent = Math.round(emo.energy * 100)
          const affinityPercent = Math.round(emo.affinity * 100)
          
          return (
            <div 
              key={id} 
              onClick={() => setSelectedAgent(selectedAgent === id ? null : id)}
              style={{
                padding: 16, borderRadius: 12, cursor: 'pointer',
                background: selectedAgent === id ? 'var(--surface-100)' : 'var(--surface-0)',
                border: selectedAgent === id ? '2px solid var(--accent-500)' : '1px solid var(--border-light)',
                transition: 'all 0.2s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <span style={{ fontSize: 32 }}>{emo.agentIcon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: AGENT_META[id]?.color || 'var(--text-primary)' }}>
                    {emo.agentName}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {getMoodEmoji(emo.mood)} {emo.label}
                  </div>
                </div>
                <div style={{ 
                  fontSize: 24, 
                  color: moodColor,
                  filter: 'drop-shadow(0 0 4px ' + moodColor + '40)'
                }}>
                  {getMoodEmoji(emo.mood)}
                </div>
              </div>

              {/* 心情条 */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                  <span>😊 心情</span>
                  <span style={{ color: moodColor, fontWeight: 600 }}>{moodPercent}%</span>
                </div>
                <div style={{ width: '100%', height: 8, borderRadius: 4, background: 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                  <div style={{ 
                    width: `${moodPercent}%`, height: '100%', borderRadius: 4,
                    background: `linear-gradient(90deg, ${moodColor}80, ${moodColor})`,
                    transition: 'width 0.6s ease'
                  }} />
                </div>
              </div>

              {/* 精力条 */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                  <span>⚡ 精力</span>
                  <span style={{ color: '#f59e0b', fontWeight: 600 }}>{energyPercent}% {getEnergyEmoji(emo.energy)}</span>
                </div>
                <div style={{ width: '100%', height: 8, borderRadius: 4, background: 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                  <div style={{ 
                    width: `${energyPercent}%`, height: '100%', borderRadius: 4,
                    background: 'linear-gradient(90deg, #f59e0b80, #f59e0b)',
                    transition: 'width 0.6s ease'
                  }} />
                </div>
              </div>

              {/* 亲密度条 */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                  <span>💕 亲密度</span>
                  <span style={{ color: '#ec4899', fontWeight: 600 }}>{affinityPercent}% {getAffinityEmoji(emo.affinity)}</span>
                </div>
                <div style={{ width: '100%', height: 8, borderRadius: 4, background: 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                  <div style={{ 
                    width: `${affinityPercent}%`, height: '100%', borderRadius: 4,
                    background: 'linear-gradient(90deg, #ec489980, #ec4899)',
                    transition: 'width 0.6s ease'
                  }} />
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 选中 Agent 详情 */}
      {selected && (
        <div style={{
          padding: 20, borderRadius: 12, background: 'var(--surface-0)',
          border: '1px solid var(--border-light)',
        }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>
            {selected.agentIcon} {selected.agentName} — 情绪历史
          </h3>
          {selected.history.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {selected.history.slice(-10).reverse().map((entry, i) => {
                const time = new Date(entry.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
                const moodColor = getMoodColor(entry.mood)
                const moodPercent = Math.round((entry.mood + 1) / 2 * 100)
                return (
                  <div key={i} style={{ 
                    display: 'flex', alignItems: 'center', gap: 12, 
                    padding: '8px 12px', borderRadius: 8, background: 'var(--surface-50)' 
                  }}>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 60 }}>{time}</span>
                    <span style={{ fontSize: 16 }}>{getMoodEmoji(entry.mood)}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
                        <span>心情</span>
                        <span style={{ color: moodColor }}>{moodPercent}%</span>
                      </div>
                      <div style={{ width: '100%', height: 6, borderRadius: 3, background: 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                        <div style={{ width: `${moodPercent}%`, height: '100%', borderRadius: 3, background: moodColor }} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', padding: 20 }}>
              暂无历史记录，开始对话后情绪变化会在这里显示
            </div>
          )}
        </div>
      )}
    </div>
  )
}
