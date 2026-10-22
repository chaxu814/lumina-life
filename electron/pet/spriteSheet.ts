// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pet/spriteSheet.ts — 桌宠自定义精灵表规格 (v0.1)
// ============================================================
//
// 【为什么做这个】
// 桌宠品类的传播靠「用户自己做一只宠物」。业界已验证这条路径
// （fork 比例很高，说明大量用户在做自己的宠物），而成熟的精灵表
// 规格相当成熟。我们不想只支持 Live2D/VRM 这种**需要会 Blender / 会绑定
// 3D 模型**的形态 —— 那把绝大多数想画一只桌宠的人挡在门外。
//
// 【规格设计：8 列 × 9 行】
//   列 = 帧序号，行 = 动作组。约定：
//     行 1 待机 idle            6 帧
//     行 2 向右跑 run-right     8 帧  ← 左跑由本行水平镜像自动补出，省一半工作量
//     行 3 挥手 wave            4 帧
//     行 4 跳跃 jump            5 帧
//     行 5 失败 fail            8 帧
//     行 6 等待 wait            6 帧
//     行 7 工作 work            8 帧  ← 绑定真实 Agent 运行状态（见 intents.ts）
//     行 8 视线向上 look-up     8 帧
//     行 9 视线向下 look-down   8 帧
//   合计 61 帧，8×9 图集。
//
//   设计取舍：
//   - 「左跑靠镜像」是这个规格最省事的地方 —— 跑动动画本来就是左右对称的，
//     逼用户再画一套是纯浪费。
//   - 每行帧数不同，但列数统一 8（最长行），短行左对齐、多余列留空。
//     这样切片器不需要知道每行多少帧，布局规则简单到能写在文档第一屏。
//
// 【三条创建路径】
//   1. 单张静态图（1 分钟）—— 只有呼吸浮动，不算完整精灵表但能立刻用
//   2. AI 生成动作表（~10 分钟）—— 给 AI 一份逐帧描述，让它出图
//   3. 已有图集 —— 直接导入，按本规格校验
//
// 【安全】
// 纯本地处理，不上传、不消耗任何模型额度。校验器拒绝可执行文件与白底图，
// 复用 modelValidator 的风险扫描（见 validateSpriteSheetImage 调用方）。
// ============================================================

import { isSafeRelativePath } from './modelImporter'

/** 精灵表规格常量 */
export const SPRITE_COLS = 8
export const SPRITE_ROWS = 9

/** 动作组定义：行号（1-based）、帧数、说明 */
export interface SpriteActionDef {
  /** 动作 id，写进 sprite.json */
  id: string
  /** 中文名，用于 UI 与 AI 生成提示词 */
  label: string
  /** 在图集中的行号（1-based，从上往下） */
  row: number
  /** 有效帧数（≤ SPRITE_COLS） */
  frames: number
  /** 左向动画是否由本行水平镜像自动补出 */
  mirroredForLeft?: boolean
  /** 给 AI 生成用的逐帧动作描述 */
  description: string
}

export const SPRITE_ACTIONS: readonly SpriteActionDef[] = [
  { id: 'idle', label: '待机', row: 1, frames: 6, description: '轻微呼吸起伏，偶眨眼，身体几乎不动' },
  { id: 'run-right', label: '向右跑', row: 2, frames: 8, mirroredForLeft: true, description: '向右奔跑循环，8 帧连贯，手脚交替' },
  { id: 'wave', label: '挥手', row: 3, frames: 4, description: '抬手挥手致意，4 帧循环' },
  { id: 'jump', label: '跳跃', row: 4, frames: 5, description: '原地起跳-滞空-落地，5 帧' },
  { id: 'fail', label: '失败', row: 5, frames: 8, description: '报错/受挫：捂脸、垂头、叹气，8 帧' },
  { id: 'wait', label: '等待', row: 6, frames: 6, description: '踱步等待、左右张望，6 帧' },
  { id: 'work', label: '工作', row: 7, frames: 8, description: '专注敲键盘/敲代码，8 帧循环' },
  { id: 'look-up', label: '视线向上', row: 8, frames: 8, description: '抬头/视线随鼠标向上移动' },
  { id: 'look-down', label: '视线向下', row: 9, frames: 8, description: '低头/视线随鼠标向下移动' },
] as const

/** 图集规格：帧宽高由用户切图时确定，默认 256×256 */
export const SPRITE_DEFAULT_FRAME = 256

export function getAction(id: string): SpriteActionDef | undefined {
  return SPRITE_ACTIONS.find(a => a.id === id)
}

export function getActionByRow(row: number): SpriteActionDef | undefined {
  return SPRITE_ACTIONS.find(a => a.row === row)
}

/** 某行的有效帧数（越界返回 0） */
export function framesInRow(row: number): number {
  return getActionByRow(row)?.frames ?? 0
}

// ═══════════════════════════════════════════════════════════
// 切片计算
// ═══════════════════════════════════════════════════════════

export interface SpriteFrameRect {
  action: string
  /** 第几帧（0-based） */
  index: number
  x: number
  y: number
  w: number
  h: number
  /** 该帧是否为水平镜像（自动补出的左向帧） */
  mirrored: boolean
}

