// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pet/modelLibrary.ts — 📚 Live2D 模型库注册中心 (v0.2)
//
// modelImporter 负责「把一个模型安全拷进来」，本模块负责「库里有哪些模型、
// 当前用哪个、如何持久化清单」。纯逻辑、不碰文件系统（扫描/读写 JSON 在接线层），
// 内置 Cat（程序化 Canvas 2D 小猫，零外部素材）恒定存在且不可删；UGC 模型条目
// 复用导入器的路径安全校验。
//
// 【为什么内置形象是程序化小猫而不是 Live2D 模型】
// Live2D Cubism 示例模型（如 Mao）受 SDK 再分发条款约束，公开仓库属于「再分发」，
// 因此不随本项目分发。程序化小猫不依赖任何第三方美术素材，是唯一能保证
// 「任何情况下桌宠都能加载」的零授权选项。Live2D 形象请在应用内自行导入。
// ============================================================

import { sanitizeModelName, isSafeRelativePath } from './modelImporter'
import * as fsp from 'node:fs/promises'
import * as fssync from 'node:fs'
import * as fspath from 'node:path'

/**
 * Avatar 形态：
 *   live2d   已实现：Cubism Live2D（.model3.json）
 *   vrm      已实现：3D VRM（.vrm，three.js / three-vrm）
 *   mmd      beta：MikuMikuDance 模型（.pmx，three.js MMDLoader）
 *   pngtuber 已实现：静态立绘 + 口型切换（.png）
 *   cat      已实现：Canvas 2D 程序化小猫（无外部素材，entryRel='__cat__'）
 */
export type AvatarKind = 'live2d' | 'vrm' | 'mmd' | 'pngtuber' | 'cat' | 'spritesheet'

export const AVATAR_KINDS: AvatarKind[] = ['live2d', 'vrm', 'mmd', 'pngtuber', 'cat', 'spritesheet']

/** 各形态对应的入口文件后缀（小写，不含点）；cat 为程序化特殊入口 */
export const KIND_ENTRY_EXT: Record<AvatarKind, string[]> = {
  live2d: ['model3.json'],
  vrm: ['vrm'],
  mmd: ['pmx', 'pmd'],
  pngtuber: ['png'],
  cat: ['__cat__'],
  // 8×9 精灵表（见 pet/spriteSheet.ts）—— 门槛最低的 UGC 形态：
  // 不用会 Blender 也能做一只自己的桌宠。
  spritesheet: ['png'],
}

export function isValidAvatarKind(kind: unknown): kind is AvatarKind {
  return typeof kind === 'string' && (AVATAR_KINDS as string[]).includes(kind)
}

/** 校验某个形态的入口文件名后缀是否合法 */
export function isValidEntryForKind(kind: AvatarKind, entryRel: string): boolean {
  const lower = entryRel.toLowerCase().replace(/\\/g, '/')
  // cat 为程序化特殊入口，无文件后缀
  if (kind === 'cat') {return lower === '__cat__'}
  return KIND_ENTRY_EXT[kind].some((ext) => lower.endsWith('.' + ext))
}

export interface ModelEntry {
  id: string
  name: string
  /** 相对模型资产根目录的入口文件路径（POSIX 风格）；随 kind 不同后缀不同 */
  entryRel: string
  /** 模型形态；缺省视为 live2d（向后兼容） */
  kind?: AvatarKind
  builtin: boolean
  addedAt: number
  /** discoverProfile 后可回填的能力标记 */
  channels?: number
  hasFiveVowel?: boolean
}

export interface ModelLibraryData {
  currentId: string | null
  custom: ModelEntry[]
}

/** 内置模型（恒定，不参与持久化）。
 *  ⚠️ 数组顺序即优先级，index 0 是**保底形象**：任何异常路径都回退到它。
 *  Cat 是程序化 Canvas 2D 小猫，不依赖任何外部素材，零授权风险、永远可加载。
 *  ⚠️ 改动此数组前请先跑 `tests/modelLibrary.test.ts`，它锁死了这个回退契约。 */
export const BUILTIN_MODELS: ModelEntry[] = [
  { id: 'Cat', name: '小猫', entryRel: '__cat__', kind: 'cat', builtin: true, addedAt: 0 },
]

/** 保底形象 id —— 删改内置模型时必须同步更新的唯一真源 */
export const FALLBACK_MODEL_ID = BUILTIN_MODELS[0].id

