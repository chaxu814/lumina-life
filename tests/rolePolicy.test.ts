// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/rolePolicy.test.ts
// 角色 → 工具权限 唯一事实源（electron/rolePolicy.ts）单元测试
//
// 权威口径（AGENTS.md）：
//   lumina = 全量调度 → 任意工具放行
//   yak    = 代码工程师 → 可写文件 / 可执行命令 / 可 git 提交
//   recha  = 审查员     → 只读：不写文件 / 不执行命令 / 不 git 提交
// ============================================================
import { describe, it, expect } from 'vitest'
import {
  resolveToolName,
  isToolAllowedForRole,
  getAllowedToolsForRole,
  getDisabledToolsForRole,
} from '../electron/rolePolicy'
import { registerAllTools, getToolNames } from '../electron/tools/index'

describe('resolveToolName — 历史别名解析', () => {
  it('write_code → file_write', () => {
    expect(resolveToolName('write_code')).toBe('file_write')
  })
  it('debug → shell_exec', () => {
    expect(resolveToolName('debug')).toBe('shell_exec')
  })
  it('review_code / find_bug / risk_assessment → file_read（只读分析，无副作用）', () => {
    expect(resolveToolName('review_code')).toBe('file_read')
    expect(resolveToolName('find_bug')).toBe('file_read')
    expect(resolveToolName('risk_assessment')).toBe('file_read')
  })
  it('真实工具名原样返回', () => {
    expect(resolveToolName('file_read')).toBe('file_read')
    expect(resolveToolName('shell_exec')).toBe('shell_exec')
  })
})

describe('recha（热茶 = 审查员，只读）', () => {
  const WRITE_TOOLS = ['file_write', 'file_edit', 'shell_exec', 'git_commit']
  for (const t of WRITE_TOOLS) {
    it(`recha 调用 ${t} 必须被拒`, () => {
      const v = isToolAllowedForRole('recha', t)
      expect(v.allowed).toBe(false)
      expect(v.resolved).toBe(t === 'file_edit' ? 'file_edit' : t)
    })
  }

  it('recha 调用只读工具 file_read / file_list / git_diff 放行', () => {
    expect(isToolAllowedForRole('recha', 'file_read').allowed).toBe(true)
    expect(isToolAllowedForRole('recha', 'file_list').allowed).toBe(true)
    expect(isToolAllowedForRole('recha', 'git_diff').allowed).toBe(true)
    expect(isToolAllowedForRole('recha', 'git_log').allowed).toBe(true)
  })

  it('recha 经别名 write_code 仍被拒（解析后命中 denylist）', () => {
    const v = isToolAllowedForRole('recha', 'write_code')
    expect(v.allowed).toBe(false)
    expect(v.resolved).toBe('file_write')
  })
})

describe('yak（Yak = 代码工程师，可写可执行）', () => {
  it('yak 调用 file_write / file_edit / shell_exec / git_commit 放行', () => {
    expect(isToolAllowedForRole('yak', 'file_write').allowed).toBe(true)
    expect(isToolAllowedForRole('yak', 'file_edit').allowed).toBe(true)
    expect(isToolAllowedForRole('yak', 'shell_exec').allowed).toBe(true)
    expect(isToolAllowedForRole('yak', 'git_commit').allowed).toBe(true)
  })

  it('yak 调用只读工具 file_read / git_diff 放行', () => {
    expect(isToolAllowedForRole('yak', 'file_read').allowed).toBe(true)
    expect(isToolAllowedForRole('yak', 'git_diff').allowed).toBe(true)
  })

  it('yak 调用被禁止的 worker 类工具 delegate_to 被拒', () => {
    expect(isToolAllowedForRole('yak', 'delegate_to').allowed).toBe(false)
    expect(isToolAllowedForRole('yak', 'delegate_chain').allowed).toBe(false)
  })
})

describe('lumina（全量调度）', () => {
  it('任意工具（含写/执行/危险）都放行', () => {
    for (const t of ['file_write', 'shell_exec', 'git_commit', 'delegate_to', 'mail_send', 'desktop_act']) {
      expect(isToolAllowedForRole('lumina', t).allowed).toBe(true)
    }
  })
  it('personaId 缺省/未知按 lumina 全放行处理', () => {
    expect(isToolAllowedForRole(undefined, 'shell_exec').allowed).toBe(true)
    expect(isToolAllowedForRole(null, 'file_write').allowed).toBe(true)
    expect(isToolAllowedForRole('unknown_role', 'shell_exec').allowed).toBe(true)
  })
})

