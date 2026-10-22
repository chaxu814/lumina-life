// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// shellFileWall.ts — 🧱 D. 文件围墙（OS 级路径锁）
//
// 第三层 → ④ 文件围墙
//   OS Integrity Level 内核级强制策略
//   runas /trustlevel:0x10000 降级子进程为 Low IL
//   + icacls 沙箱目录设为 Low IL
//   结果: Low IL 进程不可写桌面/文档/System32 等 Medium IL 目录
//
// 姊妹模块（第三层纵深防御）:
//   A | processSandbox.ts — 进程树隔离
//   B | shellMonitor.ts   — 资源配额监控
//   C | shellNetCage.ts   — 网络铁笼
//
// 集成入口: shell.ts → executeSandboxed()
//
// 原理：
//   Windows 完整性级别（Integrity Level）是内核级强制策略。
//   Low IL 进程不能写入 Medium IL 目录（桌面、文档、System32 等）。
//   我们利用这个机制来锁住 shell 进程。
//
// 双重保障：
//   1. icacls: 将沙箱目录设为 Low IL，防止外部高 IL 进程污染
//   2. runas:  将子进程降级为 Low IL，使其无法写外部 Medium IL 目录
//
// 不完美但实用：
//   不是完整沙箱（还是同一个用户身份）
//   但加了 OS 级保险——即使 shell 命令跑 rm -rf，也只能删沙箱内的文件
//   不需要管理员权限（icacls 可以在用户权限下运行）
// ============================================================

import { execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { evaluateCommand, Severity, type CommandEvaluation } from './sandboxRules'
import { recordSandboxAudit, type SandboxDisposition } from './sandboxAudit'
import { isEnabled } from '../../core/featureFlags'

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/**
 * 沙箱根目录
 *
 * Windows: %APPDATA%/Lumina/sandbox
 * macOS/Linux: ~/.lumina/sandbox
 */
function getDefaultSandboxRoot(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || process.env.USERPROFILE || '', 'Lumina', 'sandbox')
  }
  return path.join(process.env.HOME || '/tmp', '.lumina', 'sandbox')
}

/** 当前沙箱目录（运行时决定） */
let _sandboxRoot: string = ''
let _initialized = false
/** runas /trustlevel 可用性缓存（Windows 首次失败后禁用） */
let _runasAvailable: boolean | null = null

// ═══════════════════════════════════════════════════════════
// 公共 API
// ═══════════════════════════════════════════════════════════

/**
 * 初始化文件围墙沙箱
 *
 * 1. 创建沙箱目录（如果不存在）
 * 2. 用 icacls 设置完整性级别和权限（仅 Windows）
 * 3. 每个进程生命周期只执行一次
 *
 * @param customRoot 可选的沙箱根目录，不传则使用默认路径
 * @returns 沙箱目录路径
 */