/** 保底形象入口路径（渲染层拼 URL 用；Cat 为程序化特殊入口 '__cat__'） */
export const FALLBACK_ENTRY_REL = BUILTIN_MODELS[0].entryRel

/** 取保底形象条目（永远存在，用于所有异常回退路径） */
export function fallbackModel(): ModelEntry {
  return { ...BUILTIN_MODELS[0] }
}

export class ModelLibrary {
  private map = new Map<string, ModelEntry>()
  private currentId: string | null = null

  constructor(data?: ModelLibraryData, now = 0) {
    for (const b of BUILTIN_MODELS) {this.map.set(b.id, { ...b })}
    if (data) {
      for (const c of data.custom ?? []) {this.register(c, now).ok && void 0}
      if (data.currentId && this.map.has(data.currentId)) {this.currentId = data.currentId}
    }
    if (!this.currentId) {this.currentId = BUILTIN_MODELS[0].id}
  }

  /** 注册/更新一个自定义模型 */
  register(entry: { name?: string; entryRel: string; id?: string; kind?: AvatarKind; channels?: number; hasFiveVowel?: boolean }, now = 0): { ok: boolean; id?: string; error?: string } {
    const entryRel = String(entry.entryRel ?? '').replace(/\\/g, '/')
    const kind: AvatarKind = isValidAvatarKind(entry.kind) ? entry.kind : 'live2d'
    if (!isSafeRelativePath(entryRel) || !isValidEntryForKind(kind, entryRel)) {
      const expect = KIND_ENTRY_EXT[kind].map((e) => '.' + e).join(' / ')
      return { ok: false, error: `模型入口必须是安全的相对 ${expect} 路径` }
    }
    const id = entry.id ? sanitizeModelName(entry.id) : sanitizeModelName(entry.name ?? entryRel.split('/').slice(-2, -1)[0])
    if (!id) {return { ok: false, error: '无法生成有效模型 id' }}
    if (BUILTIN_MODELS.some(b => b.id === id)) {return { ok: false, error: '与内置模型 id 冲突' }}
    this.map.set(id, {
      id,
      name: entry.name?.trim() || id,
      entryRel,
      kind,
      builtin: false,
      addedAt: now,
      channels: entry.channels,
      hasFiveVowel: entry.hasFiveVowel,
    })
    return { ok: true, id }
  }

  /** 删除自定义模型；内置不可删；删除当前模型会回退到内置 */
  remove(id: string): boolean {
    const e = this.map.get(id)
    if (!e || e.builtin) {return false}
    this.map.delete(id)
    if (this.currentId === id) {this.currentId = BUILTIN_MODELS[0].id}
    return true
  }

  get(id: string): ModelEntry | undefined { return this.map.get(id) }
  list(): ModelEntry[] { return Array.from(this.map.values()) }
  current(): ModelEntry {
    return (this.currentId && this.map.get(this.currentId)) || BUILTIN_MODELS[0]
  }

  /** 切换当前模型，必须已存在 */
  select(id: string): boolean {
    if (!this.map.has(id)) {return false}
    this.currentId = id
    return true
  }

  /** 仅持久化自定义条目与当前选择（内置恒定） */
  serialize(): ModelLibraryData {
    return {
      currentId: this.currentId,
      custom: Array.from(this.map.values()).filter(e => !e.builtin).map(e => ({ ...e })),
    }
  }

  static deserialize(json: unknown): ModelLibrary {
    if (typeof json === 'object' && json !== null) {
      const d = json as ModelLibraryData
      return new ModelLibrary({ currentId: d.currentId, custom: Array.isArray(d.custom) ? d.custom : [] })
    }
    return new ModelLibrary()
  }
}

// ═══════════════════════════════════════════════════════════
// 磁盘层注册表助手（v0.3 新增）
//
// ModelLibrary 类是纯内存清单；下面这组函数直接操作用户数据目录：
//   - 清单文件：<userData>/pet-model-library.json（与 lifeServices 持久化同一份，
//     不另建 active.json，避免「两处激活状态打架」）；
//   - 模型目录：<userData>/pet-models/<消毒后模型名>/
// 内置保底形象为程序化小猫 Cat（entryRel='__cat__'，无磁盘文件），不落在磁盘目录、
// 不可卸载。曾内置的 Live2D 示例模型 Mao 因 Cubism SDK 再分发条款已退役（见
// petWindow.loadPersistedPetModel 的 RETIRED 迁移），不随仓库/安装包分发。
// ═══════════════════════════════════════════════════════════

