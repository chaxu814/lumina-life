// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/macAccessibility.test.ts — macOS AX 元素树单测
//
// 验证 AppleScript 源码构造、TSV 输出解析、角色映射，
// 以及 cuUia.axToNormalized 的 point→pixel→归一化换算
// （Retina 下这一步做错，元素坐标会整体偏一半）。
// 纯函数，Windows 上可完整验证；**不验证真实 AX 行为**（需实机）。
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  buildAxScanScript, parseAxOutput, axRoleToUiType, renderAxElementsText,
  AX_ERROR_PREFIX, AX_DEFAULT_CAP,
  type AxElement,
} from '../electron/core/platform/macAccessibility'
import { computeCaptureGeometry, pointRectToPixel } from '../electron/core/platform/macCoordinate'
import { axToNormalized } from '../electron/tools/impl/cuUia'

const RETINA = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2 }

describe('buildAxScanScript', () => {
  it('默认深度与上限进入脚本', () => {
    const s = buildAxScanScript()
    expect(s).toContain('set maxDepth to 3')
    expect(s).toContain(`set maxElems to ${AX_DEFAULT_CAP}`)
  })

  it('自定义深度/上限被夹在合法区间', () => {
    expect(buildAxScanScript(2, 50)).toContain('set maxDepth to 2')
    expect(buildAxScanScript(2, 50)).toContain('set maxElems to 50')
    // 深度上限 6
    expect(buildAxScanScript(99, 50)).toContain('set maxDepth to 6')
    // cap=0 视为「未指定」→ 回退默认值，而不是夹到 1
    expect(buildAxScanScript(99, 0)).toContain(`set maxElems to ${AX_DEFAULT_CAP}`)
  })

  it('取前台 App 的第一个窗口并递归遍历', () => {
    const s = buildAxScanScript()
    expect(s).toMatch(/frontmost is true/)
    expect(s).toMatch(/window 1/)
    expect(s).toContain('on walkUI')
  })

  it('★ 过滤零尺寸元素（不可见元素没有点击价值）', () => {
    expect(buildAxScanScript()).toMatch(/if w > 1 and h > 1 then/)
  })
})

describe('parseAxOutput', () => {
  const line = (role: string, name: string, x: number, y: number, w: number, h: number,
    en = 'true', fc = 'false') => [role, name, x, y, w, h, en, fc].join('\t')

  it('解析标准 TSV 行', () => {
    const r = parseAxOutput([
      line('AXButton', 'OK', 100, 200, 80, 30),
      line('AXTextField', 'Name', 100, 250, 200, 24),
    ].join('\n'))
    expect(r.scriptError).toBeUndefined()
    expect(r.elements).toHaveLength(2)
    expect(r.elements[0]).toMatchObject({
      index: 0, role: 'AXButton', name: 'OK',
      rect: { x: 100, y: 200, w: 80, h: 30 },
      enabled: true, focused: false,
    })
    expect(r.elements[1].index).toBe(1)
    expect(r.empty).toBe(false)
  })

  it('空输出 → empty 且无 scriptError', () => {
    const r = parseAxOutput('')
    expect(r.elements).toEqual([])
    expect(r.empty).toBe(true)
    expect(r.scriptError).toBeUndefined()
  })

  it('★ AppleScript 报错哨兵被提取为 scriptError（供上层转权限诊断）', () => {
    const r = parseAxOutput(`${AX_ERROR_PREFIX}System Events got an error: not allowed assistive access`)
    expect(r.elements).toEqual([])
    expect(r.empty).toBe(true)
    expect(r.scriptError).toMatch(/assistive access/)
  })

  it('过滤过小/零尺寸元素', () => {
    const r = parseAxOutput([
      line('AXButton', 'tiny', 0, 0, 1, 1),
      line('AXButton', 'ok', 0, 0, 10, 10),
    ].join('\n'))
    expect(r.elements).toHaveLength(1)
    expect(r.elements[0].name).toBe('ok')
  })

  it('坏行只丢自己，不影响其余（单字段容错）', () => {
    const r = parseAxOutput([
      'AXButton',              // 字段不足
      line('AXButton', 'good', 1, 2, 30, 20),
    ].join('\n'))
    expect(r.elements).toHaveLength(1)
    expect(r.elements[0].name).toBe('good')
  })

  it('缺 role 字段的行被丢弃', () => {
    const r = parseAxOutput(`\tname\t1\t2\t30\t20`)
    expect(r.elements).toEqual([])
  })

  it('enabled/focused 解析布尔', () => {
    const r = parseAxOutput(line('AXTextField', 'x', 0, 0, 50, 20, 'false', 'true'))
    expect(r.elements[0].enabled).toBe(false)
    expect(r.elements[0].focused).toBe(true)
  })

  it('字段缺省时 enabled 默认可用、focused 默认否', () => {
    const r = parseAxOutput(['AXButton', 'x', '0', '0', '50', '20'].join('\t'))
    expect(r.elements[0].enabled).toBe(true)
    expect(r.elements[0].focused).toBe(false)
  })

  it('控件名首尾空白被清理，不影响解析', () => {
    const r = parseAxOutput(['AXButton', '  Save  ', '0', '0', '50', '20', 'true', 'false'].join('\t'))
    expect(r.elements).toHaveLength(1)
    expect(r.elements[0].name).toBe('Save')
  })

  it('★ 脚本在输出前清洗控件名里的制表符/换行（否则 TSV 会被拆错列）', () => {
    // 解析层无法从已拆开的行里恢复，故必须在 AppleScript 侧换掉分隔符
    expect(buildAxScanScript()).toContain('on sanitize(s)')
    expect(buildAxScanScript()).toMatch(/my sanitize\(\(name of e\) as text\)/)
  })

  it('尊重 cap 上限', () => {
    const many = Array.from({ length: 10 }, (_, i) => line('AXButton', `b${i}`, 0, i, 20, 20))
    expect(parseAxOutput(many.join('\n'), 3).elements).toHaveLength(3)
  })

  it('非有限坐标的行被丢弃', () => {
    const r = parseAxOutput('AXButton\tx\tNaN\t0\t30\t20\ttrue\tfalse')
    expect(r.elements).toEqual([])
  })
})

