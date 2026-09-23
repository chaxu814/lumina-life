// ============================================================
// pet/modelImporter.ts — 🐱 Live2D / PNGTuber 形象 UGC 导入器 (v0.2)
//
// 让用户能把自己的 Live2D Cubism 模型（*.model3.json）或 PNGTuber
// 立绘组（idle.png + talking.png…）导入 Lumina，而不是只能用内置 Mao。
// 重点是「安全」：
//   - 校验 model3.json 的最小合法结构（Version / FileReferences.Moc）；
//   - 模型名消毒，禁止路径分隔符与「..」；
//   - 校验所有被引用资源都是安全相对路径，防 zip-slip / 目录穿越；
//   - 文件系统操作通过最小接口注入，纯逻辑可单测；
//   - v0.2：新增 zip 包导入（adm-zip 解压到临时目录后自动找 model3.json）、
//     文件夹自动扫描入口、Cubism 2 旧格式检测、PNGTuber 立绘组导入、
//     更具体的导入报错（缺 moc3 / 缺纹理 / JSON 损坏 / 路径穿越）。
// ============================================================

import AdmZip from 'adm-zip'
import * as fsp from 'node:fs/promises'
import * as fssync from 'node:fs'
import * as fspath from 'node:path'
import * as os from 'node:os'

/**
 * adm-zip 未随包发布类型声明，且与新版 @types/node 的泛型 Buffer 不兼容。
 * 这里只声明我们用到的最小表面（运行时 API 与官方一致）。
 */
interface AdmZipLike {
  getEntries(): { entryName: string }[]
  extractAllTo(targetDir: string, overwrite: boolean): void
}
function openZip(buf: Buffer): AdmZipLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (AdmZip as any)(buf) as AdmZipLike
}

