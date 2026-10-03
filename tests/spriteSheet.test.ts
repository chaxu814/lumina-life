// ============================================================
// tests/spriteSheet.test.ts — 桌宠精灵表规格 (8×9) 测试
// ============================================================
import { describe, it, expect } from 'vitest'
import {
  SPRITE_COLS, SPRITE_ROWS, SPRITE_ACTIONS, SPRITE_DEFAULT_FRAME,
  getAction, getActionByRow, framesInRow,
  computeFrameRects, expectedSheetSize,
  validateSpriteSheet, parseSpriteManifest,
  buildAiSpritePrompt, buildQuickStaticPrompt,
  assertSafeImportFiles, SPRITE_MAX_DIM,
} from '../electron/pet/spriteSheet'

describe('精灵表规格常量', () => {
  it('是 8 列 × 9 行', () => {
    expect(SPRITE_COLS).toBe(8)
    expect(SPRITE_ROWS).toBe(9)
  })

  it('九个动作行号 1~9 不重复不跳号', () => {
    const rows = SPRITE_ACTIONS.map(a => a.row).sort((x, y) => x - y)
    expect(rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('每个动作帧数都在 1~8 之间（不能超出一行的列数）', () => {
    for (const a of SPRITE_ACTIONS) {
      expect(a.frames).toBeGreaterThan(0)
      expect(a.frames).toBeLessThanOrEqual(SPRITE_COLS)
    }
  })

  it('动作 id 唯一', () => {
    const ids = SPRITE_ACTIONS.map(a => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('只有跑动动作标记了镜像补左', () => {
    const mirrored = SPRITE_ACTIONS.filter(a => a.mirroredForLeft)
    expect(mirrored.length).toBe(1)
    expect(mirrored[0].id).toBe('run-right')
  })

  it('按 id / 按行都能查到，未知返回 undefined', () => {
    expect(getAction('idle')?.label).toBe('待机')
    expect(getActionByRow(1)?.id).toBe('idle')
    expect(getAction('nope')).toBeUndefined()
    expect(framesInRow(0)).toBe(0)
    expect(framesInRow(99)).toBe(0)
  })
})

describe('切片计算', () => {
  it('默认帧尺寸下图集是 2048×2304', () => {
    expect(expectedSheetSize()).toEqual({ w: 8 * 256, h: 9 * 256 })
  })

  it('不补镜像时帧数 = 各动作帧数之和（61）', () => {
    const rects = computeFrameRects(2048, 2304, 256, 256, false)
    const expected = SPRITE_ACTIONS.reduce((n, a) => n + a.frames, 0)
    expect(rects.length).toBe(expected)
    expect(expected).toBe(61)
  })

  it('补镜像时额外多出一组 run-left（+8 帧）', () => {
    const withMirror = computeFrameRects(2048, 2304, 256, 256, true)
    const base = computeFrameRects(2048, 2304, 256, 256, false)
    const runRight = SPRITE_ACTIONS.find(a => a.id === 'run-right')!
    expect(withMirror.length).toBe(base.length + runRight.frames)
  })

  it('每个动作的第一帧 y 坐标 = (row-1)*frameH', () => {
    const rects = computeFrameRects(2048, 2304, 256, 256, false)
    for (const a of SPRITE_ACTIONS) {
      const first = rects.find(r => r.action === a.id && r.index === 0)!
      expect(first.y).toBe((a.row - 1) * 256)
      expect(first.x).toBe(0)
      expect(first.mirrored).toBe(false)
    }
  })

  it('帧矩形都落在图集范围内', () => {
    const rects = computeFrameRects(2048, 2304, 256, 256, true)
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w).toBeLessThanOrEqual(2048)
      expect(r.y + r.h).toBeLessThanOrEqual(2304)
    }
  })

  it('镜像是水平镜像（x 不变，只改 mirrored 标记）', () => {
    const rects = computeFrameRects(2048, 2304, 256, 256, true)
    const right = rects.find(r => r.action === 'run-right' && r.index === 3)!
    const left = rects.find(r => r.action === 'run-right-left' && r.index === 3)!
    expect(left.x).toBe(right.x)
    expect(left.y).toBe(right.y)
    expect(left.mirrored).toBe(true)
    expect(right.mirrored).toBe(false)
  })

  it('帧尺寸非法时返回空数组而不是抛错', () => {
    expect(computeFrameRects(2048, 2304, 0, 256)).toEqual([])
    expect(computeFrameRects(2048, 2304, 256, -1)).toEqual([])
  })
})

describe('导入校验', () => {
  it('标准 256 帧的 8×9 图集通过', () => {
    const r = validateSpriteSheet({ width: 2048, height: 2304 }, 2 * 1024 * 1024)
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('宽度无法被 8 整除时阻断（并说明原因）', () => {
    // 2003 不能被 8 整除（2000 可以：2000/8=250）
    const r = validateSpriteSheet({ width: 2003, height: 2304 }, 1024)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/8 列整除/)
  })

  it('高度无法被 9 整除时阻断', () => {
    const r = validateSpriteSheet({ width: 2048, height: 2000 }, 1024)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/9 行整除/)
  })

  it('显式声明帧尺寸时不再要求整除', () => {
    const r = validateSpriteSheet({ width: 1000, height: 900, frameW: 125, frameH: 100 }, 1024)
    expect(r.ok).toBe(true)
  })

  it('边长超限阻断', () => {
    const r = validateSpriteSheet({ width: SPRITE_MAX_DIM + 1, height: SPRITE_MAX_DIM + 1 }, 1024)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/边长/)
  })

  it('体积超 8MB 阻断', () => {
    const r = validateSpriteSheet({ width: 2048, height: 2304 }, 9 * 1024 * 1024)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/8MB/)
  })

  it('单帧过小阻断', () => {
    const r = validateSpriteSheet({ width: 2048, height: 2304, frameW: 8, frameH: 8 }, 1024)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/过小/)
  })

  it('行数不足（放不下 9 行）阻断', () => {
    const r = validateSpriteSheet({ width: 2048, height: 1024, frameH: 128 }, 1024)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/至少需要 9 行/)
  })

  it('尺寸为 0 直接阻断', () => {
    const r = validateSpriteSheet({ width: 0, height: 0 }, 0)
    expect(r.ok).toBe(false)
  })
})

