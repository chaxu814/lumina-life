// ============================================================
// AgentTaskBoard.tsx — Agent Autonomous Task Board (v2.10.1)
// Extracted from ChatPanel.tsx
// v2.11: Refactored — fixed TS type assertions, encoding, code style
// ============================================================

import React, { useState, useMemo } from 'react'
import { useStore } from '../stores/appStore'
import { useLLMPanels, AGENTS, type AgentTask } from '../chat/chatShared'
import { useLoopStore } from '../stores/loopStore'
import { cronMatches } from '../services/loopPersist'

export default function AgentTaskBoard() {
  const llmState = useLLMPanels()
  const cronTasks = useStore(s => s.cronTasks)
  const auditLogs = useStore(s => s.auditLogs)
  const conversations = useStore(s => s.conversations)
  const tokenUsage = useStore(s => s.tokenUsage)
  const toolTraces = useStore(s => s.toolTraces)
  const [filter, setFilter] = useState<'all' | 'lumina' | 'recha' | 'yak' | 'loop'>('all')

  const realTasks = useMemo<AgentTask[]>(() => {
    const now = Date.now()
    const safeTime = (ts: unknown): number => {
      if (typeof ts === 'number' && !isNaN(ts) && ts > 0) {
        if (ts < 1e11) {return ts * 1000}  // 秒级时间戳
        return ts
      }
      if (ts instanceof Date) { const t = ts.getTime(); if (!isNaN(t) && t > 0) {return t} }
      if (typeof ts === 'string') { const t = new Date(ts).getTime(); if (!isNaN(t) && t > 0) {return t} }
      return now
    }
    const fmtTime = (ts: number) => {
      const t = safeTime(ts)
      return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }
    const fmtDate = (ts: number) => {
      const t = safeTime(ts)
      const d = new Date(t)
      return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(t)}`
    }
    const result: AgentTask[] = []

    // ── Cron tasks → Yak tasks ───────────────────────────
    for (const ct of (cronTasks || []).slice(0, 4)) {
      const enabled = (ct as unknown as Record<string, unknown>).enabled !== false
      const name = (ct as unknown as Record<string, unknown>).name as string || ct.id
      const schedule = (ct as unknown as Record<string, unknown>).schedule || 'unknown'
      const action = (ct as unknown as Record<string, unknown>).action || ''
      const createdAt = (ct as unknown as Record<string, unknown>).createdAt as number
      const lastRun = (ct as unknown as Record<string, unknown>).lastRun as number | undefined

      result.push({
        id: `cron_${ct.id}`,
        agentId: 'yak',
        icon: '\u23F0',
        title: name,
        desc: `Schedule: ${schedule} | ${String(action).slice(0, 40)}`,
        status: enabled ? 'doing' : 'planning',
        progress: enabled ? 60 : 0,
        startTime: fmtDate(safeTime(createdAt)),
        endTime: lastRun != null ? fmtDate(lastRun) : undefined,
        funnyComment: enabled ? 'Scheduled task running...' : 'Paused',
      })
    }

    // ── Recent audit logs → per-agent task summaries ─────
    const recentLogs = (auditLogs || []).slice(-5).reverse()
    const agentLogMap: Record<string, number> = { lumina: 0, recha: 0, yak: 0 }
    for (const log of recentLogs) {
      const agentId =
        (log as unknown as Record<string, unknown>).agentId as string || 'recha'
      agentLogMap[agentId] = (agentLogMap[agentId] || 0) + 1
    }
    if (agentLogMap.lumina > 0) {
      result.push({
        id: 'al_lumina', agentId: 'lumina', icon: '\uD83D\uDCDD',
        title: 'Recent interactions',
        desc: `Participated in ${agentLogMap.lumina} activities`,
        status: 'done', progress: 100,
        startTime: fmtTime(now - 3600000), endTime: fmtTime(now),
        funnyComment: 'Lumina is always here for owner~ \u2728',
      })
    }
    if (agentLogMap.recha > 0) {
      result.push({
        id: 'al_recha', agentId: 'recha', icon: '\uD83D\uDD27',
        title: 'Background maintenance',
        desc: `Completed ${agentLogMap.recha} technical operations`,
        status: 'done', progress: 100,
        startTime: fmtTime(now - 7200000), endTime: fmtTime(now),
        funnyComment: "Code won't fix itself. But Recha will.",
      })
    }
    if (agentLogMap.yak > 0) {
      result.push({
        id: 'al_yak', agentId: 'yak', icon: '\uD83D\uDCCA',
        title: 'Data analytics',
        desc: `Processed ${agentLogMap.yak} data operations`,
        status: 'done', progress: 100,
        startTime: fmtTime(now - 7200000), endTime: fmtTime(now),
        funnyComment: 'All metrics nominal.',
      })
    }

    // ── Recent tool traces → tech tasks ──────────────────
    const recentTraces = (toolTraces || []).slice(-3).reverse()
    for (const trace of recentTraces) {
      const toolName =
        (trace as unknown as Record<string, unknown>).name as string || 'tool'
      const success =
        (trace as unknown as Record<string, unknown>).status === 'success'
      const ts =
        (trace as unknown as Record<string, unknown>).timestamp as number
      result.push({
        id: `tt_${(trace as any).id || Math.random()}`,
        agentId: 'recha',
        icon: success ? '\u2705' : '\u26A0\uFE0F',
        title: toolName,
        desc: success ? 'Completed successfully' : 'Needs attention',
        status: success ? 'done' : 'doing',
        progress: success ? 100 : 45,
        startTime: fmtTime(safeTime(ts) || now - 600000),
        endTime: success ? fmtTime(safeTime(ts) ? safeTime(ts) + 1000 : now) : undefined,
        funnyComment: success ? 'Ship it.' : 'Debugging in progress...',
      })
    }

    // ── Token usage stats → metric task ──────────────────
    const tokenData = tokenUsage as unknown as Record<string, number> | undefined
    if (tokenData?.today && tokenData.today > 0) {
      result.push({
        id: 'tu_tokens', agentId: 'yak', icon: '\uD83D\uDCC8',
        title: 'Token usage tracking',
        desc:
          `Today: ${tokenData.today.toLocaleString()} | ` +
          `Total: ${(tokenData.total || 0).toLocaleString()}`,
        status: 'doing', progress: Math.min(
          Math.round(((tokenData.today || 0) / (tokenData.limit || 100000)) * 100),
          100
        ),
        startTime: fmtTime(now - 86400000), endTime: undefined,
        funnyComment: 'Normal operating range.',
      })
    }

    return result
  }, [cronTasks, auditLogs, toolTraces, tokenUsage])

  // ── Merge LLM-generated tasks ───────────────────────────
  const llmTasks = llmState?.tasks || []
  const allTasks = useMemo(() => {
    const combined = [...realTasks]
    for (const t of llmTasks) {
      if (!combined.find(x => x.id === t.id)) {combined.push(t)}
    }
    return combined
  }, [realTasks, llmTasks])

  const filteredTasks = useMemo(
    () => (filter === 'all' || filter === 'loop' ? allTasks : allTasks.filter(t => t.agentId === filter)),
    [allTasks, filter]
  )

  // ── Loop 相关 ──────────────────────────────────────
  const loopTasks = useLoopStore(s => s.tasks)
  const loopEngine = useLoopStore(s => s.engine)
  const isLoopFilter = filter === 'loop'

  /** 计算下次执行的可读文本 */
  const nextRunText = (loop: typeof loopTasks[0]): string => {
    const status = loop.status
    if (status === 'paused') {return '⏸ 已暂停'}
    if (status === 'done') {return '⏹ 已停止'}
    if (status === 'configuring' || status === 'reviewing') {return '⏳ 待确认'}
    // running — 找第一个 enabled 触发器估算
    const trg = loop.triggers.find(t => t.enabled)
    if (!trg) {return '—'}
    if (trg.type === 'message') {return '💬 由消息触发'}
    if (trg.type === 'api_event') {return '📡 由事件触发'}
    const intervalMs = trg.type === 'interval' ? (trg.config?.intervalMs || 0) : 0
    const schedule = trg.type === 'cron' ? String(trg.config?.schedule || '') : ''
    const lastRun = loop.lastRunAt || loop.createdAt
    if (intervalMs > 0 && lastRun) {
      const next = new Date(lastRun + intervalMs)
      const diffMs = next.getTime() - Date.now()
      if (diffMs <= 0) {return '🟢 立即可触发'}
      const mins = Math.round(diffMs / 60000)
      if (mins < 60) {return `${mins}分钟后`}
      return `${(mins / 60).toFixed(1)}小时后`
    }
    if (schedule) {
      // 扫描未来 48 小时找下次命中
      const now = new Date()
      for (let i = 1; i <= 48 * 60; i++) {
        const t = new Date(now.getTime() + i * 60000)
        if (cronMatches(schedule, t)) {
          const diffMs = t.getTime() - Date.now()
          const mins = Math.round(diffMs / 60000)
          if (mins < 60) {return `${mins}分钟后`}
          return `${(mins / 60).toFixed(1)}小时后`
        }
      }
      return `⏰ cron: ${schedule}`
    }
    return '—'
  }

  const fmtLoopTime = (ts?: number) => {
    if (!ts) {return '—'}
    return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  // ═══════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════

  const filterTabs: Array<{ key: typeof filter; label: string; icon: string }> = [
    { key: 'all', label: 'All', icon: '\uD83D\uDCCB' },
    { key: 'lumina', label: 'Lumina', icon: '\uD83D\uDC31' },
    { key: 'recha', label: 'Recha', icon: '\uD83C\uDF75' },
    { key: 'yak', label: 'Yak', icon: '\uD83D\uDCCA' },
    { key: 'loop', label: 'Loop', icon: '\uD83D\uDD01' },
  ]

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
      {/* Filter tabs */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: 8,
        position: 'sticky', top: 0, background: 'var(--surface-0)', zIndex: 1,
        paddingBottom: 6, borderBottom: '1px solid var(--border-light)',
      }}>
        {filterTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            style={{
              padding: '4px 10px', borderRadius: 6, border: '1px solid',
              borderColor: filter === tab.key ? '#6366f1' : '#e5e7eb',
              background: filter === tab.key ? '#eef2ff' : '#fff',
              color: filter === tab.key ? '#4f46e5' : '#6b7280',
              fontSize: 11, fontWeight: filter === tab.key ? 600 : 400,
              cursor: 'pointer', transition: 'all 0.15s',
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {filteredTasks.length === 0 && !isLoopFilter && (
        <div style={{
          textAlign: 'center', color: '#d1d5db', fontSize: 12, padding: '32px 0',
        }}>
          No tasks yet. Enable autonomous mode or interact with the team.
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════
          Loop 视图（自驱任务看板）
          ═══════════════════════════════════════════════════════ */}
      {isLoopFilter && (
        <>
          {loopTasks.length === 0 && (
            <div style={{
              textAlign: 'center', color: '#d1d5db', fontSize: 12, padding: '32px 0',
            }}>
              暂无 Loop 任务。在聊天中说「帮我每天做…」自动创建，或在角色面板配置预设。
            </div>
          )}

          {loopTasks.map(loop => {
            const total = loop.subtasks.length
            const done = loop.progress.completed.length
            const pct = total > 0 ? Math.round((done / total) * 100) : 0
            const statusColor =
              loop.status === 'running' ? '#10b981' :
              loop.status === 'paused' ? '#f59e0b' :
              loop.status === 'reviewing' ? '#3b82f6' :
              loop.status === 'done' ? '#9ca3af' : '#a78bfa'
            const statusLabel =
              loop.status === 'running' ? '🟢 运行中' :
              loop.status === 'paused' ? '⏸ 暂停' :
              loop.status === 'reviewing' ? '👀 待确认' :
              loop.status === 'configuring' ? '⚙️ 拆解中' : '⏹ 已停止'
            const lastOutput = loop.outputs[loop.outputs.length - 1]
            const isRunning = loop.status === 'running'

            return (
              <div key={loop.id} style={{
                background: 'var(--surface-0)', borderRadius: 8, padding: '10px 12px',
                border: '1px solid var(--border-light)', marginBottom: 8,
                boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
              }}>
                {/* 头部：标题 + 状态 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 20 }}>🔁</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {loop.goal}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 1 }}>
                      {statusLabel} · 已运行 {loop.runCount} 轮 · 创建于 {fmtLoopTime(loop.createdAt)}
                    </div>
                  </div>
                </div>

                {/* 进度条 */}
                <div style={{
                  height: 4, borderRadius: 2, background: 'var(--border-light)',
                  marginBottom: 6, overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', borderRadius: 2,
                    background: statusColor,
                    width: `${pct}%`,
                    transition: 'width 0.5s ease',
                  }} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  子任务 {done}/{total} · 下次：{nextRunText(loop)}
                </div>

                {/* 最近一轮产出（折叠预览） */}
                {lastOutput && (
                  <div style={{
                    background: 'var(--surface-50)', borderRadius: 6, padding: '6px 8px',
                    fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6,
                    maxHeight: 60, overflow: 'hidden', lineHeight: 1.5,
                    whiteSpace: 'pre-line',
                  }}>
                    📋 最新产出（{fmtLoopTime(lastOutput.time)}）：
                    {'\n'}{lastOutput.content.slice(0, 150)}{lastOutput.content.length > 150 ? '…' : ''}
                  </div>
                )}

                {/* 操作按钮 */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {loop.status === 'reviewing' && (
                    <button onClick={() => { void loopEngine.confirmLoop(loop.id) }}
                      style={{
                        padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                        background: '#10b981', color: '#fff', border: 'none', cursor: 'pointer',
                      }}>✅ 确认启动</button>
                  )}
                  {isRunning && (
                    <button onClick={() => { void loopEngine.pauseLoop(loop.id) }}
                      style={{
                        padding: '3px 10px', borderRadius: 6, fontSize: 11,
                        background: 'var(--surface-50)', border: '1px solid var(--border-light)', cursor: 'pointer',
                      }}>⏸ 暂停</button>
                  )}
                  {loop.status === 'paused' && (
                    <button onClick={() => { void loopEngine.resumeLoop(loop.id) }}
                      style={{
                        padding: '3px 10px', borderRadius: 6, fontSize: 11,
                        background: '#eef2ff', color: '#4f46e5', border: '1px solid #c7d2fe', cursor: 'pointer',
                      }}>▶️ 继续</button>
                  )}
                  {isRunning && (
                    <button onClick={() => { void loopEngine.runCycle(loop.id) }}
                      style={{
                        padding: '3px 10px', borderRadius: 6, fontSize: 11,
                        background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d', cursor: 'pointer',
                      }}>⚡ 立即执行</button>
                  )}
                  {isRunning && (
                    <button onClick={() => { void loopEngine.stopLoop(loop.id) }}
                      style={{
                        padding: '3px 10px', borderRadius: 6, fontSize: 11,
                        background: 'var(--surface-50)', border: '1px solid var(--border-light)', cursor: 'pointer',
                      }}>⏹ 停止</button>
                  )}
                  <button onClick={() => { void loopEngine.removeLoop(loop.id) }}
                    style={{
                      padding: '3px 10px', borderRadius: 6, fontSize: 11,
                      background: 'var(--surface-50)', border: '1px solid var(--border-light)',
                      cursor: 'pointer', marginLeft: 'auto', color: '#dc2626',
                    }}>🗑 删除</button>
                </div>
              </div>
            )
          })}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════
          原有 Agent 视图（Lumina / Recha / Yak 任务）
          ═══════════════════════════════════════════════════════ */}
      {!isLoopFilter && filteredTasks.map(task => {
        const agent = AGENTS.find(a => a.id === task.agentId)
        const statusColor =
          task.status === 'done' ? '#10b981' :
          task.status === 'doing' ? '#3b82f6' :
          task.status === 'planning' ? '#f59e0b' : '#9ca3af'
        const statusLabel =
          task.status === 'done' ? 'Done' :
          task.status === 'doing' ? 'In Progress' :
          task.status === 'planning' ? 'Planned' : task.status

        return (
          <div key={task.id} style={{
            background: 'var(--surface-0)', borderRadius: 8, padding: '8px 10px',
            border: '1px solid var(--border-light)', marginBottom: 6,
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
            transition: 'box-shadow 0.15s',
          }}>
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
            }}>
              <span style={{
                width: 32, height: 32, borderRadius: 8,
                background: agent ? `${agent.color}15` : '#f3f4f6',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16, flexShrink: 0,
              }}>
                {task.icon || agent?.icon || '\uD83E\uDD16'}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  marginBottom: 2,
                }}>
                  <span style={{
                    fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
                  }}>
                    {task.title}
                  </span>
                  <span style={{
                    fontSize: 9, padding: '1px 6px', borderRadius: 4,
                    background: `${statusColor}15`, color: statusColor,
                    fontWeight: 500,
                  }}>
                    {statusLabel}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  {task.desc}
                </div>
                {/* Progress bar */}
                <div style={{
                  height: 4, borderRadius: 2, background: 'var(--border-light)',
                  marginBottom: 4, overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', borderRadius: 2,
                    background: statusColor,
                    width: `${task.progress || 0}%`,
                    transition: 'width 0.5s ease',
                  }} />
                </div>
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: 9, color: 'var(--text-secondary)',
                }}>
                  <span>
                    {task.startTime}
                    {task.endTime ? ` \u2192 ${task.endTime}` : ''}
                  </span>
                  <span style={{
                    color: agent?.color || '#6b7280', fontStyle: 'italic',
                  }}>
                    {task.funnyComment}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
