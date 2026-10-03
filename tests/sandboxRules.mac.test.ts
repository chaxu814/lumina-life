// ============================================================
// tests/sandboxRules.mac.test.ts — 沙箱规则在 macOS 上的覆盖验证
//
// 核心命题（来自需求）：**沙箱在 macOS 上不得退化为「无保护」**。
// 改造前的规则库里，与 Windows 强绑定的规则（platform: 'win32'）在
// darwin 上一条都不生效，导致 `rm -rf ~/Documents` 这类与 Windows
// `Remove-Item -Recurse -Force` 意图完全相同的命令，在 macOS 上严重度为 SAFE。
//
// 本测试用「同一意图、两平台」的对照方式锁死这个性质。
// 纯函数，Windows 上可完整验证。
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  evaluateCommand, activeRulesFor, ruleAppliesOn, Severity, ruleStats,
  type SandboxRule,
} from '../electron/tools/impl/sandboxRules'

/** 在指定平台上评估一条命令（绕过 evaluateCommand 的 process.platform 绑定） */
function evalOn(platform: string, cmd: string) {
  const active = activeRulesFor(platform)
  const hits: string[] = []
  let max = Severity.SAFE
  for (const r of active) {
    r.pattern.lastIndex = 0
    if (r.pattern.test(cmd)) {
      hits.push(r.id)
      if (r.severity > max) {max = r.severity}
    }
  }
  return { severity: max, hits }
}

describe('跨平台规则集划分', () => {
  it('win32 规则不在 darwin 生效', () => {
    const winOnly = activeRulesFor('win32').filter(r => r.platform === 'win32')
    expect(winOnly.length).toBeGreaterThan(0)
    const darwinIds = new Set(activeRulesFor('darwin').map(r => r.id))
    for (const r of winOnly) {
      expect(darwinIds.has(r.id)).toBe(false)
    }
  })

  it('posix 规则在 darwin/linux 生效，win32 上不生效', () => {
    const posixIds = activeRulesFor('darwin').filter(r => r.platform === 'posix').map(r => r.id)
    expect(posixIds.length).toBeGreaterThan(0)
    const winIds = new Set(activeRulesFor('win32').map(r => r.id))
    for (const id of posixIds) {expect(winIds.has(id)).toBe(false)}
  })

  it('ruleAppliesOn：all 恒生效', () => {
    const all: SandboxRule = {
      id: 'X', severity: Severity.LOW, category: 'COMMAND_INJECTION' as any,
      pattern: /x/, description: '', remediation: '',
    }
    for (const p of ['win32', 'darwin', 'linux', 'freebsd']) {
      expect(ruleAppliesOn(all, p)).toBe(true)
    }
  })

  it('macOS 生效规则数 ≥ Windows（补齐后不应少于 Windows）', () => {
    expect(activeRulesFor('darwin').length).toBeGreaterThanOrEqual(activeRulesFor('win32').length)
  })

  it('ruleStats 在两平台都给出非空统计', () => {
    expect(ruleStats().total).toBeGreaterThan(0)
  })
})

describe('★ 同意图跨平台防护等级对照（不得退化）', () => {
  // [描述, macOS 命令, 期望最低严重度]
  const cases: [string, string, Severity][] = [
    ['删除系统目录', 'rm -rf /System/Library/CoreServices', Severity.BLOCK],
    ['删除系统应用包', 'rm -rf /Applications/Safari.app', Severity.BLOCK],
    ['删除用户主目录', 'rm -rf /Users/alice', Severity.BLOCK],
    ['删除 $HOME', 'rm -rf $HOME', Severity.BLOCK],
    ['递归删家目录', 'rm -rf /home/bob', Severity.BLOCK],
    ['递归删个人文档', 'rm -rf ~/Documents/project', Severity.CRITICAL],
    ['rm -rf 带 -f', 'rm -f /Users/alice/notes', Severity.HIGH],
    ['find -delete', 'find . -delete', Severity.CRITICAL],
    ['rm -r -f 分开写', 'rm -r -f ~/Downloads', Severity.CRITICAL],
    ['静默强删', 'rm -f /tmp/x', Severity.HIGH],
    ['擦盘', 'diskutil eraseDisk APFS /dev/disk2', Severity.HIGH],
    ['关闭 SIP', 'csrutil disable', Severity.HIGH],
    ['关闭 Gatekeeper', 'spctl --master-disable', Severity.HIGH],
    ['导出钥匙串', 'security dump-keychain', Severity.HIGH],
    ['777 放开权限', 'chmod 777 /usr/local/bin', Severity.HIGH],
  ]

  for (const [desc, cmd, min] of cases) {
    it(`${desc}：\`${cmd}\` 在 darwin 上不低于 ${Severity[min]}`, () => {
      const r = evalOn('darwin', cmd)
      expect(r.severity).toBeGreaterThanOrEqual(min)
      expect(r.hits.length).toBeGreaterThan(0)
    })
  }
})

