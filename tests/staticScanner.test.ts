// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/staticScanner.test.ts — AST 静态安全扫描
// ============================================================
import { describe, it, expect } from 'vitest'
import { scanJavascript } from '../electron/security/staticScanner'

describe('child_process', () => {
  it("require('child_process') → block", () => {
    const r = scanJavascript(`const { exec } = require('child_process')`)
    expect(r.severity).toBe('block')
    expect(r.findings.some((f) => f.rule === 'STC-CHILD-PROCESS')).toBe(true)
  })
})

describe('eval / new Function', () => {
  it('eval → block', () => {
    const r = scanJavascript('eval(code)')
    expect(r.findings.some((f) => f.rule === 'STC-EVAL')).toBe(true)
  })
  it('new Function → block', () => {
    const r = scanJavascript('const f = new Function("return 1")')
    expect(r.findings.some((f) => f.rule === 'STC-FUNCTION-CTOR')).toBe(true)
  })
})

describe('electron remote', () => {
  it('.remote → block', () => {
    const r = scanJavascript(`const { remote } = require('electron').remote`)
    expect(r.findings.some((f) => f.rule === 'STC-ELECTRON-REMOTE')).toBe(true)
  })
})

describe('敏感路径 / 硬编码 IP', () => {
  it("读 ~/.ssh → block", () => {
    const r = scanJavascript(`fs.readFileSync(process.env.HOME + '/.ssh/id_rsa')`)
    expect(r.findings.some((f) => f.rule === 'STC-SENSITIVE-PATH')).toBe(true)
  })
  it('硬编码公网 IP → warn', () => {
    const r = scanJavascript('const C2 = "http://8.8.8.8/x"')
    expect(r.findings.some((f) => f.rule === 'STC-HARDCODED-IP' || f.rule === 'STC-SUS-DOMAIN')).toBe(true)
  })
})

describe('干净代码 → pass', () => {
  it('普通工具函数不报警', () => {
    const src = `
      function add(a, b) { return a + b }
      module.exports = { add }
    `
    const r = scanJavascript(src)
    expect(r.severity).toBe('pass')
  })
})
