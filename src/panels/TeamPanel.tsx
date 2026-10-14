// ============================================================
// TeamPanel.tsx — AI 小团队面板 (v2.7.1)
// v9.3: + 动态团队管理（TeamRegistry 集成）
// ============================================================

import React, { useState, useEffect, useMemo } from 'react'
// 群聊成员显示开关（2026-10-04）：默认全开时后台成员持续发言，
// 消息流会眼花缭乱，让用户自己决定谁参与群聊。
import { isAgentVisible, setAgentVisible, type ControllableAgentId } from '../services/teamVisibility'

type AgentActivity = 'sleeping' | 'waking' | 'working' | 'social' | 'idle' | 'resting' | 'analyzing' | 'coding' | 'caring'

interface AgentDef {
  id: string; name: string; icon: string; archetype: string; archetypeLabel: string
  color: string; bg: string; border: string
  personality: string; strengths: string[]; weaknesses: string[]; quirk: string
}

interface DynamicAgent {
  id: string; name: string; icon: string; role: string
  description: string; capabilities: string[]; triggers?: string[]
  registeredAt?: string; isBuiltIn: boolean
}

const AGENTS: AgentDef[] = [
  {
    id: 'luna', name: 'Lumina', icon: '🐱', archetype: 'companion', archetypeLabel: '陪伴猫娘',
    color: '#FF6B6B', bg: '#FFF5F5', border: '#FFD4D4',
    personality: '温暖可爱、偶尔迷糊、会撒娇',
    strengths: ['情感陪伴', '聊天解闷', '文案写作', '日常提醒'],
    weaknesses: ['深层代码', '数据分析', '系统原理'],
    quirk: '句尾爱加「呢」「喵~」',
  },
  {
    id: 'ray', name: '热茶', icon: '🍵', archetype: 'technician', archetypeLabel: '毒舌程序员',
    color: '#448AFF', bg: '#F5F9FF', border: '#D4E8FF',
    personality: '毒舌傲娇、技术极强、嘴硬心软',
    strengths: ['写代码', '修Bug', '系统操作', '技术分析'],
    weaknesses: ['情感安慰', '文学创作', '时尚穿搭'],
    quirk: '嫌弃 Lumina 笨但每次都帮她',
  },
  {
    id: 'sora', name: 'Yak', icon: '📊', archetype: 'analyst', archetypeLabel: '冷静分析师',
    color: '#43A047', bg: '#F5FFF6', border: '#D4FFD6',
    personality: '冷静理性、数据至上、偶尔冷幽默',
    strengths: ['数据分析', '搜索研究', '风险评估', '信息整理'],
    weaknesses: ['即兴创作', '情感表达', '闲聊扯淡'],
    quirk: '说笑话时自己完全不笑',
  },
]

