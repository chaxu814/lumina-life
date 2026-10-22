// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
/**
 * roleUnificationSOUL.test.ts
 *
 * 【方向已翻正 — 2026-10】本测试锁定的权威口径（来自 AGENTS.md，用户已确认）：
 *   - yak  = 代码工程师：写代码/调试/重构/跑测试；可写文件、可执行命令、可 git 提交
 *   - recha = 数据分析师兼审查员：代码审查/挑逻辑漏洞/风险评估/反面论证；只读不写
 *
 * 它从两个入口各取一份"人"：
 *   1. electron/agentTeamPersonas.ts —— TEAM_YAK / TEAM_RECHA / TEAM_PERSONAS / CODE_MODE / ANALYZE_MODE
 *   2. electron/agents/yak/SOUL_YAK.md 与 electron/agents/recha/SOUL_RECHA.md（产品侧 SOUL 文件）
 *
 * 任何一个入口把"谁写代码、谁只审不改"说反，本测试立刻红。
 *
 * 反向断言（防回归）：
 *   我们维护一个"反向委托检测器"，它扫描 OWNED_FILES，
 *   凡是出现「把写代码的活派给热茶」或「把审查的活派给 Yak」的表述，一律判失败。
 *   这样即使将来有人改回旧写法，本测试也能抓住。
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { TEAM_YAK, TEAM_RECHA, TEAM_PERSONAS, CODE_MODE, ANALYZE_MODE } from '../electron/agentTeamPersonas'
import { TEAM_MEMBERS } from '../src/data/agentRoles'

const ROOT = path.join(__dirname, '..')

function read(p: string): string {
  return fs.readFileSync(path.join(ROOT, p), 'utf-8')
}

// 角色各自的 SOUL 文件。
// 根目录 SOUL_*.md 是用户本地覆盖文件（.gitignore 已排除，公开克隆/CI 里不存在）；
// 缺失时回退到随仓库分发的出厂版本 electron/agents/<id>/SOUL.md，
// 保证在干净克隆上断言的是真正会随产品发布的出厂人格。
function readWithFallback(rootFile: string, shipped: string): string {
  const p = path.join(ROOT, rootFile)
  if (fs.existsSync(p)) {return fs.readFileSync(p, 'utf-8')}
  return read(shipped)
}
const YAK_SOUL = readWithFallback('SOUL_YAK.md', 'electron/agents/yak/SOUL.md')
const RECHA_SOUL = readWithFallback('SOUL_RECHA.md', 'electron/agents/recha/SOUL.md')
const LUMINA_SOUL = readWithFallback('SOUL_LUMINA.md', 'electron/agents/lumina/SOUL.md')

// 我负责改的文件（反向断言扫描范围）。
// 注意：这里同时覆盖 electron 与前端 persona/roles 两份入口，保证它们不互相打架。
const OWNED_FILES: Record<string, string> = {
  'electron/agentTeamPersonas.ts': read('electron/agentTeamPersonas.ts'),
  'src/data/agentRoles.ts': read('src/data/agentRoles.ts'),
}

// ─── 反向委托检测器 ──────────────────────────────────────────────────────
// 口径（新）：
//   - yak  = 写代码（coding tasks 派给 yak 才对）
//   - recha = 审查（review tasks 派给 recha 才对）
// "反向" = 写代码派给热茶，或审查派给 Yak。
// 检测器只挑「明确的委托句」，不误伤一般性的名词提及。

const CODE_TASKS = /写代码|写个|调试|重构|跑测试|实现|开发|改代码/
const REVIEW_TASKS = /审查|review|挑逻辑|挑错|反面论证|风险评估|核对数据|数据核对/

/** 从一段文本里抽出所有「任务 → 委托给 X」的箭头句 */
function parseDelegations(text: string): Array<{ who: string; task: string }> {
  const out: Array<{ who: string; task: string }> = []
  // 去掉括号注释，避免「委托给 yak（代码工程师）」里的括号干扰判断
  const clean = text.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '')
  const re = /([^。\n；;]{1,40}?)[ \t]*[→➜>][ \t]*(?:委托(?:给)?|交给|派给)[ \t]*(热茶|Yak)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) {
    out.push({ task: m[1].trim(), who: m[2].trim() })
  }
  return out
}

/**
 * 反向委托检测：
 *   who === '热茶' 且任务像写代码   → 反向（热茶不该写代码）
 *   who === 'Yak' 且任务像审查     → 反向（Yak 不该审查）
 */
function reversedDelegations(text: string) {
  return parseDelegations(text)
    .filter(({ who, task }) =>
      who === '热茶' ? CODE_TASKS.test(task) : REVIEW_TASKS.test(task))
    .map(({ who, task }) => `反向: ${task.trim()} → ${who}`)
}

