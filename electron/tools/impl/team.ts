// ============================================================
// tools/impl/team.ts — 团队/模式协作工具实现 (v8.0)
//
// v8.0: 重写 delegate_to（真·多 Agent 独立 Runner）。
//   之前: 用共享 Runner → prompt 切换人格 → splice 消息
//   现在: 走 DelegationManager → 目标 Agent 的独立 Runner → 保留完整上下文
//
// 保留 (v5.0): mode_switch, mode_status, team_context, memory_search
// 新增 (v8.0): delegate_to（调用独立 Runner）
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { getTeamManager } from '../../agentTeamManager'
import { getTeamContextManager } from '../../agentTeamContext'
import { getStructuredMemory } from '../../memoryStructured'
import { MODE_CONFIGS } from '../../agentTeamPersonas'
import type { AgentMode, TeamMemberId } from '../../agentTeamTypes'
import { getDelegationManager } from '../../delegationManager'
import { AgentRunner } from '../../agentRunner'

// ═══════════════════════════════════════════════════════════
// 「没做成」的统一口径（与 tools/registry.ts 的 buildNotExecutedResult 对齐）
//
// 为什么不 import registry 里那个函数：registry.ts 在主进程侧加载整张
//   工具表，工具实现再反向 import 它会形成 registry ↔ impl 循环依赖。
//   所以各文件各写一份本地小函数，用同一套文案保证行为一致。
//
// 为什么失败必须 ok:false：agentRunner 只在 ok:true 时把 content 原样回灌
//   给模型（ok:false 时回灌 `工具错误: ${error}`）。返回 ok:true 的失败
//   会以「这就是记忆/上下文内容」的形状进上下文，模型会把「查不到」当成
//   「不存在」继续编 —— 编造就是这么来的。
//
// 边界口径：**确实查了、确实为空**属于成功的查询，保持 ok:true，
//   但必须写明「查询成功，0 条结果」；只有真的没做成才走本函数。
// ═══════════════════════════════════════════════════════════
const NOT_EXECUTED_GUIDANCE =
  '禁止据此作答，也禁止把这段内容当作事实依据继续推理；请改用可用工具重试，或直接告诉用户你做不到以及原因。'

function notExecuted(callId: string, toolName: string, reason: string, detail: string): ToolResult {
  return {
    callId,
    ok: false,
    content: `⛔ 未执行成功（${toolName}，原因：${reason}）。以下是失败说明，不是结果。${NOT_EXECUTED_GUIDANCE}${detail ? `\n\n${detail}` : ''}`,
    error: `未执行成功（${toolName}，原因：${reason}）。${NOT_EXECUTED_GUIDANCE}${detail ? ` 实际错误/原始输出：${detail}` : ''}`,
  }
}


// ═══════════════════════════════════════════════════════════
// mode_switch — 切换工作模式
// ═══════════════════════════════════════════════════════════

export const modeSwitchDef: ToolDef = {
  name: 'mode_switch',
  description:
    '切换当前工作模式。\n' +
    '- chat ✨：默认模式，温暖伙伴，适合闲聊、查信息、生活娱乐\n' +
    '- code 🔥：编程模式，行动派，写代码/改Bug/Git操作\n' +
    '- analyze 🧠：分析模式，深度思考，架构评审/方案对比/数据分析\n' +
    '根据用户意图自动判断应切换到的模式，或手动指定。',
  params: {
    mode: {
      type: 'string',
      description: '目标模式：chat / code / analyze。留空则根据输入自动判断。',
      required: false,
    },
    reason: {
      type: 'string',
      description: '切换原因（用于日志）',
      required: false,
    },
  },
  toolsets: ['team', 'agent', 'developer'],
}

