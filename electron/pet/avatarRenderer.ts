// ============================================================
// pet/avatarRenderer.ts — Avatar 渲染器统一抽象 (v1.0)
//
// 目的：把"多形态渲染后端"的选择逻辑收敛到一处纯函数模块，不依赖 Electron，
// 可直接单测。渲染页路由 / 模型路径解析 / 内置回退 / 文件校验全部在此。
//
// 支持矩阵：
//   live2d   ✅ 已支持  pet-live2d.html   Cubism 3/4/5 (.model3.json)
//   vrm      ✅ 已支持  pet-vrm.html      three.js + @pixiv/three-vrm (.vrm)
//   pngtuber ✅ 已支持  pet-pngtuber.html  Canvas 静态立绘 + 口型 (.png)
//   mmd      🟡 beta    pet-mmd.html      three.js MMDLoader (.pmx)
//   cat      ✅ 内置     pet-cat.html      Canvas 2D 程序化小猫 (无素材)
// ============================================================

import type { AvatarKind, ModelLibraryData, ModelEntry } from './modelLibrary'
import { BUILTIN_MODELS, isValidAvatarKind } from './modelLibrary'

// ── 渲染器注册表 ──────────────────────────────────────────────

export interface RendererInfo {
  kind: AvatarKind
  /** 渲染页 HTML 文件名（相对 pet 源目录） */
  htmlFile: string
  /** 面向用户的形态名 */
  displayName: string
  /** 是否真正可渲染（false = roadmap，不应路由到该页） */
  supported: boolean
  /** beta 标注（仅 mmd） */
  beta?: boolean
  /** 不可渲染时给用户的提示 */
  unsupportedNote?: string
}

export const RENDERER_REGISTRY: Record<AvatarKind, RendererInfo> = {
  live2d: {
    kind: 'live2d',
    htmlFile: 'pet-live2d.html',
    displayName: 'Live2D（2D 立绘）',
    supported: true,
  },
  vrm: {
    kind: 'vrm',
    htmlFile: 'pet-vrm.html',
    displayName: 'VRM（3D 模型）',
    supported: true,
  },
  pngtuber: {
    kind: 'pngtuber',
    htmlFile: 'pet-pngtuber.html',
    displayName: 'PNGTuber（静态立绘）',
    supported: true,
  },
  mmd: {
    kind: 'mmd',
    htmlFile: 'pet-mmd.html',
    displayName: 'MMD（3D 模型）',
    supported: true,
    beta: true,
    unsupportedNote: undefined,
  },
  cat: {
    kind: 'cat',
    htmlFile: 'pet-cat.html',
    displayName: '小猫（程序化）',
    supported: true,
  },
  // 8×9 精灵表：门槛最低的 UGC 形态（不用会 Blender）。
  // 渲染器 HTML 尚未产出，标 supported: false —— 宁可明说不可用，
  // 也不让它出现在可选列表里点进去才发现是空的。
  spritesheet: {
    kind: 'spritesheet',
    htmlFile: '',
    displayName: '精灵表（8×9 · 自制桌宠）',
    supported: false,
    unsupportedNote:
      '精灵表规格与导入校验已就绪（见 electron/pet/spriteSheet.ts），' +
      '但渲染器页面尚未产出，暂不可用。已列入 ROADMAP v0.2.0。',
  },
}

/** 按 kind 查渲染器信息 */
export function getRendererForKind(kind: AvatarKind): RendererInfo {
  const info = RENDERER_REGISTRY[kind]
  if (info) {return { ...info }}
  // 未知 kind 兜底 live2d
  return { ...RENDERER_REGISTRY.live2d }
}

// ── 向后兼容的旧 API（测试与旧代码仍在用）──────────────────────

export type RendererStatus = 'ready' | 'beta' | 'roadmap'

export interface AvatarRendererInfo {
  kind: AvatarKind
  label: string
  status: RendererStatus
  roadmapNote?: string
  entryExts: string[]
}

