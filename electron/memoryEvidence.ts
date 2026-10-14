// ============================================================
// memoryEvidence.ts — 记忆证据评分系统 (v2.5)
//
// 借鉴业界设计: 每条记忆带有证据评分，确保记忆可信度
//
// 评分维度:
//   - confidence (置信度): 0-1, 基于来源可靠性
//   - recency (新鲜度): 0-1, 基于时间衰减
//   - frequency (频率): 0-1, 基于重复提及次数
//   - corroboration (佐证): 0-1, 是否被其他记忆支持
//   - importance (重要性): 0-1, 由 LLM 评估
//
// 综合评分 = confidence × 0.3 + recency × 0.15 + frequency × 0.15
//           + corroboration × 0.1 + importance × 0.3
//
// 评分 > 0.6: 高度可信 → 可注入 System Prompt
// 评分 0.3-0.6: 中等 → 保留但需要更多确认
// 评分 < 0.3: 低 → 可能过时或错误，可清理
// ============================================================

import fs from 'fs'
import path from 'path'
import { stateFilePath } from './core/pathsFallback'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface EvidenceScores {
  confidence: number    // 0-1, 来源可靠性
  recency: number       // 0-1, 时间衰减
  frequency: number     // 0-1, 重复提及
  corroboration: number // 0-1, 佐证支持
  importance: number    // 0-1, LLM 评估的重要性
}

export interface ScoredMemory {
  id: string
  content: string
  type: 'fact' | 'reflection' | 'persona' | 'lesson' | 'preference'
  scores: EvidenceScores
  compositeScore: number // 0-1 综合评分
  createdAt: number
  updatedAt: number
  mentionCount: number
  sourceCount: number
  status: 'confirmed' | 'pending' | 'outdated' | 'contradicted'
}

export interface EvidenceConfig {
  /** 衰减半衰期 (天) */
  decayHalfLife: number
  /** 高置信度阈值 (超过注入提示词) */
  highConfidenceThreshold: number
  /** 低置信度阈值 (低于可清理) */
  lowConfidenceThreshold: number
  /** 最大记忆数 */
  maxMemories: number
}

// ═══════════════════════════════════════════════════════════
// 证据评分引擎
// ═══════════════════════════════════════════════════════════

export class MemoryEvidenceEngine {
  private memories: ScoredMemory[] = []
  private config: EvidenceConfig
  private storagePath: string

  private static WEIGHTS = {
    confidence: 0.30,
    recency: 0.15,
    frequency: 0.15,
    corroboration: 0.10,
    importance: 0.30,
  }

  constructor(config?: Partial<EvidenceConfig>) {
    this.config = {
      decayHalfLife: 7,       // 7 天半衰期
      highConfidenceThreshold: 0.6,
      lowConfidenceThreshold: 0.3,
      maxMemories: 500,
      ...config,
    }
    // ⚠️ 不要退回 process.cwd()：开发态 cwd 就是项目根，会把状态写进 Git 工作区
    this.storagePath = stateFilePath('memory-evidence.json')
    this.load()
  }

  // ── CRUD ─────────────────────────────────────────────

  /** 添加/更新记忆并计算证据评分 */
  addMemory(params: {
    content: string
    type: ScoredMemory['type']
    sourceReliability?: number  // 0-1
    importance?: number         // 0-1, 可由 LLM 评估
    isNewSource?: boolean
  }): ScoredMemory {
    const { content, type, sourceReliability = 0.7, importance = 0.5, isNewSource = true } = params

    // 检查是否已存在相似记忆
    const existing = this.findSimilar(content)
    const id = existing ? existing.id : this.generateId()

    const now = Date.now()

    if (existing) {
      // 更新已有记忆
      existing.mentionCount++
      if (isNewSource) {existing.sourceCount++}
      existing.scores = this.calculateScores(existing, sourceReliability, importance)
      existing.compositeScore = this.computeComposite(existing.scores)
      existing.updatedAt = now
      existing.status = this.determineStatus(existing.compositeScore)
    } else {
      // 新建记忆
      const memory: ScoredMemory = {
        id,
        content,
        type,
        scores: {
          confidence: sourceReliability,
          recency: 1.0,
          frequency: 0.1,
          corroboration: 0,
          importance,
        },
        compositeScore: 0,
        createdAt: now,
        updatedAt: now,
        mentionCount: 1,
        sourceCount: 1,
        status: 'pending',
      }
      memory.compositeScore = this.computeComposite(memory.scores)
      memory.status = this.determineStatus(memory.compositeScore)
      this.memories.push(memory)
    }

    // 触发佐证更新
    this.updateCorroboration()

    // 清理低分记忆
    this.pruneLowConfidence()

    // 保存
    this.save()

    const result = this.memories.find(m => m.id === id)!
    return result
  }

