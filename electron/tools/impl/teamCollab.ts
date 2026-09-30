// ============================================================
// teamCollab.ts — 团队协作新工具 (v3.20, 对标 cc-haha agent teams)
//
// 新增 6 个工具，把 cc-haha 的「文件信箱 / 共享任务板 / 动态工种 /
// worktree 隔离 / 对抗评审团」能力暴露给 Lumina 团队（含后台 worker）：
//
//   team_message       发私信/广播（worker 私信自动抄送 Lumina）
//   team_mailbox       读/标记/统计信箱
//   team_tasks         共享任务板（创建/列出/认领/完成/失败/看板）
//   hire_worker        临时雇佣研究/检索/数据/工程/复核/测试 worker 并行干活
//   adversarial_review 多视角怀疑者投票 + 完整性批评
//   git_worktree       创建/列出/移除/合并隔离工作区
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { getTeamMailbox } from '../../team/teamMailbox'
import { getSharedBoard, type BoardTaskKind } from '../../team/teamSharedBoard'
import {
  hireAndRun, hireWorker as hireDynamicWorker, runWorker as runDynamicWorker,
  dismissWorker as dismissDynamicWorker, wakeWorker, requestShutdown,
  ROLE_SPECS, listDynamicWorkers, allMemberIds,
  type WorkerRole, type JobSpec,
} from '../../team/dynamicWorker'
import { getAgentMarkdownRegistry } from '../../team/agentMarkdown'
import {
  validateWorkflow, getWorkflowStore, runJournal,
  type WorkflowDef, type StepExecutor, type WorkflowJournal,
} from '../../team/workflowScript'
import { getLessonStore, getTeachRecorder, type Lesson } from '../../team/teachRecorder'
import { eventsToActions, type ConvertedAction } from '../../team/teachRecorder'
import { captureScreen, executeCuAction, type CuScreen } from './cuCore'
import { acquireCuSession, releaseCuSession } from './cuPermissions'
import { runAdversarialReview, formatReviewReport, DEFAULT_PERSPECTIVES } from '../../team/adversarialReview'
import { getTeamAutonomy } from '../../team/teamAutonomy'
import {
  createWorktree, listWorktrees, removeWorktree, mergeWorktree,
} from '../../team/gitWorktree'
import { listTeamMembers } from '../../core/teamRegistry'
import { newCrewState, crewStep, actionKindOf, formatCrewReport } from '../../team/cuCrew'
import { getWorkerStats, formatProfiles, rankRolesForKind } from '../../team/workerStats'
import { getTaskTrace } from '../../team/llmTrace'
// 注意：teamAutonomy 依赖 dynamicWorker，而 dynamicWorker→agentRunner→tools 入口会回到本模块，
// 顶层静态导入会形成循环依赖（ROLE_SPECS 未初始化）。故 teamAutonomy 一律在函数内动态 import。
import { getCheckpointStore, createCheckpoint, rollbackCheckpoint } from '../../team/teamCheckpoint'
import { buildDigest, getDailyLog, dayRange } from '../../team/teamDailyLog'
import { sendApprovalRequest, recordApprovalVerdict } from '../../team/teamPolicy'

const ok = (content: string): ToolResult => ({ callId: `collab-${Date.now()}`, ok: true, content })
const fail = (error: string): ToolResult => ({ callId: `collab-${Date.now()}`, ok: false, content: '', error })

/** 内置工种 + agents/*.md 自定义工种（热加载） */
function allRoleIds(): string[] {
  return [...Object.keys(ROLE_SPECS), ...getAgentMarkdownRegistry().list().map(a => a.id)]
}
// 惰性求值：本模块处于 dynamicWorker→agentRunner→tools 入口→本模块的循环依赖链上，
// 模块顶层求值时 ROLE_SPECS 可能尚未初始化，调用时再取可拿到完整对象。
const VALID_ROLES = () => Object.keys(ROLE_SPECS) as WorkerRole[]

// ═══════════════════════════════════════════════════════════
//  worker 结果回灌：截断必须留痕，空结果必须算失败
//
//  为什么这两件事必须一起做：
//  子 agent 产出 4000 字、主 agent 只拿到前 1500 字却不知道被切过，
//  模型就会把半截当成「已经查全了」的结论去回答用户 —— 这是最隐蔽的一种答错：
//  它不会报错、看不出异常，只是结论缺了后半截。
//  反过来，0 成功时回灌 ok:true +「0/6 成功」，模型极易读成
//  「已经查过了，确实没有相关内容」，于是编一个自信的否定结论。
//  静默截断 + 静默成功，是同一个毛病的两个方向。
// ═══════════════════════════════════════════════════════════

/** 单个 worker 结果回灌给主 agent 的字数上限 */
export const WORKER_RESULT_MAX_CHARS = 1500

/** 截断标记文案（单测与上层展示都依赖这个语义，不要随意改写） */
export const WORKER_TRUNCATION_MARK = '已截断'

/** 截断但显式标注：告诉主 agent「这是节选，不是全文」 */
export function truncateWorkerResult(raw: string, max = WORKER_RESULT_MAX_CHARS): string {
  const text = String(raw || '')
  if (text.length <= max) {return text}
  return `${text.slice(0, max)}\n…（${WORKER_TRUNCATION_MARK}，完整共 ${text.length} 字）`
}

/** hire 工具回灌结果的最小结构（避开 JobResult 全量字段，方便单测构造） */
export interface HireResultItem {
  role: string
  name: string
  title: string
  ok: boolean
  result?: string
  error?: string
  worktreeMerged?: boolean
}

/**
 * 拼装 hire_worker 的 ToolResult。
 *
 * 判定规则：没有任何一条「成功」结果里带文本 → 走 fail。
 * 「0/6 成功」对模型来说是合法但无信息量的输出，必须显式升级成错误，
 * 否则主 agent 会自己脑补一个「查过了没有」的结论。
 */
export function formatHireResult(
  results: HireResultItem[],
  alive: number,
  iconOf: (role: string) => string,
  maxChars = WORKER_RESULT_MAX_CHARS,
): ToolResult {
  const succeeded = results.filter(r => r.ok).length
  const usable = results.filter(r => r.ok && String(r.result || '').trim().length > 0).length

  const summary = results.map((r, i) => {
    const head = `${i + 1}. ${iconOf(r.role)} ${r.name}「${r.title}」${r.ok ? '✅' : '❌'}${r.worktreeMerged ? ' 🔀已合并' : ''}`
    let body: string
    if (!r.ok) {
      body = `失败：${r.error}`
    } else if (!String(r.result || '').trim()) {
      body = '⚠️ worker 未产出任何文本（空回复，不能当作查到了内容）'
    } else {
      body = truncateWorkerResult(String(r.result || ''), maxChars)
    }
    return `${head}\n${body}`
  }).join('\n\n')

  if (usable === 0) {
    return fail(
      `worker 未产出任何文本（${succeeded}/${results.length} 成功但无有效内容，${alive} 位留场）。\n\n${summary}\n\n`
      + '⚠️ 这不代表「查过了、确实没有相关内容」，而是没有拿到任何内容。'
      + '请改用其他方式获取信息，不要把空结果当成结论回复用户。',
    )
  }

  return ok(`👷 并行雇佣 ${results.length} 位 worker 完成（${succeeded}/${results.length} 成功，${alive} 位留场）：\n\n${summary}`)
}