/** 磁盘上的已安装模型条目（含在库内注册的元数据 + 磁盘存在性） */
export interface InstalledModel {
  id: string
  name: string
  kind: AvatarKind
  /** 相对 pet-models 根的入口（POSIX 风格） */
  entryRel: string
  /** 缩略图绝对路径；Live2D/VRM 暂未抽取缩略图时为 null */
  thumbnail: string | null
  builtin: boolean
  /** 磁盘上模型目录是否真实存在（可能库有记录但文件已被手动删除） */
  onDisk: boolean
}

function libJsonPath(userDataDir: string): string {
  return fspath.join(userDataDir, 'pet-model-library.json')
}
function modelsRootDir(userDataDir: string): string {
  return fspath.join(userDataDir, 'pet-models')
}

/** 入口后缀 → kind（库内缺 kind 字段时的兜底推断） */
function kindFromEntry(entryRel: string): AvatarKind {
  const lower = entryRel.toLowerCase().replace(/\\/g, '/')
  if (lower === '__cat__') {return 'cat'}
  if (lower.endsWith('.model3.json')) {return 'live2d'}
  if (lower.endsWith('.vrm')) {return 'vrm'}
  if (lower.endsWith('.pmx') || lower.endsWith('.pmd')) {return 'mmd'}
  if (lower.endsWith('.png')) {return 'pngtuber'}
  return 'live2d'
}

// ═══════════════════════════════════════════════════════════
// 开放模型生态：manifest.json 规范
//
// 每个模型目录下可选 manifest.json，用于补充元数据：
//   {
//     "name": "模型名",
//     "kind": "live2d|vrm|mmd|pngtuber",
//     "entry": "relative/path/to/model3.json",
//     "thumbnail": "thumbnail.png",
//     "motions": { "idle": "motions/idle.vmd", "tap": "motions/tap.vmd" },
//     "author": "作者",
//     "license": "许可说明",
//     "source": "来源URL",
//     "version": "1.0"
//   }
// 无 manifest 时从入口文件推断 kind 和名称（向后兼容）。
// ═══════════════════════════════════════════════════════════

export interface ModelManifest {
  name?: string
  kind?: AvatarKind
  entry?: string
  thumbnail?: string
  motions?: Record<string, string>
  author?: string
  license?: string
  source?: string
  version?: string
}

/** 解析 manifest.json 文本；返回 null 表示文件不存在或非法 */
export function parseModelManifest(raw: string): ModelManifest | null {
  try {
    const obj = JSON.parse(raw)
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {return null}
    const out: ModelManifest = {}
    if (typeof obj.name === 'string' && obj.name.trim()) {out.name = obj.name.trim()}
    if (typeof obj.kind === 'string' && isValidAvatarKind(obj.kind)) {out.kind = obj.kind}
    if (typeof obj.entry === 'string' && obj.entry.trim()) {out.entry = obj.entry.trim().replace(/\\/g, '/')}
    if (typeof obj.thumbnail === 'string') {out.thumbnail = obj.thumbnail}
    if (typeof obj.author === 'string') {out.author = obj.author}
    if (typeof obj.license === 'string') {out.license = obj.license}
    if (typeof obj.source === 'string') {out.source = obj.source}
    if (typeof obj.version === 'string') {out.version = obj.version}
    if (typeof obj.motions === 'object' && obj.motions !== null && !Array.isArray(obj.motions)) {
      out.motions = {}
      for (const [k, v] of Object.entries(obj.motions as Record<string, unknown>)) {
        if (typeof v === 'string') {out.motions[k] = v}
      }
    }
    return out
  } catch {
    return null
  }
}

/**
 * 扫描用户数据目录，返回全部已安装模型（内置保底形象在前）。
 * 优先以 pet-model-library.json 中的注册条目为准；磁盘上多出的孤儿目录
 * （库无记录）也会列出并标记 builtin=false、onDisk=true，便于清理。
 */
