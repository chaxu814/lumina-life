// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/core/platform/platformCapabilities.ts — 全应用功能在各平台的可用矩阵
//
// 与桌宠窗口能力（electron/pet/platformCaps.ts）互补：
// 那里管窗口透明/setShape，这里管「聊天/桌宠/记忆/人格/技能/Computer Use/
// 可访问性树/语音/视觉看屏」这条核心体验链在当前平台是否开箱可用。
//
// 主进程据此通过 IPC（platform:get-features）把能力表暴露给前端设置页，
// 前端可对不可用能力做隐藏/置灰+原因说明。本次不改前端 UI。
// ============================================================

import { getPlatformAdapter } from './platformFactory'
import type { PlatformCaps } from '../../pet/platformCaps'
import { currentPlatformCaps } from '../../pet/platformCaps'
import type { DetailedPlatformCapabilities } from './PlatformAdapter'

export interface PlatformFeatureEntry {
  /** 是否开箱可用 */
  available: boolean
  /** 中文说明（不可用时给原因/授权指引） */
  note?: string
}

export interface PlatformFeatureMatrix {
  platform: NodeJS.Platform
  /** 会话类型（Linux: wayland/x11） */
  sessionType?: string
  features: {
    chat: PlatformFeatureEntry
    pet: PlatformFeatureEntry
    memory: PlatformFeatureEntry
    persona: PlatformFeatureEntry
    skills: PlatformFeatureEntry
    computerUse: PlatformFeatureEntry
    uia: PlatformFeatureEntry
    voice: PlatformFeatureEntry
    screenVision: PlatformFeatureEntry
  }
}

/**
 * 计算当前平台的功能矩阵。纯逻辑：聊天/记忆/人格/技能与平台无关，恒可用；
 * 桌宠透明性委托 pet/platformCaps；Computer Use / UIA / 视觉看屏委托适配器能力。
 */
export function getPlatformFeatureMatrix(): PlatformFeatureMatrix {
  const adapter = getPlatformAdapter()
  const cap = adapter.capabilities
  const petCaps: PlatformCaps = currentPlatformCaps()
  const platform = process.platform

  const coreAlways: PlatformFeatureEntry = { available: true }

  return {
    platform,
    sessionType: process.env.XDG_SESSION_TYPE,
    features: {
      chat: coreAlways,
      // 桌宠：透明性被关时退化为面板，但仍可用
      pet: {
        available: true,
        note: petCaps.transparent ? undefined : petCaps.note,
      },
      memory: coreAlways,
      persona: coreAlways,
      skills: coreAlways,
      computerUse: {
        available: cap.mouse && cap.keyboard && cap.screenshot,
        note: cap.notes.length ? cap.notes.join('；') : undefined,
      },
      uia: {
        available: cap.uia,
        note: cap.uia ? undefined : 'UIA 可访问性元素树仅在 Windows 可用；其它平台以截屏+坐标操控。',
      },
      // 语音（STT/TTS）走 Python/Chromium Web Speech，与 OS 无强绑定，默认可用
      voice: coreAlways,
      screenVision: {
        available: cap.screenshot,
        note: cap.screenshot ? undefined : '当前平台无法截屏，视觉看屏不可用。',
      },
    },
  }
}

// ──────────────────────────────────────────────────────────
// 详细能力矩阵（method + 所需权限），供前端设置页逐项展示
// ──────────────────────────────────────────────────────────

/** 构造详细矩阵时可注入的探测结果（便于单测三平台全量，不实际执行系统命令） */
export interface DetailedMatrixDriver {
  platform: 'win32' | 'darwin' | 'linux'
  /** Linux: x11/wayland/aquamarine */
  displayServer?: 'x11' | 'wayland' | 'aquamarine'
  /** Linux: xdotool 是否安装 */
  xdotoolAvailable?: boolean
  /** Linux Wayland: grim 是否安装 */
  grimAvailable?: boolean
  /** macOS: cliclick 是否安装 */
  cliclickAvailable?: boolean
}

/**
 * 产出当前（或注入的）平台详细能力矩阵。
 * 与 getPlatformFeatureMatrix 的区别：那里给「聊天/桌宠/CU」这条产品功能链的布尔可用性；
 * 这里给 Computer Use 子能力逐项的「实现命令 + 需要的系统权限/依赖」，前端可渲染成表格。
 */
