// ============================================================
// userDataMigration.ts — 旧目录数据迁移（v3.34 新增）
//
// 【背景】
// 此前 main.ts 从不调用 app.setName()，于是 userData 目录取决于运行形态：
//   · dev 模式 → %APPDATA%/Electron
//   · 打包版   → %APPDATA%/lumina-life
// 同一份设置被写进两个目录，且内容会漂移。main.ts 顶部现在统一了
// app.setName('Lumina Life')，新数据一律落在同一处 —— 但**已经用 dev 跑过、
// 或跑过旧版安装包的用户，数据还留在旧目录**。
//
// ��次启动做一次性搬运，规则保守到不会丢东西：
//   · 目标文件**不存在**才搬（绝不覆盖用户后来的修改）
//   · 逐个文件处理，一个失败不影响其余
//   · 搬完在旧目录留一个 .migrated 标记，避免重复搬
//   · 全程 try/catch —— 迁移失败绝不能阻止应用启动
// ============================================================

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LEGACY_DIR_NAMES } from './core/userDataPath'

/** 旧目录名（**按优先级排序**：靠前的先搬，先搬者赢）。
 *  · lumina-life —— 打包版/旧版跑出来的目录（通常含用户真正填过的 API Key）
 *  · Electron    —— dev 模式默认目录（key 常为空）
 *  两者都存在时，先搬 lumina-life，Electron 只用来补缺口，避免用空 key 覆盖有效 key。
 *  ⚠️ 口径与 core/userDataPath.ts 的 LEGACY_DIR_NAMES 共用同一份，避免两处漂移。 */
// （LEGACY_DIR_NAMES 见顶部 import）

/** 只搬这些 —— 避免把 Electron 自己的缓存/代码缓存也拖过来 */
const MIGRATE_FILES = [
  'lumina-providers.json',
  'agent-llm-configs.json',
  'lumina-gamification.json',
  'lumina-quests.json',
  'lumina-relationships.json',
  'feature-flags.json',
  'lumina-config.json',
  'lumina-dream-diary.json',
]

/** 这些是子目录，整个搬 */
const MIGRATE_DIRS = ['agents', 'memory', 'dialog', 'chats', 'jobs']

const MARKER = '.lumina-migrated'

export interface MigrationResult {
  ran: boolean
  copiedFiles: string[]
  copiedDirs: string[]
  skipped: number
  reason?: string
}

function safeCopyDir(src: string, dst: string): number {
  let n = 0
  if (!fs.existsSync(dst)) {
    fs.cpSync(src, dst, { recursive: true })
    return 1
  }
  // 目标已存在 → 只补目标没有的文件，绝不覆盖
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      n += safeCopyDir(s, d)
    } else if (!fs.existsSync(d)) {
      fs.copyFileSync(s, d)
      n++
    }
  }
  return n
}

/**
 * 把旧目录里的 Lumina 数据并入当前 userData。
 * 必须在 app.setName() / setPath() 之后、任何模块读取 userData 之前调用。
 *
 * @param currentUserData 当前规范 userData 目录
 * @param appDataRoot     可选：Roaming 根目录（便于单测注入）
 */
export function migrateLegacyUserData(currentUserData: string, appDataRoot?: string): MigrationResult {
  const res: MigrationResult = { ran: false, copiedFiles: [], copiedDirs: [], skipped: 0 }
  try {
    const appData = appDataRoot || path.join(os.homedir(), 'AppData', 'Roaming')
    const legacyDirs = LEGACY_DIR_NAMES
      .map(n => path.join(appData, n))
      .filter(d => path.resolve(d) !== path.resolve(currentUserData))
      .filter(d => fs.existsSync(d))

    if (!legacyDirs.length) return res

    fs.mkdirSync(currentUserData, { recursive: true })

    for (const legacy of legacyDirs) {
      // ⚠️ 不再用 `.lumina-migrated` 标记跳过整个目录（2026-10-10 修）：
      //   旧标记会让某个旧目录被**永久跳过**，一旦它里面有当前目录缺失的文件
      //   （例如只有 Electron 目录里配过 LM Studio），就再也搬不过来。
      //   搬运本身是幂等的（目标存在则跳过），所以每次启动重新补缺口是安全的、廉价的。
      for (const f of MIGRATE_FILES) {
        const s = path.join(legacy, f)
        if (!fs.existsSync(s)) continue
        const d = path.join(currentUserData, f)
        if (fs.existsSync(d)) { res.skipped++; continue }
        try { fs.copyFileSync(s, d); res.copiedFiles.push(f) } catch { res.skipped++ }
      }

      for (const dir of MIGRATE_DIRS) {
        const s = path.join(legacy, dir)
        if (!fs.existsSync(s)) continue
        try {
          const n = safeCopyDir(s, path.join(currentUserData, dir))
          if (n > 0) res.copiedDirs.push(dir)
        } catch { res.skipped++ }
      }

      try { fs.writeFileSync(path.join(legacy, MARKER), new Date().toISOString(), 'utf8') } catch { /* 标记失败无所谓，下次再搬一遍也是幂等的 */ }
    }

    // 只有真的搬了东西才置 ran（否则每次启动都会打一行无意义的日志）
    if (res.copiedFiles.length > 0 || res.copiedDirs.length > 0) {
      res.ran = true
      console.log(
        `[Migration] ✅ 已从旧目录并入用户数据: ` +
        `文件 ${res.copiedFiles.length} 个、目录 ${res.copiedDirs.length} 个` +
        (res.skipped ? `（跳过 ${res.skipped} 个，目标已存在未覆盖）` : ''),
      )
    }
  } catch (e: any) {
    // 迁移失败绝不能阻止启动
    res.reason = e?.message || String(e)
    console.warn('[Migration] 旧数据迁移跳过（不影响启动）:', res.reason)
  }
  return res
}
