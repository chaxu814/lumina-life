// ============================================================
// electron/core/platform/macPermissions.ts — macOS 失败诊断（错误串 → 授权指引）
//
// ============================================================
// 背景：macOS 的权限失败**不会**以清晰的退出码返回，而是混在
//   osascript / screencapture 的 stderr 文本里，且不同系统版本措辞不同。
//   典型样本：
//     osascript  : "execution error: Error 1002 ... "  /
//                  "Not authorized to send Apple events to System Events. (-1743)"
//     screencapture: "screencapture: cannot run" /
//                  "tccERR" / CGError 相关
//     辅助功能被拒时 cliclick 往往直接退出码非 0 且无输出。
//
// 如果只是把 stderr 原样回传给用户，用户看到的是一句英文堆栈，
// 根本不知道要去哪儿开权限——这正是「静默失败」的一种伪装。
// 本模块把这些串归一为 (kind, permission, 中文原因) 三元组，
// 供 MacAdapter 转成结构化 CapabilityStatus。
//
// ⚠️ 措辞匹配是 best-effort：Apple 未提供稳定的错误码契约，
//   新版 macOS 可能改写文案。因此 classifyMacFailure 一律有 'unknown' 兜底，
//   且 MacAdapter 在 unknown 时**仍然回传原始 stderr**（附在 reason 里），
//   保证即便分类失效，诊断信息也不丢失。
// ============================================================
//
// 纯函数、零依赖、可在 Windows 上完整单测。
// ============================================================

import type { MacPermissionKey } from './platformStatus'

export type MacFailureKind =
  | 'accessibility'     // 辅助功能未授权 → 键鼠 / AX 树
  | 'screen_recording'  // 屏幕录制未授权 → 截屏
  | 'automation'        // 自动化未授权 → 驱动其它 App
  | 'not_found'         // 命令不存在（cliclick 未装等）
  | 'timeout'           // 超时
  | 'unknown'

export interface MacFailureDiagnosis {
  kind: MacFailureKind
  /** 需要的 macOS 授权；kind 非权限类时为 undefined */
  permission?: MacPermissionKey
  /** 面向用户的中文原因（可直接展示） */
  message: string
  /** 原始错误串（分类失败时也保留，供排障） */
  raw: string
}

