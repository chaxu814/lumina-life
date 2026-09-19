// ============================================================
// pet/modelImporter.ts — 🐱 Live2D 形象 UGC 导入器 (v0.1)
//
// 让用户能把自己的 Live2D Cubism 模型（*.model3.json）导入 Lumina，
// 而不是只能用内置的 Mao。重点是「安全」：
//   - 校验 model3.json 的最小合法结构（Version / FileReferences.Moc）；
//   - 模型名消毒，禁止路径分隔符与「..」；
//   - 校验所有被引用资源都是安全相对路径，防 zip-slip / 目录穿越；
//   - 文件系统操作通过最小接口注入，纯逻辑可单测。
// ============================================================

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
    errors.push('FileReferences.Moc 必须是指向 .moc3 的字符串')
  }
  if (refs['Textures'] !== undefined) {
    if (!Array.isArray(refs['Textures']) || refs['Textures'].some(t => typeof t !== 'string')) {
      errors.push('FileReferences.Textures 必须是字符串数组')
    }
  }
  return { valid: errors.length === 0, errors }
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
  const entryText = await fs.readText(entryAbs)
  let data: unknown
  try { data = JSON.parse(entryText) } catch { throw new Error('入口 model3.json 不是合法 JSON') }

  const validation = validateModel3(data)
  if (!validation.valid) {throw new Error(`模型校验失败：${validation.errors.join('；')}`)}

  // 入口相对源目录的目录前缀（资源通常相对 model3 所在目录）
  const entryDir = entryFile.includes('/') ? entryFile.replace(/[^/]+$/, '') : ''
  const referenced = [entryFile, ...collectReferencedFiles(data).map(r => joinPath(entryDir, r))]
  const uniq = Array.from(new Set(referenced))

  const unsafe = uniq.filter(p => !isSafeRelativePath(p))
  if (unsafe.length) {throw new Error(`发现不安全的资源路径：${unsafe.join('，')}`)}

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

/** 一站式：校验 → 计划 → 复制。返回安装结果。 */
export async function importLive2dModel(
  srcDir: string,
  entryFile: string,
  destRoot: string,
  rawModelName: unknown,
  fs: ModelImporterFs,
): Promise<ImportPlan & { fileCount: number }> {
  const plan = await planModelImport(srcDir, entryFile, destRoot, rawModelName, fs)
  const res = await executePlan(plan, fs)
  return { ...plan, fileCount: res.fileCount }
}
