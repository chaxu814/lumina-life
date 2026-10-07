// tests/emotionAudit.test.ts
//
// 情绪收紧可审计层的契约测试。
//
// 【为什么这个模块值得单独测】
// 它是**唯一一处「情绪能否决用户」的地方**。一旦这里出错，后果有两个方向，
// 而且都很严重：
//   · 记漏了 → 机制退化成黑箱，用户无法解释，只能关掉（护城河作废）
//   · 记错了 → 用户被误导去信任一个其实不可靠的判断
// 所以下面每条用例都在锁一个具体的不变量，而不是凑覆盖率。
import { describe, it, expect, beforeEach } from 'vitest'
import {
  EmotionAuditLog, GATE_RULES, __resetEmotionAuditLog,
  type EmotionGateRecord,
} from '../electron/orchestration/emotionAudit'
import { applyEmotionGate, ANXIETY_THRESHOLD, FATIGUE_THRESHOLD } from '../electron/orchestration/emotionGating'
import { frontendThreeToCore, anxietyFrom, type FrontendThree } from '../electron/pet/life/emotionCore'

/** 确定性的 id/时钟，让断言可复现 */
function newLog(): EmotionAuditLog {
  let t = 1_000_000
  return new EmotionAuditLog({
    now: () => (t += 1000),
    makeId: (_ts, seq) => `gate-${seq}`,
  })
}

const CALM: FrontendThree = { mood: 0.6, energy: 0.6, affinity: 0.5 }
/**
 * 焦虑高 + 情绪不稳 → 触发不可逆收紧。
 * 这组值是实测出来的：anxiety = -valence × arousal = 0.8 × 0.9 = 0.72 ≥ 0.35，
 * 且 valence -0.8 ≤ -0.1。不要随手改 —— 改了可能就不再触发，用例会失去意义。
 */
const ANXIOUS: FrontendThree = { mood: -0.8, energy: 0.9, affinity: 0.5 }
/** 疲劳高 → 触发重活收紧（valence > -0.1，所以不会误触焦虑规则） */
const TIRED: FrontendThree = { mood: 0.3, energy: -0.5, affinity: 0.5 }

