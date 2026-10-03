/**
 * dataExport.ts — 本地数据一键导出 / 导入（I6 隐私/自托管叙事）
 *
 * 设计目标（诚实、可离线、不丢数据）：
 * - 导出：把「记忆 SQLite 库」整体打包成一个 .zip，放到用户选择的目录。
 *   zip 内同时给机器可读的 JSON（每表一份）和人可读的 memory.md，
 *   让用户真的能「带走自己的全部记忆」。
 * - 导入：读回 .zip，按主键去重合并——只插入库里还没有的行，绝不覆盖/删除现有数据。
 *
 * 边界（不夸大）：
 * - 这里只打包「记忆/人格/对话摘要」这类 Lumina 自有数据。
 *   API Key、供应商配置等由 settings 模块另行管理，不在此导出（避免误带密钥）。
 * - 文案上不承诺「完全离线」：模型推理按用户配置走（联网或本地模型），
 *   本模块只负责「记忆与人格文件只在本机、可导出、可再导入」。
 *
 * 主进程内使用；经 IPC 由渲染层调用（集成方在 main.ts/preload 接线）。
 */
import * as fs from 'fs'
import * as path from 'path'
import AdmZip from 'adm-zip'
import { app } from 'electron'
import { getMemoryStore } from '../memory/memoryStore'
import { appDataDir } from '../paths'

export interface DataExportResult {
  ok: boolean
  zipPath?: string
  bytes?: number
  tables?: string[]
  rowCounts?: Record<string, number>
  error?: string
}

export interface DataImportResult {
  ok: boolean
  imported?: Record<string, number>
  skipped?: Record<string, number>
  error?: string
}

/** 不导出的系统表 / 过大或纯瞬态的表（按需扩展） */
const SKIP_TABLES = new Set(['sqlite_sequence', 'sqlite_stat1', 'sqlite_stat4'])

function timestampName(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 列出库中所有用户表 */
function listUserTables(db: any): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as Array<{ name: string }>
  return rows.map(r => r.name).filter(n => !SKIP_TABLES.has(n))
}

/** 把整库导出为 { 表名: 行数组 }（JSON 友好） */
function dumpAllTables(db: any): { data: Record<string, any[]>; counts: Record<string, number> } {
  const data: Record<string, any[]> = {}
  const counts: Record<string, number> = {}
  for (const t of listUserTables(db)) {
    try {
      const rows = db.prepare(`SELECT * FROM "${t}"`).all() as any[]
      data[t] = rows
      counts[t] = rows.length
    } catch {
      /* 单表读失败不阻断整体导出 */
    }
  }
  return { data, counts }
}

/** 人可读记忆摘要（复用 MemoryStore 既有结构化导出） */
function humanReadableMemory(): string {
  try {
    const store = getMemoryStore()
    const mem: any = (store as any).getStructuredMemory ? store.getStructuredMemory() : null
    if (!mem) {return '# Lumina Memory\n(结构化记忆不可用，详见 data/*.json)\n'}
    const lines: string[] = ['# Lumina 记忆导出', '', `导出时间: ${new Date().toISOString()}`, '']
    const u = mem.user || {}
    lines.push('## 用户画像')
    lines.push(`- 称呼: ${u.name || '（未设置）'}`)
    if (Array.isArray(u.preferences) && u.preferences.length) {lines.push(`- 偏好: ${u.preferences.join('、')}`)}
    if (Array.isArray(u.habits) && u.habits.length) {lines.push(`- 习惯: ${u.habits.join('、')}`)}
    lines.push('')
    if (Array.isArray(mem.facts) && mem.facts.length) {
      lines.push('## 事实记忆')
      for (const f of mem.facts) {lines.push(`- [${f.category}] ${f.content}`)}
      lines.push('')
    }
    if (Array.isArray(mem.reflections) && mem.reflections.length) {
      lines.push('## 反思记忆')
      for (const r of mem.reflections) {lines.push(`- ${r.topic}: ${r.insight}`)}
      lines.push('')
    }
    return lines.join('\n')
  } catch {
    return '# Lumina Memory\n(生成人可读摘要失败，详见 data/*.json)\n'
  }
}

