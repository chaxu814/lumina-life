// ============================================================
// pet/modelLibrary.ts — 📚 Live2D 模型库注册中心 (v0.2)
//
// modelImporter 负责「把一个模型安全拷进来」，本模块负责「库里有哪些模型、
// 当前用哪个、如何持久化清单」。纯逻辑、不碰文件系统（扫描/读写 JSON 在接线层），
// 内置 Mao 恒定存在且不可删；UGC 模型条目复用导入器的路径安全校验。
// ============================================================

import { sanitizeModelName, isSafeRelativePath } from './modelImporter'

export interface ModelEntry {
  id: string
  name: string
  /** 相对模型资产根目录的 model3.json 路径（POSIX 风格） */
  entryRel: string
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

/** 内置模型（恒定，不参与持久化） */
export const BUILTIN_MODELS: ModelEntry[] = [
  { id: 'Mao', name: 'Mao（魔法使）', entryRel: 'Mao/mao_pro.model3.json', builtin: true, addedAt: 0, hasFiveVowel: true },
]

export class ModelLibrary {
  private map = new Map<string, ModelEntry>()
  private currentId: string | null = null

  constructor(data?: ModelLibraryData, now = 0) {
    for (const b of BUILTIN_MODELS) this.map.set(b.id, { ...b })
    if (data) {
      for (const c of data.custom ?? []) this.register(c, now).ok && void 0
      if (data.currentId && this.map.has(data.currentId)) this.currentId = data.currentId
    }
    if (!this.currentId) this.currentId = BUILTIN_MODELS[0].id
  }

  /** 注册/更新一个自定义模型 */
  register(entry: { name?: string; entryRel: string; id?: string; channels?: number; hasFiveVowel?: boolean }, now = 0): { ok: boolean; id?: string; error?: string } {
    const entryRel = String(entry.entryRel ?? '').replace(/\\/g, '/')
    if (!isSafeRelativePath(entryRel) || !/\.model3\.json$/i.test(entryRel)) {
      return { ok: false, error: '模型入口必须是安全的相对 .model3.json 路径' }
    }
    const id = entry.id ? sanitizeModelName(entry.id) : sanitizeModelName(entry.name ?? entryRel.split('/').slice(-2, -1)[0])
    if (!id) return { ok: false, error: '无法生成有效模型 id' }
    if (BUILTIN_MODELS.some(b => b.id === id)) return { ok: false, error: '与内置模型 id 冲突' }
    this.map.set(id, {
      id,
      name: entry.name?.trim() || id,
      entryRel,
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
    if (!e || e.builtin) return false
    this.map.delete(id)
    if (this.currentId === id) this.currentId = BUILTIN_MODELS[0].id
    return true
  }

  get(id: string): ModelEntry | undefined { return this.map.get(id) }
  list(): ModelEntry[] { return Array.from(this.map.values()) }
  current(): ModelEntry {
    return (this.currentId && this.map.get(this.currentId)) || BUILTIN_MODELS[0]
  }

  /** 切换当前模型，必须已存在 */
  select(id: string): boolean {
    if (!this.map.has(id)) return false
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
