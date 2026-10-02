// ============================================================
// tests/rolePermissionsRouting.test.ts
// 角色权限 / 工具白名单 / 委托路由 方向一致性测试
//
// 【方向已翻正 — 2026-10】权威口径（来自 AGENTS.md，用户已确认）：
//   Yak  yak   = 代码工程师           → 可读可写、可执行命令、可 git 提交
//   热茶 recha = 数据分析师兼审查员    → 只读，不写文件、不执行命令
//
// 历史方向（已废弃，本测试锁死不再复辟）：
//   曾把 recha 当成能写的程序员、yak 当成只读审查员。
//   即「写代码的没写权限，审查的反而能乱删文件」。本测试锁死当前方向，
//   防止权限表、白名单、委托路由、阶段门控其中任何一处再次跑偏。
//
// 注意：team.ts / orchestration 目录的断言走源码文本校验（这些模块
// 顶层 import 了 Electron 运行时依赖，直接 import 会把单测拖进主进程环境）。
// ============================================================
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_PERMISSIONS, AccessController } from '../electron/accessControl'
import {
  getDisabledToolsForAgent,
  enforceToolPermission,
} from '../electron/agentPermissions'

const ROOT = join(__dirname, '..')

/** 读源码并统一换行为 \n —— 本仓库源码多为 CRLF，直接按 \n 匹配会漏判 */
const readSrc = (relPath: string): string =>
  readFileSync(join(ROOT, relPath), 'utf-8').replace(/\r\n/g, '\n')

const ORCH_DIR = join(ROOT, 'electron', 'orchestration')

/** 写类 / 执行类工具（这三个是权限边界的核心） */
const WRITE_TOOLS = ['file_write', 'file_edit', 'shell_exec']

/** 全部由本次方向覆盖的文件（权限表 + 路由 + 阶段门控） */
const OWNED_FILES = [
  'electron/accessControl.ts',
  'electron/agentPermissions.ts',
  'electron/tools/impl/team.ts',
  ...readdirSync(ORCH_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => `electron/orchestration/${f}`),
]

// ═══════════════════════════════════════════════════════════
// accessControl — 权限表方向
// ═══════════════════════════════════════════════════════════

