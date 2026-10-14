// ============================================================
// adversarialReview.ts — 对抗式评审团 (v3.20, 同类工程实践：N 个怀疑者投票)
//
// 同类项目的验收不是「一个 reviewer 说行就行」：
//   派出 N 个持不同怀疑视角的 agent（正确性 / 安全 / 可复现…）独立挑刺，
//   多数票判定「该方案/声明是否成立」；再上一个「完整性批评员」专查
//   评审本身漏掉了什么（没测的边界、没考虑的回滚、缺失的验收步骤）。
//
// Lumina 落地：
//   - 优先并行委托给热茶（recha，内置审查员）；热茶未配置则雇临时复核员。
//   - 每个怀疑者输出 JSON 判定（pass/fail/uncertain + 问题清单）。
//   - 多数票 + 高危一票否决；完整性批评员补「遗漏清单」。
// ============================================================

import { getDelegationManager } from '../delegationManager'
import { hireAndRun } from './dynamicWorker'
import { reviewTonePrompt } from './relationshipDrama'

export type Verdict = 'pass' | 'fail' | 'uncertain'
export type Severity = 'high' | 'medium' | 'low' | 'none'

export interface ReviewPerspective {
  id: string
  name: string
  /** 该视角的怀疑方向（注入提示词） */
  lens: string
}

export interface SkepticVote {
  perspective: string
  perspectiveName: string
  verdict: Verdict
  severity: Severity
  findings: string[]
  raw: string
  ok: boolean
}

export interface ReviewReport {
  /** 最终是否通过（多数票且无高危） */
  pass: boolean
  voteSummary: { pass: number; fail: number; uncertain: number }
  /** 汇总的问题清单（按严重度排序） */
  findings: { perspective: string; severity: Severity; text: string }[]
  /** 完整性批评员给出的遗漏 */
  missing: string[]
  votes: SkepticVote[]
  elapsedMs: number
}

export const DEFAULT_PERSPECTIVES: ReviewPerspective[] = [
  {
    id: 'correctness',
    name: '正确性怀疑者',
    lens: '假设逻辑是错的。逐行核对边界条件、空值/并发/时序、错误处理、输入校验，找能构造出的反例。',
  },
  {
    id: 'security',
    name: '安全怀疑者',
    lens: '假设攻击者在盯着它。查注入（命令/SQL/路径穿越）、凭据泄露、权限提升、不安全反序列化、敏感信息落盘、剪贴板/桌面越权。',
  },
  {
    id: 'reproducibility',
    name: '可复现怀疑者',
    lens: '假设另一个人在干净环境照做会失败。查隐式依赖、硬编码路径/端口、未声明的前置条件、不可复现的随机性、缺失的测试与验收步骤。',
  },
]

function extractJson(text: string): any {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}')
  if (s >= 0 && e > s) {
    try {return JSON.parse(cleaned.slice(s, e + 1))} catch { /* ignore */ }
  }
  return null
}

function parseVote(perspective: ReviewPerspective, text: string, ok: boolean): SkepticVote {
  const j = extractJson(text)
  let verdict: Verdict = 'uncertain'
  let severity: Severity = 'none'
  let findings: string[] = []
  if (j) {
    const v = String(j.verdict || '').toLowerCase()
    if (v.includes('pass') || v === '通过' || v.includes('ok')) {verdict = 'pass'}
    else if (v.includes('fail') || v.includes('reject') || v === '不通过' || v.includes('kill')) {verdict = 'fail'}
    const sev = String(j.severity || '').toLowerCase()
    if (sev.includes('high') || sev.includes('高') || sev.includes('严重')) {severity = 'high'}
    else if (sev.includes('med') || sev.includes('中')) {severity = 'medium'}
    else if (sev.includes('low') || sev.includes('低')) {severity = 'low'}
    if (Array.isArray(j.findings)) {
      findings = j.findings.map((f: any) => typeof f === 'string' ? f : JSON.stringify(f)).filter(Boolean)
    } else if (typeof j.findings === 'string') {
      findings = j.findings.split(/\n+/).map((s: string) => s.trim()).filter(Boolean)
    }
  }
  // 解析失败：无结论时按文本启发式判定
  if (!j) {
    if (/高危|严重|必须修复|不通过|fail/i.test(text)) {
      verdict = 'fail'; severity = 'high'
    }
    findings = findings.length ? findings : [text.slice(0, 600)]
  }
  if (verdict === 'fail' && severity === 'none') {severity = 'medium'}
  return {
    perspective: perspective.id,
    perspectiveName: perspective.name,
    verdict, severity, findings,
    raw: text,
    ok,
  }
}

function skepticTask(p: ReviewPerspective, target: string, tone = ''): string {
  return `你是对抗式评审团的「${p.name}」。请带着以下预设去挑刺：

【怀疑视角】
${p.lens}
${tone ? `\n【语气约定】\n${tone}\n` : ''}
【待评审内容】
${target}

【输出要求】
只输出一个 JSON，不要客套：
{
  "verdict": "pass" | "fail" | "uncertain",
  "severity": "high" | "medium" | "low" | "none",
  "findings": ["具体问题1（含位置/触发条件/后果）", "具体问题2"]
}
- 没有问题也要给 verdict=pass、findings=[]，并在评审记录中说明你检查过的点（写进 findings 会被视为问题，所以没问题就留空）。
- 拿不准给 uncertain，但要在 findings 里说明不确定的原因。`
}

/**
 * 运行对抗式评审。
 *
 * @param target       待评审文本（代码、方案、声明、diff 等）
 * @param perspectives 怀疑视角（默认正确性/安全/可复现）
 * @param timeoutMs    单个怀疑者超时
 */
