// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import React, { useState, useEffect } from 'react'
import { useStore } from '../stores/appStore'
import { IconPlus } from '../components/Icons'

// ── 内置技能（v2.5: 映射到 Agent 真实工具）──────────────────
const BUILTIN_SKILLS = [
  { id: 'weather',    name: '天气查询',   desc: '实时天气与预报 · 1 工具',    icon: '🌤️' },
  { id: 'search',     name: '智能搜索',   desc: '多引擎搜索+网页抓取 · 4 工具', icon: '🔍' },
  { id: 'browser',    name: '浏览器联网', desc: '打开网页操控浏览器 · 1 工具',  icon: '🌐' },
  { id: 'memory',     name: '记忆管理',   desc: '长期记忆读写检索 · 5 工具',   icon: '🧠' },
  { id: 'code',       name: '代码助手',   desc: '审查+搜索+终端执行 · 3 工具', icon: '💻' },
  { id: 'files',      name: '文件操作',   desc: '读写编辑列表文件 · 4 工具',   icon: '📁' },
  { id: 'desktop',    name: '桌面控制',   desc: '点击键入截图OCR · 5 工具',    icon: '🖥️' },
  { id: 'audio',      name: '听觉系统',   desc: '语音输入+被动监听 · 4 工具',  icon: '🎤' },
  { id: 'notify',     name: '消息通知',   desc: '系统级桌面推送 · 1 工具',     icon: '🔔' },
  { id: 'timer',      name: '定时任务',   desc: '闹钟与定时提醒 · 3 工具',     icon: '⏰' },
  { id: 'proactive',  name: '主动对话',   desc: 'AI主动搭话管理 · 2 工具',     icon: '💬' },
]

// ── v2.5: 已废弃的旧技能 ID (保留兼容) ────────────────────
const LEGACY_IDS = ['news', 'stock', 'translate', 'image']

// ── 已导入的 Skill 类型 ────────────────────────────────────
interface InstalledSkill {
  id: string
  name: string
  description: string
  version: string
  installedAt: number
  tools: string[]
  knowledge: string[]
}