/**
 * 导出到指定文件路径（调用方负责用 dialog 让用户选保存位置）。
 * @param zipPath 完整 .zip 目标路径
 */
export function exportDataToZip(zipPath: string): DataExportResult {
  try {
    const store = getMemoryStore()
    const db = (store as any).getDb()
    // WAL 落盘，避免导出到未 checkpoint 的 -wal
    try { db.pragma('wal_checkpoint(TRUNCATE)') } catch { /* 非 WAL 忽略 */ }

    const { data, counts } = dumpAllTables(db)
    const zip = new AdmZip()

    const manifest = {
      app: 'Lumina Life',
      format: 'lumina-memory-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      tables: Object.keys(counts),
      rowCounts: counts,
      note: '导入时按主键去重合并，不覆盖现有数据；模型推理按你本机配置走，本包不含 API Key。',
    }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'))
    zip.addFile('memory.md', Buffer.from(humanReadableMemory(), 'utf-8'))
    for (const [t, rows] of Object.entries(data)) {
      zip.addFile(`data/${t}.json`, Buffer.from(JSON.stringify(rows, null, 2), 'utf-8'))
    }

    zip.writeZip(zipPath)
    const bytes = fs.statSync(zipPath).size
    return { ok: true, zipPath, bytes, tables: Object.keys(counts), rowCounts: counts }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 弹出式默认导出文件名 */
export function defaultExportFileName(): string {
  return `lumina-memory-${timestampName()}.zip`
}

/**
 * 从 .zip 导入（合并，不覆盖）。
 * 策略：逐表读取 data/<table>.json，逐行尝试 INSERT；
 * 主键冲突/唯一约束失败即跳过（视为已存在）。
 */
export function importDataFromZip(zipPath: string): DataImportResult {
  try {
    if (!fs.existsSync(zipPath)) {return { ok: false, error: '文件不存在' }}
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries()
    const dataEntries = entries.filter(e => e.entryName.startsWith('data/') && e.entryName.endsWith('.json'))

    const imported: Record<string, number> = {}
    const skipped: Record<string, number> = {}
    const store = getMemoryStore()
    const db = (store as any).getDb()
    const existingTables = new Set(listUserTables(db))

    for (const entry of dataEntries) {
      const table = path.basename(entry.entryName, '.json')
      if (!existingTables.has(table)) { skipped[table] = -1 /* 表不存在 */; continue }
      let rows: any[] = []
      try { rows = JSON.parse(zip.readAsText(entry)) } catch { continue }
      if (!Array.isArray(rows) || rows.length === 0) { continue }

      const cols = Object.keys(rows[0])
      // 只插入「库中确实存在的列」，避免 schema 演进后报未知列
      const tableInfo = (db.prepare(`PRAGMA table_info("${table}")`).all() as any[])
      const knownCols = new Set(tableInfo.map((c: any) => c.name))
      const useCols = cols.filter(c => knownCols.has(c) && c !== 'id')
      if (useCols.length === 0) { continue }

      const colList = useCols.map(c => `"${c}"`).join(',')
      const placeholders = useCols.map(() => '?').join(',')
      const insert = db.prepare(`INSERT OR IGNORE INTO "${table}" (${colList}) VALUES (${placeholders})`)
      let ins = 0, skip = 0
      const txn = db.transaction(() => {
        for (const row of rows) {
          try {
            const res = insert.run(...useCols.map(c => row[c] === undefined ? null : row[c]))
            if (res.changes > 0) {ins++}
            else {skip++}
          } catch { skip++ }
        }
      })
      txn()
      imported[table] = ins
      skipped[table] = skip
    }
    return { ok: true, imported, skipped }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 返回给 onboarding / 设置页展示的本机数据位置（纯信息，不泄密） */
export function getDataLocations(): { userData: string; memoryDb: string; flagsFile: string } {
  let userData = ''
  try { userData = app.getPath('userData') } catch { userData = appDataDir() }
  return {
    userData,
    memoryDb: path.join(userData, 'lumina-memory.db'),
    flagsFile: path.join(userData, 'feature-flags.json'),
  }
}
