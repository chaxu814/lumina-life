// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/sttModelConfig.test.ts — 离线 STT 模型选择（中文默认多语种）
// ============================================================

import { describe, it, expect } from 'vitest'
import { resolveSttModel, DEFAULT_WHISPER_MODEL, ENGLISH_TINY_MODEL } from '../electron/whisper/sttModelConfig'

describe('resolveSttModel 中文离线 STT 默认模型', () => {
  it('默认（无参）→ 多语种 base，支持中文', () => {
    expect(resolveSttModel()).toBe(DEFAULT_WHISPER_MODEL)
    expect(resolveSttModel().includes('base')).toBe(true)
  })

  it('中文（zh / zh-CN）→ 多语种 base，绝不回落 tiny.en', () => {
    expect(resolveSttModel({ language: 'zh' })).toBe(DEFAULT_WHISPER_MODEL)
    expect(resolveSttModel({ language: 'zh-CN' })).toBe(DEFAULT_WHISPER_MODEL)
    expect(resolveSttModel({ language: 'zh' })).not.toBe(ENGLISH_TINY_MODEL)
  })

  it('英文默认也用多语种 base（仍可识别中文）', () => {
    expect(resolveSttModel({ language: 'en' })).toBe(DEFAULT_WHISPER_MODEL)
  })

  it('用户显式指定模型时尊重之（例如更高精度 small）', () => {
    expect(resolveSttModel({ model: 'Xenova/whisper-small', language: 'zh' })).toBe('Xenova/whisper-small')
  })

  it('空字符串模型视为未指定，回退默认', () => {
    expect(resolveSttModel({ model: '   ' })).toBe(DEFAULT_WHISPER_MODEL)
  })
})
