// ============================================================
// moodstats/index.ts — 对外统一出口
// ============================================================

export type {
  MoodSnapshot, SnapshotKind, GroupTag, EmotionReader, GateStateReader, GroupReader,
} from './types'

export type {
  SnapshotStore,
} from './snapshotStore'
export {
  createSnapshotStore, wrapToolExecutor, wrapAsyncCall,
  MemorySnapshotStore, SqliteSnapshotStore,
} from './snapshotStore'

export {
  AbGroup, createAbGroup, jsonFilePersistence, fnv1aHash,
} from './abGroup'
export type { AbGroupState, AbGroupPersistence, ExpGroup } from './abGroup'

export {
  MIN_SAMPLE, MOOD_BUCKETS, ENERGY_BUCKETS, UNKNOWN_BUCKET,
  bucketizeMood, bucketizeEnergy, aggregateBuckets, trendByDay, compareGroups,
  buildReport, honestyNote,
} from './stats'
export type { BucketRow, TrendPoint, GroupComparison, StatsReport } from './stats'

export {
  snapshotsToCsv, buildExportJson, escapeCsvCell, UTF8_BOM, SNAPSHOT_CSV_HEADER,
} from './exporter'
export type { ExportBundle } from './exporter'

export { registerMoodStats, __resetMoodStats, __getMoodStatsHandle } from './register'
export type { MoodStatsHandle, RegisterMoodStatsOptions, WrapTarget } from './register'

export { registerMoodStatsIpc } from './ipc'
