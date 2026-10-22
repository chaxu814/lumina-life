// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// configWatcher.ts — 配置热重载 (v3.5)
//
// 借鉴 QwenPaw config reload:
//   使用 fs.watch 监听配置文件变更
//   自动重新加载 LLM 配置、团队配置、技能配置
//   无需重启应用
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { EventEmitter } from 'events'

export interface ConfigChangeEvent {
  file: string
  type: 'llm' | 'team' | 'skills' | 'hooks' | 'env'
  timestamp: string
  oldValue?: any
  newValue?: any
}

export class ConfigWatcher extends EventEmitter {
  private watchers: fs.FSWatcher[] = []
  private debounceTimers = new Map<string, NodeJS.Timeout>()
  private configDir: string
  private workingDir: string

  constructor(workingDir: string) {
    super()
    this.workingDir = workingDir
    this.configDir = path.join(workingDir, 'electron')
  }

  /** 开始监听 */
  startWatch(): void {
    this.stopWatch() // 先停止旧的

    // 监听 .env 文件
    const envPath = path.join(this.workingDir, '.env')
    if (fs.existsSync(envPath)) {
      this._watchFile(envPath, 'env')
    }

    // 监听 .md 核心配置文件（AGENTS.md / SOUL_*.md / PROFILE.md）
    const mdFiles = ['AGENTS.md', 'PROFILE.md']
    for (const mdFile of mdFiles) {
      const mdPath = path.join(this.workingDir, mdFile)
      if (fs.existsSync(mdPath)) {
        this._watchFile(mdPath, 'llm')
      }
    }
    // 监听所有 SOUL_*.md
    try {
      const files = fs.readdirSync(this.workingDir)
      for (const f of files) {
        if (f.startsWith('SOUL_') && f.endsWith('.md')) {
          this._watchFile(path.join(this.workingDir, f), 'llm')
        }
      }
    } catch {}

    // 监听 skills/ 目录（新增/删除 Skill 时热重载）
    const skillsWatchDir = path.join(this.workingDir, 'skills')
    if (fs.existsSync(skillsWatchDir)) {
      this._watchDir(skillsWatchDir, 'skills')
    }

    // 监听 electron/config/*.json
    const configDir = path.join(this.configDir, 'config')
    if (fs.existsSync(configDir)) {
      this._watchDir(configDir, 'skills')
    }
  }

  /** 停止监听 */
  stopWatch(): void {
    for (const w of this.watchers) {
      w.close()
    }
    this.watchers = []
    this.debounceTimers.clear()
  }

  /** 监听单个文件 */
  watchSingle(filePath: string, type: ConfigChangeEvent['type']): void {
    this._watchFile(filePath, type)
  }

  // ═══════════════════════════════════════════════════════
  // 内部
  // ═══════════════════════════════════════════════════════

  private _watchFile(filePath: string, type: ConfigChangeEvent['type']): void {
    const watcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change') {
        this._debounce(filePath, () => {
          this._emitChange(filePath, type)
        })
      }
    })
    this.watchers.push(watcher)
    console.log(`[ConfigWatcher] 👁️ 监听: ${path.basename(filePath)}`)
  }

  private _watchDir(dirPath: string, type: ConfigChangeEvent['type']): void {
    const watcher = fs.watch(dirPath, { recursive: true }, (_event, filename) => {
      if (filename && (filename.endsWith('.json') || filename.endsWith('.yaml') || filename.endsWith('.yml') || filename.endsWith('.md'))) {
        const fullPath = path.join(dirPath, filename)
        this._debounce(fullPath, () => {
          this._emitChange(fullPath, type)
        })
      }
    })
    this.watchers.push(watcher)
    console.log(`[ConfigWatcher] 👁️ 监听目录: ${path.basename(dirPath)}`)
  }

  private _debounce(key: string, fn: () => void): void {
    const existing = this.debounceTimers.get(key)
    if (existing) {clearTimeout(existing)}
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key)
      fn()
    }, 300)) // 300ms debounce
  }

  private _emitChange(filePath: string, type: ConfigChangeEvent['type']): void {
    const event: ConfigChangeEvent = {
      file: filePath,
      type,
      timestamp: new Date().toISOString(),
    }

    console.log(`[ConfigWatcher] 🔄 配置变更: ${path.basename(filePath)} (${type})`)

    // 重新加载 .env
    if (type === 'env') {
      this._reloadDotenv()
    }

    // .md 文件变更 → 清除缓存 + 重载 Skills
    const basename = path.basename(filePath)
    if (basename === 'AGENTS.md' || basename.startsWith('SOUL_') || basename === 'PROFILE.md') {
      try {
        // 清除 systemPrompt.ts 中的 .md 缓存
        const { clearMdCache } = require('./prompts/systemPrompt')
        clearMdCache()
        console.log('[ConfigWatcher] ✅ .md 缓存已清除，下次请求将重新加载')
      } catch (err: any) {
        console.warn('[ConfigWatcher] 清除 .md 缓存失败:', err.message)
      }
    }

    // skills 目录变更 → 重载 DynamicSkillLoader
    if (type === 'skills') {
      try {
        const { getDynamicSkillLoader } = require('./skillLoader')
        getDynamicSkillLoader().reload()
        console.log('[ConfigWatcher] ✅ Skills 已热重载')
      } catch (err: any) {
        console.warn('[ConfigWatcher] Skills 重载失败:', err.message)
      }
    }

    this.emit('change', event)
  }

  private _reloadDotenv(): void {
    try {
      // 清除 require 缓存并重新加载
      const envPath = path.join(this.workingDir, '.env')
      const configResult = require('dotenv').config({ path: envPath, override: true })

      if (configResult.error) {
        console.warn('[ConfigWatcher] .env 重新加载失败:', configResult.error.message)
      } else {
        console.log('[ConfigWatcher] ✅ .env 已热重载')
        this.emit('env-reloaded', configResult.parsed || {})
      }
    } catch (err: any) {
      console.warn('[ConfigWatcher] .env 重载异常:', err.message)
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let _watcher: ConfigWatcher | null = null

export function getConfigWatcher(workingDir?: string): ConfigWatcher {
  if (!_watcher && workingDir) {
    _watcher = new ConfigWatcher(workingDir)
  }
  if (!_watcher) {
    _watcher = new ConfigWatcher(process.cwd())
  }
  return _watcher
}

export function startConfigWatcher(workingDir: string): ConfigWatcher {
  const watcher = getConfigWatcher(workingDir)
  watcher.startWatch()
  return watcher
}

export function stopConfigWatcher(): void {
  _watcher?.stopWatch()
  _watcher = null
}
