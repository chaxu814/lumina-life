/**
 * platformCapabilitiesClient.ts — 渲染端跨平台能力矩阵客户端
 *
 * 主进程 electron/ipc/platformIpc.ts 通过 platform:get-features 返回当前平台
 * 各核心功能（chat/pet/memory/persona/skills/computerUse/uia/voice/screenVision）
 * 的可用状态与降级说明。本文件是渲染端的薄客户端：
 * - 启动/设置页打开时拉取一次，缓存结果
 * - IPC 未就绪时返回保守的「未知/全部可用」默认，绝不抛错
 * - 供设置页对不可用能力做置灰 + 原因提示（本次不强行改 UI）
 */

export interface PlatformFeatureEntry {
  available: boolean
  note?: string
}

export interface PlatformFeatureMatrix {
  platform: string
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

/** 未取到主进程矩阵时的保守默认：不假装不可用，仅标记为未知 */
const FALLBACK: PlatformFeatureMatrix = {
  platform: 'unknown',
  features: {
    chat: { available: true },
    pet: { available: true },
    memory: { available: true },
    persona: { available: true },
    skills: { available: true },
    computerUse: { available: true },
    uia: { available: false },
    voice: { available: true },
    screenVision: { available: true },
  },
}

let cache: PlatformFeatureMatrix | null = null
let loading: Promise<PlatformFeatureMatrix> | null = null

/** 拉取主进程能力矩阵；失败回退保守默认。重复调用复用同一 Promise。 */
export function loadPlatformFeatures(force = false): Promise<PlatformFeatureMatrix> {
  if (cache && !force) {return Promise.resolve(cache)}
  if (loading && !force) {return loading}
  loading = (async () => {
    const api = (window as any).luminaAPI
    try {
      if (api && typeof api.platformGetFeatures === 'function') {
        const res = await api.platformGetFeatures()
        if (res && res.ok && res.matrix) {
          cache = res.matrix as PlatformFeatureMatrix
          return cache
        }
      }
    } catch { /* 未接线/主进程忙：用默认 */ }
    cache = { ...FALLBACK }
    return cache
  })()
  return loading
}

/** 同步读取（未加载时先回退默认） */
export function getPlatformFeatures(): PlatformFeatureMatrix {
  return cache || { ...FALLBACK }
}

/** 便捷判断：Computer Use 桌面操控当前是否可用 */
export function isComputerUseAvailable(): boolean {
  return getPlatformFeatures().features.computerUse.available
}
