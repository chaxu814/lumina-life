// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// a11yFontScale.test.ts — 字号缩放纯函数单测（node 环境）
//
// 覆盖 lib/a11yFontScale.ts 的无 DOM 部分；DOM 行为（applyFontScale /
// startFontScaleObserver）依赖 jsdom，本项目测试环境为 node，
// 以源码断言 + 纯函数测试覆盖。
// ============================================================
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parsePxFontSize, scaledFontSize, shouldSkipFontScale,
} from '../src/lib/a11yFontScale'

const ROOT = join(__dirname, '..')

describe('parsePxFontSize', () => {
  it('解析标准 px 值', () => {
    expect(parsePxFontSize('14px')).toBe(14)
    expect(parsePxFontSize(' 13px ')).toBe(13)
    expect(parsePxFontSize('15.5px')).toBe(15.5)
  })
  it('拒绝非 px / 空值（CSS 类管的字号不归运行时缩放器管）', () => {
    expect(parsePxFontSize('')).toBeNull()
    expect(parsePxFontSize('1.2em')).toBeNull()
    expect(parsePxFontSize('1rem')).toBeNull()
    expect(parsePxFontSize('120%')).toBeNull()
    expect(parsePxFontSize('inherit')).toBeNull()
    expect(parsePxFontSize('medium')).toBeNull()
    expect(parsePxFontSize('calc(13px * 1.25)')).toBeNull()
  })
})

describe('scaledFontSize', () => {
  it('100% 保持原值', () => {
    expect(scaledFontSize(14, 1)).toBe('14px')
  })
  it('125% / 150% 正确换算且无浮点尾巴', () => {
    expect(scaledFontSize(13, 1.25)).toBe('16.25px')
    expect(scaledFontSize(14, 1.25)).toBe('17.5px')
    expect(scaledFontSize(13, 1.5)).toBe('19.5px')
    // 10 * 1.25 = 12.5 浮点直算是 12.500000000000002，必须被抹掉
    expect(scaledFontSize(10, 1.25)).toBe('12.5px')
  })
})

describe('shouldSkipFontScale', () => {
  it('SVG 内部元素跳过（图标靠 stroke/宽高，不靠字号）', () => {
    const svg = { tagName: 'svg', closest: (s: string) => (s === 'svg' ? null : null) }
    const child = { tagName: 'path', closest: (s: string) => (s === 'svg' ? svg : null) }
    expect(shouldSkipFontScale(svg as any)).toBe(true)
    expect(shouldSkipFontScale(child as any)).toBe(true)
  })
  it('普通元素不跳过', () => {
    const div = { tagName: 'DIV', closest: () => null }
    expect(shouldSkipFontScale(div as any)).toBe(false)
  })
})

describe('字号缩放接线（源码断言，防漂移）', () => {
  const globalCss = readFileSync(join(ROOT, 'src/styles/global.css'), 'utf8')
  const a11yCss = readFileSync(join(ROOT, 'src/styles/a11y-high-contrast.css'), 'utf8')
  const appTsx = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')
  const petWindowTs = readFileSync(join(ROOT, 'electron/pet/petWindow.ts'), 'utf8')
  const petChatHtml = readFileSync(join(ROOT, 'electron/pet/pet-chat.html'), 'utf8')

  it('global.css 的字号体系乘上了 --font-scale', () => {
    expect(globalCss).toMatch(/--font-scale:\s*1/)
    expect(globalCss).toMatch(/--font-size-2xs:\s*calc\(10px \* var\(--font-scale\)\)/)
    expect(globalCss).toMatch(/--font-size-md:\s*calc\(15px \* var\(--font-scale\)\)/)
    expect(globalCss).toMatch(/--font-size-2xl:\s*calc\(24px \* var\(--font-scale\)\)/)
  })

  it('不再有 root.style.zoom 放大镜方案', () => {
    expect(appTsx).not.toMatch(/style\.zoom/)
    expect(appTsx).toMatch(/applyFontScale\(document\.body, a11y\.fontScale\)/)
    expect(appTsx).toMatch(/startFontScaleObserver/)
  })

  it('字号经 PetPrefs 同步给桌宠聊天窗', () => {
    expect(petWindowTs).toMatch(/fontScale\?: number/)
    expect(petWindowTs).toMatch(/fontScale: 1/)
    // 广播到独立聊天窗（旧的只发给主桌宠窗）
    expect(petWindowTs).toMatch(/petChatWindow[\s\S]*?send\('pet:prefs-changed'/)
    expect(petChatHtml).toMatch(/applyFontScale/)
    expect(petChatHtml).toMatch(/ipc\.invoke\('pet:prefs'\)/)
    expect(petChatHtml).toMatch(/ipc\.on\('pet:prefs-changed'/)
  })

  it('桌宠 CSS 字号已 calc 化（--font-scale 默认值在 :root）', () => {
    expect(petChatHtml).toMatch(/:root \{ --font-scale: 1; \}/)
    const calcCount = (petChatHtml.match(/font-size: calc\(/g) || []).length
    expect(calcCount).toBeGreaterThanOrEqual(40)
  })

  it('a11y-high-contrast.css 不再重复定义 --font-scale（唯一事实源在 global.css）', () => {
    expect(a11yCss).not.toMatch(/:root \{[\s\S]*?--font-scale:/)
  })
})
