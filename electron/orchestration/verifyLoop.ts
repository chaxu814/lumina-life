// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// orchestration/verifyLoop.ts — 自动验证闭环 (v1.0)
//
// Yak（yak，代码工程师）完成代码任务后，自动：
//   1. 跑验证（tsc/测试/lint）
//   2. 失败 → 自动生成修复任务 → 重新委托给 Yak（只有它有写权限）
//   3. 最多 3 轮修复
//   4. 无法修复 → 报告给 Lumina
//
// 角色口径：修复=写代码=yak；热茶（审查员）只读不写，不参与本循环。
//
// 设计原则：
//   - 纯函数式，不持有状态
//   - 依赖注入（delegateFn 由调用方提供）
//   - 不产生循环依赖
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
// 命令执行前的两道**既有**防线（不新造第三套安全系统）：
//   - security/commandPolicy.ts：命令策略的单一事实源，shell_exec 走的正是它
//   - securityGuard.ts：参数级审查，tools/registry.ts 执行的正是它
// 两者都是零 Electron 依赖的纯逻辑模块，可直接单测。
import { evaluateCommand } from '../security/commandPolicy'
import { getSecurityGuard } from '../securityGuard'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

/** 验证配置 */
export interface VerifyConfig {
  /** 验证命令列表（顺序执行，全部通过才算 pass） */
  commands: string[]
  /** 最大修复轮次（默认 3） */
  maxFixRounds: number
  /** 单条命令超时 ms（默认 120s） */
  timeoutMs: number
  /**
   * 工作目录（默认 project root）。
   * 改成可选：定不出项目目录时**必须**允许把「没有」如实传下去 ——
   * 强行塞一个 process.cwd() 只会让验证在错误的目录里跑出一个假通过。
   */
  cwd?: string
}

/** 验证结论三态。unverified 必须与 passed 严格区分：没验证过 ≠ 通过 */
export type VerifyStatus = 'passed' | 'failed' | 'unverified'

/** 单次验证结果 */
export interface VerifyResult {
  passed: boolean
  /**
   * 三态标签。声明为可选是为了兼容既有调用方/单测里手搓的字面量；
   * 读的时候一律走 normalizeVerifyStatus()，缺省按 passed 推导。
   */
  status?: VerifyStatus
  /** status==='unverified' 时给用户看的一句话（为什么没验证） */
  unverifiedReason?: string
  /** 所有命令的 stdout */
  output: string
  /** 失败命令的 stderr（仅失败时有） */
  errors: string[]
  /** 耗时 ms */
  elapsedMs: number
  /** 被安全策略拦下、**未执行**的命令（可审计用） */
  blockedCommands?: string[]
}

/** 单次修复尝试 */
export interface FixAttempt {
  round: number
  /** 当时的错误日志 */
  errorLog: string
  /** 修复委托的输出 */
  output: string
  /** 修复委托是否成功 */
  delegateSuccess: boolean
  /** 本轮的人类可读说明（成功 / 失败 / 提前终止） */
  note?: string
}

/** 自动修复全景结果 */
export interface AutoFixResult {
  /** 最终是否所有验证通过。**未验证恒为 false** —— 没跑过就不算过 */
  success: boolean
  /** 结果描述 */
  content: string
  /** 最终错误（失败时） */
  error: string | null
  /** 末次验证的三态标签（调用方据此决定怎么如实呈现给用户） */
  verifyStatus?: VerifyStatus
  /** 各轮修复记录 */
  attempts: FixAttempt[]
  /** 总耗时 ms */
  totalElapsedMs: number
}

/** 项目类型检测结果 */
export interface ProjectProfile {
  type: 'ts' | 'js' | 'python' | 'unknown'
  hasTests: boolean
  hasTypeScript: boolean
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'none'
  suggestedVerifyCommands: string[]
}

