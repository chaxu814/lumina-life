// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// AchievementWall.tsx — PS5 风格成就奖杯墙 🏆 Phase 2
//
// 全屏奖杯陈列：铜/银/金/白金四档 + 隐藏奖杯
// 分类网格展示 + 解锁特效
// ============================================================

import React, { useState, useEffect, useMemo } from 'react'

// ── 成就数据 ──
// 与 GamificationPanel 共享 ACHIEVEMENT_DISPLAY 定义，
// 为避免循环依赖，这里内联一份并保持同步。

export interface TrophyDef {
  id: string
  name: string
  description: string
  icon: string
  category: string
  /** PS5 奖杯等级: bronze | silver | gold | platinum */
  tier: 'bronze' | 'silver' | 'gold' | 'platinum'
  /** 是否隐藏奖杯 */
  hidden?: boolean
}

const ACHIEVEMENT_DISPLAY: Record<string, { name: string; description: string; icon: string; category: string }> = {
  first_chat: { name: '初次见面', description: '和 Lumina 完成第一次对话', icon: '🤝', category: 'milestone' },
  chat_100: { name: '畅聊达人', description: '累计 100 条对话消息', icon: '💬', category: 'milestone' },
  chat_1000: { name: '话痨模式', description: '累计 1000 条对话消息', icon: '🗣️', category: 'milestone' },
  week_active: { name: '一周伙伴', description: '连续使用 7 天', icon: '📅', category: 'milestone' },
  month_active: { name: '满月纪念', description: '连续使用 30 天', icon: '🌕', category: 'milestone' },
  first_tool: { name: '初试身手', description: '第一次使用工具', icon: '🔧', category: 'skill' },
  tool_master_10: { name: '工具达人', description: '使用过 10 种工具', icon: '🛠️', category: 'skill' },
  tool_master_all: { name: '全能主人', description: '使用过 20 种工具', icon: '🏆', category: 'skill' },
  first_memory: { name: '铭记于心', description: 'Lumina 记住关于你的事', icon: '💾', category: 'milestone' },
  memory_hoarder: { name: '记忆收藏家', description: '保存 50 条记忆', icon: '🧠', category: 'milestone' },
  team_love: { name: '团队默契', description: '团队亲密度总和 150', icon: '💕', category: 'social' },
  social_butterfly: { name: '社交达人', description: '观看 10 次团队群聊', icon: '🦋', category: 'social' },
  mode_hopper: { name: '百变主人', description: '切换 4 种人格模式', icon: '🎭', category: 'fun' },
  first_capsule: { name: '时间旅人', description: '埋下第一颗时光胶囊', icon: '⏳', category: 'fun' },
  task_warrior: { name: '任务战士', description: '完成 10 个定时任务', icon: '⚔️', category: 'skill' },
  night_owl: { name: '夜猫子', description: '凌晨 2-5 点还在聊', icon: '🦉', category: 'hidden' },
}

/** 奖杯等级映射 */
const TIER_MAP: Record<string, 'bronze' | 'silver' | 'gold' | 'platinum'> = {
  milestone: 'bronze',
  skill: 'silver',
  social: 'gold',
  fun: 'gold',
  hidden: 'platinum',
}

const TIER_STYLES: Record<string, { label: string; color: string; bg: string; glow: string }> = {
  bronze: { label: '铜杯', color: '#cd7f32', bg: 'rgba(205,127,50,0.12)', glow: 'rgba(205,127,50,0.3)' },
  silver: { label: '银杯', color: '#c0c0c0', bg: 'rgba(192,192,192,0.12)', glow: 'rgba(192,192,192,0.3)' },
  gold:   { label: '金杯', color: '#ffd700', bg: 'rgba(255,215,0,0.12)', glow: 'rgba(255,215,0,0.3)' },
  platinum: { label: '白金杯', color: '#e5ccff', bg: 'rgba(229,204,255,0.12)', glow: 'rgba(229,204,255,0.4)' },
}

interface AchievementWallProps {
  unlockedAchievements: string[]
  onClose: () => void
}

// ═══════════════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════════════

