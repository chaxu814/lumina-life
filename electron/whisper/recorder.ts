// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
/**
 * 麦克风录音模块
 *
 * 使用 Node.js 的 child_process + sox/ffmpeg 或内置 mic 库录音。
 * 降级策略：
 *   1. 优先尝试 `sox`（若系统有）
 *   2. 其次尝试 `ffmpeg`
 *   3. 最后抛错提示安装
 */

import { spawn } from 'child_process'
import { createWriteStream, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

export interface RecordingOptions {
  /** 录音时长（秒），默认 5 */
  duration?: number
  /** 采样率，默认 16000 */
  sampleRate?: number
  /** 输出路径，默认系统临时目录 */
  outputPath?: string
}

export interface RecordingResult {
  /** WAV 文件路径 */
  filePath: string
  /** 时长（秒） */
  duration: number
  /** 文件大小（字节） */
  size: number
}

/**
 * 检测系统是否有可用的录音工具
 */
async function detectRecorder(): Promise<'sox' | 'ffmpeg' | null> {
  try {
    const { execSync } = await import('child_process')
    execSync('sox --version', { stdio: 'pipe' })
    return 'sox'
  } catch {
    // fall through
  }
  try {
    const { execSync } = await import('child_process')
    execSync('ffmpeg -version', { stdio: 'pipe' })
    return 'ffmpeg'
  } catch {
    return null
  }
}

/**
 * 使用 sox 录音（Windows 上需安装 sox）
 */
function recordWithSox(
  outputFile: string,
  duration: number,
  sampleRate: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // sox: rec 默认从麦克风录制 -r 16000 -b 16 -c 1 output.wav trim 0 5
    const args = [
      '-b', '16',
      '-c', '1',
      '-r', String(sampleRate),
      outputFile,
      'trim', '0', String(duration),
    ]
    const proc = spawn('rec', args, { stdio: 'pipe' })

    // 部分 Windows 上 rec 可能叫 sox rec，试捕获 stderr 超时判断
    const timer = setTimeout(() => {
      proc.kill()
      resolve() // 超时视为录音完成（sox 会自己结束）
    }, (duration + 2) * 1000)

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 || code === null) {resolve()}
      else {reject(new Error(`sox rec 退出码 ${code}`))}
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * 使用 ffmpeg 录音
 */
function recordWithFfmpeg(
  outputFile: string,
  duration: number,
  sampleRate: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'dshow',                // Windows DirectShow
      '-i', 'audio=Microphone',     // 默认麦克风
      '-ar', String(sampleRate),
      '-ac', '1',
      '-sample_fmt', 's16',
      '-t', String(duration),
      '-y',
      outputFile,
    ]
    const proc = spawn('ffmpeg', args, { stdio: 'pipe' })
    proc.on('close', (code) => {
      if (code === 0) {resolve()}
      else {reject(new Error(`ffmpeg 退出码 ${code}`))}
    })
    proc.on('error', (err) => reject(err))
  })
}

/**
 * 从麦克风录制一段音频，返回 WAV 文件路径
 */
export async function recordAudio(
  options: RecordingOptions = {},
): Promise<RecordingResult> {
  const {
    duration = 5,
    sampleRate = 16000,
    outputPath = tmpdir(),
  } = options

  const filePath = join(outputPath, `lumina_mic_${randomUUID()}.wav`)

  const recorder = await detectRecorder()
  if (!recorder) {
    throw new Error(
      '找不到录音工具。请安装 sox (https://sourceforge.net/projects/sox/) 或 ffmpeg。\n' +
      '或手动录制后使用 voice_transcribe 工具识别已有音频。',
    )
  }

  if (recorder === 'sox') {
    await recordWithSox(filePath, duration, sampleRate)
  } else {
    await recordWithFfmpeg(filePath, duration, sampleRate)
  }

  // 检查文件
  const { statSync } = await import('fs')
  const stat = statSync(filePath)
  if (stat.size === 0) {
    unlinkSync(filePath)
    throw new Error('录音文件为空，可能未检测到麦克风输入')
  }

  return { filePath, duration, size: stat.size }
}