// ═══════════════════════════════════════════════════════════
// team_message
// ═══════════════════════════════════════════════════════════

export const teamMessageDef: ToolDef = {
  name: 'team_message',
  description: `给团队成员发消息（文件信箱，异步）。
- 私信：to=成员 id（yak/recha 或临时 worker id），对方用 team_mailbox 读取。
- 广播：to="*" 发给全员（含 Lumina）。
- worker 之间的私信会自动抄送 Lumina，保证 Lumina 对后台协作全可见。
适用场景：索要/补充材料、同步进度、请求另一工种协助；不要用来委托完整任务（那用 delegate_to / hire_worker）。`,
  params: {
    to: { type: 'string', description: '收件人 id（yak/recha/临时 worker id），广播用 *', required: true },
    subject: { type: 'string', description: '一句话主题', required: true },
    body: { type: 'string', description: '消息正文', required: true },
    from: { type: 'string', description: '发件人 id（后台 worker 填自己的 id；Lumina 调用可不填）', required: false },
  },
  toolsets: ['team', 'agent', 'developer'],
}

export async function teamMessage(args: Record<string, any>): Promise<ToolResult> {
  const to = String(args.to || '').trim()
  const subject = String(args.subject || '').trim()
  const body = String(args.body || '').trim()
  const from = String(args.from || 'lumina').trim()
  if (!to) {return fail('缺少收件人 to')}
  if (!subject || !body) {return fail('subject 和 body 不能为空')}

  const box = getTeamMailbox()
  try {
    if (to === '*' || to === 'all') {
      // broadcast 内部自动排除发送者；发给其余全部成员（含 Lumina）
      const members = allMemberIds()
      const delivered = await box.broadcast({ from, subject, body, members })
      return ok(`📣 已广播给 ${delivered.length} 位成员：${delivered.map(m => m.to).join(', ')}`)
    }
    const known = new Set(listTeamMembers().map((m: any) => m.id))
    if (!known.has(to)) {
      return fail(`收件人「${to}」不在团队中。当前成员：${[...known].join(', ')}`)
    }
    const msg = await box.send({ from, to, subject, body, kind: 'dm' })
    const ccNote = msg.cc && msg.cc.length ? `（已自动抄送 ${msg.cc.join(', ')}）` : ''
    return ok(`✉️ 已发给 ${to}：${subject} ${ccNote}`)
  } catch (e: any) {
    return fail(`发送失败: ${e?.message || e}`)
  }
}

// ═══════════════════════════════════════════════════════════
// team_mailbox
// ═══════════════════════════════════════════════════════════

export const teamMailboxDef: ToolDef = {
  name: 'team_mailbox',
  description: `读取/管理团队文件信箱。
- action=read：读取未读消息（默认）；member 指定读谁的信箱（worker 填自己的 id，Lumina 可不填）。
- action=mark：标记已读（ids 传消息 id 数组，不传表示全部已读）。
- action=count：查看各成员未读数。
- action=poll：阻塞等待新消息（最多 30 秒，worker 等待派活时用）。`,
  params: {
    action: { type: 'string', description: 'read / mark / count / poll', required: true },
    member: { type: 'string', description: '信箱归属成员 id（默认 lumina）', required: false },
    unread_only: { type: 'boolean', description: 'read 时是否只看未读（默认 true）', required: false },
    ids: { type: 'string', description: 'mark 时的消息 id，逗号分隔或 JSON 数组', required: false },
  },
  toolsets: ['team', 'agent', 'developer'],
}

export async function teamMailbox(args: Record<string, any>): Promise<ToolResult> {
  const action = String(args.action || 'read').trim()
  const member = String(args.member || 'lumina').trim()
  const box = getTeamMailbox()
  try {
    if (action === 'read') {
      const unreadOnly = args.unread_only !== false
      const msgs = await box.inbox(member, { unreadOnly, limit: 50 })
      if (msgs.length === 0) {return ok(`📭 ${member} 的信箱没有${unreadOnly ? '未读' : ''}消息`)}
      const text = msgs.map(m => {
        const cc = m.cc && m.cc.length ? ` [抄送${m.cc.join(',')}]` : ''
        const kind = m.kind === 'broadcast' ? '📣' : m.kind === 'system' ? '⚙️' : '✉️'
        return `${kind} [${m.id}] ${new Date(m.ts).toLocaleTimeString()} ${m.from}→${m.to}${cc}\n   主题：${m.subject}\n   ${m.body}`
      }).join('\n\n')
      return ok(`📬 ${member} 的信箱（${msgs.length} 封）：\n\n${text}`)
    }
    if (action === 'mark') {
      let ids: string[] | undefined
      if (args.ids) {
        try {
          const parsed = JSON.parse(String(args.ids))
          ids = Array.isArray(parsed) ? parsed.map(String) : [String(args.ids)]
        } catch {
          ids = String(args.ids).split(',').map(s => s.trim()).filter(Boolean)
        }
      }
      const n = await box.markRead(member, ids)
      return ok(`✅ 已标记 ${n} 封消息为已读`)
    }
    if (action === 'count') {
      const members = allMemberIds()
      const counts = box.counts(members)
      const text = Object.entries(counts).map(([m, n]) => `${m}: ${n}`).join('\n')
      return ok(`📊 未读数：\n${text}`)
    }
    if (action === 'poll') {
      const msgs = await box.poll(member, 30_000, 1000)
      if (msgs.length === 0) {return ok('⏳ 等待 30 秒无新消息')}
      return ok(`📬 收到 ${msgs.length} 封新消息：\n\n${msgs.map(m => `✉️ ${m.from}：${m.subject}\n${m.body}`).join('\n\n')}`)
    }
    return fail(`未知 action: ${action}`)
  } catch (e: any) {
    return fail(`信箱操作失败: ${e?.message || e}`)
  }
}

// ═══════════════════════════════════════════════════════════
// team_tasks
// ═══════════════════════════════════════════════════════════

export const teamTasksDef: ToolDef = {
  name: 'team_tasks',
  description: `团队共享任务板（持久化，worker 自主认领）。
- action=create：挂任务（title/detail/kind/priority/blockedBy，require_approval=true 时先进待批准泳道）。
- action=approve/reject：人工批准/驳回待批准任务（reject 需 reason）。
- action=list：列任务（status/owner/kind 可过滤）。
- action=ready：列当前可认领的任务（依赖已完成、已批准）。
- action=claim：认领指定任务（id+owner）。
- action=next：原子认领一个可做任务（owner 自领取，按优先级）。
- action=start/complete/fail/block/release：更新任务状态。
- action=board：看板泳道快照；action=history：状态变更历史（拓扑回放）。
kind: research/search/data/code/review/test/other；status: pending/pending_approval/claimed/running/done/failed/blocked。`,
  params: {
    action: { type: 'string', description: 'create/approve/reject/list/ready/claim/next/start/complete/fail/block/release/board/history', required: true },
    id: { type: 'string', description: '任务 id（更新/认领/审批时）', required: false },
    title: { type: 'string', description: 'create 时的任务标题', required: false },
    detail: { type: 'string', description: '任务详情', required: false },
    kind: { type: 'string', description: 'research/search/data/code/review/test/other', required: false },
    priority: { type: 'number', description: '数字越大越优先（默认 0）', required: false },
    blocked_by: { type: 'string', description: '依赖任务 id，逗号分隔', required: false },
    require_approval: { type: 'boolean', description: 'create 时是否需要人工批准（plan_approval）', required: false },
    owner: { type: 'string', description: '认领/操作者 id（worker 填自己 id，Lumina 可不填）', required: false },
    result: { type: 'string', description: 'complete 时的结果摘要', required: false },
    reason: { type: 'string', description: 'reject 时的驳回原因', required: false },
    error: { type: 'string', description: 'fail/block 时的原因', required: false },
    status: { type: 'string', description: 'list 过滤状态', required: false },
  },
  toolsets: ['team', 'agent', 'developer'],
}

