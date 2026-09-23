// ============================================================
// electron/gaming/profiles/index.ts — 统一导出
// ============================================================

export type {
  GameProfile,
  ProfileAction,
  ProfileSecurity,
} from './types'

export { minecraftProfile } from './minecraft'
export { factorioProfile } from './factorio'
export { genericProfile } from './generic'
export {
  PROFILES,
  getProfile,
  listProfiles,
  detectActiveProfile,
} from './registry'
