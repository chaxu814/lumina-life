// ============================================================
// tools/impl/devCompanion.ts — 💻 Recha 开发者桌宠陪伴 (I3, v0.1)
//
// 定位：纯效率编码工具和纯陪伴桌宠之间的那道缝——
// 一个「懂代码的陪伴」。Recha 是审查员，她不越权改你代码，只在你埋头写代码时
// 递水、吐槽 commit、长时间调试后关怀一句。
//
// 铁则（AGENTS.md）：
//   · Recha 绝不直接对用户说话——所有意见都写进 teamMailbox（addNotice from='recha'），
//     由 Lumina 转述给用户；
//   · 默认只读：git log/status/diff（只读）、读 package.json/tsconfig，绝不写用户代码库；
//     唯一会写的地方是团队通知板（内存/共享上下文）。
//
// flag：developer.companion（默认 true）。关闭时所有函数直接 no-op。
// 纯决策逻辑（场景判定 / 长调试阈值 / 限流）与 IO 分离，时钟注入，可单测。
// ============================================================

import { exec } from 'child_process'
import * as fs from 'fs'
import type { ToolDef, ToolResult } from '../types'
import { isEnabled } from '../../core/featureFlags'
import { getDelegationManager } from '../../delegationManager'

const clamp01 = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0))

/** 长调试关怀阈值：同一编码场景持续多久没「成功」就递水 */
export const DEV_COMPANION_THRESHOLDS = {
  /** 递水式关怀：连续调试超过 30 分钟 */
  longDebugMs: 30 * 60 * 1000,
  /** 吐槽/关怀频率上限：两次主动搭话至少间隔 10 分钟 */
  quipCooldownMs: 10 * 60 * 1000,
  /** 判定为「编码场景」的文件扩展名 */
  codeExt: ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.c', '.cpp', '.h'],
} as const

/** 用户消息/当前打开文件 → 是否处于编码场景 */
export function isCodingScene(text: string, openFiles: string[] = []): boolean {
  const t = (text || '').toLowerCase()
  const kw = ['bug', '报错', 'error', 'exception', '调试', 'debug', '重构', 'refactor', '编译', 'build',
    '类型错误', 'typeerror', 'undefined', 'npm', 'tsc', 'vitest', 'commit', '合并', 'merge', 'fix']
  if (kw.some(k => t.includes(k))) {return true}
  return openFiles.some(f => DEV_COMPANION_THRESHOLDS.codeExt.some(ext => f.toLowerCase().endsWith(ext)))
}

/** 只读 git 结果快照 */
export interface DevSnapshot {
  clean: boolean
  changedFiles: number
  lastCommit: string
  lastCommitAgoMs: number
  /** package.json 的 name/version（读不到则 null） */
  project: { name: string; version: string } | null
}

function runReadonly(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    exec(`git ${args.join(' ')}`, { cwd, timeout: 15000, windowsHide: true }, (err, stdout) => {
      resolve((stdout || '').trim())
    })
  })
}

/** 只读采集：status --short / log -1 --format / 读 package.json。绝不写任何东西。 */
export async function readOnlyDevSnapshot(cwd: string, now: number = Date.now()): Promise<DevSnapshot> {
  const status = await runReadonly(['status', '--short'], cwd)
  const lines = status ? status.split('\n').filter(Boolean) : []
  let lastCommit = '(无提交)'
  let lastCommitTs = 0
  const log = await runReadonly(['log', '-1', '--format=%h %ci %s'], cwd)
  if (log) {
    lastCommit = log
    const m = log.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)
    if (m) { lastCommitTs = new Date(m[1].replace(' ', 'T')).getTime() }
  }
  let project: DevSnapshot['project'] = null
  try {
    const pkg = JSON.parse(fs.readFileSync(`${cwd}/package.json`, 'utf-8'))
    project = { name: pkg.name || '(未命名)', version: pkg.version || '?' }
  } catch { /* 非 node 项目就读不到，正常 */ }
  return {
    clean: lines.length === 0,
    changedFiles: lines.length,
    lastCommit,
    lastCommitAgoMs: lastCommitTs ? now - lastCommitTs : Infinity,
    project,
  }
}

