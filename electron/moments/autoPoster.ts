// ============================================================
// autoPoster.ts — Agent 朋友圈自动发帖 (v2.10)
//
// 在以下时机自动发布 Agent 动态：
//   1. 主动引擎触发 → observation 类型
//   2. 团队社交对话 → chat_summary 类型
//   3. Agent 决策 → decision 类型
//   4. Agent 思考 → thought 类型
// ============================================================

import { postMoment, type PostMomentParams } from './momentsStore'

/** 主动引擎触发 → 自动发观察动态 */
export function postObservation(agentId: string, agentName: string, content: string, emotion?: string) {
  return postMoment({
    agentId, agentName, content,
    type: 'observation',
    emotion,
  })
}

/** 团队聊天摘要 → 自动发对话动态 */
export function postChatSummary(agentId: string, agentName: string, topic: string, participants: string[]) {
  const content = `聊了「${topic}」— 参与者: ${participants.join('、')}`
  return postMoment({
    agentId, agentName, content,
    type: 'chat_summary',
  })
}

/** Agent 决策 → 自动发决策动态 */
export function postDecision(agentId: string, agentName: string, question: string, decision: string, emotion?: string) {
  const content = `关于「${question}」的决策: ${decision}`
  return postMoment({
    agentId, agentName, content,
    type: 'decision',
    emotion,
  })
}

/** Agent 内心想法 → 自动发想法动态 */
export function postThought(agentId: string, agentName: string, content: string, emotion?: string) {
  return postMoment({
    agentId, agentName, content,
    type: 'thought',
    emotion,
  })
}

/** 公告（系统/用户操作触发） */
export function postAnnouncement(agentId: string, agentName: string, content: string) {
  return postMoment({
    agentId, agentName, content,
    type: 'announcement',
  })
}
