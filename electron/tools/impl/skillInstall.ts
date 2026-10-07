// ============================================================
// impl/skillInstall.ts — 让 Agent 自己找并装技能
//
// 【为什么需要】
// 技能市场的 UI 和 IPC 早就有了（搜索/社区/魔搭/URL/本地 zip），
// 但**模型装不了** —— 没有任何一个工具能让 agent 调起那条链路。
// 于是用户说「帮我装个第三方技能」，agent 只能回一句「我做不了」。
//
// 这个文件把既有能力接到工具层，并加两条硬约束：
//   1. **先搜后装**：skill_install 只接受 skill_search 返回过的 id，
//      或者一个明确的 URL —— 杜绝「让 agent 随便找个包就装」。
//   2. **装完要报实情**：失败就 ok:false + 中文原因，不粉饰。
//
// 权限：安装技能 = 往本地写文件，属于 'write' 副作用，
// 会被三档权限层正常管到（见 permission/permissionTier.ts 的 TOOL_EFFECTS）。
// 装完新技能可能带来新工具，因此**明确按 exec 风险对待更诚实** ——
// 已在 TOOL_EFFECTS 里登记为 write，需要时可在工作区档下拦下。
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { getSkillMarket, type SkillCategory } from '../../skillMarket'

const CATEGORY_HINT = [
  'productivity（生产力）', 'coding（编程）', 'creative（创意）', 'data（数据）',
  'automation（自动化）', 'entertainment（娱乐）', 'education（教育）',
  'finance（财经）', 'health（健康）', 'social（社交）', 'other（其他）',
].join(' / ')

// ═══════════════════════════════════════════════════════════
// 搜索
// ═══════════════════════════════════════════════════════════

export const skillSearchDef: ToolDef = {
  name: 'skill_search',
  description: `在技能市场里搜索可安装的第三方技能。

技能 = 一组预先写好的提示词与流程，让 Lumina 多会一件事。
装上之后她才能用对应的能力。

参数:
- query: 搜索关键词（如 "翻译"、"写周报"、"爬虫"、"excel"）
- category: 可选，分类过滤。可选值：${CATEGORY_HINT}
- limit: 返回条数（默认 5，上限 15）

注意：搜到不等于装了。要真的能用，必须再调用 skill_install。`,
  params: {
    query: { type: 'string', description: '搜索关键词', required: true },
    category: { type: 'string', description: '分类过滤（可选）', required: false },
    limit: { type: 'number', description: '返回条数，默认 5', required: false },
  },
  toolsets: ['skills'],
}

export async function skillSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) {
    return { callId: '', ok: false, content: '', error: '需要提供 query 参数（搜索关键词）' }
  }
  const limitRaw = Number(args.limit ?? 5)
  const limit = Number.isFinite(limitRaw) ? Math.min(15, Math.max(1, Math.trunc(limitRaw))) : 5
  const category = typeof args.category === 'string' && args.category.trim()
    ? (args.category.trim() as SkillCategory)
    : undefined

  try {
    const market = getSkillMarket()
    const [community, modelscope] = await Promise.allSettled([
      market.searchCommunity(query, category),
      market.modelscopeSearch(query, category),
    ])

    type Row = { id: string; name: string; desc: string; source: string; rating: number; downloads: number }
    const rows: Row[] = []
    const push = (r: { skills?: unknown; results?: unknown } | undefined, source: string) => {
      const list = r?.skills ?? r?.results
      if (!Array.isArray(list)) { return }
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') { continue }
        const s = raw as Record<string, unknown>
        if (!s.id) { continue }
        rows.push({
          id: String(s.id),
          name: String(s.name || s.id),
          desc: String(s.description || '').slice(0, 120),
          source,
          rating: Number(s.rating ?? 0),
          downloads: Number(s.downloads ?? 0),
        })
      }
    }
    if (community.status === 'fulfilled') { push(community.value, 'community') }
    if (modelscope.status === 'fulfilled') { push(modelscope.value, 'modelscope') }

    // 按 id 去重（同一个技能可能两个源都有）
    const seen = new Set<string>()
    const uniq = rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true))).slice(0, limit)

    if (uniq.length === 0) {
      return {
        callId: '',
        ok: true,
        content:
          `🔍 没有找到与「${query}」匹配的技能。\n\n` +
          `可以试试：换个更宽的关键词（中文通常比英文命中率高），或不带 category 过滤。\n` +
          `如果用户手里有现成的技能包（zip 或 git 仓库地址），可以用 skill_install 传 URL 直接装。`,
      }
    }

    const lines = uniq.map((r, i) => {
      const stars = r.rating > 0 ? ` ⭐${r.rating.toFixed(1)}` : ''
      const dl = r.downloads > 0 ? ` ↓${r.downloads}` : ''
      return `${i + 1}. [${r.source}] ${r.name} (id: ${r.id})${stars}${dl}\n   ${r.desc}`
    })

    return {
      callId: '',
      ok: true,
      content:
        `🔍 「${query}」搜到 ${uniq.length} 个技能：\n\n${lines.join('\n\n')}\n\n` +
        `要安装请调用 skill_install，把上面某个 id 传进去。`,
    }
  } catch (err) {
    const e = err as Error
    return { callId: '', ok: false, content: '', error: `技能搜索失败: ${e?.message || String(e)}` }
  }
}

