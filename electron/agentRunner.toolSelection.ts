// ============================================================
// agentRunner.toolSelection.ts — 每轮工具选择流水线（P2-10 纯搬移）
//
// 本模块由 AgentRunner.getToolsForMode / semanticGroups 原样搬入，
// 不做任何运行时行为调整、逻辑合并或阈值改动。
// 调用方（AgentRunner）组装 ToolSelectionContext → 调 selectToolsForTurn →
// 把返回值写回自身字段。本模块不持有任何可变单例状态，
// 仅「语义兜底分类缓存」为模块级私有（TTL / 容量逻辑原样保留）。
// ============================================================

import { resolveToolset } from './tools/registry'
import {
  routeTools,
  looksLikeActionRequest,
  buildGroupSelectorPrompt,
  parseGroupAnswer,
  CAPABILITY_GROUPS,
} from './tools/toolRouter'
import { CHAT_MODE_TOOLS } from './prompts/systemPrompt'
import { isToolAllowedForRole } from './rolePolicy'
import { applyEmotionGate, renderGateNotice } from './orchestration/emotionGating'
// 🎯 任务类型识别 · 术有专攻 —— 高置信纯推理题本轮隐藏联网工具
import { profileTask, SEARCH_TOOLS } from './orchestration/taskProfiler'
import { getEmotionAuditLog } from './orchestration/emotionAudit'
// 🧩 情绪因果链：把「真实任务历史」接进门控。此前这两个函数无人调用。
// 静态 import 是安全的：emotionCausalityBridge 只依赖 electron/pet/* 与 memory/*，
// 这条链上没有任何模块回引 agentRunner（已核对）。
import { getCausalFrontendThree, getCausalGatingHints } from './pet/emotionCausalityBridge'
// 主配置（lumina-config.json）读取的单一入口：功能开关从这里读，不再各自 require
import { readFeatureFlag } from './core/appConfig'
import { LITE_TOOL_WHITELIST } from './orchestration/weakModelMode'

/** 情绪对象形状（与 AgentRunner._currentEmotion 一致） */
export interface ToolSelectionEmotion {
  mood: number
  energy: number
  affinity: number
  label?: string
}

/**
 * 每轮工具选择所需的全部实例状态 —— 由 AgentRunner 在调用时显式组装，
 * 本模块不读取任何 AgentRunner 实例字段。
 */
export interface ToolSelectionContext {
  /** 档位 */
  mode: 'chat' | 'agent' | 'developer'
  /** config.isChildAgent === true */
  isChildAgent?: boolean
  /** config.skipApproval === true（与 isChildAgent 共同决定子 Agent 过滤） */
  skipApproval?: boolean
  /** 配置里被禁用的工具名 */
  disabledTools?: string[]
  /** 角色 id（缺省按 lumina 全放行） */
  personaId?: string
  /** 本轮用户原话 */
  pendingUserText: string
  /** 会话 id（routeTools 缓存键） */
  sessionId: string
  /** 弱模型降级开关 */
  liteMode: boolean
  /** 当前情绪（null = 无情绪） */
  currentEmotion: ToolSelectionEmotion | null
  /** 语义兜底小模型连接 */
  llm: { baseUrl: string; apiKey: string; model: string }
}

/** 每轮工具选择结果 —— 对应原 getToolsForMode 的返回值 + 它对实例字段的全部写入 */
export interface ToolSelectionResult {
  /** 最终暴露给模型的工具名列表 */
  tools: string[]
  /** 工具档备注名（如 Agent+按需+语义+情绪收紧） */
  toolsetName: string
  /** 情绪门控产生的说明（供注入 prompt）；无收紧时为空串 */
  emotionGateNotice: string
  /** 本轮真正暴露给模型的工具名（供执行层给出可用清单） */
  exposedTools: string[]
  /** 最近一次情绪收紧的审计 id（空串 = 本轮未收紧） */
  lastGateAuditId: string
}

// ═══════════════════════════════════════════════════════════
// 🧠 语义兜底路由（方案 C）
//
// 只在「关键词一个都没命中 + 这句话确实像在要求做事」时才调一次 LLM。
// 闲聊、以及关键词已命中的请求 —— 一次都不调，零延迟零成本。
// ═══════════════════════════════════════════════════════════

/** 分类结果缓存（同一句话不重复调 LLM；30s TTL） */
const _semanticCache = new Map<string, { groups: string[]; at: number }>()
const SEMANTIC_TTL = 30_000
const SEMANTIC_CACHE_MAX = 100

/**
 * 用一次小 LLM 调用判断该加载哪些能力组。
 * 超时 / 出错 / 返回垃圾 → 返回 null，调用方静默退回关键词结果。
 */