/**
 * 计算图集里每个有效帧的矩形。
 *
 * @param sheetW 图集像素宽
 * @param sheetH 图集像素高
 * @param frameW 单帧宽（必须整除 sheetW）
 * @param frameH 单帧高（必须整除 sheetH）
 * @param includeMirrored 是否补出镜像帧（默认 true，补全左向动画）
 */
export function computeFrameRects(
  sheetW: number,
  sheetH: number,
  frameW: number = SPRITE_DEFAULT_FRAME,
  frameH: number = SPRITE_DEFAULT_FRAME,
  includeMirrored = true,
): SpriteFrameRect[] {
  const out: SpriteFrameRect[] = []
  if (frameW <= 0 || frameH <= 0) {return out}

  for (const action of SPRITE_ACTIONS) {
    for (let i = 0; i < action.frames; i++) {
      out.push({
        action: action.id,
        index: i,
        x: i * frameW,
        y: (action.row - 1) * frameH,
        w: frameW,
        h: frameH,
        mirrored: false,
      })
    }
    // 左向：水平镜像补出，不占图集空间
    if (includeMirrored && action.mirroredForLeft) {
      for (let i = 0; i < action.frames; i++) {
        out.push({
          action: `${action.id}-left`,
          index: i,
          x: i * frameW,
          y: (action.row - 1) * frameH,
          w: frameW,
          h: frameH,
          mirrored: true,
        })
      }
    }
  }
  return out
}

/** 图集应有的像素尺寸 */
export function expectedSheetSize(
  frameW = SPRITE_DEFAULT_FRAME,
  frameH = SPRITE_DEFAULT_FRAME,
): { w: number; h: number } {
  return { w: SPRITE_COLS * frameW, h: SPRITE_ROWS * frameH }
}

// ═══════════════════════════════════════════════════════════
// 导入校验
// ═══════════════════════════════════════════════════════════

export interface SpriteValidateResult {
  ok: boolean
  /** 阻断性问题（必须修） */
  errors: string[]
  /** 提醒（可导入但体验会打折） */
  warnings: string[]
}

export interface SpriteSheetMeta {
  width: number
  height: number
  /** 帧宽高，缺省按整除推断 */
  frameW?: number
  frameH?: number
}

/** 导入体积上限（与现有模型导入保持一致的量级） */
export const SPRITE_MAX_DIM = 4096
export const SPRITE_MAX_PIXELS = 16_777_216 // 约 16.7M 像素
export const SPRITE_MAX_BYTES = 8 * 1024 * 1024

/**
 * 校验精灵表图集。
 *
 * 故意**不做**过度约束：很多用户会画成 8×8 或 4×9，只要能整除、
 * 行数够用就放行；只有「算不出整帧」或「体积超限」才阻断。
 */
