// ============================================================
// ipc/teamCollabIpc.ts — 团队协作 v3.20 IPC（信箱 / 任务板 / 动态 worker / CU 策略）
//
// 这些是给「团队面板」UI 用的只读/轻量写通道；
// agent 侧通过工具（team_message/team_tasks/hire_worker/adversarial_review）使用。
// ============================================================

import { ipcMain, screen } from 'electron'
import { getTeamMailbox } from '../team/teamMailbox'
import { getSharedBoard } from '../team/teamSharedBoard'
import {
  listDynamicWorkers, allMemberIds, requestShutdown,
} from '../team/dynamicWorker'
import { getAgentMarkdownRegistry } from '../team/agentMarkdown'
import { getWorkflowStore } from '../team/workflowScript'
import { getLessonStore, getTeachRecorder } from '../team/teachRecorder'
import { listTeamMembers } from '../core/teamRegistry'
import {
  getCuPolicy, setCuPolicy, grantApp, revokeApp,
  getActiveSession, getForegroundApp,
} from '../tools/impl/cuPermissions'
import { getWorkerStats, rankRolesForKind } from '../team/workerStats'
import { getTaskTrace } from '../team/llmTrace'
import { getTeamAutonomy, recoverOnStartup } from '../team/teamAutonomy'
import { replayLesson } from '../tools/impl/teamCollab'
import { getCheckpointStore, rollbackCheckpoint } from '../team/teamCheckpoint'
import { getDailyLog, buildDigest } from '../team/teamDailyLog'

// v3.33 任务类型 → 候选工种（与 teamCollab.ts team_stats 保持一致）
const KIND_CANDIDATES: Record<string, string[]> = {
  research: ['research', 'general'],
  search: ['search', 'research', 'general'],
  data: ['data', 'general'],
  code: ['code', 'test'],
  test: ['test', 'code'],
  review: ['review', 'test'],
  other: ['general'],
}

