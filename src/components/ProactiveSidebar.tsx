// ============================================================
// ProactiveSidebar.tsx — 24/7 主动对话引擎控制面板
// v2.9: 左侧栏专用，提供全部触发器管理和状态监控
// ============================================================

import React, { useEffect, useState, useRef } from 'react'
import { proactiveChat } from '../services/proactiveChat'

// ── 类型 ───────────────────────────────────────────

interface EngineStatus {
  running: boolean
  triggers: ProactiveTriggerState[]
  config: Record<string, any>  // 🔧 IPC 返回的动态配置，不做结构化约束
  dailyCount: number
  lastActivity?: number
  idleSeconds?: number
  systemIdleSeconds?: number
  lastProactiveTime?: number
}

interface ProactiveTriggerState {
  id: string
  type: string
  condition?: string  // 🔧 IPC 返回的原始触发器不包含此字段
  template?: string   // 🔧 IPC 返回的原始触发器不包含此字段
  enabled: boolean
  cooldown: number
  lastTriggered?: number
  priority: number
}

interface EngineConfig {
  enabled: boolean
  minIdleSeconds: number
  minIntervalSeconds: number
  maxDailyProactive: number
  useLlmPolish: boolean
  screenWatchIntervalSeconds: number
  hotTopicIntervalSeconds: number
  screenWatchEnabled: boolean
  hotTopicEnabled: boolean
  notificationsEnabled?: boolean
}

// ── 图标/表情映射 ──────────────────────────────────

const TYPE_META: Record<string, { emoji: string; label: string; color: string; bg: string }> = {
  time:           { emoji: '⏰', label: '定时',       color: '#6366f1', bg: '#eef2ff' },
  idle:           { emoji: '💤', label: '空闲',       color: '#8b5cf6', bg: '#f5f3ff' },
  event:          { emoji: '📌', label: '事件',       color: '#ec4899', bg: '#fdf2f8' },
  opportunity:    { emoji: '🎯', label: '机会',       color: '#f59e0b', bg: '#fffbeb' },
  screen_watch:   { emoji: '🖥️', label: '屏幕感知',   color: '#10b981', bg: '#ecfdf5' },
  hot_topic:      { emoji: '🔥', label: '热搜感知',   color: '#ef4444', bg: '#fef2f2' },
  personal_rhythm:{ emoji: '🌙', label: '作息规律',   color: '#06b6d4', bg: '#ecfeff' },
}

// ── 触发器中文名称映射 ──────────────────────────

const TRIGGER_NAMES: Record<string, string> = {
  'morning-greeting':      '早安问候 ☀️',
  'noon-reminder':          '午间提醒 🍱',
  'afternoon-break':        '午后休息 ☕',
  'evening-wrapup':         '下班收尾 🌆',
  'night-reminder':         '晚安提醒 💤',
  'idle-10min':             '空闲 10 分钟',
  'idle-30min':             '空闲 30 分钟',
  'startup-greeting':       '启动问好 👋',
  'long-session':           '长时守护 🕐',
  'screen-watch':           '屏幕感知 👀',
  'hot-topic':              '热搜话题 🔥',
  'personal-rhythm-start':  '启动学习 🌙',
  'personal-rhythm-lunch':  '午餐问候 🍱',
  'personal-rhythm-coffee': '下午茶提醒 ☕',
  'opportunity-after-chat': '聊天间隙搭话 💬',
}

const PRIORITY_LABELS: Record<number, string> = {
  0: '💤', 1: '💤', 2: '💤',
  3: '🟢', 4: '🟢', 5: '🟢',
  6: '🟡', 7: '🟡',
  8: '🔴', 9: '🔴', 10: '🔴',
}

// ── Props ──────────────────────────────────────────

interface Props {
  visible: boolean
  onClose: () => void
}