// ═══════════════════════════════════════════════════════════
// 项目根解析
//
// 【为什么不能用 process.cwd() 开场】
// 打包后的 Electron 里 process.cwd() 是**启动目录**，不是用户的项目目录。
// 旧实现拿它当入口 → 找不到任何命令 → 又因为 detectProjectProfile 的
// `node --check … || echo` 兜底永远退出 0 → 报「验证通过」。
// 结果是：旗舰卖点「写完自动跑 tsc + 测试」在真实用户那里是个假通过。
//
// 【解析优先级】越靠前越可信，全部记在 ProjectRootResolution.source 里：
//   ① Worker 本次实际读写的文件 —— 最可信，它就落在用户的项目里
//   ① 委托/任务上下文显式带的项目根
//   ② 之前记录下来的工作区根（用户自己配过的）
//   ③ process.cwd() 兜底，且**必须显式开启**；用了会在 detail 里点名
// 全部落空 → root=null，调用方必须报「未验证」，不允许静默通过。
// ═══════════════════════════════════════════════════════════

/** fs 探测接口（可注入：单测用假实现，不需要真磁盘） */
export interface RootProbeFs {
  existsSync(p: string): boolean
  statSync(p: string): { isDirectory(): boolean }
}

/** 项目标志文件：命中任意一个即认为这一层是项目根 */
export const PROJECT_MARKERS = [
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  '.git',
]

/** 解析线索；全部可选且可注入，便于纯函数单测 */
export interface ProjectRootHints {
  /** ① 委托/任务上下文显式带的项目根 */
  taskRoot?: string | null
  /** ① 本次任务 Worker 实际读写的文件（相对路径按 recordedRoot ?? cwd 解析） */
  touchedFiles?: readonly string[] | null
  /** ② 之前记录过的工作区根（用户显式配置过的，未配过就传 null） */
  recordedRoot?: string | null
  /** ③ 是否允许退回 process.cwd()（默认 false，调用方显式开） */
  allowCwdFallback?: boolean
  /** ③ 注入的 cwd（默认 process.cwd()） */
  cwd?: string
  /** fs 探测注入（默认真实 fs） */
  fsImpl?: RootProbeFs
  /** 向上查找的最大层数（默认 10） */
  maxDepth?: number
}

export type ProjectRootSource = 'touched-files' | 'task-context' | 'recorded' | 'cwd-fallback' | 'none'

export interface ProjectRootResolution {
  /** 定不出时为 null —— 调用方**必须**据此报「未验证」 */
  root: string | null
  /** 来源标签，用于日志与用户可见文案里说清「凭什么认为这是项目目录」 */
  source: ProjectRootSource
  /** 人类可读的判定依据 */
  detail: string
}

function isDirSafe(p: string, fsImpl: RootProbeFs): boolean {
  try { return fsImpl.statSync(p).isDirectory() } catch { return false }
}

/** 这一层目录是不是项目根（含任意标志文件） */
export function isProjectRoot(dir: string, fsImpl: RootProbeFs = fs as RootProbeFs): boolean {
  return PROJECT_MARKERS.some(m => fsImpl.existsSync(path.join(dir, m)))
}

/**
 * 从 startDir 逐级向上找项目根，找不到返回 null。
 *
 * 【为什么不像 detectProjectRoot 那样「找不到就回退到入口目录」】
 * 那个回退是「验证能跑起来」的代价，但代价是永远给出一个假根；
 * 这里宁可返回 null，把「定不出」如实交回调用方。
 */
export function findProjectRootUp(
  startDir: string,
  fsImpl: RootProbeFs = fs as RootProbeFs,
  maxDepth = 10,
): string | null {
  let dir = startDir
  for (let i = 0; i <= maxDepth; i++) {
    if (isProjectRoot(dir, fsImpl)) {return dir}
    const parent = path.dirname(dir)
    if (parent === dir) {break}
    dir = parent
  }
  return null
}

/** 从一个文件/目录路径推出项目根；不是项目的一律返回 null */
export function projectRootFromPath(
  p: string,
  fsImpl: RootProbeFs = fs as RootProbeFs,
  maxDepth = 10,
): string | null {
  if (!p || !p.trim()) {return null}
  const abs = path.resolve(p)
  const start = isDirSafe(abs, fsImpl) ? abs : path.dirname(abs)
  return findProjectRootUp(start, fsImpl, maxDepth)
}

/**
 * 按优先级解析本次验证该在哪个目录跑（纯函数，可注入 fs）。
 *
 * 触碰文件命中多个不同根时取**第一个**能解析出项目根的 —— 调用方把最有
 * 代表性的文件排在前面即可，行为可预测比「投票」更重要。
 */