export function getDetailedCapabilityMatrix(driver?: DetailedMatrixDriver): DetailedPlatformCapabilities {
  const d: DetailedMatrixDriver = driver ?? {
    platform: process.platform as 'win32' | 'darwin' | 'linux',
    displayServer: (process.env.XDG_SESSION_TYPE || '').toLowerCase() as DetailedMatrixDriver['displayServer'],
  }
  const notes: string[] = []

  if (d.platform === 'win32') {
    return {
      platform: 'win32',
      displayServer: 'win32',
      screenshot: { supported: true, method: 'screenshot-desktop + PowerShell（含隐私遮罩/多显示器）' },
      mouse: { supported: true, method: 'user32.dll SendInput / mouse_event' },
      keyboard: { supported: true, method: '剪贴板粘贴（支持中文）+ SendKeys 组合键' },
      windowManagement: { supported: true, method: 'user32 EnumWindows / SetForegroundWindow' },
      notes: ['Windows 无需额外系统授权，Computer Use 开箱即用。'],
    }
  }

  if (d.platform === 'darwin') {
    const macTool = d.cliclickAvailable === false ? 'AppleScript(System Events)' : 'cliclick + AppleScript(System Events)'
    if (d.cliclickAvailable === false) {
      notes.push('未检测到 cliclick：长按/拖拽不可用，可 brew install cliclick 后重启 App 提升可靠性。')
    }
    notes.push('键鼠需在「系统设置 → 隐私与安全性 → 辅助功能」授权；截屏需在「屏幕录制」授权，授权后重启 App。')
    notes.push('macOS 无 Windows UIA 元素树，Computer Use 以截屏+坐标为主。')
    return {
      platform: 'darwin',
      displayServer: 'cocoa',
      screenshot: {
        supported: true,
        method: 'screencapture -x -t png',
        requiresPermission: '屏幕录制（Screen Recording）',
      },
      mouse: {
        supported: true,
        method: macTool,
        requiresPermission: '辅助功能（Accessibility）',
      },
      keyboard: {
        supported: true,
        method: 'AppleScript keystroke / key code（数字键码映射）',
        requiresPermission: '辅助功能（Accessibility）',
      },
      windowManagement: { supported: true, method: 'AppleScript System Events（前台进程/窗口标题）' },
      notes,
    }
  }

  // linux
  const ds = d.displayServer
  const isWayland = ds === 'wayland' || ds === 'aquamarine'
  if (isWayland) {
    notes.push('Wayland/aquamarine 出于安全模型禁止任意应用全局注入键鼠，鼠标/键盘已禁用。')
    notes.push('如需桌面操控：注销后切换到 X11 会话，或评估 ydotool（需 uinput 权限）。')
    const grimOk = d.grimAvailable !== false
    if (!grimOk) {
      notes.push('Wayland 截屏需安装 grim：sudo apt install grim（wlroots）；GNOME 可用 gnome-screenshot。')
    }
    return {
      platform: 'linux',
      displayServer: ds,
      screenshot: {
        supported: grimOk,
        method: grimOk ? 'grim' : 'grim（未安装）',
        requiresPermission: grimOk ? undefined : 'sudo apt install grim',
      },
      mouse: { supported: false, method: '—（合成器禁止全局注入）' },
      keyboard: { supported: false, method: '—（合成器禁止全局注入）' },
      windowManagement: { supported: false, method: '—（Wayland 不暴露全局窗口枚举）' },
      notes,
    }
  }

  // X11
  const xdo = d.xdotoolAvailable !== false
  if (!xdo) {
    notes.push('未检测到 xdotool，鼠标/键盘不可用：sudo apt install xdotool。')
  }
  notes.push('截屏自动尝试 gnome-screenshot → scrot → import(ImageMagick) 降级链。')
  return {
    platform: 'linux',
    displayServer: ds || 'x11',
    screenshot: { supported: true, method: 'gnome-screenshot / scrot / import(ImageMagick) 自动降级链' },
    mouse: {
      supported: xdo,
      method: xdo ? 'xdotool mousemove/click' : 'xdotool（未安装）',
      requiresPermission: xdo ? undefined : 'sudo apt install xdotool',
    },
    keyboard: {
      supported: xdo,
      method: xdo ? 'xdotool type / key' : 'xdotool（未安装）',
      requiresPermission: xdo ? undefined : 'sudo apt install xdotool',
    },
    windowManagement: {
      supported: xdo,
      method: xdo ? 'xdotool getactivewindow getwindowname' : '—（缺 xdotool）',
    },
    notes,
  }
}
