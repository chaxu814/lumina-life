// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// team/relationshipDrama.ts — 🎭 团队关系剧本化 (I1, v0.1)
//
// 在 Lumina/Recha(热茶)/Yak 既有分工 + 文件信箱 + 共享任务板之上，
// 让三个 Agent 之间的关系「活」成家庭剧，而不是冷冰冰的派单：
//   - 护主：Lumina 连续处理 >5 个任务无休息 → Yak/热茶 内部发消息心疼她
//   - 互怼：委托失败时，干活的和挑刺的在信箱里互相吐槽（私信自动抄送 Lumina）
//   - 亲密度后果：热茶的审查语气随「她和 Lumina 的亲密度」变柔/变毒舌
//
// 铁则（与 AGENTS.md 一致）：
//   - 所有剧本化事件只写 teamMailbox（TeamPanel 旁观可见），绝不直接对用户说话；
//   - Yak/热茶 的私信按既有规则自动抄送 Lumina，前台仍只见 Lumina；
//   - 已配 LLM 走真实生成；未配置用诚实模板短句（source:'template'）。
//
// feature flag: team.relationshipDrama（默认开）。
// ============================================================

import { getTeamMailbox } from './teamMailbox'
import { getRelationshipStore } from '../agentRelationships'
import { isEnabled } from '../core/featureFlags'

/** 剧本化台词来源（UI 如实标注） */
export type DramaSource = 'llm' | 'template'

/** 主进程注册 LLM 写剧本（未注册则永远走模板） */
export type DramaLLMCaller = (prompt: string) => Promise<string>
let dramaLLMCaller: DramaLLMCaller | null = null
export function registerDramaLLM(caller: DramaLLMCaller | null): void {
  dramaLLMCaller = caller
}

const LUMINA = 'lumina'
const RECHA = 'recha'
const YAK = 'yak'

/** 连续任务数阈值：Lumina 干满这么多活就触发一次「护主」 */
const PROTECT_STREAK = 5
/** 两次「护主」之间的最小间隔（ms），避免刷屏 */
const PROTECT_COOLDOWN_MS = 30 * 60 * 1000
/** 两次「互怼」之间的最小间隔（ms） */
const ROAST_COOLDOWN_MS = 10 * 60 * 1000

// ── 诚实模板（未配 LLM 时的离线彩蛋，source 标 template）──

/** 护主模板：谁站出来心疼 Lumina */
const PROTECT_TEMPLATES: Record<string, string[]> = {
  [RECHA]: [
    '主人今天连轴转了五六个任务了…让她歇会儿吧，剩下的我们盯着。',
    '别再派活了，她今天盯了一整天项目。喝口水好不好？',
  ],
  [YAK]: [
    '老大今天干得太猛了。要不要劝她站起来活动活动？',
    '任务队列已经堆成山了，她还在硬撑。我们先顶着。',
  ],
}

