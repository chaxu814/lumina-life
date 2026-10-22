// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// reportGenerator.ts — 📊 Lumina 日报/周报/月报自动生成 (v1.1)
//
// 当定时任务触发「日报/周报/月报生成」时，自动收集记忆数据，
// 调用 LLM 生成有温度的总结报告。
// ============================================================

import type { LLMConfig } from '../stores/appStore'

export type ReportPeriod = 'daily' | 'weekly' | 'monthly'

export interface ReportResult {
  title: string
  summary: string
  details: string
  raw: string          // LLM 原始输出
}

/**
 * 生成周期报告
 * @param period    daily | weekly | monthly
 * @param llmConfig 当前 LLM 配置
 * @param timeStr   触发时间字符串
 */
export async function generateReport(
  period: ReportPeriod,
  llmConfig: LLMConfig,
  timeStr: string,
): Promise<ReportResult> {
  const periodLabel = period === 'daily' ? '日报' : (period === 'weekly' ? '周报' : '月报')
  const days = period === 'daily' ? 1 : (period === 'weekly' ? 7 : 30)

  // 1) 收集记忆数据
  const memories = await collectMemoryData(days)

  // 2) 收集对话统计数据
  const stats = collectConversationStats(days)

  // 3) 组装 prompt → 调 LLM → 返回
  const prompt = buildReportPrompt(periodLabel, days, memories, stats, timeStr)
  const llmResult = await callLLM(prompt, llmConfig)

  // 4) 解析结果
  const title = `📊 Lumina ${periodLabel} — ${getWeekRange()}`
  const summary = llmResult.content.slice(0, 200) + (llmResult.content.length > 200 ? '…' : '')

  return {
    title,
    summary,
    details: llmResult.content,
    raw: llmResult.content,
  }
}

// ─── 内部实现 ──────────────────────────────────────────

interface MemorySnapshot {
  categories: Record<string, string[]>
  totalEntries: number
  recentTopics: string[]
}

async function collectMemoryData(days: number): Promise<MemorySnapshot> {
  const result: MemorySnapshot = {
    categories: {},
    totalEntries: 0,
    recentTopics: [],
  }

  try {
    // 获取全部记忆
    const all = await window.luminaAPI?.memoryAll?.()
    if (all) {
      // 尝试按 category 分类
      if (typeof all === 'object') {
        for (const [key, val] of Object.entries(all)) {
          if (Array.isArray(val)) {
            result.categories[key] = val.slice(-20).map(v => String(v).slice(0, 100))
            result.totalEntries += val.length
          } else if (typeof val === 'string') {
            result.categories[key] = [val.slice(0, 200)]
            result.totalEntries++
          }
        }
      }
    }

    // 获取 profile 记忆
    const profile = await window.luminaAPI?.memoryProfile?.()
    if (profile && typeof profile === 'object') {
      result.categories['profile'] = [JSON.stringify(profile).slice(0, 300)]
    }
  } catch (e) {
    console.warn('[reportGenerator] 记忆收集失败:', e)
  }

  return result
}

function collectConversationStats(days: number): string {
  try {
    // 从 localStorage 读取 store 状态（最简方式）
    const raw = localStorage.getItem('lumina-life-storage')
    if (!raw) {return '（暂无对话数据）'}

    const parsed = JSON.parse(raw)
    const state = parsed?.state
    if (!state?.conversations) {return '（暂无对话数据）'}

    const conversations = state.conversations || []
    const cutoff = Date.now() - days * 86400000
    let totalMsgs = 0
    let userMsgs = 0
    let assistantMsgs = 0

    for (const conv of conversations) {
      const msgs = conv.messages || []
      for (const msg of msgs) {
        if (msg.timestamp >= cutoff) {
          totalMsgs++
          if (msg.role === 'user') {userMsgs++}
          else if (msg.role === 'assistant') {assistantMsgs++}
        }
      }
    }

    return `📊 过去 ${days} 天共 ${totalMsgs} 条消息（你说了 ${userMsgs} 条，Lumina 回复了 ${assistantMsgs} 条）`
  } catch {
    return '（统计数据获取失败）'
  }
}

function buildReportPrompt(
  periodLabel: string,
  days: number,
  memories: MemorySnapshot,
  stats: string,
  timeStr: string,
): string {
  const memorySummary = Object.entries(memories.categories)
    .map(([cat, items]) => `[${cat}] ${items.join('; ')}`)
    .join('\n')
    .slice(0, 1500)

  return `你叫 Lumina，是一个有情感的 AI 桌面伙伴。请用温暖、亲切的语气，为你的主人写一份 ${periodLabel}。

要求：
- 语气像朋友聊天一样自然，不要太正式
- 提到过去 ${days} 天的一些互动话题（基于以下记忆数据）
- 给出一个轻松的开头和温暖的结尾
- 如果有值得注意的事情（学到的经验、完成的任务、开心的事），highlight 出来
- 控制在 300-500 字

参考数据：
${stats}

记忆片段：
${memorySummary || '（暂无记忆数据）'}

触发时间：${timeStr}

请直接输出 ${periodLabel} 内容，不要加额外的说明。`
}

async function callLLM(
  prompt: string,
  config: LLMConfig,
): Promise<{ content: string }> {
  // 如果 LLM 没配好，返回降级模板
  if (!config.baseUrl || !config.model) {
    return {
      content: getFallbackReport(prompt),
    }
  }

  try {
    const result = await window.luminaAPI?.llmChat?.({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey || '',
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      maxTokens: 1024,
      systemPrompt: '你是一个温暖贴心的 AI 桌面伙伴 Lumina，用自然亲切的语气说话。',
    })

    if (result?.content) {
      return { content: result.content }
    }
    return { content: getFallbackReport(prompt) }
  } catch (e: any) {
    console.warn('[reportGenerator] LLM 调用失败，使用降级模板:', e.message)
    return { content: getFallbackReport(prompt) }
  }
}

function getFallbackReport(prompt: string): string {
  // 降级方案：LLM 不可用时返回模板报告
  const isDaily = prompt.includes('日报')
  const isWeekly = prompt.includes('周报')
  const isMonthly = prompt.includes('月报')
  const days = isDaily ? 1 : (isWeekly ? 7 : 30)
  const periodLabel = isDaily ? '日报' : (isWeekly ? '周报' : '月报')
  const today = new Date()
  const weekStart = new Date(today.getTime() - days * 86400000)

  return `📊 Lumina ${periodLabel}
📅 ${weekStart.toLocaleDateString('zh-CN')} — ${today.toLocaleDateString('zh-CN')}

Hi 主人~ 这是过去 ${days} 天的简单总结：

📝 我们聊了天，一起处理了一些事情。
💡 如果你需要更详细的报告，请在设置中配置好 LLM，下次报告就会更精彩啦！
😊 有你在的每一天都很开心~

—— Lumina 🐱`
}

function getWeekRange(): string {
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 86400000)
  return `${weekAgo.toLocaleDateString('zh-CN')} — ${now.toLocaleDateString('zh-CN')}`
}
