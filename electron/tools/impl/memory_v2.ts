// ============================================================
// impl/memory_v2.ts — 增强记忆工具 (v2.4: 三层记忆 + 向量检索)
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import {
  getMemoryStore,
  getMemoryVectorStore,
  markUnverifiedFact,
  normalizeFactSource,
} from '../../memory/memoryStore'
// v3.34: 接上五维证据链（此前 memoryEvidence.ts 是 16KB 死代码）
import { recordEvidence, contradictEvidence, rankByEvidence } from '../../memory/evidenceBridge'
import { isEnabled } from '../../core/featureFlags'

// ── 记忆保存 ────────────────────────────────────────────

export const memorySaveDef: ToolDef = {
  name: 'memory_save',
  description: '保存记忆。category: "preference"(偏好) / "habit"(习惯) / "lesson"(教训) / "convention"(约定) / "system"(系统) / "fact"(事实) / "reflection"(反思) / "persona"(人格)。保存 fact 时必须诚实声明 source：默认按 model_inferred 处理（置信度 ≤60%），只有用户真的说过/确认过才能用 user_stated / user_confirmed。若这条 fact 是在纠正一条已有的错误记忆（memory_get 里能看到的旧 id），必须带上 correct_id，否则旧条目会继续排在它前面被反复召回',
  params: {
    category: { type: 'string', description: '类别: preference/habit/lesson/convention/system/fact/reflection/persona', required: true },
    content: { type: 'string', description: '要记住的内容', required: true },
    // source 只对 category="fact" 生效：事实的权威性由「谁说的」决定，不由调用方随手传 confidence 决定
    source: {
      type: 'string',
      description: '事实来源强度（仅 category="fact" 生效）: user_stated(用户亲口说过) / user_confirmed(用户明确确认过) / model_inferred(你自己推出来的，未经验证)。默认 model_inferred',
      required: false,
      enum: ['user_stated', 'user_confirmed', 'model_inferred'],
      default: 'model_inferred',
    },
    // 纠正入口：没有它，模型上周编的结论会永远压过用户今天亲口说的那条
    correct_id: {
      type: 'number',
      description: '（仅 category="fact"）被这条纠正的旧记忆 id，来自 memory_get / memory_search 返回的条目编号。填了则旧条目被降权并标注为已取代；纠正用户明确否认的事实时必填',
      required: false,
    },
  },
  toolsets: ['agent', 'memory'],
}

