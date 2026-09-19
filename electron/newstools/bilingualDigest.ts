// ============================================================
// newstools/bilingualDigest.ts — 中英双语日报 v1.0
//
// 借鉴 Horizon：采集新闻 → 翻译英文 → 生成双语日报
// 包含 HTML 和纯文本两种输出格式
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import type { NewsCategory } from '../tools/impl/newsCollector'

export interface BilingualDigestResult {
  ok: boolean
  date: string
  cnTitle: string
  enTitle: string
  cnSummary: string
  enSummary: string
  items: Array<{
    title: string
    enTitle: string
    url: string
    source: string
    category: NewsCategory
    cnSummary: string
    enSummary: string
  }>
  html: string
  markdown: string
  error?: string
}

/** 生成双语日报 */
export async function generateBilingualDigest(
  maxItems: number = 20,
  includeEnglish: boolean = true
): Promise<BilingualDigestResult> {
  try {
    const { collectAll } = await import('../tools/impl/newsCollector')
    const { deduplicate } = await import('../tools/impl/newsDigest')
    const allItems = await collectAll()
    const items = deduplicate(allItems).slice(0, maxItems)

    const dateStr = new Date().toLocaleDateString('zh-CN', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    })
    const enDateStr = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    })

    // 尝试用 LLM 翻译标题和摘要（如果有配置）
    let translatedItems = items.map(item => ({
      title: item.title,
      enTitle: item.title,      // 默认用原标题
      url: item.url,
      source: item.source,
      category: item.category as NewsCategory,
      cnSummary: item.summary,
      enSummary: item.summary,  // 默认用原摘要
    }))

    if (includeEnglish) {
      try {
        translatedItems = await _batchTranslate(translatedItems)
      } catch (e) {
        console.warn('[bilingualDigest] 翻译服务不可用，使用原文:', e)
      }
    }

    // 生成 HTML
    const itemsHtml = translatedItems.map(item => `
      <div style="margin-bottom:16px;padding:12px;background:#f8f9fa;border-radius:8px;border-left:4px solid #448AFF;">
        <div style="font-size:14px;color:#666;margin-bottom:4px;">${item.source} · ${item.category}</div>
        <a href="${item.url}" style="font-size:16px;font-weight:600;color:#1a1a1a;text-decoration:none;" target="_blank">
          ${item.title}
        </a>
        ${includeEnglish ? `<div style="font-size:13px;color:#448AFF;margin:2px 0 4px;">${item.enTitle}</div>` : ''}
        <p style="font-size:13px;color:#555;margin:4px 0 0;line-height:1.5;">${item.cnSummary}</p>
        ${includeEnglish ? `<p style="font-size:12px;color:#777;margin:2px 0 0;line-height:1.4;">${item.enSummary}</p>` : ''}
      </div>
    `).join('')

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>📡 Lumina 双语日报 — ${dateStr}</title>
<style>
  body{font-family:-apple-system,'Microsoft YaHei',sans-serif;max-width:720px;margin:0 auto;padding:16px;background:#fff;color:#333;}
  h1{font-size:24px;margin:0;} .sub{font-size:14px;color:#888;margin:4px 0 20px;}
  a:hover{text-decoration:underline!important;}
  .footer{margin-top:32px;padding:16px;font-size:12px;color:#aaa;text-align:center;border-top:1px solid #eee;}
</style></head><body>
  <h1>📡 Lumina 每日新闻简报</h1>
  <div class="sub">${dateStr}${includeEnglish ? `<br>${enDateStr}` : ''}</div>
  ${itemsHtml}
  <div class="footer">由 Lumina AI 自动生成 · 共 ${items.length} 条</div>
</body></html>`

    const markdown = `# 📡 Lumina 每日新闻简报 — ${dateStr}${includeEnglish ? ` / ${enDateStr}` : ''}\n\n` +
      translatedItems.map(item =>
        `### ${item.title}${includeEnglish ? `\n*${item.enTitle}*` : ''}\n` +
        `> ${item.source} · ${item.category}\n\n` +
        `${item.cnSummary}\n\n` +
        `${includeEnglish ? `*${item.enSummary}*\n\n` : ''}` +
        `[阅读原文](${item.url})\n`
      ).join('\n---\n\n') +
      `\n\n---\n*由 Lumina AI 自动生成 · 共 ${items.length} 条*`

    return {
      ok: true,
      date: dateStr,
      cnTitle: `📡 Lumina 每日新闻简报 — ${dateStr}`,
      enTitle: `📡 Lumina Daily News Digest — ${enDateStr}`,
      cnSummary: `共 ${items.length} 条新闻 · ${translatedItems.filter(i => i.category === 'tech').length}条科技`,
      enSummary: `${items.length} articles · ${translatedItems.filter(i => i.category === 'tech').length} tech stories`,
      items: translatedItems,
      html,
      markdown,
    }
  } catch (err: any) {
    return { ok: false, date: '', cnTitle: '', enTitle: '', cnSummary: '', enSummary: '', items: [], html: '', markdown: '', error: err.message }
  }
}

/** 用 LLM 批量翻译标题+摘要 */
async function _batchTranslate(
  items: Array<{ title: string; enTitle: string; url: string; source: string; category: NewsCategory; cnSummary: string; enSummary: string }>
): Promise<Array<{ title: string; enTitle: string; url: string; source: string; category: NewsCategory; cnSummary: string; enSummary: string }>> {
  try {
    const { getProviderManager } = await import('../core/providerManager')
    const pm = getProviderManager?.()
    const activeConfig = pm?.getActiveConfig?.()
    if (!activeConfig?.config?.baseUrl) {return items}

    const { LLMProvider } = await import('../core/llmProvider')
    const provider = new LLMProvider({
      baseUrl: activeConfig.config.baseUrl,
      apiKey: activeConfig.config.apiKey || '',
      model: activeConfig.config.model,
      maxContextTokens: activeConfig.config.maxContextTokens || 256000,
    })

    const batchSize = 10
    const translated = [...items]

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize)
      const prompt = `Translate the following news titles and summaries to English. Return as JSON array with fields "enTitle" and "enSummary" for each item.\n\n${JSON.stringify(batch.map(item => ({ title: item.title, summary: item.cnSummary })))}`

      try {
        const res = await provider.call({
          messages: [
            { role: 'system', content: 'You are a professional translator. Return ONLY valid JSON array. No markdown. No explanation.' },
            { role: 'user', content: prompt },
          ],
          maxTokens: 4096,
          temperature: 0.1,
        })
        const raw = (res.text || '').trim()
        const jsonStart = raw.indexOf('[')
        const jsonEnd = raw.lastIndexOf(']')
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          const enBatch = JSON.parse(raw.slice(jsonStart, jsonEnd + 1))
          for (let j = 0; j < enBatch.length && i + j < translated.length; j++) {
            translated[i + j].enTitle = enBatch[j].enTitle || translated[i + j].title
            translated[i + j].enSummary = enBatch[j].enSummary || translated[i + j].cnSummary
          }
        }
      } catch {
        // 跳过该批次
      }
    }
    return translated
  } catch {
    return items
  }
}
