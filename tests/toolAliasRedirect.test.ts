// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// toolAliasRedirect.test.ts — 反幻觉占位工具删除 + 别名重定向（2026-10-07）
//
// 【这个文件为什么存在】
// 原先 tools/index.ts 注册了 4 个「反幻觉占位工具」：
//   tavily_search / tavily_extract / serpapi_search / bing_search
// 它们每个都要占 schema 体积、每轮重发（共 ≈340 tokens），
// 实现却只是 return 一句「本系统没有 Tavily」——**什么都不做**。
// 更糟的是：它们出现在 function list 里，等于在**诱导**模型去调它们。
//
// 现在改为「不注册 + 执行层别名重定向」：
//   · 省下 340 tokens/轮
//   · 覆盖面从硬编码 3 个扩大到任意搜索/抓取类幻觉名
//
// 【本文件真正要守住的东西】
// 别名重定向是**执行层**的能力，它天然有提权风险：
// 如果 `bash` 被映射到 `shell_exec`，那么一个被禁掉 shell 的后台 worker，
// 只要幻觉一个 `bash` 就能拿到 shell —— 黑名单被绕过。
// 所以下面第一条不变量是硬约束：**别名只能指向只读工具**。
// ============================================================

import { describe, it, expect, beforeAll } from 'vitest'
import {
  registerAllTools, getToolNames, getToolDef,
  resolveToolset, toOpenAIFunctions,
} from '../electron/tools/index'
import { resolveToolAlias, executeToolWithRetry } from '../electron/tools/registry'
import { routeTools, _resetAllToolRouting } from '../electron/tools/toolRouter'

/** 允许作为别名目标的工具 —— 只能是只读工具。新增别名前必须先想清楚这一点。 */
const READ_ONLY_ALIAS_TARGETS = new Set([
  'web_search', 'web_fetch',
  'file_read', 'file_list', 'file_search',
])

/** 曾被注册的 4 个占位工具，现在都不该再存在 */
const REMOVED_PLACEHOLDERS = ['tavily_search', 'tavily_extract', 'serpapi_search', 'bing_search']

describe('① 占位工具已删除', () => {
  beforeAll(() => { registerAllTools() })

  it('4 个反幻觉占位工具不再注册', () => {
    const all = getToolNames()
    const still = REMOVED_PLACEHOLDERS.filter(n => all.has(n))
    expect(
      still,
      `这些占位工具又被注册回来了：${still.join(', ')}\n` +
      `它们只 return 一句提示、什么都不做，却要占 schema 体积并每轮重发。\n` +
      `反幻觉请用 registry 的别名重定向（不占 token）而不是注册空壳工具。`,
    ).toEqual([])
  })

  it('它们也不出现在任何档位的 function list 里', () => {
    for (const mode of ['agent', 'developer', 'full']) {
      const names = resolveToolset(mode)
      const leaked = REMOVED_PLACEHOLDERS.filter(n => names.includes(n))
      expect(leaked, `${mode} 档仍能看到占位工具: ${leaked.join(', ')}`).toEqual([])
    }
  })

  it('每轮实际暴露的 schema 比修复前小（不是"删了名字但没省 token"）', () => {
    // ⚠️ 注意口径：2026-10-07 起 agent 档的**候选集**扩大了（补回 64 个此前
    //   拿不到的日常能力），所以不能拿 resolveToolset('agent') 的原始体积做比较 ——
    //   那个数字现在反而更大，但它不是发给模型的量。
    //   真正该测的是 **routeTools 之后、每轮实际进 function list 的体积**。
    const base = resolveToolset('agent')
    const r = routeTools(base, 'agent', '你好，今天过得怎么样', 'size-check')
    const exposed = r.tools.map(t => getToolDef(t)).filter(Boolean)
    const chars = JSON.stringify(toOpenAIFunctions(exposed as any[])).length
    // 修复前 agent 档每轮固定发 33,925 字符（67 个工具全量）。
    expect(chars, `每轮实际暴露仍有 ${chars} 字符，删掉占位工具 + 按需筛选却没变小？`)
      .toBeLessThan(33925 * 0.6)
  })
})

