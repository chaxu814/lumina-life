// ============================================================
// electron/core/platform/index.ts — 跨平台桌面控制适配层统一出口
// ============================================================

export * from './PlatformAdapter'
export { WindowsAdapter } from './WindowsAdapter'
export { MacAdapter } from './MacAdapter'
export { LinuxAdapter } from './LinuxAdapter'
export type { LinuxAdapterOptions } from './LinuxAdapter'
export {
  createAdapter, getPlatformAdapter, resetPlatformAdapter,
} from './platformFactory'
export type { AdapterEnv } from './platformFactory'
export {
  getPlatformFeatureMatrix,
} from './platformCapabilities'
export type {
  PlatformFeatureEntry, PlatformFeatureMatrix,
} from './platformCapabilities'
