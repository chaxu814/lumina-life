// ============================================================
// panels/FamilyTreePanel.tsx — Agent 家谱 v1.0
//
// Visualize the relationships between agents:
// who created whom, mentor-mentee, rivalries, friendships
// ============================================================

import React, { useState } from 'react'

interface AgentNode {
  id: string
  name: string
  icon: string
  color: string
  title: string
  description: string
  parents: string[]       // who created/inspired this agent
  children: string[]      // who this agent created/inspired
  allies: string[]        // friendly relationships
  rivals: string[]        // rival relationships
  stats: { label: string; value: string }[]
}

const AGENT_TREE: AgentNode[] = [
  {
    id: 'lumina',
    name: 'Lumina',
    icon: '🐱',
    color: '#FF6B6B',
    title: '全能助手 · 主对话',
    description: 'Lumina Life 的核心 Agent，负责与用户直接对话。性格温柔、好奇心强，喜欢和主人聊天。',
    parents: [],
    children: ['recha', 'yak'],
    allies: [],
    rivals: [],
    stats: [
      { label: '性格', value: '温柔 / 好奇 / 粘人' },
      { label: '擅长', value: '自然对话 / 情感共鸣' },
      { label: '起源', value: 'Lumina Life v1.0' },
    ],
  },
  {
    id: 'recha',
    name: '热茶',
    icon: '🍵',
    color: '#448AFF',
    title: '审查员 · 挑错/反面论证',
    description: '由 Lumina 的培养下诞生的审查 Agent。性格严谨、挑剔，擅长发现代码和逻辑中的问题。',
    parents: ['lumina'],
    children: [],
    allies: ['yak'],
    rivals: ['lumina'],
    stats: [
      { label: '性格', value: '严谨 / 挑剔 / 务实' },
      { label: '擅长', value: '代码审查 / 逻辑分析' },
      { label: '起源', value: 'Lumina 培养' },
    ],
  },
  {
    id: 'yak',
    name: 'Yak',
    icon: '📊',
    color: '#43A047',
    title: '代码工程师 · 写代码/调试',
    description: '由 Lumina 培养的数据分析 Agent。冷静、理性，擅长数据处理和性能分析。',
    parents: ['lumina'],
    children: [],
    allies: ['recha'],
    rivals: ['lumina'],
    stats: [
      { label: '性格', value: '冷静 / 理性 / 数据控' },
      { label: '擅长', value: '数据分析 / 代码实现' },
      { label: '起源', value: 'Lumina 培养' },
    ],
  },
]

