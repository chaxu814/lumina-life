// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// teamPolicy.ts — 关系进调度 / 聊天式审批 (v3.33)
//
// 同类项目的派单只看工种与负载；Lumina 让「关系」成为真实调度变量：
//   - 信任双签：某工种历史信任低（常搞砸/常和复核吵架），其交付必须加一道复核
//   - 聊天式审批：requireApproval 任务创建时，由创建者用自己的语气在信箱
//     @Lumina 申请批准，Lumina/用户回复即批准，审批本身进入关系演化
//
// 纯函数可单测；信箱通知为副作用函数。
// ============================================================

import { getRelationshipStore } from '../agentRelationships'
import { getTeamMailbox } from './teamMailbox'
import type { BoardTask } from './teamSharedBoard'

/** 角色在关系系统里的稳定 id（临时工实例易逝，信任按工种累积） */
export function roleActorId(role: string): string {
  return `role:${role}`
}

/** 两个成员之间的信任分（0~100）；无关系记录返回中性 50 */
export function trustBetween(a: string, b: string): number {
  const key = [a, b].sort().join('-')
  const rel = getRelationshipStore().getAll().find(r => r.pairKey === key)
  return rel ? rel.trust : 50
}

/**
 * 交付是否需要「双签」（加一道额外复核）。
 * 规则：作者工种与复核员（热茶/recha）之间信任低于阈值 → 双签；
 * 显式 force=true（高危任务）也双签。
 */
export function needsDoubleReview(opts: {
  authorRole: string
  reviewer?: string
  threshold?: number
  force?: boolean
}): { needed: boolean; reason: string; trust: number } {
  if (opts.force) {
    return { needed: true, reason: '高危任务强制双签', trust: -1 }
  }
  const reviewer = opts.reviewer || 'recha'
  const threshold = opts.threshold ?? 60
  const trust = trustBetween(roleActorId(opts.authorRole), reviewer)
  if (trust < threshold) {
    return {
      needed: true,
      reason: `${opts.authorRole} 与 ${reviewer} 的信任分 ${trust} < ${threshold}，交付需双签复核`,
      trust,
    }
  }
  return { needed: false, reason: `信任分 ${trust} ≥ ${threshold}，单签即可`, trust }
}

/**
 * 纯函数：给定候选工种与各自信任分，选出该派谁。
 * 信任过低（< minTrust）的候选直接排除；其余按信任排序。
 */
export function pickByTrust(
  candidates: Array<{ role: string; trust?: number }>,
  minTrust = 40,
): { role: string; trust: number } | null {
  const eligible = candidates
    .map(c => ({ role: c.role, trust: c.trust ?? 50 }))
    .filter(c => c.trust >= minTrust)
    .sort((a, b) => b.trust - a.trust)
  return eligible[0] || null
}

/**
 * 聊天式审批：任务进待批准泳道时，由创建者在信箱给 Lumina 发一条申请，
 * 用户/Lumina 可以在对话里直接批准（team_tasks approve）。
 * 失败不阻塞任务创建（信箱只是通知层）。
 */
export async function sendApprovalRequest(task: BoardTask): Promise<void> {
  try {
    const box = getTeamMailbox()
    const requester = task.createdBy || 'lumina'
    await box.send({
      from: requester,
      to: 'lumina',
      subject: `审批申请：${task.title}（${task.id}）`,
      body:
        `我准备接「${task.title}」（${task.kind}），这个任务要求人工批准后才能动手。\n` +
        `任务详情：${task.detail || '（无）'}\n` +
        `依赖：${task.blockedBy.length ? task.blockedBy.join(', ') : '无'}\n` +
        `回复「批准 ${task.id}」或在团队面板点批准；要驳回请说明原因。`,
      kind: 'dm',
    })
  } catch {
    /* 信箱未就绪不阻塞 */
  }
}

/** 审批结果回写关系：批准加一点信任，驳回扣一点（按创建者工种/成员） */
export function recordApprovalVerdict(requester: string, approved: boolean): void {
  if (!requester || requester === 'lumina') {return}
  try {
    const store = getRelationshipStore()
    store.recordInteraction(
      'lumina',
      requester,
      approved ? 'delegation_ok' : 'delegation_fail',
      'plan_approval',
    )
  } catch {
    /* 关系系统未就绪不阻塞 */
  }
}