describe('axRoleToUiType', () => {
  it('常见角色映射到 Windows UIA 同名控件', () => {
    expect(axRoleToUiType('AXButton')).toBe('Button')
    expect(axRoleToUiType('AXTextField')).toBe('Edit')
    expect(axRoleToUiType('AXStaticText')).toBe('Text')
    expect(axRoleToUiType('AXCheckBox')).toBe('CheckBox')
    expect(axRoleToUiType('AXComboBox')).toBe('ComboBox')
    expect(axRoleToUiType('AXList')).toBe('List')
    expect(axRoleToUiType('AXWebArea')).toBe('Document')
  })

  it('未映射角色去掉 AX 前缀后原样返回', () => {
    expect(axRoleToUiType('AXFooBar')).toBe('FooBar')
  })

  it('空角色 → Unknown', () => {
    expect(axRoleToUiType('')).toBe('Unknown')
  })
})

describe('axToNormalized — point→pixel→归一化（Retina 关键路径）', () => {
  const els: AxElement[] = [
    { index: 0, role: 'AXButton', name: 'OK', rect: { x: 100, y: 200, w: 80, h: 30 }, enabled: true, focused: false },
  ]
  const geo = computeCaptureGeometry([RETINA], 3024, 1964)
  const toRect = (r: { x: number; y: number; w: number; h: number }) => pointRectToPixel(r, geo)

  it('★ Retina：整个矩形（x/y/w/h）一起从 point 放大到像素', () => {
    // imgW/imgH = 截图像素尺寸（2×）
    const out = axToNormalized(els, 3024, 1964, 0, 0, toRect)
    // point (100,200,80,30) → pixel (200,400,160,60)
    expect(out[0].rect).toEqual({ x: 200, y: 400, w: 160, h: 60 })
    // 中心 pixel (200+80, 400+30) = (280, 430) → 归一化
    expect(out[0].nx).toBeCloseTo((280 / 3024) * 100, 4)
    expect(out[0].ny).toBeCloseTo((430 / 1964) * 100, 4)
  })

  it('★ 宽高必须一起缩放：只换原点会让中心点偏移半个控件', () => {
    // 若 rect 的 w/h 停留在 point 空间，中心会是 (240,415) 而非 (280,430)
    const withConv = axToNormalized(els, 3024, 1964, 0, 0, toRect)[0]
    const without = axToNormalized(els, 3024, 1964)[0]
    expect(withConv.nx).toBeCloseTo((280 / 3024) * 100, 4)
    expect(without.nx).toBeCloseTo((140 / 3024) * 100, 4)   // 未换算：中心 point (140,215)
    expect(withConv.nx).toBeCloseTo(without.nx * 2, 4)
  })

  it('映射为 UIA 兼容字段（automationId 空、type 用友好名）', () => {
    const out = axToNormalized(els, 3024, 1964, 0, 0, toRect)
    expect(out[0].type).toBe('Button')
    expect(out[0].automationId).toBe('')
    expect(out[0].name).toBe('OK')
  })

  it('imgW/imgH 为 0 时归一化退化为 0（不产生 NaN）', () => {
    const out = axToNormalized(els, 0, 0, 0, 0, toRect)
    expect(out[0].nx).toBe(0)
    expect(out[0].ny).toBe(0)
  })

  it('归一化夹在 0–100', () => {
    const off: AxElement[] = [
      { index: 0, role: 'AXButton', name: 'far', rect: { x: 99999, y: 99999, w: 10, h: 10 }, enabled: true, focused: false },
    ]
    const out = axToNormalized(off, 3024, 1964, 0, 0, toRect)
    expect(out[0].nx).toBe(100)
    expect(out[0].ny).toBe(100)
  })
})

describe('renderAxElementsText', () => {
  const els: AxElement[] = [
    { index: 0, role: 'AXButton', name: 'OK', rect: { x: 0, y: 0, w: 10, h: 10 }, enabled: true, focused: false },
    { index: 1, role: 'AXTextField', name: '', rect: { x: 0, y: 0, w: 10, h: 10 }, enabled: false, focused: true },
  ]

  it('空树给出明确文案', () => {
    expect(renderAxElementsText([], () => ({ nx: 0, ny: 0 }))).toMatch(/未识别到可交互元素/)
  })

  it('渲染 index/类型/名称/归一化坐标，焦点与禁用可辨识', () => {
    const txt = renderAxElementsText(els, e => ({ nx: 10, ny: 20 }))
    expect(txt).toMatch(/\[0\] Button OK/)
    expect(txt).toMatch(/\(10\.0,20\.0\)/)
    expect(txt).toMatch(/\*焦点\*/)
    expect(txt).toMatch(/禁用/)
  })
})
