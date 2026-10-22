// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// panels/CustomAgentPanel.tsx — 自定义 Agent 管理面板 (D4)
//
// 列出 / 创建 / 编辑（SOUL.md）/ 删除自定义 Agent；
// leader 角色可设为默认。底层走 custom-agent:* IPC。
// 也支持手动在 electron/agents/custom/<id>/ 下建目录（见 docs/custom-agent-guide.md）。
// ============================================================

import React, { useState, useEffect, useCallback } from 'react'

interface CustomAgent {
  id: string
  name: string
  icon: string
  personality?: string
  teamRole?: 'leader' | 'member' | 'solo'
  toolsets?: string[]
  visible?: boolean
  model?: { provider?: string; model?: string }
}

const api = () => (window as any).luminaAPI

const cardStyle: React.CSSProperties = {
  borderRadius: 10, border: '1px solid var(--border-light)', padding: 14,
  marginBottom: 10, background: 'var(--surface-0)',
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: 7, borderRadius: 7, border: '1px solid var(--border-light)',
  background: 'var(--surface-0)', color: 'var(--text-primary)', marginBottom: 8, fontSize: 12,
}
const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 3, display: 'block' }
const btn: React.CSSProperties = {
  border: 'none', borderRadius: 7, padding: '7px 14px', fontSize: 12, fontWeight: 700,
  cursor: 'pointer', marginRight: 6,
}

