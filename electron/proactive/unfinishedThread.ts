// ============================================================
// proactive/unfinishedThread.ts — 🧵 未答话头（她问了、用户还没接）
//
// 真人朋友聊天的生命力在于「话会接得住」：她问了一句「今天吃啥呀？」，
// 用户过 20 分钟才回，她应该把这事记着、下次自然接上，而不是假装没问过。
// 本模块只记一条「悬而未决的问题」：
//   - record(question)  她主动问出一个问句 → 记下
//   - consume()        用户回话后取出并清除（orchestrator 拿到后注入上下文）
//   - isQuestion(text) 是不是问句（粗粒度启发式）
// 持久化到 userData/proactive-unfinished.json；Electron 不可用（单测）纯内存。
// ============================================================

import { app } from 'electron'
import fs from 'fs'
import path from 'path'

const FILE_NAME = 'proactive-unfinished.json'

/** 是不是问句：句尾是 ?/？/吗/呢/吧/嘛，或句中含「呢/吗」 */
export function isQuestion(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  if (/[?？吗呢吧嘛]$/.test(t)) return true
  return /[呢吗]/.test(t)
}

interface StoredThread {
  question: string
  askedAt: number
}

function isElectronReady(): boolean {
  try {
    return !!app && typeof app.getPath === 'function' && !!app.getPath('userData')
  } catch {
    return false
  }
}

function threadPath(): string | null {
  if (!isElectronReady()) return null
  return path.join(app.getPath('userData'), FILE_NAME)
}

/** 未答话头存储（单条：同一时刻最多挂着一个悬而未决的问题） */
export class UnfinishedThreadStore {
  private current: StoredThread | null = null
  private loaded = false

  /** 她问了一个问题，记下来（覆盖旧的话头） */
  record(question: string, askedAt: number = Date.now()): void {
    const q = (question || '').trim()
    if (!q) return
    this.current = { question: q, askedAt }
    this.persist()
  }

  /** 取出当前话头并清除（用户回答/她决定翻篇时调用）；没有则返回 null */
  consume(): string | null {
    const q = this.current ? this.current.question : null
    this.current = null
    this.persist()
    return q
  }

  /** 当前是否挂着话头（不清除） */
  peek(): string | null {
    this.ensureLoaded()
    return this.current ? this.current.question : null
  }

  /** 清除话头（用户明确回答/翻篇），不取值 */
  clear(): void {
    this.current = null
    this.persist()
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const p = threadPath()
      if (p && fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (raw && typeof raw.question === 'string' && raw.question) {
          this.current = { question: raw.question, askedAt: Number(raw.askedAt) || Date.now() }
        }
      }
    } catch {
      this.current = null
    }
  }

  /** 持久化到 userData（Electron 不可用时静默降级） */
  persist(): void {
    this.ensureLoaded()
    try {
      const p = threadPath()
      if (!p) return
      fs.writeFileSync(p, JSON.stringify(this.current, null, 2), 'utf8')
    } catch { /* 不阻塞主链路 */ }
  }
}