export async function memorySave(args: Record<string, any>): Promise<ToolResult> {
  const store = getMemoryStore()
  const { category, content } = args

  // 🔗 记忆与进化开关（设置 → 记忆与进化）：
  //   关掉后 memory_save 直接拒绝，并**如实告知**（绝不假装记下了）。
  //   · 对话记忆      → fact / reflection / preference / habit
  //   · 本地记忆与技能 → lesson / convention / system / persona
  if (['fact', 'reflection', 'preference', 'habit'].includes(category)
      && !isEnabled('memory.conversation')) {
    return { callId: '', ok: false, content: '', error: '「对话记忆」已在 设置 → 记忆与进化 中关闭，本次未记录。' }
  }
  if (['lesson', 'convention', 'system', 'persona'].includes(category)
      && !isEnabled('memory.localSkills')) {
    return { callId: '', ok: false, content: '', error: '「本地记忆与技能」已在 设置 → 记忆与进化 中关闭，本次未记录。' }
  }

  if (category === 'fact') {
    // 为什么不让调用方直接传 confidence:1.0 —— 模型幻觉一次就会被永久固化成「100% 确定的事实」，
    // 之后每轮 memory_get 都把它当权威召回，越用越真且没有纠正路径。
    // 记忆污染比记不住更危险，所以权威性只由 source 决定，confidence 一律被 clamp。
    const source = normalizeFactSource(args.source)
    const correctId = Number(args.correct_id)
    if (Number.isFinite(correctId) && correctId > 0) {
      const res = store.correctFact(Math.trunc(correctId), {
        category: 'user', content, source, confidence: args.confidence,
      })
      const saved = store.getFacts('user', 200).find(f => f.id === res.newId)
      const pct = Math.round((saved?.confidence ?? 0) * 100)
      const demotedNote = res.demoted.length > 0
        ? `\n   ♻️ 已纠正旧记忆 id=${res.demoted.join(',')}（降权并标注为已取代，不会再压过这条）`
        : ''
      const missingNote = res.ok ? '' : `\n   ⚠️ ${res.reason}`
      // v3.34: 纠正 = 旧内容被证伪。同步把证据链里对应旧条目标为 contradicted，
      // 否则召回排序仍会把一条已被用户否认的记忆排在前面。
      const contradicted = res.ok ? contradictEvidence(content) : false
      const evNote = contradicted ? `\n   🚫 证据链已把被取代的旧条目标为 contradicted（不再优先召回）` : ''
      return {
        callId: '',
        ok: true,
        content: `✅ 事实已记录: ${content.slice(0, 100)}\n   来源: ${source} / 置信度: ${pct}%${demotedNote}${missingNote}${evNote}`
          + (pct < 80 ? '\n   ⚠️ 该条为未验证记忆，不得当作权威事实对外陈述。' : ''),
      }
    }
    const id = store.addFact({ category: 'user', content, source, confidence: args.confidence })
    const saved = store.getFacts('user', 100).find(f => f.id === id)
    const pct = Math.round((saved?.confidence ?? 0) * 100)
    // v3.34: 同时登记到证据链。写入期的权威性硬约束仍只由 source 决定，
    // 证据链只负责后续排序与生命周期（不引入第二个“谁说了算”）。
    const ev = recordEvidence(content, 'fact', source)
    const evNote = ev ? `\n   📊 证据分 ${Math.round(ev.score * 100)}%（${ev.status}）` : ''
    return {
      callId: '',
      ok: true,
      content: `✅ 事实已记录: ${content.slice(0, 100)}\n   来源: ${source} / 置信度: ${pct}%${evNote}`
        + (pct < 80 ? '\n   ⚠️ 该条为未验证记忆，不得当作权威事实对外陈述。' : ''),
    }
  }
  if (category === 'reflection') {
    store.addReflection({ topic: '会话反思', insight: content, action: '' })
    return { callId: '', ok: true, content: `✅ 反思已记录: ${content.slice(0, 100)}` }
  }

  switch (category) {
    case 'preference': store.saveUserProfile({ preferences: [content] }); break
    case 'habit': store.saveUserProfile({ habits: [content] }); break
    case 'lesson': store.saveMemoryConfig({ lessons: [content] }); break
    case 'convention': store.saveMemoryConfig({ projectConventions: [content] }); break
    case 'system': store.saveMemoryConfig({ systemInfo: [content] }); break
    case 'persona': store.addPersonaTraits([content]); break
    default: return { callId: '', ok: false, content: '', error: `未知类别: ${category}。支持: preference, habit, lesson, convention, system, fact, reflection, persona` }
  }
  return { callId: '', ok: true, content: `记忆已保存 [${category}]: ${content.slice(0, 100)}` }
}

// ── 记忆读取 ────────────────────────────────────────────

export const memoryGetDef: ToolDef = {
  name: 'memory_get',
  description: '读取记忆。section: "user"/"memory"/"facts"/"reflections"/"persona"/"all"(全部)',
  params: { section: { type: 'string', description: '"user"(用户画像) / "memory"(环境配置) / "facts"(事实) / "reflections"(反思) / "persona"(人格) / "all"(全部)', required: false } },
  toolsets: ['agent', 'memory'],
}