export default function CustomAgentPanel({ embedded }: { embedded?: boolean } = {}) {
  const [agents, setAgents] = useState<CustomAgent[]>([])
  const [toolsets, setToolsets] = useState<string[]>(['agent', 'files_core'])
  const [defaultId, setDefaultId] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [soulText, setSoulText] = useState('')
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')

  // 表单
  const [form, setForm] = useState({ id: '', name: '', icon: '🤖', personality: '', teamRole: 'member' as 'leader' | 'member' | 'solo' })

  const refresh = useCallback(async () => {
    try {
      const r = await api().customAgentList()
      if (r.ok) {
        setAgents(r.agents || [])
        setDefaultId(r.defaultLeaderId || '')
        if (r.toolsets && r.toolsets.length) {setToolsets(r.toolsets)}
      } else {setErr(r.error || '加载失败')}
    } catch (e: any) {setErr(e?.message || String(e))}
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const create = async () => {
    setErr(''); setNotice('')
    if (!form.id.trim()) {setErr('请填英文 id（字母开头，如 my_bot）'); return}
    try {
      const r = await api().customAgentCreate({ ...form, id: form.id.trim(), toolsets: ['agent', 'files_core'] })
      if (!r.ok) {setErr(r.error || '创建失败'); return}
      setCreating(false)
      setForm({ id: '', name: '', icon: '🤖', personality: '', teamRole: 'member' })
      setNotice(`已创建「${r.agent.name}」`)
      refresh()
    } catch (e: any) {setErr(e?.message || String(e))}
  }

  const startEdit = async (id: string) => {
    try {
      const r = await api().customAgentGet(id)
      if (r.ok) {setEditingId(id); setSoulText(r.soul || '')}
    } catch {}
  }

  const saveSoul = async () => {
    if (!editingId) {return}
    const r = await api().customAgentUpdate(editingId, { soulContent: soulText })
    if (r.ok) {setEditingId(null); setNotice('已保存 SOUL.md'); refresh()}
  }

  const remove = async (id: string) => {
    if (!confirm(`删除自定义 Agent「${id}」？该操作会删除其目录，不可恢复。`)) {return}
    const r = await api().customAgentDelete(id)
    if (r.ok) {setNotice('已删除'); refresh()}
  }

  const setDefault = async (id: string) => {
    const r = await api().customAgentSetDefault(id)
    if (r.ok) {setDefaultId(id); setNotice('已设为默认 Agent'); refresh()}
    else {setErr(r.error || '设置失败')}
  }

  return (
    <div style={{ padding: embedded ? 0 : 16 }}>
      <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>🤖 自定义 Agent</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>
        创建属于你自己的助手。<b>member</b> 可被 Lumina 委托干活，<b>leader</b> 可设为对你可见的默认助手，
        <b>solo</b> 独立存在。也可以手动在 <code>electron/agents/custom/&lt;id&gt;/</code> 下建目录（见文档）。
      </div>

      {err && <div style={{ background: '#ffecec', color: '#d94848', padding: 8, borderRadius: 7, fontSize: 12, marginBottom: 8 }}>{err}</div>}
      {notice && <div style={{ background: '#e6f9ee', color: '#1f9d55', padding: 8, borderRadius: 7, fontSize: 12, marginBottom: 8 }}>{notice}</div>}

      {loading ? <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>加载中…</div> : (
        <>
          {agents.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>还没有自定义 Agent，点下面按钮创建一个。</div>
          )}

          {agents.map((a) => (
            <div key={a.id} style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontSize: 18, marginRight: 8 }}>{a.icon}</span>
                  <b>{a.name}</b>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 8 }}>
                    {a.teamRole === 'leader' ? '👑 leader（对你可见）' : a.teamRole === 'solo' ? '独立' : '后台成员'}
                  </span>
                  {defaultId === a.id && <span style={{ fontSize: 11, color: '#1f9d55', marginLeft: 6 }}>★ 默认</span>}
                </div>
                <div>
                  {a.teamRole === 'leader' && defaultId !== a.id && (
                    <button style={{ ...btn, background: 'var(--surface-100)', color: 'var(--text-primary)' }} onClick={() => setDefault(a.id)}>设为默认</button>
                  )}
                  <button style={{ ...btn, background: 'var(--surface-100)', color: 'var(--text-primary)' }} onClick={() => startEdit(a.id)}>编辑人格</button>
                  <button style={{ ...btn, background: '#ffecec', color: '#d94848' }} onClick={() => remove(a.id)}>删除</button>
                </div>
              </div>
              {a.personality && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 6 }}>{a.personality}</div>}
              <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 4 }}>
                id: {a.id} · 工具集: {(a.toolsets || []).join(', ') || '默认'}
              </div>

              {editingId === a.id && (
                <div style={{ marginTop: 10, borderTop: '1px solid var(--border-light)', paddingTop: 10 }}>
                  <label style={labelStyle}>SOUL.md（人格文件，UTF-8）</label>
                  <textarea
                    style={{ ...inputStyle, height: 180, fontFamily: 'monospace' }}
                    value={soulText}
                    onChange={(e) => setSoulText(e.target.value)}
                  />
                  <button style={{ ...btn, background: '#4a9eff', color: '#fff' }} onClick={saveSoul}>保存</button>
                  <button style={{ ...btn, background: 'var(--surface-100)', color: 'var(--text-primary)' }} onClick={() => setEditingId(null)}>取消</button>
                </div>
              )}
            </div>
          ))}

          {creating ? (
            <div style={cardStyle}>
              <label style={labelStyle}>英文 id（字母开头，仅字母/数字/_/-）</label>
              <input style={inputStyle} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="my_bot" />
              <label style={labelStyle}>显示名</label>
              <input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="我的助手" />
              <label style={labelStyle}>图标（emoji）</label>
              <input style={inputStyle} value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} />
              <label style={labelStyle}>人格描述</label>
              <input style={inputStyle} value={form.personality} onChange={(e) => setForm({ ...form, personality: e.target.value })} placeholder="一句话描述它的性格与职责" />
              <label style={labelStyle}>团队角色</label>
              <select style={inputStyle} value={form.teamRole} onChange={(e) => setForm({ ...form, teamRole: e.target.value as any })}>
                <option value="member">member（后台成员，可被委托）</option>
                <option value="leader">leader（对你可见，可设默认）</option>
                <option value="solo">solo（独立，不参与团队）</option>
              </select>
              <button style={{ ...btn, background: '#4a9eff', color: '#fff' }} onClick={create}>创建</button>
              <button style={{ ...btn, background: 'var(--surface-100)', color: 'var(--text-primary)' }} onClick={() => setCreating(false)}>取消</button>
            </div>
          ) : (
            <button style={{ ...btn, background: '#4a9eff', color: '#fff' }} onClick={() => setCreating(true)}>＋ 创建新 Agent</button>
          )}
        </>
      )}
    </div>
  )
}