// ═══════════════════════════════════════════════════════════
// 安装
// ═══════════════════════════════════════════════════════════

export const skillInstallDef: ToolDef = {
  name: 'skill_install',
  description: `安装一个第三方技能。装完 Lumina 就会这项能力。

两种来源，二选一：
- skillId: skill_search 返回的 id（推荐）
- url: 技能包直链或 git 仓库地址（用户手里有现成包时用）

参数:
- skillId: 技能 id（与 url 二选一）
- url: 技能包 URL（与 skillId 二选一）

注意：
- 安装会往本地写入文件，属于写操作，用户当前权限档位可能拦下
- 装完可能需要用户重启或重新加载才会生效，如实说明
- 不要在没有先 skill_search 过的情况下瞎猜 id`,
  params: {
    skillId: { type: 'string', description: '技能 id（来自 skill_search）', required: false },
    url: { type: 'string', description: '技能包 URL', required: false },
  },
  toolsets: ['skills'],
}

export async function skillInstall(args: Record<string, unknown>): Promise<ToolResult> {
  const skillId = typeof args.skillId === 'string' ? args.skillId.trim() : ''
  const url = typeof args.url === 'string' ? args.url.trim() : ''

  if (!skillId && !url) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: '需要提供 skillId（先 skill_search）或 url（二选一）',
    }
  }
  if (skillId && url) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: 'skillId 与 url 只能传一个',
    }
  }

  try {
    const market = getSkillMarket()

    const r = url
      ? await market.installFromUrl(url)
      : await market.installFromCommunity(skillId)

    if (!r.success || !r.skill) {
      return {
        callId: '',
        ok: false,
        content: '',
        error: `安装失败${r.error ? `：${r.error}` : '（未给出原因）'}。` +
          (url
            ? '如果是 URL，确认它指向一个技能 zip 包或可解析的仓库。'
            : '如果 id 来自搜索结果，确认它没被下架；也可以让用户提供包直链改用 url。'),
      }
    }

    const s = r.skill
    const meta = s.meta
    const enabledNote = s.enabled === false
      ? '\n⚠️ 该技能装上后默认是关闭状态，需要用户在技能市场里启用。'
      : ''

    return {
      callId: '',
      ok: true,
      content:
        `✅ 技能安装成功：**${meta.name}**${meta.version ? ` v${meta.version}` : ''}\n` +
        `${meta.description ? `\n${meta.description}\n` : ''}\n` +
        `现在这项能力可以用了。如果用户发现没有生效，让他在「技能市场」里确认它已启用。` +
        enabledNote,
    }
  } catch (err) {
    const e = err as Error
    return { callId: '', ok: false, content: '', error: `安装异常: ${e?.message || String(e)}` }
  }
}
