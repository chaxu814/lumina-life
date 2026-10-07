// ============================================================
// tests/codingDisciplineWiring.test.ts
//
// 【这个测试锁的是什么】
//   用户反馈「agent 不会写代码」。根因不是缺工具（agent 模式本就含
//   file_read / file_write / file_edit / shell_exec），而是两条纪律
//   从未接进主流程：
//     ① agentRunner.initSystemPrompt() 调用 buildSystemPrompt 时
//        **漏传 options.userInput** → 路由提示 / 模糊守卫 / Coding 纪律
//        三个注入全部失效（peekRouteHint 永不被调用）；
//     ② coding-mode-injector.ts 的 8 套执行纪律是**死代码**。
//
//   这些用例是「旧行为会失败、新行为会通过」的回归测试：
//   任何人想撤掉接线，这里立刻变红。
// ============================================================

import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../electron/prompts/systemPrompt'
import {
  buildCodingDisciplinePrompt,
  detectCodingScenario,
} from '../electron/prompts/coding-mode-injector'

const build = (userInput?: string): string =>
  buildSystemPrompt('lumina', undefined, {
    skipSoul: false,
    injectSkills: false,
    userInput,
  })

const CODING_SIGNATURES = [
  'Coding Mode',
  'Bug 修复模式',
  '重构模式',
  '代码审查模式',
  '测试模式',
  '新功能实现模式',
]

const hasCodingDiscipline = (prompt: string): boolean =>
  CODING_SIGNATURES.some(s => prompt.includes(s))

// ═══════════════════════════════════════════════════════════
// 接线：传了 userInput 才注入
// ═══════════════════════════════════════════════════════════

describe('Coding 纪律接线 — buildSystemPrompt', () => {
  it('传了编程任务的 userInput → 注入 Coding 纪律', () => {
    const prompt = build('帮我写一个爬虫脚本')
    expect(hasCodingDiscipline(prompt)).toBe(true)
  })

  it('bug 修复任务 → 注入「Bug 修复模式」且含「先复现再修复」', () => {
    const prompt = build('这个 bug 帮我修一下')
    expect(prompt).toContain('Bug 修复模式')
    expect(prompt).toContain('先复现')
  })

  it('不传 userInput → 不注入任何 Coding 纪律（旧行为，不能被误触发）', () => {
    const prompt = build(undefined)
    expect(hasCodingDiscipline(prompt)).toBe(false)
  })

  it('普通对话（非编程）→ 不注入 Coding 纪律', () => {
    const prompt = build('今天天气怎么样')
    expect(hasCodingDiscipline(prompt)).toBe(false)
  })

  it('编程任务 → 附带「必须真的动手改文件 / 自己顶上」的执行要求', () => {
    const prompt = build('帮我写一个爬虫脚本')
    expect(prompt).toContain('必须真的动手改文件')
    expect(prompt).toContain('不要因为')
  })

  it('编程任务 → 同时注入路由提醒（说明路由链路已接通）', () => {
    const prompt = build('帮我写一个爬虫脚本')
    expect(prompt).toContain('🧭 路由提醒')
  })
})

// ═══════════════════════════════════════════════════════════
// 无状态入口：buildCodingDisciplinePrompt / detectCodingScenario
// ═══════════════════════════════════════════════════════════

describe('buildCodingDisciplinePrompt — 无状态场景入口', () => {
  it('空输入 → null', () => {
    expect(buildCodingDisciplinePrompt('')).toBeNull()
    expect(buildCodingDisciplinePrompt('   ')).toBeNull()
  })

  it('无编程关键词 → null', () => {
    expect(buildCodingDisciplinePrompt('今天天气怎么样')).toBeNull()
  })

  it('forceScenario 可强制指定场景（上游判定为编程但场景检测未命中时）', () => {
    const p = buildCodingDisciplinePrompt('随便什么', 'general')
    expect(p).toContain('Coding Mode')
  })

  it('debug 场景含「先复现，再修复」铁律', () => {
    const p = buildCodingDisciplinePrompt('这个报错怎么修')
    expect(p).toContain('先复现')
  })
})

describe('detectCodingScenario — 场景识别', () => {
  it('识别 debug', () => {
    expect(detectCodingScenario('这个报错怎么修')).toBe('debug')
  })
  it('识别 git', () => {
    expect(detectCodingScenario('帮我 git commit 一下')).toBe('git')
  })
  it('非编程 → null', () => {
    expect(detectCodingScenario('你好呀')).toBeNull()
  })
})
