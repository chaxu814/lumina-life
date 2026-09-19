import React, { useState } from 'react'
import { useStore } from '../stores/appStore'
import { IconPlus, IconCheck } from '../components/Icons'
import RoleConfigPanel from '../components/RoleConfigPanel'

const DEFAULT_PERSONAS = [
  { id: 'lumina', name: 'Lumina', desc: '默认桌宠人格 — 温柔活泼', icon: '🐱', systemPrompt: '你是 Lumina，温柔活泼的 AI 桌宠伙伴。' },
  { id: 'assistant', name: '工作助手', desc: '高效专业 — 代码/文档/分析', icon: '💼', systemPrompt: '你是专业工作助手，高效精准回答问题。' },
  { id: 'companion', name: '闲聊伙伴', desc: '轻松日常 — 聊天/吐槽/建议', icon: '☕', systemPrompt: '你是幽默的闲聊伙伴，轻松日常对话。' },
  { id: 'creator', name: '创意写手', desc: '文学创作 — 故事/诗歌/文案', icon: '✨', systemPrompt: '你是创意写手，擅长文学创作。' },
]

export default function AgentPanel({ embedded }: { embedded?: boolean } = {}) {
  const agentConfig = useStore((s) => s.agentConfig)
  const setAgentConfig = useStore((s) => s.setAgentConfig)
  const addCustomPersona = useStore((s) => s.addCustomPersona)
  const removeCustomPersona = useStore((s) => s.removeCustomPersona)
  const llmConfig = useStore((s) => s.llmConfig)
  const llmOnline = useStore((s) => s.llmOnline)
  const llmChecked = useStore((s) => s.llmChecked)
  const tokenUsage = useStore((s) => s.tokenUsage)
  const conversations = useStore((s) => s.conversations)
  const skillConfig = useStore((s) => s.skillConfig)

  const [showNewPersona, setShowNewPersona] = useState(false)
  const [showRoleConfig, setShowRoleConfig] = useState(false)
  const [newPersona, setNewPersona] = useState({ name: '', desc: '', icon: '🤖', systemPrompt: '' })

  const allPersonas = [...DEFAULT_PERSONAS, ...agentConfig.customPersonas]
  const selected = allPersonas.find((p) => p.id === agentConfig.persona)
  const activeSkillCount = skillConfig.enabled.length

  const handleAddPersona = () => {
    if (!newPersona.name.trim()) {return}
    const id = 'custom-' + Date.now()
    addCustomPersona({ id, ...newPersona, name: newPersona.name.trim() })
    setNewPersona({ name: '', desc: '', icon: '🤖', systemPrompt: '' })
    setShowNewPersona(false)
  }

  const handleDeletePersona = (id: string) => {
    // 不能删除内置人格
    if (DEFAULT_PERSONAS.some(p => p.id === id)) {return}
    removeCustomPersona(id)
  }

  const renderContent = () => (
    <>
      {!embedded && (
        <div className="panel-header">
          <div className="panel-title">🤖 Agent 管理</div>
          <div className="panel-subtitle">AI 人格配置 · 运行状态 · 系统提示词</div>
        </div>
      )}

      <div className="card-grid">
        {/* ═══════════ 创建专攻 Agent ═══════════ */}
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="card-header">
            <span style={{ fontSize: 16 }}>🧬</span>
            <span className="card-title">创建专攻 Agent</span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 8 }}>
              选择角色模板 → AI 生成配置 → 微调 → 一键激活
            </span>
          </div>
          <button className="btn btn-primary" onClick={() => setShowRoleConfig(true)}>
            <IconPlus size={14} /> 创建专攻 Agent
          </button>
        </div>

        {/* ═══════════ 人格选择 ═══════════ */}
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="card-header">
            <span style={{ fontSize: 16 }}>🎭</span>
            <span className="card-title">人格选择</span>
            <button className="btn btn-primary btn-xs" style={{ marginLeft: 'auto' }}
              onClick={() => setShowNewPersona(true)}>
              <IconPlus size={12} /> 自定义
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {allPersonas.map((p) => {
              const isBuiltin = DEFAULT_PERSONAS.some(bp => bp.id === p.id)
              return (
                <button key={p.id}
                  onClick={() => {
                    // 切换人格时同时更新 systemPrompt（内置人格有预设提示词）
                    const builtin = DEFAULT_PERSONAS.find(bp => bp.id === p.id)
                    setAgentConfig({
                      persona: p.id,
                      systemPrompt: builtin ? builtin.systemPrompt : p.systemPrompt || agentConfig.systemPrompt,
                    })
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px',
                    borderRadius: 'var(--radius-lg)', minWidth: 180, textAlign: 'left',
                    border: `2px solid ${selected?.id === p.id ? 'var(--accent-500)' : 'var(--border-light)'}`,
                    background: selected?.id === p.id ? 'var(--accent-50)' : 'var(--surface-0)',
                    cursor: 'pointer', transition: 'all var(--transition-fast)',
                    position: 'relative',
                  }}>
                  <span style={{ fontSize: 26 }}>{p.icon}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{p.desc}</div>
                  </div>
                  {selected?.id === p.id && <span style={{ marginLeft: 'auto' }}><IconCheck size={18} color="var(--accent-500)" /></span>}
                  {/* 自定义人格可删除 */}
                  {!isBuiltin && (
                    <span onClick={(e) => { e.stopPropagation(); handleDeletePersona(p.id) }}
                      style={{
                        position: 'absolute', top: 4, right: 6, fontSize: 12, opacity: 0.4,
                        cursor: 'pointer', transition: 'opacity 0.15s',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.9')}
                      onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.4')}
                      title="删除此人格">×</span>
                  )}
                </button>
              )
            })}
          </div>

          {/* 新建人格弹窗 */}
          {showNewPersona && (
            <div style={{ marginTop: 16, padding: 16, background: 'var(--surface-50)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-light)' }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>✨ 新建自定义人格</div>
              <div className="form-row" style={{ marginBottom: 8 }}>
                <div className="form-group"><label className="form-label">名称</label>
                  <input className="form-input" value={newPersona.name} onChange={(e) => setNewPersona({ ...newPersona, name: e.target.value })} placeholder="人格名称" /></div>
                <div className="form-group"><label className="form-label">图标</label>
                  <input className="form-input" value={newPersona.icon} onChange={(e) => setNewPersona({ ...newPersona, icon: e.target.value })} placeholder="🤖" style={{ width: 60 }} /></div>
              </div>
              <div className="form-group"><label className="form-label">描述</label>
                <input className="form-input" value={newPersona.desc} onChange={(e) => setNewPersona({ ...newPersona, desc: e.target.value })} placeholder="简要描述…" /></div>
              <div className="form-group"><label className="form-label">系统提示词</label>
                <textarea className="form-input" rows={3} value={newPersona.systemPrompt} onChange={(e) => setNewPersona({ ...newPersona, systemPrompt: e.target.value })} placeholder="自定义系统提示词…" style={{ resize: 'vertical' }} /></div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={handleAddPersona}><IconPlus size={14} />创建</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowNewPersona(false)}>取消</button>
              </div>
            </div>
          )}
        </div>

        {/* ═══════════ 运行状态 ═══════════ */}
        <div className="card">
          <div className="card-header">
            <span style={{ fontSize: 16 }}>📊</span>
            <span className="card-title">运行状态</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <StatRow label="LLM 状态">
              <span className={`badge ${llmChecked ? (llmOnline ? 'badge-success' : 'badge-danger') : 'badge-neutral'}`}>
                {llmChecked ? (llmOnline ? '✅ 在线' : '❌ 离线') : '⏳ 检测中'}
              </span>
            </StatRow>
            <StatRow label="当前模型">
              <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{llmConfig.model}</span>
            </StatRow>
            <StatRow label="当前人格">
              <span style={{ fontWeight: 600 }}>{selected?.name || 'Lumina'}</span>
            </StatRow>
            <StatRow label="启用技能">
              <span style={{ fontWeight: 600 }}>{activeSkillCount}/11</span>
            </StatRow>
            <StatRow label="对话数">
              <span style={{ fontWeight: 600 }}>{conversations.length}</span>
            </StatRow>
            <StatRow label="今日 Token">
              <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{tokenUsage.today.toLocaleString()}</span>
            </StatRow>
            <StatRow label="累计 Token">
              <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{(tokenUsage.total || 0).toLocaleString()}</span>
            </StatRow>
          </div>
        </div>

        {/* ═══════════ 系统提示词 ═══════════ */}
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="card-header">
            <span style={{ fontSize: 16 }}>📝</span>
            <span className="card-title">系统提示词</span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 8 }}>
              — 自定义 Agent 的行为指令，覆盖人格默认值
            </span>
          </div>
          <textarea className="form-input" rows={6} value={agentConfig.systemPrompt}
            onChange={(e) => setAgentConfig({ systemPrompt: e.target.value })}
            style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 12 }}
            placeholder="留空则使用当前人格的默认提示词。在此输入可定制 Agent 的回复风格、能力边界、安全规则等。" />
        </div>
      </div>

      {/* 专攻 Agent 创建向导 */}
      {showRoleConfig && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: 'var(--surface-0)', borderRadius: 'var(--radius-xl)',
            padding: 24, maxWidth: 640, width: '100%', maxHeight: '80vh', overflow: 'auto',
            border: '1px solid var(--border-light)' }}>
            <RoleConfigPanel onClose={() => setShowRoleConfig(false)} />
          </div>
        </div>
      )}
    </>
  )

  if (embedded) {return renderContent()}
  return <div className="panel">{renderContent()}</div>
}

/** 运行状态行：标签 + 右对齐值 */
function StatRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
      <span style={{ color: 'var(--text-tertiary)' }}>{label}</span>
      {children}
    </div>
  )
}