export function ensureFileWallSandbox(customRoot?: string): string {
  if (_initialized && _sandboxRoot) {return _sandboxRoot}

  _sandboxRoot = customRoot || getDefaultSandboxRoot()

  // ── 创建目录（如果不存在） ──
  try {
    if (!fs.existsSync(_sandboxRoot)) {
      fs.mkdirSync(_sandboxRoot, { recursive: true })
      console.log(`[FileWall] 📁 已创建沙箱目录: ${_sandboxRoot}`)
    }
  } catch (err: any) {
    console.warn(`[FileWall] ⚠️ 无法创建沙箱目录: ${err.message}`)
    _initialized = true
    return _sandboxRoot
  }

  // ── Windows: icacls 设置完整性级别（静默失败，不阻塞） ──
  if (process.platform === 'win32') {
    try {
      // step 1: 移除继承的父目录权限
      execSync(`icacls "${_sandboxRoot}" /inheritance:r`, {
        timeout: 8000,
        windowsHide: true,
        stdio: 'pipe',
      })

      // step 2: 授予 Users 组完全控制权（沙箱内可写可执行）
      execSync(`icacls "${_sandboxRoot}" /grant "Users:(OI)(CI)(W)"`, {
        timeout: 8000,
        windowsHide: true,
        stdio: 'pipe',
      })

      // step 3: 设置 Low 完整性级别 ← 核心！
      //   Low IL 目录：
      //     - Low IL 进程可读写 ✓
      //     - Medium IL 进程可读 ✓（向下读允许）
      //     - Medium IL 进程不可写 ✗（IL 向上写禁止）
      //   但因为我们也会降级子进程的 IL，所以主要是为了：
      //     - 防止非 Lumina 进程写沙箱目录
      execSync(`icacls "${_sandboxRoot}" /setintegritylevel Low`, {
        timeout: 8000,
        windowsHide: true,
        stdio: 'pipe',
      })

      console.log(`[FileWall] 🔒 沙箱目录已锁定 (Low IL): ${_sandboxRoot}`)
    } catch (err: any) {
      // icacls 可能因权限不足或策略限制失败——不阻塞，记录日志
      const msg = err.stderr || err.message || '未知错误'
      console.warn(`[FileWall] ⚠️ icacls 设置失败（沙箱仍可用，但 OS 级保护未生效）: ${msg.slice(0, 200)}`)
    }
  } else {
    // Unix: 创建临时目录并设置 0700 权限
    try {
      fs.chmodSync(_sandboxRoot, 0o700)
      console.log(`[FileWall] 🔒 沙箱目录已锁定 (0700): ${_sandboxRoot}`)
    } catch {
      console.warn(`[FileWall] ⚠️ chmod 设置失败`)
    }
  }

  _initialized = true
  return _sandboxRoot
}

/**
 * 重置沙箱状态（主要用于测试）
 */
export function resetFileWall(): void {
  _initialized = false
  _sandboxRoot = ''
}

/**
 * 检查当前是否已启用低完整性保护
 */
export function isLowIntegrityActive(): boolean {
  return _initialized && process.platform === 'win32'
}

/**
 * 在 Windows 上用 runas 降级命令的完整性级别
 *
 * 原理：
 *   runas /trustlevel:0x10000 以 Low Integrity Level 启动进程：
 *   - Low IL 进程可读 Medium IL 文件 ✓（向下读允许）
 *   - Low IL 进程不可写 Medium IL 目录 ✗（向上写禁止）
 *     包括：桌面、文档、System32、Program Files 等
 *   - Low IL 进程可读写 Low IL 的沙箱目录 ✓
 *
 * 实现方式：
 *   runas /trustlevel:0x10000 cmd.exe /v:on /c "<command> & echo [EXIT]=!errorlevel!"
 *   ── runas 启动 cmd.exe 作为参数中的程序
 *   ── /v:on 启用 !var! 延迟变量展开以捕获 !errorlevel!
 *   ── 末尾追加退出码标记补偿 runas 不传递退出码的问题
 *
 * 注意：
 *   - 仅 Windows 有效
 *   - 命令内含引号时用 cmd 的 `""` 转义
 *   - runas /trustlevel 不需要管理员权限，不弹 UAC
 *
 * @param command 原始命令
 * @param sandboxDir 沙箱目录路径（仅用于日志）
 * @returns 包装后的命令
 */
