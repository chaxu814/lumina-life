// ============================================================
// tests/roleUnificationSOUL.test.ts
//
// 锁定产品确认的角色分工（同名反向的 bug 修复）：
//   热茶 = 程序员（能写代码/跑命令）｜Yak = 数据分析师兼审查员（只审不改）
//
// 为什么这个测试盯的是 SOUL_*.md 本身：
//   systemPrompt.ts 真正生效的是项目根目录下这三份 md
//   （loadMdFile(getLuminaRoot(), 'SOUL_YAK.md' / 'SOUL_RECHA.md')），
//   代码里的兜底文案只在文件加载失败时才用 —— 只测兜底等于没测。
//
// 边界：本文件只断言「角色统一」这一条主线，不重复 systemPromptFactDiscipline
//       对事实纪律段落的覆盖。
// ============================================================

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CODE_MODE, ANALYZE_MODE } from '../electron/agentTeamPersonas'
import { TEAM_MEMBERS } from '../src/data/agentRoles'

const ROOT = path.resolve(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8')

const YAK_SOUL = read('SOUL_YAK.md')
const RECHA_SOUL = read('SOUL_RECHA.md')
const LUMINA_SOUL = read('SOUL_LUMINA.md')
const PERSONAS_TS = read('electron/agentTeamPersonas.ts')

/** 由「委托给 X 做 Y」抽出的 (委托人, 事由) 对，用来校验委托方向 */
function delegationsOf(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const re = /委托给?\s*\**(热茶|Yak)\**\s*[（(]?([^）)\n]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {out.push([m[1], m[2]])}
  return out
}

/** 写代码这类活 = 热茶的；审查/挑错这类活 = Yak 的 */
const CODE_TASKS = /写代码|写个|调试|重构|跑测试|实现|开发|改代码/
const REVIEW_TASKS = /审查|review|挑逻辑|挑错|反面论证|风险评估|核对数据|数据核对/

/**
 * 抽出文本里所有「委托 / 交给 / 派给」关系，两种语序都覆盖：
 *   A. 「写代码 → 委托给 Yak」  （事由在前）
 *   B. 「委托给 Yak 做代码审查」（事由在后）
 * 括注（角色名，如"（数据分析师兼审查员）"）先剥掉，否则"审查员"会被误判成派活。
 */
function parseDelegations(text: string): Array<{ who: string; task: string }> {
  const flat = text.replace(/\*\*/g, '').replace(/[（(][^）)\n]{0,30}[）)]/g, '')
  const out: Array<{ who: string; task: string }> = []

  // A：事由 → 人
  // 注意：一律用 [ \t]* 而不是 \s*，否则换行会把下一条委托的尾巴吞进当前事由里
  const arrow = /([^。\n；;]{1,40}?)[ \t]*[→➜>][ \t]*(?:委托(?:给)?|交给|派给)[ \t]*(热茶|Yak)/g
  let m: RegExpExecArray | null
  while ((m = arrow.exec(flat)) !== null) {
    out.push({ who: m[2], task: m[1].replace(/^[^一-龥A-Za-z]+/, '').trim() })
  }
  // B：人 → 事由（只取到第一个逗号/句号为止，避免把后一条委托的尾巴算进来）
  const direct = /(?:委托(?:给)?|交给|派给)[ \t]*(热茶|Yak)[ \t]*(?:来|去做|负责)?[ \t]*([^，,。；;\n]{0,24})/g
  while ((m = direct.exec(flat)) !== null) {
    out.push({ who: m[1], task: (m[2] ?? '').trim() })
  }
  return out
}

/** 返回所有"派反了活"的关系（Yak 被派去写代码 / 热茶被派去审查） */
function reversedDelegations(text: string): string[] {
  return parseDelegations(text)
    .filter(({ who, task }) =>
      who === 'Yak' ? CODE_TASKS.test(task) : REVIEW_TASKS.test(task))
    .map(({ who, task }) => `${who} ← "${task}"`)
}

describe('SOUL_YAK.md — 数据分析师兼审查员（只审不改）', () => {
  it('明确不写代码、不改代码', () => {
    expect(YAK_SOUL).toMatch(/你不写代码、不改代码|不写代码/)
    expect(YAK_SOUL).toContain('只审不改')
    expect(YAK_SOUL, '修复建议必须交给热茶执行，不能自己动手').toMatch(/交给热茶/)
  })

  it('定位是数据分析师兼审查员，不是代码工程师', () => {
    expect(YAK_SOUL).toContain('数据分析师兼审查员')
    expect(YAK_SOUL).not.toContain('代码工程师')
    expect(YAK_SOUL).not.toMatch(/你是\s*Yak[^\n]*代码工程师/)
  })

  it('保留了五条工程约束（不许在改写中丢）', () => {
    // 1 只说有证据的事实
    expect(YAK_SOUL).toContain('只说有证据的事实')
    // 2 没问题就明说没问题
    expect(YAK_SOUL).toMatch(/没问题就明说没问题/)
    expect(YAK_SOUL).toMatch(/不要为了显得尽责而编造问题/)
    // 3 有问题给具体位置和原因
    expect(YAK_SOUL).toMatch(/有问题必须给具体位置和原因/)
    // 4 没有依据就说数据不足
    expect(YAK_SOUL).toContain('数据不足，无法判断')
    // 5 结论完整返回，不许截断
    expect(YAK_SOUL).toMatch(/结论必须完整返回|结论\*\*完整\*\*传给/)
    expect(YAK_SOUL).toMatch(/不许截断/)
  })

  it('原有的"招实习生/拆任务"已换成符合审查员身份的对抗式评审', () => {
    expect(YAK_SOUL).toContain('召集对抗式评审团')
    expect(YAK_SOUL).not.toMatch(/招(临时)?实习生/)
    expect(YAK_SOUL).not.toContain('InternPool')
  })
})

describe('SOUL_RECHA.md — 代码工程师（先动手，写完必验证）', () => {
  it('明确不做审查（审查是 Yak 的活）', () => {
    expect(RECHA_SOUL).toMatch(/你不做审查|不做审查/)
    expect(RECHA_SOUL).toMatch(/审查[^。\n]*是\s*Yak\s*的活|是 Yak 的活/)
  })

  it('定位是代码工程师，且不再自我否定写代码', () => {
    expect(RECHA_SOUL).toContain('代码工程师')
    expect(RECHA_SOUL).toMatch(/你负责写代码|写代码、调试/)
    expect(RECHA_SOUL).not.toContain('绝对不能自己写代码')
    expect(RECHA_SOUL).not.toContain('审查员')
  })

  it('保留了四条干活约束', () => {
    expect(RECHA_SOUL).toMatch(/先动手再说话/)
    expect(RECHA_SOUL).toMatch(/说「完成了」之前必须验证过/)
    expect(RECHA_SOUL).toContain('应该没问题')
    expect(RECHA_SOUL).toContain('大概可用')
    expect(RECHA_SOUL).toMatch(/需求有歧义且猜错代价高/)
    expect(RECHA_SOUL).toMatch(/做不到直接说做不到/)
  })
})

describe('SOUL_LUMINA.md — 委托规则方向正确', () => {
  it('写代码/调试/重构 → 热茶；审查/挑错/风险评估 → Yak', () => {
    expect(LUMINA_SOUL).toMatch(/委托给?\s*热茶[^\n]*写代码|写代码[^\n]*→\s*委托给?\s*热茶/)
    expect(LUMINA_SOUL).toMatch(/委托给?\s*Yak[^\n]*审查|审查[^\n]*→\s*委托给?\s*Yak/)

    const pairs = delegationsOf(LUMINA_SOUL)
    const yakTasks = pairs.filter(([who]) => who === 'Yak').map(([, what]) => what).join('|')
    const rechaTasks = pairs.filter(([who]) => who === '热茶').map(([, what]) => what).join('|')
    expect(yakTasks, `Yak 被派到的活不应包含写代码：${yakTasks}`).not.toMatch(/写代码|调试|重构/)
    expect(rechaTasks, `热茶被派到的活不应包含审查：${rechaTasks}`).not.toMatch(/审查|挑逻辑|反面论证|评估风险/)
  })
})

describe('模式配置 — CODE_MODE 程序员 / ANALYZE_MODE 分析审查', () => {
  it('CODE_MODE 绑定热茶（SOUL_RECHA.md）', () => {
    expect(CODE_MODE.soulFile).toBe('SOUL_RECHA.md')
    expect(CODE_MODE.id).toBe('code')
  })

  it('ANALYZE_MODE 绑定 Yak（SOUL_YAK.md）', () => {
    expect(ANALYZE_MODE.soulFile).toBe('SOUL_YAK.md')
    expect(ANALYZE_MODE.id).toBe('analyze')
  })

  it('两个模式的文案不再把委托方向写反', () => {
    const codeText = [CODE_MODE.description, CODE_MODE.stylePrompt, CODE_MODE.extraRules].join('\n')
    const analyzeText = [ANALYZE_MODE.description, ANALYZE_MODE.stylePrompt, ANALYZE_MODE.extraRules].join('\n')

    expect(reversedDelegations(codeText), 'CODE_MODE 委托方向写反').toEqual([])
    expect(reversedDelegations(analyzeText), 'ANALYZE_MODE 委托方向写反').toEqual([])

    // 正确方向各出现一次
    expect(codeText).toMatch(/委托给?\s*热茶/)
    expect(analyzeText).toMatch(/委托给?\s*Yak/)
  })
})

describe('agentRoles.ts — Yak 不再被当成写代码的人', () => {
  it("Yak 的 roles 不含 'code'", () => {
    const yak = TEAM_MEMBERS.find(m => m.id === 'yak')
    expect(yak).toBeTruthy()
    expect(yak!.roles).not.toContain('code')
    // 审查/分析相关的保留
    for (const kept of ['learn', 'intel', 'work']) {
      expect(yak!.roles, `Yak 的 roles 不应丢掉 ${kept}`).toContain(kept)
    }
  })

  it('热茶仍然是写代码的人', () => {
    const recha = TEAM_MEMBERS.find(m => m.id === 'recha')
    expect(recha!.roles).toContain('code')
  })
})

describe('占位符 {{SKILL_LIST}} 仍在（systemPrompt 会替换它）', () => {
  it('Yak / 热茶两份 SOUL 都保留了占位符', () => {
    expect(YAK_SOUL).toContain('{{SKILL_LIST}}')
    expect(RECHA_SOUL).toContain('{{SKILL_LIST}}')
  })

  it('LUMINA 的 SOUL 从来不需要占位符（它不注入 skill 列表）', () => {
    // 记录现状：systemPrompt.ts 只在 yak / recha 分支替换 {{SKILL_LIST}}
    expect(LUMINA_SOUL).not.toContain('{{SKILL_LIST}}')
  })
})

describe('反向断言 —— 旧的同名反向表述不得复活', () => {
  const OWNED = [
    ['SOUL_YAK.md', YAK_SOUL],
    ['SOUL_RECHA.md', RECHA_SOUL],
    ['SOUL_LUMINA.md', LUMINA_SOUL],
    ['electron/agentTeamPersonas.ts', PERSONAS_TS],
  ] as const

  it('搜不到"委托给 Yak 写代码"/"委托给热茶审查"类表述', () => {
    for (const [file, text] of OWNED) {
      expect(reversedDelegations(text), `${file} 委托方向写反`).toEqual([])
      expect(text, `${file} 出现"Yak 写代码"`).not.toMatch(/Yak\s*(负责|来)?\s*写代码/)
      expect(text, `${file} 出现"热茶…审查"`).not.toMatch(/热茶\s*(负责|来)?\s*审查(?!员)/)
    }
  })

  it('反向断言不是空跑：把正确文案喂进去必须能被抓出来', () => {
    // 证明上面的检测器确实认得这两种坏写法（防止规则写松了永远通过）
    expect(reversedDelegations('写代码 → 委托给 Yak')).toHaveLength(1)
    expect(reversedDelegations('审查代码 → 委托给热茶')).toHaveLength(1)
    expect(reversedDelegations('写代码 → 委托给热茶（代码工程师），审查 → 委托给 Yak（数据分析师兼审查员）')).toEqual([])
  })

  it('OWNED 列表非空（防止上面几条断言空跑）', () => {
    expect(OWNED.length).toBe(4)
  })
})
