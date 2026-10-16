// ============================================================
// moodstats/abGroup.ts — 情绪门控 A/B 实验分组
//
// 【实验设计（刻意保守）】
//   · 默认关闭（enabled=false）：只观测、不干预。用户在面板里手动开启后才实验。
//   · 开启后，同一用户稳定分到 treatment（门控正常）或 control（门控临时关闭）。
//   · control 组**不应用门控但照常记录** —— 这是本实验唯一的干预手段，
//     对照的问题是：「关掉这个安全收紧机制，失败率会不会变好？」
//
// 【为什么这**不是** A/B 对照实验（发布前必须写在这里）】
//   分组是对 userId 做 FNV-1a 哈希得到的**稳定单值**：同一台安装里，
//   treatment 与 control **永远不可能同时非空**。
//   于是 compareGroups() 的最好结果也只是「off + 一个臂」——
//   用户在面板上看到的其实是**同一个人、同一段时间的前后对比**，
//   而这段时间里他的作息、任务难度、心情、换没换工作全都在变。
//   这些混杂因素无法被任何统计手段扣掉：样本量再大也没用，
//   因为缺的不是样本，是「同时存在两组」这件事本身。
//
//   要做真正的 A/B，需要多个**互相独立**的安装同时跑（多用户、随机分群）。
//   本项目是单机单用户 App，拿不到这个前提，所以：
//     · UI 不许自称「A/B 对照」（措辞统一由 stats.ts 的 comparisonDesign 出）；
//     · 只做「记录 + 列数字」，绝不写「门控有效/无效」。
//
// 【为什么留一个「手动换组」而不是自动随机】
//   自动重洗会让同一个用户白天在 treatment、晚上在 control 来回跳，
//   两臂的数据互相污染，比只跑一个臂更糟。所以默认稳定、绝不自动重洗。
//   但「永不换组」意味着用户**主动想跑另一臂**时没有出路，
//   于是提供 rerandomize()：由用户显式调用、记录时间戳，
//   换组前后的两段数据仍然按时间前后对照（crossover）呈现，
//   并在措辞里明确说明它依然被时间完全混杂。
//
// 【为什么 control 组要在 UI 上红色警告】
//   emotionGating 是**收紧**机制，关掉它不是「解锁能力」，
//   而是「焦虑/疲劳时也敢删文件、发邮件了」。这个风险必须亮出来，
//   不能让用户以为对照组是「更高级的体验」。
//
// 【稳定分组怎么实现】
//   首次使用时生成一个随机 userId 并持久化；之后对 userId 做 FNV-1a 哈希
//   取奇偶 —— 同一用户永远在同一组。退出实验（optOut）不会换组，
//   只是停止干预并停止标记；重新开启后分组不变（否则前后两段会互相污染）。
//   只有用户显式调用 rerandomize() 才会换组，且换组会写进 history。
//
// 【不碰 emotionGating 代码本身】
//   本类只提供「门控应该开还是关」的决议；现有链路读的是
//   readFeatureFlag('emotionGating', true)。集成接线时在那个读取点
//   套一层 resolveGateFeature(flag) 即可（见 register.ts 注释）。
// ============================================================

import type { GroupTag } from './types'

export type ExpGroup = 'treatment' | 'control'

/**
 * 一次分组任期的记录。
 *
 * 【为什么要留 history】
 * 单机单用户永远只有一个臂，「对照组」只能靠用户**主动换组**才可能出现。
 * 换组一旦发生，两段数据分别属于不同时间区间，
 * 所以必须记下 `since`，否则事后无法把快照切回正确的臂。
 * 只留当前 group 是不够的 —— 那等于把第一段数据悄悄改写成第二段的组别。
 */
export interface AssignmentRecord {
  group: ExpGroup
  /** 本段任期开始的 epoch ms；0 = 未知（老数据 / 迁移来的） */
  since: number
}

export interface AbGroupState {
  /** 实验是否开启（默认 false = 仅观测） */
  enabled: boolean
  /** 稳定用户 id（首次生成后持久化） */
  userId: string
  /** 分组（首次生成时按哈希定） */
  group: ExpGroup
  /** 用户已退出实验 */
  optedOut: boolean
  /** 历次分组任期（含当前段）。老状态没有这个字段时按当前 group 补一条 */
  history: AssignmentRecord[]
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
  private readonly now: () => number

