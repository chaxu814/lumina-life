// ============================================================
// tests/permissionTier.test.ts — 三档权限的**执行层**验证
//
// 【这个文件存在的理由】
// 项目里已经有过一个「看起来有安全、其实没有」的先例：
// `securityConfig.sandboxMode` 在安全面板上写着「🛡️ 沙箱防护已开启」，
// 但 grep 整个 electron/ 目录，**零引用** —— 它只活在渲染进程的 Zustand 里，
// 主进程从来不读。UI 绿灯，工具该删还是删。
//
// 所以这次不靠「代码看起来接上了」交差，而是把**拦截行为本身**钉死：
//   · 三档各自的放行/拦截/确认边界
//   · 工作区越界、路径穿越、大小写、Windows 分隔符
//   · 完全权限下的硬拦截仍然生效（不能被「完全」两个字买通）
//   · 未知工具默认从严（宁可多问，不放过）
//
// 纯函数，不碰 electron：decide() 是唯一裁决点，测它就等于测真实执行行为。
// ============================================================

import { describe, it, expect } from 'vitest'
import * as path from 'path'
import {
  PermissionTier,
  TIER_META,
  decide,
  classifyTool,
  isInside,
  extractPaths,
  parseTier,
  tierScore,
  type PermissionContext,
} from '../electron/permission/permissionTier'

const ROOT = path.resolve('C:\\Users\\tester\\LuminaWorkspace')
const inside = (p: string) => path.join(ROOT, p)

function ctx(over: Partial<PermissionContext> = {}): PermissionContext {
  return { tier: PermissionTier.WORKSPACE_WRITE, workspaceRoot: ROOT, toolName: 'file_read', ...over }
}

/** 带工具参数地构造一个上下文 */
function withArgs(over: Partial<PermissionContext>, args: Record<string, unknown>): PermissionContext {
  return ctx({ ...over, args })
}