export function validateSpriteSheet(
  meta: SpriteSheetMeta,
  byteLength: number,
  opts: { requireFullGrid?: boolean } = {},
): SpriteValidateResult {
  const errors: string[] = []
  const warnings: string[] = []
  const requireFullGrid = opts.requireFullGrid ?? false

  const { width, height } = meta

  if (width <= 0 || height <= 0) {
    errors.push('图集尺寸无效')
    return { ok: false, errors, warnings }
  }

  if (width > SPRITE_MAX_DIM || height > SPRITE_MAX_DIM) {
    errors.push(`图集边长不能超过 ${SPRITE_MAX_DIM}px（当前 ${width}×${height}）`)
  }
  if (width * height > SPRITE_MAX_PIXELS) {
    errors.push(`图集总像素不能超过 ${SPRITE_MAX_PIXELS}（当前 ${width * height}）`)
  }
  if (byteLength > SPRITE_MAX_BYTES) {
    errors.push(`文件体积不能超过 ${SPRITE_MAX_BYTES / 1024 / 1024}MB（当前 ${(byteLength / 1024 / 1024).toFixed(1)}MB）`)
  }

  // 帧尺寸：优先用户声明，否则按 8×9 推断
  const frameW = meta.frameW ?? (width % SPRITE_COLS === 0 ? width / SPRITE_COLS : 0)
  const frameH = meta.frameH ?? (height % SPRITE_ROWS === 0 ? height / SPRITE_ROWS : 0)

  if (!meta.frameW && frameW === 0) {
    errors.push(`图集宽度 ${width}px 无法按 8 列整除，请让每帧宽度为整数`)
  }
  if (!meta.frameH && frameH === 0) {
    errors.push(`图集高度 ${height}px 无法按 9 行整除，请让每帧高度为整数`)
  }

  if (frameW && frameH) {
    if (frameW < 16 || frameH < 16) {
      errors.push(`单帧尺寸 ${frameW}×${frameH} 过小（最小 16×16）`)
    }
    // 行数不够：缺失的动作组没法播
    const maxRow = SPRITE_ACTIONS.reduce((m, a) => Math.max(m, a.row), 0)
    if (height / frameH < maxRow) {
      errors.push(`图集只有 ${height / frameH} 行，至少需要 ${maxRow} 行覆盖全部动作`)
    } else if (!requireFullGrid) {
      warnings.push('部分动作组可能为空，对应动作会回退到待机动画')
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

// ═══════════════════════════════════════════════════════════
// 清单文件 sprite.json
// ═══════════════════════════════════════════════════════════

export interface SpriteManifest {
  kind: 'spritesheet'
  name: string
  frameW: number
  frameH: number
  /** 覆盖默认帧数的动作（高级用法，一般不用填） */
  frameCounts?: Record<string, number>
  /** 播放帧率 */
  fps?: number
}

export function parseSpriteManifest(raw: string): SpriteManifest | null {
  let data: unknown
  try { data = JSON.parse(raw) } catch { return null }
  if (!data || typeof data !== 'object') {return null}
  const d = data as Record<string, unknown>
  if (d.kind !== 'spritesheet') {return null}
  const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : 'custom-sprite'
  const frameW = typeof d.frameW === 'number' && d.frameW > 0 ? Math.floor(d.frameW) : SPRITE_DEFAULT_FRAME
  const frameH = typeof d.frameH === 'number' && d.frameH > 0 ? Math.floor(d.frameH) : SPRITE_DEFAULT_FRAME
  const fps = typeof d.fps === 'number' && d.fps > 0 ? Math.min(60, Math.max(1, d.fps)) : 12
  return { kind: 'spritesheet', name, frameW, frameH, fps }
}

// ═══════════════════════════════════════════════════════════
// AI 生成提示词（创建路径 2）
// ═══════════════════════════════════════════════════════════

/**
 * 生成给「会画画的 AI」用的规格说明文本。
 *
 * 这是业界验证过的关键体验：用户不需要懂精灵图，
 * 只要把这段规格原样发给 AI，再把出图裁成 8×9 就能用。
 */
export function buildAiSpritePrompt(opts: {
  subject: string
  style?: string
  frameW?: number
  frameH?: number
} = { subject: '一只可爱的猫娘桌宠' }): string {
  const fw = opts.frameW ?? SPRITE_DEFAULT_FRAME
  const fh = opts.frameH ?? SPRITE_DEFAULT_FRAME
  const style = opts.style ?? '日式动漫风格，干净线条，透明背景，居中构图'

  const rows = SPRITE_ACTIONS.map(a =>
    `- 第 ${a.row} 行「${a.label}」：${a.frames} 帧，${a.description}` +
    (a.mirroredForLeft ? '（左向不需要单独画，会自动水平镜像）' : '')
  ).join('\n')

  return [
    `请生成一张桌宠精灵表（sprite sheet）插画。`,
    ``,
    `【主体】${opts.subject}`,
    `【画风】${style}`,
    ``,
    `【画布】必须是 ${SPRITE_COLS} 列 × ${SPRITE_ROWS} 行的规则网格，`,
    `        共 ${SPRITE_COLS * SPRITE_ROWS} 格，每格 ${fw}×${fh}px，整张 ${SPRITE_COLS * fw}×${SPRITE_ROWS * fh}px。`,
    `        角色在每格中保持**完全相同的站位与大小**，只有姿势变化。`,
    `        背景必须**完全透明**，不要投影、不要地面、不要场景。`,
    ``,
    `【逐行动作】`,
    rows,
    ``,
    `【硬性要求】`,
    `1. 背景纯透明；若你的工具不支持透明，请明确说明，不要用白色/纯色填充。`,
    `2. 角色不得跨格；不得出框。`,
    `3. 每行的第一帧要能作为该动作的起始帧，末帧要能无缝接回第一帧（循环动画）。`,
    `4. 不要在图上写任何文字、标注或网格线。`,
  ].join('\n')
}

/** 静态图快速路径提示（创建路径 1，1 分钟） */
export function buildQuickStaticPrompt(subject = '一只可爱的猫娘桌宠'): string {
  return [
    `请生成一张桌宠立绘（单张静态图）。`,
    `【主体】${subject}`,
    `【画风】日式动漫风格，干净线条`,
    `【要求】正面全身，透明背景，居中构图，角色占画面约 80%。`,
    `（说明：本项目会自动为静态图生成呼吸与浮动动画，1 分钟即可上手，`,
    `  但没有跑动/工作等动作。想要完整动画请用 8×9 精灵表。）`,
  ].join('\n')
}

// ═══════════════════════════════════════════════════════════
// 导出：清单与目录名安全
// ═══════════════════════════════════════════════════════════

/** 精灵表在模型目录里的约定文件名 */
export const SPRITE_ENTRY_FILE = 'sprite.png'
export const SPRITE_MANIFEST_FILE = 'sprite.json'

/** 校验导入包内不含可执行文件（复用模型导入的安全规则） */
export function assertSafeImportFiles(relFiles: string[]): string[] {
  const bad: string[] = []
  for (const f of relFiles) {
    if (!isSafeRelativePath(f)) {bad.push(f)}
    const lower = f.toLowerCase()
    if (/\.(js|mjs|cjs|html?|bat|cmd|exe|dll|ps1|sh)$/.test(lower)) {bad.push(f)}
  }
  return bad
}
