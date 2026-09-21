// ============================================================
// TeamCollabSection.tsx — v3.30 团队协作中心
// 共享任务板泳道（含 plan_approval）· 文件信箱 · 动态临时工 ·
// Computer Use 权限策略 · Teach 录制回放 · Workflow 工作流
// ============================================================

import React, { useState, useEffect, useCallback } from 'react'
import TeamTopologyView from './TeamTopologyView'

const api = () => (window as any).luminaAPI

const KINDS = ['research', 'search', 'data', 'code', 'review', 'test', 'other']
const KIND_CN: Record<string, string> = {
  research: '🔎 调研', search: '🌐 检索', data: '📊 数据',
  code: '🔧 工程', review: '🧐 复核', test: '🧪 测试', other: '📌 其他',
}
const STATUSES: Array<{ key: string; label: string; color: string }> = [
  { key: 'pending_approval', label: '待批准', color: '#d97706' },
  { key: 'pending', label: '待认领', color: '#9ca3af' },
  { key: 'claimed', label: '已认领', color: '#3b82f6' },
  { key: 'running', label: '进行中', color: '#8b5cf6' },
  { key: 'blocked', label: '阻塞', color: '#f59e0b' },
  { key: 'done', label: '完成', color: '#10b981' },
  { key: 'failed', label: '失败', color: '#ef4444' },
]
const LEVEL_CN: Record<string, string> = {
  none: '⛔ 禁止', read: '👁 只读', click: '🖱 可点', full: '⌨️ 完整',
}

