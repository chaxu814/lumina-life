// ============================================================
// tests/securityGuardFailClosed.test.ts — 安全闸门 fail-closed 不变量
//
// 【对应真实问题】
// securityGuard.checkToolCall() 是所有工具执行前的安全闸门。
// 旧实现：工具参数不是合法 JSON 时 → allowed: true 放行（fail-open）。
//
// 为什么这是安全问题而不只是代码风格问题：
//   攻击者可以把恶意 payload 藏在**非法 JSON** 里——
//     {"cmd":"rm -rf /",          ← 截断的坏 JSON
//   JSON.parse 失败 → 全部规则检查跳过 → 放行。
//   换句话说，「让安全检查自己失败」反而成了绕过它的手段。
//   这是 fail-open 的教科书案例：**检查失效时默认放行**。
//
// 【风险边界（不夸大）】
// 执行层 tools/registry.ts 对解析失败是 args = {}，
// 所以坏 JSON 里的命令**不会真的被执行**。
// 但仍有两个真问题：
//   ① 工具带着空参数执行，可能产生意外副作用
//   ② 安全审查静默失效，用户与开发者都无从察觉
//
// 【本测试钉住的不变量】
//   **无法完成安全审查时，必须拦截，绝不放行。**
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')
}

describe('securityGuard · fail-closed 不变量', () => {
  const src = readSrc('electron/securityGuard.ts')

  it('参数解析失败时不再 allowed:true（fail-open 已修）', () => {
    // 取 catch 块（参数解析失败的分支）
    const i = src.indexOf('args = JSON.parse(toolCall.function.arguments)')
    expect(i).toBeGreaterThan(-1)
    const catchBlock = src.slice(i, i + 2600)
    const catchStart = catchBlock.indexOf('} catch')
    expect(catchStart).toBeGreaterThan(-1)
    // 只看**代码行**（剔除注释，避免匹配到修复说明里引用的原文）
    const body = catchBlock.slice(catchStart, catchStart + 2400)
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n')

    // 关键：分支代码里不得出现放行
    expect(body).not.toMatch(/allowed:\s*true/)
    // 必须是拒绝 + 需要审批
    expect(body).toMatch(/allowed:\s*false/)
    expect(body).toMatch(/requiresApproval:\s*true/)
  })

  it('放行文案「参数解析失败，放行」已彻底移除', () => {
    expect(src).not.toContain('参数解析失败，放行')
  })

  it('拦截时给出可操作的说明（而不是干巴巴一个 false）', () => {
    expect(src).toMatch(/不是合法 JSON/)
    expect(src).toMatch(/安全审查无法进行|已拦截/)
  })

  it('拦截 finding 字段完整（满足 GuardFinding 类型契约）', () => {
    const i = src.indexOf('GUARD-BADJSON')
    expect(i).toBeGreaterThan(-1)
    const block = src.slice(i - 200, i + 900)
    for (const f of ['id:', 'ruleId:', 'category:', 'severity:', 'title:', 'description:', 'toolName']) {
      expect(block, `finding 缺字段 ${f}`).toMatch(new RegExp(f.replace(':', '\\s*:')))
    }
  })
})

describe('securityGuard · 正常路径不受影响', () => {
  it('合法 JSON 仍走正常规则检查（未被误伤）', () => {
    const src = readSrc('electron/securityGuard.ts')
    const i = src.indexOf('args = JSON.parse(toolCall.function.arguments)')
    const after = src.slice(i, i + 2000)
    // catch 之后应继续进入规则循环
    expect(after).toMatch(/for \(const rule of GUARD_RULES\)/)
  })

  it('「安全检查已禁用」是有意的开关（保留 allowed:true）', () => {
    const src = readSrc('electron/securityGuard.ts')
    // 这是 config.enabled=false 的显式关闭，不是解析失败，两者不能混淆
    expect(src).toMatch(/if \(!this\.config\.enabled\)[\s\S]{0,200}allowed:\s*true/)
  })
})

describe('securityGuard · 执行层兜底（双保险仍然存在）', () => {
  it('执行层解析失败不再静默降级为空参数（已改为显式失败）', () => {
    const reg = readSrc('electron/tools/registry.ts')
    // 旧写法：try { args = JSON.parse(x || '{}') } catch { /* keep empty */ }
    // —— 解析失败就让工具带空参数「正常跑完」并返回 ok:true，
    //    违反本文件自己写的「没做成必须 ok:false」铁律。
    expect(reg).not.toMatch(/\/\*\s*keep empty\s*\*\//)
    // 现在：解析失败走 buildNotExecutedResult（ok:false + 明确说明）
    const n = (reg.match(/buildNotExecutedResult\(/g) || []).length
    expect(n, '缺少解析失败时的显式失败分支').toBeGreaterThan(0)
    expect(reg).toMatch(/参数不是合法 JSON/)
  })

  it('安全闸门仍是第一道防线（审批后才可能走到这里）', () => {
    const reg = readSrc('electron/tools/registry.ts')
    // 顺序：securityGuard 拦截 → 用户审批 → 工具执行。
    // 执行层的显式失败是第二道保险，不是唯一防线。
    const guard = readSrc('electron/securityGuard.ts')
    expect(guard).toMatch(/参数不是合法 JSON/)
  })
})