  constructor(opts: {
    persistence?: AbGroupPersistence
    random?: () => number
    /** 测试用：冻结时间（history.since / 换组时间戳） */
    now?: () => number
    /** 测试用：直接给定初始态 */
    initial?: Partial<AbGroupState>
  } = {}) {
    this.persistence = opts.persistence ?? {
      read: () => null,
      write: () => { /* 内存态 */ },
    }
    this.random = opts.random ?? Math.random
    this.now = opts.now ?? Date.now
    const stored = this.persistence.read() ?? {}
    this.state = {
      enabled: opts.initial?.enabled ?? stored.enabled ?? false,
      userId: opts.initial?.userId ?? stored.userId ?? makeUserId(this.random),
      group: opts.initial?.group ?? stored.group ?? decideGroup(
        opts.initial?.userId ?? stored.userId ?? '',
      ),
      optedOut: opts.initial?.optedOut ?? stored.optedOut ?? false,
      history: opts.initial?.history ?? stored.history ?? [],
    }
    // initial.group 显式给了就以它为准；没给则用（可能新生成的）userId 重算
    if (!opts.initial?.group && !stored.group) {
      this.state.group = decideGroup(this.state.userId)
    }
    // 老状态（接线前的持久化文件）没有 history：用当前 group 补一条起点未知的记录。
    // 宁可标「未知起点」也不要假装知道起点 —— 后者会让 crossover 的分段失真。
    if (!Array.isArray(this.state.history) || this.state.history.length === 0) {
      this.state.history = [{ group: this.state.group, since: 0 }]
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

  // ═══════════════════════════════════════════════════════════
  // 手动换组（唯一能产生第二个臂的入口）
  // ═══════════════════════════════════════════════════════════

  /**
   * 当前是否允许换组。
   *
   * 为什么要有这个门：换组只有两个正当理由 ——
   *   ① 用户已经跑完一段、想换到另一个臂把另一半也试一遍；
   *   ② 用户已退出实验（此时 currentGroup() 恒为 'off'，换组毫无意义）。
   * 所以「未开启」和「已退出」两种情况下都必须挡住，
   * 否则会写出一条没人看得懂的 history，却什么也没发生。
   */
  canRandomize(): boolean {
    return this.state.enabled && !this.state.optedOut
  }

  /**
   * 用户显式换组（crossover）。
   *
   * 【为什么不自动重洗】
   * 自动重洗会让同一个用户在不同小时落在不同臂上，两臂数据互相污染，
   * 比只跑一个臂更糟。所以只有用户点了按钮才换。
   *
   * 【本函数不做的事】
   * 不改 enabled、不改 optedOut、不碰 userId —— 换组只是换臂，
   * 顺带把这次换组记进 history，让事后能把快照按时间切回正确的臂。
   */
  rerandomize(): ExpGroup | null {
    if (!this.canRandomize()) {return null}
    // 用注入的 random 而不是再哈希 userId：换组必须是「一次新的抽取」，
    // 复用同一个哈希只会得到同一个结果，看起来像功能没生效。
    const next: ExpGroup = this.random() < 0.5 ? 'treatment' : 'control'
    if (next !== this.state.group) {
      this.state.history.push({ group: next, since: this.now() })
    }
    this.state.group = next
    this.persist()
    return next
  }

  /** 当前任期（哪一臂、从什么时候开始）。since=0 表示起点未知 */
  currentAssignment(): AssignmentRecord {
    const last = this.state.history[this.state.history.length - 1]
    if (last && last.group === this.state.group) {return { ...last }}
    return { group: this.state.group, since: 0 }
  }

  /** 换过几次组（= history 里严格换臂的次数，不含首段） */
  assignmentCount(): number {
    return Math.max(0, this.state.history.length - 1)
  }

  /**
   * 两个臂是否都出现过。
   *
   * 只有返回 true 时，面板才允许把这段数据叫「前后换组对照」；
   * 否则它就是单臂数据，任何两列并排都是自欺欺人。
   */
  hasSeenBothArms(): boolean {
    return this.state.history.some(h => h.group === 'treatment') &&
      this.state.history.some(h => h.group === 'control')
  }

  snapshot(): AbGroupState {
    return { ...this.state, history: this.state.history.map(h => ({ ...h })) }
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