describe('角色方向翻正（2026-10）：yak=代码工程师，recha=审查员', () => {
  it('sanity：TEAM_YAK / TEAM_RECHA 的 id 没写反', () => {
    expect(TEAM_YAK.id).toBe('yak')
    expect(TEAM_RECHA.id).toBe('recha')
  })

  it('TEAM_YAK 是代码工程师（先动手、写完必验证）', () => {
    // 编码类角色：写完由 热茶（审查员）审阅，不自己审
    expect(TEAM_YAK.systemPrompt).toMatch(/热茶（审查员）审阅|审查[^。\n]*是\s*热茶\s*的活/)
    expect(TEAM_YAK.blindSpots.join('\n')).toMatch(/审查.*热茶|那是热茶的活/)
    expect(TEAM_YAK.description).toContain('代码工程师')
    expect(TEAM_YAK.systemPrompt).toMatch(/先动手再说话|写完必须用 shell_exec 验证/)
    // 干活者不该有"只审不改/绝对不能写代码"那套话
    expect(TEAM_YAK.systemPrompt).not.toContain('绝对不能自己写代码')
    expect(TEAM_YAK.systemPrompt).not.toContain('只审不改')
  })

  it('TEAM_RECHA 是数据分析师兼审查员（只审不改）', () => {
    expect(TEAM_RECHA.systemPrompt).toMatch(/你不写代码|只审不改/)
    expect(TEAM_RECHA.systemPrompt).toMatch(/交给 Yak|由 Yak/)
    expect(TEAM_RECHA.description).toContain('审查员')
    // 审查者不该自称"代码工程师"（但它可以在描述里提到 Yak 是代码工程师）
    expect(TEAM_RECHA.systemPrompt).not.toMatch(/你是\s*热茶[^\n]*代码工程师/)
  })

  it('TEAM_PERSONAS：yak 是技术员(technician)、recha 是分析师(analyst)', () => {
    expect(TEAM_PERSONAS.yak.archetype).toBe('technician')
    expect(TEAM_PERSONAS.recha.archetype).toBe('analyst')
    expect(TEAM_PERSONAS.yak.allowedTools).toContain('file_write')
    expect(TEAM_PERSONAS.recha.allowedTools).not.toContain('file_write')
  })
})

describe('SOUL_YAK.md — 代码工程师（先动手，写完必验证）', () => {
  it('明确"不做审查、审查是热茶的活"', () => {
    expect(YAK_SOUL).toMatch(/你不做审查|不做审查/)
    expect(YAK_SOUL).toMatch(/审查[^。\n]*是\s*热茶\s*的活|是 热茶 的活/)
  })

  it('定位是代码工程师', () => {
    expect(YAK_SOUL).toContain('代码工程师')
    expect(YAK_SOUL).toMatch(/你负责写代码|写代码、调试/)
    // 不该带"绝对不能自己写代码""只审不改"那套审查员话术
    expect(YAK_SOUL).not.toContain('绝对不能自己写代码')
    expect(YAK_SOUL).not.toContain('只审不改')
  })

  it('"干活者的 4 条约束"在场（先动手/必验证/不打包票/做不到直说）', () => {
    expect(YAK_SOUL).toMatch(/先动手再说话|先动手/)
    expect(YAK_SOUL).toMatch(/说「完成了」之前必须验证|写完必须验证|必须验证过/)
    expect(YAK_SOUL).toContain('应该没问题')
    expect(YAK_SOUL).toContain('大概可用')
    expect(YAK_SOUL).toMatch(/需求有歧义且猜错代价高/)
    expect(YAK_SOUL).toMatch(/做不到直接说做不到|做不到.*直接说/)
  })
})

describe('SOUL_RECHA.md — 数据分析师兼审查员（只审不改）', () => {
  it('明确"不写代码、只审不改、改代码交给 Yak"', () => {
    expect(RECHA_SOUL).toMatch(/你不写代码、不改代码|不写代码/)
    expect(RECHA_SOUL).toContain('只审不改')
    expect(RECHA_SOUL).toMatch(/交给 Yak|由 Yak/)
  })

  it('定位是审查员，不自称代码工程师', () => {
    expect(RECHA_SOUL).toContain('审查员')
    expect(RECHA_SOUL).not.toContain('代码工程师')
    // 任何"你是 X…代码工程师"的句子都不该落在热茶身上
    expect(RECHA_SOUL).not.toMatch(/你是\s*热茶[^\n]*代码工程师/)
  })

  it('"审查者的 5 条约束"在场（说证据/没问题就明说/不编造问题/给具体位置/数据不足就承认）', () => {
    expect(RECHA_SOUL).toContain('只说有证据的事实')
    expect(RECHA_SOUL).toMatch(/没问题就明说没问题|没发现问题就明说/)
    expect(RECHA_SOUL).toMatch(/不要为了显得尽责而编造问题/)
    expect(RECHA_SOUL).toMatch(/有问题必须给具体位置和原因/)
    expect(RECHA_SOUL).toContain('数据不足，无法判断')
    expect(RECHA_SOUL).toMatch(/结论必须完整返回|结论\*\*完整\*\*传给/)
    expect(RECHA_SOUL).toMatch(/不许截断/)
  })

  it('审查员不招实习生、不搞对抗式评审团以外的执行', () => {
    expect(RECHA_SOUL).toContain('召集对抗式评审团')
    expect(RECHA_SOUL).not.toMatch(/招(临时)?实习生/)
    expect(RECHA_SOUL).not.toContain('InternPool')
  })
})