/** 最小文件系统抽象（默认用 node:fs/promises，测试注入内存实现） */
export interface ModelImporterFs {
  readText: (absPath: string) => Promise<string>
  fileExists: (absPath: string) => Promise<boolean>
  ensureDir: (absPath: string) => Promise<void>
  copyFile: (from: string, to: string) => Promise<void>
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export interface PlannedFile {
  /** 源绝对路径 */
  from: string
  /** 相对目标模型目录的路径 */
  rel: string
}

export interface ImportPlan {
  modelName: string
  /** 入口 model3.json 相对目标目录的路径 */
  entryRel: string
  targetDir: string
  files: PlannedFile[]
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** 校验 Live2D Cubism model3.json 的最小结构 */
export function validateModel3(data: unknown): ValidationResult {
  const errors: string[] = []
  if (!isRecord(data)) {return { valid: false, errors: ['模型文件不是合法 JSON 对象'] }}

  const version = data['Version']
  if (typeof version !== 'number' || version < 3 || version > 5) {
    errors.push('Version 必须是 3~5 的数字（Live2D Cubism 3/4/5）')
  }

  const refs = data['FileReferences']
  if (!isRecord(refs)) {
    errors.push('缺少 FileReferences 字段')
    return { valid: false, errors }
  }
  const moc = refs['Moc']
  if (typeof moc !== 'string' || !/\.moc3$/i.test(moc.trim())) {
    if (typeof moc === 'string' && /\.moc$/i.test(moc.trim())) {
      errors.push('FileReferences.Moc 指向 .moc（Cubism 2）：当前仅支持 Cubism 3/4/5 的 .moc3')
    } else {
      errors.push('FileReferences.Moc 必须是指向 .moc3 的字符串')
    }
  }
  if (refs['Textures'] !== undefined) {
    if (!Array.isArray(refs['Textures']) || refs['Textures'].some(t => typeof t !== 'string')) {
      errors.push('FileReferences.Textures 必须是字符串数组（通常是 textures/ 下的 .png 列表）')
    } else if (refs['Textures'].length === 0) {
      errors.push('FileReferences.Textures 为空数组：至少需要 1 张贴图')
    }
  }
  return { valid: errors.length === 0, errors }
}

/**
 * 检测 Live2D Cubism 2 旧格式（.model.json + .moc）。
 * Lumina 运行时只内置 Cubism 4 核，无法加载 .moc，给用户明确提示而不是静默黑屏。
 * 返回 null 表示不是 Cubism 2；否则返回面向用户的错误说明。
 */
export function detectLegacyCubism(entryName: string, data: unknown): string | null {
  const base = String(entryName || '').toLowerCase().replace(/\\/g, '/').split('/').pop() || ''
  if (base.endsWith('.model.json') && !base.endsWith('.model3.json')) {
    return '检测到 Live2D Cubism 2 模型（.model.json），当前仅支持 Cubism 3/4/5（.model3.json + .moc3）'
  }
  if (isRecord(data)) {
    const refs = data['FileReferences']
    const moc = isRecord(refs) ? refs['Moc'] : undefined
    if (typeof moc === 'string' && /\.moc$/i.test(moc.trim()) && !/\.moc3$/i.test(moc.trim())) {
      return '检测到 Live2D Cubism 2 模型（.moc），当前仅支持 Cubism 3/4/5（.model3.json）'
    }
  }
  return null
}

/**
 * 模型名消毒：只保留中英文、数字、下划线、连字符；
 * 去掉任何路径成分，防止目录穿越。
 */
export function sanitizeModelName(raw: unknown, fallback = 'custom-model'): string {
  const s = String(raw ?? '').trim()
  // 先取末段，丢掉任何目录前缀（Windows 与 POSIX 都防）
  const base = s.split(/[\\/]/).pop() || ''
  const cleaned = base
    .replace(/\.model3\.json$/i, '')
    .replace(/[^\p{L}\p{N}_-]/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '')
  return cleaned || fallback
}

/** 安全相对路径：不含 ..、不以 / 或盘符开头、不含反斜杠逃逸 */
export function isSafeRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p.trim()) {return false}
  const norm = p.replace(/\\/g, '/')
  if (norm.startsWith('/')) {return false}
  if (/^[a-zA-Z]:/.test(norm)) {return false} // Windows 盘符
  const parts = norm.split('/')
  if (parts.some(seg => seg === '..')) {return false}
  return true
}

/** 收集 model3.json 中所有被引用的资源相对路径 */
export function collectReferencedFiles(data: unknown): string[] {
  const out: string[] = []
  if (!isRecord(data)) {return out}
  const refs = data['FileReferences']
  if (!isRecord(refs)) {return out}

  const pushStr = (v: unknown) => { if (typeof v === 'string') {out.push(v)} }
  pushStr(refs['Moc'])
  pushStr(refs['Physics'])
  pushStr(refs['Pose'])
  pushStr(refs['DisplayInfo'])
  if (Array.isArray(refs['Textures'])) {refs['Textures'].forEach(pushStr)}
  if (Array.isArray(refs['Expressions'])) {
    refs['Expressions'].forEach(e => { if (isRecord(e)) {pushStr(e['File'])} })
  }
  const motions = refs['Motions']
  if (isRecord(motions)) {
    for (const group of Object.values(motions)) {
      if (Array.isArray(group)) {group.forEach(m => { if (isRecord(m)) {pushStr(m['File'])} })}
    }
  }
  return out
}

function joinPath(...seg: string[]): string {
  return seg.map(s => s.replace(/[\\/]+$/g, '')).filter(Boolean).join('/')
}

/**
 * 计算导入计划（读取并校验入口 model3，枚举待复制文件）。
 * 不执行复制，便于先预览 / 单测。
 */