async function semanticGroups(
  llm: { baseUrl: string; apiKey: string; model: string },
  userText: string,
): Promise<string[] | null> {
  const key = (userText || '').trim().slice(0, 200)
  if (!key) {return null}

  const cached = _semanticCache.get(key)
  if (cached && Date.now() - cached.at < SEMANTIC_TTL) {return cached.groups}

  const names = Object.keys(CAPABILITY_GROUPS)
  let groups: string[] = []
  try {
    const { LLMProvider } = await import('./core/llmProvider')
    const p = new LLMProvider({
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey || '',
      model: llm.model,
      temperature: 0,
      maxTokens: 48,
    } as any)
    const r: any = await p.call({
      messages: [
        { role: 'system', content: buildGroupSelectorPrompt(key, names) },
        { role: 'user', content: key },
      ],
      maxTokens: 48,
      temperature: 0,
    })
    const raw = String(r?.text || r?.content || '')
    // 🔧 关键：模型可能开启 reasoning，把答案放进 reasoning_content（已实测到）。
    //   只取 text 会拿到空串，分类恒失败 —— 所以两个字段都要看。
    const withReasoning = raw || String((r as any)?.reasoning || '')
    groups = parseGroupAnswer(withReasoning, names)
    console.log(`[getToolsForMode] 🧠 语义兜底: "${key.slice(0, 30)}" → [${groups.join(', ') || 'NONE'}]`)
  } catch (e) {
    // 分类失败绝不影响主流程 —— 退回关键词结果
    console.warn('[getToolsForMode] 🧠 语义兜底失败，退回关键词结果:', e)
    return null
  }

  if (_semanticCache.size >= SEMANTIC_CACHE_MAX) {
    const oldest = _semanticCache.keys().next().value
    if (oldest) {_semanticCache.delete(oldest)}
  }
  _semanticCache.set(key, { groups, at: Date.now() })
  return groups
}