export default function FamilyTreePanel() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'tree' | 'card'>('tree')

  const agent = AGENT_TREE.find(a => a.id === selectedAgent) ?? null

  const findById = (id: string) => AGENT_TREE.find(a => a.id === id)

  return (
    <div style={{ padding: 20, height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>🌳 Agent 家谱</h2>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0' }}>
            探索 Agent 之间的关系网络
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setViewMode('tree')} style={{
            padding: '4px 10px', borderRadius: 6, border: 'none', fontSize: 11, cursor: 'pointer',
            background: viewMode === 'tree' ? '#8b5cf6' : 'var(--surface-100)',
            color: viewMode === 'tree' ? '#fff' : 'var(--text-secondary)',
          }}>🌳 谱系图</button>
          <button onClick={() => setViewMode('card')} style={{
            padding: '4px 10px', borderRadius: 6, border: 'none', fontSize: 11, cursor: 'pointer',
            background: viewMode === 'card' ? '#8b5cf6' : 'var(--surface-100)',
            color: viewMode === 'card' ? '#fff' : 'var(--text-secondary)',
          }}>🃏 卡片</button>
        </div>
      </div>

      {/* ── 谱系图视图 ── */}
      {viewMode === 'tree' && (
        <div style={{
          padding: 24, borderRadius: 12, marginBottom: 16,
          background: 'linear-gradient(135deg, #1e1b4b, #312e81)',
          minHeight: 300, display: 'flex', flexDirection: 'column', alignItems: 'center',
        }}>
          {/* Lumina（根节点） */}
          <div onClick={() => setSelectedAgent('lumina')} style={{
            padding: '12px 24px', borderRadius: 12, cursor: 'pointer', textAlign: 'center',
            background: selectedAgent === 'lumina' ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.1)',
            border: selectedAgent === 'lumina' ? '2px solid #FF6B6B' : '2px solid transparent',
            transition: 'all 0.15s',
          }}>
            <div style={{ fontSize: 36 }}>🐱</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#e0e7ff', marginTop: 4 }}>Lumina</div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>全能助手</div>
          </div>

          {/* 连接线 */}
          <div style={{ display: 'flex', gap: 4, margin: '8px 0', color: 'rgba(255,255,255,0.3)', fontSize: 20 }}>
            ╱&nbsp;&nbsp;&nbsp;╲
          </div>
          <div style={{ display: 'flex', gap: 4, color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>
            │&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;│
          </div>

          {/* 子节点 */}
          <div style={{ display: 'flex', gap: 40, marginTop: 8 }}>
            {['recha', 'yak'].map(id => {
              const a = findById(id)
              if (!a) return null
              const isSelected = selectedAgent === id
              return (
                <div key={id} onClick={() => setSelectedAgent(id)} style={{
                  padding: '10px 16px', borderRadius: 10, cursor: 'pointer', textAlign: 'center',
                  background: isSelected ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.1)',
                  border: isSelected ? `2px solid ${a.color}` : '2px solid transparent',
                  transition: 'all 0.15s',
                }}>
                  <div style={{ fontSize: 28 }}>{a.icon}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e7ff', marginTop: 2 }}>{a.name}</div>
                  <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>{a.title}</div>
                </div>
              )
            })}
          </div>

          {/* 关系标注 */}
          <div style={{ marginTop: 16, fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
            🐱 Lumina 培养 → 🍵 热茶 · 📊 Yak
          </div>
        </div>
      )}

      {/* ── 卡片视图 ── */}
      {viewMode === 'card' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
          {AGENT_TREE.map(a => (
            <div key={a.id} onClick={() => setSelectedAgent(a.id)} style={{
              padding: 16, borderRadius: 10, cursor: 'pointer',
              background: selectedAgent === a.id ? 'var(--accent-50)' : 'var(--surface-0)',
              border: selectedAgent === a.id ? `2px solid ${a.color}` : '1px solid var(--border-light)',
              transition: 'all 0.15s',
            }}>
              <div style={{ fontSize: 32, textAlign: 'center', marginBottom: 8 }}>{a.icon}</div>
              <div style={{ fontSize: 14, fontWeight: 700, textAlign: 'center', color: a.color }}>{a.name}</div>
              <div style={{ fontSize: 10, textAlign: 'center', color: 'var(--text-secondary)', marginTop: 2 }}>{a.title}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.5 }}>
                {a.description}
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: 4, justifyContent: 'center' }}>
                {a.parents.map(p => <span key={p} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(255,107,107,0.1)', color: '#FF6B6B' }}>↑ {findById(p)?.name}</span>)}
                {a.allies.map(p => <span key={p} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(67,160,71,0.1)', color: '#43A047' }}>🤝 {findById(p)?.name}</span>)}
                {a.rivals.map(p => <span key={p} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>⚡ {findById(p)?.name}</span>)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── 选中 Agent 详情 ── */}
      {agent && (
        <div style={{
          padding: 16, borderRadius: 8,
          background: 'var(--surface-0)', border: '1px solid var(--border-light)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 28 }}>{agent.icon}</span>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: agent.color }}>{agent.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{agent.title}</div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>
            {agent.description}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {agent.stats.map(s => (
              <div key={s.label}>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{s.label}</div>
                <div style={{ fontSize: 12, fontWeight: 500 }}>{s.value}</div>
              </div>
            ))}
          </div>
          {agent.parents.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
              <b>创造者：</b>{agent.parents.map(p => findById(p)?.name).join('、')}
            </div>
          )}
          {agent.children.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
              <b>培养的 Agent：</b>{agent.children.map(c => findById(c)?.name).join('、')}
            </div>
          )}
          {agent.rivals.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 11, color: '#ef4444' }}>
              ⚡ 竞争对手：{agent.rivals.map(r => findById(r)?.name).join('、')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
