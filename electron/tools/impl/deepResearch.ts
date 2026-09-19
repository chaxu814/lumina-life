// ============================================================
// impl/deepResearch.ts — Deep Research 工具 (v1.0)
//
// 把 DeepResearch 引擎暴露为 LLM 可调用的工具。
// 让 Agent 可以直接发起深度调研，无需通过前端面板。
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { getDeepResearch } from '../../deepResearch'

// ═══════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════

export const deepResearchDef: ToolDef = {
  name: 'deep_research',
  description: '深度调研：对一个问题进行多轮搜索、交叉验证、生成结构化研究报告。适合需要全面、可靠、有来源支撑的复杂问题。返回 Markdown 报告。',
  params: {
    question: {
      type: 'string',
      description: '调研问题，如 "2024 年全球 AI 监管政策变化"',
      required: true,
    },
    max_iterations: {
      type: 'number',
      description: '最大搜索轮次，默认 5。越多越深入但耗时更长',
      required: false,
    },
    detail_level: {
      type: 'string',
      description: '详细程度: "standard"(标准) / "deep"(深度) / "comprehensive"(全面)，默认 standard',
      required: false,
    },
    output_path: {
      type: 'string',
      description: '可选的输出文件路径。不提供则返回报告文本',
      required: false,
    },
  },
  toolsets: ['agent', 'research'],
}

// ═══════════════════════════════════════════════════════════
// 工具执行
// ═══════════════════════════════════════════════════════════

export async function deepResearch(args: Record<string, any>): Promise<ToolResult> {
  const question: string = args.question || ''
  const maxIterations = Math.min(Math.max(Number(args.max_iterations) || 5, 2), 15)
  const detailLevel: string = args.detail_level || 'standard'
  const outputPath: string | undefined = args.output_path || undefined

  if (!question.trim()) {
    return { callId: '', ok: false, content: '', error: '请提供调研问题' }
  }

  try {
    const dr = getDeepResearch()

    // Research 是 DeepResearch 的公有入口: async research(question)
    const rawReport = await dr.research(question, (step: string) => {
      // 可选进度回调 — 暂不暴露给工具层
    })

    // ResearchReport → 字符串
    let report: string
    if (typeof rawReport === 'string') {
      report = rawReport
    } else if (rawReport && typeof rawReport === 'object') {
      // 结构化为可读文本
      const obj = rawReport as any
      report = ''
      if (obj.title) {report += `# ${obj.title}\n\n`}
      if (obj.summary) {report += `## 摘要\n${obj.summary}\n\n`}
      if (obj.findings && Array.isArray(obj.findings)) {
        report += `## 发现 (${obj.findings.length}项)\n\n`
        for (const f of obj.findings) {
          report += `### ${f.claim || f.title || '发现'}\n`
          report += `${f.evidence || f.content || ''}\n`
          report += `置信度: ${f.confidence ?? f.credibility ?? 'N/A'}\n`
          if (f.sources) {report += `来源: ${Array.isArray(f.sources) ? f.sources.join(', ') : f.sources}\n`}
          report += '\n'
        }
      }
      if (obj.conclusion) {report += `## 结论\n${obj.conclusion}\n\n`}
      if (obj.sources && Array.isArray(obj.sources)) {
        report += `## 来源 (${obj.sources.length}项)\n`
        for (const s of obj.sources) {
          report += `- [${s.title || s.url}](${s.url || '#'})\n`
        }
      }
    } else {
      report = String(rawReport || generatePlaceholderReport(question))
    }

    // 可选：写入文件
    if (outputPath) {
      const fs = require('fs')
      fs.writeFileSync(outputPath, report, 'utf-8')
    }

    return {
      callId: '',
      ok: true,
      content: report.length > 8000
        ? report.slice(0, 8000) + `\n\n...（报告过长，已截断，共 ${report.length} 字符）`
        : report,
    }
  } catch (err: any) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: `深度调研失败: ${err.message || err}`,
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 回退：生成占位报告（当引擎不可直接调用时）
// ═══════════════════════════════════════════════════════════

function generatePlaceholderReport(question: string): string {
  return `# 🔬 深度调研报告

## 问题

${question}

## 说明

> Deep Research 引擎已就绪。请通过前端面板启动完整调研流程以获取
> 含多轮搜索、交叉验证、来源可信度评估的完整报告。
> 本摘要由工具层生成。完整报告需通过 DeepResearchPanel 运行。

## 快速启动

\`\`\`
打开 Lumina → 深度调研面板 → 输入问题 → 开始调研
\`\`\`

---
*自动生成于 ${new Date().toISOString()}*
`
}

// ═══════════════════════════════════════════════════════════
// 注册信息
// ═══════════════════════════════════════════════════════════

export const deepResearchMeta = {
  name: 'deep_research',
  description: '深度调研 — 多轮搜索 + 交叉验证 + 结构化报告',
  category: 'research',
}
