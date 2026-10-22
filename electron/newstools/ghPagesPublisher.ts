// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// newstools/ghPagesPublisher.ts — GitHub Pages 日报发布 v1.0
//
// 借鉴 Horizon：生成日报 HTML → 推送到 gh-pages 分支
// 日报站点每天更新，展示所有历史日报
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { execSync } from 'child_process'

export interface PublishResult {
  ok: boolean
  url?: string
  date?: string
  htmlPath?: string
  error?: string
}

interface GHConfig {
  repoDir: string        // 本地 gh-pages 仓库路径
  remote: string         // 远程仓库 URL
  branch: string         // 分支（默认 gh-pages）
  baseUrl: string        // 站点 URL
}

let config: GHConfig | null = null

/** 配置发布参数 */
export function configurePublisher(cfg: Partial<GHConfig>): void {
  config = { ...config, ...cfg } as GHConfig
}

function getConfig(): GHConfig {
  if (config) {return config}
  const userDataPath = app?.getPath?.('userData') || process.cwd()
  const repoDir = path.join(userDataPath, 'lumina-news-site')
  config = {
    repoDir,
    remote: '',
    branch: 'gh-pages',
    baseUrl: '',
  }
  return config
}

/** 发布最新日报 */
export async function publishToGitHubPages(source: string = 'latest', dateStr?: string): Promise<PublishResult> {
  try {
    const cfg = getConfig()
    const date = source === 'date' && dateStr ? dateStr : new Date().toISOString().slice(0, 10)

    // 1. 生成日报 HTML
    const { generateBilingualDigest } = await import('./bilingualDigest')
    const digest = await generateBilingualDigest(30, true)
    if (!digest.ok) {return { ok: false, error: digest.error || '日报生成失败' }}

    // 2. 克隆/更新仓库
    if (!fs.existsSync(cfg.repoDir)) {
      if (cfg.remote) {
        execSync(`git clone ${cfg.remote} ${cfg.repoDir}`, { stdio: 'pipe', timeout: 60000 })
      } else {
        fs.mkdirSync(cfg.repoDir, { recursive: true })
        execSync('git init', { cwd: cfg.repoDir, stdio: 'pipe' })
        execSync('git checkout -b gh-pages', { cwd: cfg.repoDir, stdio: 'pipe' })
      }
    }

    // 3. 写入 HTML
    const htmlDir = path.join(cfg.repoDir, 'daily')
    if (!fs.existsSync(htmlDir)) {fs.mkdirSync(htmlDir, { recursive: true })}

    const htmlFile = path.join(htmlDir, `${date}.html`)
    const cnHtml = digest.html.replace('</body>',
      `<div class="footer">📡 Lumina 双语日报 · ${date} · <a href="index.html">全部日报</a></div></body>`)
    fs.writeFileSync(htmlFile, cnHtml, 'utf-8')

    // 4. 更新 index.html
    const indexPath = path.join(cfg.repoDir, 'index.html')
    let existingEntries: string[] = []
    if (fs.existsSync(indexPath)) {
      const existingHtml = fs.readFileSync(indexPath, 'utf-8')
      const match = existingHtml.match(/<!-- ENTRIES -->([\s\S]*)<!-- \/ENTRIES -->/)
      if (match) {existingEntries = match[1].split('\n').filter(l => l.trim())}
    }

    const entry = `<div class="entry"><a href="daily/${date}.html">${date}</a><span class="badge">+${digest.items.length}</span></div>`
    existingEntries.unshift(entry)

    const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>📡 Lumina 每日新闻日报站</title>
<style>
  body{font-family:-apple-system,'Microsoft YaHei',sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#f5f5f5;}
  h1{font-size:22px;margin:0 0 4px;} .sub{color:#888;font-size:14px;margin-bottom:24px;}
  .entry{display:flex;align-items:center;padding:12px 16px;background:#fff;border-radius:8px;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);}
  .entry a{flex:1;font-size:15px;color:#333;text-decoration:none;font-weight:500;}
  .entry a:hover{color:#448AFF;}
  .badge{font-size:12px;background:#448AFF;color:#fff;border-radius:12px;padding:2px 10px;}
  .footer{margin-top:32px;text-align:center;font-size:12px;color:#aaa;}
</style></head><body>
  <h1>📡 Lumina 每日新闻日报站</h1>
  <div class="sub">共 ${existingEntries.length} 期 · 自动生成</div>
  <!-- ENTRIES -->
${existingEntries.join('\n')}
  <!-- /ENTRIES -->
  <div class="footer">由 Lumina AI 自动发布 · <a href="https://github.com">源码</a></div>
</body></html>`
    fs.writeFileSync(indexPath, fullHtml, 'utf-8')

    // 5. 提交 + 推送到 gh-pages
    try {
      execSync('git add -A', { cwd: cfg.repoDir, stdio: 'pipe' })
      execSync(`git commit -m "📰 日报更新 ${date}"`, { cwd: cfg.repoDir, stdio: 'pipe' })
      if (cfg.remote) {
        execSync(`git push origin ${cfg.branch}`, { cwd: cfg.repoDir, stdio: 'pipe', timeout: 30000 })
      }
    } catch (e: any) {
      console.warn('[ghPagesPublisher] Git 操作警告:', e.message)
    }

    return {
      ok: true,
      url: cfg.baseUrl ? `${cfg.baseUrl}/daily/${date}.html` : htmlFile,
      date,
      htmlPath: htmlFile,
    }
  } catch (err: any) {
    return { ok: false, error: `发布失败: ${err.message}` }
  }
}