/** 截断过长 stderr，避免把整段 AppleScript 回显塞进 UI */
function clip(s: string, n = 300): string {
  const t = String(s || '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

// ── 各权限的中文原因文案 ────────────────────────────────

const MSG: Record<MacFailureKind, string> = {
  accessibility:
    '未授予「辅助功能（Accessibility）」权限。请到「系统设置 → 隐私与安全性 → 辅助功能」中勾选 Lumina Life（若列表里没有，点 + 手动添加本 App），授权后完全退出并重启本 App。',
  screen_recording:
    '未授予「屏幕与系统音频录制（Screen Recording）」权限。请到「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中勾选 Lumina Life，授权后完全退出并重启本 App。',
  automation:
    '未授予「自动化（Automation）」权限。首次用脚本驱动其它 App 时请在弹窗中点「好」，或在「系统设置 → 隐私与安全性 → 自动化」中为 Lumina Life 打开对应 App 的开关。',
  not_found:
    '系统里找不到该命令。macOS 上请先 `brew install cliclick`（键鼠长按/拖拽依赖它），装完完全退出并重启本 App。',
  timeout: '命令执行超时。可能是目标 App 正忙或系统弹出了未响应的授权对话框，请检查是否有弹窗挡住。',
  unknown: '命令执行失败（未能自动识别原因）。',
}

const PERMISSION_OF: Partial<Record<MacFailureKind, MacPermissionKey>> = {
  accessibility: 'accessibility',
  screen_recording: 'screen_recording',
  automation: 'automation',
}

// ── 识别规则 ────────────────────────────────────────────

/** 辅助功能未授权的强特征：-1743 错误码 / "assistive access" 字样（不依赖调用上下文） */
const ACCESSIBILITY_STRONG_RE = /-1743|assistive access/i

/** 「无权发送 Apple events」——可能是辅助功能，也可能是自动化，需要结合上下文判 */
const APPLE_EVENTS_RE = /not authorized to send apple events|not authorized for assistive/i

/** 屏幕录制未授权的典型特征（screencapture 的 TCC 失败） */
const SCREEN_RECORDING_RE = /tccerr|screen\s*record|cgscreen|accessibility.*screen|not permitted|cgerror|kcgerror|failed to invoke|could not create.*image/i

/** 自动化未授权（区别于辅助功能：能连上 App 但不能发 Apple events） */
const AUTOMATION_RE = /not authorized to send apple events|apple event/i

/** 命令不存在（ENOENT / not found） */
const NOT_FOUND_RE = /\benoent\b|command not found|not found|no such file or directory|is not recognized as an internal or external command/i

/** 超时 */
const TIMEOUT_RE = /timed?\s*out|timeout|etimedout/i

/**
 * 把任意 macOS 子进程失败串归一为结构化诊断。
 *
 * @param raw stderr / 错误消息（execCmd 的 ERR: 串或原始文本皆可）
 * @param hint 上下文提示，用于在无法判定时缩小候选（如 "截屏" 优先考虑 screen_recording）
 */
export function classifyMacFailure(raw: string, hint?: 'screenshot' | 'input' | 'ax' | 'app'): MacFailureDiagnosis {
  const s = String(raw || '')
  const clipped = clip(s)

  // ── 判别顺序（有意为之） ──
  // 1) -1743 / "assistive access" 是辅助功能的**强特征**，不看上下文直接命中。
  //    关键：必须早于 apple-events 判定，否则 -1743 会被泛化成「自动化未授权」，
  //    把用户引到「自动化」面板——而实际上该开的是「辅助功能」，用户会反复找不到。
  if (ACCESSIBILITY_STRONG_RE.test(s)) {
    return { kind: 'accessibility', permission: 'accessibility', message: MSG.accessibility, raw: clipped }
  }

  if (NOT_FOUND_RE.test(s)) {
    return { kind: 'not_found', message: MSG.not_found, raw: clipped }
  }

  // 2) 单纯的 "Not authorized to send Apple events"：在 System Events 调用上下文
  //    （键鼠 / AX）里，它实际就是辅助功能没开；在「驱动其它 App」上下文里
  //    才是自动化没开。同一条错误串，两个面板，不能一刀切。
  if (APPLE_EVENTS_RE.test(s)) {
    if (hint === 'app') {
      return { kind: 'automation', permission: 'automation', message: MSG.automation, raw: clipped }
    }
    return { kind: 'accessibility', permission: 'accessibility', message: MSG.accessibility, raw: clipped }
  }

  if (hint === 'screenshot' && SCREEN_RECORDING_RE.test(s)) {
    return { kind: 'screen_recording', permission: 'screen_recording', message: MSG.screen_recording, raw: clipped }
  }

  if (SCREEN_RECORDING_RE.test(s) && !hint) {
    return { kind: 'screen_recording', permission: 'screen_recording', message: MSG.screen_recording, raw: clipped }
  }

  if (TIMEOUT_RE.test(s)) {
    return { kind: 'timeout', message: MSG.timeout, raw: clipped }
  }

  // 上下文兜底：截屏失败且说不清原因时，按屏幕录制处理（macOS 截屏失败最常见原因就是 TCC）
  if (hint === 'screenshot') {
    return { kind: 'screen_recording', permission: 'screen_recording', message: MSG.screen_recording, raw: clipped }
  }

  // 键鼠失败且说不清原因：多数是辅助功能没开
  if (hint === 'input' || hint === 'ax') {
    return { kind: 'accessibility', permission: 'accessibility', message: MSG.accessibility, raw: clipped }
  }

  return { kind: 'unknown', message: MSG.unknown, raw: clipped }
}

/**
 * 诊断 → 面向用户的完整一句话（把原因 + 原始错误拼起来）。
 * 分类成功时不重复贴原始串，避免噪音；分类失败时必须带上原文。
 */
export function formatFailure(d: MacFailureDiagnosis): string {
  if (d.kind === 'unknown') {
    return `${d.message}原始错误：${d.raw || '(空)'}`
  }
  return d.message
}

/** 该诊断是否属于「需要用户去开权限」类型（决定要不要登记 needs_permission 状态） */
export function isPermissionFailure(d: MacFailureDiagnosis): boolean {
  return d.kind === 'accessibility' || d.kind === 'screen_recording' || d.kind === 'automation'
}

/** 便捷：由诊断构造中文错误串，供 MacAdapter 现有的 string 返回契约使用 */
export function failureMessage(d: MacFailureDiagnosis, verb: string): string {
  return `${verb}失败:${formatFailure(d)}`
}

export { PERMISSION_OF }