export default function TeamPanel() {
  const hour = new Date().getHours()
  const [dynamicAgents, setDynamicAgents] = useState<DynamicAgent[]>([])
  const [emotions, setEmotions] = useState<Record<string, any>>({})
  // 新增成员表单
  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState({ id: '', name: '', icon: '🤖', description: '', capabilities: '', triggers: '' })
  // ACP 连接配置
  const [showAcpForm, setShowAcpForm] = useState(false)
  const [acpFormData, setAcpFormData] = useState({
    id: '', name: '', icon: '🌐', description: '',
    url: '', apiKey: '', model: '', systemPrompt: '',
    temperature: 0.7, maxTokens: 4096,
    capabilities: '', triggers: '',
  })
  const [acpMembers, setAcpMembers] = useState<any[]>([])

  // 加载动态成员
    const loadDynamic = async () => {
    try {
      const api = (window as any).luminaAPI
      const members = await api.teamListMembers?.() || []
      setDynamicAgents(members.filter((m: any) => !m.isBuiltIn))
      // 🔧 P2: 加载情绪数据
      try {
        const emotionData = await api.teamEmotions?.()
        if (emotionData?.emotions) {setEmotions(emotionData.emotions)}
      } catch {}
      // 加载 ACP 成员
      // 加载 ACP 成员
      const acpResult = await api.acpList?.()
      if (acpResult?.ok) {setAcpMembers(acpResult.dynamic || [])}
    } catch {}
  }

  useEffect(() => { loadDynamic() }, [])

  const getActivity = (agentId: string): { activity: AgentActivity; desc: string } => {
    if (agentId === 'luna') {
      if (hour < 7) {return { activity: 'sleeping', desc: '💤 蜷在窝里睡觉' }}
      if (hour < 9) {return { activity: 'waking', desc: '🥱 伸懒腰等主人起床' }}
      if (hour < 12) {return { activity: 'caring', desc: '💬 陪主人聊天' }}
      if (hour < 13) {return { activity: 'social', desc: '🍱 和热茶、Yak聊午饭' }}
      if (hour < 18) {return { activity: 'working', desc: '📝 帮忙处理日常事务' }}
      if (hour < 22) {return { activity: 'social', desc: '🌙 晚间陪伴时光' }}
      return { activity: 'sleeping', desc: '💤 蜷在窝里睡觉' }
    }
    if (agentId === 'ray') {
      if (hour < 5) {return { activity: 'sleeping', desc: '😴 终于睡了（熬夜写代码）' }}
      if (hour < 10) {return { activity: 'sleeping', desc: '😴 补觉中' }}
      if (hour < 18) {return { activity: 'coding', desc: '💻 写代码 / 修Bug' }}
      return { activity: 'coding', desc: '🌙 深夜写代码（灵感来了）' }
    }
    // sora / yak
    if (hour < 6) {return { activity: 'sleeping', desc: '💤 准时睡觉' }}
    if (hour < 8) {return { activity: 'waking', desc: '☕ 早间数据扫描' }}
    if (hour < 18) {return { activity: 'analyzing', desc: '📊 数据分析中' }}
    return { activity: 'resting', desc: '📖 晚间阅读研究报告' }
  }

  // 注册新成员
  const handleRegister = async () => {
    if (!formData.id || !formData.name) {return}
    const api = (window as any).luminaAPI
    const result = await api.teamRegisterMember?.({
      id: formData.id,
      name: formData.name,
      icon: formData.icon,
      description: formData.description,
      capabilities: formData.capabilities.split(',').map(s => s.trim()).filter(Boolean),
      triggers: formData.triggers.split(',').map(s => s.trim()).filter(Boolean),
    })
    if (result?.ok) {
      setShowForm(false)
      setFormData({ id: '', name: '', icon: '🤖', description: '', capabilities: '', triggers: '' })
      await loadDynamic()
    } else {
      alert(result?.error || '注册失败')
    }
  }

  // 移除成员
  const handleUnregister = async (id: string) => {
    const api = (window as any).luminaAPI
    const result = await api.teamUnregisterMember?.(id)
    if (result?.ok) {
      await loadDynamic()
    } else {
      alert(result?.error || '移除失败')
    }
  }

  // 注册 ACP 成员
  const handleRegisterAcp = async () => {
    if (!acpFormData.name || !acpFormData.url) {return}
    const api = (window as any).luminaAPI
    const result = await api.acpRegister?.({
      ...acpFormData,
      id: acpFormData.id || `acp_${Date.now()}`,
      capabilities: acpFormData.capabilities.split(',').map(s => s.trim()).filter(Boolean),
      triggers: acpFormData.triggers.split(',').map(s => s.trim()).filter(Boolean),
    })
    if (result?.ok) {
      setShowAcpForm(false)
      setAcpFormData({ id: '', name: '', icon: '🌐', description: '', url: '', apiKey: '', model: '', systemPrompt: '', temperature: 0.7, maxTokens: 4096, capabilities: '', triggers: '' })
      await loadDynamic()
    } else {
      alert(result?.error || '注册失败')
    }
  }

  // 移除 ACP 成员
  const handleRemoveAcp = async (id: string) => {
    const api = (window as any).luminaAPI
    const result = await api.acpUnregister?.(id)
    if (result?.ok) {await loadDynamic()}
    else {alert(result?.error || '移除失败')}
  }

  
  // 🔧 P2: 获取 Agent 情绪
  const getEmotion = (agentId: string) => {
    return emotions[agentId] || { mood: 0.3, energy: 0.7, affinity: 0.5, label: '平静' }
  }

  // 🔧 P2: 获取情绪颜色
  const getEmotionColor = (mood: number) => {
    if (mood > 0.6) {return '#10b981'} // 绿色 - 开心
    if (mood > 0.2) {return '#3b82f6'} // 蓝色 - 不错
    if (mood > -0.3) {return '#f59e0b'} // 黄色 - 一般
    return '#ef4444' // 红色 - 低落
  }

  // 🔧 P2: 获取情绪 emoji
  const getEmotionEmoji = (mood: number) => {
    if (mood > 0.6) {return '😄'}
    if (mood > 0.2) {return '😊'}
    if (mood > -0.3) {return '😐'}
    if (mood > -0.6) {return '😔'}
    return '😢'
  }

  // ── 渲染 ──

  // 群聊可见性：写 localStorage 后用自定义事件通知同页其它订阅者
  const [visibleAgents, setVisibleAgents] = useState<Record<ControllableAgentId, boolean>>(
    () => ({ yak: isAgentVisible('yak'), recha: isAgentVisible('recha') }),
  )
  useEffect(() => {
    const onChange = () => setVisibleAgents({ yak: isAgentVisible('yak'), recha: isAgentVisible('recha') })
    window.addEventListener('gc-visible-agents-changed', onChange)
    return () => window.removeEventListener('gc-visible-agents-changed', onChange)
  }, [])
  return (
    <div style={{ padding: 16, height: '100%', overflowY: 'auto', background: 'var(--surface-50)' }}>
      <h3 style={{ marginBottom: 4, fontSize: 16 }}>👥 AI 小团队</h3>
      <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 16 }}>
        v2.7.1: 团队功能已迁移到聊天面板的「团队群聊」中。
      </p>


      {/* 固定成员卡片 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        {AGENTS.map(agent => {
          const state = getActivity(agent.id)
          return (
            <div key={agent.id} style={{
              padding: 14, borderRadius: 10, background: agent.bg,
              border: `1.5px solid ${agent.border}`,
            }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 28 }}>{agent.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: agent.color }}>{agent.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{agent.archetypeLabel}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {getEmotionEmoji(getEmotion(agent.id).mood)} {getEmotion(agent.id).label || '平静'}
                  </div>
                </div>
                <div style={{
                  fontSize: 10, padding: '2px 8px', borderRadius: 10,
                  background: state.activity === 'sleeping' ? '#f3f4f6' : agent.color + '18',
                  color: state.activity === 'sleeping' ? '#9ca3af' : agent.color,
                }}>
                  {state.desc}
                </div>
                {/* 群聊显示开关 —— Lumina 恒可见（她是用户唯一的对话对象，
                    隐藏她等于产品不可用），所以只给 yak / recha 渲染 */}
                {(agent.id === 'yak' || agent.id === 'recha') && (
                  <button
                    onClick={() => {
                      const next = !(agent.id === 'yak' ? visibleAgents.yak : visibleAgents.recha)
                      setAgentVisible(agent.id as ControllableAgentId, next)
                      setVisibleAgents({ yak: isAgentVisible('yak'), recha: isAgentVisible('recha') })
                    }}
                    title={visibleAgents[agent.id as ControllableAgentId]
                      ? '该成员正在团队群聊里发言，点击隐藏'
                      : '该成员已从群聊隐藏，点击恢复'}
                    style={{
                      flexShrink: 0, fontSize: 10, padding: '3px 9px', borderRadius: 10,
                      cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
                      border: '1px solid var(--border-medium)',
                      background: visibleAgents[agent.id as ControllableAgentId]
                        ? 'var(--green-100)' : 'var(--surface-100)',
                      color: visibleAgents[agent.id as ControllableAgentId]
                        ? 'var(--green-500)' : 'var(--text-tertiary)',
                    }}>
                    {visibleAgents[agent.id as ControllableAgentId] ? '🔇 群聊中' : '🔈 已隐藏'}
                  </button>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {agent.personality}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── 动态团队管理 ── */}
      <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 16, marginTop: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h4 style={{ margin: 0, fontSize: 14, color: 'var(--text-primary)' }}>🔧 动态团队成员</h4>
          <button
            onClick={() => setShowForm(!showForm)}
            style={{
              padding: '4px 12px', borderRadius: 6, border: '1px solid #d1d5db',
              background: showForm ? '#f3f4f6' : '#fff', cursor: 'pointer', fontSize: 12,
            }}>
            {showForm ? '取消' : '+ 添加成员'}
          </button>
        </div>

        {/* 注册表单 */}
        {showForm && (
          <div style={{
            padding: 12, borderRadius: 8, background: 'var(--surface-100)',
            border: '1px solid var(--border-light)', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12,
          }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ width: 60, color: 'var(--text-secondary)' }}>ID</label>
              <input value={formData.id} onChange={e => setFormData({ ...formData, id: e.target.value })}
                style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                placeholder="英文 ID（如 code-helper）" />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ width: 60, color: 'var(--text-secondary)' }}>名称</label>
              <input value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })}
                style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                placeholder="显示名称" />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ width: 60, color: 'var(--text-secondary)' }}>图标</label>
              <input value={formData.icon} onChange={e => setFormData({ ...formData, icon: e.target.value })}
                style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                placeholder="emoji（如 👾）" />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <label style={{ width: 60, color: 'var(--text-secondary)' }}>描述</label>
              <textarea value={formData.description} onChange={e => setFormData({ ...formData, description: e.target.value })}
                style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, minHeight: 40 }}
                placeholder="能做什么？" />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ width: 60, color: 'var(--text-secondary)' }}>能力</label>
              <input value={formData.capabilities} onChange={e => setFormData({ ...formData, capabilities: e.target.value })}
                style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                placeholder="英文逗号分隔（如 代码审查,安全审计）" />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ width: 60, color: 'var(--text-secondary)' }}>触发词</label>
              <input value={formData.triggers} onChange={e => setFormData({ ...formData, triggers: e.target.value })}
                style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                placeholder="英文逗号分隔（如 安全,漏洞,审计）" />
            </div>
            <button onClick={handleRegister}
              style={{
                padding: '6px 16px', borderRadius: 6, border: 'none',
                background: '#6366f1', color: '#fff', cursor: 'pointer', fontSize: 12, alignSelf: 'flex-end',
              }}>
              注册
            </button>
          </div>
        )}

        {/* 动态成员列表 */}
        {dynamicAgents.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0' }}>
            暂无动态成员，点击上方「添加成员」注册自定义 Agent
          </div>
        ) : (
          dynamicAgents.map(agent => (
            <div key={agent.id} style={{
              padding: 10, borderRadius: 8, background: 'var(--surface-0)',
              border: '1px solid var(--border-light)', marginBottom: 8, fontSize: 12,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span>{agent.icon || '🤖'}</span>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{agent.name}</span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>@{agent.id}</span>
                    <span style={{ fontSize: 12 }}>{getEmotionEmoji(getEmotion(agent.id).mood)}</span>
                  </div>
                <button
                  onClick={() => handleUnregister(agent.id)}
                  style={{
                    padding: '2px 8px', borderRadius: 4, border: '1px solid #fca5a5',
                    background: 'var(--red-100)', color: '#ef4444', cursor: 'pointer', fontSize: 11,
                  }}>
                  移除
                </button>
              </div>
              {agent.description && (
                <div style={{ color: 'var(--text-secondary)', marginTop: 4, fontSize: 11 }}>{agent.description}</div>
              )}
              {agent.capabilities && agent.capabilities.length > 0 && (
                <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {agent.capabilities.map(c => (
                    <span key={c} style={{
                      padding: '1px 6px', borderRadius: 4, background: '#eef2ff',
                      color: '#6366f1', fontSize: 10,
                    }}>{c}</span>
                  ))}
                </div>
              )}
              {agent.triggers && agent.triggers.length > 0 && (
                <div style={{ marginTop: 2, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {agent.triggers.map(t => (
                    <span key={t} style={{
                      padding: '1px 6px', borderRadius: 4, background: 'var(--border-light)',
                      color: 'var(--text-secondary)', fontSize: 10,
                    }}>⚡{t}</span>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* ── 🆕 v8.1: ACP 解耦 — 支持自定义成员 ── */}
      <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 16, marginTop: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h4 style={{ margin: 0, fontSize: 14 }}>🌐 ACP 自定义成员</h4>
          <button
            onClick={() => setShowAcpForm(!showAcpForm)}
            style={{
              padding: '4px 12px', borderRadius: 6, border: '1px solid #d1d5db',
              background: showAcpForm ? '#f3f4f6' : '#fff', cursor: 'pointer', fontSize: 12,
            }}>
            {showAcpForm ? '取消' : '+ 添加 ACP'}
          </button>
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
          ACP（Agent Communication Protocol）允许你接入外部 AI Agent 作为团队新成员。
          填写它的 API 地址和服务信息即可加入团队。
        </div>

        {/* ACP 注册表单 */}
        {showAcpForm && (
          <div style={{
            padding: 12, borderRadius: 8, background: 'var(--surface-100)',
            border: '1px solid #a78bfa', marginBottom: 12,
            display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12,
          }}>
            <div style={{ fontWeight: 600, color: '#7c3aed', marginBottom: 4 }}>✏️ 添加 ACP 成员</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ width: 80, color: 'var(--text-secondary)' }}>名称 *</label>
              <input value={acpFormData.name} onChange={e => setAcpFormData(f => ({ ...f, name: e.target.value }))}
                style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                placeholder="Agent 名称" />
              <input value={acpFormData.icon} onChange={e => setAcpFormData(f => ({ ...f, icon: e.target.value }))}
                style={{ width: 40, padding: '4px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 14 }}
                placeholder="🌐" />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ width: 80, color: 'var(--text-secondary)' }}>API URL *</label>
              <input value={acpFormData.url} onChange={e => setAcpFormData(f => ({ ...f, url: e.target.value }))}
                style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                placeholder="https://your-agent.com/api/chat" />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ width: 80, color: 'var(--text-secondary)' }}>API Key</label>
              <input type="password" value={acpFormData.apiKey} onChange={e => setAcpFormData(f => ({ ...f, apiKey: e.target.value }))}
                style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                placeholder="可选" />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ width: 80, color: 'var(--text-secondary)' }}>Model</label>
              <input value={acpFormData.model} onChange={e => setAcpFormData(f => ({ ...f, model: e.target.value }))}
                style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                placeholder="gpt-4o / deepseek-chat" />
              <label style={{ fontSize: 11 }}>
                🌡️ {acpFormData.temperature.toFixed(1)}
                <input type="range" min="0" max="2" step="0.1" value={acpFormData.temperature}
                  onChange={e => setAcpFormData(f => ({ ...f, temperature: parseFloat(e.target.value) }))}
                  style={{ width: 50, verticalAlign: 'middle' }} />
              </label>
            </div>
            <textarea value={acpFormData.systemPrompt} onChange={e => setAcpFormData(f => ({ ...f, systemPrompt: e.target.value }))}
              placeholder="System Prompt（告诉这个 Agent 它的角色和行为）"
              rows={2} style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 11, fontFamily: 'inherit' }} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ width: 80, color: 'var(--text-secondary)' }}>能力</label>
              <input value={acpFormData.capabilities} onChange={e => setAcpFormData(f => ({ ...f, capabilities: e.target.value }))}
                style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                placeholder="逗号分隔（如 代码审查,安全审计）" />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ width: 80, color: 'var(--text-secondary)' }}>触发词</label>
              <input value={acpFormData.triggers} onChange={e => setAcpFormData(f => ({ ...f, triggers: e.target.value }))}
                style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                placeholder="逗号分隔（如 安全,漏洞,审计）" />
            </div>
            <button onClick={handleRegisterAcp} disabled={!acpFormData.name || !acpFormData.url}
              style={{
                padding: '6px 16px', borderRadius: 6, border: 'none',
                background: (!acpFormData.name || !acpFormData.url) ? '#d1d5db' : '#7c3aed',
                color: '#fff', cursor: (!acpFormData.name || !acpFormData.url) ? 'default' : 'pointer',
                fontSize: 12, alignSelf: 'flex-end', fontWeight: 600,
              }}>
              ➕ 加入团队
            </button>
          </div>
        )}

        {/* ACP 成员列表 */}
        {acpMembers.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0' }}>
            暂无 ACP 成员，点击上方「添加 ACP」接入外部 Agent
          </div>
        ) : (
          acpMembers.map(agent => (
            <div key={agent.id} style={{
              padding: 10, borderRadius: 8,
              background: agent.acpConfig?.url ? '#f5f3ff' : 'var(--surface-0)',
              border: '1px solid #e4d5f7', marginBottom: 8, fontSize: 12,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span>{agent.icon || '🌐'}</span>
                  <span style={{ fontWeight: 600 }}>{agent.name}</span>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>@{agent.id}</span>
                  {agent.acpConfig?.url && (
                    <span style={{
                      padding: '1px 6px', borderRadius: 4, background: '#dbeafe',
                      color: '#2563eb', fontSize: 10,
                    }}>🟢 已连接</span>
                  )}
                </div>
                <button onClick={() => handleRemoveAcp(agent.id)}
                  style={{
                    padding: '2px 8px', borderRadius: 4, border: '1px solid #fca5a5',
                    background: 'var(--red-100)', color: '#ef4444', cursor: 'pointer', fontSize: 11,
                  }}>
                  移除
                </button>
              </div>
              {agent.description && (
                <div style={{ color: 'var(--text-secondary)', marginTop: 4, fontSize: 11 }}>{agent.description}</div>
              )}
              {agent.acpConfig?.url && (
                <details style={{ marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)' }}>
                  <summary style={{ cursor: 'pointer' }}>ACP 连接详情</summary>
                  <div style={{ marginTop: 4, paddingLeft: 8, borderLeft: '2px solid #e4d5f7' }}>
                    <div>🔗 {agent.acpConfig.url}</div>
                    {agent.acpConfig.model && <div>🧠 {agent.acpConfig.model}</div>}
                    <div>🌡️ {agent.acpConfig.temperature ?? 0.7}</div>
                    {agent.acpConfig.systemPrompt && (
                      <div style={{ marginTop: 4 }}>
                        <div>📝 System Prompt:</div>
                        <div style={{
                          background: '#f8f7ff', borderRadius: 4, padding: 6, marginTop: 2,
                          fontSize: 10, whiteSpace: 'pre-wrap',
                        }}>{agent.acpConfig.systemPrompt}</div>
                      </div>
                    )}
                  </div>
                </details>
              )}
              {agent.capabilities?.length > 0 && (
                <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {agent.capabilities.map((c: string) => (
                    <span key={c} style={{
                      padding: '1px 6px', borderRadius: 4, background: '#eef2ff',
                      color: '#6366f1', fontSize: 10,
                    }}>{c}</span>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
