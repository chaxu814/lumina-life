// ============================================================
// pythonManager.ts — Lumina Python Agent Node 进程管理器
//
// 职责:
//   1. 启动/停止/重启 Python 进程 (lumina_node)
//   2. 健康检查 + 心跳监控
//   3. 优雅关闭
//   4. 崩溃自动恢复（可配置）
//
// Plan C 架构:
//   Electron 主进程 ↔ (WebSocket/HTTP) ↔ Python Agent Node
//   Python 端统一管理 TTS/STT/Embedding 服务
// ============================================================

import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { app } from 'electron'

// ── 配置 ────────────────────────────────────────────

const PYTHON_NODE_PORT = 18925
const PYTHON_WS_PORT = 18926
const HEALTH_CHECK_INTERVAL_MS = 30_000  // 30 秒心跳
const MAX_RESTART_ATTEMPTS = 3
const RESTART_COOLDOWN_MS = 5_000

// ── 状态 ────────────────────────────────────────────

interface PythonManagerState {
  process: ChildProcess | null
  running: boolean
  healthy: boolean
  restartAttempts: number
  healthCheckTimer: ReturnType<typeof setInterval> | null
}

const state: PythonManagerState = {
  process: null,
  running: false,
  healthy: false,
  restartAttempts: 0,
  healthCheckTimer: null,
}

// ── 工具函数 ────────────────────────────────────────

function log(msg: string) {
  console.log(`[PythonManager] ${msg}`)
}

function warn(msg: string) {
  console.warn(`[PythonManager] ⚠️ ${msg}`)
}

function error(msg: string) {
  console.error(`[PythonManager] ❌ ${msg}`)
}

/** 查找可用的 Python 可执行文件 */
async function findPython(): Promise<string> {
  const candidates = ['python3', 'py', 'python']
  for (const bin of candidates) {
    try {
      const { execSync } = require('child_process')
      execSync(`${bin} --version`, { stdio: 'pipe', timeout: 3000 })
      return bin
    } catch {
      continue
    }
  }
  // 尝试从 QwenPaw/Copaw conda 环境找（兼容用户已有环境）
  const userHome = require('os').homedir()
  const condaPaths = [
    join(process.env.QWENPAW_WORKING_DIR || process.env.COPAW_WORKING_DIR || '', 'python.exe'),
    join(userHome, '.qwenpaw', 'python.exe'),
    join(userHome, '.copaw', 'python.exe'),
    join(process.env.CONDA_PREFIX || '', 'python.exe'),
  ]
  for (const p of condaPaths) {
    try {
      const { execSync } = require('child_process')
      execSync(`"${p}" --version`, { stdio: 'pipe', timeout: 3000 })
      return `"${p}"`
    } catch {
      continue
    }
  }
  return 'python'  // 最后的兜底
}

// ── 健康检查 ────────────────────────────────────────

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PYTHON_NODE_PORT}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const data = await res.json()
      state.healthy = data.status === 'ok'
      return state.healthy
    }
  } catch {
    // 连接失败
  }
  state.healthy = false
  return false
}

/** 执行一次健康检查并输出日志 */
async function healthCheckTick(): Promise<void> {
  const ok = await checkHealth()
  if (!ok && state.running) {
    warn(`健康检查失败: http://127.0.0.1:${PYTHON_NODE_PORT}`)
    // 尝试自动恢复
    if (state.restartAttempts < MAX_RESTART_ATTEMPTS) {
      log(`尝试自动重启 (${state.restartAttempts + 1}/${MAX_RESTART_ATTEMPTS})...`)
      await restartPythonServices()
    } else {
      error(`已达最大重启次数 (${MAX_RESTART_ATTEMPTS})，停止自动恢复`)
      stop()
    }
  } else if (ok && !state.healthy) {
    log('服务恢复健康 ✅')
  }
}

// ── 生命周期 ────────────────────────────────────────

async function ensurePythonDeps(): Promise<boolean> {
  /** 检查必要的 Python 包是否安装 */
  try {
    const pythonBin = await findPython()
    const { execSync } = require('child_process')
    execSync(`"${pythonBin}" -c "import edge_tts; import sentence_transformers"`, {
      stdio: 'pipe',
      timeout: 10000,
    })
    return true
  } catch {
    warn('Python 依赖未完全安装，部分功能可能降级')
    return false
  }
}

/**
 * 杀掉占用指定端口的进程（Windows 用 netstat + taskkill）
 */
