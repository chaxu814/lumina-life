// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
/**
 * 语音工具 — whisper.ts
 *
 * 向 Agent 暴露语音相关工具：
 *   - voice_transcribe  — 转录已有音频文件
 *   - voice_record      — 录音 + 转写（一键）
 *   - voice_status      — 检查语音能力
 */

import type { ToolDef } from '../types'
import { existsSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

// ─── voice_transcribe ─────────────────────────────────────────────
/**
 * 转录一个已有的音频文件为文字
 */
export const toolVoiceTranscribe: ToolDef = {
  name: 'voice_transcribe',
  description: '将音频文件（WAV/MP3/OGG/M4A）转录为文字。使用本地 Whisper ONNX 模型。',
  category: 'voice',
  toolsets: ['voice'],
  parameters: {
    type: 'object',
    properties: {
      audioPath: {
        type: 'string',
        description: '音频文件路径（支持 WAV / MP3 / OGG / FLAC / M4A）',
      },
      language: {
        type: 'string',
        description: '语言（可选，如 zh / en）。默认 zh，使用多语种模型；whisper-tiny.en 仅支持英文',
        enum: ['zh', 'en', 'ja', 'fr', 'de', 'auto'],
      },
      modelName: {
        type: 'string',
        description:
          'Whisper 模型（可选）。默认多语种 Xenova/whisper-base（支持中文，约 290MB，首次下载）；tiny.en 仅英文',
        enum: [
          'Xenova/whisper-base',
          'Xenova/whisper-small',
          'Xenova/whisper-tiny.en',
        ],
        default: 'Xenova/whisper-base',
      },
    },
    required: ['audioPath'],
  },
  handler: async (args: { audioPath: string; language?: string; modelName?: string }) => {
    const { transcribeAudio } = await import('../../whisper')

    if (!existsSync(args.audioPath)) {
      return {
        success: false,
        error: `文件不存在: ${args.audioPath}`,
      }
    }

    const stat = statSync(args.audioPath)
    if (stat.size === 0) {
      return { success: false, error: '文件为空' }
    }

    try {
      const result = await transcribeAudio(args.audioPath, {
        language: args.language === 'auto' ? 'zh' : (args.language || 'zh'),
        modelName: args.modelName || 'Xenova/whisper-base',
      })

      return {
        success: true,
        text: result.text,
        // 如果不需要时间戳可以只返回 text，这里也带上 chunks 供参考
        segments: result.chunks?.length
          ? result.chunks.map((c, i) => `[${c.start.toFixed(1)}s-${c.end.toFixed(1)}s] ${c.text}`).join('\n')
          : undefined,
        duration: result.duration.toFixed(1) + 's',
        model: args.modelName || 'Xenova/whisper-base',
      }
    } catch (err: any) {
      return {
        success: false,
        error: `转录失败: ${err.message}`,
        hint: '确认已安装依赖: npm install @xenova/transformers。或临时使用外部 API 替代。',
      }
    }
  },
}

// ─── voice_record ────────────────────────────────────────────────
/**
 * 录音 + 转写
 */
export const toolVoiceRecord: ToolDef = {
  name: 'voice_record',
  description: '从麦克风录音（需 sox 或 ffmpeg），自动进行 Whisper 语音识别。',
  category: 'voice',
  toolsets: ['voice'],
  parameters: {
    type: 'object',
    properties: {
      duration: {
        type: 'number',
        description: '录音时长（秒），默认 5 秒，建议 3-15 秒',
        default: 5,
      },
      language: {
        type: 'string',
        description: '语言（可选）',
        enum: ['zh', 'en', 'auto'],
      },
      modelName: {
        type: 'string',
        description: 'Whisper 模型名（默认多语种 base，支持中文）',
        default: 'Xenova/whisper-base',
      },
    },
  },
  handler: async (args: { duration?: number; language?: string; modelName?: string }) => {
    const { voiceRecordAndTranscribe } = await import('../../whisper')

    const duration = Math.min(Math.max(args.duration || 5, 1), 30) // 1-30 秒

    try {
      const result = await voiceRecordAndTranscribe(duration, args.modelName)
      return {
        success: true,
        text: result.text,
        audioPath: result.audioPath,
        duration: `${duration}s`,
        tips: result.text
          ? undefined
          : '录音成功但未识别到语音内容，可重试或调整麦克风。',
      }
    } catch (err: any) {
      return {
        success: false,
        error: `录音/转录失败: ${err.message}`,
        hint: '需要安装 sox (https://sourceforge.net/projects/sox/) 或 ffmpeg。',
      }
    }
  },
}

// ─── voice_status ────────────────────────────────────────────────
/**
 * 检查语音能力状态
 */
export const toolVoiceStatus: ToolDef = {
  name: 'voice_status',
  description: '检查语音模块的能力状态（录音工具、Whisper 模型是否就绪）',
  category: 'voice',
  toolsets: ['voice'],
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    const { checkRecordingCapability } = await import('../../whisper')

    try {
      const cap = await checkRecordingCapability()
      return {
        success: true,
        ...cap,
        recommendations: cap.available
          ? '语音系统就绪'
          : '请安装 sox 或 ffmpeg 以启用录音功能',
        whisperModel: cap.whisperModelLoaded
          ? 'Whisper 模型已加载'
          : 'Whisper 模型未加载（首次转录时会自动下载）',
      }
    } catch (err: any) {
      return {
        success: false,
        error: `检查失败: ${err.message}`,
      }
    }
  },
}

// ─── voice_speak ─────────────────────────────────────────────────
/**
 * 文字转语音（TTS）
 * Phase 3: 轻量媒体生成基础版
 */
export const toolVoiceSpeak: ToolDef = {
  name: 'voice_speak',
  description: '将文字转换为语音（使用 OpenAI TTS 或系统 TTS）。需要配置 API Key。',
  category: 'voice',
  toolsets: ['voice', 'media'],
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '要转换的文字内容',
      },
      voice: {
        type: 'string',
        description: '语音模型 (alloy / echo / fable / onyx / nova / shimmer)',
        default: 'alloy',
        enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
      },
      speed: {
        type: 'number',
        description: '语速 (0.25 - 4.0)',
        default: 1.0,
      },
    },
    required: ['text'],
  },
  handler: async (args: { text: string; voice?: string; speed?: number }) => {
    const { text, voice = 'alloy', speed = 1.0 } = args

    // 从配置获取 API Key
    const configPath = join(process.env.APPDATA || '', 'lumina', 'lumina-config.json')
    let apiKey = ''
    try {
      const config = JSON.parse(require('fs').readFileSync(configPath, 'utf-8'))
      apiKey = config.openai?.apiKey || ''
    } catch {
      apiKey = process.env.OPENAI_API_KEY || ''
    }

    if (!apiKey) {
      return {
        success: false,
        error: '未配置 OpenAI API Key。请在设置中配置，或设置环境变量 OPENAI_API_KEY。',
      }
    }

    try {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: text,
          voice,
          speed,
        }),
      })

      if (!response.ok) {
        const error = await response.text()
        return { success: false, error: `TTS 请求失败: ${error}` }
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      const saveDir = join(process.env.USERPROFILE || '', 'Desktop', 'lumina_audio')
      mkdirSync(saveDir, { recursive: true })
      const savePath = join(saveDir, `lumina_speech_${Date.now()}.mp3`)
      writeFileSync(savePath, buffer)

      return {
        success: true,
        audioPath: savePath,
        message: `✅ 语音已生成: ${savePath}`,
      }
    } catch (err: any) {
      return { success: false, error: `语音合成失败: ${err.message}` }
    }
  },
}