describe('② 别名重定向：能力没有丢', () => {
  beforeAll(() => { registerAllTools() })

  it('搜索类幻觉名 → web_search', () => {
    for (const n of ['bing_search', 'tavily_search', 'serpapi_search', 'google_search', 'duckduckgo']) {
      const r = resolveToolAlias(n)
      expect(r.name, `${n} 应重定向到 web_search`).toBe('web_search')
      expect(r.aliasedFrom).toBe(n)
    }
  })

  it('抓取类幻觉名 → web_fetch', () => {
    expect(resolveToolAlias('tavily_extract').name).toBe('web_fetch')
    expect(resolveToolAlias('scrape_url').name).toBe('web_fetch')
  })

  it('真实工具名不被别名干扰（解析后仍是自己）', () => {
    for (const n of ['web_search', 'file_read', 'shell_exec', 'memory_save']) {
      const r = resolveToolAlias(n)
      expect(r.name).toBe(n)
      expect(r.aliasedFrom).toBeUndefined()
    }
  })

  it('未注册的名字不会被"重定向"成某个无关工具', () => {
    const r = resolveToolAlias('totally_made_up_tool_xyz')
    expect(r.name).toBe('totally_made_up_tool_xyz')
    expect(r.aliasedFrom).toBeUndefined()
  })
})

describe('③ 安全不变量：别名只准指向只读工具', () => {
  beforeAll(() => { registerAllTools() })

  // 用一组"危险名"探测：如果它们能被解析成有副作用的工具，就是提权漏洞。
  //   这些名字是模型真的会编出来的（`bash` 尤其常见）。
  const DANGEROUS_PROBES = [
    'bash', 'sh', 'cmd', 'powershell', 'run_command', 'execute_command',
    'exec', 'terminal', 'write_file', 'save_file', 'edit_file', 'delete_file',
    'send_email', 'mail', 'post_tweet', 'click', 'type_text',
  ]

  it('危险幻觉名不会被重定向到有副作用的工具', () => {
    const SIDE_EFFECTING = new Set([
      'shell_exec', 'file_write', 'file_edit', 'mail_send',
      'desktop_click', 'desktop_type', 'desktop_key', 'desktop_act',
      'channel_send', 'creator_generate', 'creator_export',
    ])
    const bad: string[] = []
    for (const n of DANGEROUS_PROBES) {
      const target = resolveToolAlias(n).name
      if (SIDE_EFFECTING.has(target)) {bad.push(`${n} → ${target}`)}
    }
    expect(
      bad,
      `别名把危险名重定向到了有副作用的工具，这会绕过 worker 黑名单：\n  ${bad.join('\n  ')}\n` +
      `别名只允许指向只读工具（web_search / web_fetch / file_read / file_list / file_search）。`,
    ).toEqual([])
  })

  it('所有已配置的别名目标都在只读白名单内', async () => {
    // 直接遍历 registry 的别名表（通过公共 API 反查不到，这里用一组已知别名探测）
    const KNOWN_ALIASES = [
      'bing_search', 'google_search', 'google', 'tavily_search', 'tavily',
      'serpapi_search', 'serpapi', 'brave_search', 'duckduckgo_search', 'duckduckgo',
      'search_web', 'websearch', 'tavily_extract', 'scrape_url', 'fetch_url',
      'webfetch', 'read_file', 'list_files', 'ls', 'grep_search', 'glob_search',
    ]
    const offenders: string[] = []
    for (const a of KNOWN_ALIASES) {
      const r = resolveToolAlias(a)
      if (!r.aliasedFrom) {continue}   // 没配别名，跳过
      if (!READ_ONLY_ALIAS_TARGETS.has(r.name)) {offenders.push(`${a} → ${r.name}`)}
    }
    expect(
      offenders,
      `这些别名指向了非只读工具：\n  ${offenders.join('\n  ')}\n` +
      `若确需新增，请先确认它不会绕过 disabledTools 黑名单。`,
    ).toEqual([])
  })
})

