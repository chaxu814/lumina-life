// ============================================================
// pet/platformCaps.ts — 桌宠窗口跨平台能力探测（纯逻辑 + 可单测）
//
// 透明无边框窗口在三个平台的前提不同：
//   • Windows：DWM 合成始终可用，透明 + setShape 物理裁剪都支持。
//   • macOS：透明窗口可用；但 Electron 的 win.setShape 在 macOS 不支持（忽略）。
//   • Linux：透明需要「正在合成的窗口管理器」（Wayland 一般有；X11 需 mutter/kwin
//     开启合成或 xcompmgr/picom）。没有合成器时 transparent:true 会得到纯黑背景。
//
// 因此这里给出一个可被环境变量覆盖的能力表：
//   LUMINA_DISABLE_TRANSPARENCY=1  → 强制关透明（Linux 无合成器时的逃生开关）
//   LUMINA_FORCE_SET_SHAPE=1       → 强行尝试 setShape（默认仅 Windows）
// 关闭透明时窗口退化为「带底面板」形态（实色背景、不做 setShape），不再黑屏。
// ============================================================

export interface PlatformCaps {
  /** 是否创建透明无边框窗口（false 时退化为实色面板） */
  transparent: boolean
  /** 是否支持 win.setShape 物理裁剪（目前仅 Windows） */
  setShape: boolean
  /** 背景色（透明时为透明黑，否则为实色主题底） */
  backgroundColor: string
  /** 是否始终置顶（Linux 某些平铺 WM 可能不支持，仍允许尝试） */
  alwaysOnTop: boolean
  /** 人类可读的平台名（用于设置页/日志） */
  label: string
  /** 能力降级原因（透明被关时说明，便于设置页提示用户） */
  note?: string
}

export interface PlatformEnv {
  platform: NodeJS.Platform | string
  /** 'wayland' | 'x11' | undefined（XDG_SESSION_TYPE） */
  sessionType?: string
  /** 环境变量开关（已规范化为小写） */
  disableTransparency?: string
  forceSetShape?: string
}

/** 实色面板背景（与品牌暗紫调一致，避免 Linux 无合成器时黑屏） */
export const SOLID_PANEL_BG = '#15101f'

/**
 * 纯函数：给定平台与环境，解析桌宠窗口能力。便于单测覆盖 win/mac/linux/wayland/开关。
 */
export function resolvePlatformCaps(env: PlatformEnv): PlatformCaps {
  const platform = String(env.platform)
  const session = (env.sessionType || '').toLowerCase()
  const disableTrans = (env.disableTransparency || '').toLowerCase() === '1'
  const forceShape = (env.forceSetShape || '').toLowerCase() === '1'

  const base: PlatformCaps = {
    transparent: true,
    setShape: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    label: platform,
  }

  if (platform === 'win32') {
    return { ...base, setShape: true, label: 'Windows' }
  }

  if (platform === 'darwin') {
    // macOS 透明可用，但 setShape 不支持
    return { ...base, setShape: false, label: 'macOS' }
  }

  if (platform === 'linux') {
    // Wayland 通常自带合成；X11 不一定。默认仍尝试透明，但允许一键关闭。
    const compositorHint = session === 'wayland'
    const transparent = !disableTrans
    return {
      ...base,
      transparent,
      setShape: forceShape, // Linux 上默认不做 setShape，避免区域异常
      backgroundColor: transparent ? '#00000000' : SOLID_PANEL_BG,
      label: session === 'wayland' ? 'Linux (Wayland)' : 'Linux (X11)',
      note: transparent
        ? (compositorHint
            ? 'Wayland 合成可用，透明桌宠正常'
            : 'X11 下若桌宠区域发黑，说明窗口管理器未开合成；设置环境变量 LUMINA_DISABLE_TRANSPARENCY=1 可退化为面板模式')
        : '已关闭透明（LUMINA_DISABLE_TRANSPARENCY=1），桌宠以面板模式显示',
    }
  }

  // 其它/未知平台：保守地退化到实色面板
  return {
    ...base,
    transparent: false,
    setShape: false,
    backgroundColor: SOLID_PANEL_BG,
    label: platform || 'unknown',
    note: '未识别平台，桌宠以面板模式显示',
  }
}

/**
 * 从当前进程环境解析能力（Electron 主进程用）。
 */
export function currentPlatformCaps(): PlatformCaps {
  return resolvePlatformCaps({
    platform: process.platform,
    sessionType: process.env.XDG_SESSION_TYPE,
    disableTransparency: process.env.LUMINA_DISABLE_TRANSPARENCY,
    forceSetShape: process.env.LUMINA_FORCE_SET_SHAPE,
  })
}
