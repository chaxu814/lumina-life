// ============================================================
// ModeSettings.tsx — 场景模式设置面板 (v3.0)
//
// 第三阶段:
//   - 每个模式可单独编辑（名称、推送频率、开关等）
//   - 持久化到后端 mode-config.json
//   - 集成使用统计数据的展示
// ============================================================

import React, { useState, useEffect, useCallback } from 'react'
import { useStore, type LuminaMode } from '../stores/appStore'
import { useTranslation } from 'react-i18next'

interface ModeConfigForm {
  label: string
  emoji: string
  temperature: number
  proactiveEnabled: boolean
  proactiveInterval: number
  newsEnabled: boolean
  color: string
}

const MODE_KEYS: LuminaMode[] = ['work', 'study', 'fun', 'idle']

const MODE_LABELS: Record<LuminaMode, string> = {
  work: '💼 工作', study: '📚 学习', fun: '🎮 娱乐', idle: '😴 空闲',
}

// 自定义模式表单
interface CustomModeForm {
  id: string
  label: string
  emoji: string
  description: string
  systemPromptExtra: string
  temperature: number
  color: string
  proactiveEnabled: boolean
  proactiveInterval: number
  newsEnabled: boolean
}

interface UsageSummary {
  date: string
  modeSwitches: number
  proactiveCount: number
  userReplyCount: number
  messageCount: number
  proactiveReplyRate: number
  modeDistribution: Array<{ mode: string; minutes: number; percent: number }>
}

