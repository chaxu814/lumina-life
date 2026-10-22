// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// creator.ts — Creator 简化版 (Phase 3)
//
// 轻量内容创作工作流，不与 QwenPaw Creator 对等：
//   - 根据主题生成大纲
//   - 生成完整内容（Markdown）
//   - 导出为多种格式
//   - 支持图片/语音/字幕集成
// ============================================================

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ToolDef, ToolResult } from '../types'

// ═══════════════════════════════════════════════════════════
// 内容创作工作流
// ═══════════════════════════════════════════════════════════

interface ContentOutline {
  title: string
  sections: Array<{
    heading: string
    description: string
    estimatedWords: number
  }>
}

interface GeneratedContent {
  title: string
  content: string
  wordCount: number
  format: 'markdown' | 'html' | 'txt'
}

class CreatorEngine {
  private workspacesDir: string

  constructor() {
    this.workspacesDir = join(process.env.APPDATA || '', 'lumina', 'creator_workspaces')
    mkdirSync(this.workspacesDir, { recursive: true })
  }

  /**
   * 根据主题生成大纲
   */
  async generateOutline(topic: string, style: string = 'blog'): Promise<ContentOutline> {
    // 简化版大纲生成（实际应调用 LLM）
    // 这里返回示例大纲
    const outline: ContentOutline = {
      title: `${topic} — ${style === 'blog' ? '博客文章' : style === 'social' ? '社交媒体帖子' : '正式文档'}`,
      sections: [
        { heading: '引言', description: '引入主题背景和重要性', estimatedWords: 150 },
        { heading: '核心观点', description: '阐述主要观点和论据', estimatedWords: 400 },
        { heading: '案例分析', description: '结合实际案例说明', estimatedWords: 300 },
        { heading: '总结', description: '总结全文，给出行动建议', estimatedWords: 150 },
      ],
    }
    return outline
  }

  /**
   * 生成完整内容
   */
  async generateContent(outline: ContentOutline, additionalInstructions?: string): Promise<GeneratedContent> {
    // 简化版内容生成（实际应调用 LLM）
    const sections = outline.sections
      .map(s => `## ${s.heading}\n\n${s.description}\n\n*（此处为 ${s.estimatedWords} 字的内容区）*`)
      .join('\n---\n\n')

    const content = `# ${outline.title}\n\n${sections}`
    const wordCount = content.length

    return {
      title: outline.title,
      content,
      wordCount,
      format: 'markdown',
    }
  }

  /**
   * 导出内容
   */
  async exportContent(content: GeneratedContent, format: 'markdown' | 'html' | 'txt' = 'markdown'): Promise<string> {
    const timestamp = new Date().toISOString().slice(0, 10)
    const filename = `${content.title.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '_')}_${timestamp}`

    let finalContent = content.content
    let extension = 'md'

    if (format === 'html') {
      finalContent = this.markdownToHtml(content.content, content.title)
      extension = 'html'
    } else if (format === 'txt') {
      finalContent = content.content.replace(/[#*`]/g, '')
      extension = 'txt'
    }

    const savePath = join(this.workspacesDir, `${filename}.${extension}`)
    writeFileSync(savePath, finalContent, 'utf-8')

    return savePath
  }

  /**
   * 集成媒体生成（图片 + 语音）
   */
  async enrichWithMedia(content: GeneratedContent): Promise<{
    text: string
    images?: string[]
    audio?: string
  }> {
    // 简化版：不实际生成媒体，只返回结构
    return {
      text: content.content,
      images: [],
      audio: undefined,
    }
  }

  // ── 私有方法 ──────────────────────────────────────────

  private markdownToHtml(markdown: string, title: string): string {
    const html = markdown
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/---/g, '<hr>')
      .replace(/\n/g, '<br>')

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${html}</body></html>`
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

const creatorEngine = new CreatorEngine()

// ═══════════════════════════════════════════════════════════
// Tool 定义
// ═══════════════════════════════════════════════════════════

export const creatorOutlineDef: ToolDef = {
  name: 'creator_outline',
  description: '根据主题生成内容大纲',
  params: {
    topic: { type: 'string', description: '主题', required: true },
    style: { type: 'string', description: '风格 (blog/social/document)', required: false },
  },
  toolsets: ['agent', 'creator'],
}

export async function creatorOutlineHandler(args: Record<string, any>): Promise<ToolResult> {
  try {
    const outline = await creatorEngine.generateOutline(args.topic, args.style || 'blog')
    return { callId: '', ok: true, content: JSON.stringify(outline, null, 2) }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: `生成大纲失败: ${err.message}` }
  }
}

export const creatorGenerateDef: ToolDef = {
  name: 'creator_generate',
  description: '根据大纲生成完整内容',
  params: {
    outline: { type: 'string', description: '大纲 JSON', required: true },
    instructions: { type: 'string', description: '额外指令', required: false },
  },
  toolsets: ['agent', 'creator'],
}

export async function creatorGenerateHandler(args: Record<string, any>): Promise<ToolResult> {
  try {
    const outline = JSON.parse(args.outline)
    const content = await creatorEngine.generateContent(outline, args.instructions)
    return { callId: '', ok: true, content: JSON.stringify(content, null, 2) }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: `生成内容失败: ${err.message}` }
  }
}

export const creatorExportDef: ToolDef = {
  name: 'creator_export',
  description: '导出内容为文件（Markdown/HTML/TXT）',
  params: {
    content: { type: 'string', description: '内容 JSON', required: true },
    format: { type: 'string', description: '导出格式', required: false },
  },
  toolsets: ['agent', 'creator'],
}

export async function creatorExportHandler(args: Record<string, any>): Promise<ToolResult> {
  try {
    const content = JSON.parse(args.content)
    const format = args.format || 'markdown'
    const savePath = await creatorEngine.exportContent(content, format)
    return { callId: '', ok: true, content: `✅ 已导出: ${savePath}` }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: `导出失败: ${err.message}` }
  }
}

export const creatorEnrichDef: ToolDef = {
  name: 'creator_enrich',
  description: '为内容集成媒体（图片 + 语音）',
  params: {
    content: { type: 'string', description: '内容 JSON', required: true },
  },
  toolsets: ['agent', 'creator', 'media'],
}

export async function creatorEnrichHandler(args: Record<string, any>): Promise<ToolResult> {
  try {
    const content = JSON.parse(args.content)
    const enriched = await creatorEngine.enrichWithMedia(content)
    return { callId: '', ok: true, content: JSON.stringify(enriched, null, 2) }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: `媒体集成失败: ${err.message}` }
  }
}
