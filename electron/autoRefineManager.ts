// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// autoRefineManager.ts — 自动精炼管理器 (P4-5)
//
// 定时将每日笔记提炼进 MEMORY.md
// 类似 ReMe Light 的自动摘要
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { getAgentMemoryManager, type AgentMemory, type MemoryNote, type AgentMemoryManager } from './agentMemoryManager'
import { getAgentProfileManager } from './agentProfileManager'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface RefineResult {
  agentId: string
  date: string
  extractedCount: number
  summary: string
}

// ═══════════════════════════════════════════════════════════
// AutoRefineManager
// ═══════════════════════════════════════════════════════════

export class AutoRefineManager {
  private _timer?: NodeJS.Timeout
  private _interval: number // ms
  private _enabled: boolean = true

  constructor(intervalHours: number = 24) {
    this._interval = intervalHours * 60 * 60 * 1000
  }

  /** 启动自动精炼 */
  start(): void {
    if (!this._enabled) {return}
    
    console.log('[AutoRefine] 🕐 启动自动精炼，间隔:', this._interval / 1000 / 60 / 60, '小时')
    
    // 立即执行一次
    this.runRefine()
    
    // 定时执行
    this._timer = setInterval(() => {
      this.runRefine()
    }, this._interval)
  }

  /** 停止自动精炼 */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = undefined
    }
  }

  /** 手动触发精炼 */
  async runRefine(): Promise<RefineResult[]> {
    console.log('[AutoRefine] 🔄 开始自动精炼...')
    
    const memoryManager = getAgentMemoryManager()
    const profileManager = getAgentProfileManager()
    const results: RefineResult[] = []

    for (const agentId of Object.keys(profileManager.getAll())) {
      try {
        const result = await this._refineAgent(agentId, memoryManager)
        results.push(result)
      } catch (e) {
        console.warn(`[AutoRefine] ${agentId} 精炼失败:`, e)
      }
    }

    console.log(`[AutoRefine] ✅ 精炼完成，处理 ${results.length} 个 Agent`)
    return results
  }

  // ── 私有方法 ─────────────────────────────────────────

  private async _refineAgent(agentId: string, memoryManager: AgentMemoryManager): Promise<RefineResult> {
    const memory = memoryManager.get(agentId)
    const today = new Date().toISOString().split('T')[0]
    
    // 获取最近 7 天的笔记
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const recentNotes = memoryManager.getNotesInRange(agentId, sevenDaysAgo, today)
    
    if (recentNotes.length === 0) {
      return {
        agentId,
        date: today,
        extractedCount: 0,
        summary: '无新笔记',
      }
    }

    // 提取重要内容（简化版：提取包含特定关键词的笔记）
    const importantKeywords = ['重要', '关键', '决定', '问题', '修复', '完成', '计划', '目标']
    const extracted: string[] = []

    for (const note of recentNotes) {
      const lines = note.content.split('\n')
      for (const line of lines) {
        if (importantKeywords.some(kw => line.includes(kw))) {
          extracted.push(`[${note.date}] ${line.trim()}`)
        }
      }
    }

    // 去重并限制数量
    const uniqueExtracted = Array.from(new Set(extracted)).slice(0, 20)

    if (uniqueExtracted.length > 0) {
      // 更新 MEMORY.md
      memory.longTerm.push(...uniqueExtracted)
      memoryManager.save(agentId, memory)
    }

    return {
      agentId,
      date: today,
      extractedCount: uniqueExtracted.length,
      summary: uniqueExtracted.length > 0 
        ? `提取了 ${uniqueExtracted.length} 条重要记忆`
        : '未发现需要提取的内容',
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: AutoRefineManager | null = null

export function getAutoRefineManager(intervalHours?: number): AutoRefineManager {
  if (!_instance) {
    _instance = new AutoRefineManager(intervalHours)
  }
  return _instance
}

export function initAutoRefineManager(intervalHours?: number): AutoRefineManager {
  _instance = new AutoRefineManager(intervalHours)
  return _instance
}
