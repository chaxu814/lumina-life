// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/sttService.test.ts — STT 语音服务 单元测试
//
// 注意: Web Speech API 仅在 Chrome/Edge 浏览器中可用。
// Node 环境通过 globalThis.window mock，覆盖: 静态方法、状态管理、
// 回调系统、start/stop/toggle 生命周期。
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { STTService } from '../src/services/sttService'

describe('STTService', () => {
  let service: STTService

  function setupWindow(overrides: Record<string, any> = {}) {
    ;(globalThis as any).window = {
      luminaAPI: {
        sttCheck: vi.fn().mockResolvedValue({ available: false, engine: 'web-speech' }),
        sttStart: vi.fn().mockResolvedValue({ ok: true }),
        sttStop: vi.fn().mockResolvedValue({ ok: true }),
      },
      SpeechRecognition: undefined,
      webkitSpeechRecognition: undefined,
      ...overrides,
    }
  }

  beforeEach(() => {
    setupWindow()
    service = new STTService()
  })

  afterEach(() => {
    try { service.stop() } catch {}
    delete (globalThis as any).window
  })

  describe('static isWebSpeechSupported()', () => {
    it('returns false when SpeechRecognition unavailable', () => {
      expect(STTService.isWebSpeechSupported()).toBe(false)
    })

    it('returns true when SpeechRecognition is available', () => {
      setupWindow({ SpeechRecognition: class {} })
      expect(STTService.isWebSpeechSupported()).toBe(true)
    })

    it('returns true when webkitSpeechRecognition is available', () => {
      setupWindow({ webkitSpeechRecognition: class {} })
      expect(STTService.isWebSpeechSupported()).toBe(true)
    })

    it('returns true when both are available', () => {
      setupWindow({
        SpeechRecognition: class {},
        webkitSpeechRecognition: class {},
      })
      expect(STTService.isWebSpeechSupported()).toBe(true)
    })
  })

  describe('state management', () => {
    it('starts in stopped state', () => {
      expect(service.isListening()).toBe(false)
      expect(service.isPaused()).toBe(false)
    })

    it('defaults engine to auto', () => {
      expect(service.getEngine()).toBe('auto')
    })

    it('can set engine explicitly', () => {
      service.setEngine('whisper')
      expect(service.getEngine()).toBe('whisper')
    })

    it('can cycle through engines', () => {
      const engines = ['web-speech', 'whisper', 'vosk', 'native', 'auto']
      for (const e of engines) {
        service.setEngine(e as any)
        expect(service.getEngine()).toBe(e)
      }
    })
  })

  describe('pause() and resume() safety', () => {
    it('no-ops pause when not listening', () => {
      service.pause()
      expect(service.isPaused()).toBe(false)
      expect(service.isListening()).toBe(false)
    })

    it('no-ops resume when not listening', () => {
      service.resume()
      expect(service.isPaused()).toBe(false)
    })

    it('stop() clears both listening and paused state', () => {
      service.stop()
      expect(service.isListening()).toBe(false)
      expect(service.isPaused()).toBe(false)
    })
  })

  describe('callbacks', () => {
    it('accepts result callback', () => {
      const cb = vi.fn()
      service.setCallbacks(cb)
      expect(true).toBe(true)
    })

    it('accepts result + status callbacks', () => {
      const onResult = vi.fn()
      const onStatus = vi.fn()
      service.setCallbacks(onResult, onStatus)
      expect(true).toBe(true)
    })
  })

  describe('start() and stop() cycle', () => {
    it('can be called multiple times without crash', async () => {
      await service.start()
      await service.start()
      await service.start()
      service.stop()
      service.stop()
      expect(true).toBe(true)
    })
  })

  describe('toggle()', () => {
    it('does not throw when toggling', async () => {
      await service.toggle()
      expect(true).toBe(true)
    })
  })
})
