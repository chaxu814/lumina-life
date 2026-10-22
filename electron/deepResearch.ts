// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// deepResearch.ts — Deep Research 深度调研引擎 (v3.11)
//
// 对标：Perplexity Computer / OpenAI Deep Research
//
// 流程：
//   1. 用户提出问题
//   2. 拆解为子问题 → 多轮搜索
//   3. 交叉验证 → 来源对比 → 置信度评估
//   4. 生成结构化研究报告 (Markdown)
//
// 特点：
//   - 递归深度搜索（自动发现新关键词继续搜）
//   - 来源可信度加权（官方 > 维基 > 媒体 > 个人）
//   - 分歧标注（多个来源说法矛盾时标红）
//   - 引用追踪（每条结论必须有来源）
// ============================================================

import https from 'https'
import http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
// 🆕 2026-10-12: 复用项目内已验证的搜索栈（净化 → 多引擎回退 → 相关性过滤）
//   与单页正文抓取。此前本文件自己打 DDG 即时答案 API，实测不可达，
//   导致整个深度调研流水线恒产出空报告。
import { searchStructured, fetchReadablePage } from './tools/impl/search'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface ResearchSource {
  url: string
  title: string
  snippet: string
  domain: string
  credibility: number       // 0-10
  fetchedAt: string
  content?: string          // 完整抓取内容
}

export interface ResearchFinding {
  claim: string
  sources: ResearchSource[]
  confidence: number        // 0-1
  consensus: 'confirmed' | 'likely' | 'disputed' | 'unverified'
  conflictingSources?: ResearchSource[]
}

export interface ResearchReport {
  title: string
  question: string
  summary: string
  findings: ResearchFinding[]
  keyInsights: string[]
  sources: ResearchSource[]
  searchQueries: string[]
  confidence: number
  generatedAt: string
  durationMs: number
}

export interface DRConfig {
  llmApiKey?: string
  llmBaseUrl?: string
  llmModel?: string
  maxRounds?: number          // 最大搜索轮次
  sourcesPerRound?: number    // 每轮搜索来源数
  minConfidence?: number      // 最低置信度阈值
}

// ═══════════════════════════════════════════════════════════
// Deep Research 引擎
// ═══════════════════════════════════════════════════════════

export class DeepResearch {
  private config: DRConfig
  /**
   * 🆕 2026-10-12: 整个调研过程里**抓取正文的总次数预算**。
   *
   * 为什么要设上限：一轮调研会搜多条查询（拆解子问题 + 递归发现新关键词），
   * 每次搜索若都抓 2 条正文，12 次搜索就是 24 次网页请求 ——
   * 单页超时 10s，最坏情况要几分钟，用户会以为卡死。
   * 抓正文的价值主要在"给后续提取/交叉验证提供真实材料"，
   * 前几篇就够用，不必每轮都抓。
   */
  private _pageFetchUsed = 0
  private static readonly PAGE_FETCH_BUDGET = 4

  constructor(config: DRConfig = {}) {
    this.config = {
      maxRounds: 3,
      sourcesPerRound: 5,
      minConfidence: 0.6,
      ...config,
    }
  }

  // ═══════════════════════════════════════════════════════
  // 主流程
  // ═══════════════════════════════════════════════════════

  async research(question: string, onProgress?: (step: string) => void): Promise<ResearchReport> {
    const startTime = Date.now()
    this._pageFetchUsed = 0   // 🆕 2026-10-12: 每次调研重置抓页预算
    const allSources: ResearchSource[] = []
    const allQueries: string[] = []

    onProgress?.('🔍 拆解问题...')

    // 1. 用 LLM 拆解子问题
    const subQuestions = await this.decompose(question)
    allQueries.push(...subQuestions)

    onProgress?.(`📋 拆分为 ${subQuestions.length} 个子问题`)

    // 2. 多轮搜索
    for (let round = 0; round < (this.config.maxRounds || 3); round++) {
      const queries = round === 0 ? subQuestions : await this.discoverNewQueries(question, allSources)
      if (queries.length === 0) {break}

      onProgress?.(`🔎 第 ${round + 1} 轮搜索 (${queries.length} 条查询)...`)

      for (const q of queries) {
        const sources = await this.search(q, this.config.sourcesPerRound || 5)
        allSources.push(...sources)
        allQueries.push(q)
      }
    }

    onProgress?.(`📚 收集 ${allSources.length} 个来源`)

    // 3. 去重 + 可信度评分
    const uniqueSources = this.deduplicateSources(allSources)
    this.scoreCredibility(uniqueSources)

    // 4. LLM 分析 → 提取发现
    onProgress?.('🧠 分析来源...')
    const findings = await this.extractFindings(question, uniqueSources)

    // 5. 交叉验证
    onProgress?.('✅ 交叉验证...')
    const validatedFindings = await this.crossValidate(findings, uniqueSources)

    // 6. 生成报告
    onProgress?.('📝 生成报告...')
    const summary = await this.generateSummary(question, validatedFindings)

    const overallConfidence = validatedFindings.length > 0
      ? validatedFindings.reduce((s, f) => s + f.confidence, 0) / validatedFindings.length
      : 0

    return {
      title: await this.generateTitle(question),
      question,
      summary,
      findings: validatedFindings,
      keyInsights: this.extractKeyInsights(validatedFindings),
      sources: uniqueSources,
      searchQueries: [...new Set(allQueries)],
      confidence: Math.round(overallConfidence * 100) / 100,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    }
  }

