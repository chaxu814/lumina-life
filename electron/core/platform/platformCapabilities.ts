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
