// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/core/platform/index.ts — 跨平台桌面控制适配层统一出口
// ============================================================

export * from './PlatformAdapter'
export { WindowsAdapter } from './WindowsAdapter'
export { MacAdapter } from './MacAdapter'
export type { MacAdapterOptions } from './MacAdapter'
export { LinuxAdapter } from './LinuxAdapter'
export type { LinuxAdapterOptions } from './LinuxAdapter'
export {
  createAdapter, getPlatformAdapter, resetPlatformAdapter,
} from './platformFactory'
export type { AdapterEnv } from './platformFactory'
export {
  getPlatformFeatureMatrix,
  getDetailedCapabilityMatrix,
} from './platformCapabilities'
export type {
  PlatformFeatureEntry, PlatformFeatureMatrix, DetailedMatrixDriver,
} from './platformCapabilities'
// ── macOS 适配层（坐标 / 权限诊断 / 元素树 / 结构化降级） ──
export {
  computeCaptureGeometry, pixelToPoint, pointToPixel,
  clampPointToDesktop, toInjectablePoint, describeGeometry,
} from './macCoordinate'
export type { CaptureGeometry, DisplayInfo } from './macCoordinate'
export {
  classifyMacFailure, formatFailure, isPermissionFailure, failureMessage,
} from './macPermissions'
export type { MacFailureKind, MacFailureDiagnosis } from './macPermissions'
export {
  buildAxScanScript, parseAxOutput, axRoleToUiType, renderAxElementsText,
  AX_ERROR_PREFIX, AX_DEFAULT_CAP, AX_DEFAULT_DEPTH,
} from './macAccessibility'
export type { AxElement, AxParseResult } from './macAccessibility'
export {
  reportCapabilityStatus, getCapabilityStatus, getAllCapabilityStatuses,
  isCapabilityBlocked, blockedCapabilitiesHint, resetCapabilityStatuses,
  needsPermission, unsupported, ready,
  MAC_PERMISSION_SETTINGS_PATH, MAC_PERMISSION_LABEL, CAPABILITY_LABEL,
} from './platformStatus'
export type {
  CapabilityKey, CapabilityStatus, CapabilityState, MacPermissionKey,
  CapabilityStatusReady, CapabilityStatusUnsupported, CapabilityStatusNeedsPermission,
} from './platformStatus'