export async function memoryGet(args: Record<string, any>): Promise<ToolResult> {
  const store = getMemoryStore()
  const section = args.section || 'all'

  switch (section) {
    case 'user': {
      const p = store.getUserProfile()
      return { callId: '', ok: true, content: p ? `用户画像:\n- 偏好: ${p.preferences.join('、') || '(无)'}\n- 习惯: ${p.habits.join('、') || '(无)'}\n- 风格: ${p.communicationStyle}` : '(暂无用户画像)' }
    }
    case 'memory': {
      const m = store.getMemoryConfig()
      return { callId: '', ok: true, content: m ? `环境配置:\n- 系统: ${m.systemInfo.join(' | ') || '(无)'}\n- 约定: ${m.projectConventions.join(' | ') || '(无)'}\n- 教训: ${m.lessons.join(' | ') || '(无)'}` : '(暂无环境配置)' }
    }
    case 'facts': {
      const facts = store.getFacts(undefined, 20)
      if (facts.length === 0) {return { callId: '', ok: true, content: '(暂无事实记忆)' }}
      // 低置信度条目必须带「未验证」标注，否则模型会把模型自己的幻觉当权威继续编
      const lines = facts.map((f, i) => `${i + 1}. [${f.category}] ${markUnverifiedFact(f.content, f)}`)
      return { callId: '', ok: true, content: `📋 事实记忆 (${facts.length}条):\n${lines.join('\n')}` }
    }
    case 'reflections': {
      const refs = store.getReflections(10)
      if (refs.length === 0) {return { callId: '', ok: true, content: '(暂无反思记忆)' }}
      const lines = refs.map((r, i) => `${i + 1}. [${r.topic}] ${r.insight}`)
      return { callId: '', ok: true, content: `💭 反思记忆 (${refs.length}条):\n${lines.join('\n')}` }
    }
    case 'persona': {
      const p = store.getPersona()
      if (!p) {return { callId: '', ok: true, content: '(暂无完整人格画像)' }}
      const bar = (v: number) => '█'.repeat(Math.round(v * 5)) + '░'.repeat(5 - Math.round(v * 5))
      return { callId: '', ok: true, content: `🎭 人格画像:\n- 特质: ${p.traits.join('、')}\n- 开放:${bar(p.openness)} 尽责:${bar(p.conscientiousness)} 外向:${bar(p.extraversion)} 宜人:${bar(p.agreeableness)} 趣味:${bar(p.playfulness)}\n- 演化: ${p.evolutionLog.slice(-3).join(' | ')}` }
    }
    default:
      return { callId: '', ok: true, content: store.getMemoryInjectionText() || '(暂无记忆)' }
  }
}

// ── 记忆全览 ────────────────────────────────────────────

export const memoryAllDef: ToolDef = {
  name: 'memory_all',
  description: '列出完整的结构化记忆（三层: 事实 + 反思 + 人格 + 用户 + 环境 + 对话摘要）',
  params: {},
  toolsets: ['agent', 'memory'],
}

export async function memoryAll(): Promise<ToolResult> {
  const store = getMemoryStore()
  return { callId: '', ok: true, content: store.getMemoryInjectionText() || '(暂无记忆数据)' }
}

// ── 记忆整理 ────────────────────────────────────────────

export const memorySummarizeDef: ToolDef = {
  name: 'memory_summarize',
  description: '主动触发记忆整理：保存对话摘要，可选生成事实/反思/人格记录',
  params: {
    summary: { type: 'string', description: '对话摘要 (≤150字)', required: false },
    type: { type: 'string', description: '"fact"(提取事实) / "reflection"(生成反思) / "persona"(更新人格) / "all"(全部)', required: false },
  },
  toolsets: ['agent', 'memory'],
}

export async function memorySummarize(args: Record<string, any>): Promise<ToolResult> {
  const store = getMemoryStore()
  const results: string[] = []

  if (args.summary) {
    store.addConversationSummary(args.summary)
    results.push('对话摘要已保存')
  }

  const type = args.type || 'all'
  if (type === 'fact' || type === 'all') {
    const count = store.getFacts(undefined, 1).length
    results.push(`事实记忆: ${count} 条`)
  }
  if (type === 'reflection' || type === 'all') {
    const count = store.getReflections(1).length
    results.push(`反思记忆: ${count} 条`)
  }
  if (type === 'persona' || type === 'all') {
    const p = store.getPersona()
    if (p) {
      results.push(`人格画像: ${p.traits.join('、')}`)
    } else {
      store.updatePersona({ traits: ['友善', '乐于助人', '好奇心强'], evolutionLog: ['初始人格生成'] })
      results.push('人格画像: 已初始化')
    }
  }

  return { callId: '', ok: true, content: `📊 记忆整理:\n${results.join('\n')}` }
}

// ═══════════════════════════════════════════════════════════
// v2.4: 向量语义搜索
// ═══════════════════════════════════════════════════════════

export const memorySearchDef: ToolDef = {
  name: 'memory_search',
  description: '语义搜索记忆库。用自然语言查询，返回语义上最相关的记忆条目（不限于关键词匹配）。例如: 搜"包管理器偏好" 能找到 "用户喜欢用 pnpm"',
  params: {
    query: { type: 'string', description: '自然语言查询，如"用户用什么编辑器"、"之前说过什么偏好"', required: true },
    top_k: { type: 'number', description: '返回条数，默认 5', required: false },
  },
  toolsets: ['agent', 'memory'],
}

