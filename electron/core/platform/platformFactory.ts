// ============================================================
// electron/core/platform/platformFactory.ts — 平台适配器工厂 + 单例
//
// createAdapter(platform, env?) 按平台构造适配器（可注入环境，便于单测）。
// getPlatformAdapter() 主进程单例，按 process.platform 选择实现。
// ============================================================

import { PlatformAdapter } from './PlatformAdapter'
import { WindowsAdapter } from './WindowsAdapter'
import { MacAdapter } from './MacAdapter'
import { LinuxAdapter, LinuxAdapterOptions } from './LinuxAdapter'

export interface AdapterEnv {
  /** 注入 XDG_SESSION_TYPE（仅 Linux 用） */
  sessionType?: string
  /** 注入 xdotool 是否可用（仅 Linux 用，便于单测） */
  xdotoolAvailable?: boolean
  /** 注入 grim 是否可用（仅 Linux Wayland 截屏用，便于单测） */
  grimAvailable?: boolean
  /** 注入 cliclick 是否可用（仅 macOS 用，便于单测） */
  cliclickAvailable?: boolean
  /**
   * 注入 macOS 显示器信息（point/DIP，与 electron.screen.getAllDisplays() 同构）。
   * 缺省由 MacAdapter 自行从 electron.screen 读取；单测用它验证坐标换算。
   */
  displays?: import('./macCoordinate').DisplayInfo[]
  /** 锁定 macOS 缩放比（1 = 非 Retina；缺省由截图像素尺寸实测反推） */
  forceScale?: number
}

/** 按平台构造适配器（纯函数，可单测，不触碰全局单例） */
export function createAdapter(platform: string, env: AdapterEnv = {}): PlatformAdapter {
  if (platform === 'win32') {return new WindowsAdapter()}
  if (platform === 'darwin') {
    return new MacAdapter({
      cliclickAvailable: env.cliclickAvailable,
      displays: env.displays,
      forceScale: env.forceScale,
    })
  }
  if (platform === 'linux') {
    const opts: LinuxAdapterOptions = {
      sessionType: env.sessionType,
      xdotoolAvailable: env.xdotoolAvailable,
      grimAvailable: env.grimAvailable,
    }
    return new LinuxAdapter(opts)
  }
  // 未知平台：保守退化为 Linux 无能力模式（既不抛错，也不假装可控）
  const fallback = new LinuxAdapter({ sessionType: 'x11', xdotoolAvailable: false, ...env })
  fallback.capabilities.platform = platform as NodeJS.Platform
  fallback.capabilities.notes = [`未识别平台「${platform}」，桌面操控已禁用。`, ...fallback.capabilities.notes]
  return fallback
}

let _instance: PlatformAdapter | null = null

/** 主进程单例（按当前 process.platform + 真实进程环境） */
export function getPlatformAdapter(): PlatformAdapter {
  if (!_instance) {
    _instance = createAdapter(process.platform, {
      sessionType: process.env.XDG_SESSION_TYPE,
    })
  }
  return _instance
}

/** 测试/热切换用：重置单例 */
export function resetPlatformAdapter(): void {
  _instance = null
}