describe('SOUL_LUMINA.md — 委托方向翻正', () => {
  it('写代码/调试/重构 → Yak；审查/挑错/风险评估 → 热茶', () => {
    expect(LUMINA_SOUL).toMatch(/委托给?\s*Yak[^\n]*写代码|写代码[^\n]*→\s*委托给?\s*Yak/)
    expect(LUMINA_SOUL).toMatch(/委托给?\s*热茶[^\n]*审查|审查[^\n]*→\s*委托给?\s*热茶/)
  })

  it('反向检测器：SOUL_LUMINA.md 里没有"热茶写代码 / Yak审查"', () => {
    expect(reversedDelegations(LUMINA_SOUL)).toEqual([])
    // 从两条"委托规则"里各抓一句，确认角色没接反
    const yakTasks = LUMINA_SOUL.match(/[^\n]*Yak[^\n]*/g)?.join('\n') || ''
    const rechaTasks = LUMINA_SOUL.match(/[^\n]*热茶[^\n]*/g)?.join('\n') || ''
    expect(yakTasks, 'Yak 不该被派去审查').not.toMatch(/审查|挑逻辑|反面论证|评估风险/)
    expect(rechaTasks, '热茶 不该被派去写代码').not.toMatch(/写代码|调试|重构/)
  })
})

describe('模式绑定：CODE_MODE → SOUL_YAK.md，ANALYZE_MODE → SOUL_RECHA.md', () => {
  it('CODE_MODE 绑定 Yak（SOUL_YAK.md）', () => {
    expect(CODE_MODE.soulFile).toBe('SOUL_YAK.md')
  })

  it('ANALYZE_MODE 绑定 热茶（SOUL_RECHA.md）', () => {
    expect(ANALYZE_MODE.soulFile).toBe('SOUL_RECHA.md')
  })

  it('模式文案里的委托方向也正确', () => {
    const codeText = (CODE_MODE.extraRules || '') + '\n' + (CODE_MODE.stylePrompt || '')
    const analyzeText = (ANALYZE_MODE.extraRules || '') + '\n' + (ANALYZE_MODE.stylePrompt || '')
    // 编程模式 → 写代码委托给 Yak
    expect(codeText).toMatch(/委托给?\s*Yak/)
    // 分析/审查模式 → 审查委托给 热茶
    expect(analyzeText).toMatch(/委托给?\s*热茶/)
    // 反向：编程模式文案里不该出现把写代码交给热茶
    expect(reversedDelegations(codeText)).toEqual([])
  })
})

describe('agentRoles.ts — 热茶 不再被当成写代码的人', () => {
  it("热茶 的 roles 不含 'code'", () => {
    const recha = TEAM_MEMBERS.find(m => m.id === 'recha')
    expect(recha).toBeTruthy()
    expect(recha!.roles).not.toContain('code')
    // 分析师/审查类角色仍归热茶
    for (const kept of ['learn', 'intel', 'work']) {
      expect(recha!.roles).toContain(kept)
    }
  })

  it('Yak 仍然是写代码的人', () => {
    const yak = TEAM_MEMBERS.find(m => m.id === 'yak')
    expect(yak).toBeTruthy()
    expect(yak!.roles).toContain('code')
  })
})

describe('反向断言：扫描我负责的文件，旧坏写法不得残留', () => {
  it('{{SKILL_LIST}} 占位符两个 SOUL 都保留', () => {
    expect(YAK_SOUL).toContain('{{SKILL_LIST}}')
    expect(RECHA_SOUL).toContain('{{SKILL_LIST}}')
  })

  it('搜不到"委托给 热茶 写代码"/"委托给 Yak 审查"类反向表述', () => {
    for (const [file, text] of Object.entries(OWNED_FILES)) {
      expect(reversedDelegations(text), `${file} 里出现反向委托`).toEqual([])
      // 编码/执行类语义：不得落在热茶身上
      expect(text, `${file}: 热茶被写成写代码的人`).not.toMatch(/热茶\s*(负责|来)?\s*写代码/)
      // 审查类语义：不得落在 Yak 身上（"审查员"这种名词不算）
      expect(text, `${file}: Yak 被写成审查的人`).not.toMatch(/Yak\s*(负责|来)?\s*审查(?!员)/)
    }
  })

  it('反向检测器自身有效（sanity）', () => {
    // 这些句子应当被检测器抓到
    expect(reversedDelegations('写代码 → 委托给热茶')).toHaveLength(1)
    expect(reversedDelegations('审查代码 → 委托给 Yak')).toHaveLength(1)
    // 正确配置不该被误报
    expect(reversedDelegations('写代码 → 委托给 Yak（代码工程师），审查 → 委托给 热茶（数据分析师兼审查员）')).toEqual([])
  })
})
