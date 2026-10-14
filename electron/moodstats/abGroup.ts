// ============================================================
// moodstats/abGroup.ts — 情绪门控 A/B 实验分组
//
// 【实验设计（刻意保守）】
//   · 默认关闭（enabled=false）：只观测、不干预。用户在面板里手动开启后才实验。
//   · 开启后，同一用户稳定分到 treatment（门控正常）或 control（门控临时关闭）。
//   · control 组**不应用门控但照常记录** —— 这是本实验唯一的干预手段，
//     对照的问题是：「关掉这个安全收紧机制，失败率会不会变好？」
//
// 【为什么 control 组要在 UI 上红色警告】
//   emotionGating 是**收紧**机制，关掉它不是「解锁能力」，
//   而是「焦虑/疲劳时也敢删文件、发邮件了」。这个风险必须亮出来，
//   不能让用户以为对照组是「更高级的体验」。
//
// 【稳定分组怎么实现】
//   首次使用时生成一个随机 userId 并持久化；之后对 userId 做 FNV-1a 哈希
//   取奇偶 —— 同一用户永远在同一组。退出实验（optOut）不会换组，
//   只是停止干预并停止标记；重新开启后分组不变（否则 A/B 会污染）。
//
// 【不碰 emotionGating 代码本身】
//   本类只提供「门控应该开还是关」的决议；现有链路读的是
//   readFeatureFlag('emotionGating', true)。集成接线时在那个读取点
//   套一层 resolveGateFeature(flag) 即可（见 register.ts 注释）。
// ============================================================

import type { GroupTag } from './types'

export type ExpGroup = 'treatment' | 'control'

export interface AbGroupState {
  /** 实验是否开启（默认 false = 仅观测） */
  enabled: boolean
  /** 稳定用户 id（首次生成后持久化） */
  userId: string
  /** 分组（首次生成时按哈希定） */
  group: ExpGroup
  /** 用户已退出实验 */
  optedOut: boolean
}

// ═══════════════════════════════════════════════════════════
// 持久化适配（可注入；默认走 JSON 文件，失败降级为纯内存）
// ═══════════════════════════════════════════════════════════

export interface AbGroupPersistence {
  read(): Partial<AbGroupState> | null
  write(s: AbGroupState): void
}

export function jsonFilePersistence(filePath: string): AbGroupPersistence {
  return {
    read() {
      try {
        const fs = require('fs')
        if (!fs.existsSync(filePath)) {return null}
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<AbGroupState>
      } catch {
        return null
      }
    },
    write(s: AbGroupState) {
      try {
        const fs = require('fs')
        const path = require('path')
        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
        fs.writeFileSync(filePath, JSON.stringify(s, null, 2), 'utf8')
      } catch { /* 持久化失败 → 本次会话内存态继续，不阻断实验 */ }
    },
  }
}

// ═══════════════════════════════════════════════════════════
// 分组核心
// ═══════════════════════════════════════════════════════════

/** FNV-1a 32bit —— 不引依赖，分组只需要「稳定且近似均匀」 */
export function fnv1aHash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function makeUserId(random: () => number): string {
  const bytes = Array.from({ length: 8 }, () =>
    Math.floor(random() * 256).toString(16).padStart(2, '0')).join('')
  return `u_${bytes}`
}

function decideGroup(userId: string): ExpGroup {
  return fnv1aHash(userId) % 2 === 0 ? 'treatment' : 'control'
}

export class AbGroup {
  private state: AbGroupState
  private readonly persistence: AbGroupPersistence
  private readonly random: () => number

  constructor(opts: {
    persistence?: AbGroupPersistence
    random?: () => number
    /** 测试用：直接给定初始态 */
    initial?: Partial<AbGroupState>
  } = {}) {
    this.persistence = opts.persistence ?? {
      read: () => null,
      write: () => { /* 内存态 */ },
    }
    this.random = opts.random ?? Math.random
    const stored = this.persistence.read() ?? {}
    this.state = {
      enabled: opts.initial?.enabled ?? stored.enabled ?? false,
      userId: opts.initial?.userId ?? stored.userId ?? makeUserId(this.random),
      group: opts.initial?.group ?? stored.group ?? decideGroup(
        opts.initial?.userId ?? stored.userId ?? '',
      ),
      optedOut: opts.initial?.optedOut ?? stored.optedOut ?? false,
    }
    // initial.group 显式给了就以它为准；没给则用（可能新生成的）userId 重算
    if (!opts.initial?.group && !stored.group) {
      this.state.group = decideGroup(this.state.userId)
    }
    this.persist()
  }

  private persist(): void {
    try { this.persistence.write(this.state) } catch { /* 内存态继续 */ }
  }

  /** 快照上打的分组标签：实验未开 / 已退出 → 'off' */
  currentGroup(): GroupTag {
    if (!this.state.enabled || this.state.optedOut) {return 'off'}
    return this.state.group
  }

  /** 实验是否在运行 */
  isRunning(): boolean {
    return this.state.enabled && !this.state.optedOut
  }

  /** 当前是否为对照组（= 应该关掉门控的那组） */
  isControl(): boolean {
    return this.isRunning() && this.state.group === 'control'
  }

  /**
   * 门控特性开关的实际生效值。
   *
   * 接线语义：现有代码 `readFeatureFlag('emotionGating', true)` 的结果
   * 传进来，本函数只在「实验运行中且当前用户是对照组」时返回 false。
   * 其余情况原样透传 —— 干预面被压到最小。
   */
  resolveGateFeature(flag: boolean): boolean {
    if (!this.isRunning()) {return flag}
    if (this.state.group === 'control') {return false}
    return flag
  }

  /** 开启实验（首次开启才定组；之后不变） */
  enableExperiment(): void {
    this.state.enabled = true
    this.persist()
  }

  /** 关闭实验（回到只观测） */
  disableExperiment(): void {
    this.state.enabled = false
    this.persist()
  }

  /** 一键退出：停止干预、停止标记，但保留 userId/group 不重洗 */
  optOut(): void {
    this.state.optedOut = true
    this.persist()
  }

  /** 重新加入（面板里「我还想参与」） */
  rejoin(): void {
    this.state.optedOut = false
    this.persist()
  }

  snapshot(): AbGroupState {
    return { ...this.state }
  }
}

/** 工厂：默认持久化到数据目录 */
export function createAbGroup(opts: { filePath?: string } = {}): AbGroup {
  const path = require('path')
  const os = require('os')
  const filePath = opts.filePath ?? path.join(
    process.env.LUMINA_DATA_DIR || path.join(os.homedir(), '.lumina'),
    'moodstats-ab.json',
  )
  return new AbGroup({ persistence: jsonFilePersistence(filePath) })
}
