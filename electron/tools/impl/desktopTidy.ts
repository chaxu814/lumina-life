// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// impl/desktopTidy.ts — 桌面整理工具 (三段式: 扫描 → 方案 → 执行)
//
// 三个工具，职责严格分离：
//   desktop_tidy_scan  — 只读：分类统计
//   desktop_tidy_plan  — 只读：生成整理方案（设计上永远不移动任何东西）
//   desktop_tidy       — 写操作：真正执行移动，必须显式 execute=true
//
// 🛡️ 安全不变量（改这个文件前先读这一段，任何一条被破坏都等于这个功能是危险的）
//
//   1. 永不删除。
//      本文件只调用 fs.promises.rename / fs.promises.mkdir。
//      不存在 unlink / rm / rmSync / rmdir / copy+delete 任何一条删除路径。
//      「整理」在这里的语义只有「换位置」。
//
//   2. 一切路径都被关在桌面目录内。
//      任何来自调用方的路径参数（desktopPath）都先 path.resolve 归一化
//      （resolve 会吃掉 `..`、`.`、重复分隔符），再校验
//      `resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep)`。
//      必须先 resolve 再判前缀 —— 先判前缀的话 `C:\Users\x\Desktop\..\..\Windows`
//      这种字符串会骗过 startsWith。
//      必须 toLowerCase 再比 —— Windows 文件系统大小写不敏感，
//      `c:\users\...` 指向同一个目录，不折叠大小写等于没校验。
//
//   3. 只处理文件，不处理文件夹。
//      桌面上用户的文件夹结构一律原地不动，目录条目直接跳过并计数。
//      符号链接（isSymbolicLink）同样跳过：它可能指向桌面外的任意位置。
//
//   4. 不覆盖。
//      目标目录已有同名文件时自动改名加序号（`报告 (1).pdf`），
//      且 rename 之前再做一次存在性复查，杜绝同名覆盖。
//
//   5. 默认只读。
//      desktop_tidy 不传 execute:true 时只回放方案，一个字节都不写。
//      desktop_tidy_plan 在设计上恒为只读，dryRun:false 也会被拒绝。
//
//   6. 单次最多处理 200 个文件，超出截断并在返回里说明截断了多少。
//
//   7. 单个文件失败不影响整批：权限错误（EACCES/EPERM/EROFS）跳过并记录。
//
// ⚠️ 与既有 desktop_scan（impl/desktopScan.ts，工具名 desktop_scan）不冲突：
//    本文件注册的工具名是 desktop_tidy_scan / desktop_tidy_plan / desktop_tidy。
//    registry.registerTool 用 Map 存名字，重名会静默覆盖掉对方的实现，
//    所以这里刻意用不同前缀命名。
//
// 📌 toolsets 为什么带 'files_core'：
//    registry 的 MODE_TOOLSETS（chat/agent/developer）是**静态表独占**，
//    工具自己在 toolsets 里写 'agent' 不会被合并进任何能力档 —— 结果就是
//    「注册了但模型永远看不到」的孤儿工具，tests/delegationSafety.test.ts 有守卫会红。
//    正确修法是额外挂一个**能力层**子集；桌面整理归类为文件操作，故选 files_core。
// ============================================================

import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import type { ToolDef, ToolResult } from '../types'

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** 单次处理上限 —— 超过就截断，必须在返回里说明（安全不变量 6） */
const MAX_FILES_PER_RUN = 200

const DAY_MS = 24 * 60 * 60 * 1000

/** 基础分类（同时也是 `categories` 参数的合法取值） */
const CATEGORY_KEYS = ['图片', '视频', '音频', '文档', '压缩包', '安装包', '代码', '其他'] as const

type CategoryKey = typeof CATEGORY_KEYS[number]

/** 系统自带的文件，不属于用户内容，不整理 */
const IGNORED_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store'])

