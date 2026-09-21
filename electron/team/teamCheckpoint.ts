// ============================================================
// teamCheckpoint.ts — 团队任务整轮 Diff 检查点 / 一键回滚 (v3.33)
//
// cc-haha 有「分支/Worktree 启动会话 + 整轮 Diff 可撤销」。
// Lumina 的 code worker 已在独立 worktree 干活、成功后合并回原分支；
// 本模块在「合并前」给主仓库拍一个 git 检查点（分支 + HEAD），
// 合并后若不满意，可一键回到建队前（需要显式 force，git reset --hard）。
//
// 非 git 仓库：snapshot 返回 {isGit:false}，回滚不可用（不报错）。
// ============================================================

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { repoRoot, currentBranch } from './gitWorktree'

export interface Checkpoint {
  id: string
  at: number
  /** 关联任务/团队事件（如 worker id / job title） */
  ref: string
  basePath: string
  branch: string
  head: string
  /** 合并后的 HEAD（回滚时回到合并前的 head） */
  mergedHead?: string
}

function run(cmd: string, args: string[], cwd: string, timeout = 20_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

/** 拍检查点：记录主仓库当前分支与 HEAD */
export async function createCheckpoint(basePath: string, ref: string): Promise<Checkpoint | { isGit: false }> {
  const root = await repoRoot(basePath)
  if (!root) {return { isGit: false }}
  const branch = (await currentBranch(root)) || '(detached)'
  const rev = await run('git', ['rev-parse', 'HEAD'], root)
  if (!rev.ok) {return { isGit: false }}
  const cp: Checkpoint = {
    id: `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    ref,
    basePath: root,
    branch,
    head: rev.stdout.trim(),
  }
  try {getCheckpointStore().add(cp)} catch { /* 落盘失败不阻塞 */ }
  return cp
}

/** 记录合并后的 HEAD（用于展示合并了什么） */
export async function markMerged(cp: Checkpoint): Promise<Checkpoint> {
  const rev = await run('git', ['rev-parse', 'HEAD'], cp.basePath)
  if (rev.ok) {
    cp.mergedHead = rev.stdout.trim()
    try {getCheckpointStore().update(cp)} catch { /* ignore */ }
  }
  return cp
}

/**
 * 回滚：git reset --hard 到检查点的 HEAD。
 * 必须显式传 confirm=true（危险操作，丢弃检查点之后的提交）。
 */
export async function rollbackCheckpoint(cp: Checkpoint, confirm: boolean): Promise<{ ok: boolean; message: string }> {
  if (!confirm) {
    return { ok: false, message: '回滚会丢弃检查点之后的提交，必须显式确认（confirm=true）' }
  }
  const root = await repoRoot(cp.basePath)
  if (!root) {return { ok: false, message: '不是 git 仓库，无法回滚' }}
  // 先回到原分支（检查点可能是在别的分支上拍的）
  const switchRes = await run('git', ['checkout', cp.branch], root)
  if (!switchRes.ok && cp.branch !== '(detached)') {
    return { ok: false, message: `切换分支失败：${switchRes.stderr.trim() || switchRes.stdout}` }
  }
  const reset = await run('git', ['reset', '--hard', cp.head], root)
  if (!reset.ok) {return { ok: false, message: `回滚失败：${reset.stderr.trim()}` }}
  return { ok: true, message: `已回到 ${cp.branch}@${cp.head.slice(0, 8)}（${cp.ref}）` }
}

// ═══════════════════════════════════════════════════════════
// 检查点存储（环形 30 条）
// ═══════════════════════════════════════════════════════════

const CP_CAP = 30

export class CheckpointStore {
  private items: Checkpoint[] = []
  constructor(public readonly filepath: string | null = null) {
    if (filepath) {
      try {
        if (fs.existsSync(filepath)) {
          const raw = JSON.parse(fs.readFileSync(filepath, 'utf-8'))
          if (Array.isArray(raw?.items)) {this.items = raw.items}
        }
      } catch { /* ignore */ }
    }
  }

  private persist(): void {
    if (!this.filepath) {return}
    try {
      fs.mkdirSync(path.dirname(this.filepath), { recursive: true })
      const tmp = this.filepath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }, null, 2), 'utf-8')
      fs.renameSync(tmp, this.filepath)
    } catch { /* ignore */ }
  }

  add(cp: Checkpoint): Checkpoint {
    this.items.push(cp)
    if (this.items.length > CP_CAP) {this.items.splice(0, this.items.length - CP_CAP)}
    this.persist()
    return cp
  }

  update(cp: Checkpoint): void {
    const i = this.items.findIndex(x => x.id === cp.id)
    if (i >= 0) {this.items[i] = cp; this.persist()}
  }

  list(): Checkpoint[] {return [...this.items].reverse()}
  get(id: string): Checkpoint | undefined {return this.items.find(x => x.id === id)}
}

let _instance: CheckpointStore | null = null

function defaultPath(): string {
  const base = app?.getPath ? app.getPath('userData') : process.cwd()
  return path.join(base, 'team', 'checkpoints.json')
}

export function getCheckpointStore(filepath?: string): CheckpointStore {
  if (!_instance || filepath) {
    _instance = new CheckpointStore(filepath || defaultPath())
  }
  return _instance
}