  /** LLM 评估记忆重要性 */
  setImportance(id: string, importance: number): boolean {
    const mem = this.memories.find(m => m.id === id)
    if (!mem) {return false}

    mem.scores.importance = Math.max(0, Math.min(importance, 1))
    mem.compositeScore = this.computeComposite(mem.scores)
    mem.status = this.determineStatus(mem.compositeScore)
    this.save()
    return true
  }

  /** 标记记忆为矛盾/过时 */
  markContradicted(id: string): boolean {
    const mem = this.memories.find(m => m.id === id)
    if (!mem) {return false}

    mem.status = 'contradicted'
    mem.scores.confidence *= 0.3
    mem.compositeScore = this.computeComposite(mem.scores)
    this.save()
    return true
  }

  // ── 查询 ─────────────────────────────────────────────

  /** 获取高置信度记忆 (可注入 System Prompt) */
  getHighConfidenceMemories(limit = 20): ScoredMemory[] {
    return this.memories
      .filter(m => m.compositeScore >= this.config.highConfidenceThreshold && m.status === 'confirmed')
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .slice(0, limit)
  }

  /** 获取所有记忆按评分排序 */
  getMemoriesByScore(type?: ScoredMemory['type']): ScoredMemory[] {
    let list = [...this.memories]
    if (type) {list = list.filter(m => m.type === type)}
    return list.sort((a, b) => b.compositeScore - a.compositeScore)
  }

  /** 获取待确认记忆 */
  getPendingMemories(): ScoredMemory[] {
    return this.memories.filter(m => m.status === 'pending')
  }

  /** 🆕 v3.34: 按内容查找已有记忆（公开包装）
   *
   *  【为什么需要】记忆保存链路在写入时经常已经知道 content（例如用户纠正了
   *  一条旧记忆），需要在保存**之前**拿到对应的证据条目来判断该把它标成
   *  confirmed 还是 contradicted。findSimilar 本身是 private。
   *
   *  这里不放开原方法的可见性，而是加一个显式的公开入口 —— 让「什么时候
   *  可以按内容反查」这件事是显式选择，而不是不小心依赖了内部实现。
   */
  findByContent(content: string): ScoredMemory | undefined {
    return this.findSimilar(String(content || '').trim())
  }

  /** 🆕 v3.34: 按内容反查并标为已证伪，返回命中的 id（未命中返回 null） */
  contradictByContent(content: string): string | null {
    const hit = this.findByContent(content)
    if (!hit) {return null}
    return this.markContradicted(hit.id) ? hit.id : null
  }

  /** 获取过时/矛盾记忆 (建议清理) */
  getOutdatedMemories(): ScoredMemory[] {
    return this.memories.filter(m =>
      m.status === 'outdated' || m.status === 'contradicted'
    )
  }

  /** 生成注入 System Prompt 的记忆摘要 */
  getPromptContext(maxMemories = 10): string {
    const highConf = this.getHighConfidenceMemories(maxMemories)
    if (highConf.length === 0) {return ''}

    const lines = highConf.map(m =>
      `- [${m.type}] (置信度:${(m.compositeScore * 100).toFixed(0)}%) ${m.content}`
    )

    return `\n【已验证的用户信息】\n${lines.join('\n')}\n`
  }