export function resolveProjectRoot(hints: ProjectRootHints = {}): ProjectRootResolution {
  const fsImpl = hints.fsImpl ?? (fs as RootProbeFs)
  const cwd = hints.cwd ?? process.cwd()
  const maxDepth = hints.maxDepth ?? 10
  const recorded = hints.recordedRoot?.trim() || null
  const relativeBase = recorded ?? cwd
  const tried: string[] = []

  // ① Worker 本次实际读写的文件 —— 最可信：它就落在用户的项目里
  for (const f of hints.touchedFiles ?? []) {
    if (typeof f !== 'string' || !f.trim()) {continue}
    const abs = path.isAbsolute(f) ? f : path.resolve(relativeBase, f)
    const root = projectRootFromPath(abs, fsImpl, maxDepth)
    if (root) {
      return {
        root,
        source: 'touched-files',
        detail: `取自本次任务触碰的文件 ${abs}（向上找到项目根 ${root}）`,
      }
    }
    tried.push(abs)
  }

  // ① 委托/任务上下文显式带的项目根
  if (hints.taskRoot?.trim()) {
    const root = projectRootFromPath(hints.taskRoot.trim(), fsImpl, maxDepth)
    if (root) {
      return { root, source: 'task-context', detail: `取自委托上下文的项目根 ${hints.taskRoot} → ${root}` }
    }
    tried.push(hints.taskRoot.trim())
  }

  // ② 之前记录下来的工作区根（用户自己配过的，优先于任何猜测）
  if (recorded) {
    const root = projectRootFromPath(recorded, fsImpl, maxDepth)
    if (root) {
      return { root, source: 'recorded', detail: `取自已记录的工作区根 ${recorded} → ${root}` }
    }
    tried.push(recorded)
  }

  // ③ 最后的兜底：process.cwd()。打包态它通常不是用户的项目目录，
  //    所以必须显式开启，且用了要在 detail 里点名 —— 让日志说实话。
  if (hints.allowCwdFallback) {
    const root = findProjectRootUp(cwd, fsImpl, maxDepth)
    if (root) {
      return {
        root,
        source: 'cwd-fallback',
        detail: `⚠️ 兜底使用 process.cwd() = ${cwd}（打包态这不是你的项目目录，可能验错地方）`,
      }
    }
    tried.push(cwd)
    return {
      root: null,
      source: 'none',
      detail: `未能确定项目目录：process.cwd()=${cwd} 及其上级都不含 ${PROJECT_MARKERS[0]}/${PROJECT_MARKERS[1]} 等标志文件`,
    }
  }

  return {
    root: null,
    source: 'none',
    detail: tried.length
      ? `未能确定项目目录：以下线索均不在任何项目内 → ${tried.join(', ')}`
      : '未能确定项目目录：本次任务没有任何项目路径线索',
  }
}

// ═══════════════════════════════════════════════════════════
// 项目检测
// ═══════════════════════════════════════════════════════════

/**
 * 检测项目根目录，自动往上级找 package.json / tsconfig.json
 *
 * ⚠️ 保留给「已经明确知道入口目录」的旧调用方。**新的验证入口请用
 * resolveProjectRoot()**：本函数找不到标志文件时会回退返回 entry，
 * 那会把一个非项目目录伪装成项目根，正是打包态假通过的源头之一。
 */
export function detectProjectRoot(entry: string): string {
  let dir = fs.statSync(entry).isDirectory() ? entry : path.dirname(entry)
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {return dir}
    if (fs.existsSync(path.join(dir, 'tsconfig.json'))) {return dir}
    const parent = path.dirname(dir)
    if (parent === dir) {break}
    dir = parent
  }
  return entry
}

/**
 * 检测项目特征，返回推荐验证命令
 */
