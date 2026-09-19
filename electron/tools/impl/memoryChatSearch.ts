// ============================================================
// impl/memoryChatSearch.ts — 回忆书对话工具 v1.0
//
// 允许 Agent 用自然语言查询历史记忆，像"聊天一样翻回忆"
// 灵感来源: SpringNote 的回忆书功能
//
// 工作方式:
//   用户: "我上周干了什么？"
//   → Agent 调用本工具搜索记忆
//   → 返回相关记忆摘要
//   → Agent 整理成自然语言回答
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { getMemoryStore } from '../../memory/memoryStore'
import { xpManager } from '../../gamification/levels'

// ═══════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════

export const memoryChatSearchDef: ToolDef = {
  name: 'memory_chat_search',
  description: '【回忆书】用自然语言搜索过去的记忆。用户在问"我上周干了什么""我和热茶说过什么"时调用。返回相关记忆的时间线摘要。',
  params: {
    query: {
      type: 'string',
      description: '自然语言查询，如"上周二干了什么" "关于 project lumina 的讨论"',
      required: true,
    },
    timeRange: {
      type: 'string',
      description: '时间范围: today / yesterday / this_week / last_week / this_month / all',
      required: false,
      enum: ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'all'],
    },
    maxResults: {
      type: 'number',
      description: '最多返回几条结果（默认 5）',
      required: false,
    },
  },
  toolsets: ['agent'],
}

export async function memoryChatSearch(args: Record<string, any>): Promise<ToolResult> {
  const query = (args.query || '').trim()
  if (!query) {
    return { callId: '', ok: false, content: '', error: '请输入要搜索的内容' }
  }

  const timeRange = (args.timeRange || 'all') as string
  const maxResults = Math.min((args.maxResults as number) || 5, 20)

  const store = getMemoryStore?.()
  if (!store) {
    return { callId: '', ok: false, content: '记忆存储暂不可用，请稍后再试。' }
  }

  // 计算时间范围
  const now = new Date()
  let sinceTime: number | null = null
  switch (timeRange) {
    case 'today':
      sinceTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      break
    case 'yesterday': {
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)
      sinceTime = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()).getTime()
      break
    }
    case 'this_week': {
      const dayOfWeek = now.getDay()
      const monday = new Date(now)
      monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1))
      sinceTime = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate()).getTime()
      break
    }
    case 'last_week': {
      const lastMonday = new Date(now)
      lastMonday.setDate(now.getDate() - (now.getDay() === 0 ? 13 : now.getDay() + 6))
      sinceTime = new Date(lastMonday.getFullYear(), lastMonday.getMonth(), lastMonday.getDate()).getTime()
      break
    }
    case 'this_month':
      sinceTime = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
      break
    case 'all':
    default:
      sinceTime = null
  }

  // 从三层记忆中搜索
  const results: string[] = []

  try {
    // 1. 搜索事实记忆
    const facts = store.getFacts('all', 50)
    const relevantFacts = facts.filter(f => {
      if (sinceTime && new Date(f.timestamp).getTime() < sinceTime) {return false}
      const content = f.content.toLowerCase()
      const q = query.toLowerCase()
      return content.includes(q) || q.split(' ').some((word: string) => content.includes(word))
    })

    for (const f of relevantFacts.slice(0, maxResults)) {
      results.push(`📝 [${f.category}] ${f.content} (确信度: ${Math.round(f.confidence * 100)}%, ${new Date(f.timestamp).toLocaleDateString('zh-CN')})`)
    }

    // 2. 搜索反思记忆
    try {
      const reflections = (store as any).getReflections?.() || []
      for (const r of reflections) {
        if (sinceTime && new Date(r.timestamp).getTime() < sinceTime) {continue}
        const insightText = `${r.topic}: ${r.insight}`.toLowerCase()
        if (insightText.includes(query.toLowerCase())) {
          results.push(`💭 [反思] ${r.topic}: ${r.insight} (${new Date(r.timestamp).toLocaleDateString('zh-CN')})`)
        }
      }
    } catch {}

    // 3. 搜索结构化记忆
    try {
      const structured = (store as any).getStructuredMemory?.()
      if (structured?.user) {
        const userInfo = `👤 用户资料: ${JSON.stringify(structured.user)}`
        if (userInfo.toLowerCase().includes(query.toLowerCase())) {
          results.push(userInfo)
        }
      }
    } catch {}

  } catch (err) {
    return {
      callId: '',
      ok: true,
      content: `搜索时出了点小问题，但我尽力了。以下是找到的内容：\n${results.length > 0 ? results.slice(0, maxResults).join('\n') : '没有找到相关记忆。要不要试试换个问法？'}`,
    }
  }

  // 给 XP
  xpManager.addXp(3, '回忆书搜索')

  if (results.length === 0) {
    return {
      callId: '',
      ok: true,
      content: `关于「${query}」没有找到相关记忆。这可能是我们还没聊到过这个话题，或者记忆还在整理中。要不要换个问法？`,
    }
  }

  const output = results.slice(0, maxResults).join('\n')
  return {
    callId: '',
    ok: true,
    content: `关于「${query}」找到 ${results.length} 条相关记忆：\n\n${output}`,
  }
}