export async function planModelImport(
  srcDir: string,
  entryFile: string,
  destRoot: string,
  rawModelName: unknown,
  fs: ModelImporterFs,
): Promise<ImportPlan> {
  const modelName = sanitizeModelName(rawModelName)
  const entryAbs = joinPath(srcDir, entryFile)
  if (!(await fs.fileExists(entryAbs))) {
    throw new Error(`找不到入口文件：${entryFile}（请确认路径未被移动或重命名）`)
  }
  const entryText = await fs.readText(entryAbs)
  let data: unknown
  try { data = JSON.parse(entryText) }
  catch { throw new Error(`入口 ${entryFile} 不是合法 JSON（文件可能损坏或保存编码不是 UTF-8）`) }

  // Cubism 2 旧格式提前拦截，给出可操作的错误
  const legacy = detectLegacyCubism(entryFile, data)
  if (legacy) {throw new Error(legacy)}

  const validation = validateModel3(data)
  if (!validation.valid) {throw new Error(`模型校验失败：${validation.errors.join('；')}`)}

  // 入口相对源目录的目录前缀（资源通常相对 model3 所在目录）
  const entryDir = entryFile.includes('/') ? entryFile.replace(/[^/]+$/, '') : ''
  const referenced = [entryFile, ...collectReferencedFiles(data).map(r => joinPath(entryDir, r))]
  const uniq = Array.from(new Set(referenced))

  const unsafe = uniq.filter(p => !isSafeRelativePath(p))
  if (unsafe.length) {throw new Error(`发现不安全的资源路径（疑似 zip-slip / 目录穿越）：${unsafe.join('，')}`)}

  // 必需文件 = 入口 + moc3 + 全部贴图；其余（Physics/Pose/Motion/Expression）可选
  const refs = isRecord(data) && isRecord(data['FileReferences']) ? data['FileReferences'] : {}
  const required = new Set<string>([entryFile])
  if (typeof refs['Moc'] === 'string') {required.add(joinPath(entryDir, refs['Moc']))}
  if (Array.isArray(refs['Textures'])) {
    for (const t of refs['Textures']) {if (typeof t === 'string') {required.add(joinPath(entryDir, t))}}
  }

  // 逐文件校验存在性：moc3 / 贴图缺失直接报错；可选资源缺失不阻断，由渲染层降级
  const missingRequired: string[] = []
  for (const rel of uniq) {
    if (!required.has(rel)) {continue}
    if (!(await fs.fileExists(joinPath(srcDir, rel)))) {missingRequired.push(rel)}
  }
  if (missingRequired.length) {
    throw new Error(`模型缺少必需文件，导入中止：${missingRequired.join('，')}（请确认模型目录完整解压、没有缺文件）`)
  }

  const files: PlannedFile[] = uniq.map(rel => ({ from: joinPath(srcDir, rel), rel }))
  return {
    modelName,
    entryRel: entryFile,
    targetDir: joinPath(destRoot, modelName),
    files,
  }
}

/** 按计划复制文件到目标目录 */
export async function executePlan(plan: ImportPlan, fs: ModelImporterFs): Promise<{ installedDir: string; fileCount: number }> {
  await fs.ensureDir(plan.targetDir)
  for (const f of plan.files) {
    const to = joinPath(plan.targetDir, f.rel)
    await fs.ensureDir(to.replace(/[^/]+$/, ''))
    await fs.copyFile(f.from, to)
  }
  return { installedDir: plan.targetDir, fileCount: plan.files.length }
}

/**
 * 在磁盘目录下递归查找 *.model3.json（真实文件系统版，供自动扫描 / zip 解压后使用）。
 * 根目录命中优先，其余按目录深度排序；返回相对 rootDir 的 POSIX 路径。
 */
export async function findLive2dEntriesOnDisk(rootDir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: fssync.Dirent[]
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = fspath.join(dir, e.name)
      const rel = fspath.relative(rootDir, abs).replace(/\\/g, '/')
      if (e.isDirectory()) {
        // 跳过常见无关目录，控制扫描量
        if (/^(node_modules|\.git|__MACOSX|resources)$/i.test(e.name)) {continue}
        await walk(abs)
      } else if (/\.model3\.json$/i.test(e.name)) {
        out.push(rel)
      }
    }
  }
  await walk(rootDir)
  out.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  return out
}