/** 根据只读快照生成一句非侵入式吐槽/关怀（模板，未配 LLM 也诚实可用） */
export function composeQuip(snap: DevSnapshot): string {
  if (snap.clean) {
    return snap.lastCommitAgoMs > 60 * 60 * 1000
      ? `工作区挺干净，上一次提交是 ${Math.round(snap.lastCommitAgoMs / 3600000)} 小时前——歇会儿再写也来得及。`
      : `工作区干干净净的，状态不错呀。`
  }
  const n = snap.changedFiles
  if (n <= 3) {return `看到你改了 ${n} 个文件，慢慢来，不急。`}
  return `一次改了 ${n} 个文件……记得小步提交，别让 commit 变成「大杂烩」哦。`
}

/** 长时间调试关怀：距离上次「成功」（提交/干净工作区）超过阈值才递水 */
export function longDebugCare(now: number, lastSuccessAt: number, changedFiles: number): string | null {
  if (changedFiles === 0) {return null} // 工作区干净 ≠ 在调试
  const gap = now - lastSuccessAt
  if (gap >= DEV_COMPANION_THRESHOLDS.longDebugMs) {
    const min = Math.round(gap / 60000)
    return `这 ${min} 分钟一直没动 commit，喝口水歇会儿吧——问题不会跑掉的。`
  }
  return null
}

// ── 会话级陪伴状态（限流，避免每句话都插嘴）─────────────────────────
export class DevCompanion {
  private lastQuipAt = 0
  private lastCodingAt: number | null = null

  /** 用户发了一句话/打开了文件；返回该 drop 进 teamMailbox 的话（可能为空表示不插嘴） */
  observe(opts: { text: string; openFiles?: string[]; now: number }): string | null {
    if (!isEnabled('developer.companion')) {return null}
    if (!isCodingScene(opts.text, opts.openFiles || [])) {return null}
    this.lastCodingAt = opts.now
    if (opts.now - this.lastQuipAt < DEV_COMPANION_THRESHOLDS.quipCooldownMs) {return null}
    this.lastQuipAt = opts.now
    return null // 具体吐槽内容由 analyze() 结合 git 快照给，这里只负责「进入编码场景」记录
  }

  /** 结合只读 git 快照，决定这次递什么话；返回空表示不打扰 */
  async analyze(cwd: string, now: number): Promise<string | null> {
    if (!isEnabled('developer.companion')) {return null}
    if (this.lastCodingAt === null) {return null}
    if (now - this.lastQuipAt < DEV_COMPANION_THRESHOLDS.quipCooldownMs) {return null}
    this.lastQuipAt = now
    const snap = await readOnlyDevSnapshot(cwd, now)
    // 长调试关怀优先
    const care = longDebugCare(now, this.lastCodingAt, snap.changedFiles)
    return care ?? composeQuip(snap)
  }

  /** 重置会话状态 */
  reset(): void { this.lastQuipAt = 0; this.lastCodingAt = null }
}

// 单例（供工具与主动调度共用同一份限流状态）
let singleton: DevCompanion | null = null
export function getDevCompanion(): DevCompanion {
  if (!singleton) {singleton = new DevCompanion()}
  return singleton
}

/** 把 Recha 的话写进 teamMailbox（from='recha'），由 Lumina 转述——绝不直发用户 */
export function dropRechaNotice(message: string, priority: 'low' | 'normal' = 'low'): void {
  if (!message) {return}
  try { getDelegationManager().addNotice('recha', message, priority) } catch { /* 团队未就绪则静默 */ }
}

// ── 工具定义（Lumina 调用；结果走 mailbox，不直接对用户说话）─────────
export const devCompanionCheckDef: ToolDef = {
  name: 'developer_companion_check',
  description:
    'Recha 以「懂代码的陪伴」身份只读看一眼当前项目（git status/log + package.json），' +
    '给出一句非侵入式的吐槽或关怀。只读、不改动任何文件；意见写进团队通知板，由你（Lumina）转述。',
  params: {
    cwd: { type: 'string', description: '项目仓库路径', required: true },
  },
  toolsets: ['developer', 'agent', 'dev_tools'],
}

export async function devCompanionCheck(args: Record<string, any>): Promise<ToolResult> {
  const callId = `dev-comp-${Date.now()}`
  const cwd = args.cwd as string
  if (!cwd) {return { callId, ok: false, content: '', error: '缺少 cwd' }}
  if (!isEnabled('developer.companion')) {return { callId, ok: true, content: '开发者陪伴已关闭。' }}
  const msg = await getDevCompanion().analyze(cwd, Date.now())
  if (!msg) {return { callId, ok: true, content: '（此刻不打扰）' }}
  dropRechaNotice(msg, 'low')
  return { callId, ok: true, content: `Recha 的一句（已写进通知板，待你转述）：${msg}` }
}