export async function modeSwitch(args: Record<string, any>): Promise<ToolResult> {
  const callId = `mode-${Date.now()}`
  const modeStr = (args.mode as string)?.toLowerCase()
  const reason = (args.reason as string) || '手动切换'

  // 验证模式
  const validModes: AgentMode[] = ['chat', 'code', 'analyze']
  if (modeStr && !validModes.includes(modeStr as AgentMode)) {
    return {
      callId, ok: false, content: '',
      error: `未知模式: ${modeStr}。可用模式: chat, code, analyze`,
    }
  }

  const manager = getTeamManager()
  const from = manager.currentMode

  if (modeStr) {
    manager.setMode(modeStr as AgentMode, reason)
  } else {
    // 自动返回当前模式（保持）
    return {
      callId, ok: true,
      content: `当前模式: ${MODE_CONFIGS[from].icon} ${MODE_CONFIGS[from].name}`,
    }
  }

  const to = manager.currentMode
  return {
    callId, ok: true,
    content: `模式已切换: ${MODE_CONFIGS[from].icon} ${MODE_CONFIGS[from].name} → ${MODE_CONFIGS[to].icon} ${MODE_CONFIGS[to].name}\n原因: ${reason}`,
  }
}

// ═══════════════════════════════════════════════════════════
// mode_status — 查询当前模式
// ═══════════════════════════════════════════════════════════

export const modeStatusDef: ToolDef = {
  name: 'mode_status',
  description: '查询当前工作模式和可用模式列表。',
  params: {},
  toolsets: ['team', 'agent'],
}

export async function modeStatus(_args: Record<string, any>): Promise<ToolResult> {
  const callId = `mode-status-${Date.now()}`
  const manager = getTeamManager()
  const current = manager.currentMode
  const config = MODE_CONFIGS[current]

  const modeList = Object.entries(MODE_CONFIGS)
    .map(([id, mc]) => `  ${id === current ? '▶' : ' '} ${mc.icon} ${mc.name}: ${mc.description}`)
    .join('\n')

  return {
    callId, ok: true,
    content: `当前模式: ${config.icon} ${config.name}\n描述: ${config.description}\n\n可用模式:\n${modeList}`,
  }
}

// ═══════════════════════════════════════════════════════════
// team_context — 查看团队上下文（保留）
// ═══════════════════════════════════════════════════════════

export const teamContextDef: ToolDef = {
  name: 'team_context',
  description: '查看团队上下文和当前工作状态。',
  params: {},
  toolsets: ['team', 'agent'],
}

export async function teamContext(_args: Record<string, any>): Promise<ToolResult> {
  const callId = `team-ctx-${Date.now()}`
  const manager = getTeamManager()
  const ctxManager = getTeamContextManager()

  const modeConfig = manager.getCurrentModeConfig()
  const ctx = ctxManager.getContext()

  return {
    callId, ok: true,
    content: `当前模式: ${modeConfig.icon} ${modeConfig.name}\n模式描述: ${modeConfig.description}\n团队状态: ${manager.state.mood}\n` +
      (ctx ? `团队上下文: ${ctx.slice(0, 500)}` : '无团队上下文'),
  }
}

// ═══════════════════════════════════════════════════════════
// memory_search — 搜索记忆（保留）
// ═══════════════════════════════════════════════════════════

export const memorySearchDef: ToolDef = {
  name: 'memory_search',
  description: '搜索 MEMORY.md 和 memory/*.md 中的内容。在回答关于过往工作、决策、偏好等问题前使用。',
  params: {
    query: {
      type: 'string',
      description: '搜索关键词或问题',
      required: true,
    },
  },
  toolsets: ['memory', 'memory_v2', 'agent'],
}

export async function memorySearch(args: Record<string, any>): Promise<ToolResult> {
  const callId = `mem-search-${Date.now()}`
  const query = args.query as string

  if (!query) {
    return { callId, ok: false, content: '', error: '缺少搜索关键词' }
  }

  try {
    const store = getStructuredMemory()
    const results = await store.search(query, 5)
    if (!results || results.length === 0) {
      // 口径：记忆库确实检索了、确实 0 条 → 成功的查询，保持 ok:true，
      // 但写明「0 条」，避免模型把「没检索到」当成「用户从没提过」。
      return { callId, ok: true, content: `✅ 查询成功，0 条结果：记忆库中没有与「${query}」相关的记录。这表示没检索到，不代表不存在。` }
    }
    const formatted = results
      .map((r: any, i: number) => `${i + 1}. [${r.source || 'memory'}] ${r.content || r.text}`)
      .join('\n')
    return { callId, ok: true, content: formatted }
  } catch (e: any) {
    return { callId, ok: false, content: '', error: `搜索记忆失败: ${e.message}` }
  }
}

