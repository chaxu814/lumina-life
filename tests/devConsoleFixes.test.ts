// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// devConsoleFixes.test.ts — dev 控制台报错修复的回归守卫
//
// 【来源】2026-10-10 用户贴出的 dev 控制台日志（截图），逐条排查后修了 5 项：
//   ① Failed to serialize arguments（成就事件）—— 见 gamificationIpcSerialization.test.ts
//   ② [ScreenVision] 视觉理解失败: 'response_format.type' must be 'json_schema' or 'text'
//   ③ [LLMProvider] ⚡社交 标准模型 超时:0s   ← 看起来像「没有超时保护」
//   ④ DeprecationWarning: getBitmap() is deprecated, use toBitmap()
//   ⑤ proactiveLLM 的同类 response_format 隐患
//
// 本文件守住 ②③④⑤（① 有真行为测试，单独一个文件）。
// ============================================================

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')

/**
 * 去掉注释后的源码。
 * 修复时会在注释里**引用被删掉的旧代码**（便于后来者理解为什么改），
 * 断言「旧代码已不存在」时必须只扫代码，否则会被自己的注释击穿。
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++
      while (i < n) {
        out += src[i]
        if (src[i] === '\\') { out += src[i + 1] ?? ''; i += 2; continue }
        if (src[i] === q) { i++; break }
        i++
      }
      continue
    }
    out += c; i++
  }
  return out
}
const readCode = (rel: string) => stripComments(read(rel))

describe('② 视觉调用：response_format 不被支持时降级重试', () => {
  const src = read('electron/tools/impl/cuCore.ts')

  it('请求体抽出成 doRequest，便于换 body 重试', () => {
    expect(src).toMatch(/const doRequest = \(bodyStr: string\): Promise<string> =>/)
  })

  it('仅在「明确因 response_format 被拒」时去掉该字段重试', () => {
    // 若回退：LM Studio 会 400 `'response_format.type' must be 'json_schema' or 'text'`
    //         → 视觉理解 100% 失败（截图白拍）
    expect(src).toMatch(/if \(jsonMode && \/response_format\|json_schema\|json_object\/i\.test\(msg\)\)/)
    expect(src).toMatch(/delete retryBodyObj\.response_format/)
    expect(src).toMatch(/return doRequest\(JSON\.stringify\(retryBodyObj\)\)/)
  })

  it('首次请求仍然带上 response_format（支持严格模式的端点行为不变）', () => {
    expect(src).toMatch(/if \(jsonMode\) \{bodyObj\.response_format = \{ type: 'json_object' \}\}/)
  })
})

describe('③ LLMProvider：超时不再显示 0s，且与 AgentRunner 统一', () => {
  const src = read('electron/core/llmProvider.ts')

  it('不再用 falsy 的 0 当哨兵', () => {
    // 若回退：日志打印 `超时:0s`，看起来像「没有任何超时保护」
    expect(readCode('electron/core/llmProvider.ts')).not.toMatch(/isSocialMode \? 0 :/)
  })

  it('社交模式与 AgentRunner 用同一量级（12h），普通模式有 30min 兜底', () => {
    expect(src).toMatch(/SOCIAL_MODE_TIMEOUT_SEC = 12 \* 3600/)
    expect(src).toMatch(/DEFAULT_TIMEOUT_SEC = 1800/)
    expect(src).toMatch(/const httpTimeoutSeconds = isSocialMode\s*\n\s*\? SOCIAL_MODE_TIMEOUT_SEC/)
  })

  it('effectiveTimeout 直接用 httpTimeoutSeconds（恒为正）', () => {
    expect(src).toMatch(/const effectiveTimeout = httpTimeoutSeconds \* 1000/)
    expect(src).not.toMatch(/httpTimeoutSeconds > 0 \? httpTimeoutSeconds \* 1000 : 1_800_000/)
  })

  it('per-chunk 看门狗仍在（总超时放长也不会挂死）', () => {
    expect(src).toMatch(/FIRST_TOKEN_TIMEOUT = 120_000/)
    expect(src).toMatch(/STREAM_IDLE_TIMEOUT = 60_000/)
  })
})

describe('④ getBitmap() 弃用警告已消除', () => {
  const files = ['electron/pet/lifeServices.ts', 'electron/tools/impl/cuVerify.ts']

  for (const f of files) {
    it(`${f} 改用 toBitmap()`, () => {
      const code = read(f).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
      expect(code, `${f} 仍在调用已废弃的 getBitmap()`).not.toMatch(/\.getBitmap\(\)/)
      expect(code).toMatch(/\.toBitmap\(\)/)
    })
  }
})

describe('⑤ proactiveLLM：同类 response_format 隐患一并修掉', () => {
  const src = read('electron/proactive/resolveProactiveLLM.ts')

  it('抽出 sendOnce 并支持降级重试', () => {
    expect(src).toMatch(/const sendOnce = \(bodyStr: string\)/)
    expect(src).toMatch(/delete retryBodyObj\.response_format/)
  })

  it('降级只针对 response_format 类错误，其它错误照旧返回空串（不改变既有容错语义）', () => {
    expect(src).toMatch(/if \(\/response_format\|json_schema\|json_object\/i\.test\(first\.error\)\)/)
    expect(src).toMatch(/return ''/)
  })
})
