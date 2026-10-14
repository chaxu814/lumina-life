// rituals/index.ts — 仪式感闭环统一导出
export type {
  DailyReplayLike,
  RitualDeps,
  RitualKind,
  RitualUtterance,
  RitualRunRecord,
  RitualConfig,
  RitualState,
  RitualStatus,
} from './types'
export { DEFAULT_RITUAL_CONFIG } from './types'
export { registerRituals, RITUAL_FLAG_NIGHT, RITUAL_FLAG_MORNING } from './register'
export type { RitualsHandle, RegisterOptions } from './register'
export { runNightReview, generateNightUtterance, emptyReplay } from './nightReview'
export { runMorningBriefing, generateMorningUtterance, collectMorningDigest } from './morningBrief'
export type { MorningSources, MorningRunOptions } from './morningBrief'
export { RitualScheduler, parseHHMM } from './scheduler'
export { productionDeps, productionMorningSources } from './productionAdapter'
export { createMemoryPersistence, createFilePersistence } from './persistence'
export type { RitualPersistence } from './persistence'
