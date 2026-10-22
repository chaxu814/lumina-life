// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// gitWorktree.ts — 任务隔离工作区 (v3.20, 同类工程实践：git worktree 隔离)
//
// 同类项目给每个 Code worker 开独立 git worktree：
//   并行改代码互不踩文件、不污染主工作区，验收通过后再合并。
//
// Lumina 落地：
//   - 仓库内（有 .git）：git worktree add 到 <repo>/.lumina-worktrees/<name>
//   - 非仓库目录：降级为临时目录 os.tmpdir()/lumina-tasks/<name>，仍保证互不干扰
//
// 纯解析函数（parseWorktreePorcelain / buildWorktreeArgs）可单测，
// 真正执行 git 的部分走 child_process。
// ============================================================

import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface WorktreeInfo {
  path: string
  branch: string | null
  head: string | null
  detached: boolean
}

export interface WorktreeHandle {
  /** 工作目录（worker 在这个目录下干活） */
  workdir: string
  /** worktree 名称 */
  name: string
  /** true=git worktree；false=降级的临时目录 */
  isGit: boolean
  /** 分支名（临时目录为 null） */
  branch: string | null
}

// ═══════════════════════════════════════════════════════════
// 纯函数（可单测）
// ═══════════════════════════════════════════════════════════

/** 解析 `git worktree list --porcelain` 输出 */
export function parseWorktreePorcelain(text: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = []
  let cur: Partial<WorktreeInfo> | null = null
  const flush = () => {
    if (cur && cur.path) {
      out.push({
        path: cur.path!,
        branch: cur.branch ?? null,
        head: cur.head ?? null,
        detached: !!cur.detached,
      })
    }
    cur = null
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^worktree\s/.test(line)) {
      if (cur) {flush()}
      cur = { path: line.replace(/^worktree\s+/, '').trim() }
    } else if (!cur) {
      continue
    } else if (/^HEAD\s/.test(line)) {
      cur.head = line.replace(/^HEAD\s+/, '').trim()
    } else if (/^branch\s/.test(line)) {
      // refs/heads/feature/x → feature/x
      cur.branch = line.replace(/^branch\s+refs\/heads\//, '').trim()
    } else if (/^detached$/.test(line)) {
      cur.detached = true
    }
  }
  flush()
  return out
}

/** 安全的 worktree 名：只允许字母数字下划线横线 */
export function sanitizeName(name: string): string {
  const cleaned = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)
  return cleaned || `wt_${Date.now()}`
}

// ═══════════════════════════════════════════════════════════
// git 执行
// ═══════════════════════════════════════════════════════════

function run(cmd: string, args: string[], cwd: string, timeout = 30_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

/** 是否 git 仓库（含 worktree 自身） */
export async function isGitRepo(repoPath: string): Promise<boolean> {
  if (!fs.existsSync(repoPath)) {return false}
  const r = await run('git', ['rev-parse', '--is-inside-work-tree'], repoPath)
  return r.ok && r.stdout.trim() === 'true'
}

/** 仓库根目录（worktree 内调用也能拿到主仓库根） */
export async function repoRoot(repoPath: string): Promise<string | null> {
  const r = await run('git', ['rev-parse', '--show-toplevel'], repoPath)
  return r.ok ? r.stdout.trim() : null
}

/** 当前分支名（detached 时返回 null），v3.30 worktree 自动合并用 */
export async function currentBranch(repoPath: string): Promise<string | null> {
  const r = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
  if (!r.ok) {return null}
  const b = r.stdout.trim()
  return b && b !== 'HEAD' ? b : null
}

/** 列出 worktree */
export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const r = await run('git', ['worktree', 'list', '--porcelain'], repoPath)
  if (!r.ok) {return []}
  return parseWorktreePorcelain(r.stdout)
}

/**
 * 创建隔离工作区。
 * @param basePath 项目目录（git 仓库或普通目录）
 * @param nameHint 任务名（自动清洗）
 */
export async function createWorktree(basePath: string, nameHint: string): Promise<WorktreeHandle> {
  const name = sanitizeName(`${nameHint}_${Date.now().toString(36)}`)
  const git = await isGitRepo(basePath)

  if (!git) {
    // 降级：临时目录（不做文件复制，worker 用绝对路径读写主目录文件）
    const dir = path.join(os.tmpdir(), 'lumina-tasks', name)
    fs.mkdirSync(dir, { recursive: true })
    return { workdir: dir, name, isGit: false, branch: null }
  }

  const root = await repoRoot(basePath) || basePath
  const wtDir = path.join(root, '.lumina-worktrees', name)
  fs.mkdirSync(path.dirname(wtDir), { recursive: true })
  const branch = `lumina/${name}`
  const r = await run('git', ['worktree', 'add', '-b', branch, wtDir], root)
  if (!r.ok) {
    // 分支已存在等异常 → 退回普通 add（detached）
    const r2 = await run('git', ['worktree', 'add', '--detach', wtDir], root)
    if (!r2.ok) {
      throw new Error(`创建 worktree 失败: ${r.stderr.trim() || r2.stderr.trim()}`)
    }
    return { workdir: wtDir, name, isGit: true, branch: null }
  }
  return { workdir: wtDir, name, isGit: true, branch }
}

/** 移除 worktree（force=true 时连未提交改动一起丢弃） */
export async function removeWorktree(handle: WorktreeHandle, force = false): Promise<boolean> {
  if (!handle.isGit) {
    try {fs.rmSync(handle.workdir, { recursive: true, force: true })} catch { /* ignore */ }
    return true
  }
  const root = await repoRoot(handle.workdir)
  if (!root) {return false}
  const args = ['worktree', 'remove', handle.workdir, ...(force ? ['--force'] : [])]
  const r = await run('git', args, root)
  if (!r.ok && !force) {
    // 有改动时自动加 force 再试一次（隔离工作区，丢弃可接受）
    const r2 = await run('git', ['worktree', 'remove', '--force', handle.workdir], root)
    return r2.ok
  }
  return r.ok
}

/**
 * 把 worktree 分支合并回主分支（验收通过后）。
 * @returns 合并结果文本
 */
export async function mergeWorktree(
  handle: WorktreeHandle,
  targetBranch = 'main',
): Promise<{ ok: boolean; message: string }> {
  if (!handle.isGit || !handle.branch) {
    return { ok: false, message: '非 git worktree（临时目录），无分支可合并' }
  }
  const root = await repoRoot(handle.workdir)
  if (!root) {return { ok: false, message: '找不到仓库根' }}
  const r = await run('git', ['merge', '--no-ff', handle.branch, '-m', `Lumina: merge ${handle.branch}`], root, 60_000)
  if (!r.ok) {
    // 合并冲突：中止并报错（留给上层处理）
    await run('git', ['merge', '--abort'], root)
    return { ok: false, message: `合并冲突或失败: ${r.stderr.trim()}` }
  }
  return { ok: true, message: r.stdout.trim() || '合并完成' }
}