describe('EmotionAuditLog', () => {
  beforeEach(() => { __resetEmotionAuditLog() })

  it('没有收紧就不记 —— 审计的价值在解释被拦下的，不是解释通过的', () => {
    const log = newLog()
    const gate = applyEmotionGate(['shell_exec', 'file_read'], CALM)
    expect(gate.gated).toBe(false)
    expect(log.record(gate, CALM)).toBeNull()
    expect(log.all()).toHaveLength(0)
  })

  it('记录包含可复算的情绪快照与命中的规则', () => {
    const log = newLog()
    const gate = applyEmotionGate(['shell_exec', 'file_write', 'web_search'], ANXIOUS)
    expect(gate.gated).toBe(true)

    const id = log.record(gate, ANXIOUS)
    expect(id).toBeTruthy()

    const r = log.get(id!)!
    expect(r.status).toBe('active')
    expect(r.rules).toContain('anxiety_irreversible')
    expect(r.suppressed.length).toBeGreaterThan(0)
    expect(r.suppressed.map(s => s.tool)).toContain('shell_exec')
    // 只记被收紧的，安全的 web_search 不该出现在名单里
    expect(r.suppressed.map(s => s.tool)).not.toContain('web_search')
    // 情绪快照必须带 anxiety，否则用户无法自己核对阈值
    expect(typeof r.emotion.anxiety).toBe('number')
    expect(r.emotion.anxiety).toBeGreaterThan(0)
  })

  it('explain() 产出可逐行阅读的原因链，且包含代码位置与恢复条件', () => {
    const log = newLog()
    const gate = applyEmotionGate(['shell_exec'], ANXIOUS)
    const id = log.record(gate, ANXIOUS)!

    const s = log.explain(id)!
    expect(s.headline).toContain('暂缓')
    const text = s.detail.join('\n')
    expect(text).toContain('情绪状态')
    expect(text).toContain('命中规则')
    expect(text).toContain(GATE_RULES.anxiety_irreversible.source)  // 代码位置
    expect(text).toContain('恢复条件')
    expect(text).toContain('当前仍然生效')
  })

  it('override 只放行本轮，不改变情绪 —— 下一轮同规则照样收紧', () => {
    const log = newLog()
    const gate = applyEmotionGate(['shell_exec'], ANXIOUS)
    const id = log.record(gate, ANXIOUS)!

    const r = log.override(id, '这个我确定要删')
    expect(r!.status).toBe('overridden')
    expect(r!.overrideReason).toBe('这个我确定要删')
    // 关键：情绪没被改动
    expect(ANXIOUS).toEqual(ANXIOUS)

    // 情绪仍是焦虑的 → 重新收紧时依然会收紧
    const gate2 = applyEmotionGate(['shell_exec'], ANXIOUS)
    expect(gate2.gated).toBe(true)
  })

  it('override 是幂等的，且不覆盖已恢复的记录', () => {
    const log = newLog()
    const id = log.record(applyEmotionGate(['shell_exec'], ANXIOUS), ANXIOUS)!

    log.override(id, '第一次')
    const again = log.override(id, '第二次')!
    expect(again.overrideReason).toBe('第一次')   // 幂等，不被二次覆盖
    expect(again.overriddenAt).toBe(log.get(id)!.overriddenAt)

    const id2 = log.record(applyEmotionGate(['file_write'], ANXIOUS), ANXIOUS)!
    log.reconcile(CALM)                            // 自然恢复
    const rec = log.override(id2, '事后放行')!
    expect(rec.status).toBe('recovered')           // 已恢复的记录不被改写
  })

  it('reconcile 在情绪回落后把 active 标为 recovered', () => {
    const log = newLog()
    const id = log.record(applyEmotionGate(['shell_exec'], ANXIOUS), ANXIOUS)!
    expect(log.active()).toHaveLength(1)

    const n = log.reconcile(CALM)
    expect(n).toBe(1)
    expect(log.get(id)!.status).toBe('recovered')
    expect(log.get(id)!.recoveredAt).toBeGreaterThan(0)
    expect(log.active()).toHaveLength(0)
  })

  it('reconcile 不会动已放行的记录（放行是人的决定，不是情绪决定）', () => {
    const log = newLog()
    const id = log.record(applyEmotionGate(['shell_exec'], ANXIOUS), ANXIOUS)!
    log.override(id, '我确认')
    log.reconcile(CALM)
    expect(log.get(id)!.status).toBe('overridden')
  })

  it('审计只增不改：override 不抹掉原记录，只追加状态', () => {
    const log = newLog()
    const gate = applyEmotionGate(['shell_exec'], ANXIOUS)
    const id = log.record(gate, ANXIOUS)!
    const before = JSON.parse(JSON.stringify(log.get(id))) as EmotionGateRecord

    log.override(id, '放行')

    const after = log.get(id)!
    // 原始事实（时间、情绪、工具、notice）必须一字不变
    expect(after.ts).toBe(before.ts)
    expect(after.emotion).toEqual(before.emotion)
    expect(after.suppressed).toEqual(before.suppressed)
    expect(after.notice).toBe(before.notice)
    // 只在末尾追加了状态字段
    expect(after.status).toBe('overridden')
  })

  it('环形缓冲只保留最近 N 条，但不会破坏存活记录的一致性', () => {
    const log = new EmotionAuditLog({ maxRecords: 3, makeId: (_t, s) => `g${s}`, now: () => 1 })
    const gate = applyEmotionGate(['shell_exec'], ANXIOUS)
    for (let i = 0; i < 6; i++) log.record(gate, ANXIOUS)

    expect(log.all()).toHaveLength(3)
    expect(log.all()[0].id).toBe('g5')   // 新的在前
    expect(log.get('g0')).toBeNull()      // 旧的已挤出
  })

  it('sink 抛错不影响记录本身 —— 审计失败不能崩对话', () => {
    const log = new EmotionAuditLog({
      sink: () => { throw new Error('disk full') },
      makeId: () => 'x',
      now: () => 1,
    })
    const gate = applyEmotionGate(['shell_exec'], ANXIOUS)
    expect(() => log.record(gate, ANXIOUS)).not.toThrow()
    expect(log.all()).toHaveLength(1)
  })

  it('记录的焦虑值与门控实际用的完全一致（用户能自己核对阈值）', () => {
    // 这条用例保护的是「可解释」这件事的根基：
    // 审计里展示的 anxiety 必须等于 emotionGating 判定时用的那个值，
    // 否则用户拿 ANXIETY_THRESHOLD 一比对就对不上，可解释性当场归零。
    const log = newLog()
    const gate = applyEmotionGate(['shell_exec'], ANXIOUS)
    const id = log.record(gate, ANXIOUS)!

    const core = frontendThreeToCore(ANXIOUS)
    const r2 = (n: number): number => Math.round(n * 100) / 100

    expect(log.get(id)!.emotion.anxiety).toBe(r2(anxietyFrom(core.valence, core.arousal)))
    expect(log.get(id)!.emotion.valence).toBe(r2(core.valence))
    expect(log.get(id)!.emotion.fatigue).toBe(r2(core.fatigue))
    // 且记录的数值确实越过了阈值
    expect(log.get(id)!.emotion.anxiety).toBeGreaterThanOrEqual(ANXIETY_THRESHOLD)
  })

  it('explain 对不存在的 id 返回 null，不抛错', () => {
    expect(newLog().explain('nope')).toBeNull()
  })

  it('规则元数据齐全：verified 风格的「可核对」信息一条都不能少', () => {
    for (const [id, r] of Object.entries(GATE_RULES)) {
      expect(r.label, id).toBeTruthy()
      expect(r.condition, id).toBeTruthy()
      expect(r.recovery, id).toBeTruthy()
      expect(r.source, id).toContain('emotionGating.ts')
      expect(['irreversible', 'heavy', 'safe']).toContain(r.riskClass)
    }
    // 规则表里的阈值必须与 emotionGating 的实际阈值一致，不能各写一份
    expect(GATE_RULES.anxiety_irreversible.condition).toContain(String(ANXIETY_THRESHOLD))
    expect(GATE_RULES.fatigue_heavy.condition).toContain(String(FATIGUE_THRESHOLD))
  })

  it('疲劳规则也能被识别并单独解释', () => {
    const log = newLog()
    const gate = applyEmotionGate(['deep_research', 'browser'], TIRED)
    expect(gate.gated).toBe(true)
    const id = log.record(gate, TIRED)!
    expect(log.get(id)!.rules).toContain('fatigue_heavy')
  })
})