export default function ModeSettings() {
  const { t } = useTranslation()
  const luminaMode = useStore((s) => s.luminaMode)
  const setLuminaMode = useStore((s) => s.setLuminaMode)

  const api = (window as any).luminaAPI

  const [activeTab, setActiveTab] = useState<'modes' | 'stats'>('modes')
  const [editingMode, setEditingMode] = useState<LuminaMode | null>(null)
  const [form, setForm] = useState<ModeConfigForm>({
    label: '', emoji: '', temperature: 0.7,
    proactiveEnabled: true, proactiveInterval: 1800,
    newsEnabled: true, color: '#4A90D9',
  })
  const [log, setLog] = useState<string[]>([])
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [modeDistribution, setModeDistribution] = useState<Array<{ mode: string; totalMinutes: number }>>([])
  // 自定义模式
  const [customModes, setCustomModes] = useState<any[]>([])
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [customForm, setCustomForm] = useState<CustomModeForm>({
    id: '', label: '', emoji: '🤖', description: '', systemPromptExtra: '',
    temperature: 0.7, color: '#8B5CF6', proactiveEnabled: true, proactiveInterval: 1800, newsEnabled: true,
  })

  // 加载使用统计
  useEffect(() => {
    loadUsageStats()
    loadModeDistribution()
    loadCustomModes()
  }, [])

  const loadUsageStats = async () => {
    try {
      const result = await api?.usageToday?.()
      if (result && !result.error) setUsage(result.data)
    } catch {}
  }

  const loadModeDistribution = async () => {
    try {
      const result = await api?.usageModeDistribution?.()
      if (result && !result.error) setModeDistribution(result.data || [])
    } catch {}
  }

  // 加载自定义模式
  const loadCustomModes = async () => {
    try {
      const result = await api?.modeCustomList?.()
      if (result?.ok) setCustomModes(result.modes || [])
    } catch {}
  }

  // 创建自定义模式
  const handleCreateCustomMode = async () => {
    if (!customForm.label.trim()) return
    try {
      const result = await api?.modeCustomCreate?.({
        ...customForm,
        id: customForm.id || `custom_${Date.now()}`,
      })
      if (result?.ok) {
        addLog(`✅ 创建自定义模式: ${customForm.emoji} ${customForm.label}`)
        setShowCreateForm(false)
        setCustomForm({ id: '', label: '', emoji: '🤖', description: '', systemPromptExtra: '', temperature: 0.7, color: '#8B5CF6', proactiveEnabled: true, proactiveInterval: 1800, newsEnabled: true })
        loadCustomModes()
        // 刷新模式状态
        const state = await api?.modeGet?.()
        if (state) setLuminaMode(state)
      } else {
        addLog(`❌ 创建失败: ${result?.error || '未知错误'}`)
      }
    } catch (e: any) { addLog(`❌ 创建异常: ${e.message}`) }
  }

  // 删除自定义模式
  const handleDeleteCustomMode = async (id: string, label: string) => {
    if (!confirm(`确定删除自定义模式「${label}」？不可撤销。`)) return
    try {
      const result = await api?.modeCustomDelete?.(id)
      if (result?.ok) {
        addLog(`🗑️ 已删除: ${label}`)
        loadCustomModes()
        const state = await api?.modeGet?.()
        if (state) setLuminaMode(state)
      } else {
        addLog(`❌ 删除失败: ${result?.error}`)
      }
    } catch (e: any) { addLog(`❌ 删除异常: ${e.message}`) }
  }

  // 打开编辑
  const openEdit = (mode: LuminaMode) => {
    const config = luminaMode.allConfigs?.[mode] || luminaMode.config
    setEditingMode(mode)
    setForm({
      label: config.label || '',
      emoji: config.emoji || '',
      temperature: config.temperature ?? 0.7,
      proactiveEnabled: config.proactiveEnabled ?? true,
      proactiveInterval: config.proactiveInterval || 1800,
      newsEnabled: config.newsEnabled ?? true,
      color: config.color || '#4A90D9',
    })
  }

  // 保存配置（持久化到后端）
  const saveConfig = async () => {
    if (!editingMode) return
    try {
      await api?.modeUpdateConfig?.(editingMode, form)
      addLog(`✅ 已保存 ${MODE_LABELS[editingMode]} 配置`)
      setEditingMode(null)
      // 刷新前端状态
      const state = await api?.modeGet?.()
      if (state) setLuminaMode(state)
    } catch (e: any) {
      addLog(`❌ 保存失败: ${e.message}`)
    }
  }

  // 手动切换模式
  const handleSwitch = async (mode: LuminaMode) => {
    try {
      await api?.modeSet?.(mode)
      addLog(`🔄 手动切换到 ${MODE_LABELS[mode]}`)
    } catch (e: any) {
      addLog(`❌ 切换失败: ${e.message}`)
    }
  }

  // 释放手动覆盖
  const handleRelease = async () => {
    try {
      await api?.modeReleaseOverride?.()
      addLog('🔓 已恢复自动检测')
    } catch {}
  }

  // 立即检测
  const handleDetect = async () => {
    try {
      addLog('🔍 正在检测当前场景…')
      const result = await api?.modeDetectNow?.()
      if (result?.ok) {
        addLog(`📋 检测结果: ${result.scene.scene} (${result.scene.confidence}%) — ${result.scene.windowTitle}`)
      } else {
        addLog(`❌ 检测失败: ${result?.error || '未知错误'}`)
      }
    } catch (e: any) {
      addLog(`⚠️ 检测异常: ${e.message}`)
    }
  }

  // 刷新统计数据
  const refreshStats = async () => {
    await loadUsageStats()
    await loadModeDistribution()
    addLog('📊 统计数据已刷新')
  }

  const addLog = (msg: string) => {
    setLog(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 50))
  }

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>
        🎯 场景模式
      </h3>

      {/* 🆕 v3.0: tab 切换 */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        <button onClick={() => setActiveTab('modes')}
          style={{
            padding: '6px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
            background: activeTab === 'modes' ? 'var(--accent, #4A90D9)' : 'var(--surface-200)',
            color: activeTab === 'modes' ? '#fff' : 'var(--text-primary)',
            border: 'none', fontWeight: activeTab === 'modes' ? 600 : 400,
          }}>
          ⚙️ 模式管理
        </button>
        <button onClick={() => setActiveTab('stats')}
          style={{
            padding: '6px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
            background: activeTab === 'stats' ? 'var(--accent, #4A90D9)' : 'var(--surface-200)',
            color: activeTab === 'stats' ? '#fff' : 'var(--text-primary)',
            border: 'none', fontWeight: activeTab === 'stats' ? 600 : 400,
          }}>
          📊 使用统计
        </button>
      </div>

      {activeTab === 'modes' ? (
        <>
          {/* 当前状态 */}
          <div style={{
            background: 'var(--surface-100)', borderRadius: 10,
            padding: 12, marginBottom: 16,
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <span style={{ fontSize: 28 }}>{luminaMode.config.emoji}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{luminaMode.config.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                {luminaMode.manualOverride ? '📌 手动模式' : '🔄 自动检测'}
                {luminaMode.lastScene && ` · 置信度 ${luminaMode.lastScene.confidence}%`}
              </div>
            </div>
            {luminaMode.manualOverride && (
              <button onClick={handleRelease}
                style={{
                  padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-light)',
                  background: 'var(--surface-200)', fontSize: 11, cursor: 'pointer',
                }}>
                🔓 恢复自动
              </button>
            )}
            <button onClick={handleDetect}
              style={{
                padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-light)',
                background: 'var(--surface-200)', fontSize: 11, cursor: 'pointer',
              }}>
                🔍 立即检测
            </button>
          </div>

          {/* 场景信息 */}
          {luminaMode.lastScene && (
            <div style={{
              background: 'var(--surface-100)', borderRadius: 10, padding: 12, marginBottom: 16,
              fontSize: 12,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>📋 当前场景信息</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', color: 'var(--text-secondary)' }}>
                <span>窗口:</span><span>{luminaMode.lastScene.windowTitle}</span>
                <span>进程:</span><span>{luminaMode.lastScene.processName}</span>
                <span>置信度:</span><span>{luminaMode.lastScene.confidence}%</span>
                <span>判定依据:</span><span style={{ color: 'var(--text-tertiary)' }}>{luminaMode.lastScene.reason}</span>
              </div>
            </div>
          )}

          {/* 模式卡片列表 — 🆕 v3.0: 可单独编辑 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 16 }}>
            {MODE_KEYS.map(mode => {
              const config = luminaMode.allConfigs?.[mode] || luminaMode.config
              const isActive = mode === luminaMode.current
              const color = config.color || '#4A90D9'
              return (
                <div key={mode}
                  style={{
                    padding: 12, borderRadius: 10,
                    background: isActive ? `${color}18` : 'var(--surface-100)',
                    border: `1px solid ${isActive ? color + '40' : 'var(--border-light)'}`,
                    transition: 'all 0.2s',
                  }}
                >
                  {/* 头部: emoji + 名称 */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontSize: 20 }}>{config.emoji || MODE_LABELS[mode].split(' ')[0]}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, marginLeft: 6 }}>
                        {config.label || MODE_LABELS[mode].split(' ')[1] || mode}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {isActive && <span style={{ fontSize: 10, color, fontWeight: 600 }}>●</span>}
                      <button onClick={(e) => { e.stopPropagation(); openEdit(mode) }}
                        style={{
                          background: 'none', border: 'none', fontSize: 12, cursor: 'pointer',
                          padding: '2px 6px', borderRadius: 4,
                          color: 'var(--text-tertiary)',
                        }}>
                        ✏️
                      </button>
                    </div>
                  </div>
                  {/* 🆕 v3.0: 配置摘要 */}
                  <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4, display: 'flex', gap: 8 }}>
                    <span>{config.proactiveEnabled ? '💬' : '🔇'} {config.proactiveInterval > 0 ? `${config.proactiveInterval}s` : '关闭'}</span>
                    <span>{config.newsEnabled ? '📰' : '📰🚫'}</span>
                    <span>🌡️ {config.temperature}</span>
                  </div>
                  {/* 点击切换 */}
                  <div onClick={() => handleSwitch(mode)}
                    style={{ fontSize: 11, color: 'var(--accent, #4A90D9)', marginTop: 4, cursor: 'pointer' }}>
                    {isActive ? '当前' : '点击切换 →'}
                  </div>
                </div>
              )
            })}
          </div>

          {/* ── 🆕 v8.1: 自定义模式 ── */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>🎨 自定义模式</span>
              <button onClick={() => setShowCreateForm(!showCreateForm)}
                style={{
                  padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-light)',
                  background: 'var(--surface-200)', fontSize: 11, cursor: 'pointer',
                }}>
                {showCreateForm ? '✕ 关闭' : '✚ 新建'}
              </button>
            </div>

            {/* 创建表单 */}
            {showCreateForm && (
              <div style={{
                background: 'var(--surface-100)', borderRadius: 10, padding: 12, marginBottom: 10,
                border: '1px dashed var(--accent, #8B5CF6)',
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--accent, #8B5CF6)' }}>✏️ 创建新人格</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input value={customForm.emoji} onChange={e => setCustomForm(f => ({ ...f, emoji: e.target.value }))}
                      placeholder="🤖" style={{ width: 40, textAlign: 'center', padding: '6px 4px', borderRadius: 6, border: '1px solid var(--border-light)', fontSize: 14 }} />
                    <input value={customForm.label} onChange={e => setCustomForm(f => ({ ...f, label: e.target.value, id: `custom_${e.target.value.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_').toLowerCase()}` }))}
                      placeholder="人格名称" style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-light)', fontSize: 12 }} />
                    <input type="color" value={customForm.color} onChange={e => setCustomForm(f => ({ ...f, color: e.target.value }))}
                      style={{ width: 30, height: 30, borderRadius: 6, border: '1px solid var(--border-light)', cursor: 'pointer', padding: 0 }} />
                  </div>
                  <input value={customForm.description} onChange={e => setCustomForm(f => ({ ...f, description: e.target.value }))}
                    placeholder="简短描述这个人格的定位..." style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-light)', fontSize: 12, boxSizing: 'border-box' }} />
                  <textarea value={customForm.systemPromptExtra} onChange={e => setCustomForm(f => ({ ...f, systemPromptExtra: e.target.value }))}
                    placeholder="人格指令（system prompt）：告诉 AI 它应该扮演什么角色、说话风格、行为规则..."
                    rows={3} style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-light)', fontSize: 11, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }} />
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input type="checkbox" checked={customForm.proactiveEnabled} onChange={e => setCustomForm(f => ({ ...f, proactiveEnabled: e.target.checked }))} />
                      主动推送
                    </label>
                    <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input type="checkbox" checked={customForm.newsEnabled} onChange={e => setCustomForm(f => ({ ...f, newsEnabled: e.target.checked }))} />
                      新闻推送
                    </label>
                    <label style={{ fontSize: 11 }}>
                      🌡️ {(customForm.temperature).toFixed(1)}
                      <input type="range" min="0" max="2" step="0.1" value={customForm.temperature}
                        onChange={e => setCustomForm(f => ({ ...f, temperature: parseFloat(e.target.value) }))}
                        style={{ width: 60, verticalAlign: 'middle' }} />
                    </label>
                    <label style={{ fontSize: 11 }}>
                      间隔
                      <select value={customForm.proactiveInterval} onChange={e => setCustomForm(f => ({ ...f, proactiveInterval: parseInt(e.target.value) }))}
                        style={{ fontSize: 11, padding: '2px 4px', borderRadius: 4, border: '1px solid var(--border-light)' }}>
                        <option value={0}>关闭</option>
                        <option value={600}>10分钟</option>
                        <option value={1800}>30分钟</option>
                        <option value={3600}>1小时</option>
                      </select>
                    </label>
                  </div>
                  <button onClick={handleCreateCustomMode} disabled={!customForm.label.trim()}
                    style={{
                      padding: '8px', borderRadius: 8, border: 'none',
                      background: customForm.label.trim() ? '#8B5CF6' : 'var(--border-light)',
                      color: '#fff', fontSize: 12, fontWeight: 600, cursor: customForm.label.trim() ? 'pointer' : 'default',
                    }}>
                    🚀 创建人格
                  </button>
                </div>
              </div>
            )}

            {/* 自定义模式列表 */}
            {customModes.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '8px 0' }}>
                还没有自定义模式，点击「✚ 新建」开始造人格
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                {customModes.map(cm => {
                  const isActive = cm.id === luminaMode.current
                  const config = (luminaMode.allConfigs as any)?.[cm.id] || {}
                  return (
                    <div key={cm.id} style={{
                      padding: 10, borderRadius: 10,
                      background: isActive ? `${cm.color}18` : 'var(--surface-100)',
                      border: `1px solid ${isActive ? cm.color + '40' : 'var(--border-light)'}`,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <span style={{ fontSize: 18 }}>{cm.emoji}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, marginLeft: 6 }}>{cm.label}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {isActive && <span style={{ fontSize: 10, color: cm.color, fontWeight: 600 }}>●</span>}
                          <button onClick={() => handleDeleteCustomMode(cm.id, cm.label)}
                            style={{ background: 'none', border: 'none', fontSize: 12, cursor: 'pointer', padding: '2px 6px', borderRadius: 4, color: '#ef4444' }}>
                            🗑️
                          </button>
                        </div>
                      </div>
                      {cm.description && (
                        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2, lineHeight: 1.4 }}>{cm.description}</div>
                      )}
                      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 3, display: 'flex', gap: 6 }}>
                        <span>{cm.proactiveEnabled ? '💬' : '🔇'}</span>
                        <span>{cm.newsEnabled ? '📰' : '📰🚫'}</span>
                        <span>🌡️ {cm.temperature}</span>
                      </div>
                      <div onClick={() => handleSwitch(cm.id)}
                        style={{ fontSize: 11, color: cm.color, marginTop: 3, cursor: 'pointer' }}>
                        {isActive ? '当前' : '点击切换 →'}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 🆕 v3.0: 编辑弹窗（仅内置模式） */}
          {editingMode && (
            <div style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 1000,
            }} onClick={() => setEditingMode(null)}>
              <div style={{
                background: 'var(--surface-bg, #fff)', borderRadius: 14,
                padding: 20, width: 320, maxWidth: '90vw',
              }} onClick={e => e.stopPropagation()}>
                <h4 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>
                  ⚙️ 编辑 {MODE_LABELS[editingMode]}
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    名称
                    <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                      style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-light)', fontSize: 12 }} />
                  </label>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    Emoji
                    <input value={form.emoji} onChange={e => setForm(f => ({ ...f, emoji: e.target.value }))}
                      style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-light)', fontSize: 12 }} />
                  </label>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={form.proactiveEnabled}
                      onChange={e => setForm(f => ({ ...f, proactiveEnabled: e.target.checked }))} />
                    主动推送
                  </label>
                  {form.proactiveEnabled && (
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      推送间隔（秒）
                      <input type="number" value={form.proactiveInterval}
                        onChange={e => setForm(f => ({ ...f, proactiveInterval: Math.max(0, parseInt(e.target.value) || 0) }))}
                        style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-light)', fontSize: 12 }} />
                    </label>
                  )}
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={form.newsEnabled}
                      onChange={e => setForm(f => ({ ...f, newsEnabled: e.target.checked }))} />
                    新闻推送
                  </label>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    AI 温度（0~2）
                    <input type="number" min="0" max="2" step="0.1" value={form.temperature}
                      onChange={e => setForm(f => ({ ...f, temperature: parseFloat(e.target.value) || 0.7 }))}
                      style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-light)', fontSize: 12 }} />
                  </label>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    颜色
                    <input type="color" value={form.color}
                      onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                      style={{ width: '100%', height: 30, borderRadius: 6, border: '1px solid var(--border-light)', cursor: 'pointer' }} />
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
                  <button onClick={() => setEditingMode(null)}
                    style={{
                      padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border-light)',
                      background: 'transparent', fontSize: 12, cursor: 'pointer',
                    }}>
                    取消
                  </button>
                  <button onClick={saveConfig}
                    style={{
                      padding: '6px 14px', borderRadius: 6, border: 'none',
                      background: 'var(--accent, #4A90D9)', color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 600,
                    }}>
                    💾 保存
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 检测日志 */}
          <div style={{
            background: 'var(--surface-100)', borderRadius: 10, padding: 12,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>📝 检测日志</span>
              <button onClick={() => setLog([])}
                style={{
                  background: 'none', border: 'none', fontSize: 11,
                  color: 'var(--text-tertiary)', cursor: 'pointer',
                }}>
                清空
              </button>
            </div>
            {log.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '8px 0' }}>
                暂无日志，点击「立即检测」开始
              </div>
            ) : (
              <div style={{ maxHeight: 180, overflowY: 'auto', fontSize: 11, color: 'var(--text-secondary)' }}>
                {log.map((entry, i) => (
                  <div key={i} style={{ padding: '2px 0', borderBottom: '1px solid var(--border-light)', lineHeight: 1.6 }}>
                    {entry}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        /* 🆕 v3.0: 使用统计面板 */
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>📊 今日使用统计</span>
            <button onClick={refreshStats}
              style={{
                background: 'none', border: 'none', fontSize: 12, cursor: 'pointer',
                color: 'var(--text-tertiary)',
              }}>
              🔄 刷新
            </button>
          </div>

          {/* 今日概览卡片 */}
          {usage ? (
            <div style={{
              background: 'var(--surface-100)', borderRadius: 10, padding: 12, marginBottom: 12,
              display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8,
            }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{usage.modeSwitches}</div>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>模式切换</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{usage.proactiveCount}</div>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>主动推送</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{usage.messageCount}</div>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>对话消息</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{usage.proactiveReplyRate}%</div>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>回复率</div>
              </div>
            </div>
          ) : (
            <div style={{ background: 'var(--surface-100)', borderRadius: 10, padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 12 }}>
              暂无今日数据，使用后自动记录
            </div>
          )}

          {/* 模式时长分布 */}
          {usage && usage.modeDistribution.length > 0 && (
            <div style={{ background: 'var(--surface-100)', borderRadius: 10, padding: 12, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>今日模式分布</div>
              {usage.modeDistribution.map((m: any) => (
                <div key={m.mode} style={{ marginBottom: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
                    <span>{MODE_LABELS[m.mode as LuminaMode] || m.mode}</span>
                    <span>{m.minutes} 分钟 ({m.percent}%)</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--surface-200)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: `${m.percent}%`, borderRadius: 3,
                      background: m.mode === 'work' ? '#4A90D9' : m.mode === 'study' ? '#7B68EE' : m.mode === 'fun' ? '#FF6B6B' : '#95A5A6',
                      transition: 'width 0.3s',
                    }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 累计模式时长 */}
          {modeDistribution.length > 0 && (
            <div style={{ background: 'var(--surface-100)', borderRadius: 10, padding: 12, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>累计模式时长</div>
              {modeDistribution.map((m: any) => (
                <div key={m.mode} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '3px 0' }}>
                  <span>{MODE_LABELS[m.mode as LuminaMode] || m.mode}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{m.totalMinutes} 分钟</span>
                </div>
              ))}
            </div>
          )}

          {/* 原始数据链接 */}
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center', padding: 8 }}>
            数据仅保存在本地，不会自动上传
          </div>
        </div>
      )}
    </div>
  )
}
