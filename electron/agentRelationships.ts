// ============================================================
// agentRelationships.ts — Agent 之间的动态关系（v0.1.1）
//
// 旧版 getAllRelationships() 返回的是写死的常量，亲密度不会随互动变化。
// 本模块让关系数据真正"活"起来：
//   - 以真实事件为驱动：委托成功/失败（delegationManager）、团队群聊（socialEngine）
//   - 亲密度(affinity) / 信任(trust) / 协作数 / 争执数 按事件增减，并做 0~100 钳制
//   - 持久化到 userData/lumina-relationships.json，重启后保留
//   - 在测试环境（无 Electron app）下自动退化为纯内存，不影响单测
// ============================================================

import fs from 'fs'
import path from 'path'

export interface AgentRelationship {
  pairKey: string
  agentA: string
  agentB: string
  type: string
  affinity: number
  trust: number
  argumentCount: number
  collaborationCount: number
  lastInteraction: string
  evolutionLog: string[]
}

export type InteractionKind = 'delegation_ok' | 'delegation_fail' | 'chat' | 'disagreement'

const MAX_LOG = 40

/** 初始基线：沿用旧常量作为"出厂关系"，之后随真实互动演化 */
const SEED: Array<Omit<AgentRelationship, 'pairKey' | 'lastInteraction' | 'evolutionLog'>> = [
  { agentA: 'lumina', agentB: 'recha', type: 'colleague', affinity: 85, trust: 90, argumentCount: 12, collaborationCount: 156 },
  { agentA: 'lumina', agentB: 'yak', type: 'mentor', affinity: 75, trust: 80, argumentCount: 5, collaborationCount: 89 },
  { agentA: 'recha', agentB: 'yak', type: 'colleague', affinity: 60, trust: 70, argumentCount: 20, collaborationCount: 67 },
]

const clamp100 = (v: number): number => Math.max(0, Math.min(100, Math.round(v)))

/** 稳定的两人关系键（顺序无关：lumina-yak 与 yak-lumina 是同一条） */
function pairKeyOf(a: string, b: string): string {
  return [a, b].sort().join('-')
}

class RelationshipStore {
  private rels = new Map<string, AgentRelationship>()
  private loaded = false
  private saveTimer: NodeJS.Timeout | null = null
  private storePath: string | null = null

  constructor() {
    this.load()
  }

  private resolvePath(): string | null {
    try {
      // 惰性 require，避免在无 Electron 的测试环境（vitest）里直接崩；
      // ESM 环境下 require 不可用 → 退化为纯内存
      const electronMod = typeof require === 'function' ? require('electron') : null
      const app = electronMod?.app
      const dir = app?.getPath ? app.getPath('userData') : process.cwd()
      return path.join(dir, 'lumina-relationships.json')
    } catch {
      return null
    }
  }

  private load(): void {
    if (this.loaded) {return}
    this.loaded = true
    this.storePath = this.resolvePath()

    // 先放种子数据
    for (const s of SEED) {
      const key = pairKeyOf(s.agentA, s.agentB)
      this.rels.set(key, {
        ...s,
        pairKey: key,
        lastInteraction: new Date().toISOString(),
        evolutionLog: [],
      })
    }

    if (!this.storePath) {return}
    try {
      if (!fs.existsSync(this.storePath)) {return}
      const raw = fs.readFileSync(this.storePath, 'utf-8')
      const data = JSON.parse(raw) as { pairs?: AgentRelationship[] }
      if (Array.isArray(data.pairs)) {
        for (const p of data.pairs) {
          if (!p || !p.agentA || !p.agentB) {continue}
          const key = pairKeyOf(p.agentA, p.agentB)
          this.rels.set(key, { ...p, pairKey: key })
        }
      }
    } catch {
      // 存档损坏时回退到种子数据，不影响运行
    }
  }

