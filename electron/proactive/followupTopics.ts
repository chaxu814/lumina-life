// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// proactive/followupTopics.ts — 📮 该主动提起的旧事（记忆反思）
//
// 真人朋友不会把昨天的事当没发生：聊到一半的事、对方随口提过的计划，
// 过一两天她应该自然地「诶对了，上次那个…」捡起来。
// 每天 04:00 用 LLM 从近期记忆里合成 3 条「值得主动提起的旧事」，
// 存到 userData/proactive-followups.json；
// 主动说话前注入前 3 条；问过 / 超过 7 天自动清除。
// 持久化独立 json，不动 memoryStore 表结构。
// ============================================================

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { chatComplete } from './resolveProactiveLLM'
import { getMemoryStore } from '../memory/memoryStore'

const FILE_NAME = 'proactive-followups.json'
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 天过期
const RETAIN = 3

export interface FollowupTopic {
  text: string
  createdAt: number
  asked: boolean
}

function isElectronReady(): boolean {
  try { return !!app && typeof app.getPath === 'function' && !!app.getPath('userData') } catch { return false }
}

function storePath(): string | null {
  if (!isElectronReady()) {return null}
  return path.join(app.getPath('userData'), FILE_NAME)
}

/** 从记忆素材合成 3 条「该提起的旧事」（可注入 LLM 调用便于测试） */
export async function synthesizeFollowups(
  llmCall?: (material: string) => Promise<string>,
): Promise<string[]> {
  // ── 取素材 ───────────────────────────────────
  let material = ''
  try {
    const store = getMemoryStore()
    const summaries = store.getRecentSummaries(20)
    const facts = store.searchFacts('', 10)
    material = [
      summaries.length ? '## 近期对话摘要\n' + summaries.map((s, i) => `[${i + 1}] ${s}`).join('\n') : '',
      facts.length ? '## 记住的事实\n' + facts.map(f => `- ${f.content}`).join('\n') : '',
    ].filter(Boolean).join('\n\n')
  } catch { return [] }
  if (!material.trim()) {return []}

  // ── 调 LLM ──────────────────────────────────
  const call = llmCall || ((mat: string) => chatComplete({
    system: `你是 Lumina 桌宠（猫娘）的记忆反思器。根据最近的对话摘要和事实，
挑出 3 条「过一两天她值得自然主动提起」的旧事（比如用户提过的计划、没说完的事、答应过的事）。
要求：
- 每条 10~25 字，是一句可以自然开口的话头
- 必须来自素材里真实出现过的内容，不要编
- 不要寒暄、不要客服腔
输出严格 JSON：{"topics":["话头1","话头2","话头3"]}，凑不够就给空数组`,
    user: mat,
    maxTokens: 200,
    temperature: 0.7,
    json: true,
  }))

  try {
    const raw = (await call(material)).trim()
    const m = raw.match(/\{[\s\S]*?\}/)
    if (!m) {return []}
    const obj = JSON.parse(m[0])
    if (Array.isArray(obj.topics)) {
      return obj.topics.filter((t: any) => typeof t === 'string' && t.trim()).slice(0, RETAIN)
    }
  } catch { /* 合成失败保持旧列表 */ }
  return []
}

/** followup 存储（持久化 + 7 天过期 + 问过清除） */
export class FollowupTopicsStore {
  private topics: FollowupTopic[] = []
  private loaded = false

  private ensureLoaded(): void {
    if (this.loaded) {return}
    this.loaded = true
    try {
      const p = storePath()
      if (p && fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (Array.isArray(raw)) {this.topics = raw.filter(t => t && typeof t.text === 'string')}
      }
    } catch { this.topics = [] }
  }

  private persist(): void {
    this.ensureLoaded()
    try {
      const p = storePath()
      if (!p) {return}
      fs.writeFileSync(p, JSON.stringify(this.topics, null, 2), 'utf8')
    } catch { /* 不阻塞 */ }
  }

  /** 用新合成的话题替换列表（每日 04:00 跑） */
  replaceWith(newTopics: string[], now: number = Date.now()): void {
    this.ensureLoaded()
    this.topics = newTopics.map(t => ({ text: t.trim(), createdAt: now, asked: false }))
    this.persist()
  }

  /** 取可用的前 N 条（未问过、未过期） */
  getActive(limit = 3, now: number = Date.now()): string[] {
    this.ensureLoaded()
    this.prune(now)
    return this.topics.filter(t => !t.asked).slice(0, limit).map(t => t.text)
  }

  /** 用户被问过/聊过这条 → 标记清除 */
  markAsked(text: string): void {
    this.ensureLoaded()
    const t = this.topics.find(x => x.text === text)
    if (t) { t.asked = true; this.persist() }
  }

  /** 清理：问过的 + 超过 7 天的 */
  prune(now: number = Date.now()): void {
    this.ensureLoaded()
    const before = this.topics.length
    this.topics = this.topics.filter(t => !t.asked && (now - t.createdAt) < MAX_AGE_MS)
    if (this.topics.length !== before) {this.persist()}
  }

  /** 单测用：清空内存+文件 */
  clearAll(): void {
    this.topics = []
    this.persist()
  }
}
