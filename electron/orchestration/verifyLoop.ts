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
import { execSync, ExecSyncOptions } from 'child_process'

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
  /** 工作目录（默认 project root） */
  cwd: string
}

/** 单次验证结果 */
export interface VerifyResult {
  passed: boolean
  /** 所有命令的 stdout */
  output: string
  /** 失败命令的 stderr（仅失败时有） */
  errors: string[]
  /** 耗时 ms */
  elapsedMs: number
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
  /** 最终是否所有验证通过 */
  success: boolean
  /** 结果描述 */
  content: string
  /** 最终错误（失败时） */
  error: string | null
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
// 项目检测
// ═══════════════════════════════════════════════════════════

/**
 * 检测项目根目录，自动往上级找 package.json / tsconfig.json
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
// 验证执行
// ═══════════════════════════════════════════════════════════

/**
 * 执行验证命令
 */
export function runVerification(config: VerifyConfig): VerifyResult {
  const start = Date.now()
  const allOutputs: string[] = []
  const errors: string[] = []

  for (const cmd of config.commands) {
    try {
      const opts: any = {
        cwd: config.cwd,
        timeout: config.timeoutMs,
        encoding: 'utf-8',
        shell: true,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      }
      const stdout = execSync(cmd, opts)
      allOutputs.push(`$ ${cmd}\n${stdout}`)
    } catch (err: any) {
      const stderr = err.stderr || ''
      const stdout = err.stdout || ''
      allOutputs.push(`$ ${cmd}\n${stdout}`)
      errors.push(stderr || err.message || String(err))
    }
  }

  return {
    passed: errors.length === 0,
    output: allOutputs.join('\n---\n'),
    errors,
    elapsedMs: Date.now() - start,
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

  if (verifyResult.passed) {
    console.log(`[VerifyLoop] ✅ 首次验证通过 (${verifyResult.elapsedMs}ms)`)
    return {
      success: true,
      content: '✅ 验证通过，无需修复',
      error: null,
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

    if (verifyResult.passed) {
      console.log(`[VerifyLoop] ✅ 第 ${round} 轮修复后验证通过 (${verifyResult.elapsedMs}ms)`)
      const last = attempts[attempts.length - 1]
      if (last) {last.note = `✅ 第 ${round} 轮修复后通过`}
      return {
        success: true,
        content: `✅ 第 ${round} 轮修复后验证通过`,
        error: null,
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
