// ============================================================
// electron/core/platform/platformStatus.ts — 能力运行时状态（结构化降级通道）
//
// 为什么需要这个模块：
//   PlatformAdapter 的方法签名统一返回 `Promise<string>`（中文结果串），
//   这是历史契约，Windows 路径与全部调用点都依赖它，本模块**不改**。
//   但「macOS 没授权 / 该平台不支持」这类信息如果只塞进中文串里，
//   上层无法结构化消费，Settings 页也拿不到「去哪儿开权限」。
//
//   所以另开一条**旁路**：适配器在失败时调用 reportCapabilityStatus(key, status)
//   把结构化状态登记进来，上层（IPC / 设置页 / CU 错误提示）按需读取。
//   纯追加，不影响 Windows 既有行为——Windows 不调用这些 API，状态恒为 ready。
//
// 设计约束：
//   • 纯内存 + 纯函数，不碰 electron / fs，可单测。
//   • 默认值 ready：没登记过的能力视为可用（Windows 行为不变）。
//   • macOS 权限诊断（错误串 → 需要哪个授权）见 macPermissions.ts，
//     本模块只做状态登记与查询。
// ============================================================

// ──────────────────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────────────────

/** macOS 需要用户手动开启的系统授权（对应「系统设置 → 隐私与安全性」下各条目） */
export type MacPermissionKey =
  | 'accessibility'    // 辅助功能：控制键鼠、读 AX 元素树
  | 'screen_recording' // 屏幕录制：screencapture 取屏
  | 'automation'       // 自动化：AppleScript 驱动其它 App

export type CapabilityKey =
  | 'screenshot'
  | 'mouse'
  | 'keyboard'
  | 'window_info'
  | 'uia'
  | 'open_app'
  | 'installed_apps'
  | 'human_input_guard'

export interface CapabilityStatusReady {
  state: 'ready'
  /** 可选：实现方式说明（如 "cliclick + AppleScript"） */
  detail?: string
}

export interface CapabilityStatusUnsupported {
  state: 'unsupported'
  /** 为什么不支持（中文，可直接展示） */
  reason: string
  detail?: string
}

export interface CapabilityStatusNeedsPermission {
  state: 'needs_permission'
  permission: MacPermissionKey
  /** 中文说明（直接展示给用户） */
  reason: string
  /** 「系统设置」里的具体路径，如 '隐私与安全性 → 辅助功能' */
  settingsPath: string
  detail?: string
}

export type CapabilityStatus =
  | CapabilityStatusReady
  | CapabilityStatusUnsupported
  | CapabilityStatusNeedsPermission

/** 三种状态的比较标签（UI 着色用） */
export type CapabilityState = CapabilityStatus['state']

// ──────────────────────────────────────────────────────────
// 权限 → 系统设置路径 / 展示名（纯映射，可单测）
// ──────────────────────────────────────────────────────────

/** macOS 权限 → 「系统设置 → 隐私与安全性」下的子路径 */
export const MAC_PERMISSION_SETTINGS_PATH: Record<MacPermissionKey, string> = {
  accessibility: '系统设置 → 隐私与安全性 → 辅助功能',
  screen_recording: '系统设置 → 隐私与安全性 → 屏幕与系统音频录制',
  automation: '系统设置 → 隐私与安全性 → 自动化',
}

/** macOS 权限 → 展示名 */
export const MAC_PERMISSION_LABEL: Record<MacPermissionKey, string> = {
  accessibility: '辅助功能（Accessibility）',
  screen_recording: '屏幕与系统音频录制（Screen Recording）',
  automation: '自动化（Automation）',
}

/** 造一个 needs_permission 状态（统一 reason 文案，避免各处各写一套） */
export function needsPermission(
  permission: MacPermissionKey,
  actionCn: string,
  detail?: string,
): CapabilityStatusNeedsPermission {
  return {
    state: 'needs_permission',
    permission,
    reason: `执行「${actionCn}」需要${MAC_PERMISSION_LABEL[permission]}权限：请到「${MAC_PERMISSION_SETTINGS_PATH[permission]}」中勾选 Lumina Life，授权后**完全退出并重启**本 App 才生效。`,
    settingsPath: MAC_PERMISSION_SETTINGS_PATH[permission],
    detail,
  }
}

/** 造一个 unsupported 状态 */
export function unsupported(reason: string, detail?: string): CapabilityStatusUnsupported {
  return { state: 'unsupported', reason, detail }
}

/** 造一个 ready 状态 */
export function ready(detail?: string): CapabilityStatusReady {
  return detail ? { state: 'ready', detail } : { state: 'ready' }
}

// ──────────────────────────────────────────────────────────
// 状态登记表（进程内内存）
// ──────────────────────────────────────────────────────────

const _status = new Map<CapabilityKey, CapabilityStatus>()

/** 登记某能力的运行时状态（适配器在探测到失败/未授权时调用） */
export function reportCapabilityStatus(key: CapabilityKey, status: CapabilityStatus): void {
  _status.set(key, status)
}

/** 读某能力状态；未登记过返回 ready（Windows 从不登记，行为与之前完全一致） */
export function getCapabilityStatus(key: CapabilityKey): CapabilityStatus {
  return _status.get(key) ?? { state: 'ready' }
}

/** 一次性读全部已登记状态 */
export function getAllCapabilityStatuses(): Partial<Record<CapabilityKey, CapabilityStatus>> {
  return Object.fromEntries(_status) as Partial<Record<CapabilityKey, CapabilityStatus>>
}

/** 某能力是否处于「不可用」态（unsupported 或 needs_permission） */
export function isCapabilityBlocked(key: CapabilityKey): boolean {
  const s = getCapabilityStatus(key)
  return s.state === 'unsupported' || s.state === 'needs_permission'
}

/**
 * 汇总「当前平台上所有被阻断的能力」为一句中文提示（设置页 / 错误提示用）。
 * 无阻断时返回空串。
 */
export function blockedCapabilitiesHint(): string {
  const all = getAllCapabilityStatuses()
  const parts: string[] = []
  for (const [key, s] of Object.entries(all) as [CapabilityKey, CapabilityStatus][]) {
    if (!s) {continue}
    if (s.state === 'unsupported') {parts.push(`「${CAPABILITY_LABEL[key]}」不可用：${s.reason}`)}
    else if (s.state === 'needs_permission') {parts.push(`「${CAPABILITY_LABEL[key]}」${s.reason}`)}
  }
  return parts.join(' ')
}

/** 能力键 → 中文名（提示文案用） */
export const CAPABILITY_LABEL: Record<CapabilityKey, string> = {
  screenshot: '屏幕截图',
  mouse: '鼠标控制',
  keyboard: '键盘输入',
  window_info: '窗口信息',
  uia: '可访问性元素树',
  open_app: '打开应用',
  installed_apps: '已装应用枚举',
  human_input_guard: '真人接管守卫',
}

/** 测试用：清空登记（避免跨用例串味） */
export function resetCapabilityStatuses(): void {
  _status.clear()
}
