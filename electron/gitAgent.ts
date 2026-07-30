// ============================================================
// gitAgent.ts — Aider 式 Git 自动集成 (v3.11)
//
// 对标 Aider (25K⭐) — Git 原生工作流
//
// 功能：
//   - 自动 git diff 分析变更
//   - LLM 生成合规 commit message (Conventional Commits)
//   - 自动 commit + push
//   - 编程协作模式集成：热茶/Yak 写代码 → Lumina 审查 → 自动提交
//   - 安全：只提交工作区内的变更，never force push
// ============================================================

import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import https from 'https'
import http from 'http'

const execAsync = promisify(exec)

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface GitStatus {
  branch: string
  ahead: number
  behind: number
  staged: GitFile[]
  unstaged: GitFile[]
  untracked: GitFile[]
  clean: boolean
}

export interface GitFile {
  path: string
  status: 'M' | 'A' | 'D' | 'R' | '??'
  oldPath?: string  // 重命名时
  diff?: string
}

export interface GitCommitResult {
  success: boolean
  message?: string
  hash?: string
  filesChanged: number
  insertions: number
  deletions: number
  error?: string
}

export interface GitDiffAnalysis {
  summary: string
  files: string[]
  suggestedType: 'feat' | 'fix' | 'refactor' | 'docs' | 'style' | 'test' | 'chore' | 'perf'
  suggestedScope?: string
  breakingChange: boolean
}

// ═══════════════════════════════════════════════════════════
// Git Agent
// ═══════════════════════════════════════════════════════════

export class GitAgent {
  private repoPath: string
  private llmConfig: { apiKey?: string; baseUrl?: string; model?: string }

  constructor(repoPath: string, llmConfig?: { apiKey?: string; baseUrl?: string; model?: string }) {
    this.repoPath = repoPath
    this.llmConfig = llmConfig || {}
  }

  // ═══════════════════════════════════════════════════════
  // 状态查询
  // ═══════════════════════════════════════════════════════

  async getStatus(): Promise<GitStatus> {
    const { stdout: branchOut } = await this.exec('git rev-parse --abbrev-ref HEAD')
    const branch = branchOut.trim()

    let ahead = 0, behind = 0
    try {
      const { stdout: countOut } = await this.exec('git rev-list --count --left-right origin/' + branch + '...HEAD 2>/dev/null || echo "0\t0"')
      const [a, b] = countOut.trim().split('\t').map(Number)
      ahead = a || 0; behind = b || 0
    } catch { /* no remote */ }

    const { stdout: statusOut } = await this.exec('git status --porcelain')
    const lines = statusOut.trim().split('\n').filter(Boolean)

    const staged: GitFile[] = []
    const unstaged: GitFile[] = []
    const untracked: GitFile[] = []

    for (const line of lines) {
      const statusCode = line.substring(0, 2)
      const filePath = line.substring(3).trim()

      if (statusCode.startsWith('??')) {
        untracked.push({ path: filePath, status: '??' })
      } else if (statusCode[0] !== ' ' && statusCode[1] === ' ') {
        // Staged but maybe modified in working tree
        staged.push({ path: filePath, status: statusCode[0] as GitFile['status'] })
      } else if (statusCode[0] === ' ' && statusCode[1] !== ' ') {
        unstaged.push({ path: filePath, status: statusCode[1] as GitFile['status'] })
      } else {
        // Both staged and unstaged changes
        staged.push({ path: filePath, status: statusCode[0] as GitFile['status'] })
      }
    }

    return { branch, ahead, behind, staged, unstaged, untracked, clean: lines.length === 0 }
  }

  async getDiff(staged = false): Promise<string> {
    const flag = staged ? '--staged' : ''
    try {
      const { stdout } = await this.exec(`git diff ${flag} -- .`)
      return stdout || '(no changes)'
    } catch {
      return '(error getting diff)'
    }
  }

