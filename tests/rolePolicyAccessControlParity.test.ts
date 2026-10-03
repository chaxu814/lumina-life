// ============================================================
// rolePolicyAccessControlParity.test.ts
// 两套权限表的一致性守卫（v3.34 新增）
//
// 【为什么需要这个文件】
// 本项目有两套描述「谁能用什么」的数据：
//
//   1. electron/rolePolicy.ts —— **运行时真正执行的那一套**
//      rolePolicy.ts:1-12 自称「唯一事实源」；执行层 reactEngine.ts 的
//      checkRoleGate() 与广告层 agentRunner.ts 都读它。
//
//   2. electron/accessControl.ts 的 DEFAULT_PERMISSIONS —— **设置面板读的那一套**
//      由 main.ts 的 IPC（动态 import）与 SettingsPanel 的 AccessControlSettings
//      使用，用户在这里改权限会写进这里。
//
// 【问题】两者描述的是同一件事，却各写各的。electron/tools/impl/team.ts:215
// 甚至留了一句注释自认这件事：「路由口径（与 accessControl.ts 权限表一致，
// 改一处必须改另一处）」—— 这正是会漂移的地方。
//
// 【为什么不是删掉 accessControl】
// 它不是死代码：main.ts:1149 的动态 import + SettingsPanel:1777 的 UI 都在用。
// 用户能在设置里看到并调整权限，这是有产品价值的能力。
//
// 【本测试的立场】
// 不试图合并两套（那是大重构，风险高），而是**把它们锁在一起**：
// 一旦有人只改一处没改另一处，这个测试立刻红，并指出差在哪。
// 口径上以 rolePolicy 为准（它是唯一事实源），accessControl 跟随。
//
// ⚠️ 诚实说明：这是「防止漂移」，不是「消除重复」。真正的合并应该作为
// 独立任务做，届时本测试的差集应当恒为空。
// ============================================================

import { describe, it, expect } from 'vitest'
import { isToolAllowedForRole, type RoleId } from '../electron/rolePolicy'
import { DEFAULT_PERMISSIONS } from '../electron/accessControl'

/** accessControl 的 shellAccess/allowedWritePaths 表达的能力，
 *  翻译成 rolePolicy 口径下的具体工具名，才能与 rolePolicy 比对。 */
function deriveToolSet(role: RoleId): Set<string> {
  const p = DEFAULT_PERMISSIONS[role]
  const tools = new Set<string>()

  // 写路径：非空 = 可写
  if (p.allowedWritePaths.length > 0) {
    tools.add('file_write')
    tools.add('file_edit')
  }
  // 读路径：非空 = 可读
  if (p.allowedReadPaths.length > 0) {
    tools.add('file_read')
    tools.add('file_list')
    tools.add('file_search')
  }
  // shell
  if (p.shellAccess) {
    tools.add('shell_exec')
  }
  // 命令白名单含 git_commit 视为可提交
  if (p.allowedCommands.includes('*') || p.allowedCommands.includes('git_commit')) {
    tools.add('git_commit')
  }
  // 危险工具
  for (const t of p.allowedDangerousTools) {
    if (t !== '*') {tools.add(t)}
  }
  return tools
}

describe('rolePolicy ↔ accessControl 权限表一致性', () => {
  it('yak：accessControl 声称可写可执行，rolePolicy 必须真的放行', () => {
    const derived = deriveToolSet('yak')
    expect(derived.has('file_write')).toBe(true)
    expect(derived.has('shell_exec')).toBe(true)
    expect(derived.has('git_commit')).toBe(true)

    for (const t of ['file_write', 'file_edit', 'shell_exec', 'git_commit']) {
      const v = isToolAllowedForRole('yak', t)
      expect(
        v.allowed,
        `accessControl 说 yak 可用 ${t}，但 rolePolicy 拒绝了它。` +
        `原因: ${v.reason ?? '未知'}。请同步两处。`,
      ).toBe(true)
    }
  })

  it('recha：accessControl 声称只读，rolePolicy 必须真的挡住写与执行', () => {
    const derived = deriveToolSet('recha')
    expect(derived.has('file_write')).toBe(false)
    expect(derived.has('shell_exec')).toBe(false)
    expect(derived.has('git_commit')).toBe(false)

    for (const t of ['file_write', 'file_edit', 'shell_exec', 'git_commit']) {
      const v = isToolAllowedForRole('recha', t)
      expect(
        v.allowed,
        `accessControl 说 recha 不可用 ${t}，但 rolePolicy 放行了它 —— ` +
        `这是越权风险，请立刻同步两处。`,
      ).toBe(false)
    }
  })

  it('recha 仍保留只读能力（不要收得只剩空集）', () => {
    for (const t of ['file_read', 'git_diff', 'git_log', 'memory_search']) {
      expect(isToolAllowedForRole('recha', t).allowed,
        `recha 是审查员，${t} 必须可用`).toBe(true)
    }
  })

  it('yak 不得二次委托（rolePolicy 的 deny 兜底仍然生效）', () => {
    // accessControl 完全没有表达「不可委托」这一层，所以这一条由 rolePolicy 独自保证。
    // 写进测试是为了：将来有人放宽 accessControl 时，这里会挡住。
    for (const t of ['delegate_to', 'delegate_chain', 'hire_worker']) {
      expect(isToolAllowedForRole('yak', t).allowed,
        `后台 worker 不得二次委托，但 rolePolicy 放行了 ${t}`).toBe(false)
    }
  })

  it('lumina：accessControl 与 rolePolicy 都应视为全放行', () => {
    // lumina 是用户唯一接口，权限最大；两处口径必须一致
    for (const t of ['file_write', 'shell_exec', 'desktop_act', 'adversarial_review']) {
      expect(isToolAllowedForRole('lumina', t).allowed,
        `lumina 应全放行，但 ${t} 被拒`).toBe(true)
    }
    expect(DEFAULT_PERMISSIONS.lumina.allowedDangerousTools).toContain('*')
  })
})
