// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// modelCapabilityCache.ts — 模型能力缓存 (v3.5)
//
// 借鉴 QwenPaw ModelCapabilityCache:
//   持久化记录每个模型的能力（function calling、图片支持、上下文长度等）
//   避免每次启动反复探测，支持配置热重载
// ============================================================

import * as fs from 'fs'
import * as path from 'path'

export interface ModelCapability {
  modelName: string
  /** 是否支持 function calling / tools */
  supportsTools: boolean
  /** 是否支持多模态 */
  supportsVision: boolean
  /** 最大上下文长度 (tokens) */
  maxContextTokens: number
  /** 检测时间 */
  lastChecked: string
  /** 模型参数大小 (B) */
  paramSize?: number
  /** 推荐超时 (秒) */
  recommendedTimeout: number
  /** 是否正常运行过 */
  hasWorkedBefore: boolean
  /** 错误计数 */
  errorCount: number
}

interface CapabilityStore {
  version: number
  updatedAt: string
  models: Record<string, ModelCapability>
}

export class ModelCapabilityCache {
  private store: CapabilityStore
  private cachePath: string
  private static _instance: ModelCapabilityCache | null = null

  private constructor(workingDir: string) {
    this.cachePath = path.join(workingDir, '.cache', 'model_capabilities.json')
    this.store = this._load()
  }

  static getInstance(workingDir?: string): ModelCapabilityCache {
    if (!this._instance && workingDir) {
      this._instance = new ModelCapabilityCache(workingDir)
    }
    if (!this._instance) {
      // fallback
      this._instance = new ModelCapabilityCache(process.cwd())
    }
    return this._instance
  }

  static resetInstance(): void {
    this._instance = null
  }

  /** 获取模型能力 */
  get(modelName: string): ModelCapability | undefined {
    const key = this._normalizeName(modelName)
    return this.store.models[key]
  }

  /** 更新模型能力 */
  update(modelName: string, partial: Partial<ModelCapability>): void {
    const key = this._normalizeName(modelName)
    const existing = this.store.models[key] || this._defaultCapability(modelName)
    this.store.models[key] = {
      ...existing,
      ...partial,
      modelName: partial.modelName || existing.modelName,
      lastChecked: new Date().toISOString(),
    }
    this._save()
  }

  /** 记录成功运行 */
  recordSuccess(modelName: string): void {
    const key = this._normalizeName(modelName)
    const existing = this.store.models[key] || this._defaultCapability(modelName)
    this.store.models[key] = {
      ...existing,
      hasWorkedBefore: true,
      errorCount: 0,
      lastChecked: new Date().toISOString(),
    }
    this._save()
  }

  /** 记录失败 */
  recordFailure(modelName: string): void {
    const key = this._normalizeName(modelName)
    const existing = this.store.models[key] || this._defaultCapability(modelName)
    this.store.models[key] = {
      ...existing,
      errorCount: existing.errorCount + 1,
      lastChecked: new Date().toISOString(),
    }
    this._save()
  }

  /** 标记模型不支持 tools */
  markNoToolSupport(modelName: string): void {
    this.update(modelName, { supportsTools: false })
  }

  /** 从模型名称推断参数大小 */
  inferParamSize(modelName: string): number {
    const match = modelName.match(/(\d+)B/i)
    return match ? parseInt(match[1], 10) : 7
  }

  /** 推荐超时 */
  recommendTimeout(modelName: string, estTokens: number): number {
    const params = this.inferParamSize(modelName)
    const base = params <= 14 ? 180 : params <= 40 ? 300 : 600
    const tokenFactor = Math.min(estTokens / 16000, 3.0)
    return Math.ceil(base * tokenFactor)
  }

  /** 列出所有缓存 */
  listAll(): ModelCapability[] {
    return Object.values(this.store.models)
  }

  /** 清除所有缓存 */
  clear(): void {
    this.store.models = {}
    this._save()
  }

  // ═══════════════════════════════════════════
  // 内部
  // ═══════════════════════════════════════════

  private _normalizeName(name: string): string {
    // 规范化模型名称（去掉路径分隔符）
    return name.replace(/[\\/:]/g, '_').slice(0, 120)
  }

  private _defaultCapability(modelName: string): ModelCapability {
    return {
      modelName,
      supportsTools: true,   // 默认乐观
      supportsVision: false,
      maxContextTokens: 256_000,
      paramSize: this.inferParamSize(modelName),
      lastChecked: new Date().toISOString(),
      recommendedTimeout: 300,
      hasWorkedBefore: false,
      errorCount: 0,
    }
  }

  private _load(): CapabilityStore {
    try {
      const dir = path.dirname(this.cachePath)
      if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
      if (fs.existsSync(this.cachePath)) {
        const raw = fs.readFileSync(this.cachePath, 'utf-8')
        return JSON.parse(raw)
      }
    } catch (err: any) {
      console.warn('[ModelCache] 加载缓存失败:', err.message)
    }
    return { version: 1, updatedAt: new Date().toISOString(), models: {} }
  }

  private _save(): void {
    try {
      this.store.updatedAt = new Date().toISOString()
      const dir = path.dirname(this.cachePath)
      if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
      fs.writeFileSync(this.cachePath, JSON.stringify(this.store, null, 2), 'utf-8')
    } catch (err: any) {
      console.warn('[ModelCache] 保存缓存失败:', err.message)
    }
  }
}

/** 便捷获取 */
export function getModelCapabilityCache(workingDir?: string): ModelCapabilityCache {
  return ModelCapabilityCache.getInstance(workingDir)
}
