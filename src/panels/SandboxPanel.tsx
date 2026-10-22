// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// SandboxPanel.tsx — 🔍 沙箱透明可视化（I5）
//
// 「透明玻璃房」：实时展示每一条 shell 命令经过 7×8 规则库后的
// 级别 / 命中类别 / 处置（放行·降级·拦截·批准）。
//
// 数据来源：window.luminaAPI.sandboxGetAuditLog()
//   —— 由 electron/ipc/sandboxAuditIpc.ts 注册（集成阶段接入 preload）。
//   若该方法尚未暴露（preload 未接线），面板优雅降级为「待接入」提示，不报错。
// ============================================================

import React, { useEffect, useState, useCallback } from 'react'

interface AuditHit {
  id: string
  category: string
  description: string
}

interface AuditEntry {
  id: number
  at: string
  command: string
  severity: number
  severityLabel: string
  hits: AuditHit[]
  disposition: 'passed' | 'degraded' | 'blocked' | 'approved'
  source: string
}

interface AuditStats {
  day: string
  intercepted: number
  degraded: number
  approved: number
  total: number
  buffered: number
}

interface RulesInfo {
  total: number
  bySeverity: Record<number, number>
  byCategory: Record<string, number>
}

interface AuditPayload {
  log: AuditEntry[]
  stats: AuditStats
  rules: RulesInfo
}

const SEV_COLORS: Record<number, string> = {
  0: '#22c55e', 1: '#64748b', 2: '#84cc16', 3: '#f59e0b',
  4: '#f97316', 5: '#ef4444', 6: '#991b1b',
}

const CAT_LABELS: Record<string, string> = {
  COMMAND_INJECTION: '命令注入',
  PATH_TRAVERSAL: '路径穿越',
  DATA_EXFIL: '数据外泄',
  SENSITIVE_FILE: '敏感文件',
  CREDIT_LEAK: '凭证泄露',
  PROMPT_INJECTION: '提示注入',
  CODE_EXECUTION: '代码执行',
  PRIVILEGE_ESCALATION: '提权破坏',
}

const DISPOSITION_META: Record<string, { label: string; color: string }> = {
  passed: { label: '放行', color: '#22c55e' },
  degraded: { label: 'Low IL 降级', color: '#f59e0b' },
  blocked: { label: '拦截', color: '#ef4444' },
  approved: { label: '人工批准', color: '#3b82f6' },
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString('zh-CN', { hour12: false })
  } catch {return iso.slice(11, 19)}
}

export default function SandboxPanel() {
  const [data, setData] = useState<AuditPayload | null>(null)
  const [available, setAvailable] = useState<boolean>(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const api = (window as any).luminaAPI
      if (!api?.sandboxGetAuditLog) {
        setAvailable(false)
        return
      }
      setRefreshing(true)
      const payload: AuditPayload = await api.sandboxGetAuditLog()
      setData(payload)
      setAvailable(true)
    } catch (err) {
      console.warn('[SandboxPanel] 拉取审计失败:', err)
      setAvailable(false)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [load])

  const stats = data?.stats
  const rules = data?.rules

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">🔍 沙箱玻璃房</div>
        <div className="panel-subtitle">
          7 级严重度 × 8 类威胁 · 实时透明审计
          {rules ? ` · 规则库 ${rules.total} 条` : ''}
          <button
            onClick={load}
            style={{
              marginLeft: 10, fontSize: 11, padding: '2px 10px',
              border: '1px solid var(--border-light)', borderRadius: 6,
              background: 'var(--surface-50)', cursor: 'pointer',
            }}
          >
            {refreshing ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      {!available && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12, lineHeight: 1.7 }}>
          沙箱审计后端尚未接入 preload。<br />
          集成阶段在 preload 暴露 <code>sandboxGetAuditLog</code> 后，这里会实时显示每次命令的级别与处置。
        </div>
      )}

      {available && (
        <>
          {/* 三个统计卡片 */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            {[
              { label: '今日拦截', value: stats?.intercepted ?? 0, color: '#ef4444' },
              { label: '今日降级', value: stats?.degraded ?? 0, color: '#f59e0b' },
              { label: '今日人工批准', value: stats?.approved ?? 0, color: '#3b82f6' },
            ].map(c => (
              <div key={c.label} style={{
                flex: 1, padding: '12px 14px', borderRadius: 'var(--radius-lg)',
                background: '#fff', border: '1px solid var(--border-light)',
              }}>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{c.label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: c.color }}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* 审计表格 */}
          <div className="card" style={{ border: '1px solid var(--border-light)', borderRadius: 'var(--radius-lg)' }}>
            <div className="card-header" style={{
              padding: '10px 14px', borderBottom: '1px solid var(--border-light)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span>📝</span>
              <span className="card-title" style={{ fontSize: 13, fontWeight: 600 }}>
                实时审计（最近 {data?.log.length ?? 0} 条）
              </span>
            </div>
            <div style={{ maxHeight: 420, overflowY: 'auto' }}>
              {(!data || data.log.length === 0) ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                  暂无记录 — 让 Lumina 跑一条 shell 命令，这里会实时显示它经过的安全检查
                </div>
              ) : (
                data.log.map(entry => {
                  const sevColor = SEV_COLORS[entry.severity] || '#64748b'
                  const disp = DISPOSITION_META[entry.disposition] || DISPOSITION_META.passed
                  return (
                    <div key={entry.id} style={{
                      padding: '8px 12px', borderBottom: '1px solid var(--border-light)',
                      borderLeft: `3px solid ${sevColor}`,
                    }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11 }}>
                        <span style={{ color: 'var(--text-tertiary)' }}>
                          {fmtTime(entry.at)}
                        </span>
                        <span style={{
                          background: sevColor, color: '#fff', borderRadius: 4,
                          padding: '1px 6px', fontWeight: 600,
                        }}>
                          {entry.severityLabel}
                        </span>
                        <span style={{
                          background: disp.color + '20', color: disp.color,
                          borderRadius: 4, padding: '1px 6px',
                        }}>
                          {disp.label}
                        </span>
                        <span style={{
                          marginLeft: 'auto', fontSize: 10, color: 'var(--text-tertiary)',
                        }}>
                          {entry.source}
                        </span>
                      </div>
                      <div style={{
                        marginTop: 4, fontSize: 12, fontFamily: 'var(--font-mono)',
                        color: 'var(--text-primary)', wordBreak: 'break-all',
                      }}>
                        {entry.command}
                      </div>
                      {entry.hits.length > 0 && (
                        <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {entry.hits.map(h => (
                            <span key={h.id} style={{
                              fontSize: 10, background: 'var(--surface-50)',
                              border: '1px solid var(--border-light)', borderRadius: 4,
                              padding: '1px 6px', color: 'var(--text-secondary)',
                            }} title={h.description}>
                              {h.id} · {CAT_LABELS[h.category] || h.category}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>

          <div style={{
            marginTop: 12, padding: '10px 14px', fontSize: 11,
            color: 'var(--text-tertiary)', lineHeight: 1.6,
            background: 'var(--surface-50)', borderRadius: 'var(--radius-md)',
          }}>
            💡 透明玻璃房：每条命令在执行前都会过一遍规则库。
            <strong>高风险</strong>自动降到 Low IL 进程跑（写不进你的桌面/文档）；
            <strong>严重/阻断</strong>直接拦下；普通命令正常执行。所有动作都留痕在这里。
          </div>
        </>
      )}
    </div>
  )
}
