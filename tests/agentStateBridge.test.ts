// ============================================================
// tests/agentStateBridge.test.ts — 桌宠绑定真实 Agent 运行状态
// ============================================================
// 验证差异化能力（P2）：桌宠动作反映真实执行状态，而不只是随机情绪。
// 这是同类桌宠明确放弃的边界（"只是个状态提示"），业界普遍未做。
import { describe, it, expect, beforeEach } from 'vitest'
import {
  agentStateToMotion,
  agentStateToExpression,
  shouldDrivePetFromAgent,
  AGENT_STATE_MIN_DWELL_MS,
  __resetAgentStateBridge,
  type AgentRunState,
  type AgentStateSnapshot,
} from '../electron/pet/agentStateBridge'

function snap(state: AgentRunState, sinceMs = 10_000): AgentStateSnapshot {
  return { state, actor: 'yak', taskTitle: 't', sinceMs }
}

describe('运行态 → 桌宠动作映射', () => {
  it('每个状态都有对应动作，且动作名对齐精灵表规格', () => {
    const states: AgentRunState[] = ['idle', 'working', 'reviewing', 'waiting', 'attention', 'celebrating']
    for (const s of states) {
      expect(agentStateToMotion(s)).toBeTruthy()
      expect(agentStateToExpression(s)).toBeTruthy()
    }
  })

  it('写代码 → 敲键盘 work', () => {
    expect(agentStateToMotion('working')).toBe('work')
  })

  it('审查 → review（区别于写代码，暗示有第二双眼睛）', () => {
    expect(agentStateToMotion('reviewing')).toBe('review')
    expect(agentStateToMotion('reviewing')).not.toBe(agentStateToMotion('working'))
  })

  it('出错 → fail 动作（不是 idle）', () => {
    expect(agentStateToMotion('attention')).toBe('fail')
  })

  it('空闲 → idle', () => {
    expect(agentStateToMotion('idle')).toBe('idle')
  })

  it('表情与动作不重复（专注/怀疑/担心各不同）', () => {
    const exprs = (['working', 'reviewing', 'waiting', 'attention', 'celebrating', 'idle'] as AgentRunState[])
      .map(agentStateToExpression)
    expect(new Set(exprs).size).toBe(exprs.length)
  })

  it('未知状态兜底到 idle 而不是抛错', () => {
    expect(agentStateToMotion('garbage' as AgentRunState)).toBe('idle')
    expect(agentStateToExpression('garbage' as AgentRunState)).toBe('neutral')
  })
})

describe('是否接管桌宠（防止抖动/呆板）', () => {
  it('空闲时不接管：让情绪系统自由表现', () => {
    expect(shouldDrivePetFromAgent(snap('idle'))).toBe(false)
  })

  it('用户关闭开关时永不接管', () => {
    expect(shouldDrivePetFromAgent(snap('working'), Date.now(), false)).toBe(false)
  })

  it('非空闲且已过最小驻留时间 → 接管', () => {
    expect(shouldDrivePetFromAgent(snap('working', AGENT_STATE_MIN_DWELL_MS))).toBe(true)
  })

  it('状态刚变、还没驻留够 → 不接管（防抖）', () => {
    expect(shouldDrivePetFromAgent(snap('working', 0))).toBe(false)
    expect(shouldDrivePetFromAgent(snap('working', AGENT_STATE_MIN_DWELL_MS - 1))).toBe(false)
  })

  it('出错状态也要过驻留时间才切（避免一闪而过）', () => {
    expect(shouldDrivePetFromAgent(snap('attention', 0))).toBe(false)
    expect(shouldDrivePetFromAgent(snap('attention', 5000))).toBe(true)
  })
})

describe('状态模块自身是纯净的', () => {
  beforeEach(() => { __resetAgentStateBridge() })

  it('reset 辅助函数可调用且不抛错', () => {
    expect(() => __resetAgentStateBridge()).not.toThrow()
  })

  it('最小驻留时间是合理的非零值', () => {
    expect(AGENT_STATE_MIN_DWELL_MS).toBeGreaterThan(0)
    expect(AGENT_STATE_MIN_DWELL_MS).toBeLessThan(5000)
  })
})
