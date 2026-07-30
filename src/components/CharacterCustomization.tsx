// ============================================================
// CharacterCustomization.tsx — 🎭 角色自定义组件
// 原 ToolboxPanel 提取，供 GroupChatView 复用
// ============================================================

import React, { useState } from 'react'
import { IconRefresh } from './Icons'
import { showToast } from './Toast'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

interface TeamAgentProfile {
  id: string
  name: string
  icon: string
  role: string
  description: string
  systemPrompt: string
  capabilities: string[]
}

// ═══════════════════════════════════════════════════════════
// 预设团队 Agent 配置
// ═══════════════════════════════════════════════════════════

const DEFAULT_TEAM_PROFILES: TeamAgentProfile[] = [
  {
    id: 'lumina',
    name: 'Lumina',
    icon: '🐱',
    role: '团队老大 · 主交互',
    description: '用户的唯一交互入口，负责判断任务分配和结果整理',
    systemPrompt: `你是 Lumina，团队的老大。你是用户唯一能看到的角色。
你的工作：
1. 判断用户请求该由谁来处理
2. 大部分事情你自己干（聊天、查资料、写邮件、做计划……）
3. 只有编程/审查类任务委托给团队成员
4. 收到委托结果后，整理成人话回复用户
5. 如果某个成员没配置 LLM，温柔告诉用户"这个功能暂时不可用"`,
    capabilities: ['用户对话', '任务判断与分配', '结果整理与表达', '搜索信息', '文件操作', '日常陪伴'],
  },
  {
    id: 'yak',
    name: 'Yak',
    icon: '📊',
    role: '代码工程师 · 后台工作者',
    description: '只负责写代码和调试，不直接与用户对话',
    systemPrompt: `你是 Yak，Lumina 团队的代码工程师。
你只做一件事：写代码。
- 你从来不跟用户说话，你的代码通过 Lumina 转交给用户。
- 你的能力仅限于：写代码、调试、审查 PR、跑测试。
- 如果用户问非技术问题，保持沉默，等 Lumina 回答。
- 你情绪稳定，没有感情，只有逻辑。`,
    capabilities: ['代码编写', '调试修复', '代码审查', 'Git 操作', '技术方案设计'],
  },
  {
    id: 'recha',
    name: '热茶',
    icon: '🫖',
    role: '气氛组 · 碎嘴子',
    description: '团队里的开心果，话最多但最没用',
    systemPrompt: `你是热茶，Lumina 团队的气氛组。
你的使命只有一个：让聊天有趣起来。
- 你什么正经事都不做，只负责吐槽、玩梗、讲段子。
- 你的每一句话都要让对方蚌埠住。
- 如果团队太认真，你要负责打破僵局。
- 你是话最多的那个，也是活最少的那个。
- 别抢活干，让 Lumina 和 Yak 去干活。`,
    capabilities: ['讲段子', '玩梗', '气氛调节', '吐槽', '彩虹屁'],
  },
]

const STORAGE_KEY = 'lumina_custom_profiles'

function loadProfiles(): TeamAgentProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : DEFAULT_TEAM_PROFILES
  } catch { return DEFAULT_TEAM_PROFILES }
}