  async getLog(count = 5): Promise<string> {
    const { stdout } = await this.exec(`git log --oneline -${count}`)
    return stdout
  }

  // ═══════════════════════════════════════════════════════
  // LLM 分析 diff
  // ═══════════════════════════════════════════════════════

  async analyzeDiff(diff: string): Promise<GitDiffAnalysis> {
    if (!diff || diff === '(no changes)') {
      return { summary: '无变更', files: [], suggestedType: 'chore', breakingChange: false }
    }

    // 提取文件名
    const files = diff.match(/diff --git a\/(.+?) b\//g)?.map(m =>
      m.replace('diff --git a/', '').replace(/ b\/.*/, '')
    ) || []

    // 用 LLM 分析
    if (this.llmConfig.apiKey) {
      try {
        const analysis = await this.callLLM(this.buildDiffPrompt(diff, files))
        return this.parseDiffAnalysis(analysis, files)
      } catch { /* fallback */ }
    }

    // 规则回退
    return this.fallbackDiffAnalysis(diff, files)
  }

  private buildDiffPrompt(diff: string, files: string[]): string {
    return `分析以下 git diff，按 Conventional Commits 规范建议 commit 信息。

## 变更文件
${files.map(f => '- ' + f).join('\n')}

## Diff
\`\`\`diff
${diff.slice(0, 3000)}
\`\`\`

## 输出 JSON (严格遵守)
{
  "summary": "一句话总结变更",
  "type": "feat|fix|refactor|docs|style|test|chore|perf",
  "scope": "影响的模块名或空",
  "breakingChange": true/false,
  "message": "完整的commit message (中文，50字内)"
}

只输出 JSON。`
  }