// ═══════════════════════════════════════════════════════════
// ⭐ v8.0: delegate_to — 委托任务给团队成员（独立 Runner）
//
// 之前 (v6.2): 共享 Runner → 切 prompt 模∂人格 → splice 删消息
// 现在 (v8.0): 走 DelegationManager → 目标 Agent 的独立 Runner → 保留完整上下文
//
// 工作流:
//   Lumina 调用此工具 → DM 路由到 热茶/Yak 的独立 Runner
//   → 目标 Runner 用自己的 LLM/工具/记忆处理
//   → 返回结果，Lumina 整理成人话回复用户
//
// ⚠️ 路由口径（与 accessControl.ts 权限表一致，改一处必须改另一处）：
//   写代码/调试/重构 → yak（Yak，代码工程师）
//   审查/挑错/风险评估 → recha（热茶，数据分析师兼审查员）
//   历史版本这里是反的，会把编码任务派给没有写权限的一方，等于任务注定失败。
// ═══════════════════════════════════════════════════════════

export const delegateToDef: ToolDef = {
  name: 'delegate_to',
  description:
    '⭐ 委托任务给团队成员（写代码→Yak📊，审查找错→热茶🍵）。\n' +
    '只有以下 5 种场景才用，其他事你自己干：\n' +
    '1. 写代码/调试 bug → yak（Yak）\n' +
    '2. 审查代码/找逻辑漏洞 → recha（热茶）\n' +
    '3. 反面意见/风险评估 → recha（热茶）\n' +
    '4. 浏览网页/读取 URL 内容 → recha（热茶，用 fetch_content）\n' +
    '5. 搜索研究/资料查找 → recha（热茶，用 web_research）\n' +
    'Yak 和 热茶 有独立的 LLM 和上下文，能记住之前的委托历史。',
  params: {
    to: {
      type: 'string',
      description: '目标成员：\n  - yak 📊：代码工程师（写代码、调试、重构）\n  - recha 🍵：数据分析师兼审查员（审查代码、挑错、风险评估，只读不写）',
      required: true,
    },
    task: {
      type: 'string',
      description: '任务描述——详细说明要做什么。就像你给一个专业同事派活一样，说清楚需求和上下文。',
      required: true,
    },
    taskType: {
      type: 'string',
      description: '任务类型：code_write / code_debug / code_explain / code_review / logic_check / risk_assess / counter_argument / fetch_content（读取 URL 内容） / web_research（网络搜索研究）',
      required: true,
    },
    context: {
      type: 'string',
      description: '可选的上下文补充（如相关文件路径、用户原话、代码片段）。不传则带上最近 4 条对话。',
      required: false,
    },
  },
  // v3.34: 标记为「不可用于子 Agent」。
  // 工具层堵递归委托：子 Agent 拿不到派生类工具，A→B→A 的无限自我派生
  // 在源头就不成立。此前该机制存在但没有任何工具声明过 true，闸门是空转的。
  blockedInChild: true,
  // v3.34: 委托类工具的真实耗时远超默认 60s。
  // 依据：首次真实跑打包版时观察到 —— 委托会 fork 子 Agent 跑完整 ReAct，
  // 必要时再触发 v9.0 自动验证（真的执行 npx tsc + npx vitest），60s 必然打满；
  // 而「超时」不等于「停止」（Promise.race 只让调用方不再等，底层 promise 继续跑），
  // 于是重试会再开一条完整委托链，后台同时跑着两条。
  timeoutMs: 900000,
  toolsets: ['team', 'agent', 'developer'],
}

