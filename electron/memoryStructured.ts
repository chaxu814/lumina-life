// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// memoryStructured.ts — 三层结构化记忆系统 (v3.0)
//
// 三层记忆架构：
//   Layer 1: 个人记忆 (Per-Agent)  — 每个 agent 自己的经验和理解
//   Layer 2: 团队记忆 (Team)       — 团队共享的决策、教训、协作记录
//   Layer 3: 项目记忆 (Project)    — 特定项目的技术细节
//
// 设计原则：
//   - 借鉴 QwenPaw 的 MEMORY.md + memory/YYYY-MM-DD.md 结构
//   - 记忆分层：临时的存每日笔记，重要的提炼到长期记忆
//   - 语义搜索：支持跨层搜索
//   - 自动衰减：不活跃的记忆权重降低
// ============================================================

import { getMemoryStore } from './memory/memoryStore'

// ═══════════════════════════════════════════════════════════
// 记忆类型
// ═══════════════════════════════════════════════════════════

export type MemoryLayer = 'personal' | 'team' | 'project'

export interface StructuredMemory {
  id: string
  layer: MemoryLayer
  /** 关联的 agent ID（personal 层必填） */
  agentId?: string
  /** 类别 */
  category: MemoryCategory
  /** 记忆内容 */
  content: string
  /** 标签 */
  tags: string[]
  /** 重要性 0-1 */
  importance: number
  /** 创建时间 */
  createdAt: number
  /** 最后访问时间 */
  lastAccessedAt: number
  /** 访问次数 */
  accessCount: number
  /** 衰减权重 */
  decayWeight: number
}

export type MemoryCategory =
  | 'user_preference'     // 用户偏好
  | 'decision'            // 决策记录
  | 'lesson'              // 经验教训
  | 'project_context'     // 项目上下文
  | 'technical_detail'    // 技术细节
  | 'collaboration'       // 协作记录
  | 'bug_fix'             // Bug 修复记录
  | 'architecture'        // 架构决策
  | 'general'             // 通用

// ═══════════════════════════════════════════════════════════
// 结构化记忆管理器
// ═══════════════════════════════════════════════════════════

export class StructuredMemoryManager {
  private memories: StructuredMemory[] = []
  private readonly DECAY_RATE = 0.01 // 每次衰减的权重降低比例
  private readonly DECAY_THRESHOLD = 0.1 // 低于此权重视为"遗忘"

  // ── 存储 ────────────────────────────────────────

  /**
   * 保存一条结构化记忆
   */
  save(memory: Omit<StructuredMemory, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount' | 'decayWeight'>): StructuredMemory {
    const full: StructuredMemory = {
      ...memory,
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      decayWeight: memory.importance, // 初始权重 = 重要性
    }
    this.memories.push(full)

    // 同时存入底层 memoryStore 做语义搜索
    try {
      const store = getMemoryStore()
      store.addMemory({
        key: full.id,
        value: `${memory.layer}/${memory.category}: ${memory.content}`,
        metadata: {
          layer: memory.layer,
          category: memory.category,
          agentId: memory.agentId || '',
          tags: memory.tags.join(','),
          importance: String(memory.importance),
        },
      })
    } catch {
      // memoryStore 不可用时降级到内存
    }

    return full
  }

  // ── 查询 ────────────────────────────────────────

  /**
   * 按层查询记忆
   */
  queryByLayer(layer: MemoryLayer, agentId?: string): StructuredMemory[] {
    let results = this.memories.filter((m) => m.layer === layer)
    if (layer === 'personal' && agentId) {
      results = results.filter((m) => m.agentId === agentId)
    }
    return this.sortByRelevance(results)
  }

  /**
   * 按类别查询
   */
  queryByCategory(category: MemoryCategory, layer?: MemoryLayer): StructuredMemory[] {
    let results = this.memories.filter((m) => m.category === category)
    if (layer) {results = results.filter((m) => m.layer === layer)}
    return this.sortByRelevance(results)
  }

  /**
   * 按标签查询
   */
  queryByTag(tag: string): StructuredMemory[] {
    return this.sortByRelevance(
      this.memories.filter((m) => m.tags.includes(tag))
    )
  }

