// ============================================================
// pythonBin.ts — 跨平台 Python 可执行文件解析
//
// Windows 通常是 `python`（或 `py`）；macOS/Linux 自带 `python3`，
// 许多发行版没有 `python` 这个名字。可选 Python 能力（语音/抓取）统一走这里。
// 纯标准库 + 缓存，Electron 与 CLI 都可用。
// ============================================================

import { execSync } from 'child_process'

let cached: string | null = null

/** 候选顺序：Windows 用 python 优先，类 Unix 用 python3 优先 */
function candidates(): string[] {
  if (process.platform === 'win32') {return ['python', 'py', 'python3']}
  return ['python3', 'python']
}

/**
 * 返回当前平台可用的 Python 命令名（不可用时给一个合理默认，
 * 让调用方的失败被自己的 try/catch 兜住，而不是直接抛错）。
 */
export function resolvePython(): string {
  if (cached) {return cached}
  for (const bin of candidates()) {
    try {
      execSync(`${bin} --version`, { stdio: 'pipe', timeout: 3000 })
      cached = bin
      return bin
    } catch {
      // 继续下一个候选
    }
  }
  cached = process.platform === 'win32' ? 'python' : 'python3'
  return cached
}

/** 仅供测试：重置缓存 */
export function __resetPythonCacheForTest(): void {
  cached = null
}