/** 扩展名 → 基础分类 */
const EXTENSION_CATEGORY: Record<string, CategoryKey> = (() => {
  const table: Record<string, CategoryKey> = {}
  const add = (category: CategoryKey, exts: string[]): void => {
    for (const ext of exts) { table[ext] = category }
  }
  add('图片', ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.heic', '.heif', '.tiff', '.tif', '.ico', '.raw', '.psd'])
  add('视频', ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts'])
  add('音频', ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.ape', '.opus'])
  add('文档', ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.rtf', '.csv', '.odt', '.ods', '.odp', '.epub'])
  add('压缩包', ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.iso', '.cab'])
  add('安装包', ['.exe', '.msi', '.msix', '.appx', '.dmg', '.pkg', '.deb', '.rpm', '.apk'])
  add('代码', ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.html', '.htm', '.css', '.scss', '.json', '.xml', '.yml', '.yaml', '.toml', '.sql', '.sh', '.bat', '.cmd', '.ps1', '.vue'])
  return table
})()

/**
 * 年龄维度：同一种扩展名，文件越老越可能是「用完就扔」的东西，
 * 单独放到「旧 xxx」子目录，让整理结果对用户更有意义。
 * 这就是「扩展名 + 文件年龄」双维度里的第二维。
 */
interface AgeRule {
  base: CategoryKey
  /** 修改时间超过这个天数就命中 */
  olderThanDays: number
  folder: string
}

const AGE_RULES: AgeRule[] = [
  { base: '安装包', olderThanDays: 30, folder: '旧安装包' },
  { base: '压缩包', olderThanDays: 180, folder: '旧压缩包' },
  { base: '其他', olderThanDays: 90, folder: '旧文件' },
]

/** 基础分类 → 默认目标文件夹（没有命中年龄规则时用） */
const BASE_FOLDER: Record<CategoryKey, string> = {
  图片: '图片',
  视频: '视频',
  音频: '音频',
  文档: '文档',
  压缩包: '压缩包',
  安装包: '安装包',
  代码: '代码',
  其他: '其他',
}

// ═══════════════════════════════════════════════════════════
// 路径安全（安全不变量 2 / 3）
// ═══════════════════════════════════════════════════════════

/** 去掉结尾多余的分隔符；盘符根（C:\）保持原样 */
function stripTrailingSep(target: string): string {
  return target.length > 3 ? target.replace(/[\\/]+$/, '') : target
}

/**
 * 判断 target 是否位于 root 之内（含 root 自身）。
 *
 * 顺序是刻意的：先 path.resolve 归一化（`..` 在这一步被消解），
 * 再 toLowerCase 折叠（Windows 大小写不敏感），最后比前缀。
 * 三步任何一步提前都会漏 —— 详见文件头的安全不变量 2。
 */
function isInsideRoot(root: string, target: string): boolean {
  const rootKey = stripTrailingSep(path.resolve(root)).toLowerCase()
  const targetKey = stripTrailingSep(path.resolve(target)).toLowerCase()
  if (targetKey === rootKey) {return true}
  return targetKey.startsWith(rootKey + path.sep.toLowerCase())
}

/** 桌面根目录：优先 Electron 的 app.getPath('desktop')，取不到时回退到 ~/Desktop */
function getDesktopRoot(): string {
  try {
    const resolved = app?.getPath('desktop')
    if (typeof resolved === 'string' && resolved.length > 0) {
      return path.resolve(resolved)
    }
  } catch {
    // 非 Electron 环境（纯 node 测试 / CLI）—— 走回退分支
  }
  return path.resolve(os.homedir(), 'Desktop')
}

// ═══════════════════════════════════════════════════════════
// 分类
// ═══════════════════════════════════════════════════════════

function classifyByExtension(fileName: string): CategoryKey {
  return EXTENSION_CATEGORY[path.extname(fileName).toLowerCase()] ?? '其他'
}

/** 扩展名定大类 + 年龄定细分目录 */
function resolveTargetFolder(base: CategoryKey, ageDays: number): string {
  for (const rule of AGE_RULES) {
    if (rule.base === base && ageDays > rule.olderThanDays) {return rule.folder}
  }
  return BASE_FOLDER[base]
}

// ═══════════════════════════════════════════════════════════
// 扫描
// ═══════════════════════════════════════════════════════════

interface DesktopEntry {
  name: string
  /** 绝对源路径（已校验在桌面内） */
  from: string
  /** 目标目录绝对路径（已校验在桌面内） */
  targetDir: string
  /** 最终文件名（可能已加序号） */
  finalName: string
  /** 相对桌面根的目标，如 `文档/报告.pdf` */
  targetRelative: string
  base: CategoryKey
  folder: string
  sizeBytes: number
  ageDays: number
}

interface SkipRecord {
  name: string
  reason: string
}

interface ScanResult {
  desktopRoot: string
  entries: DesktopEntry[]
  /** 命中分类过滤后的总数（截断前） */
  matchedCount: number
  /** 扫描到的文件总数（截断前） */
  totalFiles: number
  /** 顶层文件夹数量 —— 一律不动 */
  dirCount: number
  hiddenCount: number
  truncated: boolean
  skipped: SkipRecord[]
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.stat(target)
    return true
  } catch {
    return false
  }
}

function isHiddenName(name: string): boolean {
  // Unix 风格点文件 + Office 临时文件（~$xxx.docx）
  return name.startsWith('.') || name.startsWith('~$')
}

/**
 * 生成不冲突的文件名：已存在就在扩展名前加 ` (n)`。
 * taken 是本批次内已占用的文件名（小写），避免同一批里两个文件抢同一个名字。
 */
/** 读取目录内已有文件名（小写集合）；目录不存在返回空集。
 *  用于把"逐个 pathExists"降为"一次 readdir + 集合查找"，避免 200 次串行 fs 调用。 */
async function listDirNames(dir: string): Promise<Set<string>> {
  try {
    const names = await fs.promises.readdir(dir)
    return new Set(names.map(n => n.toLowerCase()))
  } catch { return new Set() }
}

async function resolveUniqueName(
  dir: string,
  fileName: string,
  taken: Set<string>,
  /** 目录内已有名字的预加载集合；提供时不再逐个 pathExists（性能） */
  existing?: Set<string>,
): Promise<string> {
  const parsed = path.parse(fileName)
  let candidate = fileName
  let n = 1
  const conflicts = async (name: string): Promise<boolean> => {
    if (taken.has(name.toLowerCase())) {return true}
    if (existing) {return existing.has(name.toLowerCase())}
    return await pathExists(path.join(dir, name))
  }
  while (await conflicts(candidate)) {
    candidate = `${parsed.name} (${n})${parsed.ext}`
    n += 1
    if (n > 999) {break}   // 兜底：999 次还撞上就放弃改名，由调用方再复查一次
  }
  return candidate
}

async function scanDesktop(
  desktopRoot: string,
  includeHidden: boolean,
  categories: CategoryKey[] | null,
): Promise<ScanResult> {
  const dirents = await fs.promises.readdir(desktopRoot, { withFileTypes: true })
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const skipped: SkipRecord[] = []
  let totalFiles = 0
  let dirCount = 0
  let hiddenCount = 0
  let matchedCount = 0

  interface Candidate {
    name: string
    fullPath: string
    sizeBytes: number
    ageDays: number
    base: CategoryKey
    folder: string
  }
  const candidates: Candidate[] = []

  for (const dirent of dirents) {
    // 安全不变量 3：文件夹一律不碰
    if (dirent.isDirectory()) {dirCount += 1; continue}
    // 符号链接可能指向桌面外，直接跳过
    if (dirent.isSymbolicLink()) {skipped.push({ name: dirent.name, reason: '符号链接，已跳过' }); continue}
    if (!dirent.isFile()) {continue}
    if (IGNORED_NAMES.has(dirent.name.toLowerCase())) {continue}

    if (isHiddenName(dirent.name)) {
      hiddenCount += 1
      if (!includeHidden) {continue}
    }

    totalFiles += 1

    // 安全不变量 2：源路径必须落在桌面内（readdir 结果本应天然满足，仍做一次纵深防御）
    const fullPath = path.join(desktopRoot, dirent.name)
    if (!isInsideRoot(desktopRoot, fullPath)) {
      skipped.push({ name: dirent.name, reason: '路径越出桌面目录，已拒绝' })
      continue
    }

    let sizeBytes = 0
    let ageDays = 0
    try {
      const stat = await fs.promises.stat(fullPath)
      sizeBytes = stat.size
      ageDays = Math.max(0, Math.floor((Date.now() - stat.mtimeMs) / DAY_MS))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      skipped.push({ name: dirent.name, reason: `无法读取文件信息（${code}）` })
      continue
    }

    const base = classifyByExtension(dirent.name)
    if (categories && !categories.includes(base)) {continue}
    matchedCount += 1

    candidates.push({
      name: dirent.name,
      fullPath,
      sizeBytes,
      ageDays,
      base,
      folder: resolveTargetFolder(base, ageDays),
    })
  }

  // 安全不变量 6：单次上限
  const truncated = candidates.length > MAX_FILES_PER_RUN
  const limited = truncated ? candidates.slice(0, MAX_FILES_PER_RUN) : candidates

  // 目标目录 + 去重命名
  const entries: DesktopEntry[] = []
  const takenByDir = new Map<string, Set<string>>()
  // 每个目标目录只 readdir 一次，避免 200 次串行 fs 调用（负载下会拖慢到超时）
  const dirListingCache = new Map<string, Set<string>>()
  for (const item of limited) {
    const targetDir = path.join(desktopRoot, item.folder)
    // 安全不变量 2：目标路径同样必须落在桌面内（folder 来自白名单，这里是纵深防御）
    if (!isInsideRoot(desktopRoot, targetDir)) {
      skipped.push({ name: item.name, reason: '目标目录越出桌面，已拒绝' })
      continue
    }
    const taken = takenByDir.get(targetDir) ?? new Set<string>()
    let existing = dirListingCache.get(targetDir)
    if (!existing) {
      existing = await listDirNames(targetDir)
      dirListingCache.set(targetDir, existing)
    }
    const finalName = await resolveUniqueName(targetDir, item.name, taken, existing)
    taken.add(finalName.toLowerCase())
    existing.add(finalName.toLowerCase())
    takenByDir.set(targetDir, taken)

    entries.push({
      name: item.name,
      from: item.fullPath,
      targetDir,
      finalName,
      // 输出用 / 分隔（path.join 在 Windows 上会给 \，对 LLM 不友好）
      targetRelative: `${item.folder}/${finalName}`,
      base: item.base,
      folder: item.folder,
      sizeBytes: item.sizeBytes,
      ageDays: item.ageDays,
    })
  }

  return { desktopRoot, entries, matchedCount, totalFiles, dirCount, hiddenCount, truncated, skipped }
}

// ═══════════════════════════════════════════════════════════
// 公共前置：解析参数 + 校验桌面目录
// ═══════════════════════════════════════════════════════════

interface PreparedScan {
  ok: true
  result: ScanResult
  categories: CategoryKey[] | null
}
interface PreparedError {
  ok: false
  error: string
}

function parseCategories(raw: unknown): CategoryKey[] | { error: string } | null {
  if (raw === undefined || raw === null) {return null}
  const list = Array.isArray(raw) ? raw : [raw]
  if (list.length === 0) {return null}
  const picked: CategoryKey[] = []
  for (const item of list) {
    const name = String(item).trim()
    const matched = CATEGORY_KEYS.find(key => key === name)
    if (!matched) {
      // 白名单校验：categories 直接影响目标文件夹名，绝不允许外部拼路径
      return { error: `未知分类 "${name}"，合法取值为: ${CATEGORY_KEYS.join(' / ')}` }
    }
    if (!picked.includes(matched)) {picked.push(matched)}
  }
  return picked
}

/**
 * 解析并校验调用参数，然后扫桌面。
 * 桌面外的路径、穿越路径在这里就返回 ok:false，不会进入任何写操作。
 */
async function prepareScan(args: Record<string, unknown>): Promise<PreparedScan | PreparedError> {
  const parsedCategories = parseCategories(args.categories)
  if (parsedCategories !== null && !Array.isArray(parsedCategories)) {
    return { ok: false, error: parsedCategories.error }
  }
  const categories = parsedCategories as CategoryKey[] | null

  const desktopRoot = getDesktopRoot()

  // 可选的扫描子目录。默认就是桌面根。
  const scanRoot = typeof args.desktopPath === 'string' && args.desktopPath.length > 0
    ? path.resolve(args.desktopPath)
    : desktopRoot

  if (!isInsideRoot(desktopRoot, scanRoot)) {
    return {
      ok: false,
      error: `路径越界，已拒绝: ${scanRoot} 不在桌面目录 ${desktopRoot} 内（不允许 .. 穿越或指向桌面外）`,
    }
  }

  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(scanRoot)
  } catch {
    return { ok: false, error: `桌面目录不可访问: ${scanRoot}` }
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `桌面路径不是目录: ${scanRoot}` }
  }

  const result = await scanDesktop(scanRoot, args.includeHidden === true, categories)
  return { ok: true, result, categories }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {return `${bytes}B`}
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(0)}KB`}
  if (bytes < 1024 * 1024 * 1024) {return `${(bytes / 1024 / 1024).toFixed(1)}MB`}
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

/** 统一的 LLM 友好清单格式：`- 报告.pdf → 文档/报告.pdf` */
function renderEntryLines(entries: DesktopEntry[]): string[] {
  return entries.map(entry => `- ${entry.name} → ${entry.targetRelative}`)
}

function renderSkipLines(skipped: SkipRecord[]): string[] {
  return skipped.map(item => `- ${item.name}: ${item.reason}`)
}

function renderTruncationNote(result: ScanResult): string[] {
  if (!result.truncated) {return []}
  const remain = result.matchedCount - result.entries.length
  return [`⚠️ 命中 ${result.matchedCount} 个文件，本次只处理前 ${MAX_FILES_PER_RUN} 个，还有 ${remain} 个未处理`]
}

function renderFolderCountNote(entries: DesktopEntry[]): string {
  const folders = new Set(entries.map(entry => entry.folder))
  return `${entries.length} 个文件 → ${folders.size} 个子文件夹`
}

// ═══════════════════════════════════════════════════════════
// 工具 1: desktop_tidy_scan（只读）
// ═══════════════════════════════════════════════════════════

export const desktopScanDef: ToolDef = {
  name: 'desktop_tidy_scan',
  description:
    '扫描桌面并按「扩展名 + 文件年龄」给出分类统计（图片/视频/音频/文档/压缩包/安装包/代码/其他），\n' +
    '并预览每个文件会被移到哪个子文件夹。\n' +
    '纯只读 —— 不创建文件夹，不移动文件，不删除任何东西。\n' +
    '当用户说「整理一下桌面」「桌面太乱了」时先用它看现状。',
  params: {
    includeHidden: {
      type: 'boolean',
      description: '是否统计隐藏文件（点开头、~$ 临时文件）。默认 false',
      required: false,
    },
    desktopPath: {
      type: 'string',
      description:
        '可选：只扫描桌面的某个子目录（绝对路径）。必须位于桌面目录内，' +
        '越界路径会被直接拒绝。默认扫描整个桌面',
      required: false,
    },
  },
  toolsets: ['productivity'],
}

export async function desktopScan(args: Record<string, unknown>): Promise<ToolResult> {
  const start = Date.now()
  try {
    const prepared = await prepareScan(args)
    if (!prepared.ok) {return { callId: '', ok: false, content: '', error: prepared.error }}

    const { result } = prepared
    if (result.entries.length === 0) {
      return {
        callId: '',
        ok: true,
        content:
          `🗂️ 桌面很干净，没有需要整理的文件。\n` +
          `扫描目录: ${result.desktopRoot}\n` +
          `文件夹 ${result.dirCount} 个（不参与整理）`,
        durationMs: Date.now() - start,
      }
    }

    // 按基础分类统计
    const stats = new Map<CategoryKey, { count: number; bytes: number }>()
    for (const entry of result.entries) {
      const bucket = stats.get(entry.base) ?? { count: 0, bytes: 0 }
      bucket.count += 1
      bucket.bytes += entry.sizeBytes
      stats.set(entry.base, bucket)
    }

    const lines: string[] = [
      '🗂️ 桌面整理 — 扫描结果（只读，未改动任何文件）',
      '',
      `扫描目录: ${result.desktopRoot}`,
      `可整理文件: ${result.entries.length} 个`,
      `顶层文件夹: ${result.dirCount} 个（保持原位，不动）`,
      `隐藏文件: ${result.hiddenCount} 个${args.includeHidden === true ? '（已计入）' : '（未计入）'}`,
      '',
      '📊 按分类统计:',
    ]
    for (const key of CATEGORY_KEYS) {
      const bucket = stats.get(key)
      if (bucket) {lines.push(`- ${key}: ${bucket.count} 个 (${formatSize(bucket.bytes)})`)}
    }
    lines.push('')
    lines.push(`📁 目标文件夹分布: ${[...new Set(result.entries.map(e => e.folder))].join('、')}`)
    lines.push('')
    lines.push('📋 整理清单预览:')
    lines.push(...renderEntryLines(result.entries))
    lines.push(...renderTruncationNote(result))
    if (result.skipped.length > 0) {
      lines.push('')
      lines.push(`⚠️ 扫描阶段跳过 ${result.skipped.length} 项:`)
      lines.push(...renderSkipLines(result.skipped))
    }
    lines.push('')
    lines.push('💡 下一步: desktop_tidy_plan 看完整方案，desktop_tidy(execute=true) 才真正移动文件。')

    return { callId: '', ok: true, content: lines.join('\n'), durationMs: Date.now() - start }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { callId: '', ok: false, content: '', error: `桌面扫描失败: ${message}`, durationMs: Date.now() - start }
  }
}

// ═══════════════════════════════════════════════════════════
// 工具 2: desktop_tidy_plan（只读，设计上不可写）
// ═══════════════════════════════════════════════════════════

export const desktopPlanDef: ToolDef = {
  name: 'desktop_tidy_plan',
  description:
    '生成桌面整理方案：每个文件会从哪移到哪个分类子文件夹，**绝不移动任何文件**。\n' +
    '本工具在设计上恒为只读（dryRun 永远是 true，即使传 false 也不会执行移动）。\n' +
    '用户确认方案后，再调 desktop_tidy(execute=true) 执行。',
  params: {
    dryRun: {
      type: 'boolean',
      description: '恒为 true 的只读标记。本工具不提供任何写入能力，传什么都不影响 —— 不会移动文件',
      required: false,
    },
    categories: {
      type: 'string',
      description:
        '可选：只整理指定分类，逗号分隔。合法值: 图片 / 视频 / 音频 / 文档 / 压缩包 / 安装包 / 代码 / 其他。' +
        '不传表示全部分类',
      required: false,
    },
    includeHidden: {
      type: 'boolean',
      description: '是否包含隐藏文件。默认 false',
      required: false,
    },
    desktopPath: {
      type: 'string',
      description: '可选：只针对桌面某个子目录。必须位于桌面目录内，越界路径会被拒绝',
      required: false,
    },
  },
  toolsets: ['productivity'],
}

export async function desktopPlan(args: Record<string, unknown>): Promise<ToolResult> {
  const start = Date.now()
  try {
    // 未知分类名不静默忽略，直接失败
    if (typeof args.categories === 'string' && args.categories.trim().length > 0) {
      args = { ...args, categories: args.categories.split(/[,，、]\s*/).filter(Boolean) }
    }

    const prepared = await prepareScan(args)
    if (!prepared.ok) {return { callId: '', ok: false, content: '', error: prepared.error }}
    const { result, categories } = prepared

    if (result.entries.length === 0) {
      return {
        callId: '',
        ok: true,
        content:
          `📋 整理方案（只读）— 没有需要整理的文件。\n` +
          `扫描目录: ${result.desktopRoot}`,
        durationMs: Date.now() - start,
      }
    }

    const lines: string[] = [
      '📋 整理方案 —— 🔒 只读预览，本次没有移动任何文件',
      '',
      `扫描目录: ${result.desktopRoot}`,
      categories
        ? `限定分类: ${categories.join('、')}`
        : '限定分类: 全部',
      `顶层文件夹 ${result.dirCount} 个不会被移动`,
      '',
      '计划移动:',
      ...renderEntryLines(result.entries),
      '',
      `合计: ${renderFolderCountNote(result.entries)}`,
    ]
    lines.push(...renderTruncationNote(result))
    if (result.skipped.length > 0) {
      lines.push('')
      lines.push(`⚠️ 跳过 ${result.skipped.length} 项:`)
      lines.push(...renderSkipLines(result.skipped))
    }

    if (args.dryRun === false) {
      lines.push('')
      lines.push('ℹ️ dryRun:false 未生效 —— 本工具在设计上就没有写入能力，不会移动任何文件。')
    }

    lines.push('')
    lines.push('💡 确认方案无误后，调用 desktop_tidy(execute=true) 执行。')

    return { callId: '', ok: true, content: lines.join('\n'), durationMs: Date.now() - start }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { callId: '', ok: false, content: '', error: `生成整理方案失败: ${message}`, durationMs: Date.now() - start }
  }
}

// ═══════════════════════════════════════════════════════════
// 工具 3: desktop_tidy（写操作，必须 execute=true）
// ═══════════════════════════════════════════════════════════

export const desktopTidyDef: ToolDef = {
  name: 'desktop_tidy',
  description:
    '执行桌面整理：把桌面上的文件移动到「图片/视频/音频/文档/压缩包/安装包/代码/其他」子文件夹。\n' +
    '🔒 安全约定：\n' +
    '  · 不传 execute:true（或传 false）时 **只回放整理方案，一个文件都不会动**\n' +
    '  · 永不删除，只做移动（rename）\n' +
    '  · 源和目标都限制在桌面目录内，跨目录/穿越路径一律拒绝\n' +
    '  · 桌面上的文件夹本身不动，只处理文件\n' +
    '  · 目标重名自动改名（报告 (1).pdf），不覆盖\n' +
    '  · 单次最多 200 个文件\n' +
    '建议先调 desktop_tidy_plan 给用户看方案，用户确认后再传 execute=true。',
  params: {
    execute: {
      type: 'boolean',
      description: '必须显式传 true 才会真正移动文件。默认 false = 只回放方案',
      required: false,
    },
    categories: {
      type: 'string',
      description:
        '可选：只整理指定分类，逗号分隔。合法值: 图片 / 视频 / 音频 / 文档 / 压缩包 / 安装包 / 代码 / 其他。' +
        '不传表示全部分类',
      required: false,
    },
    includeHidden: {
      type: 'boolean',
      description: '是否处理隐藏文件。默认 false',
      required: false,
    },
    desktopPath: {
      type: 'string',
      description: '可选：只整理桌面某个子目录。必须位于桌面目录内，越界路径会被拒绝',
      required: false,
    },
  },
  toolsets: ['productivity'],
  // 刻意不标 dangerous: 这里的写入门是 execute:true + 路径白名单双闸门，
  // 再叠一层 SecurityGuard 审批只会把「查看方案」也拖进审批流。
}

export async function desktopTidy(args: Record<string, unknown>): Promise<ToolResult> {
  const start = Date.now()
  try {
    if (typeof args.categories === 'string' && args.categories.trim().length > 0) {
      args = { ...args, categories: args.categories.split(/[,，、]\s*/).filter(Boolean) }
    }

    const prepared = await prepareScan(args)
    if (!prepared.ok) {return { callId: '', ok: false, content: '', error: prepared.error }}
    const { result } = prepared

    // ── 安全不变量 5：默认只读 ──────────────────────────────
    if (args.execute !== true) {
      if (result.entries.length === 0) {
        return {
          callId: '',
          ok: true,
          content: `🧹 整理方案（未执行）— 没有需要整理的文件。\n扫描目录: ${result.desktopRoot}`,
          durationMs: Date.now() - start,
        }
      }
      const lines: string[] = [
        '🧹 整理方案 —— 🔒 未执行（execute 未传 true），文件位置完全没变',
        '',
        `扫描目录: ${result.desktopRoot}`,
        `顶层文件夹 ${result.dirCount} 个保持原位（只整理文件）`,
        '确认后移动的文件:',
        ...renderEntryLines(result.entries),
        '',
        `合计: ${renderFolderCountNote(result.entries)}`,
        ...renderTruncationNote(result),
        '',
        '💡 确认无误后重新调用并传 execute=true 才会真正移动。',
      ]
      return { callId: '', ok: true, content: lines.join('\n'), durationMs: Date.now() - start }
    }

    // ── 真正执行 ─────────────────────────────────────────
    if (result.entries.length === 0) {
      return {
        callId: '',
        ok: true,
        content: `✅ 桌面没有需要整理的文件，未做任何改动。\n扫描目录: ${result.desktopRoot}`,
        durationMs: Date.now() - start,
      }
    }

    const moved: string[] = []
    const failed: SkipRecord[] = [...result.skipped]
    const createdDirs = new Set<string>()
    let dirBlocked = 0

    for (const entry of result.entries) {
      // 安全不变量 2：移动前对源和目标各再校验一次
      if (!isInsideRoot(result.desktopRoot, entry.from) || !isInsideRoot(result.desktopRoot, entry.targetDir)) {
        failed.push({ name: entry.name, reason: '路径越出桌面目录，已拒绝' })
        continue
      }

      // 目标目录：已存在的软链接/联接点会写到桌面外，必须拒绝
      if (!createdDirs.has(entry.targetDir)) {
        try {
          const linkStat = await fs.promises.lstat(entry.targetDir)
          if (linkStat.isSymbolicLink()) {
            dirBlocked += 1
            failed.push({ name: entry.name, reason: `目标目录 ${entry.folder} 是链接，已拒绝写入` })
            continue
          }
          if (!linkStat.isDirectory()) {
            dirBlocked += 1
            failed.push({ name: entry.name, reason: `目标路径 ${entry.folder} 不是目录，已跳过` })
            continue
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code !== 'ENOENT') {
            dirBlocked += 1
            failed.push({ name: entry.name, reason: `目标目录不可访问（${code ?? '未知'}），已跳过` })
            continue
          }
          // 不存在 → 建一个
          try {
            await fs.promises.mkdir(entry.targetDir, { recursive: true })
            createdDirs.add(entry.targetDir)
          } catch (mkdirErr) {
            dirBlocked += 1
            const mkdirCode = (mkdirErr as NodeJS.ErrnoException).code ?? 'UNKNOWN'
            failed.push({ name: entry.name, reason: `无法创建目录 ${entry.folder}（${mkdirCode}）` })
            continue
          }
        }
      }

      // 目标不存在性复查（防 TOCTOU），撞名就再取一个序号名
      let finalPath = path.join(entry.targetDir, entry.finalName)
      if (await pathExists(finalPath)) {
        const renamed = await resolveUniqueName(entry.targetDir, entry.name, new Set<string>())
        finalPath = path.join(entry.targetDir, renamed)
        entry.finalName = renamed
        entry.targetRelative = `${entry.folder}/${renamed}`
      }

      try {
        await fs.promises.rename(entry.from, finalPath)
        moved.push(`- ${entry.name} → ${entry.targetRelative}`)
      } catch (err) {
        // 安全不变量 7：单文件失败只记录，不中断整批
        const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN'
        const reason = (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
          ? `权限不足（${code}）`
          : `移动失败（${code}）`
        failed.push({ name: entry.name, reason })
      }
    }

    const lines: string[] = [
      '✅ 桌面整理完成',
      '',
      `扫描目录: ${result.desktopRoot}`,
      `顶层文件夹 ${result.dirCount} 个保持原位（只整理文件）`,
      `已移动 ${moved.length} 个文件:`,
      ...moved,
      '',
      `合计: ${renderFolderCountNote(result.entries)}`,
    ]
    lines.push(...renderTruncationNote(result))
    if (dirBlocked > 0) {
      lines.push('')
      lines.push(`⚠️ ${dirBlocked} 个文件因目标目录问题被跳过`)
    }
    if (failed.length > 0) {
      lines.push('')
      lines.push(`⚠️ 跳过 ${failed.length} 项（文件仍在桌面原位）:`)
      lines.push(...renderSkipLines(failed))
    }
    lines.push('')
    lines.push('ℹ️ 本工具只做移动，从不删除任何文件。')

    // 一个都没动成 → 诚实报失败，别把空结果说成成功
    if (moved.length === 0) {
      return {
        callId: '',
        ok: false,
        content: lines.join('\n'),
        error: `整理未成功: ${failed.length} 个文件全部被跳过（${failed[0]?.reason ?? '未知原因'}）`,
        durationMs: Date.now() - start,
      }
    }

    return { callId: '', ok: true, content: lines.join('\n'), durationMs: Date.now() - start }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { callId: '', ok: false, content: '', error: `桌面整理失败: ${message}`, durationMs: Date.now() - start }
  }
}