  // ═══════════════════════════════════════════════════════
  // 步骤 1: 拆解问题
  // ═══════════════════════════════════════════════════════

  private async decompose(question: string): Promise<string[]> {
    const prompt = `将以下问题拆解为 3-5 个可独立搜索的子问题。每个子问题应：
- 聚焦一个具体方面
- 适合搜索引擎查询（关键词形式）
- 覆盖不同角度

问题：${question}

输出格式（每行一个，不要编号）：`

    try {
      const response = await this.callLLM(prompt, 0.7, 300)
      return response.split('\n')
        .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
        .filter(l => l.length > 3)
    } catch {
      return [question]
    }
  }

  // ═══════════════════════════════════════════════════════
  // 步骤 2: 搜索
  // ═══════════════════════════════════════════════════════

  private async search(query: string, count: number): Promise<ResearchSource[]> {
    // 🐛 2026-10-12 修复（功能级）：
    //   原实现打的是 `https://api.duckduckgo.com/?format=json` —— 那是
    //   **即时答案 API**（只返回百科摘要，不是网页搜索），而且实测
    //   **三个查询全部超时不可达**。于是「帮我调研 X」走进本工具后，
    //   搜索恒返回空数组 → 多轮调研流水线跑完只产出一份空报告。
    //
    //   现在改用项目内已验证的搜索栈（electron/tools/impl/search.ts）：
    //   净化查询 → 多引擎回退 → 相关性过滤 → 排序，拿到的是真正的网页结果。
    try {
      const results = await searchStructured(query, count)
      const sources: ResearchSource[] = results.map(r => ({
        url: r.link,
        title: r.title,
        snippet: r.desc,
        domain: this.extractDomain(r.link),
        credibility: 5, // 默认中等可信度
        fetchedAt: new Date().toISOString(),
      }))

      // 🆕 2026-10-12: 深度调研不能只看搜索摘要 —— 抓前几条正文，
      //   让后续「提取发现 / 交叉验证」有真正的材料可依据（这才是"爬虫"该做的）。
      //   抓不到（反爬/JS 渲染）就静默跳过，摘要仍然可用。
      //   总次数受 PAGE_FETCH_BUDGET 限制，避免多轮调研把时间耗在抓页面上。
      const budget = Math.max(0, DeepResearch.PAGE_FETCH_BUDGET - this._pageFetchUsed)
      const targets = sources.slice(0, Math.min(2, budget))
      this._pageFetchUsed += targets.length
      await Promise.all(targets.map(async (s) => {
        const page = await fetchReadablePage(s.url)
        if (page && page.text.length > 200) {
          s.snippet = `${s.snippet}\n\n[正文节选] ${page.text.slice(0, 1200)}`
        }
      }))

      return sources
    } catch (err: any) {
      console.warn('[deepResearch] 搜索失败:', err?.message || err)
      return []
    }
  }

  // ═══════════════════════════════════════════════════════
  // 步骤 3: 发现新查询
  // ═══════════════════════════════════════════════════════