describe('accessControl：Yak=程序员，热茶=审查员', () => {
  it('yak（Yak）允许写任意路径，并放行写类/执行类危险工具', () => {
    const p = DEFAULT_PERMISSIONS.yak
    expect(p.allowedWritePaths.length).toBeGreaterThan(0)
    expect(p.allowedReadPaths.length).toBeGreaterThan(0)
    for (const t of WRITE_TOOLS) {
      expect(p.allowedDangerousTools).toContain(t)
    }
    expect(p.shellAccess).toBe(true)
    expect(p.allowedCommands.length).toBeGreaterThan(0)
    expect(p.description).toContain('代码工程师')
  })

  it('recha（热茶）写路径为空、无危险工具、不能执行命令', () => {
    const p = DEFAULT_PERMISSIONS.recha
    expect(p.allowedWritePaths).toEqual([])
    expect(p.allowedDangerousTools).toEqual([])
    expect(p.shellAccess).toBe(false)
    // 只读：读路径仍然放开，否则审查员连代码都读不到
    expect(p.allowedReadPaths.length).toBeGreaterThan(0)
    expect(p.description).toContain('审查员')
  })

  it('AccessController 实际判定：yak 能写能跑，recha 一律拒绝', () => {
    const ac = new AccessController()

    expect(ac.checkWritePath('yak', 'K:/2/Lumina AI/electron/foo.ts').allowed).toBe(true)
    expect(ac.checkWritePath('recha', 'K:/2/Lumina AI/electron/foo.ts').allowed).toBe(false)

    expect(ac.checkShellCommand('yak', 'node ./node_modules/typescript/bin/tsc --noEmit').allowed).toBe(true)
    expect(ac.checkShellCommand('recha', 'node ./node_modules/typescript/bin/tsc --noEmit').allowed).toBe(false)

    expect(ac.checkToolAccess('yak', 'file_write').allowed).toBe(true)
    expect(ac.checkToolAccess('recha', 'file_write').allowed).toBe(false)

    // 读权限两方都在（审查员要能读代码才能审）
    expect(ac.checkReadPath('yak', 'K:/2/Lumina AI/electron/foo.ts').allowed).toBe(true)
    expect(ac.checkReadPath('recha', 'K:/2/Lumina AI/electron/foo.ts').allowed).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════
// agentPermissions — 工具白名单 / DENIED 方向
// ═══════════════════════════════════════════════════════════

describe('agentPermissions：白名单与 DENIED 同向', () => {
  it('yak（Yak）的禁用工具里不含写类工具', () => {
    const disabled = getDisabledToolsForAgent('yak')
    for (const t of WRITE_TOOLS) {
      expect(disabled).not.toContain(t)
    }
  })

  it('recha（热茶）的禁用工具含全部写类/执行类工具', () => {
    const disabled = getDisabledToolsForAgent('recha')
    for (const t of WRITE_TOOLS) {
      expect(disabled).toContain(t)
    }
  })

  it('enforceToolPermission：yak 可写，recha 被拒', () => {
    for (const t of WRITE_TOOLS) {
      expect(enforceToolPermission('yak', t)).toBe(true)
      expect(enforceToolPermission('recha', t)).toBe(false)
    }
  })

  it('只读工具两方都可用', () => {
    for (const agent of ['yak', 'recha'] as const) {
      expect(enforceToolPermission(agent, 'file_read')).toBe(true)
      expect(enforceToolPermission(agent, 'grep_search')).toBe(true)
    }
  })
})

// ═══════════════════════════════════════════════════════════
// tools/impl/team.ts — 委托路由与文案
// ═══════════════════════════════════════════════════════════

describe('team.ts：delegate_to / delegate_chain 路由', () => {
  const src = readSrc('electron/tools/impl/team.ts')

  it('delegate_to 描述：写代码→Yak/yak，审查→热茶/recha', () => {
    expect(src).toContain('写代码→Yak')
    expect(src).toContain('审查找错→热茶')
    expect(src).toContain('写代码/调试 bug → yak')
    expect(src).toContain('审查代码/找逻辑漏洞 → recha')
    expect(src).toContain('反面意见/风险评估 → recha')
  })

  it('delegate_to 的 to 参数说明与报错文案方向正确', () => {
    expect(src).toContain('yak 📊：代码工程师')
    expect(src).toContain('recha 🍵：数据分析师兼审查员')
    expect(src).toContain('目标成员必须是 yak 📊（代码工程师）或 recha 🍵（数据分析师兼审查员）')
  })

  it('delegate_chain：先 Yak 写代码（code_write→yak），再 热茶 审查（code_review→recha）', () => {
    const writeAt = src.indexOf("to: 'yak',\n      task: i === 1")
    const reviewAt = src.indexOf("to: 'recha',\n      task: reviewTask")

    expect(writeAt).toBeGreaterThan(-1)
    expect(reviewAt).toBeGreaterThan(-1)
    // 先写后审，顺序不能反
    expect(writeAt).toBeLessThan(reviewAt)

    // 变量名跟角色对上：yakResult = 写代码结果，rechaResult = 审查结果
    expect(src).toContain('const yakResult = await dm.delegate')
    expect(src).toContain('const rechaResult = await dm.delegate')
    expect(src).toContain('委托Yak写代码 → 自动转热茶审查')
  })
})

// ═══════════════════════════════════════════════════════════
// orchestration/ — 阶段门控与看板的职责映射
// ═══════════════════════════════════════════════════════════

describe('orchestration：职责映射不出现反向硬编码', () => {
  const files = readdirSync(ORCH_DIR).filter(f => f.endsWith('.ts'))

  it("任何 orchestration 文件都不存在 assignTo: 'recha' 的硬编码派活", () => {
    // 匹配赋值位置（, 或 } 收尾），避开类型联合 'yak' | 'lumina' | 'recha'
    const assignRecha = /assignTo:\s*'recha'\s*[,}]/
    for (const f of files) {
      expect(`${f}: ${assignRecha.test(readSrc(`electron/orchestration/${f}`))}`)
        .toBe(`${f}: false`)
    }
  })

  it('taskBoard：默认 assignTo 是 yak（程序员），否则默认任务没人能执行', () => {
    const src = readSrc('electron/orchestration/taskBoard.ts')
    expect(src).toMatch(/assignTo:\s*options\?\.assignTo\s*\|\|\s*'yak'/)
    expect(src).not.toMatch(/assignTo:\s*options\?\.assignTo\s*\|\|\s*'recha'/)
  })

  it('phaseGate：调研/执行/验证→yak，审查→recha', () => {
    const src = readSrc('electron/orchestration/phaseGate.ts')
    // 调研（code_explain）与验证（code_debug）都要跑命令 → 只有 Yak 做得了
    expect(src).toContain("delegateFn('yak', researchTask, 'code_explain')")
    expect(src).toContain("delegateFn('yak',\n      `【验证阶段")
    // 审查是 热茶 的活
    expect(src).toContain("delegateFn('recha',\n      `【代码审查")
    // 默认拆出的子任务都派给 Yak
    expect((src.match(/assignTo: 'yak' as const/g) || []).length).toBeGreaterThanOrEqual(3)
    expect(src).toContain("t.assignTo === 'yak'")
  })

  it('yakParallel：派活发起者是 Yak（程序员），不是审查员', () => {
    const src = readSrc('electron/orchestration/yakParallel.ts')
    expect(src).toMatch(/delegationManager\.delegate\(\s*'yak'/)
    expect(src).not.toMatch(/delegationManager\.delegate\(\s*'recha'/)
  })

  it('internPool：子智能体由 owner 招人、权限继承 owner、热茶审查（不 owner 自审）', () => {
    const src = readSrc('electron/orchestration/internPool.ts')
    // 泛化：任意 owner（Lumina/Yak/热茶）都能招自己的临时子智能体
    expect(src).toContain('你是被你的直属 owner 招来的临时帮手')
    // 审查仍由 热茶 做，owner 不审自己的产出
    expect(src).toContain('审查是 热茶（🍵）的职责')
    // 子智能体权限严格继承 owner 的角色边界
    expect(src).toContain('你的可用工具严格等于你 owner 的可用工具')
    expect(src).toContain('权限严格继承派生它的 owner')
    // 各 owner 派生的子智能体边界正确：Yak 可写可跑，热茶只读
    expect(src).toContain('Yak 派生的子智能体')
    expect(src).toContain('热茶 派生的子智能体')
    // 旧的「只有 Yak 能招人」硬编码口径已被泛化取代
    expect(src).not.toContain('那是热茶的事')
  })
})

// ═══════════════════════════════════════════════════════════
// 反向断言：旧的错误口径必须彻底消失
// ═══════════════════════════════════════════════════════════

describe('反向断言：旧的反向口径不得残留', () => {
  // 新口径正确：yak=代码工程师(可写可跑)、recha=审查员(只读)。
  // 下面这些串一旦出现，就等于又退回了「热茶写代码 / Yak 只读审查」的旧错误方向。
  const forbidden = [
    '写代码→热茶',
    '写代码/调试 bug → recha',
    '热茶 写代码',
    '热茶 — 代码工程师',
    '热茶，可写文件和执行命令',
    'Yak — 数据分析师兼审查员，只读不写',
    'Yak 只读不写',
    '委托热茶写代码',
  ]

  it('所有归属文件里都搜不到反向文案', () => {
    for (const rel of OWNED_FILES) {
      const src = readSrc(rel)
      for (const bad of forbidden) {
        expect(`${rel} :: ${bad} :: ${src.includes(bad)}`).toBe(`${rel} :: ${bad} :: false`)
      }
    }
  })

  it('accessControl 两条 description 精确匹配新口径', () => {
    expect(DEFAULT_PERMISSIONS.yak.description).toBe('Yak — 代码工程师，可写文件和执行命令')
    expect(DEFAULT_PERMISSIONS.recha.description).toBe('热茶 — 审查员，只读不写')
    const src = readSrc('electron/accessControl.ts')
    expect(src).toContain('Yak — 代码工程师，可写文件和执行命令')
    expect(src).toContain('热茶 — 审查员，只读不写')
  })
})