// ═══════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  if (d.toDateString() === now.toDateString()) {
    return `今天 ${hh}:${mm}:${ss}`
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}:${ss}`
}

function formatIdle(seconds: number): string {
  if (seconds < 60) {return `${seconds}秒`}
  const mins = Math.floor(seconds / 60)
  if (mins < 60) {return `${mins}分钟`}
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  return `${hours}小时${remainMins > 0 ? remainMins + '分' : ''}`
}

// ═══════════════════════════════════════════════════
// 组件
// ═══════════════════════════════════════════════════

export default function ProactiveSidebar({ visible, onClose }: Props) {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [statusReady, setStatusReady] = useState(false)  // 🔧 v2.10: 防止初次渲染闪烁
  const [expandedType, setExpandedType] = useState<string[]>([])
  const [showConfig, setShowConfig] = useState(true)  // 🔧 v2.17: 高级设置默认展开
  const pauseRef = useRef(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── 拉取引擎状态（带超时，防止 IPC 挂死） ──────
  const fetchStatus = async () => {
    if (pauseRef.current) {return}
    try {
      const s = await Promise.race([
        window.luminaAPI.proactiveStatus(),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000)),
      ])
      if (s) {
        setStatus(s)
        setStatusReady(true)
      }
    } catch {
      // 后端未就绪
    }
  }

  useEffect(() => {
    if (!visible) {return}
    setStatusReady(false)
    fetchStatus()
    pollRef.current = setInterval(fetchStatus, 15000)  // 15s 轮询（不频繁不卡顿）
    return () => { if (pollRef.current) {clearInterval(pollRef.current)} }
  }, [visible])

  // ── 开关触发器（乐观更新：先改 UI，后台同步） ──
  const toggleTrigger = async (id: string, enabled: boolean) => {
    // 乐观更新：立刻刷新本地状态
    setStatus(prev => {
      if (!prev) {return prev}
      return {
        ...prev,
        triggers: prev.triggers.map(t => t.id === id ? { ...t, enabled } : t),
      }
    })
    // 同步更新前端 proactiveChat 触发器
    const frontTriggers = proactiveChat.getTriggers()
    const ft = frontTriggers.find(t => t.id === id)
    if (ft) {proactiveChat.updateTrigger(id, { enabled })}
    // 后台 IPC 同步（不 await，不阻塞 UI）
    window.luminaAPI.proactiveUpdateTrigger(id, { enabled }).catch((e: any) => {
      console.warn('[ProactiveSidebar] 后端更新失败:', e)
      // 失败时回滚
      setStatus(prev => {
        if (!prev) {return prev}
        return {
          ...prev,
          triggers: prev.triggers.map(t => t.id === id ? { ...t, enabled: !enabled } : t),
        }
      })
    })
  }

  // ── 测试触发 ──────────────────────────────────
  const testTrigger = async (trigger: ProactiveTriggerState) => {
    setLoading(true)
    try {
      // 尝试前端服务触发（兼容旧触发器）
      const frontTriggers = proactiveChat.getTriggers()
      if (frontTriggers.find(t => t.id === trigger.id)) {
        await proactiveChat.triggerNow(trigger.id)
      }
      // 后台引擎强制激活
      await window.luminaAPI.proactiveTestTrigger(trigger.id)
      fetchStatus()
    } catch (e) {
      console.warn('[ProactiveSidebar] 测试触发失败:', e)
    } finally {
      setLoading(false)
    }
  }

  // ── 更新配置（乐观更新） ──────────────────────
  const updateEngineConfig = async (partial: Record<string, any>) => {
    // 乐观更新 UI
    setStatus(prev => {
      if (!prev) {return prev}
      return { ...prev, config: { ...prev.config, ...partial } }
    })
    // 后台同步（不阻塞 UI）
    window.luminaAPI.proactiveUpdateConfig(partial).catch((e: any) => {
      console.warn('[ProactiveSidebar] 更新配置失败:', e)
      fetchStatus()  // 失败时回滚
    })
  }

  // ── 切换折叠 ──────────────────────────────────
  const toggleExpand = (type: string) => {
    setExpandedType(prev =>
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    )
  }

  // ── 格式化时间 ────────────────────────────────
  const formatTime = (ts?: number) => {
    if (!ts) {return '从未'}
    const d = new Date(ts)
    const now = new Date()
    const diffMin = Math.floor((now.getTime() - ts) / 60000)
    if (diffMin < 1) {return '刚刚'}
    if (diffMin < 60) {return `${diffMin} 分钟前`}
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`
  }

  // ── 冷却进度 ──────────────────────────────────
  const cooldownPercent = (trigger: ProactiveTriggerState) => {
    if (!trigger.lastTriggered) {return 100}
    const elapsed = Date.now() - trigger.lastTriggered
    return Math.min(100, Math.round((elapsed / (trigger.cooldown * 1000)) * 100))
  }

  if (!visible) {return null}

  // 按类型分组触发器
  const grouped = (status?.triggers || []).reduce((acc, t) => {
    const type = t.type
    if (!acc[type]) {acc[type] = []}
    acc[type].push(t)
    return acc
  }, {} as Record<string, ProactiveTriggerState[]>)

  const enabledCount = (status?.triggers || []).filter(t => t.enabled).length
  const totalCount = (status?.triggers || []).length

  // ── 公共按钮样式 ──────────────────────────────
  const subtleBtn: React.CSSProperties = {
    background: 'transparent', border: 'none', cursor: 'pointer',
    padding: '2px 4px', borderRadius: 4, color: 'var(--text-secondary)', fontSize: 13,
    display: 'flex', alignItems: 'center', gap: 2,
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', background: '#f8f9fb',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      overflow: 'hidden',
    }}>
      {/* ═══ 标题栏 ═══ */}
      <div style={{
        padding: '10px 12px',
        borderBottom: '1px solid var(--border-light)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
        background: 'linear-gradient(135deg, #7c3aed08 0%, #3b82f608 100%)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 16 }}>⚡</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>
            主动引擎
          </span>
          {status && (
            <span style={{
              width: 7, height: 7, borderRadius: 7,
              background: status.running ? '#22c55e' : '#94a3b8',
              boxShadow: status.running ? '0 0 6px rgba(34,197,94,0.5)' : 'none',
              transition: 'all 0.3s',
            }} />
          )}
        </div>
        <button onClick={onClose} style={{
          ...subtleBtn, fontSize: 16, fontWeight: 700,
          color: 'var(--text-secondary)', padding: '2px 6px',
        }}>×</button>
      </div>

      {/* ═══ 内容滚动区 ═══ */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '6px 0' }}>

        {/* ── 引擎总开关 + 今日统计 ── */}
        <div style={{ padding: '0 10px', marginBottom: 8 }}>
          {!statusReady ? (
            /* 🔧 v2.10: 加载中占位 — 防止先显示"已暂停"再闪变为"运行中" */
            <div style={{
              padding: '8px 10px',
              background: 'linear-gradient(135deg, #f0fdf4, #ecfdf5)',
              borderRadius: 8, border: '1px solid #bbf7d0',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#166534' }}>🟢 引擎运行中</div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>加载中...</div>
              </div>
              <div style={{
                width: 40, height: 22, borderRadius: 11,
                background: '#22c55e', position: 'relative',
              }}>
                <div style={{
                  position: 'absolute', top: 2, left: 20,
                  width: 18, height: 18, borderRadius: 9,
                  background: 'var(--surface-0)', boxShadow: '0 1px 3px rgba(0,0,0,.15)',
                }} />
              </div>
            </div>
          ) : (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 10px',
            background: status?.config?.enabled
              ? 'linear-gradient(135deg, #f0fdf4, #ecfdf5)'
              : 'linear-gradient(135deg, #fafafa, #f5f5f5)',
            borderRadius: 8,
            border: status?.config?.enabled ? '1px solid #bbf7d0' : '1px solid #e5e7eb',
          }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: status?.config?.enabled ? '#166534' : '#6b7280' }}>
                {status?.config?.enabled ? '🟢 引擎运行中' : '⚪ 引擎已暂停'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                今日主动 {status?.dailyCount ?? 0} 次 · {enabledCount}/{totalCount} 触发器已启用
              </div>
            </div>
            <div
              onClick={() => updateEngineConfig({ enabled: !status?.config?.enabled })}
              style={{
                width: 40, height: 22, borderRadius: 11, cursor: 'pointer',
                background: status?.config?.enabled ? '#22c55e' : '#d1d5db',
                transition: 'all 0.25s',
                position: 'relative',
                boxShadow: status?.config?.enabled ? '0 0 8px rgba(34,197,94,0.35)' : 'none',
              }}
            >
              <div style={{
                position: 'absolute', top: 2,
                left: status?.config?.enabled ? 20 : 2,
                width: 18, height: 18, borderRadius: 9,
                background: 'var(--surface-0)',
                transition: 'left 0.25s',
                boxShadow: '0 1px 3px rgba(0,0,0,.15)',
              }} />
            </div>
          </div>
          )}
        </div>

        {/* ── 按类别折叠的触发器列表 ── */}
        {Object.keys(TYPE_META).map(typeKey => {
          const triggers = grouped[typeKey]
          if (!triggers || triggers.length === 0) {return null}
          const meta = TYPE_META[typeKey]
          const isExpanded = expandedType.includes(typeKey)
          const typeEnabled = triggers.some(t => t.enabled)

          return (
            <div key={typeKey} style={{ marginBottom: 4 }}>
              {/* 分类标题 */}
              <div
                onClick={() => toggleExpand(typeKey)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', cursor: 'pointer',
                  fontSize: 11, fontWeight: 600, color: typeEnabled ? meta.color : 'var(--text-secondary)',
                  transition: 'color 0.2s',
                  userSelect: 'none',
                }}
              >
                <span>{isExpanded ? '▼' : '▶'}</span>
                <span style={{ fontSize: 14 }}>{meta.emoji}</span>
                <span>{meta.label}</span>
                <span style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 8,
                  background: meta.bg, color: meta.color,
                  marginLeft: 'auto',
                }}>
                  {triggers.filter(t => t.enabled).length}/{triggers.length}
                </span>
              </div>

              {/* 触发器列表 */}
              {isExpanded && triggers.map(trigger => {
                const cdPct = cooldownPercent(trigger)
                const canTrigger = cdPct >= 100
                return (
                  <div key={trigger.id} style={{
                    margin: '2px 8px', padding: '6px 10px',
                    borderRadius: 6,
                    background: trigger.enabled ? '#fff' : '#fafafa',
                    border: trigger.enabled ? '1px solid #e5e7eb' : '1px solid #f3f4f6',
                    transition: 'all 0.15s',
                  }}>
                    {/* 第一行：触发器名 + 开关 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        fontSize: 10, minWidth: 16, textAlign: 'center',
                      }}>{PRIORITY_LABELS[trigger.priority] || '⚪'}</span>
                      <span style={{
                        fontSize: 11, fontWeight: 500, color: 'var(--text-primary)',
                        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }} title={trigger.id}>
                        {TRIGGER_NAMES[trigger.id] || trigger.id.replace(/-/g, ' ')}
                      </span>
                      {/* 冷却徽章 */}
                      {trigger.lastTriggered && cdPct < 100 && (
                        <span style={{
                          fontSize: 9, color: '#f59e0b', background: 'var(--yellow-100)',
                          padding: '1px 5px', borderRadius: 8,
                        }}>冷却 {Math.ceil((trigger.cooldown * 1000 - (Date.now() - trigger.lastTriggered!)) / 1000)}s</span>
                      )}
                      {/* 开关 */}
                      <div
                        onClick={(e) => { e.stopPropagation(); toggleTrigger(trigger.id, !trigger.enabled) }}
                        style={{
                          width: 32, height: 18, borderRadius: 9, cursor: 'pointer',
                          background: trigger.enabled ? meta.color : '#d1d5db',
                          transition: 'all 0.2s',
                          position: 'relative', flexShrink: 0,
                          boxShadow: trigger.enabled ? `0 0 6px ${meta.color}44` : 'none',
                        }}
                      >
                        <div style={{
                          position: 'absolute', top: 2,
                          left: trigger.enabled ? 16 : 2,
                          width: 14, height: 14, borderRadius: 7,
                          background: 'var(--surface-0)',
                          transition: 'left 0.2s',
                          boxShadow: '0 1px 2px rgba(0,0,0,.12)',
                        }} />
                      </div>
                    </div>

                    {/* 第二行：详情 + 测试按钮 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                      <span style={{ fontSize: 9, color: 'var(--text-secondary)', flex: 1 }}>
                        {trigger.condition} · 优先级 {trigger.priority} · {formatTime(trigger.lastTriggered)}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); testTrigger(trigger) }}
                        disabled={loading || !canTrigger}
                        style={{
                          ...subtleBtn, fontSize: 9,
                          padding: '1px 6px',
                          background: canTrigger ? meta.bg : '#f3f4f6',
                          color: canTrigger ? meta.color : '#d1d5db',
                          borderRadius: 4,
                          border: canTrigger ? `1px solid ${meta.color}33` : '1px solid #f3f4f6',
                          cursor: canTrigger && !loading ? 'pointer' : 'default',
                          opacity: canTrigger ? 1 : 0.5,
                        }}
                        title={canTrigger ? '立即测试触发一次' : '冷却中，请稍后再试'}
                      >
                        ⚡ 测试
                      </button>
                    </div>

                    {/* 冷却进度条 */}
                    {!canTrigger && trigger.lastTriggered && (
                      <div style={{
                        marginTop: 3, height: 2, background: 'var(--border-light)', borderRadius: 1, overflow: 'hidden',
                      }}>
                        <div style={{
                          height: '100%', width: `${cdPct}%`,
                          background: `linear-gradient(90deg, ${meta.color}88, ${meta.color})`,
                          borderRadius: 1, transition: 'width 1s linear',
                        }} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}

        {/* ── 高级配置折叠区 ── */}
        <div style={{ borderTop: '1px solid #e5e7eb', marginTop: 8, paddingTop: 4 }}>
          <div
            onClick={() => setShowConfig(!showConfig)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
              cursor: 'pointer', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)',
              userSelect: 'none',
            }}
          >
            <span>{showConfig ? '▼' : '▶'}</span>
            <span style={{ fontSize: 14 }}>⚙️</span>
            <span>高级设置</span>
          </div>

          {showConfig && status?.config && (
            <div style={{ padding: '0 12px 8px' }}>
              {renderConfigSlider('空闲触发阈值', status.config.minIdleSeconds, 30, 3600, (v) => updateEngineConfig({ minIdleSeconds: v }), '秒')}
              {renderConfigSlider('最小间隔', status.config.minIntervalSeconds, 60, 7200, (v) => updateEngineConfig({ minIntervalSeconds: v }), '秒')}
              {renderConfigSlider('每日上限', status.config.maxDailyProactive, 1, 100, (v) => updateEngineConfig({ maxDailyProactive: v }), '次')}
              {renderConfigSlider('屏幕感知间隔', status.config.screenWatchIntervalSeconds, 60, 3600, (v) => updateEngineConfig({ screenWatchIntervalSeconds: v }), '秒')}
              {renderConfigSlider('热搜轮询间隔', status.config.hotTopicIntervalSeconds, 300, 7200, (v) => updateEngineConfig({ hotTopicIntervalSeconds: v }), '秒')}

              {/* LLM 润色 */}
              <ConfigToggle
                label="LLM 润色"
                desc="让 AI 动态生成更自然的搭话"
                value={status.config.useLlmPolish}
                onChange={(v) => updateEngineConfig({ useLlmPolish: v })}
              />

              {/* 屏幕感知 */}
              <ConfigToggle
                label="🖥️ 屏幕感知"
                desc="截图分析你的屏幕内容来搭话"
                value={status.config.screenWatchEnabled}
                onChange={(v) => updateEngineConfig({ screenWatchEnabled: v })}
              />

              {/* 热搜感知 */}
              <ConfigToggle
                label="🔥 热搜感知"
                desc="监测 B站/微博热搜来发起话题"
                value={status.config.hotTopicEnabled}
                onChange={(v) => updateEngineConfig({ hotTopicEnabled: v })}
              />

              {/* 弹窗通知 */}
              <ConfigToggle
                label="🔔 Windows 弹窗通知"
                desc="主动对话时弹出系统通知"
                value={status.config.notificationsEnabled ?? false}
                onChange={(v) => {
                  updateEngineConfig({ notificationsEnabled: v })
                  window.luminaAPI.proactiveSetNotify?.(v)
                }}
              />
            </div>
          )}
        </div>

        {/* ── 底部手动心跳 + 状态 ── */}
        <div style={{ padding: '6px 12px', borderTop: '1px solid #e5e7eb' }}>
          <button
            onClick={() => {
              proactiveChat.recordActivity()
              window.luminaAPI.proactiveHeartbeat()
              // 延迟一下再刷新，确保后端已更新
              setTimeout(fetchStatus, 300)
            }}
            style={{
              width: '100%', padding: '6px 0',
              background: 'linear-gradient(135deg, #7c3aed, #6366f1)',
              color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer',
              fontSize: 11, fontWeight: 600,
              transition: 'opacity 0.2s',
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            💓 手动心跳（重置空闲计时）
          </button>
          <div style={{ fontSize: 9, color: 'var(--text-secondary)', textAlign: 'center', marginTop: 4 }}>
            {status?.lastActivity
              ? `上次活跃: ${formatTime(status.lastActivity)} · 空闲 ${formatIdle(status.idleSeconds ?? 0)}`
              : '等待心跳...'}
          </div>
          {status && status.systemIdleSeconds !== undefined && status.systemIdleSeconds > 0 && (
            <div style={{ fontSize: 9, color: '#d97706', textAlign: 'center', marginTop: 1 }}>
              🖥️ 系统空闲: {formatIdle(status.systemIdleSeconds)}
            </div>
          )}
        </div>

      </div>

      {/* ═══ 全局关键帧 ═══ */}
      <style>{`
        @keyframes pulseGlow {
          0%, 100% { box-shadow: 0 0 4px rgba(34,197,94,0.3); }
          50% { box-shadow: 0 0 12px rgba(34,197,94,0.6); }
        }
      `}</style>
    </div>
  )
}

// ═══════════════════════════════════════════════════
// 辅助子组件
// ═══════════════════════════════════════════════════

/** 配置滑块 */
function renderConfigSlider(
  label: string, value: number, min: number, max: number,
  onChange: (v: number) => void, unit: string,
) {
  return (
    <div key={label} style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-secondary)', marginBottom: 2 }}>
        <span>{label}</span>
        <span style={{ fontWeight: 600 }}>{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: '100%', height: 4, accentColor: '#6366f1',
          cursor: 'pointer',
        }}
      />
    </div>
  )
}

/** 配置开关 */
function ConfigToggle({ label, desc, value, onChange }: {
  label: string; desc: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '5px 0', borderBottom: '1px solid var(--border-light)',
    }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</div>
        <div style={{ fontSize: 9, color: 'var(--text-secondary)' }}>{desc}</div>
      </div>
      <div
        onClick={() => onChange(!value)}
        style={{
          width: 32, height: 18, borderRadius: 9, cursor: 'pointer',
          background: value ? '#6366f1' : '#d1d5db',
          transition: 'all 0.2s',
          position: 'relative', flexShrink: 0,
          boxShadow: value ? '0 0 6px rgba(99,102,241,0.35)' : 'none',
        }}
      >
        <div style={{
          position: 'absolute', top: 2,
          left: value ? 16 : 2,
          width: 14, height: 14, borderRadius: 7,
          background: 'var(--surface-0)',
          transition: 'left 0.2s',
          boxShadow: '0 1px 2px rgba(0,0,0,.12)',
        }} />
      </div>
    </div>
  )
}
