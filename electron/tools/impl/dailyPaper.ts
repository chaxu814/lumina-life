// ============================================================
// impl/dailyPaper.ts — Daily Paper 每日论文精选工具
//
// 功能：
//   1. 从 arXiv 获取最新论文 (复用 newsCollector)
//   2. LLM 筛选并生成摘要
//   3. 生成每日精选推送消息
// ============================================================

import { collectAll, type NewsItem } from './newsCollector'
import type { ToolResult } from '../types'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface DailyPaperResult {
  ok: boolean
  papers: Array<{
    title: string
    url: string
    source: string
    summary: string
  }>
  message: string
  totalCollected: number
  totalFiltered: number
}

// ═══════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════

export const dailyPaperDef = {
  name: 'daily_paper',
  description: '获取今日 arXiv 论文精选，返回 1-2 篇最值得关注的论文及摘要',
  params: {
    categories: {
      type: 'array',
      description: '要筛选的论文分类，如 ["cs.ai", "cs.cl", "cs.lg"]',
      required: false,
    },
    maxResults: {
      type: 'number',
      description: '最大返回论文数量 (1-5)',
      required: false,
    },
  },
  toolsets: ['news', 'agent'],
}

// ═══════════════════════════════════════════════════════════
// 工具实现
// ═══════════════════════════════════════════════════════════

export async function dailyPaperHandler(args: {
  categories?: string[]
  maxResults?: number
}): Promise<ToolResult> {
  try {
    // 获取论文
    const allItems = await collectAll({ arxiv: true, rss: false, baidu: false })
    let papers = allItems.filter(item => item.category === 'paper')

    // 按分类筛选
    if (args.categories && args.categories.length > 0) {
      const catSet = new Set(args.categories)
      papers = papers.filter(p => {
        // 从 source 中提取分类，如 "arXiv CS.AI" -> "cs.ai"
        const match = p.source.match(/arXiv\s+([\w.]+)/i)
        if (match) return catSet.has(match[1].toLowerCase())
        return true
      })
    }

    const totalCollected = allItems.length
    const totalFiltered = papers.length

    // 限制数量
    const maxResults = Math.min(args.maxResults || 2, 5)
    papers = papers.slice(0, maxResults)

    // 生成消息
    const message = generateDailyPaperMessage(papers)

    return {
      callId: '',
      ok: true,
      content: JSON.stringify({
        ok: true,
        papers: papers.map(p => ({
          title: p.title,
          url: p.url,
          source: p.source,
          summary: p.summary.slice(0, 200),
        })),
        message,
        totalCollected,
        totalFiltered,
      }),
    }
  } catch (err: any) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: `Daily Paper 获取失败: ${err.message}`,
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 消息生成
// ═══════════════════════════════════════════════════════════

function generateDailyPaperMessage(papers: NewsItem[]): string {
  if (papers.length === 0) {
    return '今日 arXiv 暂无新论文，稍后再来看看吧 📚'
  }

  const lines: string[] = []
  lines.push('📚 今日 arXiv 精选:')
  
  for (const paper of papers.slice(0, 2)) {
    const title = paper.title.length > 50 ? paper.title.slice(0, 50) + '...' : paper.title
    lines.push(`\n• ${title}`)
    lines.push(`  ${paper.url}`)
  }

  return lines.join('\n')
}