/** 文件夹扫描兜底：发现 .model.json / 单个 .moc 时给出 Cubism 2 提示 */
async function findLegacyCubismOnDisk(rootDir: string): Promise<string | null> {
  let entries: fssync.Dirent[]
  try { entries = await fsp.readdir(rootDir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    if (e.isFile() && /\.model\.json$/i.test(e.name) && !/\.model3\.json$/i.test(e.name)) {
      return '检测到 Live2D Cubism 2 模型（.model.json），当前仅支持 Cubism 3/4/5（.model3.json）'
    }
    if (e.isFile() && /\.moc$/i.test(e.name) && !/\.moc3$/i.test(e.name)) {
      return '检测到 Live2D Cubism 2 模型（.moc），当前仅支持 Cubism 3/4/5（.model3.json）'
    }
  }
  return null
}

/**
 * 一站式：校验 → 计划 → 复制。返回安装结果。
 * v0.2：entryFile 传空字符串时，自动在 srcDir 中递归查找 *.model3.json
 * （根目录优先），无需用户手选入口文件。
 */
export async function importLive2dModel(
  srcDir: string,
  entryFile: string,
  destRoot: string,
  rawModelName: unknown,
  fs: ModelImporterFs,
): Promise<ImportPlan & { fileCount: number }> {
  let entry = entryFile || ''
  if (!entry) {
    const found = await findLive2dEntriesOnDisk(srcDir)
    if (!found.length) {
      const legacy = await findLegacyCubismOnDisk(srcDir)
      throw new Error(legacy || `目录中未找到 *.model3.json（请确认已选择模型根目录，且是 Cubism 3/4/5 模型）`)
    }
    entry = found[0]
  }
  const plan = await planModelImport(srcDir, entry, destRoot, rawModelName, fs)
  const res = await executePlan(plan, fs)
  return { ...plan, fileCount: res.fileCount }
}

export interface ZipImportResult extends ImportPlan {
  fileCount: number
  /** 压缩包内找到的全部 model3.json（相对临时解压目录）；调用方可据此让用户多选 */
  candidates: string[]
}

/**
 * 从 zip 缓冲区导入 Live2D 模型（v0.2 新增）。
 *   1. adm-zip 解压到系统临时目录；
 *   2. 递归查找 *.model3.json（根目录优先）；多个时取第一个并把候选列表带回去；
 *   3. 走标准 planModelImport + executePlan；
 *   4. 无论成败都清理临时目录。
 * 解压前检查 zip 条目没有越出根目录（zip-slip 防护）。
 */
export async function importLive2dFromZip(
  zipBuffer: Buffer,
  destRoot: string,
  fs: ModelImporterFs,
  rawModelName?: unknown,
): Promise<ZipImportResult> {
  const zip = openZip(zipBuffer)
  const tmpRoot = await fsp.mkdtemp(fspath.join(os.tmpdir(), 'lumina-live2d-'))
  try {
    for (const entry of zip.getEntries()) {
      const normalized = entry.entryName.replace(/\\/g, '/')
      if (normalized.split('/').some(seg => seg === '..')) {
        throw new Error('压缩包包含越界路径条目（zip-slip 风险），已拒绝导入')
      }
    }
    zip.extractAllTo(tmpRoot, true)

    const candidates = await findLive2dEntriesOnDisk(tmpRoot)
    if (!candidates.length) {
      const legacy = await findLegacyCubismOnDisk(tmpRoot)
      throw new Error(legacy || '压缩包内未找到 *.model3.json（支持 Cubism 3/4/5 模型；请直接打整个模型文件夹）')
    }
    const entry = candidates[0]
    const plan = await planModelImport(tmpRoot, entry, destRoot, rawModelName, fs)
    const res = await executePlan(plan, fs)
    return { ...plan, fileCount: res.fileCount, candidates }
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
}

// ── PNGTuber 立绘组导入 ──────────────────────────────────────

/** PNGTuber 四态帧名约定（相对模型目录） */
export const PNGTUBER_FRAMES = {
  idle: 'idle.png',
  talking: 'talking.png',
  blink: 'blink.png',
  blinkTalking: 'blink-talking.png',
} as const

export interface PngTuberLayout {
  kind: 'pngtuber'
  /** 各帧相对模型目录的实际文件名（仅含实际存在的帧） */
  frames: Partial<Record<keyof typeof PNGTUBER_FRAMES, string>>
  /** 是否具备眨眼两帧（4 态模式） */
  hasBlink: boolean
  /** 可选配置文件 pngtuber.json 的相对路径 */
  configRel: string | null
}

/**
 * 检测一个目录是否为 PNGTuber 立绘组：
 *   - 必须同时存在 idle.png + talking.png（2 态起步）；
 *   - 有 pngtuber.json 时记录其位置（可自定义帧名/参数，渲染层后续读取）；
 *   - 存在 blink.png + blink-talking.png 自动升级为 4 态眨眼模式。
 * 不是 PNGTuber 时返回 null。
 */
export async function detectPngTuberLayout(srcDir: string, fs: ModelImporterFs): Promise<PngTuberLayout | null> {
  const has = (rel: string) => fs.fileExists(joinPath(srcDir, rel))
  const idle = await has(PNGTUBER_FRAMES.idle)
  const talking = await has(PNGTUBER_FRAMES.talking)
  if (!idle || !talking) {return null}

  const frames: PngTuberLayout['frames'] = { idle: PNGTUBER_FRAMES.idle, talking: PNGTUBER_FRAMES.talking }
  const configRel = 'pngtuber.json'
  const hasConfig = await has(configRel)
  const blink = await has(PNGTUBER_FRAMES.blink)
  const blinkTalking = await has(PNGTUBER_FRAMES.blinkTalking)
  if (blink && blinkTalking) {
    frames.blink = PNGTUBER_FRAMES.blink
    frames.blinkTalking = PNGTUBER_FRAMES.blinkTalking
  }
  return { kind: 'pngtuber', frames, hasBlink: !!(blink && blinkTalking), configRel: hasConfig ? configRel : null }
}

/**
 * 导入 PNGTuber 立绘组：把 idle/talking(+blink…) 等帧复制进目标模型目录。
 * 返回 entryRel（注册到模型库用，固定指向 idle.png）与布局描述。
 */
export async function importPngTuberModel(
  srcDir: string,
  destRoot: string,
  rawModelName: unknown,
  fs: ModelImporterFs,
): Promise<{ installedDir: string; entryRel: string; fileCount: number; layout: PngTuberLayout }> {
  const layout = await detectPngTuberLayout(srcDir, fs)
  if (!layout) {
    throw new Error('不是合法的 PNGTuber 模型：目录中必须包含 idle.png 与 talking.png（参见 docs/avatar-guide.md）')
  }
  const modelName = sanitizeModelName(rawModelName)
  const targetDir = joinPath(destRoot, modelName)
  await fs.ensureDir(targetDir)

  const rels = Object.values(layout.frames).filter((p): p is string => !!p)
  if (layout.configRel) {rels.push(layout.configRel)}
  for (const rel of rels) {
    if (!isSafeRelativePath(rel)) {throw new Error(`PNGTuber 帧路径不安全：${rel}`)}
    await fs.copyFile(joinPath(srcDir, rel), joinPath(targetDir, rel))
  }
  return { installedDir: targetDir, entryRel: `${modelName}/${PNGTUBER_FRAMES.idle}`, fileCount: rels.length, layout }
}