  /** 防抖落盘，避免一次群聊/流水线高频写盘 */
  private scheduleSave(): void {
    if (!this.storePath) {return}
    if (this.saveTimer) {clearTimeout(this.saveTimer)}
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, 800)
  }

  private saveNow(): void {
    if (!this.storePath) {return}
    try {
      const pairs = this.getAll()
      fs.writeFileSync(this.storePath, JSON.stringify({ version: 1, pairs }, null, 2), 'utf-8')
    } catch {
      /* 写盘失败不影响内存中的关系演化 */
    }
  }

  private ensure(a: string, b: string): AgentRelationship {
    const key = pairKeyOf(a, b)
    let rel = this.rels.get(key)
    if (!rel) {
      // 动态成员（如实习生）之间的关系：从中性基线开始
      rel = {
        pairKey: key,
        agentA: [a, b].sort()[0],
        agentB: [a, b].sort()[1],
        type: 'colleague',
        affinity: 50,
        trust: 50,
        argumentCount: 0,
        collaborationCount: 0,
        lastInteraction: new Date().toISOString(),
        evolutionLog: [],
      }
      this.rels.set(key, rel)
    }
    return rel
  }

  /**
   * 记录一次两人之间的互动，驱动关系演化。
   * @param a 成员 A
   * @param b 成员 B
   * @param kind 互动类型
   * @param taskType 可选，委托任务类型（用于识别"建设性唱反调"）
   */
  recordInteraction(a: string, b: string, kind: InteractionKind, taskType?: string): void {
    if (!a || !b || a === b) {return}
    const rel = this.ensure(a, b)
    const now = new Date().toISOString()
    rel.lastInteraction = now

    let note = ''
    switch (kind) {
      case 'delegation_ok':
        rel.collaborationCount += 1
        rel.trust = clamp100(rel.trust + 1)
        rel.affinity = clamp100(rel.affinity + 1.5)
        // 风险评估 / 反方论证属于"建设性唱反调"：争一次，但更可信
        if (taskType === 'counter_argument' || taskType === 'risk_assess') {
          rel.argumentCount += 1
          rel.trust = clamp100(rel.trust + 0.5)
          rel.affinity = clamp100(rel.affinity - 0.5)
          note = `协作 #${rel.collaborationCount}（含一次专业分歧，${taskType}）`
        } else {
          note = `成功协作 #${rel.collaborationCount}（${taskType || 'delegate'}）`
        }
        break
      case 'delegation_fail':
        rel.trust = clamp100(rel.trust - 2)
        rel.affinity = clamp100(rel.affinity - 0.5)
        note = '委托失败，信任 -2'
        break
      case 'chat':
        // 群聊是低成本的"刷脸"，亲密度微涨，不刷协作数
        rel.affinity = clamp100(rel.affinity + 0.3)
        note = '参与了一次团队群聊'
        break
      case 'disagreement':
        rel.argumentCount += 1
        rel.affinity = clamp100(rel.affinity - 0.5)
        rel.trust = clamp100(rel.trust + 0.5)
        note = `发生分歧 #${rel.argumentCount}`
        break
    }

    if (note) {
      const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
      rel.evolutionLog.push(`[${stamp}] ${a} ↔ ${b}：${note}`)
      if (rel.evolutionLog.length > MAX_LOG) {rel.evolutionLog.splice(0, rel.evolutionLog.length - MAX_LOG)}
    }

    this.scheduleSave()
  }

  /** 返回所有关系（旧版 getAllRelationships 的同构格式），按 pairKey 排序 */
  getAll(): AgentRelationship[] {
    return Array.from(this.rels.values()).sort((x, y) => x.pairKey.localeCompare(y.pairKey))
  }

  /** 测试 / 设置页用：清空并回到出厂种子状态（同时删除持久化文件） */
  reset(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.storePath) {
      try { fs.unlinkSync(this.storePath) } catch { /* 文件不存在即可 */ }
    }
    this.rels.clear()
    this.loaded = false
    this.load()
  }
}

let _instance: RelationshipStore | null = null

export function getRelationshipStore(): RelationshipStore {
  if (!_instance) {_instance = new RelationshipStore()}
  return _instance
}
