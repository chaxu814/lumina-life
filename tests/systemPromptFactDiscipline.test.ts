// ============================================================
// tests/systemPromptFactDiscipline.test.ts
//
// 锁定一条产品底线：事实纪律（不编造 / 标来源 / 委托结果完整呈现 /
// 失败如实说 / 缺信息就说缺什么）在**任何场景**都必须出现在 prompt 里，
// 尤其是群聊（skipSoul=true，会剥掉人格风格）——
// 旧实现把三条纪律混在 `## ✨ 你的风格` 里，群聊整段被剥，等于群聊无底线。
//
// 同时锁定角色统一文案：Yak = 代码工程师，热茶 = 审查员。
// ============================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import { buildSystemPrompt } from '../electron/prompts/systemPrompt'

const FACT_HEADING = '## 🧷 事实纪律'
const PERSONA_HEADING_RE = /^##\s+.*你的风格/
/** 整段 prompt 上匹配标题用：必须带 m，否则 ^ 只锚定整串开头 */
const PERSONA_HEADING_IN_TEXT_RE = /^##\s+.*你的风格/m
const H2_RE = /^##\s+[^#]/

/** 五条底线各取一个识别片段，缺一条即视为底线残缺 */
const FIVE_RULES = [
  '这部分信息不够确定',          // 1 不确定就明说，禁止编造
  '标注来源',                     // 2 引用搜索/工具结果要标来源
  '必须**完整**呈现给用户',        // 3 团队委托结果必须完整呈现
  '如实说失败',                    // 4 工具/查询失败如实说
  '还缺什么',                     // 5 信息不足要说清缺什么
]

const buildLumina = (socialMode: boolean): string =>
  buildSystemPrompt('lumina', undefined, { skipSoul: socialMode, injectSkills: false })

/** 取出某个二级标题对应的整段（不含下一个二级标题） */
function sectionOf(prompt: string, headingRe: RegExp): string {
  const lines = prompt.split('\n')
  const start = lines.findIndex(l => headingRe.test(l))
  if (start < 0) {return ''}
  const end = lines.findIndex((l, i) => i > start && H2_RE.test(l))
  return lines.slice(start, end < 0 ? lines.length : end).join('\n')
}

const h2Headings = (prompt: string): string[] =>
  prompt.split('\n').filter(l => H2_RE.test(l))

/**
 * 取 prompt 中 `## 💭 当前模式人格`（SOUL.md）之前的部分。
 * 为什么测试里要单独处理：skipSoul 本来就不该注入 SOUL，这是既有设计；
 * 本用例只关心"底座 AGENTS.md 的人格段被剥离时，有没有顺手吞掉后面的章节"。
 */
const SOUL_MARKER = '## 💭 当前模式人格'
function basePrefix(prompt: string): string {
  const idx = prompt.indexOf(SOUL_MARKER)
  return idx >= 0 ? prompt.slice(0, idx) : prompt
}