  // ── 评分计算 ─────────────────────────────────────────

  private calculateScores(
    existing: ScoredMemory,
    sourceReliability: number,
    importance: number
  ): EvidenceScores {
    const now = Date.now()

    // 置信度: 平均来源可靠性
    const confidence = (existing.scores.confidence * (existing.mentionCount - 1) + sourceReliability) / existing.mentionCount

    // 新鲜度: 指数衰减
    const ageDays = (now - existing.createdAt) / (1000 * 60 * 60 * 24)
    const recency = Math.exp(-ageDays * Math.LN2 / this.config.decayHalfLife)

    // 频率: sigmoid 函数
    const frequency = 1 / (1 + Math.exp(-0.3 * (existing.mentionCount - 3)))

    // 佐证: 需要姐妹记忆支持 (外部更新)
    const corroboration = existing.scores.corroboration

    // 重要性: 保持或更新
    const newImportance = importance > 0 ? importance : existing.scores.importance

    return {
      confidence: Math.max(0, Math.min(confidence, 1)),
      recency: Math.max(0, Math.min(recency, 1)),
      frequency: Math.max(0, Math.min(frequency, 1)),
      corroboration: Math.max(0, Math.min(corroboration, 1)),
      importance: Math.max(0, Math.min(newImportance, 1)),
    }
  }

  private computeComposite(scores: EvidenceScores): number {
    return (
      scores.confidence * MemoryEvidenceEngine.WEIGHTS.confidence +
      scores.recency * MemoryEvidenceEngine.WEIGHTS.recency +
      scores.frequency * MemoryEvidenceEngine.WEIGHTS.frequency +
      scores.corroboration * MemoryEvidenceEngine.WEIGHTS.corroboration +
      scores.importance * MemoryEvidenceEngine.WEIGHTS.importance
    )
  }

  private determineStatus(score: number): ScoredMemory['status'] {
    if (score >= this.config.highConfidenceThreshold) {return 'confirmed'}
    if (score >= this.config.lowConfidenceThreshold) {return 'pending'}
    return 'outdated'
  }

  /** 更新佐证分数：语义相似的其他记忆互相支持 */
  private updateCorroboration(): void {
    for (const mem of this.memories) {
      let support = 0
      for (const other of this.memories) {
        if (other.id === mem.id) {continue}
        const similarity = this.textSimilarity(mem.content, other.content)
        if (similarity > 0.4) {support += similarity * 0.2}
      }
      mem.scores.corroboration = Math.min(support, 1)
      mem.compositeScore = this.computeComposite(mem.scores)
      mem.status = this.determineStatus(mem.compositeScore)
    }
  }

  private pruneLowConfidence(): void {
    const toRemove = this.memories.filter(m =>
      m.compositeScore < this.config.lowConfidenceThreshold &&
      m.status === 'outdated'
    )
    if (toRemove.length > 0) {
      const ids = new Set(toRemove.map(m => m.id))
      this.memories = this.memories.filter(m => !ids.has(m.id))
      console.log(`[MemoryEvidence] 清理 ${toRemove.length} 条低分记忆`)
    }

    // 限制总数
    if (this.memories.length > this.config.maxMemories) {
      this.memories.sort((a, b) => a.compositeScore - b.compositeScore)
      const removed = this.memories.length - this.config.maxMemories
      this.memories = this.memories.slice(removed)
      console.log(`[MemoryEvidence] 清理 ${removed} 条超量记忆`)
    }
  }

  // ── 相似度 ───────────────────────────────────────────

  private findSimilar(content: string): ScoredMemory | undefined {
    const threshold = 0.6
    for (const mem of this.memories) {
      if (this.textSimilarity(mem.content, content) >= threshold) {
        return mem
      }
    }
    return undefined
  }