  private parseDiffAnalysis(response: string, files: string[]): GitDiffAnalysis {
    try {
      const json = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] || '{}')
      return {
        summary: json.summary || '代码变更',
        files,
        suggestedType: json.type || 'chore',
        suggestedScope: json.scope || undefined,
        breakingChange: json.breakingChange || false,
      }
    } catch {
      return this.fallbackDiffAnalysis('', files)
    }
  }

  private fallbackDiffAnalysis(diff: string, files: string[]): GitDiffAnalysis {
    const isNew = diff.includes('new file')
    const hasDelete = diff.includes('deleted file')
    const hasTest = files.some(f => f.includes('test') || f.includes('spec'))
    const hasDoc = files.some(f => f.endsWith('.md'))

    let type: GitDiffAnalysis['suggestedType'] = 'chore'
    if (isNew) type = 'feat'
    else if (hasDelete) type = 'refactor'
    else if (hasTest) type = 'test'
    else if (hasDoc) type = 'docs'

    return { summary: `${type}: 更新 ${files.length} 个文件`, files, suggestedType: type, breakingChange: false }
  }

  // ═══════════════════════════════════════════════════════
  // LLM 生成 commit message
  // ═══════════════════════════════════════════════════════

  async generateCommitMessage(diff: string): Promise<string> {
    if (!this.llmConfig.apiKey) {
      const { suggestedType, suggestedScope } = await this.analyzeDiff(diff)
      const scope = suggestedScope ? `(${suggestedScope})` : ''
      return `${suggestedType}${scope}: 自动提交`
    }

    try {
      const analysis = await this.analyzeDiff(diff)
      const { suggestedType, suggestedScope, breakingChange } = analysis

      const prompt = `根据 git diff 生成一条 Conventional Commit message (中文)。

## 规则
- 格式: type(scope): 描述
- type 是 ${suggestedType}
- 描述用中文，简洁精准，50字以内
- 描述用户能理解的变更内容，不要技术堆砌
${breakingChange ? '- ⚠️ 这是破坏性变更，加 BREAKING CHANGE footer' : ''}

## Diff
\`\`\`diff
${diff.slice(0, 2000)}
\`\`\`

输出纯文本 commit message，不要引号。`

      const msg = await this.callLLM(prompt)
      // 清理
      const cleaned = msg.trim()
        .replace(/^["']|["']$/g, '')
        .replace(/^commit message:?\s*/i, '')
        .split('\n')[0]
      return cleaned || `${suggestedType}${suggestedScope ? `(${suggestedScope})` : ''}: 代码更新`
    } catch {
      return 'chore: 自动提交'
    }
  }

  // ═══════════════════════════════════════════════════════
  // 操作
  // ═══════════════════════════════════════════════════════

  async stage(files?: string[]): Promise<boolean> {
    try {
      if (files && files.length > 0) {
        await this.exec(`git add ${files.map(f => `"${f}"`).join(' ')}`)
      } else {
        await this.exec('git add -A')
      }
      return true
    } catch { return false }
  }

  async commit(message: string): Promise<GitCommitResult> {
    try {
      await this.exec(`git commit -m "${message.replace(/"/g, '\\"')}"`)
      const { stdout: hash } = await this.exec('git rev-parse --short HEAD')
      const { stdout: stats } = await this.exec('git diff --stat HEAD~1..HEAD 2>/dev/null || echo "0 files changed"')

      const filesMatch = stats.match(/(\d+) files? changed/)?.[1]
      const insertMatch = stats.match(/(\d+) insertions?/)?.[1]
      const deleteMatch = stats.match(/(\d+) deletions?/)?.[1]

      return {
        success: true,
        message,
        hash: hash.trim(),
        filesChanged: Number(filesMatch) || 0,
        insertions: Number(insertMatch) || 0,
        deletions: Number(deleteMatch) || 0,
      }
    } catch (err: any) {
      return { success: false, error: err.message, filesChanged: 0, insertions: 0, deletions: 0 }
    }
  }

  async autoCommit(files?: string[]): Promise<GitCommitResult> {
    // 1. 获取 diff
    await this.stage(files)
    const diff = await this.getDiff(true)

    if (!diff || diff === '(no changes)') {
      return { success: false, error: '无变更可提交', filesChanged: 0, insertions: 0, deletions: 0 }
    }

    // 2. LLM 生成 message
    const message = await this.generateCommitMessage(diff)

    // 3. 提交
    return this.commit(message)
  }

  async push(): Promise<boolean> {
    try {
      await this.exec('git push')
      return true
    } catch { return false }
  }

  async pull(): Promise<boolean> {
    try {
      await this.exec('git pull --rebase')
      return true
    } catch { return false }
  }

  /** 一键：add → analyze → commit → push */
  async autoCommitAndPush(files?: string[]): Promise<GitCommitResult & { pushed: boolean }> {
    const result = await this.autoCommit(files)
    if (!result.success) return { ...result, pushed: false }
    const pushed = await this.push()
    return { ...result, pushed }
  }

  /** 创建分支 */
  async createBranch(name: string): Promise<boolean> {
    try {
      await this.exec(`git checkout -b "${name}"`)
      return true
    } catch { return false }
  }

  // ═══════════════════════════════════════════════════════
  // LLM
  // ═══════════════════════════════════════════════════════

  private async callLLM(prompt: string): Promise<string> {
    const apiKey = this.llmConfig.apiKey || ''
    const baseUrl = this.llmConfig.baseUrl || 'https://api.openai.com'
    const model = this.llmConfig.model || 'gpt-4o-mini'

    const url = new URL(baseUrl.replace(/\/+$/, '') + '/chat/completions')
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http

    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.3,
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
        timeout: 15000,
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

  private async exec(cmd: string): Promise<{ stdout: string; stderr: string }> {
    return execAsync(cmd, { cwd: this.repoPath, timeout: 30000 })
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: GitAgent | null = null

export function initGitAgent(repoPath: string, llmConfig?: any): GitAgent {
  _instance = new GitAgent(repoPath, llmConfig)
  return _instance
}

export function getGitAgent(): GitAgent {
  if (!_instance) throw new Error('GitAgent 未初始化')
  return _instance
}
