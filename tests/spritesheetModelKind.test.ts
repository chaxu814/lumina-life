// ============================================================
// tests/spritesheetModelKind.test.ts — 精灵表作为一等公民形态
// ============================================================
// 验证 spritesheet 已真正接入 AvatarKind 体系（而不是一个孤立模块）。
// 上一次审计就是靠「有没有调用方」抓出 16KB 死代码的，这里要有对应守卫。
import { describe, it, expect } from 'vitest'
import {
  AVATAR_KINDS,
  KIND_ENTRY_EXT,
  isValidAvatarKind,
  isValidEntryForKind,
} from '../electron/pet/modelLibrary'
import { validateSpriteSheet, SPRITE_COLS, SPRITE_ROWS, assertSafeImportFiles } from '../electron/pet/spriteSheet'
import { isSafeRelativePath } from '../electron/pet/modelImporter'
import { isRenderable, unsupportedReason, AVATAR_RENDERERS } from '../electron/pet/avatarRenderer'

describe('spritesheet 已注册为 AvatarKind', () => {
  it('在形态列表里', () => {
    expect(AVATAR_KINDS).toContain('spritesheet')
  })

  it('isValidAvatarKind 认它', () => {
    expect(isValidAvatarKind('spritesheet')).toBe(true)
  })

  it('入口后缀是 png', () => {
    expect(KIND_ENTRY_EXT.spritesheet).toContain('png')
  })

  it('sprite.png 是合法入口', () => {
    expect(isValidEntryForKind('spritesheet', 'sprite.png')).toBe(true)
  })

  it('拒绝非 png 入口（防止把任意文件当精灵表）', () => {
    expect(isValidEntryForKind('spritesheet', 'sprite.exe')).toBe(false)
    expect(isValidEntryForKind('spritesheet', 'evil.js')).toBe(false)
  })

  it('isValidEntryForKind 只管后缀（路径安全由 register 层的 isSafeRelativePath 负责）', () => {
    // 这是有意的职责划分：isValidEntryForKind 只回答「后缀对不对」，
    // 路径安全在 register() 里先过 isSafeRelativePath 再看后缀。
    expect(isValidEntryForKind('spritesheet', '../../evil.png')).toBe(true)
    expect(isValidEntryForKind('spritesheet', 'evil.exe')).toBe(false)
  })
})

describe('每个形态都有入口后缀定义（防止新增形态漏配）', () => {
  it('所有 kind 都能在 KIND_ENTRY_EXT 查到且非空', () => {
    for (const k of AVATAR_KINDS) {
      expect(KIND_ENTRY_EXT[k], `kind ${k} 缺少入口后缀`).toBeTruthy()
      expect(KIND_ENTRY_EXT[k].length).toBeGreaterThan(0)
    }
  })
})

describe('路径安全的真实边界（register 层）', () => {
  it('isSafeRelativePath 拒绝路径穿越', () => {
    expect(isSafeRelativePath('../../evil.png')).toBe(false)
    expect(isSafeRelativePath('/etc/passwd')).toBe(false)
    expect(isSafeRelativePath('sprite.png')).toBe(true)
    expect(isSafeRelativePath('nested/sprite.png')).toBe(true)
  })

  it('assertSafeImportFiles 与 isSafeRelativePath 口径一致（导入器与模型库双层拦截）', () => {
    expect(assertSafeImportFiles(['../../evil.png'])).toHaveLength(1)
    expect(assertSafeImportFiles(['nested/sprite.png'])).toHaveLength(0)
  })
})

describe('诚实的可用性标注（不能吹）', () => {
  it('精灵表规格已就绪但渲染器未产出 → 标 roadmap 且不可渲染', () => {
    // 宁可明说不可用，也不要让它出现在可选列表里点进去发现是空的
    expect(AVATAR_RENDERERS.spritesheet.status).toBe('roadmap')
    expect(isRenderable('spritesheet')).toBe(false)
  })

  it('不可渲染时必须给出可读原因（而不是静默失败）', () => {
    const why = unsupportedReason('spritesheet')
    expect(why).toBeTruthy()
    expect(why).toMatch(/ROADMAP|待产出|尚未/)
  })

  it('已支持的形态仍然可渲染（没被本次改动误伤）', () => {
    for (const k of ['live2d', 'vrm', 'pngtuber', 'cat'] as const) {
      expect(isRenderable(k)).toBe(true)
    }
  })
})

describe('精灵表校验与形态体系衔接', () => {
  it('标准 8×9 图集在这个体系里合法', () => {
    const r = validateSpriteSheet({ width: SPRITE_COLS * 256, height: SPRITE_ROWS * 256 }, 1024 * 1024)
    expect(r.ok).toBe(true)
  })
})