function parseBlocked(v: any): string[] {
  if (!v) {return []}
  if (Array.isArray(v)) {return v.map(String)}
  return String(v).split(',').map(s => s.trim()).filter(Boolean)
}

function fmtTask(t: any): string {
  const owner = t.owner || '未认领'
  const dep = t.blockedBy?.length ? ` 依赖[${t.blockedBy.join(',')}]` : ''
  const tail = t.status === 'done' ? `\n     结果：${String(t.result || '').slice(0, 200)}`
    : t.status === 'failed' || t.status === 'blocked' ? `\n     原因：${t.error}` : ''
  return `[${t.id}] (${t.status}) ${t.title} 〈${t.kind}〉 👤${owner} 优先级${t.priority}${dep}${tail}`
}

export async function teamTasks(args: Record<string, any>): Promise<ToolResult> {
  const action = String(args.action || 'board').trim()
  const owner = String(args.owner || 'lumina')
  const board = getSharedBoard()
  try {
    switch (action) {
      case 'create': {
        if (!args.title) {return fail('create 缺少 title')}
        const kind = (args.kind || 'other') as BoardTaskKind
        const t = await board.createTask({
          title: String(args.title),
          detail: args.detail ? String(args.detail) : '',
          kind,
          createdBy: owner,
          priority: Number(args.priority) || 0,
          blockedBy: parseBlocked(args.blocked_by),
          requireApproval: !!args.require_approval,
        })
        if (t.status === 'pending_approval') {
          // v3.33 聊天式审批：创建者在信箱里向 Lumina 申请批准
          await sendApprovalRequest(t)
          return ok(`📋 已挂任务 ${fmtTask(t)}（等待人工批准，已在团队信箱提交申请）`)
        }
        return ok(`📋 已挂任务 ${fmtTask(t)}`)
      }
      case 'approve': {
        if (!args.id) {return fail('approve 缺少 id')}
        const before = board.list().find(t => t.id === String(args.id))
        const t = await board.approve(String(args.id), owner)
        recordApprovalVerdict(before?.createdBy || 'lumina', true)
        return ok(`🆗 ${owner} 已批准任务 ${t.id}，进入待认领池（已通知申请人）`)
      }
      case 'reject': {
        if (!args.id) {return fail('reject 缺少 id')}
        const before = board.list().find(t => t.id === String(args.id))
        const reason = String(args.reason || '未说明原因')
        const t = await board.reject(String(args.id), owner, reason)
        recordApprovalVerdict(before?.createdBy || 'lumina', false)
        if (before && before.createdBy !== 'lumina') {
          await getTeamMailbox().send({
            from: 'lumina', to: before.createdBy,
            subject: `任务 ${t.id}「${t.title}」被驳回`,
            body: `驳回原因：${reason}`, kind: 'dm',
          }).catch(() => null)
        }
        return ok(`🚫 ${owner} 驳回任务 ${t.id}：${t.error}`)
      }
      case 'history': {
        const events = board.getHistory()
        if (!events.length) {return ok('（暂无状态变更历史）')}
        const lines = events.slice(-40).map(e =>
          `${new Date(e.ts).toLocaleTimeString()} ${e.taskId} ${e.from}→${e.to}（${e.by}）${e.title ? ` ${e.title}` : ''}`)
        return ok(`🕘 任务板状态变更（最近 ${lines.length} 条）：\n${lines.join('\n')}`)
      }
      case 'list': {
        const list = board.list({
          status: args.status,
          owner: args.owner,
          kind: args.kind,
        })
        if (list.length === 0) {return ok('📭 没有匹配的任务')}
        return ok(`📋 任务列表（${list.length}）：\n${list.map(fmtTask).join('\n')}`)
      }
      case 'ready': {
        const ready = board.ready()
        if (ready.length === 0) {return ok('📭 当前没有可认领的任务')}
        return ok(`✅ 可认领任务（${ready.length}）：\n${ready.map(fmtTask).join('\n')}`)
      }
      case 'claim': {
        if (!args.id) {return fail('claim 缺少 id')}
        const t = await board.claim(String(args.id), owner)
        return ok(`🙋 ${owner} 已认领 ${fmtTask(t)}`)
      }
      case 'next': {
        const kinds = args.kind ? String(args.kind).split(',').map(s => s.trim()) as BoardTaskKind[] : undefined
        const t = await board.claimNext(owner, { kinds })
        if (!t) {return ok('📭 没有可认领的任务')}
        return ok(`🙋 ${owner} 自动领取 ${fmtTask(t)}\n详情：${t.detail || '(无)'}`)
      }
      case 'start': {
        const t = await board.start(String(args.id), owner)
        return ok(`▶️ 任务 ${t.id} 进入 running`)
      }
      case 'complete': {
        const t = await board.complete(String(args.id), owner, String(args.result || '已完成'))
        return ok(`✔️ 任务 ${t.id} 完成：${String(t.result || '').slice(0, 200)}`)
      }
      case 'fail': {
        const t = await board.fail(String(args.id), owner, String(args.error || '未知错误'))
        return ok(`❌ 任务 ${t.id} 失败：${t.error}`)
      }
      case 'block': {
        const t = await board.block(String(args.id), owner, String(args.error || '被阻塞'))
        return ok(`⛔ 任务 ${t.id} 阻塞：${t.error}`)
      }
      case 'release': {
        const t = await board.release(String(args.id), owner)
        return ok(`↩️ 任务 ${t.id} 已释放回任务池`)
      }
      case 'board': {
        const s = board.snapshot()
        const lanes: Array<[string, string]> = [
          ['pending_approval', '待批准'], ['pending', '待认领'], ['claimed', '已认领'],
          ['running', '进行中'], ['blocked', '阻塞'], ['done', '完成'], ['failed', '失败'],
        ]
        const text = lanes.map(([k, label]) => {
          const tasks = s.lanes[k as keyof typeof s.lanes]
          return `## ${label}（${tasks.length}）\n${tasks.map(t => fmtTask(t)).join('\n') || '（空）'}`
        }).join('\n\n')
        return ok(`📌 团队看板（共 ${s.total}）：\n\n${text}`)
      }
      default:
        return fail(`未知 action: ${action}`)
    }
  } catch (e: any) {
    return fail(`任务板操作失败: ${e?.message || e}`)
  }
}

// ═══════════════════════════════════════════════════════════
// hire_worker
// ═══════════════════════════════════════════════════════════

