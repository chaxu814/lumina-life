// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
/**
 * Whisper 语音模块 — 对外统一接口
 *
 * 提供语音转文字能力：
 *   - voiceTranscribe(audioPath) — 转录已有音频文件
 *   - voiceRecord(durationSec) — 麦克风录音 + 转录（一键）
 *
 * 依赖：
 *   - @xenova/transformers (ONNX Runtime)
 *   - sox 或 ffmpeg（录音用）
 */

export { WhisperTranscriber, transcribeAudio } from './transcriber'
export type { TranscribeOptions, TranscribeResult } from './transcriber'
export { recordAudio } from './recorder'
export type { RecordingOptions, RecordingResult } from './recorder'
import { DEFAULT_WHISPER_MODEL } from './sttModelConfig'

/**
 * 录制并转录（一键语音输入）
 * 录音 → WAV → Whisper ONNX → 文本
 */
export async function voiceRecordAndTranscribe(
  duration: number = 5,
  modelName?: string,
  language: string = 'zh',
): Promise<{ text: string; audioPath: string }> {
  const { recordAudio } = await import('./recorder')
  const { transcribeAudio } = await import('./transcriber')

  const recording = await recordAudio({ duration })
  const result = await transcribeAudio(recording.filePath, {
    modelName: modelName || DEFAULT_WHISPER_MODEL,
    language,
  })

  return { text: result.text, audioPath: recording.filePath }
}

/**
 * 检查环境是否支持录音（有哪些录音工具）
 */
export async function checkRecordingCapability(): Promise<{
  available: boolean
  tools: string[]
  whisperModelLoaded: boolean
}> {
  const tools: string[] = []

  // 检查录音工具
  const { execSync } = await import('child_process')
  for (const [cmd, name] of [
    ['sox --version', 'sox'],
    ['ffmpeg -version', 'ffmpeg'],
  ] as const) {
    try {
      execSync(cmd, { stdio: 'pipe' })
      tools.push(name)
    } catch {
      // not found
    }
  }

  // 检查 whisper 模型状态
  const transcriber = (await import('./transcriber')).WhisperTranscriber.getInstance()

  return {
    available: tools.length > 0,
    tools,
    whisperModelLoaded: transcriber.isReady(),
  }
}
