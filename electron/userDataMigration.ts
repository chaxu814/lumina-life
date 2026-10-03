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

/** dev 模式下 Electron 用的默认目录名 */
const LEGACY_DIR_NAMES = ['Electron']

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
 * 必须在 app.setName() 之后、任何模块读取 userData 之前调用。
 */
export function migrateLegacyUserData(currentUserData: string): MigrationResult {
  const res: MigrationResult = { ran: false, copiedFiles: [], copiedDirs: [], skipped: 0 }
  try {
    const appData = path.join(os.homedir(), 'AppData', 'Roaming')
    const legacyDirs = LEGACY_DIR_NAMES
      .map(n => path.join(appData, n))
      .filter(d => path.resolve(d) !== path.resolve(currentUserData))
      .filter(d => fs.existsSync(d))

    if (!legacyDirs.length) return res

    fs.mkdirSync(currentUserData, { recursive: true })

    for (const legacy of legacyDirs) {
      const marker = path.join(legacy, MARKER)
      if (fs.existsSync(marker)) continue
      res.ran = true

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

      try { fs.writeFileSync(marker, new Date().toISOString(), 'utf8') } catch { /* 标记失败无所谓，下次再搬一遍也是幂等的 */ }
    }

    if (res.ran) {
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