export function detectProjectProfile(cwd: string): ProjectProfile {
  const hasTsConfig = fs.existsSync(path.join(cwd, 'tsconfig.json'))
  const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'))
  const hasPyProject = fs.existsSync(path.join(cwd, 'pyproject.toml')) ||
                        fs.existsSync(path.join(cwd, 'requirements.txt'))

  const type: ProjectProfile['type'] = hasTsConfig ? 'ts' : hasPyProject ? 'python' : 'js'
  const hasTypeScript = hasTsConfig

  // 检测包管理器
  let packageManager: ProjectProfile['packageManager'] = 'none'
  let hasTests = false

  if (hasPackageJson) {
    if (fs.existsSync(path.join(cwd, 'yarn.lock'))) {packageManager = 'yarn'}
    else if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) {packageManager = 'pnpm'}
    else {packageManager = 'npm'}

    // 检测是否有 test script
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'))
      hasTests = !!(pkg.scripts?.test || pkg.scripts?.vitest || pkg.scripts?.jest)
    } catch { /* ignore */ }
  }

  // 推荐验证命令
  const suggestedVerifyCommands: string[] = []

  if (hasTypeScript) {
    const npx = packageManager === 'yarn' ? 'yarn' : packageManager === 'pnpm' ? 'pnpm' : 'npx'
    suggestedVerifyCommands.push(`${npx} tsc --noEmit 2>&1`)
  }

  if (hasTests && type === 'ts') {
    suggestedVerifyCommands.push(`npx vitest run 2>&1 || npm test 2>&1`)
  }

  // fallback: 至少跑一次语法检查
  if (suggestedVerifyCommands.length === 0 && type === 'js') {
    suggestedVerifyCommands.push(`node --check ${cwd}/**/*.js 2>&1 || echo "无法自动检测验证命令"`)
  }

  return {
    type,
    hasTests,
    hasTypeScript,
    packageManager,
    suggestedVerifyCommands,
  }
}

// ═══════════════════════════════════════════════════════════
// 命令闸门（执行前必须过）
//
// 【为什么必须有】旧实现直接 execSync(cmd, {shell:true})，
// 绕开了用户自己的 shell_exec 全链路（permissionTier + securityGuard +
// commandPolicy）。沙箱玻璃房对「用户/模型写的命令」关得严严实实，
// 却在「自己给自己发的验证命令」上留了个洞 —— 那也是命令，一样会 rm -rf。
//
// 【为什么不用审批弹窗】自动验证是无人值守的，每条命令弹一次审批等于
// 亲手废掉这个功能。所以取「非交互式预检」：命中 REJECT/需审批一律不执行，
// 并如实报「命令被安全策略拦截」—— 既不打扰用户，也绝不偷偷放行。
// ═══════════════════════════════════════════════════════════

export interface CommandGateResult {
  allowed: boolean
  /** 命中的规则 id（可审计） */
  rule?: string
  /** 人类可读理由 */
  reason?: string
}

export type VerifyCommandGate = (cmd: string) => CommandGateResult

/** 真·执行（默认注入点，单测可替换 → 不 spawn 任何进程） */
export interface VerifyExecOptions {
  cwd?: string
  timeout?: number
  encoding?: 'utf-8'
  maxBuffer?: number
  /** 验证命令自带 `2>&1` / `||` 管道语法，必须交给 shell 解释 */
  shell?: boolean
}
export type VerifyExecFn = (cmd: string, opts: VerifyExecOptions) => string

/**
 * 默认闸门：security/commandPolicy.ts + securityGuard.ts 两层，与
 * shell_exec 走的是同一份规则库与同一套判定，不存在「只有内部命令能绕过」。
 */