// ── P5：delegate_to 优雅降级 ─────────────────────────────
// 目标 worker（yak/recha）未配置 LLM 时，不再直接报错「不可用」，
// 而是尝试用 Lumina（主 Agent）已配置的 LLM，以「影子 worker」方式
// 直接完成任务。这样既不会让委托链路整体失败，也保留了角色分工的语义。
// 仅当 Lumina 自身也未配置 LLM 时，才给出明确的配置提示。
async function runDelegateFallback(
  callId: string,
  to: TeamMemberId,
  task: string,
  taskType: string,
): Promise<ToolResult> {
  const dm = getDelegationManager()
  const luminaRunner = dm.getRunner('lumina')
  const cfg = (luminaRunner as any)?.config
  const hasLumina = !!(cfg && cfg.baseUrl && cfg.model)

  if (!hasLumina) {
    const who = to === 'recha' ? '热茶 🍵' : 'Yak 📊'
    return notExecuted(
      callId,
      'delegate_to',
      `${who} 未配置 LLM`,
      `${who} 与 Lumina 都未配置可用的 LLM 端点，委托链路无法运行。请先在设置中为 Lumina 或该 worker 配置 LLM（baseUrl + model）。`,
    )
  }

  const rolePrompt =
    to === 'recha'
      ? '你是 热茶 🍵，Lumina 团队的资深数据分析师兼审查员。擅长数据核查、风险研判、逻辑找茬与对抗性评审。请用严谨、可证伪的方式给出结论，明确列出证据与依据。'
      : '你是 Yak 📊，Lumina 团队的代码工程师。擅长写代码、调试、解释代码与代码审查。请给出可运行、结构清晰、带必要说明的方案与代码。'

  console.log(`[delegate_to] ⚠️ ${to} 未配置 LLM，降级为 Lumina 影子 ${to} 直接执行`)

  try {
    const result: string = await AgentRunner.createWorker(
      {
        ...cfg,
        personaId: (cfg.personaId as string) || 'lumina',
        systemPrompt:
          `${rolePrompt}\n\n【本次任务类型】${taskType}\n只输出结果，不闲聊；若信息不足请明确说明缺口。`,
      },
      task,
    )
    const who = to === 'recha' ? '热茶 🍵' : 'Yak 📊'
    return {
      callId,
      ok: true,
      content:
        `⚠️ ${who} 未单独配置 LLM，已由 Lumina 以「${who}」角色代执行完成任务（降级模式）：\n\n${result}`,
    }
  } catch (err: any) {
    return notExecuted(
      callId,
      'delegate_to',
      '降级执行失败',
      `Lumina 影子 ${to} 执行也出错: ${err?.message || String(err)}`,
    )
  }
}

export async function delegateTo(args: Record<string, any>): Promise<ToolResult> {
  const callId = `delegate-${Date.now()}`
  const to = (args.to as string)?.toLowerCase()
  const task = args.task as string
  const taskType = args.taskType as string

  // ── 参数校验 ───────────────────────────────
  if (!to || !['yak', 'recha'].includes(to)) {
    return {
      callId, ok: false, content: '',
      error: '目标成员必须是 yak 📊（代码工程师）或 recha 🍵（数据分析师兼审查员）',
    }
  }

  if (!task || task.trim().length === 0) {
    return { callId, ok: false, content: '', error: '任务描述不能为空。请详细说明要做什么。' }
  }

  const validTypes = ['code_write', 'code_debug', 'code_explain', 'code_review', 'logic_check', 'risk_assess', 'counter_argument', 'fetch_content', 'web_research']
  if (!taskType || !validTypes.includes(taskType)) {
    return {
      callId, ok: false, content: '',
      error: `无效任务类型: "${taskType}"。有效类型: ${validTypes.join(', ')}`,
    }
  }

  // ── 通过 DelegationManager 委托 ───────────
  try {
    const dm = getDelegationManager()

    if (!dm.isConfigured(to as TeamMemberId)) {
      // P5 修复：目标 worker 未配置 LLM 时，不再直接报错「不可用」，
      // 而是降级为「Lumina 以该 worker 角色直接执行」；
      // 仅当 Lumina 自身也未配置时，才给出明确的配置提示。
      return runDelegateFallback(callId, to as TeamMemberId, task, taskType)
    }

    // 记录开始
    console.log(`[delegate_to] 🚀 ${to} ← "${task.slice(0, 80)}..." (${taskType})`)

    // 获取当前 Agent 的 ID（工具总是由当前 Agent Runner 调用）
    const fromId: TeamMemberId = 'lumina'

    const result = await dm.delegate(fromId, {
      to: to as TeamMemberId,
      task,
      taskType: taskType as any,
      // v9.5 fix: 不信任上游 context（可能含 group chat 前缀、system prompt、历史消息污染）
      // Worker 只需要 task 本身，历史上下文只会触发 LLM 重复/中毒
      context: '',
    })

    console.log(`[delegate_to] ✅ ${to} 返回 (${result.success ? '成功' : '失败'}, ${result.elapsedMs}ms)`)

    return {
      callId,
      ok: result.success,
      content: result.success
        ? result.content
        : `委托失败: ${result.error || '未知错误'}`,
      error: result.success ? undefined : (result.error || '未知错误'),
    }
  } catch (err: any) {
    console.error(`[delegate_to] ❌ 委托异常:`, err)
    return {
      callId, ok: false, content: '',
      error: `委托过程异常: ${err.message || String(err)}`,
    }
  }
}

