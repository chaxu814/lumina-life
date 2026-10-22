// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// phaseGateDelegate.ts — 五阶段门控委托工具（v3.34 新增）
//
// 【为什么需要这个文件】
// `DelegationManager.phaseGatedDelegate()`（Research → Plan → Execute →
// Verify → Review）是本项目最完整的编排实现 —— 21KB 状态机，含复杂度
// 分析、情绪参与判断、依赖图展开、并行批次、阶段准入准出、验证闭环。
//
// 但在 v3.34 之前它**全仓 0 个调用方**：没有 tool、没有 IPC、没有 runner、
// 也没有 preload 引用。它内部依赖的 `PhaseGate` / `getYakParallel` /
// `getPhasesFromComplexity` 只能通过这个死入口到达。
//
// 后果很具体：
//   · 用户按 README 体验到的「复杂任务分阶段执行」从来没发生过
//   · `orchestration/phaseGate.ts` 的全部逻辑（以及为它写的 7 处结构测试）
//     测的是一段跑不到的代码
//   · `luckyModeIntegration` 生成的 usePhaseGate 配置无人消费
//
// 【修法】
// 挂一个 tool 出去，让模型能直接调用。与 delegate_to 的区别：
//   delegate_to         单次派活，串行等结果，适合边界清晰的小任务
//   phase_gate_delegate 先判复杂度，简单任务自动降级成 delegate_to，
//                       复杂任务走完整五阶段 + 验证闭环
// 模型可以「总是用后者」，也可以「自己判断」——这正是 phaseGatedDelegate
// 内部已经实现的分支逻辑，不需要我们在 prompt 里重复教。
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { getDelegationManager } from '../../delegationManager'

function ok(text: string): ToolResult {
  return { callId: '', ok: true, content: text, durationMs: 0 }
}
function fail(text: string): ToolResult {
  return { callId: '', ok: false, content: text, durationMs: 0 }
}

export const phaseGateDelegateDef: ToolDef = {
  name: 'phase_gate_delegate',
  description:
    '五阶段门控委托：复杂任务走完整流程（调研 → 计划 → 执行 → 验证 → 审查），简单任务自动降级为普通派活。\n' +
    '何时用：需求模糊/跨多个模块/需要先调研再动手的活（"重构这个模块"、"调研一下再加个功能"、"把这个项目优化一下"）。\n' +
    '何时不用：边界清晰的一步到位任务（"把这个函数改成异步"）——用 delegate_to 更快更省。\n' +
    '本工具会自动判断复杂度，你也可以自己先判断后决定调用哪个。',
  params: {
    task: { type: 'string', description: '要完成的任务（用自然语言描述，模型会拆成阶段）', required: true },
    taskType: {
      type: 'string',
      description: '任务类型，如 coding / refactor / research / debug / general。不确定就填 general',
      required: false,
    },
    context: { type: 'string', description: '补充上下文：项目路径、已知约束、相关文件', required: false },
  },
  toolsets: ['team', 'agent', 'developer'],
  // v3.34: 标记为「不可用于子 Agent」。
  // 工具层堵递归委托：子 Agent 拿不到派生类工具，A→B→A 的无限自我派生
  // 在源头就不成立。此前该机制存在但没有任何工具声明过 true，闸门是空转的。
  blockedInChild: true,
  // v3.34: 本工具会跑完整五阶段编排（调研→计划→执行→验证→审查），每阶段可能
  // 再派生多个 worker。能力面**强于** hire_worker / workflow（那两个都是
  // dangerous: true），标成 false 会让 SecurityGuard 完全跳过它 —— 那是错的。
  dangerous: true,
  // 五阶段编排的真实耗时远不止默认的 60s（单次 LLM 调用就可能 60s+）。
  // 原来用默认超时的话，每次超时都会重跑整个编排，而上一轮的派生还在后台
  // 继续跑（Promise.race 只是不等了，底层 promise 并没被取消）。
  timeoutMs: 900_000,
}

export async function phaseGateDelegate(args: Record<string, any>): Promise<ToolResult> {
  const task = String(args.task || '').trim()
  if (!task) {return fail('缺少 task')}

  const from = String(args.from || 'lumina')
  const taskType = String(args.taskType || 'general')

  try {
    const dm = getDelegationManager()
    const result = await dm.phaseGatedDelegate({
      from,
      task,
      taskType,
      context: args.context ? String(args.context) : undefined,
    })

    const header = result.success
      ? '✅ 阶段门控执行完成'
      : `❌ 阶段门控执行失败：${result.error || '未知错误'}`

    // 超时文案要说清「编排可能仍在后台继续」—— Promise.race 只是不等了，
    // 底层 promise 没有被取消。隐瞒这一点会让用户以为已经停下了。
    const stillRunning = !!result.error && /超时|timeout|ETIMEDOUT/i.test(result.error)
    const backgroundNote = stillRunning
      ? '\n\n⚠️ 本次调用已返回超时，但底层编排**可能仍在后台继续派生 worker**。' +
        '继续大量调用前，建议先在任务面板确认上一次的状态。'
      : ''

    const meta = [
      `⏱ 耗时 ${(result.elapsedMs / 1000).toFixed(1)}s`,
      result.toolCallsCount > 0 ? `🔧 工具调用 ${result.toolCallsCount} 次` : null,
      result.retryInfo?.totalRetries ? `🔁 重试 ${result.retryInfo.totalRetries} 次` : null,
    ].filter(Boolean).join(' · ')

    const questions = result.questions?.length
      ? `\n\n❓ 需要确认：\n${result.questions.map(q => `  - ${q}`).join('\n')}`
      : ''

    return ok(`${header}\n${meta}\n\n${result.content}${questions}${backgroundNote}`)
  } catch (e: any) {
    return fail(`phase_gate_delegate 失败: ${e?.message || e}`)
  }
}
