// ============================================================
// orchestration/verifyLoop.ts — 自动验证闭环 (v1.0)
//
// Yak 完成代码任务后，自动：
//   1. 跑验证（tsc/测试/lint）
//   2. 失败 → 自动生成修复任务 → 重新委托给 Yak
//   3. 最多 3 轮修复
//   4. 无法修复 → 报告给 Lumina
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
 */
export function buildFixTask(
  originalTask: string,
  verifyResult: VerifyResult,
  round: number,
  maxRounds: number,
): string {
  const errorBlock = verifyResult.errors.join('\n\n')

  return `【🔄 第 ${round}/${maxRounds} 轮自动修复 — 验证未通过】

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

【重要】
- 这不是新任务，是修复任务
- 不要重写整个文件
- 修复完成后我会自动再次验证
- 还剩 ${maxRounds - round} 轮修复机会`
}

// ═══════════════════════════════════════════════════════════
// 自动修复闭环（核心）
// ═══════════════════════════════════════════════════════════

export interface DelegateFnOptions {
  /** 是否跳过验证（内部重委托时使用，避免递归） */
  skipVerify?: boolean
}

/**
 * 自动验证 + 修复循环
 *
 * @param verifyConfig - 验证配置
 * @param originalTask - 原始任务描述
 * @param delegateFn - 委托函数（由 DelegationManager 注入）
 * @param projectRoot - 项目根目录
 * @returns AutoFixResult
 */
export async function autoFixLoop(
  verifyConfig: VerifyConfig,
  originalTask: string,
  delegateFn: (fixTask: string, opts?: DelegateFnOptions) => Promise<{ success: boolean; content: string }>,
): Promise<AutoFixResult> {
  const start = Date.now()
  const attempts: FixAttempt[] = []
  const maxRounds = verifyConfig.maxFixRounds

  // 步骤 1：首次验证
  console.log(`[VerifyLoop] 🔍 首次验证... (${verifyConfig.commands.join(', ')})`)
  let verifyResult = runVerification(verifyConfig)

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
    const fixTask = buildFixTask(originalTask, verifyResult, round, maxRounds)
    console.log(`[VerifyLoop] 🔧 第 ${round}/${maxRounds} 轮修复...`)

    const delegateStart = Date.now()
    const fixResult = await delegateFn(fixTask, { skipVerify: true })
    const delegateElapsed = Date.now() - delegateStart

    const attempt: FixAttempt = {
      round,
      errorLog: verifyResult.errors.join('\n').slice(0, 2000),
      output: fixResult.content.slice(0, 2000),
      delegateSuccess: fixResult.success,
    }
    attempts.push(attempt)

    // 验证修复结果
    console.log(`[VerifyLoop] 🔍 第 ${round} 轮修复后验证...`)
    verifyResult = runVerification(verifyConfig)

    if (verifyResult.passed) {
      console.log(`[VerifyLoop] ✅ 第 ${round} 轮修复后验证通过 (${verifyResult.elapsedMs}ms)`)
      return {
        success: true,
        content: `✅ 第 ${round} 轮修复后验证通过`,
        error: null,
        attempts,
        totalElapsedMs: Date.now() - start,
      }
    }

    console.log(`[VerifyLoop] ❌ 第 ${round} 轮验证仍失败`)
  }

  // 超过最大轮次
  console.log(`[VerifyLoop] ❌ 修复失败，已达最大轮次 ${maxRounds}`)
  return {
    success: false,
    content: `❌ 自动修复失败，经过 ${maxRounds} 轮修复后验证仍未通过`,
    error: verifyResult.errors.join('\n').slice(0, 5000),
    attempts,
    totalElapsedMs: Date.now() - start,
  }
}

/**
 * 判断 taskType 是否需要自动验证
 */
export function taskMayNeedVerification(taskType: string): boolean {
  return ['code_write', 'code_debug', 'code_modify', 'code_refactor'].includes(taskType)
}
