// ============================================================
// electron/gaming/focus.ts — 游戏窗口焦点鲁棒性
//
// 解决"焦点被抢"问题：输入法候选框 / 翻译气泡 / 通知中心 / 其他窗口
// 抢走键盘焦点，导致 autoPlay 的键鼠操作打在错误窗口上。
//
// 策略（focusWindowRobust）：
//   1. 优先调用平台适配器 focusWindow(title)
//      —— Windows 上已封装 EnumWindows + AttachThreadInput +
//         SetForegroundWindow + 点窗口中心聚焦内容区；
//   2. 等待 100-200ms 后用 getActiveWindow 验证前台窗口标题是否匹配；
//      不匹配则重试一次；
//   3. 适配器无 focusWindow / 仍不匹配 → PowerShell AppActivate 兜底；
//   4. 聚焦后发 ESC 关闭可能残留的菜单 / 候选框 / 翻译气泡（best-effort）。
//
// 全部依赖可注入，便于单测（不真实操作系统）。
// ============================================================

import { execCmd } from '../core/platform'

/** 与平台适配器 focusWindow / getActiveWindow 相关的最小结构（避免强耦合） */
export interface FocusAdapterLike {
  focusWindow?: (titleSubstring: string) => Promise<boolean>
  getActiveWindow?: () => Promise<{ title: string; processName?: string; bounds?: unknown } | null>
}

/** 可注入依赖（测试用） */
export interface FocusDeps {
  /** 取平台适配器（默认走 getPlatformAdapter） */
  getAdapter?: () => Promise<FocusAdapterLike | null | undefined>
  /** 执行外部命令（默认走 execCmd） */
  exec?: (cmd: string, args: string[]) => Promise<string>
  /** 可注入 sleep */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 默认取适配器（动态 import，避免测试环境硬依赖 electron） */
async function defaultGetAdapter(): Promise<FocusAdapterLike | null> {
  try {
    const { getPlatformAdapter } = await import('../core/platform')
    return (getPlatformAdapter() as FocusAdapterLike) || null
  } catch {
    return null
  }
}

/**
 * PowerShell AppActivate 兜底脚本：
 * WScript.Shell.AppActivate 按标题激活窗口（前台锁时可能失败，best-effort）。
 */
function psAppActivate(title: string): string {
  const t = title.replace(/'/g, "''")
  return `(New-Object -ComObject WScript.Shell).AppActivate('${t}') | Out-Null; Start-Sleep -Milliseconds 150; Write-Output 'OK'`
}

/** 关闭干扰弹窗：发 ESC（关闭候选框 / 翻译气泡 / 通知中心 / 残留菜单） */
const PS_DISMISS_POPUPS = `(New-Object -ComObject WScript.Shell).SendKeys('{ESC}'); Write-Output 'OK'`

/**
 * 把目标游戏窗口拉到前台并确保输入焦点落在窗口内。
 * 返回是否确认前台窗口标题已匹配（无法验证时退化为 AppActivate 是否成功）。
 */
export async function focusWindowRobust(
  title: string,
  deps: FocusDeps = {},
): Promise<boolean> {
  const sleep = deps.sleep || defaultSleep
  const exec = deps.exec || execCmd
  const getAdapter = deps.getAdapter || defaultGetAdapter
  const needle = (title || '').trim()
  if (!needle) {return false}

  const adapter = await getAdapter()
  const lowerNeedle = needle.toLowerCase()

  /** 读取前台窗口标题，判断是否已命中目标 */
  const currentTitleMatch = async (): Promise<boolean> => {
    if (!adapter?.getActiveWindow) {return false}
    try {
      const aw = await adapter.getActiveWindow()
      const t = (aw?.title || '').toLowerCase()
      return t.includes(lowerNeedle)
    } catch {
      return false
    }
  }

  let matched = await currentTitleMatch()

  // 1) 适配器聚焦（Windows 上含 AttachThreadInput 绕过前台锁 + 点中心）
  if (!matched && adapter?.focusWindow) {
    try {await adapter.focusWindow(needle)} catch { /* 忽略，走兜底 */ }
    await sleep(150)
    matched = await currentTitleMatch()
  }

  // 2) 仍不匹配 → 重试一次
  if (!matched && adapter?.focusWindow) {
    try {await adapter.focusWindow(needle)} catch { /* 忽略 */ }
    await sleep(150)
    matched = await currentTitleMatch()
  }

  // 3) 适配器不可用 / 仍失败 → PowerShell AppActivate 兜底
  let activateOk = false
  if (!matched) {
    try {
      const r = await exec('powershell', ['-NoProfile', '-Command', psAppActivate(needle)])
      activateOk = !r.startsWith('ERR:')
    } catch {activateOk = false}
    await sleep(150)
    matched = await currentTitleMatch()
  }

  // 4) 关闭干扰弹窗（best-effort，不阻断；ESC 关掉候选框/菜单/气泡）
  try {await exec('powershell', ['-NoProfile', '-Command', PS_DISMISS_POPUPS])} catch { /* 忽略 */ }

  return matched || activateOk
}