// ═══════════════════════════════════════════════════════════
// v8.1: 自动迭代流水线
// ═══════════════════════════════════════════════════════════

export const delegateChainDef: ToolDef = {
  name: 'delegate_chain',
  description:
    '委托Yak写代码 → 自动转热茶审查 → 有问题自动返回Yak修改的迭代流水线。\n' +
    '适用于需要代码实现+代码审查的复杂任务。\n' +
    '系统会自动控制迭代次数（最多5轮），不会无限循环。',
  params: {
    task: {
      type: 'string',
      description: '要完成的核心任务描述',
      required: true,
    },
    maxIterations: {
      type: 'number',
      description: '最大迭代轮数（默认3，最大5）',
      required: false,
    },
    context: {
      type: 'string',
      description: '项目上下文或已有进展',
      required: false,
    },
    filePaths: {
      type: 'string',
      description: '相关文件路径，用逗号分隔',
      required: false,
    },
  },
  // v3.34: 标记为「不可用于子 Agent」。
  // 工具层堵递归委托：子 Agent 拿不到派生类工具，A→B→A 的无限自我派生
  // 在源头就不成立。此前该机制存在但没有任何工具声明过 true，闸门是空转的。
  blockedInChild: true,
  // v3.34: 委托类工具的真实耗时远超默认 60s。
  // 依据：首次真实跑打包版时观察到 —— 委托会 fork 子 Agent 跑完整 ReAct，
  // 必要时再触发 v9.0 自动验证（真的执行 npx tsc + npx vitest），60s 必然打满；
  // 而「超时」不等于「停止」（Promise.race 只让调用方不再等，底层 promise 继续跑），
  // 于是重试会再开一条完整委托链，后台同时跑着两条。
  timeoutMs: 900000,
  toolsets: ['team', 'agent', 'developer'],
}