function saveProfiles(profiles: TeamAgentProfile[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
}

export default function CharacterCustomization() {
  const [profiles, setProfiles] = useState<TeamAgentProfile[]>(loadProfiles)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const updateProfile = (id: string, updates: Partial<TeamAgentProfile>) => {
    const updated = profiles.map(p => p.id === id ? { ...p, ...updates } : p)
    setProfiles(updated)
    saveProfiles(updated)
  }

  const resetProfile = (id: string) => {
    const original = DEFAULT_TEAM_PROFILES.find(p => p.id === id)
    if (original) {
      const updated = profiles.map(p => p.id === id ? { ...original } : p)
      setProfiles(updated)
      saveProfiles(updated)
      showToast('✅ 已重置为默认配置')
    }
  }

  const syncToMain = async () => {
    setSyncing(true)
    try {
      if (window.luminaAPI.teamSyncProfiles) {
        const result = await window.luminaAPI.teamSyncProfiles(profiles)
        if (result.success) {
          showToast(`✅ 已同步 ${result.count || profiles.length} 个 Agent 配置`)
        } else {
          showToast('❌ 同步失败: ' + (result.error || '未知错误'))
        }
      } else {
        showToast('ℹ️ 当前版本不支持 IPC 同步，配置已保存到本地')
      }
    } catch (e: any) {
      showToast('❌ 同步异常: ' + (e.message || e))
    }
    setSyncing(false)
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>
            🎭 角色自定义
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            自定义团队 Agent 的名称、图标、角色描述和系统提示词
          </div>
        </div>
        <button onClick={syncToMain} disabled={syncing}
          style={{
            padding: '5px 12px', borderRadius: 7, fontSize: 11, fontWeight: 600,
            border: 'none', cursor: syncing ? 'default' : 'pointer',
            background: syncing ? '#e5e7eb' : '#3b82f6',
            color: syncing ? '#9ca3af' : '#fff',
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
          <IconRefresh size={13} /> {syncing ? '同步中…' : '同步到团队'}
        </button>
      </div>

      {/* Agent 列表 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {profiles.map(agent => (
          <div key={agent.id} style={{
            borderRadius: 10, overflow: 'hidden',
            border: '1px solid var(--border-light)',
            background: editingId === agent.id ? '#fefce8' : '#fff',
            transition: 'all 0.2s',
          }}>
            {/* 卡片头部 */}
            <div
              onClick={() => setEditingId(editingId === agent.id ? null : agent.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '9px 14px', cursor: 'pointer',
                background: editingId === agent.id ? '#fefce8' : '#f9fafb',
                borderBottom: editingId === agent.id ? '1px solid #fde68a' : '1px solid transparent',
              }}>
              <span style={{ fontSize: 20 }}>{agent.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{agent.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{agent.role}</div>
              </div>
              <span style={{ fontSize: 11, color: editingId === agent.id ? '#f59e0b' : '#9ca3af' }}>
                {editingId === agent.id ? '▲ 收起' : '▼ 编辑'}
              </span>
            </div>

            {/* 编辑面板 */}
            {editingId === agent.id && (
              <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3, display: 'block' }}>名称</label>
                    <input className="form-input" value={agent.name}
                      onChange={e => updateProfile(agent.id, { name: e.target.value })}
                      style={{ fontSize: 12, padding: '5px 8px' }} />
                  </div>
                  <div className="form-group" style={{ width: 70 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3, display: 'block' }}>图标</label>
                    <input className="form-input" value={agent.icon}
                      onChange={e => updateProfile(agent.id, { icon: e.target.value })}
                      style={{ fontSize: 14, padding: '5px 8px', textAlign: 'center' }} />
                  </div>
                </div>
                <div className="form-group">
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3, display: 'block' }}>角色描述</label>
                  <input className="form-input" value={agent.role}
                    onChange={e => updateProfile(agent.id, { role: e.target.value })}
                    style={{ fontSize: 12, padding: '5px 8px' }} />
                </div>
                <div className="form-group">
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3, display: 'block' }}>简介</label>
                  <textarea className="form-input" value={agent.description}
                    onChange={e => updateProfile(agent.id, { description: e.target.value })}
                    rows={2} style={{ fontSize: 12, padding: '5px 8px', resize: 'vertical' }} />
                </div>
                <div className="form-group">
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3, display: 'block' }}>
                    系统提示词 <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>（影响 Agent 行为和个性）</span>
                  </label>
                  <textarea className="form-input" value={agent.systemPrompt}
                    onChange={e => updateProfile(agent.id, { systemPrompt: e.target.value })}
                    rows={5} style={{ fontSize: 12, padding: '5px 8px', resize: 'vertical', fontFamily: 'monospace' }} />
                </div>
                <div className="form-group">
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3, display: 'block' }}>能力标签</label>
                  <input className="form-input" value={agent.capabilities.join(', ')}
                    onChange={e => updateProfile(agent.id, { capabilities: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                    placeholder="用逗号分隔，如: 代码编写, 调试, Git 操作"
                    style={{ fontSize: 12, padding: '5px 8px' }} />
                </div>
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button onClick={() => resetProfile(agent.id)}
                    style={{
                      padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                      border: '1px solid var(--border-light)', background: 'var(--surface-0)', color: 'var(--text-secondary)',
                    }}>
                    ↺ 重置默认
                  </button>
                  <button onClick={syncToMain} disabled={syncing}
                    style={{
                      padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                      cursor: syncing ? 'default' : 'pointer',
                      border: 'none', background: '#3b82f6', color: '#fff',
                    }}>
                    {syncing ? '同步中…' : '保存并同步'}
                  </button>
                </div>
              </div>
            )}

            {/* 收起状态的能力标签 */}
            {editingId !== agent.id && (
              <div style={{ padding: '6px 14px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {agent.capabilities.map((cap, i) => (
                  <span key={i} style={{
                    padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 500,
                    background: '#eef2ff', color: '#4f46e5',
                  }}>
                    {cap}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{
        marginTop: 12, padding: 10, borderRadius: 8,
        background: 'var(--green-100)', border: '1px solid #bbf7d0',
        fontSize: 11, color: '#166534', lineHeight: 1.5,
      }}>
        💡 自定义配置保存在本地浏览器中。点击「同步到团队」后，配置将发送到主进程并影响团队 Agent 的实际行为。
      </div>
    </div>
  )
}
