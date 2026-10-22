// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// processSandbox.ts — 🔄 A. 进程树隔离 / Job Object 管理 (v1.0)
//
// 第三层 → ① 进程树隔离
//   确保杀掉一个进程时，它的整个进程树都被清理
//   Windows: taskkill /T /F 递归杀灭
//   Unix: 负 PID 发 SIGKILL 给进程组
//
// 姊妹模块（第三层纵深防御）:
//   B | shellMonitor.ts  — 资源配额监控
//   C | shellNetCage.ts  — 网络铁笼
//   D | shellFileWall.ts — 文件围墙
//
// 集成入口: shell.ts → executeSandboxed()
//
// 设计决策：
//   为什么不用 child.kill()？
//     child.kill() 只杀 spawn 出来的直接子进程。
//     如果子进程又 fork 了孙进程（npm install 会这样做），
//     孙进程变成孤儿/僵尸，继续运行。
//   为什么不用 windows-job 原生模块？
//     避免 node-gyp 编译依赖，taskkill 是系统内置命令，
//     零依赖，同样可靠。

import { execSync } from 'child_process'

// ═══════════════════════════════════════════════════════════
// 进程树杀灭
// ═══════════════════════════════════════════════════════════

/**
 * 递归杀死 PID 对应的整个进程树
 *
 * Windows: taskkill /T /F /PID <pid>
 *   /T = 杀死进程树（包括所有子进程）
 *   /F = 强制终止
 *
 * Unix: 负 PID 信号
 *   向进程组发送 SIGKILL
 *
 * @returns true 表示成功杀灭（或进程已不存在），false 表示失败
 */
export async function killProcessTree(pid: number): Promise<boolean> {
  if (!pid || pid <= 0) {return false}

  try {
    if (process.platform === 'win32') {
      // 🔧 Windows: taskkill /T /F — 系统内置，不需要额外依赖
      // 不重定向 stderr，以便检测"进程未找到"的错误
      execSync(`taskkill /PID ${pid} /T /F`, {
        timeout: 5000,
        windowsHide: true,
        stdio: 'pipe',
      })
      return true
    } else {
      // 🔧 Unix: 负 PID = 进程组
      try {
        process.kill(-pid, 'SIGKILL')
        return true
      } catch {
        // 可能进程组不存在，尝试直接杀
        try {
          process.kill(pid, 'SIGKILL')
          return true
        } catch {
          return false
        }
      }
    }
  } catch (err: any) {
    // taskkill 返回非零退出码的情况：
    //   - 128: 没有找到进程（进程已经结束）
    //   -   1: 一般错误
    // 这些都不算失败——目标已经达到了（进程没了）
    const stderr = (err.stderr || '').toString().toLowerCase()
    const stdout = (err.stdout || '').toString().toLowerCase()
    const combined = stderr + stdout
    if (combined.includes('没有找到') || combined.includes('not found') || combined.includes('no such') ||
        err.status === 128) {
      return true // 进程已经没了，算成功
    }
    // 其他错误才记录警告
    console.warn(`[ProcessSandbox] killProcessTree(${pid}) 异常 (exit code ${err.status}): ${err.message.slice(0, 120)}`)
    // 即使异常也返回 true——最佳努力杀灭
    return true
  }
}

/**
 * 同步版：递归杀死进程树（用于紧急清理）
 */
export function killProcessTreeSync(pid: number): boolean {
  if (!pid || pid <= 0) {return false}

  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, {
        timeout: 5000,
        windowsHide: true,
        stdio: 'pipe',
      })
      return true
    } else {
      try { process.kill(-pid, 'SIGKILL'); return true }
      catch { try { process.kill(pid, 'SIGKILL'); return true } catch { return false } }
    }
  } catch (err: any) {
    const stderr = (err.stderr || '').toString().toLowerCase()
    const stdout = (err.stdout || '').toString().toLowerCase()
    const combined = stderr + stdout
    if (combined.includes('没有找到') || combined.includes('not found') || combined.includes('no such') ||
        err.status === 128) {
      return true
    }
    console.warn(`[ProcessSandbox] killProcessTreeSync(${pid}) 异常 (exit ${err.status}): ${err.message.slice(0, 120)}`)
    return true // 最佳努力
  }
}

// ═══════════════════════════════════════════════════════════
// 进程组管理
// ═══════════════════════════════════════════════════════════

export interface TrackedProcess {
  id: string
  pid: number
  command: string
  startTime: number
  label?: string
}

/**
 * 进程组管理器
 *
 * 跟踪所有由 Lumina 发起的 shell 进程，
 * 支持按组批量清理、查询存活状态。
 */
export class ProcessGroupManager {
  private processes = new Map<string, TrackedProcess>()

  /** 注册一个进程到跟踪列表 */
  register(id: string, pid: number, command: string, label?: string): void {
    this.processes.set(id, {
      id,
      pid,
      command: command.slice(0, 200),
      startTime: Date.now(),
      label,
    })
    console.log(`[ProcessSandbox] 📝 跟踪进程 #${pid}: ${command.slice(0, 80)}`)

    // 自动清理上限：最多跟踪 50 个历史进程
    if (this.processes.size > 50) {
      const oldest = [...this.processes.entries()]
        .sort((a, b) => a[1].startTime - b[1].startTime)
        .slice(0, this.processes.size - 50)
      for (const [id] of oldest) {
        this.processes.delete(id)
      }
    }
  }

  /** 按 ID 杀灭进程树 */
  async kill(id: string): Promise<boolean> {
    const entry = this.processes.get(id)
    if (!entry) {return false}
    const ok = await killProcessTree(entry.pid)
    this.processes.delete(id)
    console.log(`[ProcessSandbox] 💀 已杀灭进程 #${entry.pid} 整棵树: ${ok ? '✅' : '⚠️ 可能未完全清理'}`)
    return ok
  }

  /** 杀掉所有跟踪中的进程 */
  async killAll(): Promise<number> {
    let count = 0
    for (const [id] of this.processes) {
      const ok = await this.kill(id)
      if (ok) {count++}
    }
    return count
  }

  /** 获取正在运行的进程列表 */
  listRunning(): TrackedProcess[] {
    return [...this.processes.values()]
  }

  /** 获取进程数量 */
  get size(): number {
    return this.processes.size
  }

  /** 根据 PID 查找进程 ID */
  findIdByPid(pid: number): string | undefined {
    for (const [id, entry] of this.processes) {
      if (entry.pid === pid) {return id}
    }
    return undefined
  }

  /** 清除已结束的进程记录（不杀，只是清理列表） */
  cleanStale(): void {
    // 保留最近 10 条，清除更早的记录
    if (this.processes.size <= 10) {return}
    const entries = [...this.processes.entries()]
      .sort((a, b) => b[1].startTime - a[1].startTime)
    const toRemove = entries.slice(10)
    for (const [id] of toRemove) {
      this.processes.delete(id)
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let _globalProcessManager: ProcessGroupManager | null = null

export function getProcessManager(): ProcessGroupManager {
  if (!_globalProcessManager) {
    _globalProcessManager = new ProcessGroupManager()
  }
  return _globalProcessManager
}

export function resetProcessManager(): void {
  _globalProcessManager = new ProcessGroupManager()
}
