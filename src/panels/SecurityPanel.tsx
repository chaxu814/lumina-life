// ============================================================
// SecurityPanel.tsx — 🛡️ 安全中心 (v3.0)
//
// v3.0 新增:
//   - 🧱 沙箱 "虚拟围栏" 管理
//   - Agent 沙箱目录展示
//   - 用户授权目录列表（增/删）
//   - 沙箱状态总览
// ============================================================

import React, { useState, useEffect, useCallback } from 'react'
import { useStore } from '../stores/appStore'

interface AuthorizedDir {
  id: string
  path: string
  label: string
  authorizedAt: number
  tools: string[]
  agentIds: string[]
}

interface SandboxConfig {
  defaultRoot: string
  agents: Record<string, { sandboxDir: string; enabled: boolean }>
  authorizedDirs: AuthorizedDir[]
}

const KNOWN_AGENTS = [
  { id: 'lumina', label: 'Lumina 👑', color: '#6366f1' },
  { id: 'yak', label: 'Yak 🔧', color: '#f59e0b' },
  { id: 'recha', label: '热茶 🍵', color: '#10b981' },
]

export default function SecurityPanel({ embedded }: { embedded?: boolean } = {}) {
  const securityConfig = useStore((s) => s.securityConfig)
  const setSecurityConfig = useStore((s) => s.setSecurityConfig)
  const auditLogs = useStore((s) => s.auditLogs)

  const sandboxMode = securityConfig.sandboxMode ?? true

  const [sandboxConfig, setSandboxConfig] = useState<SandboxConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAddDir, setShowAddDir] = useState(false)
  const [newDirPath, setNewDirPath] = useState('')
  const [newDirLabel, setNewDirLabel] = useState('')

  // ── 加载沙箱配置 ──────────────────────────────────
  useEffect(() => {
    loadSandboxConfig()
  }, [])

  const loadSandboxConfig = async () => {
    setLoading(true)
    try {
      const api = (window as any).luminaAPI
      if (api?.sandboxGetConfig) {
        const config = await api.sandboxGetConfig()
        setSandboxConfig(config)
      }
    } catch (err) {
      console.warn('[Security] 加载沙箱配置失败:', err)
    }
    setLoading(false)
  }

  // ── 切换沙箱模式 ──────────────────────────────────
  const toggleSandbox = useCallback(async () => {
    const newValue = !sandboxMode
    setSecurityConfig({ sandboxMode: newValue })
    try {
      await (window as any).luminaAPI?.approvalUpdateConfig({
        executionLevel: newValue ? 'smart' : 'auto',
      })
    } catch (err) {
      console.warn('[Security] 同步后端失败:', err)
    }
  }, [sandboxMode, setSecurityConfig])

  // ── 添加授权目录 ──────────────────────────────────
  const handleAddDir = useCallback(async () => {
    if (!newDirPath.trim()) return
    try {
      const api = (window as any).luminaAPI
      if (api?.sandboxAddAuthorizedDir) {
        await api.sandboxAddAuthorizedDir({
          path: newDirPath.trim(),
          label: newDirLabel.trim() || undefined,
        })
        await loadSandboxConfig()
        setShowAddDir(false)
        setNewDirPath('')
        setNewDirLabel('')
      }
    } catch (err) {
      console.warn('[Security] 添加授权目录失败:', err)
    }
  }, [newDirPath, newDirLabel])

  // ── 移除授权目录 ──────────────────────────────────
  const handleRemoveDir = useCallback(async (dirId: string) => {
    try {
      const api = (window as any).luminaAPI
      if (api?.sandboxRemoveAuthorizedDir) {
        await api.sandboxRemoveAuthorizedDir(dirId)
        await loadSandboxConfig()
      }
    } catch (err) {
      console.warn('[Security] 移除授权目录失败:', err)
    }
  }, [])

  // ── 切换 Agent 沙箱 ───────────────────────────────
  const toggleAgentSandbox = useCallback(async (agentId: string, enabled: boolean) => {
    try {
      const api = (window as any).luminaAPI
      if (api?.sandboxUpdateAgent) {
        await api.sandboxUpdateAgent(agentId, { enabled })
        await loadSandboxConfig()
      }
    } catch (err) {
      console.warn('[Security] 更新 Agent 沙箱状态失败:', err)
    }
  }, [])

  const renderContent = () => (
    <div>
      {!embedded && (
        <div className="panel-header">
          <div className="panel-title">🛡️ 安全中心</div>
          <div className="panel-subtitle">沙箱模式 · 虚拟围栏 · 审批流 · 实时审计</div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════
          🛡️ 沙箱模式 — 一键开关
          ══════════════════════════════════════════════════ */}
      <div style={{
        padding: 20, borderRadius: 'var(--radius-lg)',
        background: sandboxMode
          ? 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)'
          : 'var(--yellow-100)',
        border: `2px solid ${sandboxMode ? '#4ade80' : '#facc15'}`,
        marginBottom: 16,
        transition: 'all 0.3s ease',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* 图标 */}
          <div style={{
            width: 48, height: 48, borderRadius: '50%',
            background: sandboxMode
              ? 'linear-gradient(135deg, #22c55e, #16a34a)'
              : 'linear-gradient(135deg, #facc15, #eab308)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, color: '#fff', flexShrink: 0,
            boxShadow: sandboxMode
              ? '0 4px 12px rgba(34,197,94,0.35)'
              : '0 4px 12px rgba(250,204,21,0.35)',
          }}>
            🛡️
          </div>

          {/* 文案 */}
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 16, fontWeight: 700,
              color: sandboxMode ? '#166534' : '#92400e',
              marginBottom: 2,
            }}>
              {sandboxMode ? '🛡️ 沙箱防护已开启' : '⚠️ 沙箱防护已关闭'}
            </div>
            <div style={{
              fontSize: 11, lineHeight: 1.4,
              color: sandboxMode ? '#15803d' : '#b45309',
            }}>
              {sandboxMode
                ? 'Lumina 执行中高风险操作前都会先问你。文件写入会检查安全区，外部路径自动重定向到沙箱。'
                : '仅拦截严重风险操作。可随时重新开启以获得更安全防护。'}
            </div>
          </div>

          {/* 开关 */}
          <div onClick={toggleSandbox} style={{
            width: 52, height: 28, borderRadius: 14,
            background: sandboxMode ? '#22c55e' : '#d1d5db',
            position: 'relative', cursor: 'pointer', flexShrink: 0,
            transition: 'background 0.2s ease',
            boxShadow: sandboxMode ? '0 2px 8px rgba(34,197,94,0.3)' : 'none',
          }}>
            <div style={{
              width: 22, height: 22, borderRadius: '50%',
              background: '#fff', position: 'absolute', top: 3,
              left: sandboxMode ? 27 : 3,
              transition: 'left 0.25s ease, transform 0.15s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
            }} />
          </div>
        </div>

        {sandboxMode && (
          <div style={{
            marginTop: 12, padding: '10px 14px',
            background: 'rgba(255,255,255,0.6)',
            borderRadius: 'var(--radius-md)',
            fontSize: 12, color: '#15803d',
            lineHeight: 1.5,
          }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 14 }}>🧱</span>
              <span>
                <strong>虚拟围栏已生效：</strong>
                文件写入超出安全区自动重定向到沙箱目录；
                读取敏感文件需审批；
                系统关键路径始终禁止写入。
              </span>
            </div>
            {sandboxConfig && (
              <div style={{ marginTop: 6, fontSize: 11, color: '#166534', fontFamily: 'monospace' }}>
                默认沙箱: {sandboxConfig.defaultRoot}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════════════
          🧱 Agent 沙箱状态
          ══════════════════════════════════════════════════ */}
      <div className="card" style={{
        border: '1px solid var(--border-light)', borderRadius: 'var(--radius-lg)',
        marginBottom: 16,
      }}>
        <div className="card-header" style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border-light)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>🧱</span>
          <span className="card-title" style={{ fontSize: 13, fontWeight: 600 }}>
            Agent 沙箱
          </span>
          {loading && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>加载中…</span>}
        </div>

        <div style={{ padding: '8px 14px' }}>
          {KNOWN_AGENTS.map((agent) => {
            const agentCfg = sandboxConfig?.agents?.[agent.id]
            const enabled = agentCfg?.enabled ?? (agent.id !== 'lumina')
            const sandboxDir = agentCfg?.sandboxDir || `${sandboxConfig?.defaultRoot || '…'}/${agent.id}`

            return (
              <div key={agent.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 0',
                borderBottom: '1px solid var(--border-light)',
              }}>
                {/* Agent 图标 */}
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: agent.color + '20',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 14, flexShrink: 0,
                }}>
                  {agent.label.split(' ')[1] || '🤖'}
                </div>

                {/* 信息 */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{agent.label}</div>
                  <div style={{
                    fontSize: 10, color: 'var(--text-tertiary)',
                    fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {sandboxDir}
                  </div>
                </div>

                {/* 开关 */}
                <div
                  onClick={() => toggleAgentSandbox(agent.id, !enabled)}
                  style={{
                    width: 36, height: 20, borderRadius: 10,
                    background: enabled ? '#22c55e' : '#d1d5db',
                    position: 'relative', cursor: 'pointer', flexShrink: 0,
                    transition: 'background 0.2s',
                    opacity: agent.id === 'lumina' ? 0.5 : 1,
                  }}
                  title={agent.id === 'lumina' ? 'Lumina 作为主控，沙箱始终启用' : `${enabled ? '关闭' : '开启'} ${agent.label} 沙箱`}
                >
                  <div style={{
                    width: 16, height: 16, borderRadius: '50%',
                    background: '#fff', position: 'absolute', top: 2,
                    left: enabled ? 18 : 2,
                    transition: 'left 0.2s',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.12)',
                  }} />
                </div>
              </div>
            )
          })}

          {!sandboxConfig && !loading && (
            <div style={{ padding: '12px 0', textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)' }}>
              沙箱后端未连接
            </div>
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════
          📂 授权目录管理
          ══════════════════════════════════════════════════ */}
      <div className="card" style={{
        border: '1px solid var(--border-light)', borderRadius: 'var(--radius-lg)',
        marginBottom: 16,
      }}>
        <div className="card-header" style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border-light)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>📂</span>
          <span className="card-title" style={{ fontSize: 13, fontWeight: 600 }}>
            授权目录
          </span>
          <span className="badge badge-info" style={{ marginLeft: 'auto', fontSize: 10 }}>
            {sandboxConfig?.authorizedDirs?.length || 0} 个目录
          </span>
          <button
            onClick={() => setShowAddDir(!showAddDir)}
            style={{
              background: 'var(--accent-500)', color: '#fff', border: 'none',
              borderRadius: 'var(--radius-sm)', padding: '4px 10px',
              fontSize: 11, cursor: 'pointer', fontWeight: 600,
            }}
          >
            + 添加
          </button>
        </div>

        {/* 添加表单 */}
        {showAddDir && (
          <div style={{
            padding: '10px 14px',
            background: 'var(--surface-50)',
            borderBottom: '1px solid var(--border-light)',
          }}>
            <div style={{ marginBottom: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
              授权 Agent 可以访问的目录（路径不存在会自动创建）
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={newDirLabel}
                onChange={(e) => setNewDirLabel(e.target.value)}
                placeholder="名称（如：我的项目）"
                style={{
                  flex: 1, padding: '6px 8px', fontSize: 12,
                  border: '1px solid var(--border-light)', borderRadius: 'var(--radius-sm)',
                  background: '#fff',
                }}
              />
              <input
                value={newDirPath}
                onChange={(e) => setNewDirPath(e.target.value)}
                placeholder="C:\Users\xxx\project"
                style={{
                  flex: 2, padding: '6px 8px', fontSize: 12,
                  border: '1px solid var(--border-light)', borderRadius: 'var(--radius-sm)',
                  background: '#fff', fontFamily: 'monospace',
                }}
              />
              <button
                onClick={handleAddDir}
                disabled={!newDirPath.trim()}
                style={{
                  background: newDirPath.trim() ? 'var(--accent-500)' : '#d1d5db',
                  color: '#fff', border: 'none',
                  borderRadius: 'var(--radius-sm)', padding: '6px 14px',
                  fontSize: 11, cursor: newDirPath.trim() ? 'pointer' : 'default',
                  fontWeight: 600,
                }}
              >
                授权
              </button>
            </div>
          </div>
        )}

        {/* 列表 */}
        <div>
          {(!sandboxConfig?.authorizedDirs || sandboxConfig.authorizedDirs.length === 0) ? (
            <div style={{
              padding: '20px 14px', textAlign: 'center',
              color: 'var(--text-tertiary)', fontSize: 12,
              lineHeight: 1.6,
            }}>
              暂无授权目录<br />
              <span style={{ fontSize: 11 }}>
                Agent 默认只能写入沙箱目录。添加授权目录可以允许 Agent 直接操作你指定的文件夹。
              </span>
            </div>
          ) : (
            sandboxConfig.authorizedDirs.map((dir) => (
              <div key={dir.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 14px',
                borderBottom: '1px solid var(--border-light)',
              }}>
                <span style={{ fontSize: 16 }}>📁</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{dir.label}</div>
                  <div style={{
                    fontSize: 10, color: 'var(--text-tertiary)',
                    fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {dir.path}
                  </div>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                  {new Date(dir.authorizedAt).toLocaleDateString('zh-CN')}
                </div>
                <button
                  onClick={() => handleRemoveDir(dir.id)}
                  style={{
                    background: 'transparent', border: 'none',
                    color: '#ef4444', cursor: 'pointer',
                    fontSize: 14, padding: '2px 6px', borderRadius: 'var(--radius-sm)',
                  }}
                  title="移除授权"
                >
                  🗑️
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════
          实时审计日志
          ══════════════════════════════════════════════════ */}
      <div className="card" style={{ border: '1px solid var(--border-light)', borderRadius: 'var(--radius-lg)' }}>
        <div className="card-header" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-light)' }}>
          <span style={{ fontSize: 16 }}>📝</span>
          <span className="card-title" style={{ fontSize: 13, fontWeight: 600 }}>审计日志</span>
          <span className="badge badge-info" style={{ marginLeft: 'auto', fontSize: 10 }}>
            {auditLogs.length} 条记录
          </span>
        </div>
        <div style={{ maxHeight: 200, overflowY: 'auto' }}>
          {auditLogs.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
              暂无审计记录 — 操作将实时显示
            </div>
          ) : (
            auditLogs.map((log) => (
              <div key={log.id} style={{
                display: 'flex', gap: 12, padding: '6px 12px', fontSize: 11,
                borderBottom: '1px solid var(--border-light)',
                alignItems: 'flex-start',
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%', marginTop: 4, flexShrink: 0,
                  background: log.type === 'llm' ? 'var(--accent-500)' :
                    log.type === 'tts' ? '#7c3aed' :
                    log.type === 'skill' ? 'var(--green-500)' :
                    log.type === 'security' ? 'var(--red-500)' : 'var(--text-disabled)',
                }} />
                <span style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 10, minWidth: 36 }}>
                  {log.time}
                </span>
                <span style={{ flex: 1, color: 'var(--text-primary)' }}>{log.action}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════
          底部 — 安全说明
          ══════════════════════════════════════════════════ */}
      <div style={{
        marginTop: 16, padding: '12px 16px',
        background: 'var(--surface-50)', borderRadius: 'var(--radius-md)',
        fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--text-secondary)' }}>
          🔒 安全体系说明
        </div>
        <div>三层防护：<strong>🧱 虚拟围栏</strong>（路径安全检查 + 重定向）→ <strong>🛡️ 安全守卫</strong>（威胁模式匹配）→ <strong>✅ 审批流</strong>（用户确认）</div>
        <div style={{ marginTop: 4 }}>
          <strong>🧱 虚拟围栏（第二层）</strong>：文件写入超出安全区 → 自动重定向到沙箱目录；
          读取敏感文件 → 需用户审批；
          系统关键路径 → 始终拒绝。
        </div>
        <div style={{ marginTop: 4 }}>
          <strong>📂 授权目录</strong>：添加信任目录后，Agent 可以直接读写该目录下的文件，无需重定向。适合你的项目文件夹。
        </div>
      </div>
    </div>
  )

  if (embedded) return renderContent()
  return <div className="panel">{renderContent()}</div>
}
