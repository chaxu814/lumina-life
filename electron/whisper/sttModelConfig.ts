// ============================================================
// whisper/sttModelConfig.ts — 本地离线语音识别（STT）模型配置
//
// 关键决策（对应体检报告 P0「中文离线 STT」）：
//   • 默认模型从只识英文的 Xenova/whisper-tiny.en（~150MB）改为多语种
//     Xenova/whisper-base（~290MB，支持中文），中文链路强制 language=zh。
//   • 模型缓存放进应用 userData（卸载可清、跨平台一致），而不是全局 ~/.cache。
//   • 中国大陆首次下载模型默认走 hf-mirror.com 镜像，避免 huggingface.co 不通；
//     可用环境变量 HF_ENDPOINT 覆盖。
//
// 模型仅在首次使用语音时下载一次（约 290MB），之后完全离线，不依赖联网 Web Speech。
// ============================================================

import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

/** 多语种模型（支持中文）；英文 tiny.en 永远不作为中文/默认选择 */
export const DEFAULT_WHISPER_MODEL = 'Xenova/whisper-base'
/** 仅英文、更快更小，仅在用户明确选英文时可选 */
export const ENGLISH_TINY_MODEL = 'Xenova/whisper-tiny.en'

export interface ModelResolveOptions {
  model?: string
  language?: string
}

/**
 * 选定 STT 模型：用户显式指定优先；中文（默认）用多语种 base；
 * 任何带 zh 的语言都绝不允许回落到 tiny.en（它只识英文）。
 */
export function resolveSttModel(opts: ModelResolveOptions = {}): string {
  if (opts.model && opts.model.trim()) {return opts.model.trim()}
  // 默认产品面向中文：统一用多语种 base（可识别中文/英文）；
  // tiny.en 仅英文，任何中文链路都绝不能回落到它。
  return DEFAULT_WHISPER_MODEL
}

/**
 * 返回模型缓存目录（userData/models/xenova）。
 */
export function sttCacheDir(): string {
  try {
    return path.join(app.getPath('userData'), 'models', 'xenova')
  } catch {
    // app 未就绪时的兜底
    return path.join(process.cwd(), 'models', 'xenova')
  }
}

/**
 * 配置 @xenova/transformers 的 env：缓存目录 + 国内镜像。
 * 在创建 pipeline 前调用。返回配置后的 env（拿不到依赖时返回 null）。
 */
export function configureTransformersEnv(): any | null {
  let env: any = null
  try {
    // 显式 require 到运行时 env 单例（ESM 互操作）
    const mod = require('@xenova/transformers')
    env = mod.env || mod.default?.env
  } catch {
    return null
  }
  if (!env) {return null}
  try {
    const dir = sttCacheDir()
    fs.mkdirSync(dir, { recursive: true })
    env.cacheDir = dir
    env.localModelPath = dir
    // 模型文件下载主机：默认国内镜像，用户显式 HF_ENDPOINT 时尊重之
    if (!process.env.HF_ENDPOINT && !process.env.HF_MIRROR) {
      env.remoteHost = 'https://hf-mirror.com'
    } else if (process.env.HF_ENDPOINT) {
      env.remoteHost = process.env.HF_ENDPOINT
    }
    // 允许从本地网络代理（若设置了）
    env.allowLocalModels = true
  } catch (e) {
    console.warn('[STT] configureTransformersEnv 失败:', (e as Error)?.message)
  }
  return env
}
