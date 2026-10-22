// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// impl/aboutLumina.ts — Lumina 自省工具
//
// 【为什么需要】
// system prompt 里的「自我认知」是**常驻摘要**（为了省 token 只放要点）。
// 当用户问得更细（"你有多少工具""支持什么平台""团队都有谁""Lucky 是什么"）
// 时，模型需要一个能**实时读到完整、准确自身信息**的入口 —— 就是本工具。
//
// 【数据来源】全部走 selfKnowledge.buildFullSelfDescription()，
// 实时读取版本 / 平台 / 工具清单 / 技能 / 成员，读不到就省略，不编造。
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { buildFullSelfDescription } from '../../selfKnowledge'

export const aboutLuminaDef: ToolDef = {
  name: 'about_lumina',
  description:
    '查询 Lumina 自身的实时信息：版本、运行平台、团队成员与分工、已注册工具清单、内置技能、能力与边界、Lucky 模式说明。' +
    '当用户问"你是谁 / 你能做什么 / 你有什么功能 / 团队有谁 / Lucky 是什么 / 支持什么平台"时调用它，不要凭记忆瞎答。',
  params: {},
  // 能力层 'self'（由 agent 档 includes）—— 非模式层，声明即可达
  toolsets: ['self'],
}

export async function aboutLumina(_args: Record<string, any>): Promise<ToolResult> {
  try {
    return { callId: '', ok: true, content: buildFullSelfDescription() }
  } catch (e: any) {
    return { callId: '', ok: false, content: `自省快照构建失败: ${e?.message || e}` }
  }
}
