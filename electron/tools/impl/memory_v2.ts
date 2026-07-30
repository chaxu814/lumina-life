// ============================================================
// impl/memory_v2.ts — 增强记忆工具 (v2.4: 三层记忆 + 向量检索)
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { getMemoryStore, getMemoryVectorStore } from '../../memory/memoryStore'

// ── 记忆保存 ────────────────────────────────────────────

export const memorySaveDef: ToolDef = {
  name: 'memory_save',
  description: '保存记忆。category: "preference"(偏好) / "habit"(习惯) / "lesson"(教训) / "convention"(约定) / "system"(系统) / "fact"(事实) / "reflection"(反思) / "persona"(人格)',
  params: {
    category: { type: 'string', description: '类别: preference/habit/lesson/convention/system/fact/reflection/persona', required: true },
    content: { type: 'string', description: '要记住的内容', required: true },
  },
  toolsets: ['agent', 'memory'],
}

export async function memorySave(args: Record<string, any>): Promise<ToolResult> {
  const store = getMemoryStore()
  const { category, content } = args

  if (category === 'fact') {
    store.addFact({ category: 'user', content, confidence: 1.0, source: 'user_said' })
    return { callId: '', ok: true, content: `✅ 事实已记录: ${content.slice(0, 100)}` }
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
      if (facts.length === 0) return { callId: '', ok: true, content: '(暂无事实记忆)' }
      const lines = facts.map((f, i) => `${i + 1}. [${f.category}] ${f.content} (${(f.confidence * 100).toFixed(0)}%)`)
      return { callId: '', ok: true, content: `📋 事实记忆 (${facts.length}条):\n${lines.join('\n')}` }
    }
    case 'reflections': {
      const refs = store.getReflections(10)
      if (refs.length === 0) return { callId: '', ok: true, content: '(暂无反思记忆)' }
      const lines = refs.map((r, i) => `${i + 1}. [${r.topic}] ${r.insight}`)
      return { callId: '', ok: true, content: `💭 反思记忆 (${refs.length}条):\n${lines.join('\n')}` }
    }
    case 'persona': {
      const p = store.getPersona()
      if (!p) return { callId: '', ok: true, content: '(暂无完整人格画像)' }
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
    vectorStore.addEntry(`[事实:${fact.category}] ${fact.content}`, {
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

  // 执行语义搜索
  const results = await vectorStore.search(query, topK, 0.05)

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

  const lines = results.map((r, i) =>
    `${i + 1}. [相似度 ${(r.score * 100).toFixed(0)}%] ${r.entry.text.slice(0, 200)}`
  )

  return {
    callId: '',
    ok: true,
    content: `🔍 语义搜索 "${query}" (${results.length} 条):\n${lines.join('\n')}`,
  }
}