  /**
   * 语义搜索（关键词匹配 + 标签匹配）
   */
  search(query: string, limit = 5): StructuredMemory[] {
    const lower = query.toLowerCase()
    const scored = this.memories.map((m) => {
      let score = 0
      // 内容匹配
      if (m.content.toLowerCase().includes(lower)) {score += 3}
      // 标签匹配
      for (const tag of m.tags) {
        if (lower.includes(tag) || tag.includes(lower)) {score += 2}
      }
      // 类别匹配
      if (m.category.toLowerCase().includes(lower)) {score += 1}
      // 重要性加权
      score *= m.importance * m.decayWeight
      return { memory: m, score }
    })

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => {
        // 更新访问统计
        s.memory.lastAccessedAt = Date.now()
        s.memory.accessCount++
        s.memory.decayWeight = Math.min(1, s.memory.decayWeight + 0.05)
        return s.memory
      })
  }

  // ── Agent 专用查询 ──────────────────────────────

  /**
   * 获取某个 agent 应该知道的所有相关记忆
   * （个人记忆 + 团队记忆 + 项目记忆的并集，按相关性排序）
   */
  getContextForAgent(agentId: string, limit = 8): StructuredMemory[] {
    const relevant = this.memories.filter(
      (m) =>
        (m.layer === 'personal' && m.agentId === agentId) ||
        m.layer === 'team' ||
        m.layer === 'project'
    )
    return this.sortByRelevance(relevant).slice(0, limit)
  }

  /**
   * 生成 agent 上下文的文本注入
   */
  buildAgentContextInjection(agentId: string): string {
    const memories = this.getContextForAgent(agentId, 5)
    if (memories.length === 0) {return ''}

    const personal = memories.filter((m) => m.layer === 'personal')
    const team = memories.filter((m) => m.layer === 'team')
    const project = memories.filter((m) => m.layer === 'project')

    let context = '\n【记忆上下文】\n'

    if (project.length) {
      context += '\n📁 项目记忆：\n'
      context += project.map((m) => `  • ${m.content}`).join('\n')
    }

    if (team.length) {
      context += '\n👥 团队记忆：\n'
      context += team.map((m) => `  • ${m.content}`).join('\n')
    }

    if (personal.length) {
      context += '\n👤 个人记忆：\n'
      context += personal.map((m) => `  • ${m.content}`).join('\n')
    }

    return context
  }

  // ── 常用场景的快捷方法 ──────────────────────────

  /** 记录一次用户偏好 */
  recordPreference(agentId: string, content: string, importance = 0.8): void {
    this.save({
      layer: 'personal',
      agentId,
      category: 'user_preference',
      content,
      tags: ['preference', 'user'],
      importance,
    })
  }

  /** 记录一个团队决策 */
  recordDecision(agentId: string, content: string): void {
    this.save({
      layer: 'team',
      agentId,
      category: 'decision',
      content,
      tags: ['decision'],
      importance: 0.9,
    })
  }

  /** 记录一个经验教训 */
  recordLesson(agentId: string, content: string, layer: MemoryLayer = 'team'): void {
    this.save({
      layer,
      agentId,
      category: 'lesson',
      content,
      tags: ['lesson', 'learned'],
      importance: 0.85,
    })
  }

  /** 记录一次 Bug 修复 */
  recordBugFix(agentId: string, bug: string, fix: string): void {
    this.save({
      layer: 'project',
      agentId,
      category: 'bug_fix',
      content: `Bug: ${bug} → 修复: ${fix}`,
      tags: ['bug', 'fix', 'debug'],
      importance: 0.7,
    })
  }

  /** 记录架构决策 */
  recordArchitecture(agentId: string, decision: string, rationale: string): void {
    this.save({
      layer: 'project',
      agentId,
      category: 'architecture',
      content: `决策: ${decision}。理由: ${rationale}`,
      tags: ['architecture', 'design', 'decision'],
      importance: 0.9,
    })
  }

  // ── 记忆维护 ────────────────────────────────────

  /**
   * 衰减所有记忆权重（定期调用）
   */
  decay(): void {
    const now = Date.now()
    for (const memory of this.memories) {
      // 根据未访问时间计算衰减
      const daysSinceAccess = (now - memory.lastAccessedAt) / (1000 * 60 * 60 * 24)
      memory.decayWeight = Math.max(
        this.DECAY_THRESHOLD,
        memory.importance * Math.exp(-this.DECAY_RATE * daysSinceAccess)
      )
    }
  }

  /**
   * 清理"遗忘"的记忆（权重低于阈值的）
   */
  cleanup(): number {
    const before = this.memories.length
    this.memories = this.memories.filter((m) => m.decayWeight > this.DECAY_THRESHOLD)
    return before - this.memories.length
  }

  /**
   * 强化某条记忆（增加权重）
   */
  reinforce(memoryId: string): boolean {
    const memory = this.memories.find((m) => m.id === memoryId)
    if (!memory) {return false}
    memory.decayWeight = Math.min(1, memory.decayWeight + 0.1)
    memory.lastAccessedAt = Date.now()
    memory.accessCount++
    return true
  }

  // ── 辅助 ────────────────────────────────────────

  private sortByRelevance(memories: StructuredMemory[]): StructuredMemory[] {
    return memories.sort((a, b) => {
      // 综合得分：重要性 × 衰减权重 × 访问频率
      const scoreA = a.importance * a.decayWeight * Math.log(a.accessCount + 2)
      const scoreB = b.importance * b.decayWeight * Math.log(b.accessCount + 2)
      return scoreB - scoreA
    })
  }

  /** 获取统计信息 */
  getStats(): { total: number; byLayer: Record<string, number>; byCategory: Record<string, number> } {
    const byLayer: Record<string, number> = {}
    const byCategory: Record<string, number> = {}

    for (const m of this.memories) {
      byLayer[m.layer] = (byLayer[m.layer] || 0) + 1
      byCategory[m.category] = (byCategory[m.category] || 0) + 1
    }

    return { total: this.memories.length, byLayer, byCategory }
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _structuredMemory: StructuredMemoryManager | null = null

export function getStructuredMemory(): StructuredMemoryManager {
  if (!_structuredMemory) {_structuredMemory = new StructuredMemoryManager()}
  return _structuredMemory
}

// ═══════════════════════════════════════════════════════════
// 记忆管理工具定义（增强版 memory 工具）
// ═══════════════════════════════════════════════════════════

export const STRUCTURED_MEMORY_TOOLS = {
  'memory_save_v2': {
    name: 'memory_save_v2',
    description:
      '保存一条结构化记忆。支持三层：personal（个人）/ team（团队共享）/ project（项目相关）。\n' +
      '类别：user_preference（偏好）、decision（决策）、lesson（教训）、\n' +
      'technical_detail（技术细节）、collaboration（协作）、bug_fix（修复）、\n' +
      'architecture（架构）、general（通用）',
    params: {
      layer: {
        type: 'string',
        description: '记忆层级：personal / team / project',
        required: true,
        enum: ['personal', 'team', 'project'],
      },
      category: {
        type: 'string',
        description: '记忆类别',
        required: true,
        enum: ['user_preference', 'decision', 'lesson', 'project_context', 'technical_detail', 'collaboration', 'bug_fix', 'architecture', 'general'],
      },
      content: { type: 'string', description: '记忆内容', required: true },
      tags: { type: 'string', description: '标签，逗号分隔', required: false },
      importance: {
        type: 'number',
        description: '重要性 0-1，默认 0.7',
        required: false,
      },
    },
  },

  'memory_search_v2': {
    name: 'memory_search_v2',
    description:
      '在结构化记忆中搜索。支持按层级、类别、标签过滤。',
    params: {
      query: { type: 'string', description: '搜索关键词', required: true },
      layer: {
        type: 'string',
        description: '限定层级：personal / team / project（可选）',
        required: false,
        enum: ['personal', 'team', 'project'],
      },
      category: {
        type: 'string',
        description: '限定类别（可选）',
        required: false,
      },
    },
  },

  'memory_team_context': {
    name: 'memory_team_context',
    description: '获取当前 agent 应该知道的所有相关记忆（个人 + 团队 + 项目的并集）',
    params: {},
  },
}
