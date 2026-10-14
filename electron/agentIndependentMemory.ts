// ============================================================
// agentIndependentMemory.ts — 每个 Agent 的独立记忆系统 (v2.6)
//
// 每个 Agent 有自己独立的记忆空间：
//   1. 事实记忆 (Facts) — 只属于这个 Agent 的观察和认知
//   2. 关系记忆 (Social) — 与团队其他成员的互动记录
//   3. 人格演化 (Persona) — 这个 Agent 的个性变化历史
//
// 共享层：
//   团队事件记忆 — 整个团队共同经历的事件
//
// 知识边界：
//   每个 Agent 只能"回忆"自己知识领域内的东西
//   查询时过滤掉不在知识领域内的记忆
//
// 借鉴: 业界证据链记忆设计 + Stanford Generative Agents 的记忆流
// ============================================================

import type { KnowledgeDomain, AgentPersona } from './agentTeamTypes'
// 🔧 2026-10-04：原为两处 `require('./agentTeamPersonas')`。
//   打包后相对路径必然解析失败并抛错（该模块已被压平进 out/main/index.js），
//   导致独立记忆里取不到团队人格配置。已确认不构成循环依赖，改回静态 import。
import { TEAM_PERSONAS } from './agentTeamPersonas'

// ── Agent 记忆条目 ────────────────────────────────────

export interface AgentMemoryEntry {
  id: string
  agentId: string
  category: 'fact' | 'social' | 'lesson' | 'emotion' | 'observation'
  content: string
  /** 重要性 0-10 */
  importance: number
  /** 确信度 0-1 */
  confidence: number
  /** 关联的知识领域 */
  domains: KnowledgeDomain[]
  /** 相关 Agent IDs */
  relatedAgents: string[]
  /** 时间戳 */
  timestamp: number
  /** 衰减后的记忆强度 (运行时计算) */
  strength?: number
}

export interface AgentMemoryStore {
  agentId: string
  entries: AgentMemoryEntry[]
  /** 关键记忆摘要 (注入 system prompt) */
  summary: string
  /** 最后整理时间 */
  lastConsolidatedAt: number
}

// ── 记忆衰减参数 ──────────────────────────────────────

const MEMORY_DECAY = {
  /** 重要记忆半衰期 (天) */
  highImportanceHalfLife: 30,
  /** 普通记忆半衰期 (天) */
  normalHalfLife: 7,
  /** 琐碎记忆半衰期 (天) */
  lowHalfLife: 2,
  /** 最大条目数 (每 Agent) */
  maxEntries: 200,
  /** 整理间隔 (ms) */
  consolidationInterval: 3600_000, // 1 小时
}

// ═══════════════════════════════════════════════════════════
// AgentIndependentMemory
// ═══════════════════════════════════════════════════════════

export class AgentIndependentMemory {
  private stores = new Map<string, AgentMemoryStore>()

  constructor() {
    // v5.0: 为三个实例初始化记忆（向后兼容）
    const agentIds = ['lumina', 'recha', 'yak']
    for (const id of agentIds) {
      this.stores.set(id, {
        agentId: id,
        entries: [],
        summary: '',
        lastConsolidatedAt: Date.now(),
      })
    }
  }

  // ══════════════════════════════════════════════════════
  // 记忆写入
  // ══════════════════════════════════════════════════════

