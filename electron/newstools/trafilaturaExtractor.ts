// ============================================================
// newstools/trafilaturaExtractor.ts — Trafilatura 全文提取 v1.0
//
// 借鉴 Horizon：用 Python trafilatura 库提取文章正文
// 支持三种模式：trafilatura（首选）、readability（降级）、原始 HTML
// ============================================================

import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'

export interface FullTextResult {
  ok: boolean
  title?: string
  author?: string
  date?: string
  text?: string
  description?: string
  image?: string
  language?: string
  error?: string
}

/** 提取文章全文（Python trafilatura 方式） */
export async function extractFullText(url: string): Promise<FullTextResult> {
  try {
    // 尝试用 Python trafilatura
    const script = path.join(__dirname, 'scripts', 'extract_article.py')
    if (fs.existsSync(script)) {
      const result = await _runPythonScript(script, url)
      if (result.ok) {return result}
    }
  } catch {}

  // 降级：用 readability 方式直接 fetch + 解析
  return _readabilityFallback(url)
}

/** 调用 Python 脚本 */
function _runPythonScript(scriptPath: string, url: string): Promise<FullTextResult> {
  return new Promise((resolve) => {
    const proc = spawn('python3', [scriptPath, url], { timeout: 30000 })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        try { resolve(JSON.parse(stdout)) }
        catch { resolve(_readabilityFallback(url)) }
      } else {
        console.warn('[trafilatura] Python 退出码:', code, stderr.slice(0, 200))
        resolve(_readabilityFallback(url))
      }
    })
    proc.on('error', () => resolve(_readabilityFallback(url)))
  })
}

/** 降级：使用 Node.js 的 readability 类似方法 */
async function _readabilityFallback(url: string): Promise<FullTextResult> {
  try {
    const https = url.startsWith('https') ? await import('https') : await import('http')
    const httpMod = url.startsWith('https') ? await import('https') : await import('http')
    const mod = url.startsWith('https') ? await import('https') : await import('http')
    // 直接用 fetch 获取页面内容
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Lumina/1.0' },
      signal: AbortSignal.timeout(15000),
    })
    const html = await resp.text()

    // 简单提取：title + 去掉 HTML 标签的主体
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].trim() : ''

    // 去标签拿纯文本
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)
    const body = bodyMatch ? bodyMatch[1] : html
    const text = body
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    return {
      ok: true,
      title,
      text: text.slice(0, 10000),
      description: text.slice(0, 200),
      language: 'zh-CN',
    }
  } catch (err: any) {
    return { ok: false, error: `提取失败: ${err.message}` }
  }
}