export async function runAdversarialReview(
  target: string,
  opts: {
    perspectives?: ReviewPerspective[]
    timeoutMs?: number
    /** 完整性批评员（默认开启） */
    completenessCritic?: boolean
  } = {},
): Promise<ReviewReport> {
  const started = Date.now()
  const perspectives = opts.perspectives || DEFAULT_PERSPECTIVES
  const timeout = opts.timeoutMs ?? 120_000
  const useCritic = opts.completenessCritic !== false

  const dm = getDelegationManager()
  const rechaReady = dm.isConfigured('recha')

  // 亲密度 → 审查语气（README「亲密度影响审查语气」的实际接线点）
  // 以前 reviewTonePrompt() 写好了却没人调用，属于“文档吹了、代码没接”。
  // 审查员拿到的是真实 LLM 提示词，所以语气约定放在这里才真正生效。
  let tone = ''
  try { tone = reviewTonePrompt() } catch { /* 关系库未就绪则不加语气约定 */ }

  let votes: SkepticVote[] = []

  if (rechaReady) {
    // 并行委托热茶，分别戴不同怀疑视角
    const delegations = perspectives.map(p =>
      dm.delegate('lumina', {
        to: 'recha' as any,
        task: skepticTask(p, target, tone),
        taskType: 'risk_assess' as any,
        context: `对抗式评审视角：${p.name}`,
        timeout,
      }).then(res => parseVote(p, res.content || res.error || '', res.success))
        .catch((e: any) => parseVote(p, `评审失败: ${e?.message || e}`, false)),
    )
    votes = await Promise.all(delegations)
  } else {
    // 热茶未配置：雇临时复核员（每个视角一个，干完即散）
    const jobs = perspectives.map(p => ({
      role: 'review' as const,
      title: p.name,
      task: skepticTask(p, target, tone),
      timeoutMs: timeout,
    }))
    const results = await hireAndRun(jobs)
    votes = results.map((r, i) => parseVote(perspectives[i], r.result || r.error || '', r.ok))
  }

  // ── 完整性批评员：查评审本身的遗漏 ──
  let missing: string[] = []
  if (useCritic) {
    const findingsSoFar = votes
      .flatMap(v => v.findings.map(f => `- [${v.perspectiveName}] ${f}`))
      .join('\n') || '（评审团未发现问题）'
    const criticInput = `你是「完整性批评员」。评审团刚审完下面这份内容，你的职责不是重复挑刺，而是专查**评审漏掉了什么**：
- 哪些边界/场景/模块根本没被检查到？
- 缺少哪些验收步骤、测试、回滚方案、监控？
- 有哪些声明没有证据支撑？

【待评审内容】
${target}

【评审团已发现】
${findingsSoFar}

只输出 JSON：{"missing":["遗漏点1（具体、可执行）","遗漏点2"]}`

    let criticText = ''
    let criticOk = false
    if (rechaReady) {
      try {
        const r = await dm.delegate('lumina', {
          to: 'recha' as any,
          task: criticInput,
          taskType: 'risk_assess' as any,
          timeout,
        })
        criticText = r.content || ''
        criticOk = r.success
      } catch (e: any) {
        criticText = `完整性评审失败: ${e?.message || e}`
      }
    } else {
      const r = await hireAndRun([{ role: 'review', title: '完整性批评员', task: criticInput, timeoutMs: timeout }])
      criticText = r[0]?.result || r[0]?.error || ''
      criticOk = r[0]?.ok || false
    }
    const j = extractJson(criticText)
    if (j && Array.isArray(j.missing)) {
      missing = j.missing.map((m: any) => String(m)).filter(Boolean)
    } else if (criticOk) {
      missing = criticText.split(/\n+/).map(s => s.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean).slice(0, 10)
    }
  }

  // ── 汇总：多数票 + 高危一票否决 ──
  const voteSummary = {
    pass: votes.filter(v => v.verdict === 'pass').length,
    fail: votes.filter(v => v.verdict === 'fail').length,
    uncertain: votes.filter(v => v.verdict === 'uncertain').length,
  }
  const hasHigh = votes.some(v => v.verdict === 'fail' && v.severity === 'high')
  const majorityFail = voteSummary.fail > voteSummary.pass
  const pass = !hasHigh && !majorityFail

  const sevRank: Record<Severity, number> = { high: 0, medium: 1, low: 2, none: 3 }
  const findings = votes
    .flatMap(v => v.findings.map(text => ({ perspective: v.perspectiveName, severity: v.severity, text })))
    .sort((a, b) => sevRank[a.severity] - sevRank[b.severity])

  return {
    pass,
    voteSummary,
    findings,
    missing,
    votes,
    elapsedMs: Date.now() - started,
  }
}

/** 把评审报告渲染成给 agent/用户看的文本 */
export function formatReviewReport(report: ReviewReport): string {
  const lines: string[] = []
  lines.push(`🧐 对抗式评审结论：${report.pass ? '✅ 通过' : '❌ 不通过'}`)
  lines.push(`投票：通过 ${report.voteSummary.pass} / 不通过 ${report.voteSummary.fail} / 存疑 ${report.voteSummary.uncertain}`)
  if (report.findings.length > 0) {
    lines.push('\n问题清单：')
    const sevCn: Record<Severity, string> = { high: '🔴高', medium: '🟡中', low: '🔵低', none: '—' }
    for (const f of report.findings) {
      lines.push(`- ${sevCn[f.severity]} [${f.perspective}] ${f.text}`)
    }
  }
  if (report.missing.length > 0) {
    lines.push('\n完整性批评（遗漏项）：')
    for (const m of report.missing) {lines.push(`- ${m}`)}
  }
  lines.push(`\n耗时 ${(report.elapsedMs / 1000).toFixed(1)}s`)
  return lines.join('\n')
}