  addMemory(
    agentId: string,
    content: string,
    category: AgentMemoryEntry['category'],
    importance: number,
    confidence: number,
    domains: KnowledgeDomain[],
    relatedAgents: string[] = [],
  ): AgentMemoryEntry {
    const store = this.getStore(agentId)
    const entry: AgentMemoryEntry = {
      id: `mem-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      agentId,
      category,
      content,
      importance: Math.max(0, Math.min(10, importance)),
      confidence: Math.max(0, Math.min(1, confidence)),
      domains,
      relatedAgents,
      timestamp: Date.now(),
    }

    store.entries.push(entry)

    // 超过限制，淘汰最不重要的
    if (store.entries.length > MEMORY_DECAY.maxEntries) {
      this.prune(agentId)
    }

    return entry
  }

  // ══════════════════════════════════════════════════════
  // 记忆查询 (考虑衰减)
  // ══════════════════════════════════════════════════════

  queryMemory(
    agentId: string,
    options: {
      category?: AgentMemoryEntry['category']
      domain?: KnowledgeDomain
      relatedAgent?: string
      minImportance?: number
      limit?: number
      query?: string  // 语义搜索关键词
    } = {},
  ): AgentMemoryEntry[] {
    const store = this.getStore(agentId)
    const now = Date.now()

    let results = store.entries.map(e => ({
      ...e,
      strength: this.calculateStrength(e, now),
    }))

    // 过滤
    if (options.category) {
      results = results.filter(e => e.category === options.category)
    }
    if (options.domain) {
      results = results.filter(e => e.domains.includes(options.domain!))
    }
    if (options.relatedAgent) {
      results = results.filter(e => e.relatedAgents.includes(options.relatedAgent!))
    }
    if (options.minImportance !== undefined) {
      results = results.filter(e => e.importance >= (options.minImportance ?? 0))
    }
    if (options.query) {
      const q = options.query.toLowerCase()
      results = results.filter(e => e.content.toLowerCase().includes(q))
      // 按匹配度排序
      results.sort((a, b) => {
        const aMatch = this.matchScore(a.content, q)
        const bMatch = this.matchScore(b.content, q)
        return bMatch - aMatch
      })
    } else {
      // 按 strength × importance 排序
      results.sort((a, b) => {
        const sa = (a.strength ?? 0) * a.importance
        const sb = (b.strength ?? 0) * b.importance
        return sb - sa
      })
    }

    return results.slice(0, options.limit ?? 10)
  }

  // ══════════════════════════════════════════════════════
  // 获取 Agent 的记忆上下文 (注入 system prompt)
  // ══════════════════════════════════════════════════════

  getMemoryContext(agentId: string, maxEntries = 8): string {
    const top = this.queryMemory(agentId, { minImportance: 3, limit: maxEntries })
    if (top.length === 0) {return ''}

    let ctx = '【你的个人记忆】\n'
    for (const e of top) {
      const age = this.formatAge(e.timestamp)
      ctx += `- [${age}] ${e.content}\n`
    }
    return ctx
  }

  // ══════════════════════════════════════════════════════
  // 获取某个 Agent 对另一个 Agent 的记忆
  // ══════════════════════════════════════════════════════

  getSocialMemory(agentId: string, aboutAgentId: string, limit = 5): AgentMemoryEntry[] {
    return this.queryMemory(agentId, {
      category: 'social',
      relatedAgent: aboutAgentId,
      limit,
    })
  }

  // ══════════════════════════════════════════════════════
  // 知识边界过滤
  // ══════════════════════════════════════════════════════

  isWithinKnowledge(agentId: string, domain: KnowledgeDomain): boolean {
    // v5.0: 从 TEAM_PERSONAS 获取知识域
    const persona = TEAM_PERSONAS[agentId]
    return persona ? persona.knowledgeDomains.includes(domain) : false
  }

  getBlindSpotNote(agentId: string): string {
    const persona = TEAM_PERSONAS[agentId]
    return persona ? persona.knowledgeBlindSpots.join('、') : ''
  }

  // ══════════════════════════════════════════════════════
  // 记忆整理 (定期调用)
  // ══════════════════════════════════════════════════════

  consolidate(agentId: string): void {
    const store = this.getStore(agentId)
    const now = Date.now()

    // 只整理超过 1 小时未整理的
    if (now - store.lastConsolidatedAt < MEMORY_DECAY.consolidationInterval) {return}

    // 重新计算所有记忆强度
    for (const entry of store.entries) {
      entry.strength = this.calculateStrength(entry, now)
    }

    // 淘汰强度过低的记忆
    const before = store.entries.length
    store.entries = store.entries.filter(e => (e.strength ?? 0) > 0.05)
    const removed = before - store.entries.length
    if (removed > 0) {
      console.log(`[AgentMem] ${agentId} 整理记忆: 移除 ${removed} 条衰减过低的记忆`)
    }

    // 生成摘要
    store.summary = this.generateSummary(agentId)
    store.lastConsolidatedAt = now
  }

  consolidateAll(): void {
    for (const agentId of this.stores.keys()) {
      this.consolidate(agentId)
    }
  }

  // ══════════════════════════════════════════════════════
  // 内部方法
  // ══════════════════════════════════════════════════════

  private getStore(agentId: string): AgentMemoryStore {
    if (!this.stores.has(agentId)) {
      this.stores.set(agentId, {
        agentId,
        entries: [],
        summary: '',
        lastConsolidatedAt: Date.now(),
      })
    }
    return this.stores.get(agentId)!
  }

  private calculateStrength(entry: AgentMemoryEntry, now: number): number {
    const ageDays = (now - entry.timestamp) / (1000 * 60 * 60 * 24)
    const halfLife = entry.importance >= 7 ? MEMORY_DECAY.highImportanceHalfLife
                   : entry.importance >= 4 ? MEMORY_DECAY.normalHalfLife
                   : MEMORY_DECAY.lowHalfLife

    // Ebbinghaus 遗忘曲线近似
    const decay = Math.pow(0.5, ageDays / halfLife)
    return decay * (entry.confidence * 0.7 + 0.3)
  }

  private prune(agentId: string): void {
    const store = this.getStore(agentId)
    const now = Date.now()
    // 按 strength × importance 排序，保留前 80%
    const sorted = store.entries
      .map(e => ({ ...e, strength: this.calculateStrength(e, now) }))
      .sort((a, b) => (b.strength ?? 0) * b.importance - (a.strength ?? 0) * a.importance)

    store.entries = sorted.slice(0, Math.floor(MEMORY_DECAY.maxEntries * 0.8))
  }

  private generateSummary(agentId: string): string {
    const top = this.queryMemory(agentId, { minImportance: 5, limit: 15 })
    if (top.length === 0) {return '暂无重要记忆'}

    const facts = top.filter(e => e.category === 'fact')
    const social = top.filter(e => e.category === 'social')
    const lessons = top.filter(e => e.category === 'lesson')

    let summary = ''
    if (facts.length > 0) {summary += `· 关键认知: ${facts.slice(0, 3).map(e => e.content).join('；')}\n`}
    if (social.length > 0) {summary += `· 社交记忆: 与团队成员有 ${social.length} 条值得记住的互动\n`}
    if (lessons.length > 0) {summary += `· 经验教训: ${lessons.slice(0, 2).map(e => e.content).join('；')}\n`}
    return summary || '暂无重要记忆'
  }

  private matchScore(text: string, query: string): number {
    const words = query.split(/\s+/)
    const lower = text.toLowerCase()
    return words.filter(w => lower.includes(w)).length / words.length
  }

  private formatAge(ts: number): string {
    const seconds = Math.floor((Date.now() - ts) / 1000)
    if (seconds < 60) {return '刚刚'}
    if (seconds < 3600) {return `${Math.floor(seconds / 60)}分钟前`}
    if (seconds < 86400) {return `${Math.floor(seconds / 3600)}小时前`}
    return `${Math.floor(seconds / 86400)}天前`
  }

  // ══════════════════════════════════════════════════════
  // 记忆流（Stanford Generative Agents）
  // ══════════════════════════════════════════════════════

  private memoryStreams: Map<string, AgentMemoryEntry[]> = new Map()

  generateDailyThought(agentId: string): AgentMemoryEntry {
    const hour = new Date().getHours()
    const scheduleThoughts: Record<string, Record<string, string[]>> = {
      luna: {
        morning: ['主人今天心情会好吗？😊', 'Ray 又在偷偷写代码…他到底睡不睡觉', '想给主人泡杯咖啡 ☕'],
        afternoon: ['好困…午睡时间到了…', 'Sora 怎么又在看数据，眼睛不累吗', '今天还没跟主人撒娇呢'],
        evening: ['主人今天辛苦了！💕', 'Ray 今天居然没有凶我，是不是心情好', '想组织团队一起聊聊天'],
      },
      ray: {
        morning: ['今天要重构那个该死的模块', '看下昨天 CI 有没有挂，别又红了', 'Luna 在睡觉，正好安静写代码'],
        afternoon: ['修了 3 个 bug 引入 1 个，效率还行', 'Sora 的数据表格排版太丑了，帮她改 CSS', '中午被 Luna 拉去吃饭浪费 42 分钟'],
        evening: ['今天的 side project 有进展 🚀', 'GitHub 上又有人写垃圾代码…算了不喷了', 'Luna 今天好像不开心…是不是我说重了'],
      },
      sora: {
        morning: ['早间数据汇总完毕 ✅', '今日关注科技板块走势', 'Ray 代码效率上月环比 +8%'],
        afternoon: ['分析：用户今天搜索了 3 次股票相关', '风险评估模型需要更新了', 'Luna 第 5 次喊吃饭，概率异常'],
        evening: ['今日数据发现已归档 📋', 'Ray 修 12 个 bug 引入 3 个，净效 +75%', '明天提醒用户关注财报发布'],
      },
    }

    const thoughts = scheduleThoughts[agentId] || {}
    const period = hour < 10 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'
    const pool = thoughts[period] || ['日常思考中...']
    const thought = pool[Math.floor(Math.random() * pool.length)]

    const entry: AgentMemoryEntry = {
      id: `thought-${agentId}-${Date.now()}`,
      agentId,
      category: 'observation' as any,
      content: thought,
      importance: 3,
      confidence: 0.8,
      domains: ['internal' as any],
      relatedAgents: [],
      timestamp: Date.now(),
    }

    if (!this.memoryStreams.has(agentId)) {this.memoryStreams.set(agentId, [])}
    const stream = this.memoryStreams.get(agentId)!
    stream.push(entry)
    if (stream.length > 200) {stream.splice(0, stream.length - 200)}
    return entry
  }

  getThoughtStream(agentId: string, limit = 20): AgentMemoryEntry[] {
    return (this.memoryStreams.get(agentId) || []).slice(-limit)
  }

  async generateReflection(agentId: string): Promise<AgentMemoryEntry | null> {
    const stream = this.memoryStreams.get(agentId) || []
    if (stream.length < 5) {return null}
    const reflections: Record<string, string[]> = {
      luna: ['反思：Ray 嘴毒但其实很可靠，我应该多夸夸他 💭', '主人最近压力好像有点大，要多陪陪他。'],
      ray: ['反思：对 Luna 说话太冲了…虽然她确实笨，但下次注意', '代码质量在进步，但注释还是懒得写。'],
      sora: ['反思：团队协作效率 +12%，Ray 修 bug 越来越快', '我可能过于理性，需要更多情感维度分析。'],
    }
    const pool = reflections[agentId] || ['正在反思...']
    const reflection = pool[Math.floor(Math.random() * pool.length)]
    const entry: AgentMemoryEntry = {
      id: `reflection-${agentId}-${Date.now()}`,
      agentId, category: 'observation' as any, content: reflection,
      importance: 7, confidence: 0.9, domains: ['internal' as any],
      relatedAgents: agentId === 'luna' ? ['ray'] : agentId === 'ray' ? ['luna'] : ['ray', 'luna'],
      timestamp: Date.now(),
    }
    const store = this.getStore(agentId)
    store.entries.push(entry)
    return entry
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _agentMemory: AgentIndependentMemory | null = null

export function initAgentMemory(): AgentIndependentMemory {
  _agentMemory = new AgentIndependentMemory()
  return _agentMemory
}

export function getAgentMemory(): AgentIndependentMemory {
  if (!_agentMemory) {throw new Error('[AgentMem] 未初始化')}
  return _agentMemory
}