export const defaultVerifyCommandGate: VerifyCommandGate = (cmd) => {
  const text = String(cmd ?? '').trim()
  if (!text) {
    return { allowed: false, rule: 'EMPTY_COMMAND', reason: '空命令' }
  }

  // ① 命令策略层（shellExec 里同一条路径）
  const verdict = evaluateCommand(text, { enabledApproval: true })
  if (verdict.decision === 'reject') {
    return {
      allowed: false,
      rule: verdict.matchedRule || 'REJECT',
      reason: verdict.reasons.join('；') || '命中命令拒绝规则',
    }
  }
  if (verdict.decision === 'require_approval') {
    return {
      allowed: false,
      rule: verdict.matchedRule || 'REQUIRE_APPROVAL',
      reason: `${verdict.reasons.join('；')}（高危命令需人工确认，自动验证不弹窗，故本轮不执行）`,
    }
  }

  // ② 参数级审查层（tools/registry.ts 同款：伪造一次 shell_exec 调用）
  try {
    const guard = getSecurityGuard()
    const res = guard.checkToolCall({
      id: '',
      type: 'function',
      function: { name: 'shell_exec', arguments: JSON.stringify({ command: text }) },
    })
    if (!res.allowed) {
      return {
        allowed: false,
        rule: res.findings.map(f => f.ruleId).join(',') || 'GUARD_BLOCK',
        reason: res.summary,
      }
    }
    if (res.requiresApproval) {
      return {
        allowed: false,
        rule: res.findings.map(f => f.ruleId).join(',') || 'GUARD_APPROVAL',
        reason: `${res.summary}（需人工确认，自动验证不弹窗，故本轮不执行）`,
      }
    }
  } catch (err: any) {
    // 失败关闭：护栏自己坏了就不能放行未知命令。
    // 验证是附加能力，宁可报「未执行」，也不要变成一个绕过护栏的后门。
    console.error('[VerifyLoop] ⛔ 安全审查异常，命令不放行:', err?.message || err)
    return { allowed: false, rule: 'GUARD_ERROR', reason: `安全审查异常: ${err?.message || String(err)}` }
  }

  return { allowed: true }
}

/** runVerification 的可注入依赖（单测不 spawn 任何进程） */
export interface VerifyDeps {
  /** 命令闸门，默认 defaultVerifyCommandGate */
  gate?: VerifyCommandGate
  /** 实际执行，默认 execSync 包装 */
  exec?: VerifyExecFn
}

function defaultExec(cmd: string, opts: VerifyExecOptions): string {
  // ⚠️ @types/node 把 ExecSyncOptions.shell 收窄成 string（运行时其实接受 boolean），
  // 而验证命令必须走 shell。这里放宽标注，但绝不改变执行语义。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return execSync(cmd, { ...opts } as any).toString()
}

/** 工作目录可用性检查 —— 不合格就「未验证」，绝不返回 passed */
function checkCwdUsable(cwd: string | undefined): { ok: boolean; reason: string } {
  if (!cwd || !cwd.trim()) {
    return { ok: false, reason: '未能确定项目目录，未做自动验证' }
  }
  if (!isDirSafe(cwd, fs as RootProbeFs)) {
    return { ok: false, reason: `项目目录不存在或不可访问: ${cwd}，未做自动验证` }
  }
  if (!isProjectRoot(cwd)) {
    return { ok: false, reason: `${cwd} 不含 ${PROJECT_MARKERS.slice(0, 2).join(' / ')} 等项目标志文件，未做自动验证` }
  }
  return { ok: true, reason: '' }
}

/** 构造「未验证」结果 —— 唯一允许 passed=false 的构造入口之一 */
export function unverifiedResult(reason: string, elapsedMs = 0): VerifyResult {
  return {
    passed: false,
    status: 'unverified',
    unverifiedReason: reason,
    output: `[未验证] ${reason}`,
    errors: [reason],
    elapsedMs,
    blockedCommands: [],
  }
}

/** 归一化三态：缺 status 时按 passed 推导，兼容既有调用方手搓的结果对象 */
export function normalizeVerifyStatus(r: VerifyResult): VerifyStatus {
  if (r.status) {return r.status}
  return r.passed ? 'passed' : 'failed'
}

// ═══════════════════════════════════════════════════════════
// 验证执行
// ═══════════════════════════════════════════════════════════

/**
 * 执行验证命令（每条命令先过安全闸门）
 *
 * 失败关闭的三种情形，都会如实落到 errors/status，绝不吞掉：
 *   1. 定不出项目目录 → unverified
 *   2. 命令被策略拦截 → 该条不执行，记进 blockedCommands + errors
 *   3. 命令执行抛错 → 记进 errors
 */
