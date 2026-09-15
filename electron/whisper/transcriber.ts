/**
 * Whisper ONNX 推理封装
 *
 * 基于 @xenova/transformers —— 内部使用 ONNX Runtime (onnxruntime-node)
 * 进行本地 Whisper 推理，无需 GPU，无需联网（模型首次运行时自动下载缓存）。
 *
 * 使用模型: Xenova/whisper-tiny.en (约 150MB，缓存到 ~/.cache/huggingface)
 * 或 Xenova/whisper-base (约 290MB，支持中文等多语种)
 *
 * 安装: npm install @xenova/transformers
 */

import { readFileSync, existsSync } from 'fs'
import { extname, join } from 'path'
import { tmpdir } from 'os'
import { promisify } from 'util'
import { exec } from 'child_process'

const execAsync = promisify(exec)

export interface TranscribeOptions {
  /** 模型名称，默认 'Xenova/whisper-tiny.en' */
  modelName?: string
  /** 语言（可选，如 'zh' 'en'） */
  language?: string
  /** 是否强制重新下模型 */
  forceReDownload?: boolean
}

export interface TranscribeResult {
  text: string
  /** 各段落（含时间戳） */
  chunks?: Array<{ start: number; end: number; text: string }>
  duration: number
}

/**
 * Whisper transcriber 单例
 *
 * 首次调用 initialize() 时下载模型，后续复用。
 * modelName 支持:
 *   - Xenova/whisper-tiny.en (英文，快，~150MB)
 *   - Xenova/whisper-base    (多语种，~290MB)
 *   - Xenova/whisper-small   (~460MB)
 *   - Xenova/whisper-medium  (~1.5GB)
 */
export class WhisperTranscriber {
  private static instance: WhisperTranscriber | null = null
  private pipeline: any = null
  private modelName: string = 'Xenova/whisper-tiny.en'
  private initialized: boolean = false

  static getInstance(): WhisperTranscriber {
    if (!WhisperTranscriber.instance) {
      WhisperTranscriber.instance = new WhisperTranscriber()
    }
    return WhisperTranscriber.instance
  }

  /**
   * 初始化模型（首次调用自动下载）
   */
  async initialize(options: TranscribeOptions = {}): Promise<void> {
    if (this.initialized && !options.forceReDownload) return

    this.modelName = options.modelName || 'Xenova/whisper-tiny.en'

    try {
      // 动态导入 @xenova/transformers（可选依赖）
      const { pipeline } = await import('@xenova/transformers' as any)

      this.pipeline = await pipeline('automatic-speech-recognition', this.modelName, {
        quantized: true, // 使用 int8 量化，更快更省内存
      })

      this.initialized = true
      console.log(`[Whisper] 模型加载完成: ${this.modelName}`)
    } catch (err: any) {
      throw new Error(
        `Whisper 模型加载失败: ${err.message}\n` +
        `请确认已安装: npm install @xenova/transformers\n` +
        `或使用已有音频文件 + 外部工具方案。`,
      )
    }
  }

  /**
   * 转录音频文件
   *
   * @param audioPath - 音频文件路径（支持 WAV/MP3/OGG/FLAC/M4A）
   * @param options  - 转录参数
   */
  async transcribe(
    audioPath: string,
    options: TranscribeOptions = {},
  ): Promise<TranscribeResult> {
    if (!existsSync(audioPath)) {
      throw new Error(`音频文件不存在: ${audioPath}`)
    }

    await this.initialize(options)

    const pipelineOpts: any = {
      return_timestamps: 'chunk',
    }

    if (options.language) {
      // whisper-tiny.en 只支持英文，其他模型可指定语言
      pipelineOpts.forced_decoder_ids = null
      // @ts-ignore
      pipelineOpts.language = options.language
    }

    try {
      const result = await this.pipeline(audioPath, pipelineOpts)

      const text = result?.text?.trim() || ''
      const chunks = result?.chunks?.map((c: any) => ({
        start: c.timestamp?.[0] ?? 0,
        end: c.timestamp?.[1] ?? 0,
        text: c.text?.trim() || '',
      })) || []

      return {
        text,
        chunks: chunks.length > 0 ? chunks : undefined,
        duration: chunks.length
          ? Math.max(...chunks.map((c: any) => c.end))
          : 0,
      }
    } catch (err: any) {
      throw new Error(`转录失败: ${err.message}`)
    }
  }

  /**
   * 检查是否已初始化
   */
  isReady(): boolean {
    return this.initialized
  }

  /**
   * 获取已加载的模型名
   */
  getModelName(): string {
    return this.modelName
  }

  /**
   * 释放模型（释放内存）
   */
  async dispose(): Promise<void> {
    this.pipeline = null
    this.initialized = false
    WhisperTranscriber.instance = null
  }
}

/**
 * 快速转录函数（对已有音频文件）
 */
export async function transcribeAudio(
  audioPath: string,
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const transcriber = WhisperTranscriber.getInstance()
  return transcriber.transcribe(audioPath, options)
}