  private async discoverNewQueries(question: string, existingSources: ResearchSource[]): Promise<string[]> {
    const existing = existingSources.map(s => s.title + ': ' + s.snippet).join('\n')
    const prompt = `基于现有搜索结果，发现 2-3 个相关但未覆盖的新搜索方向。

## 原问题
${question}

## 已有结果
${existing.slice(0, 2000)}

输出新搜索关键词（每行一个）：`

    try {
      const response = await this.callLLM(prompt, 0.8, 200)
      return response.split('\n')
        .map(l => l.replace(/^[-*\d]+[\.\)]\s*/, '').trim())
        .filter(l => l.length > 3)
    } catch {
      return []
    }
  }

  // ═══════════════════════════════════════════════════════
  // 步骤 4: 提取发现
  // ═══════════════════════════════════════════════════════

  private async extractFindings(question: string, sources: ResearchSource[]): Promise<ResearchFinding[]> {
    const sourcesText = sources.map((s, i) =>
      `[${i}] ${s.title}\n   URL: ${s.url}\n   ${s.snippet}`
    ).join('\n\n')

    const prompt = `分析以下搜索结果，提取 3-7 个关键发现。

## 问题
${question}

## 搜索结果
${sourcesText.slice(0, 4000)}

## 输出 JSON 数组
[{
  "claim": "关键发现（一句话）",
  "sourceIndices": [0, 2],
  "confidence": 0.8,
  "consensus": "confirmed|likely|disputed"
}]

规则：
- claim: 具体的事实性发现
- confidence: 0-1，来源越多越可信
- consensus: 多个来源一致=confirmed，单一来源=likely，来源矛盾=disputed
- 只输出 JSON`

    try {
      const response = await this.callLLM(prompt, 0.4, 2000)
      const json = JSON.parse(response.match(/\[[\s\S]*\]/)?.[0] || '[]')
      return json.map((f: any) => ({
        claim: f.claim,
        sources: (f.sourceIndices || []).map((i: number) => sources[i]).filter(Boolean),
        confidence: f.confidence || 0.5,
        consensus: f.consensus || 'likely',
      }))
    } catch {
      // 回退：每个来源一个发现
      return sources.slice(0, 5).map(s => ({
        claim: s.snippet.slice(0, 200),
        sources: [s],
        confidence: 0.4,
        consensus: 'unverified' as const,
      }))
    }
  }

  // ═══════════════════════════════════════════════════════
  // 步骤 5: 交叉验证
  // ═══════════════════════════════════════════════════════

  private async crossValidate(findings: ResearchFinding[], sources: ResearchSource[]): Promise<ResearchFinding[]> {
    for (const finding of findings) {
      // 检查是否有来源矛盾
      const conflicting = this.findConflictingSources(finding.claim, sources, finding.sources)
      if (conflicting.length > 0) {
        finding.conflictingSources = conflicting
        finding.consensus = 'disputed'
        finding.confidence = Math.max(0.1, finding.confidence - 0.3)
      } else if (finding.sources.length >= 3) {
        finding.consensus = 'confirmed'
        finding.confidence = Math.min(1, finding.confidence + 0.1)
      }
    }
    return findings.filter(f => f.confidence >= (this.config.minConfidence || 0.6))
  }

  private findConflictingSources(claim: string, allSources: ResearchSource[], currentSources: ResearchSource[]): ResearchSource[] {
    // 基于关键词匹配判断是否有矛盾
    const claimWords = new Set(claim.toLowerCase().split(/\s+/))
    const currentDomain = new Set(currentSources.map(s => s.domain))
    return allSources.filter(s =>
      !currentDomain.has(s.domain) &&
      this.hasOpposingKeywords(claimWords, s.snippet)
    )
  }

  private hasOpposingKeywords(claimWords: Set<string>, snippet: string): boolean {
    const opposing = ['然而', '但是', '不过', '实际上', '并非', '不准确', '相反', 'however', 'but', 'actually', 'not', 'contrary', 'disputed', 'controversial', 'debunked']
    const snippetLower = snippet.toLowerCase()
    return opposing.some(w => snippetLower.includes(w))
  }

  // ═══════════════════════════════════════════════════════
  // 步骤 6: 生成总结
  // ═══════════════════════════════════════════════════════

  private async generateSummary(question: string, findings: ResearchFinding[]): Promise<string> {
    const findingsText = findings.map(f =>
      `- ${f.claim} [置信度: ${f.confidence}, 来源: ${f.sources.map(s => s.domain).join(', ')}]`
    ).join('\n')

    const prompt = `基于以下研究发现，生成一段 150-200 字的总结摘要。

## 原始问题
${question}

## 研究发现
${findingsText}

要求：中立客观、结构清晰、直接回答核心问题。`

    try {
      return await this.callLLM(prompt, 0.5, 400)
    } catch {
      return findings.map(f => f.claim).join('；')
    }
  }

  private async generateTitle(question: string): Promise<string> {
    try {
      return await this.callLLM(`为以下研究问题生成简洁标题（15字以内）：${question}`, 0.7, 50)
    } catch {
      return question.slice(0, 30)
    }
  }

  private extractKeyInsights(findings: ResearchFinding[]): string[] {
    return findings
      .filter(f => f.consensus === 'confirmed' && f.confidence >= 0.8)
      .map(f => f.claim)
  }

  // ═══════════════════════════════════════════════════════
  // 可信度评分
  // ═══════════════════════════════════════════════════════

  private scoreCredibility(sources: ResearchSource[]): void {
    const domainScores: Record<string, number> = {
      'wikipedia.org': 8,
      'github.com': 7,
      'arxiv.org': 9,
      'nature.com': 9,
      'science.org': 9,
      'ieee.org': 9,
      'bbc.com': 7,
      'reuters.com': 8,
      'bloomberg.com': 7,
      'nytimes.com': 7,
      'medium.com': 4,
      'reddit.com': 3,
      'twitter.com': 2,
      'weixin.qq.com': 3,
      'zhihu.com': 5,
      'csdn.net': 5,
      'github.io': 4,
    }

    for (const source of sources) {
      for (const [domain, score] of Object.entries(domainScores)) {
        if (source.domain.includes(domain)) {
          source.credibility = score
          break
        }
      }
      // 官方/政府网站加分
      if (source.domain.endsWith('.gov') || source.domain.endsWith('.gov.cn')) {
        source.credibility = Math.max(source.credibility, 8)
      }
      if (source.domain.endsWith('.edu') || source.domain.endsWith('.edu.cn')) {
        source.credibility = Math.max(source.credibility, 7)
      }
    }
  }

  private deduplicateSources(sources: ResearchSource[]): ResearchSource[] {
    const seen = new Set<string>()
    return sources.filter(s => {
      const key = s.url || s.title
      if (seen.has(key)) {return false}
      seen.add(key)
      return true
    })
  }

  // ═══════════════════════════════════════════════════════
  // 报告导出
  // ═══════════════════════════════════════════════════════

  toMarkdown(report: ResearchReport): string {
    const confidenceEmoji = report.confidence >= 0.8 ? '🟢' : report.confidence >= 0.5 ? '🟡' : '🔴'

    return `# ${report.title}

> ${confidenceEmoji} 综合置信度: ${(report.confidence * 100).toFixed(0)}%
> ⏱️ 耗时: ${(report.durationMs / 1000).toFixed(1)}s
> 📅 生成: ${report.generatedAt}

## 📋 研究问题
${report.question}

## 📝 摘要
${report.summary}

## 🔑 关键发现
${report.keyInsights.map((k, i) => `${i + 1}. ${k}`).join('\n')}

## 📊 详细发现
${report.findings.map((f, i) => {
  const status = f.consensus === 'confirmed' ? '✅' : f.consensus === 'disputed' ? '⚠️' : '📌'
  return `### ${status} 发现 ${i + 1} (置信度: ${(f.confidence * 100).toFixed(0)}%)
${f.claim}

**来源:**
${f.sources.map(s => `- [${s.title}](${s.url}) (${s.domain}, 可信度: ${s.credibility}/10)`).join('\n')}
${f.conflictingSources ? `\n⚠️ **争议来源:**\n${f.conflictingSources.map(s => `- [${s.title}](${s.url})`).join('\n')}` : ''}`
}).join('\n\n')}

## 📚 所有来源
${report.sources.map(s => `- [${s.title}](${s.url}) | ${s.domain} | ⭐${s.credibility}`).join('\n')}

## 🔍 搜索查询
${report.searchQueries.map(q => `- ${q}`).join('\n')}

---
*由 Lumina Deep Research 引擎生成 · v3.11*
`
  }

  // ═══════════════════════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════════════════════

  private async callLLM(prompt: string, temperature = 0.5, maxTokens = 1000): Promise<string> {
    const apiKey = this.config.llmApiKey || process.env.OPENAI_API_KEY || ''
    const baseUrl = this.config.llmBaseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com'
    const model = this.config.llmModel || process.env.LLM_MODEL || 'gpt-4o-mini'

    if (!apiKey) {return ''}

    const url = new URL(baseUrl.replace(/\/+$/, '') + '/chat/completions')
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http

    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature,
    })

    return new Promise((resolve, reject) => {
      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        timeout: 30000,
      }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).choices?.[0]?.message?.content || '')
          } catch { resolve('') }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); resolve('') })
      req.write(body)
      req.end()
    })
  }

  private async fetchJson(url: string): Promise<any> {
    return new Promise((resolve) => {
      const transport = url.startsWith('https:') ? https : http
      transport.get(url, { timeout: 10000 }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({}) }
        })
      }).on('error', () => resolve({}))
    })
  }

  private extractDomain(url: string): string {
    try { return new URL(url).hostname } catch { return '' }
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: DeepResearch | null = null

export function initDeepResearch(config?: DRConfig): DeepResearch {
  _instance = new DeepResearch(config)
  return _instance
}

export function getDeepResearch(): DeepResearch {
  if (!_instance) {_instance = new DeepResearch()}
  return _instance
}