export async function selectToolsForTurn(ctx: ToolSelectionContext): Promise<ToolSelectionResult> {
  let tools: string[]
  let toolsetName: string
  // 子 Agent 过滤 blockedInChild 工具
  const isChild = ctx.isChildAgent === true || ctx.skipApproval === true
  switch (ctx.mode) {
    case 'developer':
      tools = resolveToolset('developer', new Set(), isChild); toolsetName = 'Developer'; break
    case 'chat':
      tools = CHAT_MODE_TOOLS; toolsetName = 'Chat'; break
    case 'agent':
    default:
      tools = resolveToolset('agent', new Set(), isChild); toolsetName = 'Agent'; break
  }

  // ═══════════════════════════════════════════════════════════
  // 🎯 工具按需筛选（2026-10-07）
  //
  // 【为什么加】修复前这里把整档工具全量发给模型 —— agent 档 67 个
  //   ≈ 9,700 tokens，**每一次模型调用都要重发一遍**（包括「现在几点」）。
  //   实测 601 次真实工具调用里只有 22 个工具被用过，前 7 个占 95%。
  //
  // 【放在这一步的原因】必须在 disabledTools / rolePolicy / 情绪门控
  //   **之前**：本模块只做减法（从本档可用工具里挑子集），后面三层
  //   语义完全不变，仍然是「disabled → 角色 → 情绪」依次收紧。
  //
  // 【失败开放】拿不到用户输入、或裁完少于 8 个工具时，routeTools 会
  //   主动退回全量。宁可多花 token，也不能让模型手里没有工具。
  // ═══════════════════════════════════════════════════════════
  // 📌 记下候选集：语义兜底必须在**同一份**候选上重跑路由。
  //   重新 resolveToolset() 会丢掉 isChild / disabledTools 的过滤，那就危险了。
  const candidateTools = tools
  const fullCount = tools.length
  let routed: ReturnType<typeof routeTools>
  try {
    routed = routeTools(
      tools,
      ctx.mode || 'agent',
      ctx.pendingUserText,
      ctx.sessionId,
      readFeatureFlag('tools.onDemand', true),
    )
  } catch (e) {
    // 路由自身出错绝不能连累整轮对话 —— 退回全量即可
    console.warn('[getToolsForMode] 🎯 按需筛选异常，本轮退回全量:', e)
    routed = { tools, groups: [], newlyMatched: [], narrowed: false, reason: '筛选异常' }
  }
  // 🧠 方案 C 语义兜底：关键词一个都没命中 + 这句话确实像在要求做事 → 问一次 LLM。
  //   闲聊不会走到这里（looksLikeActionRequest 已过滤），所以日常对话零额外调用。
  if (routed.narrowed && routed.groups.length === 0) {
    const input = (ctx.pendingUserText || '').trim()
    let semanticOn = true
    try { semanticOn = readFeatureFlag('tools.semanticRouting', true) } catch { /* 默认开 */ }
    if (semanticOn && looksLikeActionRequest(input)) {
      const groups = await semanticGroups(ctx.llm, input)
      if (groups && groups.length > 0) {
        const withSemantic = routeTools(
          candidateTools,
          ctx.mode || 'agent',
          input,
          ctx.sessionId,
          true,
          groups,
        )
        if (withSemantic.tools.length >= 8) {
          tools = withSemantic.tools
          routed = withSemantic
          toolsetName += '+语义'
          console.log(`[getToolsForMode] 🧠 语义兜底生效: 补上 [${groups.join(', ')}] → ${tools.length} 个工具`)
        }
      }
    }
  }

  tools = routed.tools
  if (routed.narrowed) {
    const saved = Math.round((1 - tools.length / Math.max(1, fullCount)) * 100)
    toolsetName += `+按需`
    console.log(
      `[getToolsForMode] 🎯 按需筛选: ${fullCount} → ${tools.length} 个工具（省 ${saved}%）` +
      ` | 生效组: ${routed.groups.join(', ') || '仅核心'}` +
      (routed.newlyMatched.length ? ` | 本轮新命中: ${routed.newlyMatched.join(', ')}` : ''),
    )
  } else if (routed.reason) {
    console.log(`[getToolsForMode] 🎯 未裁剪（${routed.reason}），全量 ${fullCount} 个工具`)
  }

  const disabled = ctx.disabledTools
  if (disabled && disabled.length > 0) {
    const disabledSet = new Set(disabled)
    tools = tools.filter(t => !disabledSet.has(t))
  }

  // 每轮重置：上一轮的收紧说明不能泄漏到下一轮
  let emotionGateNotice = ''

  // 角色硬闸门（广告层）：在 disabledTools 之上，再按 rolePolicy 过滤一遍，
  // 确保向 LLM 广告的工具都在当前角色白名单内。
  // personaId 缺省按 lumina（全放行）处理，不影响 Lumina 主聊天。
  const personaId = ctx.personaId
  tools = tools.filter(t => isToolAllowedForRole(personaId, t).allowed)

  // 🆕 情绪驱动的工具收紧（创新功能 1）
  //   放在最后：只有前面所有硬性过滤都放行的工具，才有资格被情绪收紧。
  //   顺序很重要——情绪**永远不能**放宽 rolePolicy 的角色边界。
  //   读 features.emotionGating 开关：用户可关（键缺失 = 默认开）。
  let emotionGatingOn = true
  try {
    // 🔧 2026-10-04：原实现 `require('./agentConfig').getConfig()` 双重错误
    //   （模块不导出 getConfig + 打包后相对路径不存在），且被 catch 吞掉，
    //   使 features.emotionGating **永远读到 undefined** ——
    //   后果是用户在设置里关了「情绪门控」，工具仍被收紧，且无任何提示。
    //   现统一走主配置单一入口。详见 electron/core/appConfig.ts。
    emotionGatingOn = readFeatureFlag('emotionGating', true)
    // 🧠 moodstats A/B 对照干预点：只有「采集已注册 + 实验在跑 + 当前是对照组」
    // 时才可能把门控改写为 false；其余一切情况（默认配置）原样透传，
    // 表达式与 readFeatureFlag('emotionGating', true) 完全等价。
    try {
      const msReg = require('./moodstats/register') as typeof import('./moodstats/register')
      const msHandle = msReg.__getMoodStatsHandle?.()
      if (msHandle) {emotionGatingOn = msHandle.ab.resolveGateFeature(emotionGatingOn)}
    } catch { /* moodstats 未接线 → 原样透传 */ }
  } catch { /* 读不到就用默认 */ }

  // ── 🔗 情绪因果链接入（2026-10-04）──
  // 此前 getCausalFrontendThree() / getCausalGatingHints() 写好了（67 个用例），
  // 却**没有任何生产代码调用它们** —— 与 SkillMarketPanel、两个新面板同一类死模块。
  // 情绪此前由「桌宠表情」驱动（表现层），现在接上「真实任务历史」（因果层）：
  //   Yak 连续失败 → confidence 下降 → 焦虑升高 → 真的收紧不可逆工具
  //
  // 【安全前提：只收紧不放宽】
  // 取两者中**更焦虑**的那个，而不是用因果值覆盖情绪值 ——
  // 这样因果链只会让门控更严，永远不会因为某次失败把门控放松。
  let gateEmotion = ctx.currentEmotion
  let causalNote = ''
  try {
    const causalEmotion = getCausalFrontendThree()
    if (gateEmotion) {
      // 逐维取「更负/更低」的一侧：mood 取小、energy 取小
      gateEmotion = {
        ...gateEmotion,
        mood: Math.min(gateEmotion.mood, causalEmotion.mood),
        energy: Math.min(gateEmotion.energy, causalEmotion.energy),
      }
    } else {
      gateEmotion = causalEmotion
    }
    const hints = getCausalGatingHints()
    if (hints.tighten.length > 0) {
      causalNote = hints.reasons.join('；')
    }
  } catch {
    // 情绪因果链自身出错时绝不能连带搞挂门控 —— 主流程优先级高于情绪表现
    gateEmotion = ctx.currentEmotion
  }

  const gate = emotionGatingOn
    ? applyEmotionGate(tools, gateEmotion)
    : { tools, suppressed: [], reasons: [], gated: false, notice: '' }
  let lastGateAuditId = ''
  if (gate.gated) {
    tools = gate.tools
    toolsetName += '+情绪收紧'
    emotionGateNotice = renderGateNotice(gate)
    console.log(
      `[getToolsForMode] 😶 情绪收紧：暂缓 ${gate.suppressed.length} 个工具（${gate.reasons.join('；')}）`,
    )
    // 🔍 情绪收紧入审计（创新功能 1）
    //   收紧一旦发生，就必须留下可解释的记录 —— 否则用户问「为什么刚才不帮我」，
    //   没有人（包括我们）能回答，机制就退化成黑箱。
    //   `gateEmotion` 的非空不靠类型系统推断：applyEmotionGate 对 null 永远返回
    //   gated=false，所以这里 gate.gated 已蕴含非空，但仍显式守卫，
    //   避免将来有人改了上游的 null 语义就静默写进一条空情绪的审计。
    if (gateEmotion) {
      try {
        lastGateAuditId = getEmotionAuditLog().record(gate, gateEmotion) ?? ''
        if (lastGateAuditId) {
          console.log(`[getToolsForMode] 🔍 已入审计: ${lastGateAuditId}`)
        }
      } catch (e) {
        console.warn('[getToolsForMode] 审计写入失败（已忽略，不影响本轮）:', e)
      }
    }
  } else {
    // 情绪回落后，把上一轮仍然生效的收紧标为已恢复，
    // 让用户看到「已经好了」而不是永远挂着一个未知的限制。
    if (gateEmotion) {
      try { getEmotionAuditLog().reconcile(gateEmotion) } catch { /* 忽略 */ }
    }
    lastGateAuditId = ''
  }
  if (causalNote) {
    console.log(`[getToolsForMode] 🧩 情绪因果链：${causalNote}`)
  }

  // 🪶 弱模型（nano / small）自动降级：只保留安全白名单工具，
  //   砍掉团队协作 / 写文件 / 跑命令 / git 等小模型协调不动也易跑飞的重操作。
  //   放在所有硬性过滤之后，是最后一道"减法"，不影响前面的逻辑。
  if (ctx.liteMode) {
    const kept = tools.filter(t => LITE_TOOL_WHITELIST.has(t))
    if (kept.length > 0) {
      tools = kept
      toolsetName += '+轻量'
    } else {
      // 失败开放：白名单被上游过滤全干掉时，至少退回 memory_search，
      // 保证模型还能"回忆"，而不是手里空空直接崩。
      tools = ['memory_search']
      toolsetName += '+轻量(兜底)'
    }
    console.log(`[getToolsForMode] 🪶 轻量模式：工具裁剪至 [${tools.join(', ')}]`)
  }

  // 🎯 能力匹配（术有专攻）：高置信「纯推理题」本轮隐藏联网工具。
  //
  // 【为什么】用户实测：问纯组合概率题「集合 C={1,2,3,...,13} 子集 N 个元素
  //   不含五个连续整数 概率」，模型却先 web_search 搜题目原文，返回无关百科页。
  //   system prompt 的能力匹配指引是主手段；这里再做一道**硬保证**——
  //   把 web_search / web_fetch / browser 从本轮名单拿掉，让它想搜也搜不了，
  //   只能老老实实自己推理。
  //
  // 【安全前提】只在「高置信纯推理」时收紧；判不出 / 低置信一律不动（失败开放）。
  //   与 emotionGating 同一条铁则：本模块只做减法，永不放宽。
  try {
    const profile = profileTask(ctx.pendingUserText || '')
    if (profile.suppressSearch) {
      const before = tools.length
      tools = tools.filter(t => !SEARCH_TOOLS.includes(t))
      if (tools.length < before) {
        toolsetName += '+推理'
        console.log(
          `[getToolsForMode] 🎯 纯推理题（${profile.signals.join('、')}）：` +
          `本轮隐藏 ${before - tools.length} 个联网工具，让模型自己算`,
        )
      }
    }
  } catch { /* 能力匹配失败绝不能影响主流程 */ }

  // 📋 记下本轮真正暴露的工具名 —— 供执行层在「模型调了未加载的工具」时
  //   给出可用清单（否则会把它误报成「工具不存在」）。
  const exposedTools = tools

  return { tools, toolsetName, emotionGateNotice, exposedTools, lastGateAuditId }
}
