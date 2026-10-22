// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// impl/codeDaily.ts — 代码日报/周报工具
//
// 通过 git log 统计指定仓库在时间窗口内的：
//   - 提交数、作者分布
//   - 改动文件数（去重）
// 适合下班前自动生成代码日报 / 每周代码周报。
// ============================================================

import { execFile } from 'child_process'
import type { ToolDef, ToolResult } from '../types'

const GIT_TIMEOUT_MS = 15000

function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !(err as any).killed) {
        // git 非零退出也算正常（如没有提交），这里只记录 stderr
      }
      resolve({
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        code: err ? ((err as any).code ?? 1) : 0,
      })
    })
  })
}

interface CommitInfo {
  hash: string
  author: string
  subject: string
}

/** 解析 git log 输出为提交列表 */
function parseCommits(stdout: string): CommitInfo[] {
  const commits: CommitInfo[] = []
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean)
  for (const line of lines) {
    // 格式: "<hash> <subject> (<author>)"
    const m = line.match(/^([0-9a-f]+)\s+(.*?)\s*\(([^)]+)\)\s*$/)
    if (m) {
      commits.push({ hash: m[1], subject: m[2].trim(), author: m[3].trim() })
    }
  }
  return commits
}

/** 统计作者提交分布 */
function authorDistribution(commits: CommitInfo[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const c of commits) {
    map.set(c.author, (map.get(c.author) || 0) + 1)
  }
  return map
}

/** 统计时间窗口内改动的文件数（去重） */
async function countChangedFiles(cwd: string, since: string): Promise<number> {
  const r = await runGit(
    ['log', `--since=${since}`, '--name-only', '--pretty=format:', '--no-merges'],
    cwd,
  )
  const files = new Set(
    r.stdout.split('\n').map(f => f.trim()).filter(Boolean),
  )
  return files.size
}

/** 生成日报/周报正文 */
async function generateReport(cwd: string, since: string, label: string): Promise<ToolResult> {
  if (!cwd) {
    return { callId: '', ok: false, content: '', error: '需要提供 cwd（仓库目录）参数' }
  }

  // 1. 校验是否为 git 仓库
  const rev = await runGit(['rev-parse', '--is-inside-work-tree'], cwd)
  if (rev.code !== 0 || !/true/i.test(rev.stdout.trim())) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: `目录 "${cwd}" 不是 Git 仓库或 git 不可用。`,
    }
  }

  // 2. 拉取提交日志
  const log = await runGit(
    ['log', `--since=${since}`, '--pretty=format:%h %s (%an)', '--no-merges'],
    cwd,
  )
  const commits = parseCommits(log.stdout)

  if (commits.length === 0) {
    return {
      callId: '',
      ok: true,
      content: `📋 代码${label}\n\n目录: ${cwd}\n时间窗口: 近 ${since}\n\n（该时间段内没有新的提交）`,
    }
  }

  // 3. 统计改动文件数
  const fileCount = await countChangedFiles(cwd, since)

  // 4. 作者分布
  const dist = authorDistribution(commits)
  const distLines = [...dist.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([author, n]) => `  - ${author}: ${n} 次提交`)
    .join('\n')

  // 5. 提交列表（最多列 20 条）
  const listLines = commits
    .slice(0, 20)
    .map(c => `  ${c.hash}  ${c.subject}  (${c.author})`)
    .join('\n')
  const more = commits.length > 20 ? `\n  ... 以及另外 ${commits.length - 20} 条提交` : ''

  const body = [
    `📋 代码${label}`,
    ``,
    `目录: ${cwd}`,
    `时间窗口: 近 ${since}`,
    ``,
    `📊 统计:`,
    `  - 提交数: ${commits.length}`,
    `  - 改动文件: ${fileCount} 个`,
    `  - 参与作者: ${dist.size} 人`,
    ``,
    `👥 作者分布:`,
    distLines,
    ``,
    `📝 提交记录:`,
    listLines + more,
  ].join('\n')

  return { callId: '', ok: true, content: body }
}

// ── 工具 1: 日报 ────────────────────────────────────────

export const codeDailyGenerateDef: ToolDef = {
  name: 'code_daily_generate',
  description: `在指定 Git 仓库生成代码日报：统计近 1 天的提交数、作者分布、改动文件数。

参数:
- cwd: Git 仓库的绝对路径`,
  params: {
    cwd: { type: 'string', description: 'Git 仓库目录绝对路径', required: true },
  },
  toolsets: ['agent', 'developer'],
}

export async function codeDailyGenerate(args: Record<string, any>): Promise<ToolResult> {
  try {
    return await generateReport(String(args.cwd || ''), '1 day ago', '日报')
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: `生成代码日报失败: ${err?.message || err}` }
  }
}

// ── 工具 2: 周报 ────────────────────────────────────────

export const codeDailyWeeklyDef: ToolDef = {
  name: 'code_daily_weekly',
  description: `在指定 Git 仓库生成代码周报：统计近 7 天的提交数、作者分布、改动文件数。

参数:
- cwd: Git 仓库的绝对路径`,
  params: {
    cwd: { type: 'string', description: 'Git 仓库目录绝对路径', required: true },
  },
  toolsets: ['agent', 'developer'],
}

export async function codeDailyWeekly(args: Record<string, any>): Promise<ToolResult> {
  try {
    return await generateReport(String(args.cwd || ''), '7 days ago', '周报')
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: `生成代码周报失败: ${err?.message || err}` }
  }
}