export function runVerification(config: VerifyConfig, deps: VerifyDeps = {}): VerifyResult {
  const start = Date.now()
  const allOutputs: string[] = []
  const errors: string[] = []
  const blocked: string[] = []
  const gate = deps.gate ?? defaultVerifyCommandGate
  const exec = deps.exec ?? defaultExec

  // ① 定不出项目目录 → 明确报「未验证」，不给调用方任何可以当成通过的余地
  const cwdCheck = checkCwdUsable(config.cwd)
  if (!cwdCheck.ok) {
    console.error(`[VerifyLoop] ⛔ ${cwdCheck.reason}`)
    return unverifiedResult(cwdCheck.reason, Date.now() - start)
  }

  // ② 空命令列表同样是「没验证过」，不是「验证通过」
  if (!config.commands || config.commands.length === 0) {
    const reason = '项目目录内没有可用的验证命令，未做自动验证'
    console.warn(`[VerifyLoop] ⚠️ ${reason} (cwd=${config.cwd})`)
    return unverifiedResult(reason, Date.now() - start)
  }

  for (const cmd of config.commands) {
    // ③ 执行前必须过闸门：拦下的命令一条都不许进 execSync
    const gateResult = gate(cmd)
    if (!gateResult.allowed) {
      const msg = `命令被安全策略拦截，未执行: ${cmd}` +
        `（规则 ${gateResult.rule || 'UNKNOWN'}${gateResult.reason ? ' — ' + gateResult.reason : ''}）`
      console.warn(`[VerifyLoop] ⛔ ${msg}`)
      blocked.push(cmd)
      allOutputs.push(`$ ${cmd}\n[未执行] ${msg}`)
      errors.push(msg)
      continue
    }

    try {
      const opts: VerifyExecOptions = {
        cwd: config.cwd,
        timeout: config.timeoutMs,
        encoding: 'utf-8',
        shell: true,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      }
      const stdout = exec(cmd, opts)
      allOutputs.push(`$ ${cmd}\n${stdout}`)
    } catch (err: any) {
      const stderr = err.stderr || ''
      const stdout = err.stdout || ''
      allOutputs.push(`$ ${cmd}\n${stdout}`)
      errors.push(stderr || err.message || String(err))
      console.error(`[VerifyLoop] ❌ 验证命令失败: ${cmd} → ${String(errors[errors.length - 1]).slice(0, 200)}`)
    }
  }

  return {
    passed: errors.length === 0,
    status: errors.length === 0 ? 'passed' : 'failed',
    output: allOutputs.join('\n---\n'),
    errors,
    elapsedMs: Date.now() - start,
    blockedCommands: blocked,
  }
}

// ═══════════════════════════════════════════════════════════
// 修复任务构建
// ═══════════════════════════════════════════════════════════

/**
 * 根据验证错误构建自动修复任务
 *
 * @param moodPrefix 情绪化指令前缀（Lumina 心情不好时更短更直接），可空
 */
export function buildFixTask(
  originalTask: string,
  verifyResult: VerifyResult,
  round: number,
  maxRounds: number,
  moodPrefix = '',
): string {
  const errorBlock = verifyResult.errors.join('\n\n')

  return `【🔄 第 ${round}/${maxRounds} 轮自动修复 — 验证未通过】
${moodPrefix}
原始任务:
${originalTask}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
验证失败输出:
\`\`\`
${errorBlock.slice(0, 3000)}
\`\`\`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【修复要求】
1. 仔细阅读以上报错，定位到具体文件和行号
2. 修复导致编译/类型/测试失败的问题
3. 不要破坏已有的功能
4. 只改必须改的地方，最小改动原则
5. 修复完成后我会重新验证，${maxRounds - round} 轮修复机会

【重要】
- 这不是新任务，是修复任务
- 不要重写整个文件
- 修复完成后我会自动再次验证`
}

// ═══════════════════════════════════════════════════════════
// 自动修复闭环（核心）
// ═══════════════════════════════════════════════════════════

export interface DelegateFnOptions {
  /** 是否跳过验证（内部重委托时使用，避免递归） */
  skipVerify?: boolean
}

/** 循环提前终止的判定结果 */
export interface StopCheck {
  shouldStop: boolean
  reason?: string | null
}