export const AVATAR_RENDERERS: Record<AvatarKind, AvatarRendererInfo> = {
  live2d: { kind: 'live2d', label: 'Live2D（2D 立绘）', status: 'ready', entryExts: ['model3.json'] },
  vrm: { kind: 'vrm', label: 'VRM（3D 模型）', status: 'ready', entryExts: ['vrm'] },
  mmd: { kind: 'mmd', label: 'MMD（3D 模型）', status: 'beta', roadmapNote: 'MMD 支持为 beta（.pmx），暂不支持物理/表情/.pmd 老格式。', entryExts: ['pmx', 'pmd'] },
  pngtuber: { kind: 'pngtuber', label: 'PNGTuber（静态立绘）', status: 'ready', entryExts: ['png'] },
  cat: { kind: 'cat', label: '小猫（程序化）', status: 'ready', entryExts: ['__cat__'] },
  spritesheet: {
    kind: 'spritesheet',
    label: '精灵表（8×9 · 自制桌宠）',
    status: 'roadmap',
    roadmapNote:
      '规格、切片、AI 生成提示词与导入校验已就绪，渲染器待产出（ROADMAP v0.2.0）。',
    entryExts: ['png'],
  },
}

/** 某形态当前是否真正可渲染 */
export function isRenderable(kind: AvatarKind | undefined): boolean {
  if (!kind) {return true} // 未指定视为 live2d（向后兼容）
  return RENDERER_REGISTRY[kind]?.supported === true
}

/** 选中不可渲染形态时给用户的提示；可渲染时返回 null */
export function unsupportedReason(kind: AvatarKind | undefined): string | null {
  if (!kind || isRenderable(kind)) {return null}
  return AVATAR_RENDERERS[kind]?.roadmapNote ?? '该形态暂未支持。'
}

/** 已就绪形态列表 */
export function readyKinds(): AvatarKind[] {
  return (Object.keys(RENDERER_REGISTRY) as AvatarKind[]).filter((k) => RENDERER_REGISTRY[k].supported)
}

// ── 模型路径解析纯函数 ────────────────────────────────────────

/** 回退到内置 Mao（任何异常路径下的安全默认值） */
export function fallbackToBuiltin(): { modelId: string; kind: AvatarKind; entryRel: string } {
  const mao = BUILTIN_MODELS.find(b => b.id === 'Mao') || BUILTIN_MODELS[0]
  return { modelId: mao.id, kind: (mao.kind as AvatarKind) || 'live2d', entryRel: mao.entryRel }
}

/**
 * 从库数据中解析指定模型的入口路径与形态。
 * 找不到时返回 null（调用方应回退 fallbackToBuiltin）。
 */
export function resolveModelEntry(
  libraryData: ModelLibraryData | null | undefined,
  modelId: string,
): { entryRel: string; kind: AvatarKind; modelId: string } | null {
  if (!libraryData || typeof modelId !== 'string' || !modelId) {return null}
  // 先查内置
  const builtin = BUILTIN_MODELS.find(b => b.id === modelId)
  if (builtin) {
    return { entryRel: builtin.entryRel, kind: (builtin.kind as AvatarKind) || 'live2d', modelId: builtin.id }
  }
  // 再查自定义
  const custom = Array.isArray(libraryData.custom) ? libraryData.custom.find((c: ModelEntry) => c.id === modelId) : null
  if (custom && custom.entryRel) {
    const kind = isValidAvatarKind(custom.kind) ? custom.kind : guessKindFromEntry(custom.entryRel)
    return { entryRel: custom.entryRel, kind, modelId: custom.id }
  }
  return null
}

/** 从入口文件后缀猜测 kind（纯函数，不碰文件系统） */
export function guessKindFromEntry(entryRel: string): AvatarKind {
  const lower = entryRel.toLowerCase().replace(/\\/g, '/')
  if (lower === '__cat__') {return 'cat'}
  if (lower.endsWith('.model3.json')) {return 'live2d'}
  if (lower.endsWith('.vrm')) {return 'vrm'}
  if (lower.endsWith('.pmx') || lower.endsWith('.pmd')) {return 'mmd'}
  if (lower.endsWith('.png')) {return 'pngtuber'}
  return 'live2d'
}

/**
 * 校验模型入口路径是否合法（文件存在 + 扩展名正确）。
 * 纯函数：存在性检查由调用方注入（这里只做路径后缀判断，避免直接依赖 fs）。
 * 对于 cat 特殊入口，恒为 true（无文件需检查）。
 */
export function isModelValid(entryPath: string, kind: AvatarKind): boolean {
  if (kind === 'cat') {return entryPath === '__cat__'}
  if (kind === 'mmd') {return /\.pmx$/i.test(entryPath) || /\.pmd$/i.test(entryPath)}
  if (kind === 'live2d') {return /\.model3\.json$/i.test(entryPath)}
  if (kind === 'vrm') {return /\.vrm$/i.test(entryPath)}
  if (kind === 'pngtuber') {return /\.png$/i.test(entryPath)}
  return false
}
