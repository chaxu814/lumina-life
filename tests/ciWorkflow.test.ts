// ============================================================
// ciWorkflow.test.ts — CI 工作流配置的漂移守卫（v3.34 新增）
//
// 【为什么需要这个文件】
// 2026-10-03 发生过一次真实的「承诺与实现不符」：
//   提交信息写了「warning 用棘轮制（scripts/lint-ratchet.cjs）」，
//   但 `.github/workflows/test.yml` 里实际跑的是 `npx eslint . --max-warnings 0`。
//   棘轮那一步**根本没写进文件**，而 `max-warnings 0` 对着仓库里约 5000 条
//   历史 warning 会把 CI 直接打红。
//
//   也就是说：如果按那个提交发布，**第一次 push 就会看到全绿的本地测试
//   和必红的 CI**，而提交信息读起来像是全都做完了。
//
// 本测试把「CI 里 lint 到底怎么跑」锁成断言，让这类漂移在提交时就被挡住，
// 而不是等到 GitHub Actions 上才发现。
//
// 【设计取舍】
// 刻意用「结构断言」而不是跑 YAML parser —— 不想为了一条断言新增依赖。
// 只剥离 `#` 开头的整行注释后做子串匹配，足够挡住「步骤被删掉/被改回去」
// 这类真实回归。
// ============================================================

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '..')

function readWorkflow(name: string): { raw: string; code: string } {
  const raw = readFileSync(join(root, '.github', 'workflows', name), 'utf8')
  // 剥离整行注释（YAML 里 # 在行首才是注释；行内的 ## 才是）
  const code = raw.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n')
  return { raw, code }
}

function section(code: string, from: RegExp): string {
  const lines = code.split('\n')
  const s = lines.findIndex(l => from.test(l))
  if (s < 0) { return '' }
  const e = lines.findIndex((l, i) => i > s && /^ {2}\S/.test(l))
  return lines.slice(s, e < 0 ? lines.length : e).join('\n')
}

describe('CI 工作流 · test.yml', () => {
  const { code } = readWorkflow('test.yml')
  const lint = section(code, /^ {2}lint:/)

  it('lint job 存在且非空', () => {
    expect(lint.length).toBeGreaterThan(0)
  })

  it('strict 类型检查必须真的执行（不得 continue-on-error）', () => {
    expect(lint).toMatch(/run: npx tsc --noEmit --strict/)
    // 这一条是 README 里「tsc --strict 零错误」这句宣传的唯一执行点。
    // 一旦又变成 continue-on-error，README 的说法就变成空话。
    expect(lint).not.toMatch(/continue-on-error/)
  })

  it('ESLint 分成 error 门禁 + warning 棘轮两档', () => {
    expect(lint).toMatch(/run: npx eslint \. --quiet/)
    expect(lint).toMatch(/run: node scripts\/lint-ratchet\.cjs/)
  })

  it('禁止 --max-warnings 0（对着约 5000 条历史 warning 会打红 CI）', () => {
    // 历史教训：仓库有约 5000 条 warning，--max-warnings 0 等于永久红灯。
    // 真想收紧 warning，应该调 lint-baseline.json 或降低容差，不是用这个开关。
    expect(lint).not.toMatch(/--max-warnings\s+0/)
  })

  it('棘轮容差必须显式设置（跨平台 warning 计数会有个位数波动）', () => {
    expect(lint).toMatch(/LINT_RATCHET_TOLERANCE/)
  })
})

describe('CI 工作流 · 矩阵与触发条件', () => {
  const { code } = readWorkflow('test.yml')

  it('push 触发不因只改文档而跳过（保留原有 paths-ignore）', () => {
    // 这里只断言 push 触发的分支列表存在，避免有人误删导致 CI 不再跑
    expect(code).toMatch(/on:/)
    expect(code).toMatch(/branches:\s*\[main, master\]/)
  })

  it('跨平台矩阵覆盖 win/mac/linux', () => {
    expect(code).toMatch(/windows-latest/)
    expect(code).toMatch(/macos-latest/)
    expect(code).toMatch(/ubuntu-latest/)
  })

  it('原生 ABI 门禁仍在（better-sqlite3 与 Electron 版本错配的真实事故守卫）', () => {
    // 2026-10-03 发布审计发现的真实事故：预编译包是 Node 20 ABI 143，
    // Electron 40 需要 148，导致「vitest 全绿但打包后 SQLite 静默降级」。
    expect(code).toMatch(/native-abi/)
    expect(code).toMatch(/rebuild:electron/)
  })
})

describe('lint 基线文件', () => {
  it('scripts/lint-baseline.json 存在且格式正确', () => {
    const raw = readFileSync(join(root, 'scripts', 'lint-baseline.json'), 'utf8')
    const b = JSON.parse(raw)
    expect(typeof b.errors).toBe('number')
    expect(typeof b.warnings).toBe('number')
    // 基线的意义是「只允许变小」。如果 errors 不是 0，说明有 error 级违规漏网了。
    expect(b.errors).toBe(0)
    expect(b.warnings).toBeGreaterThan(0)
  })

  it('棘轮脚本存在', () => {
    const raw = readFileSync(join(root, 'scripts', 'lint-ratchet.cjs'), 'utf8')
    expect(raw).toMatch(/lint-baseline\.json/)
    expect(raw).toMatch(/TOLERANCE/)
  })
})