export default function AchievementWall({ unlockedAchievements, onClose }: AchievementWallProps) {
  const [filter, setFilter] = useState<string>('all')
  const [animatingId, setAnimatingId] = useState<string | null>(null)
  const [selectedTrophy, setSelectedTrophy] = useState<string | null>(null)
  const [showUnlockAnim, setShowUnlockAnim] = useState(false)

  // 奖杯列表
  const trophies = useMemo(() => {
    return Object.entries(ACHIEVEMENT_DISPLAY).map(([id, def]) => ({
      id,
      ...def,
      tier: TIER_MAP[def.category] || 'bronze',
      unlocked: unlockedAchievements.includes(id),
      hidden: def.category === 'hidden',
    }))
  }, [unlockedAchievements])

  // 筛选
  const filtered = useMemo(() => {
    if (filter === 'all') {return trophies}
    if (filter === 'unlocked') {return trophies.filter(t => t.unlocked)}
    if (filter === 'locked') {return trophies.filter(t => !t.unlocked && !t.hidden)}
    return trophies.filter(t => t.tier === filter)
  }, [trophies, filter])

  // 统计
  const stats = useMemo(() => {
    const total = trophies.filter(t => !t.hidden).length
    const unlocked = trophies.filter(t => t.unlocked).length
    const byTier = { bronze: 0, silver: 0, gold: 0, platinum: 0 }
    const unlockedByTier = { bronze: 0, silver: 0, gold: 0, platinum: 0 }
    trophies.forEach(t => {
      byTier[t.tier]++
      if (t.unlocked) {unlockedByTier[t.tier]++}
    })
    return { total, unlocked, byTier, unlockedByTier, pct: total > 0 ? Math.round(unlocked / total * 100) : 0 }
  }, [trophies])

  // 最近解锁动画
  useEffect(() => {
    if (unlockedAchievements.length > 0) {
      // 找到最后一个解锁的（不在之前的列表里）
      setAnimatingId(unlockedAchievements[unlockedAchievements.length - 1])
      const t = setTimeout(() => setAnimatingId(null), 2000)
      return () => clearTimeout(t)
    }
  }, [unlockedAchievements.length])

  // ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') {onClose()} }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      zIndex: 99998, background: 'rgba(10,10,30,0.92)',
      backdropFilter: 'blur(12px)',
      display: 'flex', flexDirection: 'column',
      color: '#fff', fontFamily: 'var(--font-sans)',
      animation: 'aw-fadeIn 0.3s ease-out',
    }}>
      <style>{`
        @keyframes aw-fadeIn { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
        @keyframes aw-trophyPop { 0% { transform: scale(0) rotate(-10deg); opacity: 0; } 60% { transform: scale(1.15) rotate(3deg); } 100% { transform: scale(1) rotate(0); opacity: 1; } }
        @keyframes aw-glow { 0%, 100% { filter: drop-shadow(0 0 4px var(--glow)); } 50% { filter: drop-shadow(0 0 12px var(--glow)); } }
        @keyframes aw-confetti { 0% { transform: translateY(0) rotate(0); opacity: 1; } 100% { transform: translateY(-120px) rotate(360deg); opacity: 0; } }
        @keyframes aw-sparkle { 0%, 100% { opacity: 0; transform: scale(0) rotate(0); } 50% { opacity: 1; transform: scale(1) rotate(180deg); } }
        .aw-scroll::-webkit-scrollbar { width: 6px; }
        .aw-scroll::-webkit-scrollbar-track { background: transparent; }
        .aw-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
      `}</style>

      {/* 头部 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '20px 32px', borderBottom: '1px solid rgba(255,255,255,0.08)',
        flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 800 }}>
            🏆 奖杯墙
          </div>
          <div style={{ fontSize: 13, opacity: 0.6, marginTop: 2 }}>
            已完成 {stats.unlocked}/{stats.total} · 完成度 {stats.pct}%
          </div>
        </div>
        <button onClick={onClose} style={{
          background: 'rgba(255,255,255,0.08)', border: 'none',
          color: '#fff', fontSize: 20, width: 36, height: 36,
          borderRadius: 10, cursor: 'pointer', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          transition: 'background 0.2s',
        }} onMouseOver={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
           onMouseOut={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}>
          ✕
        </button>
      </div>

      {/* 统计条 PS5 风格 */}
      <div style={{
        display: 'flex', gap: 12, padding: '12px 32px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        {(['bronze', 'silver', 'gold', 'platinum'] as const).map(tier => {
          const s = TIER_STYLES[tier]
          return (
            <div key={tier} style={{
              flex: 1, background: s.bg, borderRadius: 10, padding: '8px 12px',
              border: `1px solid ${s.color}33`, cursor: 'pointer',
              transition: 'all 0.2s', opacity: filter === tier ? 1 : 0.6,
            }} onClick={() => setFilter(filter === tier ? 'all' : tier)}>
              <div style={{ fontSize: 11, color: s.color, fontWeight: 700 }}>{s.label}</div>
              <div style={{ fontSize: 20, fontWeight: 800 }}>
                {stats.unlockedByTier[tier]}<span style={{ fontSize: 12, fontWeight: 400, opacity: 0.5 }}>/{stats.byTier[tier]}</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* 筛选标签 */}
      <div style={{
        display: 'flex', gap: 6, padding: '10px 32px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        {[
          { key: 'all', label: '全部' },
          { key: 'unlocked', label: '已解锁' },
          { key: 'locked', label: '未解锁' },
        ].map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)} style={{
            padding: '4px 14px', borderRadius: 20, border: 'none',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
            background: filter === f.key ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)',
            color: filter === f.key ? '#fff' : 'rgba(255,255,255,0.6)',
            transition: 'all 0.2s',
          }}>{f.label}</button>
        ))}
      </div>

      {/* 奖杯网格 */}
      <div className="aw-scroll" style={{
        flex: 1, overflow: 'auto', padding: '20px 32px',
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: 14, alignContent: 'start',
      }}>
        {filtered.map(trophy => {
          const s = TIER_STYLES[trophy.tier]
          const isNew = animatingId === trophy.id
          return (
            <div key={trophy.id}
              onClick={() => setSelectedTrophy(selectedTrophy === trophy.id ? null : trophy.id)}
              style={{
                position: 'relative',
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center',
                padding: '16px 10px 12px',
                borderRadius: 14,
                background: trophy.unlocked ? s.bg : 'rgba(255,255,255,0.03)',
                border: `1px solid ${trophy.unlocked ? `${s.color}44` : 'rgba(255,255,255,0.06)'}`,
                cursor: 'pointer',
                opacity: trophy.unlocked || filter === 'all' ? 1 : 0.4,
                transition: 'all 0.25s cubic-bezier(0.4,0,0.2,1)',
                animation: isNew ? 'aw-trophyPop 0.5s ease-out' : 'none',
                '--glow': s.glow,
                ...(selectedTrophy === trophy.id ? {
                  transform: 'scale(1.05)',
                  boxShadow: `0 0 20px ${s.glow}`,
                  borderColor: s.color,
                } : {}),
              } as React.CSSProperties}
              onMouseOver={e => { if (trophy.unlocked) { e.currentTarget.style.transform = 'scale(1.05)'; e.currentTarget.style.boxShadow = `0 0 16px ${s.glow}` } }}
              onMouseOut={e => { if (selectedTrophy !== trophy.id) { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = 'none' } }}
            >
              {/* 奖杯图标 */}
              <div style={{
                fontSize: 36, lineHeight: 1.2, marginBottom: 6,
                filter: trophy.unlocked ? 'none' : 'grayscale(1) brightness(0.4)',
                animation: trophy.unlocked ? 'aw-glow 3s ease-in-out infinite' : 'none',
              }}>
                {trophy.unlocked ? trophy.icon : '🏆'}
              </div>

              {/* 奖杯等级标签 */}
              <div style={{
                fontSize: 9, fontWeight: 700, color: s.color,
                background: `${s.color}22`, padding: '1px 8px',
                borderRadius: 10, marginBottom: 4, textTransform: 'uppercase',
                letterSpacing: 1,
              }}>
                {s.label}
              </div>

              {/* 名称 */}
              <div style={{
                fontSize: 11, fontWeight: 600, textAlign: 'center',
                color: trophy.unlocked ? '#fff' : 'rgba(255,255,255,0.3)',
                lineHeight: 1.3, maxWidth: 120,
              }}>
                {trophy.unlocked ? trophy.name : '???'}
              </div>

              {/* 解锁闪光特效 */}
              {isNew && (
                <div style={{
                  position: 'absolute', top: -4, right: -4,
                  fontSize: 16, animation: 'aw-sparkle 1s ease-out 3',
                }}>✨</div>
              )}
            </div>
          )
        })}
      </div>

      {/* 选中奖杯详情弹窗 */}
      {selectedTrophy && (() => {
        const t = trophies.find(tt => tt.id === selectedTrophy)
        if (!t) {return null}
        const s = TIER_STYLES[t.tier]
        return (
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            background: 'rgba(20,20,50,0.95)', backdropFilter: 'blur(16px)',
            borderTop: `1px solid ${s.color}44`,
            padding: '20px 32px',
            display: 'flex', alignItems: 'center', gap: 20,
            animation: 'aw-fadeIn 0.2s ease-out',
          }}>
            <div style={{ fontSize: 52 }}>{t.unlocked ? t.icon : '🏆'}</div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 18, fontWeight: 700 }}>{t.unlocked ? t.name : '???'}</span>
                <span style={{
                  fontSize: 10, fontWeight: 700, color: s.color,
                  background: `${s.color}22`, padding: '2px 10px',
                  borderRadius: 10, textTransform: 'uppercase',
                }}>{s.label}</span>
              </div>
              <div style={{ fontSize: 13, opacity: 0.6, marginTop: 4 }}>
                {t.unlocked ? t.description : '尚未解锁 · 继续探索吧！'}
              </div>
              {t.unlocked && (
                <div style={{ fontSize: 11, opacity: 0.4, marginTop: 2 }}>
                  类别: {t.category === 'milestone' ? '里程碑' : t.category === 'skill' ? '技能' : t.category === 'social' ? '社交' : t.category === 'hidden' ? '隐藏' : '趣味'}
                </div>
              )}
            </div>
            <button onClick={() => setSelectedTrophy(null)} style={{
              background: 'rgba(255,255,255,0.08)', border: 'none',
              color: '#fff', fontSize: 18, width: 32, height: 32,
              borderRadius: 8, cursor: 'pointer',
            }}>✕</button>
          </div>
        )
      })()}

      {/* 底部进度条 */}
      <div style={{
        padding: '8px 32px', borderTop: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{
          width: '100%', height: 4, borderRadius: 2,
          background: 'rgba(255,255,255,0.08)', overflow: 'hidden',
        }}>
          <div style={{
            width: `${stats.pct}%`, height: '100%',
            background: 'linear-gradient(90deg, #cd7f32, #c0c0c0, #ffd700, #e5ccff)',
            borderRadius: 2, transition: 'width 0.5s ease',
          }}/>
        </div>
      </div>
    </div>
  )
}