export function wrapLowIntegrity(command: string, sandboxDir?: string): string {
  if (process.platform !== 'win32') {return command}
  // runas 之前失败过？跳过包装
  if (_runasAvailable === false) {return command}
  // 避免重复包装
  if (/^runas\s+\/trustlevel:/i.test(command.trim())) {return command}
  // 空命令不包装
  if (!command.trim()) {return command}

  // cmd.exe 内部 `""` = 一个引号字面量
  const safeCmd = command.replace(/"/g, '""')
  const exitCapture = ` & echo [LUMINA_EXIT_CODE]=!errorlevel!`

  const wrapped = `runas /trustlevel:0x10000 cmd.exe /v:on /c "${safeCmd}${exitCapture}"`

  console.log(`[FileWall] 🔒 命令已包装 Low IL (沙箱: ${sandboxDir || 'default'})`)
  return wrapped
}

/**
 * 标记 runas 不可用（供 shell.ts 在 spawn 失败时调用）
 * 后续 wrapLowIntegrity 将跳过包装，直接用原始命令
 */
export function markRunasUnavailable(): void {
  _runasAvailable = false
  console.warn('[FileWall] ⚠️ runas /trustlevel 不可用，后续命令禁用 Low IL 保护')
}

/**
 * 尝试检测 runas 是否可用（不阻塞，不抛出）
 */
export async function probeRunasAvailability(): Promise<boolean> {
  if (_runasAvailable !== null) {return _runasAvailable}
  if (process.platform !== 'win32') {
    _runasAvailable = false
    return false
  }
  try {
    const { exec } = await import('child_process')
    await new Promise<void>((resolve, reject) => {
      exec('runas /trustlevel:0x10000 cmd.exe /c ver', {
        timeout: 5000,
        windowsHide: true,
      }, (err) => {
        // runas 即使成功启动 cmd 也会返回 0，但我们可以检查 stderr
        // 如果 runas.exe 不存在或服务不可用，err 不为 null
        if (err && (err.message?.includes('not found') || err.message?.includes('找不到'))) {
          _runasAvailable = false
          reject(err)
        } else {
          _runasAvailable = true
          resolve()
        }
      })
    })
  } catch {
    _runasAvailable = false
  }
  return _runasAvailable !== false
}

/**
 * 从运行输出中提取真实退出码
 *
 * @param output 命令输出文本
 * @returns 提取到的退出码，或 null（如果找不到标记）
 */
export function extractExitCode(output: string): number | null {
  const match = output.match(/\[LUMINA_EXIT_CODE\]=(\d+)/)
  if (match) {
    return parseInt(match[1], 10)
  }
  return null
}

/**
 * 清理输出中的退出码标记行（兼容 Windows \r\n 和 Unix \n）
 */
export function stripExitMarker(output: string): string {
  return output.replace(/\r?\n?\[LUMINA_EXIT_CODE\]=\d+\r?\n?/g, '').trim()
}

// ═══════════════════════════════════════════════════════════
// v6.2 (F1): 基于 7×8 规则库的 Low IL 降级决策
// ═══════════════════════════════════════════════════════════

export interface LowILDecision {
  /** 是否需要 runas 降级 */
  shouldWrap: boolean
  /** 审计处置 */
  disposition: SandboxDisposition
  /** 完整评估结果（含命中规则） */
  evaluation: CommandEvaluation
  /** 决策理由（人类可读） */
  reason: string
}

/**
 * 决定一条命令是否要降级到 Low IL，并写入审计。
 *
 * 策略（feature flag `sandbox.severityMatrix` 开启时）：
 *   - CRITICAL/BLOCK → 降级 + 审计记 blocked（真正的硬拦由 shell.ts 前置危险模式兜底）
 *   - HIGH           → 降级 + 审计记 degraded
 *   - MEDIUM         → 不降级，仅审计
 *   - LOW/INFO/SAFE  → 不降级，仅审计（普通 npm/build 等保持正常 IL，
 *                       否则 Low IL 写不进用户项目目录，破坏日常体验）
 *
 * flag 关闭 → 回退旧行为：Windows 上一律 Low IL 降级。
 */
export function decideLowIL(command: string): LowILDecision {
  const evaluation = evaluateCommand(command)

  // 无论走哪条分支都写一条审计（透明玻璃房）
  recordSandboxAudit(command, {
    source: 'shell_exec',
    disposition: evaluation.blocked ? 'blocked' : evaluation.degraded ? 'degraded' : 'passed',
  })

  // flag 关闭 → 旧行为：一律降级
  if (!isEnabled('sandbox.severityMatrix')) {
    return { shouldWrap: true, disposition: 'degraded', evaluation, reason: '旧策略：Windows 一律 Low IL' }
  }

  if (evaluation.severity >= Severity.CRITICAL) {
    return { shouldWrap: true, disposition: 'blocked', evaluation, reason: evaluation.summary }
  }
  if (evaluation.severity >= Severity.HIGH) {
    return { shouldWrap: true, disposition: 'degraded', evaluation, reason: evaluation.summary }
  }
  return { shouldWrap: false, disposition: 'passed', evaluation, reason: evaluation.summary }
}