describe('sprite.json 解析', () => {
  it('解析完整清单', () => {
    const m = parseSpriteManifest(JSON.stringify({
      kind: 'spritesheet', name: '我的桌宠', frameW: 128, frameH: 128, fps: 8,
    }))
    expect(m).toEqual({ kind: 'spritesheet', name: '我的桌宠', frameW: 128, frameH: 128, fps: 8 })
  })

  it('缺字段时用默认值补齐', () => {
    const m = parseSpriteManifest(JSON.stringify({ kind: 'spritesheet' }))
    expect(m?.name).toBe('custom-sprite')
    expect(m?.frameW).toBe(SPRITE_DEFAULT_FRAME)
    expect(m?.fps).toBe(12)
  })

  it('fps 被夹在 1~60', () => {
    expect(parseSpriteManifest(JSON.stringify({ kind: 'spritesheet', fps: 999 }))?.fps).toBe(60)
    expect(parseSpriteManifest(JSON.stringify({ kind: 'spritesheet', fps: 0 }))?.fps).toBe(12)
  })

  it('非法 JSON / 类型不符 / kind 不对都返回 null', () => {
    expect(parseSpriteManifest('{not json')).toBeNull()
    expect(parseSpriteManifest('[]')).toBeNull()
    expect(parseSpriteManifest(JSON.stringify({ kind: 'vrm' }))).toBeNull()
  })
})

describe('AI 生成提示词', () => {
  it('包含 8 列 9 行与画布尺寸', () => {
    const p = buildAiSpritePrompt({ subject: '一只柴犬桌宠' })
    expect(p).toMatch(/8 列 × 9 行/)
    expect(p).toMatch(/2048×2304/)
    expect(p).toMatch(/柴犬桌宠/)
  })

  it('逐行列出九个动作', () => {
    const p = buildAiSpritePrompt({})
    for (const a of SPRITE_ACTIONS) {
      expect(p).toContain(a.label)
    }
  })

  it('说明左跑不需要单独画', () => {
    const p = buildAiSpritePrompt({})
    expect(p).toMatch(/左向不需要单独画|水平镜像/)
  })

  it('要求透明背景与循环首尾相接', () => {
    const p = buildAiSpritePrompt({})
    expect(p).toMatch(/透明/)
    expect(p).toMatch(/循环/)
  })

  it('静态图提示词是另一条路径且说明只能做呼吸浮动', () => {
    const p = buildQuickStaticPrompt()
    expect(p).toMatch(/单张静态图/)
    expect(p).toMatch(/呼吸/)
  })
})

describe('导入包安全', () => {
  it('拦截路径穿越', () => {
    expect(assertSafeImportFiles(['../../evil.png'])).toHaveLength(1)
  })

  it('拦截可执行文件', () => {
    const bad = assertSafeImportFiles(['a/b.png', 'run.js', 'x.exe', 'y.ps1', 'z.html'])
    expect(bad).toHaveLength(4)
  })

  it('正常图片放行', () => {
    expect(assertSafeImportFiles(['sprite.png', 'sprite.json'])).toHaveLength(0)
  })
})