// ═══════════════════════════════════════════════════════════
describe('档位元数据', () => {
  it('三档都有中文标签、说明和颜色', () => {
    for (const t of [PermissionTier.READ_ONLY, PermissionTier.WORKSPACE_WRITE, PermissionTier.FULL]) {
      const m = TIER_META[t]
      expect(m.label).toBeTruthy()
      expect(m.desc.length).toBeGreaterThan(10)
      expect(m.color).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it('强度递增：只读 < 工作区 < 完全', () => {
    expect(tierScore(PermissionTier.READ_ONLY)).toBeLessThan(tierScore(PermissionTier.WORKSPACE_WRITE))
    expect(tierScore(PermissionTier.WORKSPACE_WRITE)).toBeLessThan(tierScore(PermissionTier.FULL))
  })

  it('parseTier 容错：脏值一律落到工作区档（不是最宽松的那个）', () => {
    expect(parseTier('read_only')).toBe(PermissionTier.READ_ONLY)
    expect(parseTier('READONLY')).toBe(PermissionTier.READ_ONLY)
    expect(parseTier('full')).toBe(PermissionTier.FULL)
    expect(parseTier('完全乱写')).toBe(PermissionTier.WORKSPACE_WRITE)
    expect(parseTier(undefined)).toBe(PermissionTier.WORKSPACE_WRITE)
    expect(parseTier(null)).toBe(PermissionTier.WORKSPACE_WRITE)
    expect(parseTier(123)).toBe(PermissionTier.WORKSPACE_WRITE)
    // ⚠️ 最关键：任何无法识别的输入都不能变成 FULL
    expect(parseTier('full-ish')).not.toBe(PermissionTier.FULL)
    expect(parseTier({ toString: () => 'full' })).not.toBe(PermissionTier.FULL)
  })
})

// ═══════════════════════════════════════════════════════════
describe('P4: 可信目录白名单（降低工作区外写文件的审批摩擦）', () => {
  const TRUSTED = path.resolve('C:\\Users\\tester\\TrustedProjects')
  const inTrusted = path.join(TRUSTED, 'note.txt')
  const outside = path.resolve('C:\\Users\\tester\\Elsewhere\\note.txt')

  it('工作区内修改档：工作区外的写操作默认需确认（回归基线）', () => {
    const d = decide(withArgs({ tier: PermissionTier.WORKSPACE_WRITE, toolName: 'file_write' }, { path: outside }))
    expect(d.action).toBe('ask')
  })

  it('工作区外的路径若落在 trustedDirs 内 → 免审批直接放行', () => {
    const d = decide(withArgs(
      { tier: PermissionTier.WORKSPACE_WRITE, toolName: 'file_write', trustedDirs: [TRUSTED] },
      { path: inTrusted },
    ))
    expect(d.action).toBe('allow')
  })

  it('P4 不放大边界：exec / secret 仍按原规则确认或拦截', () => {
    const exec = decide(withArgs(
      { tier: PermissionTier.WORKSPACE_WRITE, toolName: 'shell_exec', trustedDirs: [TRUSTED] },
      { command: 'echo hi' },
    ))
    expect(exec.action).toBe('ask')
    const secret = decide(withArgs(
      { tier: PermissionTier.WORKSPACE_WRITE, toolName: 'read_env', trustedDirs: [TRUSTED] },
      {},
    ))
    expect(secret.action).toBe('deny')
  })

  it('trustedDirs 与工作区合并判定：工作区内写操作本就放行，加白名单不受影响', () => {
    const d = decide(withArgs(
      { tier: PermissionTier.WORKSPACE_WRITE, toolName: 'file_write', trustedDirs: [TRUSTED] },
      { path: inside('output.md') },
    ))
    expect(d.action).toBe('allow')
  })
})

// ═══════════════════════════════════════════════════════════
describe('仅可查看 —— 该挡的一定要挡住', () => {
  const t = PermissionTier.READ_ONLY

  it('放行纯读工具', () => {
    for (const tool of ['file_read', 'file_list', 'weather', 'web_fetch', 'calendar_list']) {
      expect(decide(ctx({ tier: t, toolName: tool })).action).toBe('allow')
    }
  })

  it('拦下写文件', () => {
    const r = decide(ctx({ tier: t, toolName: 'file_write' }))
    expect(r.action).toBe('deny')
    if (r.action === 'deny') {
      expect(r.reason).toContain('仅可查看')
      expect(r.category).toBe('PRIVILEGE_ESCALATION')
    }
  })

  it('拦下执行命令', () => {
    expect(decide(ctx({ tier: t, toolName: 'shell_exec' })).action).toBe('deny')
  })

  it('拦下操控鼠标键盘', () => {
    expect(decide(ctx({ tier: t, toolName: 'desktop_act' })).action).toBe('deny')
  })

  it('拦下对外发送', () => {
    expect(decide(ctx({ tier: t, toolName: 'mail_send' })).action).toBe('deny')
  })

  it('拦下读凭证，并给出专门的类别', () => {
    const r = decide(ctx({ tier: t, toolName: 'get_api_key' }))
    expect(r.action).toBe('deny')
    if (r.action === 'deny') { expect(r.category).toBe('CREDIT_LEAK') }
  })

  it('⚠️ 即使参数看起来无害，写操作在只读档也一律拒绝', () => {
    // 目标就在工作区里也不行 —— 只读档就是只读
    const r = decide(withArgs({ tier: t, toolName: 'file_write' }, { path: inside('a.txt') }))
    expect(r.action).toBe('deny')
  })
})

// ═══════════════════════════════════════════════════════════
describe('工作区内修改 —— 边界是根目录', () => {
  const t = PermissionTier.WORKSPACE_WRITE

  it('工作区内的写操作放行', () => {
    const r = decide(ctx({ tier: t, toolName: 'file_write' }) )
    expect(r.action).toBe('allow')
  })

  it('工具没暴露路径参数时按工作区内放行（少数情况）', () => {
    const r = decide(ctx({ tier: t, toolName: 'file_write' }))
    expect(r.action).toBe('allow')
  })

  it('带路径参数时：根目录内放行', () => {
    const r = decide(withArgs({ tier: t, toolName: 'file_write' }, { path: inside('docs\\a.md') }))
    expect(r.action).toBe('allow')
  })

  it('带路径参数时：工作区外需确认，风险为 high', () => {
    const r = decide(withArgs({ tier: t, toolName: 'file_write' }, { path: 'C:\\Windows\\System32\\x.dll' }))
    expect(r.action).toBe('ask')
    if (r.action === 'ask') { expect(r.risk).toBe('high') }
  })

  it('多个路径里只要有一个越界就需确认', () => {
    const r = decide(withArgs({ tier: t, toolName: 'file_write' }, { path: inside('ok.txt'), dest: 'C:\\evil.txt' }))
    expect(r.action).toBe('ask')
  })

  it('路径穿越 `..` 被当成工作区外', () => {
    const r = decide(withArgs({ tier: t, toolName: 'file_write' }, { path: path.join(inside('a'), '..', '..', '..', 'Windows', 'x') }))
    expect(r.action).toBe('ask')
  })

  it('执行命令在这一档必须确认', () => {
    const r = decide(ctx({ tier: t, toolName: 'shell_exec', command: 'npm test' }))
    expect(r.action).toBe('ask')
    if (r.action === 'ask') { expect(r.risk).toBe('high') }
  })

  it('操控鼠标在这一档必须确认', () => {
    expect(decide(ctx({ tier: t, toolName: 'desktop_act' })).action).toBe('ask')
  })

  it('对外发送这一档要确认，但风险等级是中（不是 high）', () => {
    const r = decide(ctx({ tier: t, toolName: 'mail_send' }))
    expect(r.action).toBe('ask')
    if (r.action === 'ask') { expect(r.risk).toBe('medium') }
  })

  it('读凭证仍然拒绝（工作区档不是「随便」档）', () => {
    expect(decide(ctx({ tier: t, toolName: 'get_api_key' })).action).toBe('deny')
  })

  it('未配置工作区时，写操作退化为「需确认」而不是放行', () => {
    const r = decide({ tier: t, workspaceRoot: null, toolName: 'file_write' })
    expect(r.action).toBe('ask')
  })
})

// ═══════════════════════════════════════════════════════════
describe('完全权限 —— 免确认，但硬拦截不被买通', () => {
  const t = PermissionTier.FULL

  it('放行写、命令、GUI、外发 —— 不再逐步确认', () => {
    for (const tool of ['file_write', 'shell_exec', 'desktop_act', 'mail_send']) {
      expect(decide(ctx({ tier: t, toolName: tool })).action).toBe('allow')
    }
  })

  it('🔒 但递归删除根目录仍然被拒 —— 这是刻意的', () => {
    const r = decide(ctx({ tier: t, toolName: 'shell_exec', command: 'rm -rf /' }))
    expect(r.action).toBe('deny')
    if (r.action === 'deny') { expect(r.category).toBe('PRIVILEGE_ESCALATION') }
  })

  it('🔒 fork 炸弹仍然被拒', () => {
    const r = decide(ctx({ tier: t, toolName: 'shell_exec', command: ':(){ :|:& };:' }))
    expect(r.action).toBe('deny')
  })

  it('🔒 普通的删除根目录写法也能命中（rm -rf /、rm -fr /）', () => {
    for (const cmd of ['rm -rf /', 'rm -fr /', 'rmdir /']) {
      expect(decide(ctx({ tier: t, toolName: 'shell_exec', command: cmd })).action).toBe('deny')
    }
  })

  it('🔒 但删除普通目录不会被误伤', () => {
    const r = decide(ctx({ tier: t, toolName: 'shell_exec', command: 'rm -rf ./node_modules' }))
    expect(r.action).toBe('allow')
  })
})

// ═══════════════════════════════════════════════════════════
describe('路径判定', () => {
  it('isInside 认根目录自身与子路径', () => {
    expect(isInside(ROOT, ROOT)).toBe(true)
    expect(isInside(ROOT, inside('a.txt'))).toBe(true)
    expect(isInside(ROOT, inside('a\\b\\c.txt'))).toBe(true)
  })

  it('isInside 拒绝兄弟目录的「前缀巧合」', () => {
    // LuminaWorkspace2 不是 LuminaWorkspace 的子目录 —— 前缀相同但不在里面
    expect(isInside(ROOT, ROOT + '2\\x.txt')).toBe(false)
    expect(isInside(ROOT, path.join(path.dirname(ROOT), 'other\\x.txt'))).toBe(false)
  })

  it('isInside 拒绝 `..` 穿越', () => {
    expect(isInside(ROOT, path.resolve(inside('..\\..\\..\\Windows\\System32')))).toBe(false)
  })

  it('extractPaths 认常见的路径参数名', () => {
    const paths = extractPaths({ path: 'a', file: 'b', filePath: 'c', dest: 'd', cwd: 'ignored', n: 1 })
    expect(paths).toEqual(['a', 'b', 'c', 'd'])
  })

  it('extractPaths 忽略非字符串值', () => {
    expect(extractPaths({ path: 123, file: null, target: '' })).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════
describe('工具分类 —— 未知工具默认从严', () => {
  it('已知工具分类正确', () => {
    expect(classifyTool('file_read')).toBe('read')
    expect(classifyTool('file_write')).toBe('write')
    expect(classifyTool('shell_exec')).toBe('exec')
    expect(classifyTool('desktop_act')).toBe('gui')
    expect(classifyTool('mail_send')).toBe('net')
    expect(classifyTool('get_api_key')).toBe('secret')
  })

  it('🔒 任何没登记的工具都按「写」处理（宁可多问，不放过）', () => {
    expect(classifyTool('some_brand_new_tool_2030')).toBe('write')
    // 在只读档下，未知工具被拒
    expect(decide(ctx({ tier: PermissionTier.READ_ONLY, toolName: 'some_brand_new_tool_2030' })).action).toBe('deny')
    // 在工作区档下，未知工具至少要确认
    expect(decide(ctx({ tier: PermissionTier.WORKSPACE_WRITE, toolName: 'some_brand_new_tool_2030' })).action).not.toBe('deny')
  })

  it('大小写不敏感的工具名也能归类', () => {
    expect(classifyTool('FILE_WRITE')).toBe('write')
  })
})

// ═══════════════════════════════════════════════════════════
describe('回归：不能因为权限层而放行本该拦的东西', () => {
  it('每个档位下，凭证类工具永不放行', () => {
    for (const t of [PermissionTier.READ_ONLY, PermissionTier.WORKSPACE_WRITE, PermissionTier.FULL]) {
      expect(decide(ctx({ tier: t, toolName: 'get_api_key' })).action).toBe('deny')
      expect(decide(ctx({ tier: t, toolName: 'read_env' })).action).toBe('deny')
    }
  })

  it('权限层的结论永远可解释（reason 非空）', () => {
    for (const t of [PermissionTier.READ_ONLY, PermissionTier.WORKSPACE_WRITE, PermissionTier.FULL]) {
      for (const tool of ['file_read', 'file_write', 'shell_exec', 'desktop_act', 'mail_send', 'get_api_key']) {
        const r = decide(ctx({ tier: t, toolName: tool }))
        expect(r.reason.length).toBeGreaterThan(4)
        expect(r.action).not.toBe('')
      }
    }
  })
})
