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
export { stardewValleyProfile } from './stardewValley'
export { civilization6Profile } from './civilization6'
export { genericProfile } from './generic'
export {
  PROFILES,
  getProfile,
  listProfiles,
  detectActiveProfile,
} from './registry'