/** autoFixLoop 的可选钩子（全部可注入，便于单测与情绪化策略） */
export interface AutoFixHooks {
  /** v02 测试用：替换真实验证执行 */
  runVerify?: (cfg: VerifyConfig) => VerifyResult | Promise<VerifyResult>
  /**
   * 情绪化修复指令前缀（如 '【紧急】请立即修复…'）。由调用方按当前情绪决定，
   * 保持 verifyLoop 不依赖情绪模块（纯函数 + 依赖注入）。
   */
  moodPrefix?: (round: number) => string
  /** 外部停止条件（如 LuckyMode 的预算/轮数上限），返回 shouldStop 即终止 */
  shouldStop?: (round: number, maxRounds: number, lastResult: VerifyResult) => StopCheck
  /** 收敛检测：连续多轮错误模式完全相同 → 提前终止，避免烧 token */
  isConverged?: (rounds: VerifyResult[], round: number) => boolean
  /** 委托失败（未产出结果）时的处理；返回 true 表示跳过一次重试 */
  onDelegateFailure?: (round: number, error: string) => boolean
}

/**
 * 自动验证 + 修复循环（唯一实现）
 *
 * 【为什么这里是唯一实现】
 * 历史上 `DelegationManager._autoVerifyAfterDelegation` 曾把本函数的逻辑整段
 * 复制内联，导致两份实现各自演化：内联版多出「情绪调节轮数」「收敛检测」
 * 「LuckyMode 停止条件」三项能力，而本函数没有 —— 修 bug 必须改两处，
 * 漏一处就是线上不一致。现已把全部能力收敛到本函数，调用方只负责提供钩子。
 *
 * 纯函数 + 依赖注入：不 import 情绪/任务/日志模块，可单测、不绑运行时。
 */
