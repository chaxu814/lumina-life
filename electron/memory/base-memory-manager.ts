// ============================================================
// memory/base-memory-manager.ts — 可插拔记忆管理器基类
//
// 借鉴 QwenPaw BaseMemoryManager 设计：
//   - 定义抽象接口，记忆后端可切换
//   - 生命周期：start → use → close
//   - 统一的记忆搜索接口
//
// 现有实现：
//   - MemoryStoreManager — SQLite 三层记忆（事实/反思/人格）
// 未来可扩展：
//   - VectorMemoryManager — 向量语义检索
//   - CloudMemoryManager — 云端记忆同步
// ============================================================

// ═══════════════════════════════════════════════════════════
// 统一记忆条目（替代旧版分散的类型）
// ═══════════════════════════════════════════════════════════

export interface MemoryEntry {
  id: string
  content: string
  timestamp: number
  tags: string[]
  importance: number // 0-1
  source: 'user' | 'agent' | 'system' | 'team'
  agentId?: string
  metadata?: Record<string, any>
}

export interface MemorySearchOptions {
  query: string
  maxResults?: number
  minScore?: number
  tags?: string[]
  agentId?: string
  category?: string
}

export interface MemorySearchResult {
  entry: MemoryEntry
  score: number
  snippet: string
}

// ═══════════════════════════════════════════════════════════
// 压缩结果
// ═══════════════════════════════════════════════════════════

export interface CompactionResult {
  /** 压缩后的摘要文本 */
  summary: string
  /** 压缩前消息数 */
  originalCount: number
  /** 压缩后保留消息数 */
  retainedCount: number
  /** 压缩前 token 估算 */
  tokensBefore: number
  /** 压缩后 token 估算 */
  tokensAfter: number
  /** 是否实际执行了压缩 */
  compacted: boolean
}

// ═══════════════════════════════════════════════════════════
// 记忆 System Prompt 生成结果
// ═══════════════════════════════════════════════════════════

export interface MemoryPromptResult {
  /** 注入到 system prompt 的记忆文本 */
  promptText: string
  /** 包含的记忆条目数 */
  entryCount: number
  /** 记忆类型 */
  categories: string[]
}

// ═══════════════════════════════════════════════════════════
// BaseMemoryManager — 抽象基类
// ═══════════════════════════════════════════════════════════

export abstract class BaseMemoryManager {
  /** 工作目录 */
  protected workingDir: string

  /** Agent ID */
  protected agentId: string

  /** 是否已初始化 */
  protected _initialized = false

  constructor(workingDir: string, agentId: string) {
    this.workingDir = workingDir
    this.agentId = agentId
  }

  // ═════════════════════════════════════════════════════════
  // 生命周期
  // ═════════════════════════════════════════════════════════

  /** 初始化存储后端 */
  abstract start(): Promise<void>

  /** 关闭并释放资源 */
  abstract close(): Promise<boolean>

  /** 是否已初始化 */
  get initialized(): boolean {
    return this._initialized
  }

  // ═════════════════════════════════════════════════════════
  // 记忆读写
  // ═════════════════════════════════════════════════════════

  /** 保存一条记忆 */
  abstract saveEntry(entry: Omit<MemoryEntry, 'id'>): Promise<string>

  /** 更新一条记忆 */
  abstract updateEntry(id: string, updates: Partial<MemoryEntry>): Promise<boolean>

  /** 删除一条记忆 */
  abstract deleteEntry(id: string): Promise<boolean>

  /** 获取单条记忆 */
  abstract getEntry(id: string): Promise<MemoryEntry | null>

  /** 语义搜索记忆 */
  abstract search(options: MemorySearchOptions): Promise<MemorySearchResult[]>

  /** 列出所有记忆 */
  abstract listEntries(options?: {
    tags?: string[]
    agentId?: string
    limit?: number
    offset?: number
  }): Promise<MemoryEntry[]>

  // ═════════════════════════════════════════════════════════
  // 对话压缩
  // ═════════════════════════════════════════════════════════

  /**
   * 压缩对话消息为结构化摘要
   *
   * @param messages 要压缩的消息列表
   * @param options 压缩选项
   * @returns 压缩结果
   */
  abstract compactMessages(
    messages: Array<{ role: string; content: string }>,
    options?: {
      keepRecent?: number
      maxTokens?: number
    },
  ): Promise<CompactionResult>

  // ═════════════════════════════════════════════════════════
  // System Prompt 生成
  // ═════════════════════════════════════════════════════════

  /**
   * 生成用于注入 system prompt 的记忆文本
   *
   * @param options 筛选选项
   * @returns 记忆 prompt 结果
   */
  abstract getMemoryPrompt(options?: {
    tags?: string[]
    maxEntries?: number
    includePersona?: boolean
  }): Promise<MemoryPromptResult>

  // ═════════════════════════════════════════════════════════
  // 辅助方法
  // ═════════════════════════════════════════════════════════

  /** 生成唯一 ID */
  protected generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  }

  /** 估算文本的 token 数（简单近似：中文 ~1.5 字符/token，英文 ~4 字符/token） */
  protected estimateTokens(text: string): number {
    if (!text) {return 0}
    let tokens = 0
    for (const char of text) {
      if (/[\u4e00-\u9fff]/.test(char)) {
        tokens += 0.67 // 中文字符 ~1.5 字符/token
      } else if (/\s/.test(char)) {
        tokens += 0.25 // 空白
      } else {
        tokens += 0.25 // 英文字符 ~4 字符/token
      }
    }
    return Math.ceil(tokens)
  }
}

// ═══════════════════════════════════════════════════════════
// 防重入保护的压缩守卫
// ═══════════════════════════════════════════════════════════

export class CompactionGuard {
  private _running = false
  private _lastCompactionTime = 0
  private _minIntervalMs: number

  /**
   * @param minIntervalMs 两次压缩之间的最小间隔（毫秒），防止频繁压缩
   */
  constructor(minIntervalMs = 5000) {
    this._minIntervalMs = minIntervalMs
  }

  /**
   * 尝试获取压缩锁
   * @returns true 表示可以执行压缩，false 表示正在压缩中或间隔太短
   */
  acquire(): boolean {
    if (this._running) {
      console.warn('[CompactionGuard] re-entrancy prevented')
      return false
    }

    const now = Date.now()
    if (now - this._lastCompactionTime < this._minIntervalMs) {
      console.log('[CompactionGuard] too soon since last compaction')
      return false
    }

    this._running = true
    return true
  }

  /** 释放压缩锁 */
  release(): void {
    this._lastCompactionTime = Date.now()
    this._running = false
  }

  /** 强制重置（异常恢复用） */
  reset(): void {
    this._running = false
  }
}
