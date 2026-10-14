// ============================================================
// tests/sandboxRulesNormalize.test.ts — 命令归一化（编码伪装绕过）验收
//
// 背景：旧实现直接对原始命令串匹配规则，以下"编码一次"的形态全部绕过：
//   bash -c "$(echo cm0gLXJmIC8= | base64 -d)"   # rm -rf / 的 base64 形态
//   r\m -rf /                                    # 反斜杠转义
//   rm%20-rf%20/                                 # 百分号编码
// 本测试钉住"归一化后必须命中" + "正常命令不得误报"。
// ============================================================

import { describe, it, expect } from 'vitest'
import { evaluateCommand, normalizeCommand, Severity } from '../electron/tools/impl/sandboxRules'

describe('命令归一化 · 编码伪装必须被识破', () => {
  it('base64 解码后执行的 rm -rf / → 命中 BLOCK', () => {
    const ev = evaluateCommand('bash -c "$(echo cm0gLXJmIC8= | base64 -d)"')
    expect(ev.severity).toBe(Severity.BLOCK)
    expect(ev.blocked).toBe(true)
  })

  it('裸 base64 管道：echo <b64> | base64 -d → 命中', () => {
    const ev = evaluateCommand('echo cm0gLXJmIC8= | base64 -d')
    expect(ev.severity).toBeGreaterThanOrEqual(Severity.CRITICAL)
  })

  it('反斜杠转义 r\\m -rf / → 命中 BLOCK', () => {
    const ev = evaluateCommand('r\\m -rf /')
    expect(ev.severity).toBe(Severity.BLOCK)
  })

  it('百分号编码 rm%20-rf%20/ → 命中 BLOCK', () => {
    const ev = evaluateCommand('rm%20-rf%20/')
    expect(ev.severity).toBe(Severity.BLOCK)
  })

  it('空字节插入 rm\\x00 -rf / → 命中 BLOCK', () => {
    const ev = evaluateCommand('rm\x00 -rf /')
    expect(ev.severity).toBe(Severity.BLOCK)
  })

  it('PowerShell FromBase64String 形态 → 命中', () => {
    // 解出 "rm -rf /" 的等价危险动词即可（这里用 shutdown 更容易构造）
    const b64 = Buffer.from('shutdown /s').toString('base64')
    const ev = evaluateCommand(`powershell -c "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | iex"`)
    expect(ev.severity).toBeGreaterThanOrEqual(Severity.HIGH)
  })
})

describe('命令归一化 · 正常命令不得误报', () => {
  it('普通只读命令仍为 SAFE', () => {
    expect(evaluateCommand('ls -la').severity).toBe(Severity.SAFE)
    expect(evaluateCommand('git status').severity).toBe(Severity.SAFE)
    expect(evaluateCommand('npm run build').severity).toBe(Severity.SAFE)
  })

  it('无害的 base64 解码不应被判为高危', () => {
    const b64 = Buffer.from('hello world').toString('base64')
    const ev = evaluateCommand(`echo ${b64} | base64 -d`)
    expect(ev.severity).toBeLessThan(Severity.HIGH)
  })

  it('含长标识符的普通命令不误报', () => {
    expect(evaluateCommand('node scripts/buildProductionBundle.js').severity).toBe(Severity.SAFE)
  })

  it('原文本身仍被评估（归一化是加法不是替换）', () => {
    expect(evaluateCommand('del C:\\Windows\\*').severity).toBe(Severity.BLOCK)
  })
})

describe('normalizeCommand 纯函数契约', () => {
  it('返回多个候选形态且包含原文', () => {
    const forms = normalizeCommand('r\\m%20-rf%20/')
    expect(forms).toContain('r\\m%20-rf%20/')
    expect(forms.length).toBeGreaterThan(1)
  })

  it('对安全命令不产生荒谬候选', () => {
    const forms = normalizeCommand('ls')
    expect(forms.every(f => typeof f === 'string')).toBe(true)
  })
})