export async function listInstalledModels(userDataDir: string): Promise<InstalledModel[]> {
  let lib: ModelLibrary
  try {
    const raw = await fsp.readFile(libJsonPath(userDataDir), 'utf8')
    lib = ModelLibrary.deserialize(JSON.parse(raw))
  } catch {
    lib = new ModelLibrary()
  }

  const out: InstalledModel[] = lib.list().map((e) => {
    const kind: AvatarKind = isValidAvatarKind(e.kind) ? e.kind : kindFromEntry(e.entryRel)
    const modelDir = e.builtin ? null : fspath.join(modelsRootDir(userDataDir), e.id)
    return {
      id: e.id,
      name: e.name,
      kind,
      entryRel: e.entryRel,
      thumbnail: kind === 'pngtuber' && !e.builtin
        ? fspath.join(modelsRootDir(userDataDir), e.entryRel)
        : null,
      builtin: e.builtin,
      onDisk: e.builtin ? true : (modelDir !== null && existsDir(modelDir)),
    }
  })

  // 磁盘孤儿目录扫描：库内没注册但磁盘上躺着的模型目录
  const root = modelsRootDir(userDataDir)
  let dirs: fssync.Dirent[]
  try { dirs = await fsp.readdir(root, { withFileTypes: true }) } catch { dirs = [] }
  const known = new Set(out.map(o => o.id))
  for (const d of dirs) {
    if (!d.isDirectory() || known.has(d.name)) {continue}
    out.push({
      id: d.name,
      name: d.name,
      kind: 'live2d',
      entryRel: '',
      thumbnail: null,
      builtin: false,
      onDisk: true,
    })
  }
  return out
}

function existsDir(p: string): boolean {
  try {
    // 同步检查足够（启动时一次性枚举）
    return fssync.existsSync(p)
  } catch { return false }
}

/**
 * 当前激活模型 id（读 pet-model-library.json 的 currentId）。
 *
 * 【为什么必须校验存在性】库文件可能来自旧版本：例如用户此前选中过一个
 * 已被移出仓库的 Live2D 模型，或手动删过模型目录。若只读不校验，会拿到
 * 一个库里不存在的 id，一路传到渲染层才炸成「模型加载失败」。这里直接
 * 判定为无效并回退保底形象，让失败发生在最靠近数据源的地方。
 */
export function getActiveModel(userDataDir: string): string {
  try {
    const text = fssync.readFileSync(libJsonPath(userDataDir), 'utf8')
    const raw: unknown = JSON.parse(text)
    const id = (raw as { currentId?: unknown }).currentId
    if (typeof id !== 'string' || !id) {return FALLBACK_MODEL_ID}
    // 注意：deserialize 要的是**已解析的对象**，传字符串会被当成空库。
    const lib = ModelLibrary.deserialize(raw as ModelLibraryData)
    return lib.get(id) ? id : FALLBACK_MODEL_ID
  } catch {
    return FALLBACK_MODEL_ID
  }
}

/**
 * 切换激活模型：写回 pet-model-library.json 的 currentId。
 * 注意只改库记录，不触碰磁盘文件；内置保底形象恒定可选。
 * 返回 false 表示目标模型不存在于库中。
 */
export function setActiveModel(userDataDir: string, modelId: string): boolean {
  let raw: unknown = null
  try {
    raw = JSON.parse(fssync.readFileSync(libJsonPath(userDataDir), 'utf8'))
  } catch { raw = { currentId: null, custom: [] } }
  const lib = ModelLibrary.deserialize(raw)
  if (!lib.select(modelId)) {return false}
  const data = lib.serialize()
  try {
    fssync.mkdirSync(fspath.dirname(libJsonPath(userDataDir)), { recursive: true })
    fssync.writeFileSync(libJsonPath(userDataDir), JSON.stringify(data, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 卸载模型：从库中移除 + 删除磁盘模型目录。
 * 内置保底形象拒绝删除。当前激活模型被删时，库会自动回退到保底形象。
 */
export async function uninstallModel(userDataDir: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
  const cleanId = sanitizeModelName(modelId)
  if (BUILTIN_MODELS.some(b => b.id === cleanId)) {
    return { ok: false, error: '内置模型不可卸载' }
  }
  let raw: unknown = null
  try {
    raw = JSON.parse(await fsp.readFile(libJsonPath(userDataDir), 'utf8'))
  } catch { /* 无库文件 */ }
  const lib = ModelLibrary.deserialize(raw)
  if (!lib.remove(cleanId)) {return { ok: false, error: '模型不在库中' }}
  await fsp.writeFile(libJsonPath(userDataDir), JSON.stringify(lib.serialize(), null, 2), 'utf8').catch(() => {})

  const target = fspath.join(modelsRootDir(userDataDir), cleanId)
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
  return { ok: true }
}
