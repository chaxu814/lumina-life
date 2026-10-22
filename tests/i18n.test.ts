// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/i18n.test.ts — i18n 语言包与运行时行为单测
//
// 覆盖：
// - en-US.json 与 zh-CN.json 的扁平 key 集合完全一致（无缺 key）
// - i18n.changeLanguage() 持久化到 localStorage（key: lumina_lang）
// - fallbackLng 回退到 zh-CN
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'
import zhCN from '../src/i18n/locales/zh-CN.json'
import enUS from '../src/i18n/locales/en-US.json'

/** 把嵌套对象拍平成 "a.b.c" 的 key 列表 */
function flattenKeys(obj: Record<string, any>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenKeys(v, key))
    } else {
      out.push(key)
    }
  }
  return out
}

describe('i18n locale parity', () => {
  const zhKeys = flattenKeys(zhCN as Record<string, any>)
  const enKeys = flattenKeys(enUS as Record<string, any>)
  const zhSet = new Set(zhKeys)
  const enSet = new Set(enKeys)

  it('en-US has every key that zh-CN defines', () => {
    const missing = zhKeys.filter((k) => !enSet.has(k))
    expect(missing, `keys missing in en-US: ${missing.join(', ')}`).toEqual([])
  })

  it('zh-CN has every key that en-US defines', () => {
    const missing = enKeys.filter((k) => !zhSet.has(k))
    expect(missing, `keys missing in zh-CN: ${missing.join(', ')}`).toEqual([])
  })

  it('every locale value is a non-empty string', () => {
    const bad: string[] = []
    for (const k of zhKeys) {
      // 手动遍历取叶子值
      let cur: any = zhCN
      for (const part of k.split('.')) { cur = cur?.[part] }
      if (typeof cur !== 'string' || cur.trim() === '') { bad.push(k) }
    }
    expect(bad, `empty/non-string zh-CN values: ${bad.join(', ')}`).toEqual([])
  })
})

describe('i18n runtime', () => {
  beforeEach(() => {
    vi.resetModules()
    // Node 环境没有浏览器对象；按 i18n/index.ts 的配置 stub localStorage。
    // i18next-browser-languagedetector 读 window.localStorage，故 window 也要指向同一个 store。
    const store = new Map<string, string>()
    const localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
      removeItem: (k: string) => { store.delete(k) },
    }
    ;(globalThis as any).localStorage = localStorage
    ;(globalThis as any).window = { localStorage }
  })

  it('falls back to zh-CN when requested language is missing', async () => {
    const i18n = (await import('../src/i18n')).default
    const fb = i18n.options.fallbackLng
    const list = Array.isArray(fb) ? fb : [fb]
    expect(list).toContain('zh-CN')
  })

  it('changeLanguage persists to localStorage under lumina_lang', async () => {
    const i18n = (await import('../src/i18n')).default
    await i18n.changeLanguage('en-US')
    expect((globalThis as any).localStorage.getItem('lumina_lang')).toBe('en-US')
    await i18n.changeLanguage('zh-CN')
    expect((globalThis as any).localStorage.getItem('lumina_lang')).toBe('zh-CN')
  })

  it('normalizes short codes: en -> en-US, zh -> zh-CN', async () => {
    const i18n = (await import('../src/i18n')).default
    await i18n.changeLanguage('en')
    expect(i18n.language).toBe('en-US')
    await i18n.changeLanguage('zh')
    expect(i18n.language).toBe('zh-CN')
  })
})