export const hireWorkerDef: ToolDef = {
  name: 'hire_worker',
  description: `临时雇佣后台 worker 并行干活，干完自动解散（对标 cc-haha TeamCreate）。
工种 role：
- research 研究员：多源调研、资料交叉验证（可联网）
- search 检索员：多引擎网页搜集（可联网）
- data 数据员：数据清洗、统计、脚本分析
- code 工程员：写代码/修 bug/跑测试
- review 复核员：只看不改的正确性/风险审查（更深的多视角审查用 adversarial_review）
- test 测试员：编写/运行测试
- general 协作者：通用杂活
两种用法：
1. 单个：role + task
2. 多个并行：jobs 传 JSON 数组，每项 {role, task, title}
v3.30 增强：
- 工种也支持 agents/*.md 里定义的自定义工种（先 team_roles 查看）；
- code 工程员自动开 git worktree 隔离，成功自动合并回当前分支、失败保留现场；
- 研究/检索/数据/通用杂活自动用小模型降本（tier 可覆盖）；
- keep_alive=true 时 worker 干完进入 idle 待命，用 worker_control 唤醒/解散。
用户只与 Lumina 对话；结果由你汇总后出口。`,
  params: {
    role: { type: 'string', description: '单个任务时的工种（内置或 agents/*.md 自定义 id）', required: false },
    task: { type: 'string', description: '单个任务描述', required: false },
    title: { type: 'string', description: '单个任务标题', required: false },
    path: { type: 'string', description: 'code 工种的 worktree 根目录（默认当前项目）', required: false },
    tier: { type: 'string', description: '强制模型分级 small/strong（可选）', required: false },
    jobs: { type: 'string', description: '多个任务：JSON 数组 [{role, task, title, path, tier}]', required: false },
    keep_alive: { type: 'boolean', description: 'true 时干完不解散、进入 idle 待命（默认 false）', required: false },
  },
  toolsets: ['team', 'agent', 'developer'],
  dangerous: true,
}

export async function hireWorker(args: Record<string, any>): Promise<ToolResult> {
  const known = allRoleIds()
  const jobs: JobSpec[] = []
  if (args.jobs) {
    try {
      const parsed = typeof args.jobs === 'string' ? JSON.parse(args.jobs) : args.jobs
      if (!Array.isArray(parsed)) {throw new Error('jobs 必须是数组')}
      for (const j of parsed) {
        if (!j?.task) {throw new Error('每个 job 必须包含 task')}
        const role = String(j.role || 'general')
        if (!known.includes(role)) {throw new Error(`未知工种: ${role}`)}
        jobs.push({
          role,
          task: String(j.task),
          title: j.title ? String(j.title) : undefined,
          path: j.path ? String(j.path) : undefined,
          tier: j.tier === 'small' || j.tier === 'strong' ? j.tier : undefined,
        })
      }
    } catch (e: any) {
      return fail(`jobs 解析失败: ${e?.message}`)
    }
  } else {
    if (!args.task) {return fail('请提供 task，或用 jobs 传多个任务')}
    const role = String(args.role || 'general')
    if (!known.includes(role)) {
      return fail(`未知工种: ${role}，内置 ${VALID_ROLES().join('/')}，自定义 ${getAgentMarkdownRegistry().list().map(a => a.id).join('/') || '(无)'}`)
    }
    jobs.push({
      role, task: String(args.task),
      title: args.title ? String(args.title) : undefined,
      path: args.path ? String(args.path) : undefined,
      tier: args.tier === 'small' || args.tier === 'strong' ? args.tier : undefined,
    })
  }
  if (jobs.length === 0) {return fail('没有有效任务')}
  if (jobs.length > 6) {return fail('一次最多并行 6 个 worker，避免资源争抢')}

  try {
    const results = await hireAndRun(jobs, { keepAlive: !!args.keep_alive })
    const mdRegistry = getAgentMarkdownRegistry()
    const iconOf = (role: string) => ROLE_SPECS[role]?.icon || mdRegistry.get(role)?.icon || '👷'
    return formatHireResult(results, listDynamicWorkers().length, iconOf)
  } catch (e: any) {
    return fail(`雇佣 worker 失败: ${e?.message || e}`)
  }
}

