// ============================================================
// impl/git.ts — Git 操作工具
// ============================================================

import { exec } from 'child_process'
import type { ToolDef, ToolResult } from '../types'

function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = exec(`git ${args.join(' ')}`, { cwd, timeout: 30000, windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('close', (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code || 0 }))
    child.on('error', () => resolve({ stdout: '', stderr: 'git 命令执行失败', code: -1 }))
  })
}

export const gitStatusDef: ToolDef = {
  name: 'git_status',
  description: '查看 Git 仓库状态。显示变更文件列表。',
  params: { cwd: { type: 'string', description: '仓库路径', required: true } },
  toolsets: ['agent', 'developer'],
}

export async function gitStatus(args: Record<string, any>): Promise<ToolResult> {
  const r = await runGit(['status', '--short'], args.cwd)
  if (r.code !== 0) {return { callId: '', ok: false, content: '', error: r.stderr || r.stdout }}
  return { callId: '', ok: true, content: r.stdout || '(工作区干净)' }
}

export const gitCommitDef: ToolDef = {
  name: 'git_commit',
  description: 'Git 提交变更。自动 git add -A + commit。',
  params: {
    cwd: { type: 'string', description: '仓库路径', required: true },
    message: { type: 'string', description: '提交信息', required: true },
  },
  toolsets: ['agent', 'developer'],
  dangerous: true,
}

export async function gitCommit(args: Record<string, any>): Promise<ToolResult> {
  await runGit(['add', '-A'], args.cwd)
  const r = await runGit(['commit', '-m', args.message], args.cwd)
  if (r.code !== 0) {return { callId: '', ok: false, content: '', error: r.stderr || r.stdout }}
  return { callId: '', ok: true, content: r.stdout || '提交成功' }
}

export const gitLogDef: ToolDef = {
  name: 'git_log',
  description: '查看 Git 提交日志',
  params: {
    cwd: { type: 'string', description: '仓库路径', required: true },
    count: { type: 'number', description: '显示条数，默认 5', required: false },
  },
  toolsets: ['agent', 'developer'],
}

export async function gitLog(args: Record<string, any>): Promise<ToolResult> {
  const count = args.count || 5
  const r = await runGit(['log', `-${count}`, '--oneline', '--decorate'], args.cwd)
  if (r.code !== 0) {return { callId: '', ok: false, content: '', error: r.stderr }}
  return { callId: '', ok: true, content: r.stdout || '(无提交记录)' }
}

export const gitDiffDef: ToolDef = {
  name: 'git_diff',
  description: '查看 Git 工作区变更详情',
  params: { cwd: { type: 'string', description: '仓库路径', required: true } },
  toolsets: ['agent', 'developer'],
}

export async function gitDiff(args: Record<string, any>): Promise<ToolResult> {
  const r = await runGit(['diff', '--stat'], args.cwd)
  if (r.code !== 0) {return { callId: '', ok: false, content: '', error: r.stderr }}
  return { callId: '', ok: true, content: r.stdout || '(无变更)' }
}