  private textSimilarity(a: string, b: string): number {
    // 简单的 Jaccard 相似度
    const wordsA = new Set(
      a.toLowerCase().replace(/[^\w\u4e00-\u9fff\s]/g, '').split(/\s+/).filter(w => w.length > 1)
    )
    const wordsB = new Set(
      b.toLowerCase().replace(/[^\w\u4e00-\u9fff\s]/g, '').split(/\s+/).filter(w => w.length > 1)
    )

    if (wordsA.size === 0 || wordsB.size === 0) {return 0}

    let intersection = 0
    for (const w of wordsA) {
      if (wordsB.has(w)) {intersection++}
    }

    return intersection / Math.max(wordsA.size, wordsB.size)
  }

  // ── ID 生成 ──────────────────────────────────────────

  private generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  }

  // ── 持久化 ───────────────────────────────────────────

  private load(): void {
    try {
      if (fs.existsSync(this.storagePath)) {
        const data = JSON.parse(fs.readFileSync(this.storagePath, 'utf-8'))
        this.memories = data.memories || []
        if (data.config) {
          this.config = { ...this.config, ...data.config }
        }
        // 更新佐证
        this.updateCorroboration()
      }
    } catch (err) {
      // 🔧 P0 修复（静默覆盖整个记忆库）
      // 旧实现：解析失败 → this.memories 保持 []，只打一条 warn。
      // 而 addMemory 等操作末尾会无条件 this.save()，
      // 于是**任何一条新记忆都会把整个佐证记忆库覆盖成只剩它**。
      // 佐证评分、确认状态、outdated 标记全部丢失，且不可恢复。
      //
      // 现在：备份原文 + 抛错。抛错后调用方不会走到 save，
      // 原文件保持原样，用户还能手动抢救。
      const backup = this.storagePath + '.corrupted'
      try {
        if (fs.existsSync(this.storagePath) && !fs.existsSync(backup)) {
          fs.copyFileSync(this.storagePath, backup)
        }
        console.error(
          `[MemoryEvidence] 佐证记忆库已损坏，原文备份至 ${backup}。` +
          '为避免覆盖既有记忆，本次不写入。'
        )
      } catch { /* 备份失败也必须继续抛错 */ }
      throw new Error(`MemoryEvidence: 记忆库已损坏（备份于 ${backup}），已中止写入`)
    }
  }

  private save(): void {
    // 🔧 写入前滚动备份一份（保留最近 3 份）。
    // 即使是正常路径下的意外覆盖（如某个 bug 写入了残缺数据），
    // 用户也有机会从备份捞回——这个库是长期积累的，不可再生。
    try {
      if (fs.existsSync(this.storagePath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        fs.copyFileSync(this.storagePath, `${this.storagePath}.bak.${stamp}`)
        const baks = fs.readdirSync(path.dirname(this.storagePath))
          .filter(f => f.startsWith(path.basename(this.storagePath) + '.bak.'))
          .sort()
        for (const old of baks.slice(0, Math.max(0, baks.length - 3))) {
          try { fs.unlinkSync(path.join(path.dirname(this.storagePath), old)) } catch { /* ignore */ }
        }
      }
    } catch { /* 备份失败不阻塞保存 */ }
    try {
      fs.writeFileSync(this.storagePath, JSON.stringify({
        memories: this.memories,
        config: this.config,
      }, null, 2), 'utf-8')
    } catch (err) {
      console.error('[MemoryEvidence] 保存失败:', err)
    }
  }

  /** 获取统计摘要 */
  getStats() {
    const total = this.memories.length
    const confirmed = this.memories.filter(m => m.status === 'confirmed').length
    const pending = this.memories.filter(m => m.status === 'pending').length
    const avgScore = total > 0
      ? this.memories.reduce((sum, m) => sum + m.compositeScore, 0) / total
      : 0

    return { total, confirmed, pending, avgScore, outdated: total - confirmed - pending }
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _evidence: MemoryEvidenceEngine | null = null

export function getMemoryEvidence(): MemoryEvidenceEngine {
  if (!_evidence) {
    _evidence = new MemoryEvidenceEngine()
  }
  return _evidence
}
