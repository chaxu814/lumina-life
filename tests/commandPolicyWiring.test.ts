// ============================================================
// tests/commandPolicyWiring.test.ts — shell.ts 接线命令策略（P2-8 阶段1）
//
// 验收点：
//  1. REJECT 层默认开：命中即拦截，与既有黑名单风格一致，命令不执行
//  2. APPROVAL 层灰度 flag（默认关）：
//     - flag 开：命中 APR 规则 → 创建审批请求、本轮不执行、返回 /approve 提示
//     - flag 关：行为与接线前完全一致（不弹审批、按既有路径执行）
// ============================================================

import { describe, it, expect, afterEach } from 'vitest'
import { shellExec } from '../electron/tools/impl/shell'
import { setFlag, isEnabled } from '../electron/core/featureFlags'
import { getApprovalService } from '../electron/approvalService'

describe('命令策略接线：REJECT 层（默认开）', () => {
  afterEach(() => {
    setFlag('security.commandApproval', false)
    getApprovalService().cancelAllPending()
  })

  it('diskpart（格式化磁盘）→ 直接拦截', async () => {
    // 注：del /f /s /q C:\ 会被既有 DANGEROUS_PATTERNS 黑名单先拦——
    // 那正是「两层防线叠加」的预期。这里选 policy 独有的拒绝项验证新层。
    const r = await shellExec({ command: 'diskpart' })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('安全策略拒绝')
    expect(r.content).toContain('REJ-')
  })

  it('rm -rf / → 被拒（黑名单或策略层，任一防线均可）', async () => {
    const r = await shellExec({ command: 'rm -rf /' })
    // 既有 DANGEROUS_PATTERNS 黑名单与新 REJECT 层是叠加关系，
    // 任一层拦住都算达标——重点是命令没有执行。
    expect(r.content).toMatch(/拦截|拒绝/)
  })

  it('普通命令不受影响（allow）', async () => {
    // evaluateCommand 层面：只读命令必须 allow
    const { evaluateCommand } = await import('../electron/security/commandPolicy')
    expect(evaluateCommand('git --version', { enabledApproval: false }).decision).toBe('allow')
    expect(evaluateCommand('dir /b', { enabledApproval: false }).decision).toBe('allow')
  })
})

describe('命令策略接线：APPROVAL 层（灰度 flag security.commandApproval）', () => {
  afterEach(() => {
    setFlag('security.commandApproval', false)
    getApprovalService().cancelAllPending()
  })

  it('flag 默认关闭', () => {
    // 恢复默认：新开关必须保守默认关
    expect(isEnabled('security.commandApproval')).toBe(false)
  })

  it('flag 开：命中 APR 规则 → 创建审批请求、本轮不执行', async () => {
    setFlag('security.commandApproval', true)
    const before = getApprovalService().pendingCount
    // sudo 是 APR-PRIV-ESC-006 命中项；Windows 上没有 sudo，
    // 若走到执行只会是 ENOENT 错误——正好用来证明「审批先行、未执行」
    const r = await shellExec({ command: 'sudo -n whoami' })
    expect(r.content).toContain('/approve')
    expect(r.content).toContain('APR-')
    // 审批请求真的进了队列
    expect(getApprovalService().pendingCount).toBe(before + 1)
  })

  it('flag 关：同一审批层命令不再走审批（行为与接线前一致）', async () => {
    setFlag('security.commandApproval', false)
    const before = getApprovalService().pendingCount
    // 走到执行层（sudo 在 Windows 上会 ENOENT 报错，但关键是没有审批提示）
    const r = await shellExec({ command: 'sudo -n whoami' })
    expect(r.content).not.toContain('/approve')
    expect(r.content).not.toContain('安全策略拒绝')
    expect(getApprovalService().pendingCount).toBe(before)
  })

  it('evaluateCommand：flag 关时 approval 规则完全不参与判定', async () => {
    const { evaluateCommand } = await import('../electron/security/commandPolicy')
    // APR-PRIV-ESC-006
    expect(evaluateCommand('sudo whoami', { enabledApproval: false }).decision).toBe('allow')
    expect(evaluateCommand('sudo whoami', { enabledApproval: true }).decision).toBe('require_approval')
  })
})