export default function SkillsPanel({ embedded }: { embedded?: boolean } = {}) {
  const skillConfig = useStore((s) => s.skillConfig)
  const setSkillConfig = useStore((s) => s.setSkillConfig)
  const addAuditLog = useStore((s) => s.addAuditLog)

  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([])
  const [installing, setInstalling] = useState(false)
  const [installMsg, setInstallMsg] = useState('')
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null)

  // 加载已安装的 Skill
  useEffect(() => { refreshInstalledSkills() }, [])

  const refreshInstalledSkills = async () => {
    try {
      const result = await window.luminaAPI.skillList()
      if (result?.skills) {setInstalledSkills(result.skills)}
    } catch (err) {
      console.warn('[SkillsPanel] 无法加载已安装 Skill:', err)
    }
  }

  const toggleSkill = (id: string) => {
    const has = skillConfig.enabled.includes(id)
    const newEnabled = has ? skillConfig.enabled.filter((s) => s !== id) : [...skillConfig.enabled, id]
    setSkillConfig({ enabled: newEnabled })
    const allSkills = [...BUILTIN_SKILLS, ...installedSkills.map(s => ({ id: s.id, name: s.name, desc: s.description, icon: '📦' }))]
    const skill = allSkills.find((s) => s.id === id)
    addAuditLog({
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      action: `${has ? '🔴 停用' : '🟢 启用'}技能 — ${skill?.name || id}`,
      type: 'skill',
    })
  }

  // 🔥 导入 Skill 压缩包
  const handleImportSkillZip = async () => {
    setInstalling(true)
    setInstallMsg('打开文件选择...')
    try {
      const result = await window.luminaAPI.skillOpenDialog()
      if (result?.cancelled) {
        setInstallMsg('已取消')
      } else if (result?.success) {
        const s = result.skill
        setInstallMsg(`✅ 安装成功: ${s.name} v${s.version} (${s.tools.length} 工具, ${s.knowledge.length} 知识)`)
        addAuditLog({
          time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          action: `📦 导入 Skill: ${s.name} v${s.version}`,
          type: 'skill',
        })
        refreshInstalledSkills()
      } else {
        setInstallMsg(`❌ ${result?.error || '安装失败'}`)
        addAuditLog({
          time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          action: `❌ Skill 导入失败: ${result?.error}`,
          type: 'skill',
        })
      }
    } catch (err: any) {
      setInstallMsg(`❌ ${err.message}`)
    } finally {
      setInstalling(false)
    }
  }

  // 卸载 Skill
  const handleUninstall = async (skillId: string) => {
    try {
      const result = await window.luminaAPI.skillUninstall(skillId)
      if (result.success) {
        addAuditLog({
          time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          action: `🗑️ 卸载 Skill: ${skillId}`,
          type: 'skill',
        })
        refreshInstalledSkills()
      }
    } catch {}
  }

  const activeCount = BUILTIN_SKILLS.filter((s) => skillConfig.enabled.includes(s.id)).length

  const renderContent = () => (
    <div>
      {!embedded && (
        <div className="panel-header">
          <div className="panel-title">⚡ 技能</div>
          <div className="panel-subtitle">
            {activeCount}/{BUILTIN_SKILLS.length} 内置激活
            {installedSkills.length > 0 && ` · ${installedSkills.length} 个导入`}
          </div>
        </div>
      )}

      {/* ── 内置技能网格 ─────────────────────────────── */}
      <div className="card-grid">
        {BUILTIN_SKILLS.map((skill) => {
          const enabled = skillConfig.enabled.includes(skill.id)
          return (
            <div key={skill.id} className="card" style={{
              opacity: enabled ? 1 : 0.5,
              transition: 'opacity var(--transition-normal)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 26 }}>{skill.icon}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{skill.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{skill.desc}</div>
                  </div>
                </div>
                <div
                  className={'toggle' + (enabled ? ' on' : '')}
                  onClick={() => toggleSkill(skill.id)}
                />
              </div>
              <span
                className={`badge ${enabled ? 'badge-success' : 'badge-neutral'}`}
                style={{ fontSize: 10 }}
              >
                {enabled ? '已激活' : '未启用'}
              </span>
            </div>
          )
        })}
      </div>

      {/* ── 导入区域 ───────────────────────────────── */}
      <div style={{
        marginTop: 24, padding: '20px 24px',
        background: 'var(--surface-50)', borderRadius: 'var(--radius-lg)',
        border: '2px dashed var(--border-medium)',
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: installedSkills.length > 0 ? 16 : 0,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
              📦 导入 Skill 压缩包
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              就像 QwenPaw — 把 Skill 打包成 .zip（内含 SKILL.md + tools/ + knowledge/），拖进来就能用
            </div>
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleImportSkillZip}
            disabled={installing}
            style={{ whiteSpace: 'nowrap' }}
          >
            {installing ? '⏳ 正在安装…' : <><IconPlus size={14} />选择 .zip</>}
          </button>
        </div>

        {installMsg && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 'var(--radius-md)',
            fontSize: 12, lineHeight: 1.5,
            background: installMsg.startsWith('✅') ? 'var(--green-50)' :
              installMsg.startsWith('❌') ? 'var(--red-50)' : 'var(--surface-200)',
            color: installMsg.startsWith('✅') ? 'var(--green-700)' :
              installMsg.startsWith('❌') ? 'var(--red-600)' : 'var(--text-secondary)',
          }}>
            {installMsg}
          </div>
        )}
      </div>

      {/* ── 已安装的 Skill ───────────────────────────── */}
      {installedSkills.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{
            fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)',
            marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6,
          }}>
            📦 已导入的 Skill ({installedSkills.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {installedSkills.map((skill) => {
              const expanded = expandedSkill === skill.id
              return (
                <div key={skill.id} style={{
                  padding: '12px 16px', borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-50)', border: '1px solid var(--border-light)',
                }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div
                      onClick={() => setExpandedSkill(expanded ? null : skill.id)}
                      style={{ cursor: 'pointer', flex: 1 }}
                    >
                      <span style={{ fontWeight: 700, fontSize: 13 }}>{skill.name}</span>
                      <span style={{
                        fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 8,
                        background: 'var(--surface-200)', padding: '1px 6px', borderRadius: 3,
                      }}>
                        v{skill.version}
                      </span>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                        {skill.description}
                      </div>
                    </div>
                    <button
                      onClick={() => handleUninstall(skill.id)}
                      style={{
                        fontSize: 10, padding: '3px 8px', border: '1px solid var(--border-medium)',
                        borderRadius: 4, color: 'var(--red-500)', cursor: 'pointer',
                        background: 'transparent',
                      }}
                    >
                      卸载
                    </button>
                  </div>

                  {/* 展开详情 */}
                  {expanded && (
                    <div style={{
                      marginTop: 10, padding: 10, background: 'var(--surface-100)',
                      borderRadius: 'var(--radius-sm)', fontSize: 11,
                    }}>
                      <div style={{ marginBottom: 6 }}>
                        <strong>📅 安装时间：</strong>
                        {new Date(skill.installedAt).toLocaleString('zh-CN')}
                      </div>
                      {skill.tools.length > 0 && (
                        <div style={{ marginBottom: 4 }}>
                          <strong>🔧 工具 ({skill.tools.length})：</strong>
                          <div style={{ color: 'var(--text-tertiary)', marginTop: 2 }}>
                            {skill.tools.map((t) => (
                              <span key={t} style={{
                                display: 'inline-block', marginRight: 6, marginBottom: 2,
                                padding: '1px 6px', borderRadius: 3,
                                background: 'var(--surface-200)', fontSize: 10,
                              }}>
                                {t}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {skill.knowledge.length > 0 && (
                        <div>
                          <strong>📚 知识 ({skill.knowledge.length})：</strong>
                          <div style={{ color: 'var(--text-tertiary)', marginTop: 2 }}>
                            {skill.knowledge.map((k) => (
                              <div key={k} style={{ fontSize: 10 }}>📄 {k}</div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )

  if (embedded) {return renderContent()}
  return <div className="panel">{renderContent()}</div>
}