describe('Windows 行为零回归（同一批命令在 win32 上等级不变）', () => {
  it('★ 对照：`rm -rf ~/Documents` 在 macOS 达到 CRITICAL（改造前为 SAFE）', () => {
    // 这是本次改造的核心命题：修复前 darwin 上该命令命中 0 条规则。
    const mac = evalOn('darwin', 'rm -rf ~/Documents')
    expect(mac.severity).toBeGreaterThanOrEqual(Severity.CRITICAL)
    expect(mac.hits).toContain('CRIT-005P')
  })

  it('★ 对照：`rm -rf /Applications/Safari.app` 在 macOS 达到 BLOCK（改造前为 SAFE）', () => {
    const mac = evalOn('darwin', 'rm -rf /Applications/Safari.app')
    expect(mac.severity).toBe(Severity.BLOCK)
    expect(mac.hits).toContain('BLOCK-006P')
  })

  const cases: [string, Severity][] = [
    ['Remove-Item C:\\Windows\\System32 -Recurse -Force', Severity.BLOCK],
    ['reg delete HKLM\\Software', Severity.BLOCK],
    ['net user hacker pass /add', Severity.BLOCK],
    ['format c:', Severity.BLOCK],
    ['del /f important.txt', Severity.HIGH],
  ]

  for (const [cmd, min] of cases) {
    it(`\`${cmd}\` 在 win32 上仍不低于 ${Severity[min]}`, () => {
      expect(evalOn('win32', cmd).severity).toBeGreaterThanOrEqual(min)
    })
  }

  it('POSIX 规则不得误伤 Windows（win32 上 rm -rf ~/Documents 不应被新规则命中为 BLOCK）', () => {
    // rm -rf ~/Documents 在 win32 上应落到 CRIT-005P 之外——它本就是 POSIX 命令，
    // 但 Windows 上确实可能经 git-bash 执行。这里只断言不被 **BLOCK-002P** 误判为删家目录。
    const r = evalOn('win32', 'rm -rf ~/Documents')
    expect(r.hits).not.toContain('BLOCK-002P')
  })
})

describe('误伤防护：日常命令不应被新规则误判', () => {
  const safe: string[] = [
    'ls -la /Applications',
    'echo hello world',
    'rm file.txt',                    // 非递归、无 -f
    'cat README.md',
    'git commit -m "fix: mac adapter"',
    'npm run build',
    'grep -r "foo" src/',
  ]

  for (const cmd of safe) {
    it(`\`${cmd}\` 在 darwin 上不触发 BLOCK/CRIT`, () => {
      const r = evalOn('darwin', cmd)
      expect(r.severity).toBeLessThan(Severity.CRITICAL)
    })
  }
})

describe('evaluateCommand 在当前平台（win32 开发机）的行为', () => {
  it('空输入返回 SAFE', () => {
    expect(evaluateCommand('').severity).toBe(Severity.SAFE)
    expect(evaluateCommand(null).severity).toBe(Severity.SAFE)
  })

  it('高危命令产出 blocked/degraded/needsApproval 标志', () => {
    const r = evaluateCommand('format c:')
    expect(r.blocked).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.needsApproval).toBe(true)
    expect(r.summary).toMatch(/阻断|严重/)
  })

  it('普通命令摘要为「安全」', () => {
    expect(evaluateCommand('echo hi').summary).toBe('安全')
  })
})
