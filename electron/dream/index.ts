// dream/index.ts — 梦境系统统一导出
export {
  generateDream,
  generateTodayDream,
  getAllDreams,
  getRecentDreams,
  getDreamByDate,
  deleteDream,
  getDreamStats,
} from './dreamEngine'
export type { DreamEntry } from './dreamEngine'