export async function memorySearch(args: Record<string, any>): Promise<ToolResult> {
  const store = getMemoryStore()
  const vectorStore = getMemoryVectorStore()
  const query = args.query || ''
  const topK = args.top_k || 5

  if (!query.trim()) {
    return { callId: '', ok: false, content: '', error: '请提供搜索内容' }
  }

  // 收集所有记忆条目
  const structured = store.getStructuredMemory()

  // 将结构记忆转为向量条目
  vectorStore.clear()

  // 事实记忆
  for (const fact of structured.facts) {
    // 检索结果同样要带「未验证」标注，否则召回回来的幻觉会被当权威继续编
    vectorStore.addEntry(`[事实:${fact.category}] ${markUnverifiedFact(fact.content, fact)}`, {
      type: 'fact',
      category: fact.category,
      confidence: fact.confidence,
      source: fact.source,
    })
  }

  // 反思记忆
  for (const ref of structured.reflections) {
    vectorStore.addEntry(`[反思:${ref.topic}] ${ref.insight} → ${ref.action}`, {
      type: 'reflection',
      topic: ref.topic,
    })
  }

  // 用户画像
  if (structured.user.preferences.length > 0) {
    vectorStore.addEntry(`[偏好] ${structured.user.preferences.join(' | ')}`, { type: 'preference' })
  }
  if (structured.user.habits.length > 0) {
    vectorStore.addEntry(`[习惯] ${structured.user.habits.join(' | ')}`, { type: 'habit' })
  }
  if (structured.user.communicationStyle) {
    vectorStore.addEntry(`[沟通风格] ${structured.user.communicationStyle}`, { type: 'communicationStyle' })
  }

  // 环境配置
  for (const lesson of structured.memory.lessons) {
    vectorStore.addEntry(`[教训] ${lesson}`, { type: 'lesson' })
  }
  for (const conv of structured.memory.projectConventions) {
    vectorStore.addEntry(`[约定] ${conv}`, { type: 'convention' })
  }
  for (const info of structured.memory.systemInfo) {
    vectorStore.addEntry(`[系统] ${info}`, { type: 'systemInfo' })
  }
  for (const exp of structured.memory.toolExperience) {
    vectorStore.addEntry(`[工具] ${exp}`, { type: 'toolExperience' })
  }

  // 人格
  if (structured.persona) {
    vectorStore.addEntry(`[人格] 特质: ${structured.persona.traits.join('、')}`, { type: 'persona' })
  }

  // 🆕 执行混合检索：BM25 词法 + 余弦语义 → RRF 融合
  //   之前这里只跑 vectorStore.search()（纯 TF-IDF 余弦），关键词精确命中和
  //   语义相近只能二选一。现在默认走双路融合；任何一层失败都会自动回退，
  //   最差退回原来的纯语义 + 关键词回退链，行为不会比旧版差。
  let results: Awaited<ReturnType<typeof vectorStore.search>> = []
  let usedHybrid = true
  try {
    results = await vectorStore.searchHybrid(query, topK, { minCosine: 0.05 })
  } catch (err) {
    usedHybrid = false
    console.warn('[memorySearch] 混合检索失败，回退纯语义检索:', err)
    results = await vectorStore.search(query, topK, 0.05)
  }

  if (results.length === 0) {
    // 回退到关键词搜索
    const kwResults = vectorStore.searchByKeywords(query, topK)
    if (kwResults.length === 0) {
      return { callId: '', ok: true, content: '未找到相关记忆。' }
    }
    return {
      callId: '',
      ok: true,
      content: `🔍 关键词匹配 (${kwResults.length} 条):\n${kwResults.map((e, i) => `${i + 1}. ${e.text.slice(0, 150)}`).join('\n')}`,
    }
  }

  // v3.34: 证据链重排 —— 被用户证伪（contradicted）/ 已过期（outdated）的条目沉底，
  // 已确认（confirmed）的提到前面。这是「证据链」对用户可感知的直接作用：
  // 记错的事不会再被当成事实优先讲出来。
  const { ranked, demoted } = rankByEvidence(results, r => r.entry?.text ?? '')
  results = ranked as typeof results

  const lines = results.map((r, i) =>
    `${i + 1}. [相似度 ${(r.score * 100).toFixed(0)}%] ${r.entry.text.slice(0, 200)}`
  )
  const demoteNote = demoted > 0
    ? `\n⚠️ 其中 ${demoted} 条被证据链标为已证伪/已过期，已沉底排序`
    : ''

  const modeLabel = usedHybrid ? '混合检索(BM25+余弦·RRF融合)' : '语义检索'

  return {
    callId: '',
    ok: true,
    content: `🔍 ${modeLabel} "${query}" (${results.length} 条):\n${lines.join('\n')}${demoteNote}`,
  }
}