/** 列出可用工种（内置 + agents/*.md 自定义） */
export function listRoles(): string {
  const builtin = Object.entries(ROLE_SPECS).map(([id, s]) => `${s.icon} ${id}（${s.name}）`).join('\n')
  const custom = getAgentMarkdownRegistry().list()
    .map(a => `${a.icon} ${a.id}（${a.name}，${a.modelTier === 'small' ? '小模型' : '主力模型'}）`).join('\n')
  return `🧑‍🔧 内置工种：\n${builtin}\n${custom ? `\n📝 自定义工种（agents/*.md，热加载）：\n${custom}` : ''}`
}

// ═══════════════════════════════════════════════════════════
// adversarial_review
// ═══════════════════════════════════════════════════════════

export const adversarialReviewDef: ToolDef = {
  name: 'adversarial_review',
  description: `对抗式评审团：派多个持不同怀疑视角的评审员独立挑刺，多数票判定 + 高危一票否决，
再由完整性批评员专查评审遗漏。默认三视角：正确性 / 安全 / 可复现。
适用于：代码改动验收、方案/架构评审、重要事实声明核验、发布前检查。
比单次 code_review 更严格（不是一个人说行就行）。`,
  params: {
    target: { type: 'string', description: '待评审内容（代码、diff、方案、声明）', required: true },
    perspectives: { type: 'string', description: '自定义视角：JSON 数组 [{id,name,lens}]，不传用默认三视角', required: false },
    no_critic: { type: 'boolean', description: 'true 时跳过完整性批评员', required: false },
    author_role: { type: 'string', description: '被审内容的作者工种（如 code）；不通过时问题会写进该工种的易错档案，下次开工自动提醒', required: false },
  },
  toolsets: ['team', 'agent', 'developer'],
  dangerous: true,
}

export async function adversarialReview(args: Record<string, any>): Promise<ToolResult> {
  const target = String(args.target || '').trim()
  if (!target) {return fail('缺少待评审内容 target')}
  if (target.length > 30_000) {
    return fail(`评审内容过长（${target.length} 字符），请压缩到 30000 字符以内（或先委托 Yak 摘要）`)
  }
  try {
    let perspectives = DEFAULT_PERSPECTIVES
    if (args.perspectives) {
      try {
        const parsed = typeof args.perspectives === 'string' ? JSON.parse(args.perspectives) : args.perspectives
        if (Array.isArray(parsed) && parsed.length >= 2 && parsed.every(p => p?.id && p?.name && p?.lens)) {
          perspectives = parsed
        }
      } catch {
        return fail('perspectives 解析失败：需为 JSON 数组 [{id,name,lens}]')
      }
    }
    const report = await runAdversarialReview(target, {
      perspectives,
      completenessCritic: args.no_critic !== true,
      timeoutMs: 180_000,
    })
    // v3.33 不通过的问题写进作者工种易错档案（热茶的批评被团队记住）
    if (args.author_role && !report.pass) {
      const n = getWorkerStats().recordReview(String(args.author_role), report.findings.map(f => f.text))
      if (n) {
        return ok(`${formatReviewReport(report)}\n\n📝 已把 ${n} 个问题记入 ${args.author_role} 工种易错档案，下次开工自动提醒。`)
      }
    }
    return ok(formatReviewReport(report))
  } catch (e: any) {
    return fail(`对抗式评审失败: ${e?.message || e}`)
  }
}

// ═══════════════════════════════════════════════════════════
// git_worktree
// ═══════════════════════════════════════════════════════════

export const gitWorktreeDef: ToolDef = {
  name: 'git_worktree',
  description: `为并行任务创建/管理隔离工作区（git worktree），让多个 worker 改代码互不踩文件。
- action=create：在项目目录下创建隔离工作区，返回 workdir（交给 worker 用）。
- action=list：列出该项目的全部 worktree。
- action=remove：移除隔离工作区（force=true 丢弃未提交改动）。
- action=merge：把隔离分支合并回主分支（默认 main，可用 target 指定）。
非 git 仓库时 create 会降级为临时目录。`,
  params: {
    action: { type: 'string', description: 'create/list/remove/merge', required: true },
    path: { type: 'string', description: '项目目录（create/list/merge 时）', required: false },
    name: { type: 'string', description: '任务名/标识（create 时）', required: false },
    workdir: { type: 'string', description: '要移除的工作区路径（remove 时）', required: false },
    branch: { type: 'string', description: 'worktree 分支名（remove 时校验用）', required: false },
    target: { type: 'string', description: 'merge 目标分支（默认 main）', required: false },
    force: { type: 'boolean', description: 'remove 时强制丢弃改动', required: false },
  },
  toolsets: ['team', 'agent', 'developer'],
}

export async function gitWorktree(args: Record<string, any>): Promise<ToolResult> {
  const action = String(args.action || '').trim()
  try {
    if (action === 'create') {
      const basePath = String(args.path || process.cwd())
      const name = String(args.name || `task_${Date.now()}`)
      const handle = await createWorktree(basePath, name)
      return ok(
        `🌿 已创建隔离工作区：${handle.workdir}\n` +
        (handle.isGit ? `类型：git worktree，分支：${handle.branch || '(detached)'}` : '类型：非 git 仓库，降级为临时目录') +
        '\n把该 workdir 交给 worker 作为工作目录；验收通过后用 action=merge 合并。',
      )
    }
    if (action === 'list') {
      const basePath = String(args.path || process.cwd())
      const list = await listWorktrees(basePath)
      if (list.length === 0) {return ok('该目录没有 worktree（或不是 git 仓库）')}
      return ok(`🌿 worktree 列表：\n${list.map(w => `- ${w.path} ${w.branch ? `[${w.branch}]` : '[detached]'}`).join('\n')}`)
    }
    if (action === 'remove') {
      if (!args.workdir) {return fail('remove 缺少 workdir')}
      const removed = await removeWorktree({
        workdir: String(args.workdir),
        name: String(args.name || 'task'),
        isGit: true,
        branch: args.branch ? String(args.branch) : null,
      }, !!args.force)
      return ok(removed ? '🗑️ 已移除隔离工作区' : '移除失败（可能有未提交改动，加 force=true 强制）')
    }
    if (action === 'merge') {
      if (!args.workdir || !args.branch) {return fail('merge 需要 workdir 与 branch')}
      const r = await mergeWorktree({
        workdir: String(args.workdir),
        name: String(args.name || 'task'),
        isGit: true,
        branch: String(args.branch),
      }, String(args.target || 'main'))
      return r.ok ? ok(`🔀 ${r.message}`) : fail(r.message)
    }
    return fail(`未知 action: ${action}`)
  } catch (e: any) {
    return fail(`worktree 操作失败: ${e?.message || e}`)
  }
}

// ═══════════════════════════════════════════════════════════
// v3.30: team_roles / worker_control
// ═══════════════════════════════════════════════════════════

export const teamRolesDef: ToolDef = {
  name: 'team_roles',
  description: '列出可雇佣的全部工种：内置 7 种 + agents/*.md 自定义工种（文件热加载，改了立即生效）。',
  params: {},
  toolsets: ['team', 'agent', 'developer'],
}

export async function teamRoles(_args: Record<string, any>): Promise<ToolResult> {
  return ok(listRoles())
}

export const workerControlDef: ToolDef = {
  name: 'worker_control',
  description: `管理 hire_worker(keep_alive=true) 留在场的待命 worker。
- action=list：列出 worker（id/工种/状态 idle|working|shutdown_requested/模型分级/工作目录）。
- action=wake：唤醒 idle worker 执行新任务（id+task），省掉重新雇佣。
- action=shutdown：关停握手——idle 立即解散；working 标记 shutdown_requested，手头活结束自动下线。`,
  params: {
    action: { type: 'string', description: 'list / wake / shutdown', required: true },
    id: { type: 'string', description: 'worker id（wake/shutdown 时）', required: false },
    task: { type: 'string', description: 'wake 时的新任务', required: false },
  },
  toolsets: ['team', 'agent', 'developer'],
  dangerous: true,
}

export async function workerControl(args: Record<string, any>): Promise<ToolResult> {
  const action = String(args.action || 'list')
  try {
    if (action === 'list') {
      const ws = listDynamicWorkers()
      if (!ws.length) {return ok('当前没有留场 worker')}
      return ok(`🧑‍🔧 留场 worker（${ws.length}）：\n${ws.map(w =>
        `- ${w.id} ${w.icon} ${w.name}（${w.role}）状态=${w.state} 模型=${w.modelTier}${w.model ? `:${w.model}` : ''}${w.workdir ? ` 工作区=${w.workdir}` : ''}`).join('\n')}`)
    }
    if (action === 'wake') {
      if (!args.id || !args.task) {return fail('wake 需要 id 和 task')}
      const result = await wakeWorker(String(args.id), String(args.task))
      return ok(`🔔 唤醒结果：\n${String(result).slice(0, 2000)}`)
    }
    if (action === 'shutdown') {
      if (!args.id) {return fail('shutdown 需要 id')}
      const r = requestShutdown(String(args.id))
      return r.ok ? ok(`🛑 ${r.message}（deferred=${r.deferred}）`) : fail(r.message)
    }
    return fail(`未知 action: ${action}`)
  } catch (e: any) {
    return fail(`worker_control 失败: ${e?.message || e}`)
  }
}

// ═══════════════════════════════════════════════════════════
// v3.30 P2: workflow（模型现写 JSON DSL 脚本）
// ═══════════════════════════════════════════════════════════

export const workflowDef: ToolDef = {
  name: 'workflow',
  description: `多步骤团队工作流（你写 JSON DSL，确定性调度器执行，安全不 eval 代码）。
- action=run：启动工作流。spec 为 JSON：{"name","mode":"pipeline|parallel","steps":[...]}
  每步 {"id","role","task","after":["上一步id"]}；任务文本里用 $id.result 引用上游结果。
  pipeline 按 after 分层执行；parallel 尽量并行（上限 concurrency=4）。
  v3.31 条件："when":{"step":"上一步id","op":"contains|equals|truthy","value":"期望","not":false}
    —— 引用步骤结果不满足时本步骤自动 skipped（其下游一并跳过）；when.step 自动算作依赖，无需再写 after。
  v3.31 有界重试："retry":{"maxAttempts":3,"until":{"op":"contains","value":"成功"},"delayMs":400}
    —— 异常或结果不满足 until 都会重试，最多 5 次，避免无限重试。
  journal 持久化，崩溃后 action=resume 跳过已完成步骤继续。
- action=resume：按 id 续跑（id 在 run 的返回里）。
- action=list：查看工作流与各步骤状态。
- action=get：查看单个工作流明细。
步骤最多 20 步；role 与 hire_worker 相同（内置/自定义工种）。`,
  params: {
    action: { type: 'string', description: 'run / resume / list / get', required: true },
    spec: { type: 'string', description: 'run 时的工作流 JSON（字符串）', required: false },
    id: { type: 'string', description: 'resume/get 时的工作流 id', required: false },
  },
  toolsets: ['team', 'agent', 'developer'],
  dangerous: true,
}

/** 生产执行器：每步雇一个对应工种 worker，干完即散 */
function defaultExecutor(): StepExecutor {
  return async (step, preparedTask) => {
    const w = await hireDynamicWorker({
      role: step.role || 'general',
      maxToolCalls: 16,
      ...(step.role === 'code' ? { basePath: process.cwd() } : {}),
    })
    try {
      const result = await runDynamicWorker(w, preparedTask, step.timeoutMs || 6 * 60_000)
      return { workerId: w.id, result }
    } finally {
      if (listDynamicWorkers().some(x => x.id === w.id)) {dismissDynamicWorker(w.id)}
    }
  }
}

function formatJournal(j: WorkflowJournal): string {
  const steps = j.def.steps.map((s: any) => {
    const r = j.steps[s.id]
    const icon = r?.status === 'done' ? '✅' : r?.status === 'failed' ? '❌' : r?.status === 'skipped' ? '⏭️' : r?.status === 'running' ? '🔄' : '⬜'
    const deps = [...(s.after || []), ...(s.when?.step ? [s.when.step] : [])]
    const dep = deps.length ? ` 依赖[${deps.join(',')}]` : ''
    const cond = s.when ? ` when=${s.when.op}${s.when.not ? '(not)' : ''}` : ''
    const retry = s.retry ? ` retry×${s.retry.maxAttempts || 2}` : ''
    const tries = r?.attempts && r.attempts > 1 ? `（第${r.attempts}次尝试）` : ''
    return `${icon} ${s.id}（${s.role || 'general'}）${dep}${cond}${retry} ${r?.status || 'pending'}${tries}`
  }).join('\n')
  return `🧶 ${j.name} [${j.id}] 状态=${j.status} 模式=${j.mode}\n${steps}${j.error ? `\n⚠️ ${j.error}` : ''}`
}

export async function workflow(args: Record<string, any>): Promise<ToolResult> {
  const action = String(args.action || 'list')
  const store = getWorkflowStore()
  try {
    if (action === 'run') {
      if (!args.spec) {return fail('run 缺少 spec（工作流 JSON）')}
      let def: WorkflowDef
      try {
        const parsed = typeof args.spec === 'string' ? JSON.parse(args.spec) : args.spec
        const v = validateWorkflow(parsed)
        if (!v.ok) {return fail(`工作流校验失败：${v.errors.join('；')}`)}
        def = v.def!
      } catch (e: any) {
        return fail(`spec 解析失败：${e?.message}`)
      }
      const journal = store.create(def)
      const j = await runJournal(journal, defaultExecutor(), {
        onPersist: () => {try {store.save(journal)} catch { /* ignore */ }},
      })
      store.save(j)
      // 汇总每步结果
      const results = j.def.steps.map(s => {
        const r = j.steps[s.id]
        return `【${s.id}】${r.status}${r.status === 'done' ? `：${String(r.result || '').slice(0, 600)}` : r.error ? `：${r.error}` : ''}`
      }).join('\n\n')
      return ok(`${formatJournal(j)}\n\n结果：\n${results}`)
    }
    if (action === 'resume') {
      if (!args.id) {return fail('resume 缺少 id')}
      const j = store.get(String(args.id))
      if (!j) {return fail(`工作流 ${args.id} 不存在`)}
      await runJournal(j, defaultExecutor(), {
        onPersist: () => {try {store.save(j)} catch { /* ignore */ }},
      })
      store.save(j)
      return ok(formatJournal(j))
    }
    if (action === 'list') {
      const list = store.list()
      if (!list.length) {return ok('暂无工作流')}
      return ok(list.slice(0, 20).map(formatJournal).join('\n\n'))
    }
    if (action === 'get') {
      if (!args.id) {return fail('get 缺少 id')}
      const j = store.get(String(args.id))
      if (!j) {return fail(`工作流 ${args.id} 不存在`)}
      return ok(formatJournal(j))
    }
    return fail(`未知 action: ${action}`)
  } catch (e: any) {
    return fail(`workflow 失败: ${e?.message || e}`)
  }
}

// ═══════════════════════════════════════════════════════════
// v3.30 P2 / v3.31: teach（演示一次，沉淀成可回放技能）
// ═══════════════════════════════════════════════════════════

/**
 * 回放一条课程（agent 工具与 UI IPC 共用）。
 * 每步走 executeCuAction：会话锁 / 权限门 / 真人介入保护全部生效。
 */
export async function replayLesson(lesson: Lesson): Promise<{
  ok: boolean
  steps: number
  messages: string[]
  stoppedReason?: string
}> {
  const actions = eventsToActions(lesson.events, lesson.screenW, lesson.screenH, {
    aggregateTyping: !!lesson.aggregateTyping,
  })
  if (!actions.length) {return { ok: false, steps: 0, messages: [], stoppedReason: '课程没有可回放的动作' }}
  const sessionId = `teach_${Date.now()}`
  let locked = false
  try {locked = acquireCuSession(sessionId, `teach replay ${lesson.id}`)} catch { /* ignore */ }
  const messages: string[] = []
  let stoppedReason: string | undefined
  // v3.33 CU 三人组：操作员=回放动作，安全员=cuPermissions（denied），观察员=每步 dHash 核对
  let crew = newCrewState()
  try {
    for (const a of actions as ConvertedAction[]) {
      // 每步前按当前屏幕取视图（归一化坐标天然自适应；多屏取虚拟原点）
      const shot: CuScreen = await captureScreen({ sessionId })
      const r = await executeCuAction(a as any, { imgW: shot.w, imgH: shot.h, vx: shot.vx || 0, vy: shot.vy || 0 }, { sessionId })
      messages.push(r.msg)
      const verdict = crewStep(crew, {
        actionKind: actionKindOf((a as any).action_type),
        denied: r.denied,
        denyReason: r.denyReason,
        ok: r.ok,
        // verified=false 时 changed 为 undefined，观察员不裁决（策略关闭即不拦）
        changed: r.verified ? r.changed : undefined,
      })
      crew = verdict.state
      if (verdict.verdict === 'abort') {stoppedReason = verdict.reason; break}
      if (verdict.verdict === 'reobserve') {
        // 观察员要求重看：重新截图再继续下一个动作（本动作已成功，不重复执行）
        await captureScreen({ sessionId }).catch(() => null)
      }
      await new Promise(res => setTimeout(res, 350))
    }
  } finally {
    if (locked) {try {releaseCuSession(sessionId)} catch { /* ignore */ }}
  }
  if (!stoppedReason) {messages.push(formatCrewReport(crew))}
  return { ok: !stoppedReason, steps: actions.length, messages, stoppedReason }
}

export const teachDef: ToolDef = {
  name: 'teach',
  description: `录制/回放「演示一次」的桌面操作技能（Windows）。
- action=record：开始录制鼠标点击/拖拽/滚轮/组合键；用户操作完按 F8 结束。
- action=stop：结束录制并保存为课程（name 必填，可带 description；aggregate_typing=true 时把连续打字聚合成文本回放）。
- action=list：列出已沉淀课程。
- action=replay：按 id 回放，坐标按当前屏幕自动缩放，回放受会话锁/审批/真人中止保护。
- action=remove：删除课程。
适合：每天重复的固定点击流程（导出报表、签到、切换固定设置）。注意不要在密码框录制。`,
  params: {
    action: { type: 'string', description: 'record / stop / list / replay / remove', required: true },
    name: { type: 'string', description: 'stop 时保存的课程名', required: false },
    description: { type: 'string', description: '课程说明', required: false },
    id: { type: 'string', description: 'replay/remove 时的课程 id', required: false },
    aggregate_typing: { type: 'boolean', description: 'stop 时是否把连续打字聚合成文本（默认 false）', required: false },
  },
  toolsets: ['team', 'agent', 'desktop', 'computer_use'],
  dangerous: true,
}

export async function teach(args: Record<string, any>): Promise<ToolResult> {
  const action = String(args.action || 'list')
  const recorder = getTeachRecorder()
  const lessons = getLessonStore()
  try {
    if (action === 'record') {
      const r = recorder.start()
      return r.ok ? ok(`⏺️ ${r.message}（录制中…）`) : fail(r.message)
    }
    if (action === 'stop') {
      if (!args.name) {return fail('stop 缺少 name（课程名）')}
      const r = await recorder.stop()
      if (!r.ok || !r.events) {return fail(r.message || '录制结束失败')}
      // 录制屏幕尺寸：用当前截图尺寸（与回放坐标系一致）
      const shot = await captureScreen({})
      const lesson = lessons.save({
        name: String(args.name),
        description: args.description ? String(args.description) : '',
        events: r.events,
        screenW: shot.w,
        screenH: shot.h,
        aggregateTyping: !!args.aggregate_typing,
      })
      const converted = eventsToActions(r.events, shot.w, shot.h, { aggregateTyping: !!args.aggregate_typing })
      return ok(`⏹️ 已沉淀课程「${lesson.name}」id=${lesson.id}，录制 ${r.events.length} 个事件 → ${converted.length} 个动作`)
    }
    if (action === 'list') {
      const list = lessons.list()
      if (!list.length) {return ok('暂无已沉淀课程')}
      return ok(`📚 课程（${list.length}）：\n${list.map(l =>
        `- ${l.id} 「${l.name}」${l.description ? ` ${l.description}` : ''}（${l.eventCount} 事件，${new Date(l.createdAt).toLocaleString()}）`).join('\n')}`)
    }
    if (action === 'replay') {
      if (!args.id) {return fail('replay 缺少 id')}
      const lesson = lessons.get(String(args.id))
      if (!lesson) {return fail(`课程 ${args.id} 不存在`)}
      const r = await replayLesson(lesson)
      if (r.steps === 0) {return fail(r.stoppedReason || '课程没有可回放的动作')}
      const head = r.ok ? `▶️ 回放课程「${lesson.name}」完成（${r.steps} 步）` : `▶️ 回放课程「${lesson.name}」中止（${r.messages.length}/${r.steps} 步）`
      return ok(`${head}：\n${r.messages.join('\n')}${r.stoppedReason ? `\n⛔ ${r.stoppedReason}` : ''}`)
    }
    if (action === 'remove') {
      if (!args.id) {return fail('remove 缺少 id')}
      return lessons.remove(String(args.id)) ? ok('🗑️ 已删除课程') : fail('课程不存在')
    }
    return fail(`未知 action: ${action}`)
  } catch (e: any) {
    return fail(`teach 失败: ${e?.message || e}`)
  }
}

// ═══════════════════════════════════════════════════════════
// v3.33: team_stats（绩效画像 / 派活路由 / 任务级追踪 / 自治状态）
// ═══════════════════════════════════════════════════════════

export const teamStatsDef: ToolDef = {
  name: 'team_stats',
  description: `查看团队成长与运行追踪（v3.33）。
- action=profiles：各工种绩效画像（累计单数、成功率、平均耗时、高频易错点、经验卡数）。
- action=rank：给定 kind（research/search/data/code/review/test），按历史表现给出工种排序，派活前先问它。
- action=trace：任务级追踪（最近任务来源/耗时/成败/长任务；不是 token 级计费日志）。
- action=autonomy：内驱力自领取状态（是否运行、在飞任务数、累计自领取次数）。
- action=cards：查看某工种的经验卡全文（role 必填）。`,
  params: {
    action: { type: 'string', description: 'profiles / rank / trace / autonomy / cards', required: true },
    kind: { type: 'string', description: 'rank 时的任务类型', required: false },
    role: { type: 'string', description: 'cards 时的工种', required: false },
    limit: { type: 'number', description: 'trace 返回条数（默认 20）', required: false },
  },
  toolsets: ['team', 'agent', 'developer'],
}

const KIND_CANDIDATES: Record<string, string[]> = {
  research: ['research', 'general'],
  search: ['search', 'research', 'general'],
  data: ['data', 'general'],
  code: ['code', 'test'],
  test: ['test', 'code'],
  review: ['review', 'test'],
  other: ['general'],
}

export async function teamStats(args: Record<string, any>): Promise<ToolResult> {
  const action = String(args.action || 'profiles')
  const stats = getWorkerStats()
  try {
    if (action === 'profiles') {return ok(formatProfiles(stats.getState()))}
    if (action === 'cards') {
      if (!args.role) {return fail('cards 缺少 role')}
      const p = stats.getProfile(String(args.role))
      if (!p || !p.cards.length) {return ok(`工种 ${args.role} 还没有经验卡`)}
      return ok(`🗃️ ${args.role} 的经验卡（${p.cards.length}）：\n` +
        p.cards.slice().reverse().map(c => `· [${c.source}] ${c.title}\n  ${c.body}`).join('\n'))
    }
    if (action === 'rank') {
      const kind = String(args.kind || 'other')
      const candidates = KIND_CANDIDATES[kind] || KIND_CANDIDATES.other
      const ranked = rankRolesForKind(stats.getState(), candidates)
      const text = ranked.map((r, i) =>
        `${i + 1}. ${r.role} 得分 ${r.score.toFixed(2)}${r.fresh ? '（新工种，无履历，中性分）' : ''}`).join('\n')
      return ok(`🎯 ${kind} 任务的工种推荐顺序：\n${text}`)
    }
    if (action === 'trace') {
      const limit = Number(args.limit) || 20
      const trace = getTaskTrace()
      const entries = trace.list(limit)
      if (!entries.length) {return ok('暂无任务追踪记录')}
      const s = trace.summary()
      const lines = entries.map(e =>
        `${e.phase === 'start' ? '▶️' : (e.ok ? '✅' : '❌')} ${new Date(e.at).toLocaleTimeString()} ` +
        `[${e.source}/${e.role}] ${e.title}${e.phase === 'end' ? ` ${Math.round((e.durationMs || 0) / 1000)}s` : ''}${e.longRunning ? ' ⏱️长任务' : ''}`)
      return ok(`🔎 任务追踪（累计 ${s.total} 完成，${s.ok} 成功 / ${s.fail} 失败，在飞 ${s.running}，长任务 ${s.longRunning}，均时 ${Math.round(s.avgDurationMs / 1000)}s）：\n${lines.join('\n')}`)
    }
    if (action === 'autonomy') {
      const st = getTeamAutonomy().status()
      if (!st.running) {return ok('🧭 内驱力自领取未运行（留场 worker 只等显式派活）')}
      return ok(`🧭 自领取运行中：在飞 ${st.inFlight}/${st.maxConcurrent}，累计自领取 ${st.totalClaims} 次，轮询周期 ${Math.round(st.intervalMs / 1000)}s`)
    }
    return fail(`未知 action: ${action}`)
  } catch (e: any) {
    return fail(`team_stats 失败: ${e?.message || e}`)
  }
}

// ═══════════════════════════════════════════════════════════
// v3.33: team_autonomy（开关内驱力自领取）
// ═══════════════════════════════════════════════════════════

export const teamAutonomyDef: ToolDef = {
  name: 'team_autonomy',
  description: `开关「内驱力自领取」：开启后，keep_alive 留在场的 idle worker 会按工种责任心
（越闲越主动，抖动轮询、全局并发帽 2）自己到任务板认领匹配的活，不用逐个派活。
- action=start（默认）/ stop / status；interval_ms、max_concurrent 可选。
自定义工种与一次性 worker 不自动揽活。`,
  params: {
    action: { type: 'string', description: 'start / stop / status', required: false },
    interval_ms: { type: 'number', description: '轮询周期（毫秒，默认 30000，带 ±35% 抖动）', required: false },
    max_concurrent: { type: 'number', description: '自治任务并发帽（默认 2）', required: false },
  },
  toolsets: ['team', 'agent', 'developer'],
}

export async function teamAutonomy(args: Record<string, any>): Promise<ToolResult> {
  const action = String(args.action || 'start')
  const auto = getTeamAutonomy()
  if (action === 'stop') {
    auto.stop()
    return ok('🧭 已停止内驱力自领取（已在跑的任务不受影响）')
  }
  if (action === 'status') {
    const st = auto.status()
    return ok(st.running
      ? `运行中：在飞 ${st.inFlight}/${st.maxConcurrent}，累计自领取 ${st.totalClaims} 次`
      : '未运行')
  }
  auto.start({
    intervalMs: Number(args.interval_ms) || undefined,
    maxConcurrent: Number(args.max_concurrent) || undefined,
  })
  return ok('🧭 内驱力自领取已启动：留场 idle 成员会自己到任务板找匹配的活')
}

// ═══════════════════════════════════════════════════════════
// v3.33: team_log（团队日记）
// ═══════════════════════════════════════════════════════════

export const teamLogDef: ToolDef = {
  name: 'team_log',
  description: `团队日记（v3.33）：把一天的任务板事件、任务追踪、工种成长剪成「团队日记」。
- action=today（默认）/ yesterday / date（date=YYYY-MM-DD）；action=recent 列出最近 n 天（默认 7）。
写入后缓存，可用于晚安/晚会回顾。`,
  params: {
    action: { type: 'string', description: 'today / yesterday / date / recent', required: false },
    date: { type: 'string', description: 'date 时的日期 YYYY-MM-DD', required: false },
    days: { type: 'number', description: 'recent 时的天数（默认 7）', required: false },
  },
  toolsets: ['team', 'agent', 'developer'],
}

function resolveDigestDate(args: Record<string, any>): Date {
  const action = String(args.action || 'today')
  const d = new Date()
  if (action === 'yesterday') {d.setDate(d.getDate() - 1)}
  if (action === 'date' && args.date) {
    const [y, m, day] = String(args.date).split('-').map(Number)
    if (y && m && day) {return new Date(y, m - 1, day, 12)}
  }
  return d
}

export async function teamLog(args: Record<string, any>): Promise<ToolResult> {
  const action = String(args.action || 'today')
  const store = getDailyLog()
  try {
    if (action === 'recent') {
      const recent = store.recent(Number(args.days) || 7)
      if (!recent.length) {return ok('还没有团队日记缓存（先查一次 today 生成）')}
      return ok(recent.map(d => `## ${d.date}\n${d.lines.join(' ')}`).join('\n\n'))
    }
    const date = resolveDigestDate(args)
    const { key } = dayRange(date)
    const cached = store.get(key)
    if (cached && action !== 'today') {return ok(cached.markdown)}
    // 现算：任务板历史 + trace + 画像 + 自治计数
    const events = getSharedBoard().getHistory()
    const traces = getTaskTrace().list(5000).slice().reverse()
    const autonomyCount = getTeamAutonomy().status().totalClaims
    const digest = buildDigest(
      { events, traces, stats: getWorkerStats().getState(), autonomousClaims: autonomyCount },
      date,
    )
    store.save(digest)
    return ok(digest.markdown)
  } catch (e: any) {
    return fail(`team_log 失败: ${e?.message || e}`)
  }
}

// ═══════════════════════════════════════════════════════════
// v3.33: team_checkpoint（整轮 Diff 检查点 / 一键回滚）
// ═══════════════════════════════════════════════════════════

export const teamCheckpointDef: ToolDef = {
  name: 'team_checkpoint',
  description: `团队代码任务的整轮检查点（v3.33，对标 cc-haha 整轮 Diff 可撤销）。
code worker 的 worktree 合并前会自动拍点，合并后不满意可回滚。
- action=list：列出最近检查点（id / 时间 / 关联 / 分支 / 合并前 HEAD）。
- action=create：手动给当前项目拍点（ref 说明）。
- action=rollback：按 id 回滚（危险！必须显式 confirm=true，会 git reset --hard 丢弃检查点之后的提交）。
非 git 仓库不支持。`,
  params: {
    action: { type: 'string', description: 'list / create / rollback', required: true },
    id: { type: 'string', description: 'rollback 时的检查点 id', required: false },
    ref: { type: 'string', description: 'create 时的说明', required: false },
    path: { type: 'string', description: '项目目录（默认当前目录）', required: false },
    confirm: { type: 'boolean', description: 'rollback 必须传 true', required: false },
  },
  toolsets: ['team', 'agent', 'developer'],
  dangerous: true,
}

export async function teamCheckpoint(args: Record<string, any>): Promise<ToolResult> {
  const action = String(args.action || 'list')
  const store = getCheckpointStore()
  try {
    if (action === 'list') {
      const list = store.list()
      if (!list.length) {return ok('还没有检查点（code worker 合并 worktree 时会自动拍点）')}
      return ok(`📸 检查点（最近 ${list.length}）：\n` + list.slice(0, 15).map(c =>
        `- ${c.id} ${new Date(c.at).toLocaleString()} 「${c.ref}」 ${c.branch}@${c.head.slice(0, 8)}` +
        `${c.mergedHead ? ` → 合并后 ${c.mergedHead.slice(0, 8)}` : ''}`).join('\n'))
    }
    if (action === 'create') {
      const r = await createCheckpoint(String(args.path || process.cwd()), String(args.ref || 'manual'))
      if ('isGit' in r) {return fail('当前目录不是 git 仓库，无法拍检查点')}
      return ok(`📸 已拍检查点 ${r.id}：${r.branch}@${r.head.slice(0, 8)}（${r.ref}）`)
    }
    if (action === 'rollback') {
      if (!args.id) {return fail('rollback 缺少 id')}
      if (!args.confirm) {return fail('回滚会丢弃检查点之后的提交，确认时必须显式传 confirm=true')}
      const cp = store.get(String(args.id))
      if (!cp) {return fail(`检查点 ${args.id} 不存在`)}
      const r = await rollbackCheckpoint(cp, true)
      return r.ok ? ok(`⏪ ${r.message}`) : fail(r.message)
    }
    return fail(`未知 action: ${action}`)
  } catch (e: any) {
    return fail(`team_checkpoint 失败: ${e?.message || e}`)
  }
}