/** 孤立的 ### 子标题 = 上一个段落被吞掉的证据（Markdown 结构已损坏） */
function hasOrphanSubheadings(prompt: string): boolean {
  let seenH2 = false
  for (const line of prompt.split('\n')) {
    if (H2_RE.test(line)) {seenH2 = true; continue}
    if (/^###\s/.test(line) && !seenH2) {return true}
  }
  return false
}

describe('事实纪律 — 任何场景都生效', () => {
  it('socialMode（群聊）下五条事实纪律全部保留', () => {
    const prompt = buildLumina(true)
    expect(prompt).toContain(FACT_HEADING)
    for (const rule of FIVE_RULES) {
      expect(prompt, `群聊 prompt 缺少事实纪律：${rule}`).toContain(rule)
    }
  })

  it('非 socialMode 下五条事实纪律同样存在', () => {
    const prompt = buildLumina(false)
    expect(prompt).toContain(FACT_HEADING)
    for (const rule of FIVE_RULES) {
      expect(prompt, `常规 prompt 缺少事实纪律：${rule}`).toContain(rule)
    }
  })

  it('事实纪律只出现一次（不是复制一份到人格里）', () => {
    const social = buildLumina(true)
    const full = buildLumina(false)

    // 标题唯一
    expect(social.split(FACT_HEADING).length - 1).toBe(1)
    expect(full.split(FACT_HEADING).length - 1).toBe(1)

    // "呈现给用户"只可能出现在新段里（模板的人格/回复原则里没有这句）
    expect(social.split('呈现给用户').length - 1).toBe(1)
    expect(full.split('呈现给用户').length - 1).toBe(1)

    // 人格段里已经不再藏着同样的三条（旧实现：挪走而不是复制）
    const persona = sectionOf(full, PERSONA_HEADING_RE)
    expect(persona, '常规 prompt 里不应再存在人格风格段？').not.toBe('')
    for (const legacy of ['不编造', '标注来源', '团队委托结果必须完整呈现']) {
      expect(persona, `人格风格段仍残留事实纪律条目：${legacy}`).not.toContain(legacy)
    }
    // 人格本身必须还在（剥离逻辑只该作用于群聊）
    expect(persona).toContain('温暖干脆')
  })

  it('剥离人格风格后：标题结构完整、下一段没有被吞掉', () => {
    const full = buildLumina(false)
    const social = buildLumina(true)

    // 人格段在群聊里确实被剥掉了
    expect(full).toMatch(PERSONA_HEADING_IN_TEXT_RE)
    expect(social).not.toMatch(PERSONA_HEADING_IN_TEXT_RE)

    // 除人格标题外，底座里的二级标题一个都不能少（下一段没被吞）
    const fullBase = basePrefix(full)
    const socialH2 = new Set(h2Headings(social))
    for (const h of h2Headings(fullBase)) {
      if (PERSONA_HEADING_RE.test(h)) {continue}
      expect(socialH2.has(h), `群聊 prompt 丢失章节：${h}`).toBe(true)
    }
    // 紧跟人格段之后的那一段必须原样保留
    const lines = fullBase.split('\n')
    const personaIdx = lines.findIndex(l => PERSONA_HEADING_RE.test(l))
    const nextH2 = lines.find((l, i) => i > personaIdx && H2_RE.test(l))
    expect(nextH2).toBeTruthy()
    expect(social).toContain(nextH2 as string)

    // 段落边界完整：无 3 连换行、无孤儿子标题
    expect(social).not.toMatch(/\n{3,}/)
    expect(hasOrphanSubheadings(social)).toBe(false)
  })

  it('事实纪律段在模板文件中位于"被剥离范围"之外', () => {
    // 构建器可能加载的模板：项目根 AGENTS.md（回退路径）与 electron/agents/lumina/AGENTS.md（标准路径）
    const root = nodePath.resolve(__dirname, '..')
    const templates = [
      nodePath.join(root, 'AGENTS.md'),
      nodePath.join(root, 'electron', 'agents', 'lumina', 'AGENTS.md'),
    ].filter(p => nodeFs.existsSync(p))
    expect(templates.length).toBeGreaterThan(0)

    const social = buildLumina(true)

    for (const file of templates) {
      const raw = nodeFs.readFileSync(file, 'utf8')
      const personaRaw = sectionOf(raw, PERSONA_HEADING_RE)
      if (!personaRaw) {continue}

      // 剥离范围 = 人格段；事实纪律不能落在这一段里
      expect(personaRaw, `${file} 的人格段里不应包含事实纪律段`).not.toContain('🧷 事实纪律')

      // 而人格段的首条内容在群聊 prompt 中必须已经消失
      const firstBullet = personaRaw.split('\n').find(l => /^\s*[-*]/.test(l))
      if (firstBullet) {
        expect(social, `${file} 的人格条目未被剥离`).not.toContain(firstBullet.trim())
      }
    }

    // 反证：剥离范围之外的内容（五条纪律）确实留在了群聊 prompt 里
    expect(social).toContain(FACT_HEADING)
    for (const rule of FIVE_RULES) {expect(social).toContain(rule)}
  })
})

// ── 角色统一文案兜底（Yak = 代码工程师，热茶 = 审查员） ──
// 这段文案只在 SOUL/AGENTS md 加载失败时才会被用到，所以通过 mock fs
// 让身份文件"加载失败"，强制走到降级分支。
describe('后台成员降级文案（角色统一）', () => {
  afterEach(() => {
    vi.doUnmock('fs')
    vi.resetModules()
  })

  async function buildFallback(agentId: 'yak' | 'recha', socialMode: boolean): Promise<string> {
    vi.resetModules()
    vi.doMock('fs', async () => {
      const real = await vi.importActual<typeof import('fs')>('fs')
      const missing = /[\\/](AGENTS|SOUL|SOUL_LUMINA|SOUL_YAK|SOUL_RECHA|PROFILE|MEMORY)\.md$/
      const isMissing = (p: unknown) => missing.test(String(p))
      return {
        ...real,
        existsSync: (p: string) => (isMissing(p) ? false : real.existsSync(p)),
        readFileSync: (p: string, ...rest: unknown[]) => {
          if (isMissing(p)) {throw new Error('mocked: identity file missing')}
          return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
        },
      }
    })
    const mod = await import('../electron/prompts/systemPrompt')
    return mod.buildSystemPrompt(agentId, undefined, { skipSoul: socialMode, injectSkills: false })
  }

  it('Yak 的降级文案是代码工程师，不含"数据分析师/审查员"', async () => {
    for (const socialMode of [false, true]) {
      const prompt = await buildFallback('yak', socialMode)
      expect(prompt).toContain('Yak')
      expect(prompt).toContain('代码工程师')
      expect(prompt, `Yak 降级文案不应出现"数据分析师"（socialMode=${socialMode}）`).not.toContain('数据分析师')
    }
  })

  it('热茶的降级文案是审查员，不含"代码工程师/写代码"', async () => {
    for (const socialMode of [false, true]) {
      const prompt = await buildFallback('recha', socialMode)
      // 只断言"角色文案"部分——共享的「自我认知」块会合法地提到团队里有代码工程师 Yak
      const rolePart = prompt.split('## 🪞 自我认知')[0]
      expect(rolePart).toContain('热茶')
      expect(rolePart).toContain('审查员')
      expect(rolePart, `热茶降级文案不应出现"代码工程师"（socialMode=${socialMode}）`).not.toContain('代码工程师')
      expect(rolePart, `热茶降级文案不应出现"写代码"（socialMode=${socialMode}）`).not.toContain('写代码')
    }
  })
})
