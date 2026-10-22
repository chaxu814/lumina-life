// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// WorkflowPanel.tsx — 工作流模板面板 (v8.1)
//
// 复杂任务一键套餐
//   - 显示所有模板（内置 + 自定义）
//   - 一键激活
//   - 创建自定义模板
//   - 搜索/标签过滤
// ============================================================

import React, { useState, useEffect } from 'react'
import { showToast } from './Toast'

interface WorkflowTemplate {
  id: string
  name: string
  description: string
  icon: string
  category: 'builtin' | 'custom'
  targetMode?: string
  systemPromptExtra: string
  toolWhitelist?: string[]
  toolBlacklist?: string[]
  temperatureOverride?: number
  proactiveEnabled?: boolean
  tags: string[]
  createdAt: number
  updatedAt: number
}

export default function WorkflowPanel() {
  const api = (window as any).luminaAPI

  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [filtered, setFiltered] = useState<WorkflowTemplate[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [activating, setActivating] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({
    name: '', description: '', icon: '📋', systemPromptExtra: '',
    targetMode: 'work', temperatureOverride: 0.7, proactiveEnabled: false,
    toolWhitelist: '', toolBlacklist: '', tags: '',
  })

  // 加载模板
  useEffect(() => {
    loadTemplates()
  }, [])

  const loadTemplates = async () => {
    try {
      const result = await api?.workflowList?.()
      if (result?.ok) {
        setTemplates(result.templates || [])
        setFiltered(result.templates || [])
      }
    } catch (e) { console.error('WF load error:', e) }
  }

  // 搜索/过滤
  useEffect(() => {
    let list = [...templates]
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tags.some(tg => tg.toLowerCase().includes(q))
      )
    }
    if (activeTag) {
      list = list.filter(t => t.tags.includes(activeTag))
    }
    setFiltered(list)
  }, [searchQuery, activeTag, templates])

  // 获取所有标签
  const allTags = [...new Set(templates.flatMap(t => t.tags))].sort()

  // 激活模板
  const handleActivate = async (id: string) => {
    setActivating(id)
    try {
      const result = await api?.workflowActivate?.(id)
      if (result?.ok) {
        showToast(`✅ 已激活工作流: ${result.template?.name || id}`, 'success')
      } else {
        showToast(`激活失败: ${result?.error || '未知错误'}`, 'error')
      }
    } catch (e: any) {
      showToast(`激活异常: ${e.message}`, 'error')
    } finally {
      setActivating(null)
    }
  }

  // 删除自定义模板
  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确定删除模板「${name}」？`)) {return}
    try {
      const result = await api?.workflowDelete?.(id)
      if (result?.ok) {
        showToast(`已删除: ${name}`, 'success')
        loadTemplates()
      } else {
        showToast(`删除失败: ${result?.error}`, 'error')
      }
    } catch (e: any) {
      showToast(`删除异常: ${e.message}`, 'error')
    }
  }

  // 创建模板
  const handleCreate = async () => {
    if (!createForm.name.trim()) {return}
    try {
      const data: any = {
        name: createForm.name,
        description: createForm.description,
        icon: createForm.icon || '📋',
        systemPromptExtra: createForm.systemPromptExtra,
        targetMode: createForm.targetMode || undefined,
        temperatureOverride: createForm.temperatureOverride,
        proactiveEnabled: createForm.proactiveEnabled,
        tags: createForm.tags.split(/[,\s]+/).filter(Boolean),
      }
      if (createForm.toolWhitelist.trim()) {
        data.toolWhitelist = createForm.toolWhitelist.split(/[,\s]+/).filter(Boolean)
      }
      if (createForm.toolBlacklist.trim()) {
        data.toolBlacklist = createForm.toolBlacklist.split(/[,\s]+/).filter(Boolean)
      }
      const result = await api?.workflowCreate?.(data)
      if (result?.ok) {
        showToast(`✅ 模板已创建: ${createForm.name}`, 'success')
        setShowCreate(false)
        setCreateForm({ name: '', description: '', icon: '📋', systemPromptExtra: '', targetMode: 'work', temperatureOverride: 0.7, proactiveEnabled: false, toolWhitelist: '', toolBlacklist: '', tags: '' })
        loadTemplates()
      } else {
        showToast(`创建失败: ${result?.error}`, 'error')
      }
    } catch (e: any) {
      showToast(`创建异常: ${e.message}`, 'error')
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>📋 工作流模板</h3>
        <button onClick={() => setShowCreate(!showCreate)}
          style={{
            padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border-light)',
            background: 'var(--surface-200)', fontSize: 11, cursor: 'pointer',
          }}>
          {showCreate ? '✕ 关闭' : '✚ 新建模板'}
        </button>
      </div>

      {/* 搜索栏 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <input
          value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
          placeholder="搜索模板名称/描述/标签..."
          style={{
            flex: 1, padding: '6px 10px', borderRadius: 6,
            border: '1px solid var(--border-light)', fontSize: 12, boxSizing: 'border-box',
          }}
        />
      </div>

      {/* 标签过滤 */}
      {allTags.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
          <button onClick={() => setActiveTag(null)}
            style={{
              padding: '3px 8px', borderRadius: 12, fontSize: 10, cursor: 'pointer',
              border: '1px solid var(--border-light)',
              background: activeTag === null ? '#4A90D9' : 'transparent',
              color: activeTag === null ? '#fff' : 'var(--text-secondary)',
            }}>
            全部
          </button>
          {allTags.map(tag => (
            <button key={tag} onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              style={{
                padding: '3px 8px', borderRadius: 12, fontSize: 10, cursor: 'pointer',
                border: '1px solid var(--border-light)',
                background: activeTag === tag ? '#4A90D9' : 'transparent',
                color: activeTag === tag ? '#fff' : 'var(--text-secondary)',
              }}>
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* 创建表单 */}
      {showCreate && (
        <div style={{
          background: 'var(--surface-100)', borderRadius: 10, padding: 12, marginBottom: 12,
          border: '1px dashed var(--accent, #4A90D9)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>✏️ 新建工作流模板</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input value={createForm.name} onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
              placeholder="模板名称 *" style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-light)', fontSize: 12 }} />
            <input value={createForm.description} onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))}
              placeholder="简短描述" style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-light)', fontSize: 12 }} />
            <textarea value={createForm.systemPromptExtra} onChange={e => setCreateForm(f => ({ ...f, systemPromptExtra: e.target.value }))}
              placeholder="System Prompt（告诉 AI 怎么做）" rows={3}
              style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-light)', fontSize: 11, fontFamily: 'inherit', resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <label style={{ fontSize: 11 }}>图标
                <input value={createForm.icon} onChange={e => setCreateForm(f => ({ ...f, icon: e.target.value }))}
                  style={{ width: 40, padding: '4px', borderRadius: 4, border: '1px solid var(--border-light)', fontSize: 14 }} />
              </label>
              <label style={{ fontSize: 11 }}>目标模式
                <select value={createForm.targetMode} onChange={e => setCreateForm(f => ({ ...f, targetMode: e.target.value }))}
                  style={{ padding: '4px', borderRadius: 4, border: '1px solid var(--border-light)', fontSize: 11 }}>
                  <option value="">保持不变</option>
                  <option value="work">💼 工作</option>
                  <option value="study">📚 学习</option>
                  <option value="fun">🎮 娱乐</option>
                  <option value="idle">😴 空闲</option>
                </select>
              </label>
              <label style={{ fontSize: 11 }}>
                🌡️ {createForm.temperatureOverride.toFixed(1)}
                <input type="range" min="0" max="2" step="0.1" value={createForm.temperatureOverride}
                  onChange={e => setCreateForm(f => ({ ...f, temperatureOverride: parseFloat(e.target.value) }))}
                  style={{ width: 50, verticalAlign: 'middle' }} />
              </label>
            </div>
            <input value={createForm.toolWhitelist} onChange={e => setCreateForm(f => ({ ...f, toolWhitelist: e.target.value }))}
              placeholder="可用工具（逗号分隔，为空使用默认）"
              style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-light)', fontSize: 11 }} />
            <input value={createForm.tags} onChange={e => setCreateForm(f => ({ ...f, tags: e.target.value }))}
              placeholder="标签（逗号分隔）" style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-light)', fontSize: 11 }} />
            <button onClick={handleCreate} disabled={!createForm.name.trim()}
              style={{
                padding: '8px', borderRadius: 8, border: 'none',
                background: createForm.name.trim() ? '#4A90D9' : 'var(--border-light)',
                color: '#fff', fontSize: 12, fontWeight: 600, cursor: createForm.name.trim() ? 'pointer' : 'default',
              }}>
              💾 创建模板
            </button>
          </div>
        </div>
      )}

      {/* 模板列表 */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 24, fontSize: 12, color: 'var(--text-tertiary)' }}>
          {templates.length === 0 ? '加载模板中...' : '没有匹配的模板'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(tpl => (
            <div key={tpl.id} style={{
              padding: 12, borderRadius: 10,
              background: 'var(--surface-100)',
              border: '1px solid var(--border-light)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 18 }}>{tpl.icon || '📋'}</span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{tpl.name}</span>
                    {tpl.category === 'builtin' && (
                      <span style={{ fontSize: 9, color: 'var(--text-tertiary)', background: 'var(--surface-200)', padding: '1px 6px', borderRadius: 4 }}>内置</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.4 }}>
                    {tpl.description}
                  </div>
                  {tpl.tags.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                      {tpl.tags.map(tag => (
                        <span key={tag} style={{
                          fontSize: 9, padding: '1px 6px', borderRadius: 8,
                          background: 'var(--surface-200)', color: 'var(--text-tertiary)',
                        }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {tpl.category === 'custom' && (
                    <button onClick={() => handleDelete(tpl.id, tpl.name)}
                      style={{
                        padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-light)',
                        background: 'transparent', fontSize: 11, cursor: 'pointer', color: '#ef4444',
                      }}>
                      🗑️
                    </button>
                  )}
                  <button onClick={() => handleActivate(tpl.id)} disabled={activating === tpl.id}
                    style={{
                      padding: '6px 12px', borderRadius: 6, border: 'none',
                      background: activating === tpl.id ? '#d1d5db' : '#4A90D9',
                      color: '#fff', fontSize: 11, cursor: activating === tpl.id ? 'default' : 'pointer',
                      fontWeight: 600,
                    }}>
                    {activating === tpl.id ? '激活中...' : '🚀 一键启用'}
                  </button>
                </div>
              </div>
              {/* 配置详情 */}
              <details style={{ marginTop: 8, fontSize: 11, color: 'var(--text-tertiary)' }}>
                <summary style={{ cursor: 'pointer' }}>查看配置详情</summary>
                <div style={{ marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--border-light)' }}>
                  {tpl.targetMode && <div>🎯 切换模式: {tpl.targetMode}</div>}
                  {tpl.temperatureOverride != null && <div>🌡️ 温度: {tpl.temperatureOverride}</div>}
                  {tpl.toolWhitelist && tpl.toolWhitelist.length > 0 && (
                    <div>🔧 允许工具: {tpl.toolWhitelist.join(', ')}</div>
                  )}
                  {tpl.toolBlacklist && tpl.toolBlacklist.length > 0 && (
                    <div>🚫 禁止工具: {tpl.toolBlacklist.join(', ')}</div>
                  )}
                  {tpl.systemPromptExtra && (
                    <div style={{ marginTop: 4 }}>
                      <div>📝 系统提示:</div>
                      <div style={{
                        background: 'var(--surface-200)', borderRadius: 4, padding: 6, marginTop: 2,
                        fontSize: 10, whiteSpace: 'pre-wrap', maxHeight: 100, overflowY: 'auto',
                      }}>
                        {tpl.systemPromptExtra}
                      </div>
                    </div>
                  )}
                </div>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