describe('④ 执行层拒绝名单（防别名绕过黑名单）', () => {
  beforeAll(() => { registerAllTools() })

  it('deniedTools 命中"重定向后的真实名" → 拒绝执行', async () => {
    // worker 场景：web_search 被禁 → 幻觉 tavily_search 也不能绕过去
    const r = await executeToolWithRetry('tavily_search', { query: 'x' }, { deniedTools: ['web_search'] })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('不可用')
  })

  it('deniedTools 命中"原始幻觉名" → 同样拒绝', async () => {
    const r = await executeToolWithRetry('tavily_search', { query: 'x' }, { deniedTools: ['tavily_search'] })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('不可用')
  })

  it('未被拒绝的真实工具照常放行（没有把功能一起堵死）', async () => {
    // datetime 无副作用、参数为空，是最安全的"放行探针"
    const r = await executeToolWithRetry('datetime', {}, { deniedTools: ['web_search'] })
    expect(r.ok, `datetime 不该被 web_search 的拒绝名单波及：${r.error || ''}`).toBe(true)
  })

  it('不传 deniedTools 时行为不变（向后兼容）', async () => {
    const r = await executeToolWithRetry('datetime', {})
    expect(r.ok).toBe(true)
  })
})

describe('⑤ 报错要如实区分「不存在」与「本轮未加载」', () => {
  beforeAll(() => { registerAllTools() })

  // 【为什么需要】
  // 加了按需筛选后，「工具不存在」和「工具本轮没加载」是两件完全不同的事：
  //   · 不存在 = 模型在幻觉（比如编了个 `send_tweet`）
  //   · 未加载 = 筛选判断失误（工具真实存在，只是这句请求没触发它）
  // 旧实现无论哪种都回一句「工具不存在」—— 把**筛选失误伪装成模型幻觉**，
  // 模型于是永远不知道自己其实可以请求那个能力。
  it('调一个真实存在但未暴露的工具 → 说「本轮未加载」，不说「不存在」', async () => {
    // calendar_add 是真实注册的工具；这里刻意只暴露 file_read
    const r = await executeToolWithRetry(
      'calendar_add', { title: 'x' },
      { availableTools: ['file_read', 'web_search'] },
    )
    expect(r.ok).toBe(false)
    expect(r.content, '真实存在的工具被误报成「不存在」').not.toContain('不存在')
    expect(r.content).toContain('本轮未加载')
  })

  it('调一个真正不存在的工具 → 说「不存在」', async () => {
    const r = await executeToolWithRetry(
      'send_tweet_to_elon', {},
      { availableTools: ['file_read'] },
    )
    expect(r.ok).toBe(false)
    expect(r.content).toContain('不存在')
  })

  it('失败信息里带上「本轮可用工具清单」，让模型能立刻改道', async () => {
    const avail = ['file_read', 'web_search', 'datetime']
    const r = await executeToolWithRetry('calendar_add', {}, { availableTools: avail })
    expect(r.content).toContain('本轮实际可用的工具')
    for (const t of avail) {
      expect(r.content, `可用清单里少了 ${t}`).toContain(t)
    }
  })

  it('不传 availableTools 时不拦（向后兼容：无暴露信息就不做这层判断）', async () => {
    // 没有暴露信息时无法区分「未加载」与「正常调用」，所以这层检查整体跳过，
    // 已注册的工具照常执行 —— 保证老调用点行为不变。
    const r = await executeToolWithRetry('datetime', {})
    expect(r.ok, `不传 availableTools 时不该被拦：${r.error || ''}`).toBe(true)
  })
})