export async function delegateChain(args: Record<string, any>): Promise<ToolResult> {
  const callId = `chain-${Date.now()}`
  const task = (args.task || '').trim()
  const maxIterations = Math.min(Math.max(1, (args.maxIterations as number) || 3), 5)
  const context = (args.context as string) || ''
  const filePaths = (args.filePaths as string)?.split(',').map((s: string) => s.trim()).filter(Boolean) || []

  if (!task) {
    return { callId, ok: false, content: '', error: '请提供 task 参数' }
  }

  const dm = getDelegationManager()
  const fromId: TeamMemberId = 'lumina'

  console.log(`[delegate_chain] 🚀 开始流水线: "${task.slice(0, 60)}..." 最大${maxIterations}轮`)

  let prevContext = context
  if (!prevContext) {
    const allCtx = dm.getAllContext()
    if (allCtx.length > 0) {
      prevContext = '团队已有上下文:\n' + allCtx.map(e => `[${e.key}] ${e.value.slice(0, 100)}`).join('\n')
    }
  }

  for (let i = 1; i <= maxIterations; i++) {
    console.log(`[delegate_chain] 📦 第${i}轮: Yak 写代码`)

    // Step 1: Yak（yak，程序员）写代码 —— 它才是有写权限的那一方
    const yakResult = await dm.delegate(fromId, {
      to: 'yak',
      task: i === 1
        ? task + (prevContext ? '\n\n已有上下文:\n' + prevContext : '')
        : `修复/改进以下代码:\n\n${prevContext}\n\n原始任务: ${task}`,
      taskType: 'code_write',
      context: prevContext,
      filePaths,
    })

    if (!yakResult.success) {
      return { callId, ok: false, content: '', error: `在第${i}轮 Yak 执行失败: ${yakResult.error}` }
    }

    if (yakResult.questions && yakResult.questions.length > 0) {
      return {
        callId, ok: false, content: '',
        error: `Yak 需要确认: ${yakResult.questions.join('; ')}。请先回答后再启动流水线。`,
      }
    }

    // Step 2: 热茶（审查员）审查
    const reviewTask = `审查以下代码：\n\n${yakResult.content.slice(0, 4000)}\n\n关注：逻辑正确性、边界条件、安全问题、性能问题。`
    console.log(`[delegate_chain] 📦 第${i}轮: 热茶 审查`)

    const rechaResult = await dm.delegate(fromId, {
      to: 'recha',
      task: reviewTask,
      taskType: 'code_review',
      context: '',
    })

    if (!rechaResult.success) {
      return { callId, ok: false, content: '', error: `在第${i}轮热茶审查失败: ${rechaResult.error}` }
    }

    if (rechaResult.questions && rechaResult.questions.length > 0) {
      return {
        callId, ok: false, content: '',
        error: `热茶需要确认: ${rechaResult.questions.join('; ')}。请先回答后再启动流水线。`,
      }
    }

    const reviewPassed = /✅|通过|批准|认可|没问题|可以合并|同意|LGTM|approved/i.test(rechaResult.content)
    prevContext = `第${i}轮结果:\nYak: ${yakResult.content.slice(0, 1000)}\n\n热茶: ${rechaResult.content.slice(0, 1000)}`

    if (reviewPassed) {
      console.log(`[delegate_chain] ✅ 第${i}轮审查通过！`)
      dm.setContext('last_chain_result', yakResult.content.slice(0, 500), 'yak')
      return {
        callId, ok: true,
        content: `## 流水线结果（第${i}轮通过）\n\n### Yak（程序员）输出\n${yakResult.content}\n\n### 热茶 审查\n${rechaResult.content}\n\n> 共 ${i} 轮迭代完成`,
      }
    }

    if (i < maxIterations) {
      console.log(`[delegate_chain] 🔄 第${i}轮未通过审查，进入第${i + 1}轮修复...`)
    } else {
      return {
        callId, ok: true,
        content: `## 流水线达到最大轮数（${maxIterations}轮）\n\n### 最终 Yak（程序员）输出\n${yakResult.content}\n\n### 最终 热茶 审查\n${rechaResult.content}\n\n> ⚠️ 达到最大迭代次数，仍有未解决的问题。建议手动审查。`,
      }
    }
  }

  return { callId, ok: false, content: '', error: '流水线异常终止' }
}

// ═══════════════════════════════════════════════════════════
// v8.1: 团队通知板
// ═══════════════════════════════════════════════════════════

export const writeNoticeDef: ToolDef = {
  name: 'write_notice',
  description:
    '给团队写一条通知留言。\n' +
    'Yak/热茶在任务中发现需要告知Lumina的事情时使用。\n' +
    '通知会被Lumina在下次决策前读取。\n' +
    'Workers请设置from="yak"或from="recha"。',
  params: {
    message: {
      type: 'string',
      description: '通知内容',
      required: true,
    },
    priority: {
      type: 'string',
      description: '优先级: low / normal / high（默认 normal）',
      required: false,
    },
    from: {
      type: 'string',
      description: '通知来源：yak / recha。Workers必须设置。',
      required: false,
    },
  },
  toolsets: ['team', 'agent'],
}

export async function writeNotice(args: Record<string, any>): Promise<ToolResult> {
  const callId = `notice-${Date.now()}`
  const message = (args.message || '').trim()
  const priority = (args.priority as string) || 'normal'
  const from = (args.from as string) || 'recha'

  if (!message) {
    return { callId, ok: false, content: '', error: '请提供 message 参数' }
  }

  const validPriorities = ['low', 'normal', 'high']
  const p = validPriorities.includes(priority) ? priority as 'low' | 'normal' | 'high' : 'normal'

  const validFrom = ['yak', 'recha', 'lumina'] as TeamMemberId[]
  const f = validFrom.includes(from as TeamMemberId) ? from as TeamMemberId : 'recha'

  getDelegationManager().addNotice(f, message, p)

  return {
    callId, ok: true,
    content: `✅ 通知已写入（来源: ${f}, 优先级: ${p}）`,
  }
}