export function registerTeamCollabIpc(): void {
  // v3.33 启动恢复：回收中断任务 + worktree 对账；随后启动内驱力自领取
  void recoverOnStartup().then(report => {
    if (report.reapedTasks.length || report.orphanWorktrees) {
      console.log('[TeamCollabIPC] 崩溃恢复:', report.notice)
    }
  }).catch(() => undefined)
  try { getTeamAutonomy().start() } catch { /* ignore */ }

  // ── 文件信箱 ────────────────────────────────────────

  ipcMain.handle('team-collab:members', () => {
    return allMemberIds()
  })

  ipcMain.handle('team-collab:mailbox-inbox', async (_e, member: string, unreadOnly = true) => {
    return getTeamMailbox().inbox(member, { unreadOnly, limit: 100 })
  })

  ipcMain.handle('team-collab:mailbox-counts', async () => {
    return getTeamMailbox().counts(allMemberIds())
  })

  // v3.32 聚合通讯流（拓扑工作台右侧）
  ipcMain.handle('team-collab:mail-stream', async () => {
    return getTeamMailbox().stream(200)
  })

  ipcMain.handle('team-collab:mailbox-mark', async (_e, member: string, ids?: string[]) => {
    return { count: await getTeamMailbox().markRead(member, ids) }
  })

  ipcMain.handle('team-collab:mailbox-send', async (_e, payload: {
    from: string; to: string; subject: string; body: string
  }) => {
    const msg = await getTeamMailbox().send({
      from: payload.from || 'lumina',
      to: payload.to,
      subject: payload.subject,
      body: payload.body,
      kind: 'dm',
    })
    return { ok: true, id: msg.id }
  })

  // ── 共享任务板 ──────────────────────────────────────

  ipcMain.handle('team-collab:board', () => getSharedBoard().snapshot())

  ipcMain.handle('team-collab:board-history', (_e, since?: number) => getSharedBoard().getHistory(since || 0))

  ipcMain.handle('team-collab:board-list', (_e, filter: any) => getSharedBoard().list(filter || {}))

  ipcMain.handle('team-collab:board-action', async (_e, action: string, payload: any) => {
    const board = getSharedBoard()
    const member = payload?.owner || 'lumina'
    switch (action) {
      case 'create':
        return board.createTask({
          title: String(payload.title),
          detail: payload.detail || '',
          kind: payload.kind || 'other',
          createdBy: member,
          priority: Number(payload.priority) || 0,
          blockedBy: Array.isArray(payload.blockedBy) ? payload.blockedBy : [],
          requireApproval: !!payload.requireApproval,
        })
      case 'approve':
        return board.approve(String(payload.id), member)
      case 'reject':
        return board.reject(String(payload.id), member, String(payload.reason || '未说明原因'))
      case 'claim':
        return board.claim(String(payload.id), member)
      case 'next':
        return board.claimNext(member, {})
      case 'start':
        return board.start(String(payload.id), member)
      case 'complete':
        return board.complete(String(payload.id), member, String(payload.result || '已完成'))
      case 'fail':
        return board.fail(String(payload.id), member, String(payload.error || '未知错误'))
      case 'block':
        return board.block(String(payload.id), member, String(payload.error || '被阻塞'))
      case 'release':
        return board.release(String(payload.id), member)
      default:
        throw new Error(`未知 board action: ${action}`)
    }
  })

  // ── 动态 worker（v3.30 含状态/模型分级/工作区 + 关停握手） ─────

  ipcMain.handle('team-collab:workers', () => {
    return listDynamicWorkers().map(w => ({
      id: w.id, name: w.name, role: w.role, icon: w.icon,
      hiredAt: w.hiredAt, busy: w.busy,
      state: w.state, modelTier: w.modelTier, model: w.model,
      workdir: w.workdir || null, keepAlive: w.keepAlive,
    }))
  })

  ipcMain.handle('team-collab:worker-shutdown', (_e, id: string) => requestShutdown(String(id)))

  // ── 成员检查器 / 自定义工种 ──────────────────────────

  ipcMain.handle('team-collab:members-detail', () => listTeamMembers())

  ipcMain.handle('team-collab:custom-roles', () => getAgentMarkdownRegistry().list())

  // ── 工作流（v3.30 P2） ──────────────────────────────

  ipcMain.handle('team-collab:workflows', () => getWorkflowStore().list())

  ipcMain.handle('team-collab:workflow-get', (_e, id: string) => getWorkflowStore().get(String(id)))

  // ── Teach 录制回放（v3.30 P2） ───────────────────────

  ipcMain.handle('teach:record-start', () => getTeachRecorder().start())

  ipcMain.handle('teach:record-stop', async () => {
    const r = await getTeachRecorder().stop()
    return r
  })

  ipcMain.handle('teach:save', (_e, payload: { name: string; description?: string; events: any[]; aggregateTyping?: boolean }) => {
    if (!payload?.name || !Array.isArray(payload.events)) {
      throw new Error('teach:save 需要 name 与 events')
    }
    const d = screen.getPrimaryDisplay()
    const sf = d.scaleFactor || 1
    return getLessonStore().save({
      name: String(payload.name),
      description: payload.description ? String(payload.description) : '',
      events: payload.events,
      screenW: Math.round(d.size.width * sf),
      screenH: Math.round(d.size.height * sf),
      aggregateTyping: !!payload.aggregateTyping,
    })
  })

  ipcMain.handle('teach:list', () => getLessonStore().list())

  ipcMain.handle('teach:remove', (_e, id: string) => getLessonStore().remove(String(id)))

  // v3.31：UI 直接回放（复用 agent 工具同一条回放路径，权限门/真人中止全部生效）
  ipcMain.handle('teach:replay', async (_e, id: string) => {
    const lesson = getLessonStore().get(String(id))
    if (!lesson) {throw new Error(`课程 ${id} 不存在`)}
    return replayLesson(lesson)
  })

  // ── Computer Use 策略（权限门） ─────────────────────

  ipcMain.handle('cu-policy:get', () => getCuPolicy())

  ipcMain.handle('cu-policy:set', (_e, patch: any) => setCuPolicy(patch || {}))

  ipcMain.handle('cu-policy:grant', (_e, proc: string, level: string) => grantApp(proc, level as any))

  ipcMain.handle('cu-policy:revoke', (_e, proc: string) => revokeApp(proc))

  ipcMain.handle('cu-policy:session', () => getActiveSession())

  ipcMain.handle('cu-policy:foreground', async () => {
    try {return await getForegroundApp()} catch {return null}
  })

  // ── v3.33 绩效画像 / 任务追踪 / 自治 / 检查点 / 团队日记 ─────

  ipcMain.handle('team-collab:stats-profiles', () => getWorkerStats().getState())

  ipcMain.handle('team-collab:stats-rank', (_e, kind: string) => {
    const candidates = KIND_CANDIDATES[String(kind)] || KIND_CANDIDATES.other
    return rankRolesForKind(getWorkerStats().getState(), candidates)
  })

  ipcMain.handle('team-collab:trace', (_e, limit?: number) => {
    const trace = getTaskTrace()
    return { entries: trace.list(limit || 30), summary: trace.summary() }
  })

  ipcMain.handle('team-collab:autonomy', (_e, action?: string) => {
    const auto = getTeamAutonomy()
    if (action === 'start') {auto.start()}
    else if (action === 'stop') {auto.stop()}
    return auto.status()
  })

  ipcMain.handle('team-collab:checkpoints', () => getCheckpointStore().list())

  ipcMain.handle('team-collab:checkpoint-rollback', async (_e, id: string, confirm: boolean) => {
    const cp = getCheckpointStore().get(String(id))
    if (!cp) {throw new Error(`检查点 ${id} 不存在`)}
    return rollbackCheckpoint(cp, !!confirm)
  })

  ipcMain.handle('team-collab:daily-log', (_e, dateStr?: string) => {
    const store = getDailyLog()
    const d = new Date()
    if (dateStr === 'yesterday') {d.setDate(d.getDate() - 1)}
    const events = getSharedBoard().getHistory()
    const traces = getTaskTrace().list(5000).slice().reverse()
    const digest = buildDigest(
      {
        events, traces, stats: getWorkerStats().getState(),
        autonomousClaims: getTeamAutonomy().status().totalClaims,
      },
      d,
    )
    store.save(digest)
    return digest
  })

  console.log('[TeamCollabIPC] 团队协作 v3.33 IPC 注册完成')
}
