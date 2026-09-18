// ============================================================
// pet/avatarRenderer.ts — Avatar 渲染器抽象与能力声明
//
// 目的：在不假装"已经能渲染 VRM/MMD"的前提下，把多形态渲染的接口固定下来。
// 当前唯一落地的是 Live2D（在 pet-live2d.html 里运行）。VRM / MMD / PNGTuber
// 标记为 roadmap：选中这些模型时，前端应拿到明确的"暂未支持"提示，而不是黑屏。
//
// 真正的 3D 渲染器接入后，只需在 AVATAR_RENDERERS 注册对应实现即可，
// 上层（模型库 / 设置 / 桌宠窗口）无需改动。
// ============================================================

import type { AvatarKind } from './modelLibrary'

export type RendererStatus = 'ready' | 'roadmap'

export interface AvatarRendererInfo {
  kind: AvatarKind
  /** 面向用户的形态名 */
  label: string
  /** 能力状态：ready 已可渲染；roadmap 为架构预留 */
  status: RendererStatus
  /** roadmap 时给用户的说明 */
  roadmapNote?: string
  /** 支持的入口后缀 */
  entryExts: string[]
}

export const AVATAR_RENDERERS: Record<AvatarKind, AvatarRendererInfo> = {
  live2d: {
    kind: 'live2d',
    label: 'Live2D（2D 立绘）',
    status: 'ready',
    entryExts: ['model3.json'],
  },
  vrm: {
    kind: 'vrm',
    label: 'VRM（3D 模型）',
    status: 'roadmap',
    roadmapNote: 'VRM 3D 渲染（three.js / three-vrm）正在开发中，当前版本暂不支持载入 .vrm。',
    entryExts: ['vrm'],
  },
  mmd: {
    kind: 'mmd',
    label: 'MMD（3D 模型）',
    status: 'roadmap',
    roadmapNote: 'MMD（.pmx/.pmd）渲染正在规划中，当前版本暂不支持。',
    entryExts: ['pmx', 'pmd'],
  },
  pngtuber: {
    kind: 'pngtuber',
    label: 'PNGTuber（静态立绘）',
    status: 'roadmap',
    roadmapNote: '静态立绘 + 口型切换正在规划中，当前版本暂不支持。',
    entryExts: ['png'],
  },
}

/** 某形态当前是否真正可渲染 */
export function isRenderable(kind: AvatarKind | undefined): boolean {
  if (!kind) return true // 未指定视为 live2d（向后兼容）
  return AVATAR_RENDERERS[kind]?.status === 'ready'
}

/** 选中不可渲染形态时给用户的提示；可渲染时返回 null */
export function unsupportedReason(kind: AvatarKind | undefined): string | null {
  if (!kind || isRenderable(kind)) return null
  return AVATAR_RENDERERS[kind].roadmapNote ?? '该形态暂未支持。'
}

/** 已就绪形态列表 */
export function readyKinds(): AvatarKind[] {
  return (Object.keys(AVATAR_RENDERERS) as AvatarKind[]).filter((k) => AVATAR_RENDERERS[k].status === 'ready')
}