export const readNoticesDef: ToolDef = {
  name: 'read_notices',
  description:
    '读取团队通知板中未读的通知（Yak/热茶写给你的留言）。\n' +
    '建议在每次做重要决策前先检查通知板，看看团队成员是否有需要告知你的信息。',
  params: {},
  toolsets: ['team', 'agent'],
}

export async function readNotices(args: Record<string, any>): Promise<ToolResult> {
  const callId = `read-notices-${Date.now()}`
  const dm = getDelegationManager()
  const notices = dm.getUnreadNotices()

  if (notices.length === 0) {
    return { callId, ok: true, content: '📋 通知板为空，没有未读通知。' }
  }

  const lines = notices.map((n, i) => {
    const priorityIcon = n.priority === 'high' ? '🔴' : n.priority === 'normal' ? '🟡' : '🟢'
    return `${i + 1}. ${priorityIcon} [${n.from}] ${n.message}`
  })

  dm.markAllNoticesRead()

  return {
    callId, ok: true,
    content: `📋 团队通知板（${notices.length}条未读）:\n${lines.join('\n')}`,
  }
}

// ═══════════════════════════════════════════════════════════
// v8.1: 团队共享上下文
// ═══════════════════════════════════════════════════════════

export const saveContextDef: ToolDef = {
  name: 'save_context',
  description:
    '保存团队共享上下文（项目级记忆）。\n' +
    '所有团队成员可见，适合记录项目进展、关键决策、重要的实现细节。\n' +
    '使用示例：save_context(key="project_status", value="用户认证模块已完成，下一步做权限管理")',
  params: {
    key: {
      type: 'string',
      description: '上下文键名（如 project_status, decision_20240616, db_schema）',
      required: true,
    },
    value: {
      type: 'string',
      description: '上下文内容',
      required: true,
    },
  },
  toolsets: ['team', 'agent'],
}

export async function saveContext(args: Record<string, any>): Promise<ToolResult> {
  const callId = `savectx-${Date.now()}`
  const key = (args.key || '').trim()
  const value = (args.value || '').trim()

  if (!key || !value) {
    return { callId, ok: false, content: '', error: '请提供 key 和 value 参数' }
  }

  getDelegationManager().setContext(key, value, 'lumina')

  return {
    callId, ok: true,
    content: `✅ 共享上下文 [${key}] 已保存`,
  }
}

export const loadContextDef: ToolDef = {
  name: 'load_context',
  description:
    '读取团队共享上下文（项目级记忆）。\n' +
    '不加 key 参数则返回所有上下文。\n' +
    '使用示例：load_context(key="project_status") 或 load_context()',
  params: {
    key: {
      type: 'string',
      description: '上下文键名。留空则返回所有上下文。',
      required: false,
    },
  },
  toolsets: ['team', 'agent'],
}

export async function loadContext(args: Record<string, any>): Promise<ToolResult> {
  const callId = `loadctx-${Date.now()}`
  const key = (args.key as string) || ''
  const dm = getDelegationManager()

  if (key) {
    const entry = dm.getContext(key.trim())
    if (!entry) {
      // 按 key 精确读取没读到 = 没取到内容，与「查全量为空」性质不同，
      // 必须显式失败，否则模型会拿没有的值继续推理。
      const available = dm.getAllContext().map(e => e.key)
      return notExecuted(
        callId, 'load_context',
        `未找到共享上下文 [${key}]`,
        `当前已存在的 key: ${available.length > 0 ? available.join(', ') : '(一个都没有)'}\n可用 load_context() 不带参数列出全部。`,
      )
    }
    return {
      callId, ok: true,
      content: `[${entry.key}] (由 ${entry.updatedBy} 更新于 ${entry.timestamp})\n${entry.value}`,
    }
  }

  const all = dm.getAllContext()
  if (all.length === 0) {
    // 口径：全量读取确实执行了、确实为空 → 成功的查询，保持 ok:true
    return { callId, ok: true, content: '✅ 查询成功，0 条结果：团队共享上下文当前为空。' }
  }

  const lines = all.map(e => `- [${e.key}] ${e.updatedBy}: ${e.value.slice(0, 150)}${e.value.length > 150 ? '...' : ''}`)
  return {
    callId, ok: true,
    content: `📝 团队共享上下文（${all.length}条）:\n${lines.join('\n')}`,
  }
}