describe('受限角色调用未登记工具 → 被拒', () => {
  it('recha 调用不在白名单的 mail_send / desktop_act 被拒', () => {
    expect(isToolAllowedForRole('recha', 'mail_send').allowed).toBe(false)
    expect(isToolAllowedForRole('recha', 'desktop_act').allowed).toBe(false)
  })
  it('yak 调用不在白名单的 mail_send / image_generate 被拒', () => {
    expect(isToolAllowedForRole('yak', 'mail_send').allowed).toBe(false)
    expect(isToolAllowedForRole('yak', 'image_generate').allowed).toBe(false)
  })
})

describe('getAllowedToolsForRole / getDisabledToolsForRole', () => {
  const ALL = ['file_read', 'file_write', 'shell_exec', 'git_commit', 'delegate_to', 'mail_send']

  it('recha 允许集 = 只读子集，不含写/执行', () => {
    const allowed = getAllowedToolsForRole('recha', ALL)
    expect(allowed).toContain('file_read')
    expect(allowed).not.toContain('file_write')
    expect(allowed).not.toContain('shell_exec')
    expect(allowed).not.toContain('git_commit')
  })

  it('yak 允许集含写/执行，不含 delegate_to', () => {
    const allowed = getAllowedToolsForRole('yak', ALL)
    expect(allowed).toContain('file_write')
    expect(allowed).toContain('shell_exec')
    expect(allowed).not.toContain('delegate_to')
    expect(allowed).not.toContain('mail_send')
  })

  it('disabled 集 = 全集 ∩ 不允许', () => {
    const disabled = getDisabledToolsForRole('recha', ALL)
    expect(disabled).toContain('file_write')
    expect(disabled).toContain('shell_exec')
    expect(disabled).not.toContain('file_read')
  })

  it('lumina 的 disabled 集为空', () => {
    expect(getDisabledToolsForRole('lumina', ALL)).toEqual([])
  })
})

describe('🔒 防御性兜底（fail-closed）— 空清单绝不静默全放行', () => {
  it('recha 传入空清单时，退回静态 denylist（不返回 []）', () => {
    const disabled = getDisabledToolsForRole('recha', [])
    expect(disabled).not.toEqual([])
    // 至少包含写/执行/提交四类（recha 的静态 denylist）
    expect(disabled).toContain('file_write')
    expect(disabled).toContain('file_edit')
    expect(disabled).toContain('shell_exec')
    expect(disabled).toContain('git_commit')
  })

  it('yak 传入空清单时，退回静态 denylist（delegate 类）', () => {
    const disabled = getDisabledToolsForRole('yak', [])
    expect(disabled).not.toEqual([])
    expect(disabled).toContain('delegate_to')
    expect(disabled).toContain('delegate_chain')
    expect(disabled).toContain('hire_worker')
    expect(disabled).toContain('adversarial_review')
  })

  it('lumina 传入空清单时仍为空（全量调度，无静态 deny）', () => {
    expect(getDisabledToolsForRole('lumina', [])).toEqual([])
  })
})

describe('🔒 真实注册表下的角色 disabledTools（main.ts 根因修复后验收）', () => {
  it('registerAllTools 后，recha 应被禁用大量工具（含写/执行/委托/邮件/桌面操控）', () => {
    registerAllTools()
    const all = [...getToolNames()]
    expect(all.length).toBeGreaterThan(100) // 注册表已填充，非退化空 []

    const rechaDisabled = getDisabledToolsForRole('recha', all)
    // 写/执行/提交类必在禁用集（即便注册表顺序变化也不退化）
    for (const t of ['file_write', 'file_edit', 'shell_exec', 'git_commit']) {
      expect(rechaDisabled).toContain(t)
    }
    // recha 是审查员，绝大多数工具都不在其白名单 → 禁用数应远大于放行数
    expect(rechaDisabled.length).toBeGreaterThan(all.length / 2)
    // 关键断言：修复前这里恒为 0（注册表未填充）→ recha 被悄悄全放行
    expect(rechaDisabled.length).toBeGreaterThan(100)
  })

  it('yak 禁用集不为 0（根因修复前恒为 []），且写/执行被放行、delegate 类被禁', () => {
    registerAllTools()
    const all = [...getToolNames()]
    const yakDisabled = getDisabledToolsForRole('yak', all)
    // 🔒 关键回归断言：修复前 main.ts 在注册前取清单 → yakDisabled 恒为 []
    // （静默全放行）。修复后必须 > 0。
    expect(yakDisabled.length).toBeGreaterThan(0)
    // 代码工程师：白名单内写/执行/提交必须放行（不在禁用集）
    for (const t of ['file_write', 'file_edit', 'shell_exec', 'git_commit']) {
      expect(yakDisabled).not.toContain(t)
    }
    // 但 worker 不二次委托 / 不跑流水线（静态 denylist 必在禁用集）
    for (const t of ['delegate_to', 'delegate_chain', 'hire_worker', 'adversarial_review']) {
      expect(yakDisabled).toContain(t)
    }
  })
})