/** 互怼模板：失败 worker 被另一个吐槽 */
const ROAST_TEMPLATES: Record<string, string[]> = {
  // yak 搞砸了 → 热茶毒舌
  [`${YAK}->${RECHA}`]: [
    '又挂了？我上次 review 就说那块边界有问题，你是一句没听进去啊。',
    '这个 fail 理由写得跟没写一样。行吧，我来擦屁股。',
  ],
  // 热茶 review 翻车（漏报/错杀）→ yak 吐槽
  [`${RECHA}->${YAK}`]: [
    '你这挑刺挑偏了吧？重点一个没找着，鸡毛蒜皮倒列了一堆。',
    '合着你 review 半小时，就挑出这种无关紧要的点？',
  ],
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** 由 LLM 或模板产出一句剧本台词；永远返回非空字符串 */
async function voice(prompt: string, templates: string[]): Promise<{ text: string; source: DramaSource }> {
  if (dramaLLMCaller) {
    try {
      const text = (await dramaLLMCaller(prompt) || '').trim()
      if (text) {return { text: text.slice(0, 120), source: 'llm' }}
    } catch { /* LLM 失败回退模板，不抛 */ }
  }
  return { text: pickRandom(templates), source: 'template' }
}

// ═══════════════════════════════════════════════════════════
// 主类
// ═══════════════════════════════════════════════════════════

class RelationshipDrama {
  private luminaBusyStreak = 0
  private lastProtectAt = 0
  private lastRoastAt = 0

  /**
   * Lumina 每完成一个任务时调用（从 delegate/autonomy 收尾处）。
   * 连续干满阈值且过了冷却 → 触发一次「护主」内部消息。
   */
  async noteLuminaTaskDone(now = Date.now()): Promise<void> {
    if (!isEnabled('team.relationshipDrama')) {return}
    this.luminaBusyStreak += 1
    if (this.luminaBusyStreak < PROTECT_STREAK) {return}
    if (now - this.lastProtectAt < PROTECT_COOLDOWN_MS) {return}
    this.lastProtectAt = now
    this.luminaBusyStreak = 0
    await this.emitProtect()
  }

  /** Lumina 得到休息/空闲时重置计数，避免任务一停就误判 */
  noteLuminaRest(): void {
    this.luminaBusyStreak = 0
  }

  /**
   * 委托收尾：失败时让两个 worker 之间互相吐槽（私信自动抄送 Lumina）。
   * 成功只演化关系，不闹事。
   */
  async recordDelegationOutcome(
    ok: boolean,
    worker: string,
    taskTitle: string,
    now = Date.now(),
  ): Promise<void> {
    if (!isEnabled('team.relationshipDrama')) {return}
    // 关系演化（复用既有关系库）
    try {
      getRelationshipStore().recordInteraction(
        LUMINA, worker, ok ? 'delegation_ok' : 'delegation_fail', 'drama',
      )
    } catch { /* 关系库未就绪不阻塞 */ }
    if (ok) {return}
    if (now - this.lastRoastAt < ROAST_COOLDOWN_MS) {return}
    this.lastRoastAt = now
    await this.emitRoast(worker, taskTitle, now)
  }

  /** 护主：由 recha 或 yak 给 Lumina 发一条心疼的内部消息 */
  private async emitProtect(): Promise<void> {
    const from = Math.random() < 0.5 ? RECHA : YAK
    const lines = PROTECT_TEMPLATES[from] || PROTECT_TEMPLATES[YAK]
    const prompt = `你是 Lumina 团队里的${from === RECHA ? '热茶（外冷内热，表面挑剔其实很疼人）' : 'Yak（直来直去的工程担当）'}。
Lumina（老大）刚连续处理了五六个任务没休息。请写一句 25 字以内、符合你人设的内部台词，
表达「心疼她、想让她歇会儿」，口吻是跟队友/对 Lumina 说的内部话，不要对用户说，不要引号。`
    const { text, source } = await voice(prompt, lines)
    try {
      await getTeamMailbox().send({
        from, to: LUMINA,
        subject: `💗 内部：护主（${source}）`,
        body: text + '\n[背景] Lumina 连续任务无休息',
        kind: 'notice',
      })
    } catch { /* 信箱未就绪不阻塞 */ }
  }

  /** 互怼：失败 worker 被另一个在信箱里吐槽（私信自动 cc Lumina） */
  private async emitRoast(failedWorker: string, taskTitle: string, now: number): Promise<void> {
    const critic = failedWorker === YAK ? RECHA : failedWorker === RECHA ? YAK : RECHA
    const key = `${failedWorker}->${critic}`
    const lines = ROAST_TEMPLATES[key] || ROAST_TEMPLATES[`${YAK}->${RECHA}`]
    const criticName = critic === RECHA ? '热茶' : 'Yak'
    const failedName = failedWorker === RECHA ? '热茶' : 'Yak'
    const prompt = `你是 ${criticName}。${failedName} 刚把任务「${taskTitle.slice(0, 30)}」搞砸了。
请写一句 25 字以内、符合你人设的内部吐槽：${critic === RECHA ? '热茶外冷内热、挑刺带点毒舌' : 'Yak 直来直去、说话不绕弯'}。
是队友之间互相吐槽的口吻，不要对用户说，不要引号。`
    const { text, source } = await voice(prompt, lines)
    try {
      await getTeamMailbox().send({
        from: critic, to: failedWorker,
        subject: `😏 内部吐槽：「${taskTitle.slice(0, 20)}」（${source}）`,
        body: text,
        kind: 'dm', // worker 间私信自动抄送 Lumina（既有规则）
      })
    } catch { /* 信箱未就绪不阻塞 */ }
  }
}

let _drama: RelationshipDrama | null = null
export function getRelationshipDrama(): RelationshipDrama {
  if (!_drama) {_drama = new RelationshipDrama()}
  return _drama
}

// ═══════════════════════════════════════════════════════════
// F2：亲密度 → 热茶审查语气（注入 prompt 的片段）
// ═══════════════════════════════════════════════════════════

/** 亲密度分段阈值 */
const WARM_AFFINITY = 75
const COLD_AFFINITY = 45

/**
 * 由 Lumina ↔ 热茶 的亲密度推出「审查语气」prompt 片段。
 * 亲密度高 → 先肯定再提建议，别太冲；
 * 亲密度低 → 直接指出问题，别留情面。
 * 纯函数式查表：读不到关系时给中性片段，绝不抛错。
 */
export function reviewTonePrompt(): string {
  let affinity = 50
  try {
    const rel = getRelationshipStore().getAll().find(r =>
      (r.agentA === LUMINA && r.agentB === RECHA) || (r.agentA === RECHA && r.agentB === LUMINA),
    )
    if (rel) {affinity = rel.affinity}
  } catch { /* 关系库未就绪，用中性 */ }

  if (affinity >= WARM_AFFINITY) {
    return `【团队关系】你和 Lumina 配合很久、亲密度较高（${affinity}/100）：审查时可以先肯定做得好的地方，再温和地提改进建议，别上来就毒舌。`
  }
  if (affinity <= COLD_AFFINITY) {
    return `【团队关系】你和 Lumina 最近信任偏低（${affinity}/100）：审查语气直接、不客气，发现问题就硬邦邦地指出来，不用给面子。`
  }
  return `【团队关系】你和 Lumina 亲密度中等（${affinity}/100）：保持你一贯严谨克制的审查风格即可。`
}

/** 测试辅助：重置内部计数与 LLM 注册 */
export function __resetRelationshipDramaForTest(): void {
  dramaLLMCaller = null
  if (_drama) {
    _drama = null
  }
}