export default function TeamCollabSection() {
  const [tab, setTab] = useState<'topology' | 'board' | 'mailbox' | 'cu' | 'teach' | 'workflow' | 'growth'>('topology')
  const [board, setBoard] = useState<any>(null)
  const [history, setHistory] = useState<any[]>([])
  const [mailStream, setMailStream] = useState<any[]>([])
  const [mail, setMail] = useState<any[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [workers, setWorkers] = useState<any[]>([])
  const [policy, setPolicy] = useState<any>(null)
  const [foreground, setForeground] = useState<{ proc: string; title: string } | null>(null)
  const [session, setSession] = useState<any>(null)
  const [workflows, setWorkflows] = useState<any[]>([])
  const [wfDetail, setWfDetail] = useState<any>(null)
  const [lessons, setLessons] = useState<any[]>([])
  const [recording, setRecording] = useState(false)

  // 任务表单
  const [taskTitle, setTaskTitle] = useState('')
  const [taskKind, setTaskKind] = useState('research')
  const [taskDetail, setTaskDetail] = useState('')
  const [needApproval, setNeedApproval] = useState(false)
  // 信箱表单
  const [msgTo, setMsgTo] = useState('yak')
  const [msgSubject, setMsgSubject] = useState('')
  const [msgBody, setMsgBody] = useState('')
  // 授权表单
  const [grantProc, setGrantProc] = useState('')
  const [grantLevel, setGrantLevel] = useState('full')
  // Teach 保存表单
  const [lessonName, setLessonName] = useState('')
  const [lessonDesc, setLessonDesc] = useState('')
  const [pendingEvents, setPendingEvents] = useState<any[] | null>(null)
  const [aggTyping, setAggTyping] = useState(false)
  const [replaying, setReplaying] = useState<string | null>(null)
  // v3.33 成长/运维
  const [profiles, setProfiles] = useState<any>({})
  const [trace, setTrace] = useState<any>(null)
  const [autonomy, setAutonomy] = useState<any>(null)
  const [dailyLog, setDailyLog] = useState<any>(null)
  const [checkpoints, setCheckpoints] = useState<any[]>([])

  const refresh = useCallback(async () => {
    const a = api()
    if (!a) {return}
    try {
      const [b, h, m, c, w, p, s, fg, wfs, ls, ms, prof, tr, au, cps] = await Promise.all([
        a.collabBoard?.().catch(() => null),
        a.collabBoardHistory?.().catch(() => []),
        a.collabMailboxInbox?.('lumina', false).catch(() => []),
        a.collabMailboxCounts?.().catch(() => ({})),
        a.collabWorkers?.().catch(() => []),
        a.cuPolicyGet?.().catch(() => null),
        a.cuPolicySession?.().catch(() => null),
        a.cuPolicyForeground?.().catch(() => null),
        a.collabWorkflows?.().catch(() => []),
        a.teachList?.().catch(() => []),
        a.collabMailStream?.().catch(() => []),
        a.collabStatsProfiles?.().catch(() => ({})),
        a.collabTrace?.(20).catch(() => null),
        a.collabAutonomy?.('status').catch(() => null),
        a.collabCheckpoints?.().catch(() => []),
      ])
      setBoard(b)
      setHistory(h || [])
      setMail(m || [])
      setMailStream(ms || [])
      setCounts(c || {})
      setWorkers(w || [])
      setPolicy(p)
      setSession(s)
      setForeground(fg)
      setWorkflows(wfs || [])
      setLessons(ls || [])
      setProfiles(prof || {})
      setTrace(tr)
      setAutonomy(au)
      setCheckpoints(cps || [])
      // 团队日记只在成长页打开时才现算，避免无谓写盘
      if (tab === 'growth') {
        a.collabDailyLog?.().then(setDailyLog).catch(() => null)
      }
    } catch { /* 面板查询静默失败 */ }
  }, [tab])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  const boardAction = async (action: string, payload: any) => {
    try {
      await api()?.collabBoardAction?.(action, payload)
      await refresh()
    } catch (e) {
      alert('操作失败: ' + e)
    }
  }

  const shutdownWorker = async (id: string) => {
    try {
      const r = await api()?.collabWorkerShutdown?.(id)
      if (r && !r.ok) {alert(r.message || '关停失败')}
      await refresh()
    } catch (e) {
      alert('操作失败: ' + e)
    }
  }

  const createTask = async () => {
    if (!taskTitle.trim()) {return}
    await boardAction('create', {
      title: taskTitle.trim(), kind: taskKind, detail: taskDetail, owner: 'lumina',
      requireApproval: needApproval,
    })
    setTaskTitle(''); setTaskDetail(''); setNeedApproval(false)
  }

  const sendMail = async () => {
    if (!msgSubject.trim() || !msgBody.trim()) {return}
    await api()?.collabMailboxSend?.({ from: 'lumina', to: msgTo, subject: msgSubject, body: msgBody })
    setMsgSubject(''); setMsgBody('')
    await refresh()
  }

  const togglePolicy = async (key: string) => {
    const next = await api()?.cuPolicySet?.({ [key]: !policy[key] })
    if (next) {setPolicy(next)}
  }

  const grant = async () => {
    if (!grantProc.trim()) {return}
    const next = await api()?.cuPolicyGrant?.(grantProc.trim(), grantLevel)
    if (next) {setPolicy(next)}
    setGrantProc('')
  }

  const revoke = async (proc: string) => {
    const next = await api()?.cuPolicyRevoke?.(proc)
    if (next) {setPolicy(next)}
  }

  // ── Teach ──
  const startRecord = async () => {
    const r = await api()?.teachRecordStart?.()
    if (r && !r.ok) {alert(r.message)}
    setRecording(!!r?.ok)
  }
  const stopAndSave = async () => {
    const r = await api()?.teachRecordStop?.()
    setRecording(false)
    if (!r?.ok || !r.events?.length) {alert(r?.message || '没有录到任何操作'); return}
    if (!lessonName.trim()) {
      // 事件暂存，等用户填名后保存，不用重录
      setPendingEvents(r.events)
      return
    }
    const saved = await api()?.teachSave?.({
      name: lessonName.trim(),
      description: lessonDesc.trim(),
      events: r.events,
      aggregateTyping: aggTyping,
    })
    if (saved?.id) {setLessonName(''); setLessonDesc(''); setPendingEvents(null); await refresh()}
  }
  const savePending = async () => {
    if (!pendingEvents || !lessonName.trim()) {return}
    const saved = await api()?.teachSave?.({
      name: lessonName.trim(),
      description: lessonDesc.trim(),
      events: pendingEvents,
      aggregateTyping: aggTyping,
    })
    if (saved?.id) {setLessonName(''); setLessonDesc(''); setPendingEvents(null); await refresh()}
  }
  const removeLesson = async (id: string) => {
    await api()?.teachRemove?.(id)
    await refresh()
  }
  const replayLesson = async (id: string, name: string) => {
    if (!window.confirm(`即将回放课程「${name}」：回放会真实移动鼠标/点击，请把目标窗口准备好，期间你一碰鼠标键盘就会中止。开始？`)) {return}
    setReplaying(id)
    try {
      const r = await api()?.teachReplay?.(id)
      if (r?.ok) {
        alert(`回放完成：${r.steps} 步全部执行`)
      } else {
        alert(`回放中止：${r?.stoppedReason || '未知原因'}\n${(r?.messages || []).slice(-3).join('\n')}`)
      }
    } catch (e) {
      alert('回放失败: ' + e)
    } finally {
      setReplaying(null)
    }
  }

  // ── Workflow ──
  const openWorkflow = async (id: string) => {
    const j = await api()?.collabWorkflowGet?.(id)
    setWfDetail(j)
  }

  // ── v3.33 自治/检查点 ──
  const toggleAutonomy = async () => {
    const next = autonomy?.running ? 'stop' : 'start'
    const r = await api()?.collabAutonomy?.(next)
    if (r) {setAutonomy(r)}
    await refresh()
  }
  const rollback = async (cp: any) => {
    if (!window.confirm(`危险操作：回滚到检查点 ${cp.id} 会 git reset --hard 丢弃之后的所有提交，确定继续？`)) {return}
    if (!window.confirm(`再确认一次：「${cp.ref}」之后的提交将永久丢失。真的回滚？`)) {return}
    try {
      const r = await api()?.collabCheckpointRollback?.(cp.id, true)
      alert(r?.ok ? `⏪ ${r.message}` : `回滚失败：${r?.message}`)
      await refresh()
    } catch (e) {
      alert('回滚失败: ' + e)
    }
  }

  const input: React.CSSProperties = {
    padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12,
  }
  const btn: React.CSSProperties = {
    padding: '3px 10px', borderRadius: 4, border: '1px solid #d1d5db',
    background: '#fff', cursor: 'pointer', fontSize: 11,
  }
  const primaryBtn: React.CSSProperties = {
    ...btn, border: 'none', background: '#ec4899', color: '#fff', fontWeight: 600,
  }

  return (
    <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 16, marginTop: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h4 style={{ margin: 0, fontSize: 14 }}>🤝 协作中心 <span style={{ fontSize: 10, color: '#9ca3af' }}>v3.33</span></h4>
        {workers.length > 0 && (
          <span style={{ fontSize: 10, color: '#8b5cf6', background: '#f5f3ff', padding: '2px 8px', borderRadius: 10 }}>
            {workers.length} 位临时工在岗
          </span>
        )}
      </div>

      {/* Tab 切换 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {([
          ['topology', '🕸 团队拓扑'],
          ['board', '📌 任务板'],
          ['mailbox', `📬 信箱${counts.lumina ? ` (${counts.lumina})` : ''}`],
          ['cu', '🖥️ CU 策略'],
          ['teach', '⏺ Teach'],
          ['workflow', '🧶 工作流'],
          ['growth', '📈 成长/日记'],
        ] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{
              ...btn,
              background: tab === key ? '#ec4899' : '#fff',
              color: tab === key ? '#fff' : '#374151',
              border: tab === key ? 'none' : '1px solid #d1d5db',
            }}>
            {label}
          </button>
        ))}
      </div>

      {/* ══════════ 实时拓扑 ══════════ */}
      {tab === 'topology' && (
        <TeamTopologyView board={board} workers={workers} counts={counts}
          onAction={boardAction} history={history} onShutdown={shutdownWorker}
          mailStream={mailStream} />
      )}

      {/* ══════════ 任务板 ══════════ */}
      {tab === 'board' && (
        <div>
          {/* 新建任务 */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 6, padding: 10,
            background: 'var(--surface-100)', border: '1px solid var(--border-light)',
            borderRadius: 8, marginBottom: 12, fontSize: 12,
          }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input style={{ ...input, flex: 1 }} value={taskTitle} onChange={e => setTaskTitle(e.target.value)}
                placeholder="任务标题（worker 可自主认领）" />
              <select style={input} value={taskKind} onChange={e => setTaskKind(e.target.value)}>
                {KINDS.map(k => <option key={k} value={k}>{KIND_CN[k]}</option>)}
              </select>
            </div>
            <textarea style={{ ...input, minHeight: 36, fontFamily: 'inherit' }} value={taskDetail}
              onChange={e => setTaskDetail(e.target.value)} placeholder="任务详情（可选）" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button style={primaryBtn} onClick={createTask}>＋ 挂到任务板</button>
              <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={needApproval} onChange={e => setNeedApproval(e.target.checked)} />
                需人工批准（plan_approval，先进入待批准泳道）
              </label>
            </div>
          </div>

          {/* 泳道 */}
          {STATUSES.map(st => {
            const tasks = board?.lanes?.[st.key] || []
            if (tasks.length === 0) {return null}
            return (
              <div key={st.key} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: st.color, marginBottom: 4 }}>
                  {st.label}（{tasks.length}）
                </div>
                {tasks.map((t: any) => (
                  <div key={t.id} style={{
                    padding: '6px 10px', borderRadius: 6, marginBottom: 4,
                    background: 'var(--surface-0)', border: '1px solid var(--border-light)', fontSize: 11,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600 }}>
                        {KIND_CN[t.kind] || t.kind} {t.title}
                        {t.requireApproval && t.status === 'pending_approval' && <span style={{ color: '#d97706' }}> 🔍</span>}
                      </span>
                      <span style={{ color: '#9ca3af', whiteSpace: 'nowrap' }}>
                        {t.owner ? `👤 ${t.owner}` : '未认领'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                      {t.status === 'pending_approval' && (
                        <>
                          <button style={{ ...btn, borderColor: '#6ee7b7', color: '#047857' }}
                            onClick={() => boardAction('approve', { id: t.id, owner: 'lumina' })}>批准</button>
                          <button style={btn}
                            onClick={() => boardAction('reject', { id: t.id, owner: 'lumina' })}>驳回</button>
                        </>
                      )}
                      {t.status === 'pending' && (
                        <button style={btn} onClick={() => boardAction('claim', { id: t.id, owner: 'lumina' })}>认领</button>
                      )}
                      {(t.status === 'claimed' || t.status === 'running') && t.owner === 'lumina' && (
                        <>
                          <button style={btn} onClick={() => boardAction('start', { id: t.id, owner: 'lumina' })}>开始</button>
                          <button style={btn} onClick={() => boardAction('complete', { id: t.id, owner: 'lumina' })}>完成</button>
                          <button style={btn} onClick={() => boardAction('release', { id: t.id, owner: 'lumina' })}>释放</button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
          {board && board.total === 0 && (
            <div style={{ fontSize: 11, color: '#9ca3af' }}>任务板是空的——挂上来的任务 worker 可以自主认领、并行处理。</div>
          )}
        </div>
      )}

      {/* ══════════ 信箱 ══════════ */}
      {tab === 'mailbox' && (
        <div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, fontSize: 10 }}>
            {Object.entries(counts).map(([m, n]) => (
              <span key={m} style={{
                padding: '2px 8px', borderRadius: 10,
                background: n ? '#ecfdf5' : '#f3f4f6', color: n ? '#059669' : '#9ca3af',
              }}>
                {m}: {n as number}
              </span>
            ))}
          </div>

          {/* 发信 */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 6, padding: 10,
            background: 'var(--surface-100)', border: '1px solid var(--border-light)',
            borderRadius: 8, marginBottom: 12, fontSize: 12,
          }}>
            <select style={input} value={msgTo} onChange={e => setMsgTo(e.target.value)}>
              <option value="yak">📊 Yak</option>
              <option value="recha">🍵 热茶</option>
              <option value="*">📣 全员广播</option>
              {workers.map(w => <option key={w.id} value={w.id}>{w.icon} {w.name}</option>)}
            </select>
            <input style={input} value={msgSubject} onChange={e => setMsgSubject(e.target.value)} placeholder="主题" />
            <textarea style={{ ...input, minHeight: 40, fontFamily: 'inherit' }} value={msgBody}
              onChange={e => setMsgBody(e.target.value)} placeholder="正文（worker 间私信会自动抄送 Lumina）" />
            <div><button style={primaryBtn} onClick={sendMail}>✉️ 发送</button></div>
          </div>

          {/* 邮件列表 */}
          {mail.length === 0 && <div style={{ fontSize: 11, color: '#9ca3af' }}>📭 信箱为空</div>}
          {mail.slice().reverse().map((m: any) => (
            <div key={m.id} style={{
              padding: '6px 10px', borderRadius: 6, marginBottom: 4, fontSize: 11,
              background: m.kind === 'system' ? '#f9fafb' : 'var(--surface-0)',
              border: '1px solid var(--border-light)',
            }}>
              <div style={{ fontWeight: 600 }}>
                {m.kind === 'broadcast' ? '📣' : m.kind === 'system' ? '⚙️' : '✉️'} {m.from} → {m.to}：{m.subject}
                {m.cc?.length > 0 && <span style={{ color: '#9ca3af', fontWeight: 400 }}> （抄送 {m.cc.join(',')}）</span>}
              </div>
              <div style={{ color: '#4b5563', marginTop: 2, whiteSpace: 'pre-wrap' }}>{m.body}</div>
              <div style={{ marginTop: 4, color: '#9ca3af', fontSize: 10 }}>
                {new Date(m.ts).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ══════════ CU 策略 ══════════ */}
      {tab === 'cu' && policy && (
        <div style={{ fontSize: 12 }}>
          <div style={{
            padding: 10, borderRadius: 8, marginBottom: 12,
            background: session ? '#fef3c7' : '#f0fdf4',
            border: `1px solid ${session ? '#fde68a' : '#bbf7d0'}`,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {session ? `🔒 会话锁：${session.label}` : '🔓 会话锁：空闲'}
            </div>
            <div style={{ fontSize: 11, color: '#4b5563' }}>
              前台应用：{foreground ? `${foreground.proc}${foreground.title ? ` — ${foreground.title.slice(0, 40)}` : ''}` : '探测中…'}
            </div>
          </div>

          {([
            ['enabled', '🚦 权限门总开关'],
            ['humanInterrupt', '🙋 真人介入即停（动鼠标/键盘立即交还，v3.30）'],
            ['multiMonitor', '🖥️ 多显示器（截整个虚拟桌面，v3.30）'],
            ['maskBackgroundWindows', '🫣 隐私遮罩（非前台窗口涂黑，v3.30）'],
            ['browserReadonly', '🌐 浏览器只读（禁止模拟点击/输入）'],
            ['terminalClickOnly', '💻 终端/IDE 只点不打'],
            ['clipboardGrant', '📋 剪贴板写入需 full 授权'],
            ['sessionLock', '🔒 会话锁（防并发键鼠冲突）'],
            ['verifyAfterAction', '✅ 点击后画面验证（无变化提示重看）'],
          ] as const).map(([key, label]) => (
            <label key={key} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '6px 0', borderBottom: '1px solid #f3f4f6', cursor: 'pointer',
            }}>
              <span>{label}</span>
              <input type="checkbox" checked={!!policy[key]} onChange={() => togglePolicy(key)} />
            </label>
          ))}

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12 }}>
            <span style={{ fontSize: 11 }}>未知应用默认：</span>
            <select style={input} value={policy.defaultLevel}
              onChange={async e => setPolicy(await api()?.cuPolicySet?.({ defaultLevel: e.target.value }))}>
              {Object.entries(LEVEL_CN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>

          {/* 应用授权 */}
          <div style={{ marginTop: 12, padding: 10, background: 'var(--surface-100)', borderRadius: 8, border: '1px solid var(--border-light)' }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>应用授权</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input style={{ ...input, flex: 1 }} value={grantProc}
                onChange={e => setGrantProc(e.target.value)} placeholder="进程名，如 notepad / code" />
              <select style={input} value={grantLevel} onChange={e => setGrantLevel(e.target.value)}>
                {Object.entries(LEVEL_CN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <button style={primaryBtn} onClick={grant}>授权</button>
            </div>
            {Object.entries(policy.rules || {}).map(([proc, level]) => (
              <div key={proc} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '3px 0', fontSize: 11,
              }}>
                <span>🖥 {proc}</span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {LEVEL_CN[level as string] || String(level)}
                  <button style={{ ...btn, padding: '1px 6px' }} onClick={() => revoke(proc)}>撤销</button>
                </span>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 10, lineHeight: 1.6 }}>
            系统快捷键（Win+R、Ctrl+Shift+Esc、Alt+Tab 等）在任何授权级别下都被硬拦截；
            全局急停 Ctrl+Alt+X 始终有效。真人介入门默认开启，你一碰鼠标键盘 AI 立即停手。
          </div>
        </div>
      )}

      {/* ══════════ Teach 录制回放 ══════════ */}
      {tab === 'teach' && (
        <div style={{ fontSize: 12 }}>
          <div style={{
            padding: 10, borderRadius: 8, marginBottom: 12,
            background: recording ? '#fee2e2' : 'var(--surface-100)',
            border: `1px solid ${recording ? '#fca5a5' : 'var(--border-light)'}`,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              {recording ? '⏺️ 正在录制…操作完按 F8 结束（或点下方按钮）' : '演示一次，沉淀成可回放技能'}
            </div>
            <div style={{ fontSize: 10.5, color: '#6b7280', lineHeight: 1.6, marginBottom: 8 }}>
              录制鼠标点击/右键/拖拽/<b>滚轮</b>/组合键；勾选后也可聚合连续打字（<b>勿在密码框录制</b>）。
              回放走 Computer Use 权限门与真人介入保护，不是旁路注入。
            </div>
            <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={aggTyping} onChange={e => setAggTyping(e.target.checked)} />
              把连续打字聚合为文本回放（粘贴方式，支持长文本；默认关，保护隐私）
            </label>
            {!recording ? (
              <button style={{ ...primaryBtn, background: '#dc2626' }} onClick={startRecord}>⏺ 开始录制</button>
            ) : (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <input style={{ ...input, flex: 1, minWidth: 140 }} value={lessonName}
                  onChange={e => setLessonName(e.target.value)} placeholder="课程名（必填）" />
                <input style={{ ...input, flex: 1, minWidth: 140 }} value={lessonDesc}
                  onChange={e => setLessonDesc(e.target.value)} placeholder="说明（可选）" />
                <button style={primaryBtn} onClick={stopAndSave}>⏹ 结束并保存（F8）</button>
              </div>
            )}
          </div>
          {pendingEvents && (
            <div style={{
              padding: 10, borderRadius: 8, marginBottom: 12,
              background: '#fef3c7', border: '1px solid #fde68a',
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6, color: '#78350f' }}>
                已停止录制（{pendingEvents.length} 个原始事件），起个名字再保存：
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <input style={{ ...input, flex: 1, minWidth: 140 }} value={lessonName}
                  onChange={e => setLessonName(e.target.value)} placeholder="课程名（必填）" />
                <input style={{ ...input, flex: 1, minWidth: 140 }} value={lessonDesc}
                  onChange={e => setLessonDesc(e.target.value)} placeholder="说明（可选）" />
                <button style={primaryBtn} onClick={savePending}>保存课程</button>
                <button style={btn} onClick={() => {setPendingEvents(null); setLessonName(''); setLessonDesc('')}}>放弃</button>
              </div>
            </div>
          )}
          {lessons.length === 0 && <div style={{ fontSize: 11, color: '#9ca3af' }}>暂无已沉淀课程。也可对 Lumina 说「teach 回放 &lt;id&gt;」在对话中回放。</div>}
          {lessons.map((l: any) => (
            <div key={l.id} style={{
              padding: '6px 10px', borderRadius: 6, marginBottom: 4, fontSize: 11,
              background: 'var(--surface-0)', border: '1px solid var(--border-light)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
            }}>
              <span>
                <b>📚 {l.name}</b>
                <span style={{ color: '#9ca3af' }}> {l.id} · {l.eventCount} 事件{l.aggregateTyping ? ' · 含打字' : ''} · {new Date(l.createdAt).toLocaleString()}</span>
                {l.description && <div style={{ color: '#6b7280' }}>{l.description}</div>}
              </span>
              <span style={{ display: 'flex', gap: 4, whiteSpace: 'nowrap' }}>
                <button style={{ ...btn, padding: '1px 6px', ...(replaying === l.id ? { opacity: 0.6 } : {}) }}
                  disabled={replaying === l.id}
                  onClick={() => replayLesson(l.id, l.name)}>
                  {replaying === l.id ? '回放中…' : '▶ 回放'}
                </button>
                <button style={{ ...btn, padding: '1px 6px' }} onClick={() => removeLesson(l.id)}>删除</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ══════════ Workflow ══════════ */}
      {tab === 'workflow' && (
        <div style={{ fontSize: 12 }}>
          <div style={{ fontSize: 10.5, color: '#6b7280', lineHeight: 1.6, marginBottom: 10,
            padding: 10, background: 'var(--surface-100)', borderRadius: 8, border: '1px solid var(--border-light)' }}>
            🧶 工作流由 Lumina 用 JSON DSL 现写（不 eval 代码，安全），确定性调度器按依赖分层派给 worker，
            支持 when 条件跳过与 retry 有界重试（≤5 次），日志持久化、崩溃可续跑。
            在对话里对 Lumina 说「用 workflow 跑一个多步骤任务」即可生成。
          </div>
          {workflows.length === 0 && <div style={{ fontSize: 11, color: '#9ca3af' }}>暂无工作流。</div>}
          {workflows.map((j: any) => (
            <div key={j.id} style={{
              padding: '6px 10px', borderRadius: 6, marginBottom: 4, fontSize: 11,
              background: 'var(--surface-0)', border: '1px solid var(--border-light)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <b>🧶 {j.name}</b>
                <span style={{ color: '#9ca3af' }}>{j.id} · {j.status} · {j.mode}</span>
                <button style={{ ...btn, padding: '1px 6px' }} onClick={() => openWorkflow(j.id)}>明细</button>
              </div>
              {wfDetail?.id === j.id && (
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {(j.def?.steps || []).map((s: any) => {
                    const r = j.steps?.[s.id]
                    const icon = r?.status === 'done' ? '✅' : r?.status === 'failed' ? '❌'
                      : r?.status === 'skipped' ? '⏭️' : r?.status === 'running' ? '🔄' : '⬜'
                    return (
                      <div key={s.id} style={{ fontSize: 10.5 }}>
                        {icon} {s.id}（{s.role || 'general'}）：{r?.status || 'pending'}
                        {s.after?.length ? ` · 依赖 ${s.after.join(',')}` : ''}
                        {s.when ? ` · when ${s.when.op}${s.when.not ? '(not)' : ''}` : ''}
                        {s.retry ? ` · retry×${s.retry.maxAttempts || 2}` : ''}
                        {r?.attempts > 1 ? ` · 第${r.attempts}次尝试` : ''}
                      </div>
                    )
                  })}
                  {j.error && <div style={{ color: '#b91c1c' }}>⚠️ {j.error}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ══════════ 成长/日记（v3.33） ══════════ */}
      {tab === 'growth' && (
        <div style={{ fontSize: 12 }}>
          {/* 内驱力自领取 */}
          <div style={{
            padding: 10, borderRadius: 8, marginBottom: 12,
            background: autonomy?.running ? '#f0fdf4' : 'var(--surface-100)',
            border: `1px solid ${autonomy?.running ? '#bbf7d0' : 'var(--border-light)'}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <b>🧭 内驱力自领取{autonomy?.running ? '（运行中）' : '（未运行）'}</b>
              <button style={{ ...primaryBtn, ...(autonomy?.running ? { background: '#6b7280' } : {}) }}
                onClick={toggleAutonomy}>
                {autonomy?.running ? '停止' : '启动'}
              </button>
            </div>
            <div style={{ fontSize: 10.5, color: '#6b7280', marginTop: 6, lineHeight: 1.6 }}>
              开启后，留场 idle 成员越闲越主动，按工种责任心到任务板自认领（抖动轮询、并发帽 2，
              非 1 秒硬轮询）；自定义工种与一次性 worker 不自动揽活。
              {autonomy?.running && ` 在飞 ${autonomy.inFlight}/${autonomy.maxConcurrent}，累计自领取 ${autonomy.totalClaims} 次。`}
            </div>
          </div>

          {/* 工种绩效画像 */}
          <div style={{ fontWeight: 700, marginBottom: 6 }}>📊 工种绩效画像</div>
          {Object.keys(profiles).length === 0 && (
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 12 }}>
              还没有任务履历（临时工干完第一批活后，成功率/易错点/经验卡会沉淀在这里）。
            </div>
          )}
          {Object.values(profiles).map((p: any) => {
            const rate = p.jobs ? Math.round(((p.success + 1) / (p.jobs + 2)) * 100) : 50
            const top = Object.entries(p.mistakes as Record<string, number>)
              .sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, 3)
            const avg = p.jobs ? Math.round(p.totalDurationMs / p.jobs / 1000) : 0
            return (
              <div key={p.role} style={{
                padding: '6px 10px', borderRadius: 6, marginBottom: 4,
                background: 'var(--surface-0)', border: '1px solid var(--border-light)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <b>👷 {p.role}</b>
                  <span style={{ color: '#6b7280' }}>
                    {p.jobs} 单（✅{p.success}/❌{p.fail}）≈{rate}% · 均{avg}s · 🗃️{p.cards?.length || 0}
                  </span>
                </div>
                {top.length > 0 && (
                  <div style={{ fontSize: 10.5, color: '#b45309', marginTop: 2 }}>
                    易错：{top.map(([t, n]) => `${t}×${n}`).join('、')}
                  </div>
                )}
              </div>
            )
          })}

          {/* 任务追踪 */}
          {trace?.summary && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                🔎 任务追踪
                <span style={{ fontWeight: 400, fontSize: 10, color: '#9ca3af' }}>
                  （任务级，非 token 计费日志；✅{trace.summary.ok} ❌{trace.summary.fail} 在飞{trace.summary.running} 长任务{trace.summary.longRunning} 均{Math.round(trace.summary.avgDurationMs / 1000)}s）
                </span>
              </div>
              {(trace.entries || []).slice(-8).map((e: any) => (
                <div key={e.id} style={{ fontSize: 10.5, color: '#4b5563', padding: '1px 0' }}>
                  {e.phase === 'start' ? '▶️' : e.ok ? '✅' : '❌'} {new Date(e.at).toLocaleTimeString()}
                  {' '}[{e.source}/{e.role}] {e.title}
                  {e.phase === 'end' ? ` ${Math.round((e.durationMs || 0) / 1000)}s` : ''}
                  {e.longRunning ? ' ⏱️' : ''}
                </div>
              ))}
            </div>
          )}

          {/* 团队日记 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              🌙 今日团队日记
              <button style={{ ...btn, marginLeft: 8, padding: '1px 8px' }}
                onClick={() => api()?.collabDailyLog?.().then(setDailyLog).catch(() => null)}>刷新</button>
            </div>
            <div style={{
              padding: 10, borderRadius: 8, whiteSpace: 'pre-wrap',
              background: 'var(--surface-100)', border: '1px solid var(--border-light)',
              fontSize: 11, lineHeight: 1.7, color: '#374151',
            }}>
              {dailyLog ? dailyLog.markdown.replace(/^## .*$/m, '') : '点「刷新」生成今日团队日记（任务板/追踪/工种成长）。'}
            </div>
          </div>

          {/* 整轮检查点 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>📸 代码检查点（合并前自动拍点，可回滚）</div>
            {checkpoints.length === 0 && <div style={{ fontSize: 11, color: '#9ca3af' }}>暂无检查点（code worker 合并 worktree 时自动创建）。</div>}
            {checkpoints.slice(0, 10).map((c: any) => (
              <div key={c.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                padding: '4px 8px', borderRadius: 6, marginBottom: 4, fontSize: 10.5,
                background: 'var(--surface-0)', border: '1px solid var(--border-light)',
              }}>
                <span>{new Date(c.at).toLocaleString()} 「{c.ref}」 {c.branch}@{c.head.slice(0, 7)}
                  {c.mergedHead ? ` → ${c.mergedHead.slice(0, 7)}` : ''}</span>
                {c.mergedHead && <button style={{ ...btn, padding: '1px 6px', color: '#b91c1c' }}
                  onClick={() => rollback(c)}>回滚</button>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