async function killProcessOnPort(port: number): Promise<void> {
  try {
    const { execSync } = require('child_process')
    // netstat 查找占用端口的 PID
    const result = execSync(
      `netstat -ano | findstr "LISTENING" | findstr ":${port} "`,
      { timeout: 3000, encoding: 'utf8' }
    ).toString().trim()
    if (!result) {return}

    // 提取 PID（最后一列）
    const lines = result.split('\n')
    const pids = new Set<number>()
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      const pid = parseInt(parts[parts.length - 1], 10)
      if (!isNaN(pid) && pid > 0) {pids.add(pid)}
    }

    for (const pid of pids) {
      try {
        execSync(`taskkill /pid ${pid} /f /t`, { timeout: 2000, stdio: 'ignore' })
        log(`清理了端口 ${port} 上的旧进程 (PID ${pid})`)
      } catch {
        // 可能权限不足或进程已死
      }
    }
  } catch {
    // netstat 没找到占用进程，正常情况
  }
}

/**
 * 启动 Python Agent Node
 */
export async function startPythonServices(): Promise<boolean> {
  if (state.running) {
    log('服务已在运行')
    return true
  }

  // ── 启动前清理：杀掉占用端口的旧进程 ──────────────
  await killProcessOnPort(PYTHON_NODE_PORT)
  await killProcessOnPort(PYTHON_WS_PORT)

  const pythonBin = await findPython()
  const scriptPath = join(app.getAppPath(), 'python', 'run_node.py')

  log(`启动 Python Node: ${pythonBin} ${scriptPath} --http-port ${PYTHON_NODE_PORT} --ws-port ${PYTHON_WS_PORT} --lazy`)

  try {
    const proc = spawn(pythonBin, [
      scriptPath,
      '--http-port', String(PYTHON_NODE_PORT),
      '--ws-port', String(PYTHON_WS_PORT),
      '--lazy',
    ], {
      cwd: join(app.getAppPath(), 'python'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    state.process = proc

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n')
      for (const line of lines) {
        if (line) {log(`[stdout] ${line}`)}
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n')
      for (const line of lines) {
        if (line) {error(`[stderr] ${line}`)}
      }
    })

    proc.on('exit', (code, signal) => {
      log(`进程退出 code=${code} signal=${signal}`)
      state.running = false
      state.process = null
      state.healthy = false
    })

    proc.on('error', (err) => {
      error(`进程启动失败: ${err.message}`)
      state.running = false
    })

    state.running = true

    // 等待服务就绪（最长 15 秒）
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500))
      const ok = await checkHealth()
      if (ok) {
        log(`✅ Python Node 就绪 (http://127.0.0.1:${PYTHON_NODE_PORT})`)
        state.restartAttempts = 0
        // 启动心跳
        state.healthCheckTimer = setInterval(healthCheckTick, HEALTH_CHECK_INTERVAL_MS)
        return true
      }
    }

    // 超时未就绪
    warn('Python Node 启动超时，部分功能降级')
    state.healthy = false
    return false
  } catch (err: any) {
    error(`启动失败: ${err.message}`)
    state.running = false
    return false
  }
}

/**
 * 停止 Python Agent Node
 */
export function stopPythonServices(): void {
  log('正在停止 Python Node...')

  if (state.healthCheckTimer) {
    clearInterval(state.healthCheckTimer)
    state.healthCheckTimer = null
  }

  const proc = state.process
  if (!proc || proc.killed) {
    state.running = false
    state.healthy = false
    log('没有运行中的进程')
    return
  }

  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore' })
    } else {
      proc.kill('SIGTERM')
      // 给 3 秒优雅退出，超时强制 kill
      setTimeout(() => {
        if (!proc.killed) {proc.kill('SIGKILL')}
      }, 3000)
    }
  } catch (err: any) {
    error(`停止失败: ${err.message}`)
    try { proc.kill() } catch {}
  }

  state.running = false
  state.healthy = false
  log('Python Node 已停止')
}

/**
 * 重启 Python Agent Node
 */
export async function restartPythonServices(): Promise<boolean> {
  log('重启 Python Node...')
  stopPythonServices()
  // 等待进程完全退出
  await new Promise(r => setTimeout(r, RESTART_COOLDOWN_MS))
  state.restartAttempts++
  return startPythonServices()
}

// ── 状态查询 ────────────────────────────────────────

export function getPythonManagerStatus() {
  return {
    running: state.running,
    healthy: state.healthy,
    httpPort: PYTHON_NODE_PORT,
    wsPort: PYTHON_WS_PORT,
    restartAttempts: state.restartAttempts,
    pid: state.process?.pid ?? null,
  }
}

// ═══════════════════════════════════════════════════════════
// 导出单例访问函数（兼容 main.ts 的 import / require 模式）
// ═══════════════════════════════════════════════════════════

let _instance: PythonManagerAPI | null = null

interface PythonManagerAPI {
  start: () => Promise<boolean>
  stop: () => void
  restart: () => Promise<boolean>
  status: () => ReturnType<typeof getPythonManagerStatus>
}

export function getPythonManager(): PythonManagerAPI {
  if (!_instance) {
    _instance = {
      start: startPythonServices,
      stop: stopPythonServices,
      restart: restartPythonServices,
      status: getPythonManagerStatus,
    }
  }
  return _instance
}