export async function autoFixLoop(
  verifyConfig: VerifyConfig,
  originalTask: string,
  delegateFn: (fixTask: string, opts?: DelegateFnOptions) => Promise<{ success: boolean; content: string }>,
  hooks: AutoFixHooks = {},
): Promise<AutoFixResult> {
  const start = Date.now()
  const attempts: FixAttempt[] = []
  const maxRounds = verifyConfig.maxFixRounds
  const runVerify = hooks.runVerify ?? runVerification
  const history: VerifyResult[] = []

  // 步骤 1：首次验证
  console.log(`[VerifyLoop] 🔍 首次验证... (${verifyConfig.commands.join(', ')})`)
  let verifyResult = await runVerify(verifyConfig)
  history.push(verifyResult)

  // 未验证 ≠ 通过：这一轮根本没跑起来，让 Yak「按报错修」只会瞎改代码。
  // 直接如实上报，宁可让用户自己跑一次 tsc，也不要一个假的「验证通过」。
  const firstStatus = normalizeVerifyStatus(verifyResult)
  if (firstStatus === 'unverified') {
    const reason = verifyResult.unverifiedReason || verifyResult.errors[0] || '未知原因'
    console.error(`[VerifyLoop] ⛔ 未做验证，不进入修复循环: ${reason}`)
    return {
      success: false,
      content: `⚠️ 未做自动验证：${reason}`,
      error: reason,
      verifyStatus: 'unverified',
      attempts,
      totalElapsedMs: Date.now() - start,
    }
  }

  if (verifyResult.passed) {
    console.log(`[VerifyLoop] ✅ 首次验证通过 (${verifyResult.elapsedMs}ms)`)
    return {
      success: true,
      content: '✅ 验证通过，无需修复',
      error: null,
      verifyStatus: 'passed',
      attempts,
      totalElapsedMs: Date.now() - start,
    }
  }

  console.log(`[VerifyLoop] ❌ 首次验证失败，开始修复循环...`)

  // 步骤 2~N：修复 + 验证循环
  for (let round = 1; round <= maxRounds; round++) {
    // 外部停止条件（LuckyMode 预算等）
    if (hooks.shouldStop) {
      const stop = hooks.shouldStop(round, maxRounds, verifyResult)
      if (stop.shouldStop) {
        const why = stop.reason ?? '未说明原因'
        console.log(`[VerifyLoop] ⏹ 提前终止: ${why}`)
        attempts.push({ round, errorLog: '', output: '', delegateSuccess: false, note: `⏹ ${why}` })
        return {
          success: false,
          content: `⏹ 修复循环提前终止: ${why}`,
          error: verifyResult.errors.join('\n').slice(0, 5000),
          verifyStatus: 'failed',
          attempts,
          totalElapsedMs: Date.now() - start,
        }
      }
    }

    const fixTask = buildFixTask(
      originalTask,
      verifyResult,
      round,
      maxRounds,
      hooks.moodPrefix ? hooks.moodPrefix(round) : '',
    )
    console.log(`[VerifyLoop] 🔧 第 ${round}/${maxRounds} 轮修复...`)

    let fixResult: { success: boolean; content: string }
    try {
      fixResult = await delegateFn(fixTask, { skipVerify: true })
    } catch (err: any) {
      const msg = err?.message || String(err)
      attempts.push({ round, errorLog: verifyResult.errors.join('\n').slice(0, 2000), output: '', delegateSuccess: false, note: `修复委托异常: ${msg}` })
      if (!hooks.onDelegateFailure?.(round, msg)) {break}
      continue
    }

    attempts.push({
      round,
      errorLog: verifyResult.errors.join('\n').slice(0, 2000),
      output: fixResult.content.slice(0, 2000),
      delegateSuccess: fixResult.success,
    })

    // 验证修复结果
    console.log(`[VerifyLoop] 🔍 第 ${round} 轮修复后验证...`)
    verifyResult = await runVerify(verifyConfig)
    history.push(verifyResult)

    // 修复途中若变成「未验证」（例如项目目录没了/命令被策略全拦），
    // 同样不能算通过，也不能继续下一轮 —— 如实收尾。
    const roundStatus = normalizeVerifyStatus(verifyResult)
    if (roundStatus === 'unverified') {
      const reason = verifyResult.unverifiedReason || verifyResult.errors[0] || '未知原因'
      console.error(`[VerifyLoop] ⛔ 第 ${round} 轮后转为未验证，终止修复循环: ${reason}`)
      const lastAttempt = attempts[attempts.length - 1]
      if (lastAttempt) {lastAttempt.note = `⏹ 未验证: ${reason.slice(0, 100)}`}
      return {
        success: false,
        content: `⚠️ 未做自动验证：${reason}`,
        error: reason,
        verifyStatus: 'unverified',
        attempts,
        totalElapsedMs: Date.now() - start,
      }
    }

    if (verifyResult.passed) {
      console.log(`[VerifyLoop] ✅ 第 ${round} 轮修复后验证通过 (${verifyResult.elapsedMs}ms)`)
      const last = attempts[attempts.length - 1]
      if (last) {last.note = `✅ 第 ${round} 轮修复后通过`}
      return {
        success: true,
        content: `✅ 第 ${round} 轮修复后验证通过`,
        error: null,
        verifyStatus: 'passed',
        attempts,
        totalElapsedMs: Date.now() - start,
      }
    }

    // 收敛检测：错误模式无变化 → 再试也是白烧 token
    if (hooks.isConverged?.(history, round)) {
      console.log(`[VerifyLoop] ⏹ 错误模式无变化，提前终止修复循环`)
      const last = attempts[attempts.length - 1]
      if (last) {last.note = '提前终止: 错误模式无变化'}
      break
    }

    console.log(`[VerifyLoop] ❌ 第 ${round} 轮验证仍失败`)
  }

  // 超过最大轮次
  console.log(`[VerifyLoop] ❌ 修复失败，已达最大轮次 ${maxRounds}`)
  const last = attempts[attempts.length - 1]
  if (last && !last.note) {last.note = `第 ${maxRounds} 轮后仍失败`}
  return {
    success: false,
    content: `❌ 自动修复失败，经过 ${maxRounds} 轮修复后验证仍未通过`,
    error: verifyResult.errors.join('\n').slice(0, 5000),
    verifyStatus: 'failed',
    attempts,
    totalElapsedMs: Date.now() - start,
  }
}

/**
 * 默认收敛检测：连续两轮错误文本高度重合（后一轮包含前一轮的前 100 字符）
 * 且发生在第 3 轮及以后 → 判定为无进展。
 */
export function defaultConvergenceCheck(history: VerifyResult[], round: number): boolean {
  if (round < 3 || history.length < 2) {return false}
  const prev = history[history.length - 2].errors
  const cur = history[history.length - 1].errors
  if (!prev.length || !cur.length) {return false}
  return cur.every((e, i) => !!prev[i] && e.includes(prev[i].slice(0, 100)))
}

/**
 * 判断 taskType 是否需要自动验证
 */
export function taskMayNeedVerification(taskType: string): boolean {
  return ['code_write', 'code_debug', 'code_modify', 'code_refactor'].includes(taskType)
}
