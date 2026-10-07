// ============================================================
// toolRouting.test.ts — 工具按需筛选（2026-10-07）
//
// 【背景】修复前每轮把整档工具全量塞进 function list：
//   agent 67 个 ≈ 9,700 tokens / developer 93 个 ≈ 12,400 tokens，
//   **每一次模型调用都重发一遍**。实测 601 次真实调用只用到 22 个工具。
//
// 【本文件守什么】
//   1. 核心工具永远在（不能因为筛选让模型「没工具可用」）
//   2. 关键词命中就加组（功能不能丢）
//   3. 粘性生效（不能「上一轮能用下一轮没了」）
//   4. **失败开放**：拿不到输入 / 裁得太少 → 退回全量
//   5. 🔴 **提示词教过的工具必须常驻** —— 这是最容易踩的坑：
//      `agentTeamPersonas` 明确教模型调 delegate_to / hire_worker /
//      adversarial_review / git_worktree / save_context 等，
//      如果把它们挪进按需组，提示词就会让模型去调一个不在列表里的工具。
//   6. 真的省了 token（不是"路由了但体积没变"）
// ============================================================

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { registerAllTools, getToolDef, resolveToolset, toOpenAIFunctions } from '../electron/tools/index'
import {
  routeTools, matchGroups, resetToolRouting, _resetAllToolRouting,
  CORE_TOOLS, DEVELOPER_CORE_TOOLS, CAPABILITY_GROUPS,
  looksLikeActionRequest, buildGroupSelectorPrompt, parseGroupAnswer,
} from '../electron/tools/toolRouter'

const agentTools = () => resolveToolset('agent')
const devTools = () => resolveToolset('developer')

const schemaTokens = (names: string[]) => {
  const defs = names.map(n => getToolDef(n)).filter(Boolean)
  return Math.round(JSON.stringify(toOpenAIFunctions(defs as any[])).length / 3.5)
}

/**
 * 提示词里**明确教模型调用**的工具 —— 必须常驻，不能进按需组。
 * 依据：electron/agentTeamPersonas.ts（TEAM_LUMINA.systemPrompt）与
 *       electron/prompts/systemPrompt.ts 的实际文本。
 * 改动这张表前，请先去那两个文件里确认提示词是否也改了。
 */
const PROMPT_TAUGHT_TOOLS = [
  'delegate_to', 'delegate_chain', 'team_message', 'team_mailbox', 'team_tasks',
  'hire_worker', 'workflow', 'adversarial_review', 'git_worktree',
  'write_notice', 'read_notices', 'save_context', 'load_context',
]

describe('① 核心工具永远在', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  it('无论用户问什么，CORE_TOOLS 里的工具都不会被裁掉', () => {
    for (const input of ['你好', '帮我搜一下今天的新闻', '写个快排', '整理桌面']) {
      const r = routeTools(agentTools(), 'agent', input, 's1')
      const missing = CORE_TOOLS.filter(t => agentTools().includes(t) && !r.tools.includes(t))
      expect(missing, `输入「${input}」时核心工具被裁掉了：${missing.join(', ')}`).toEqual([])
    }
  })

  it('developer 档额外常驻 git / lsp / 浏览器工具', () => {
    const r = routeTools(devTools(), 'developer', '看看这个 bug', 's1')
    const missing = DEVELOPER_CORE_TOOLS.filter(t => devTools().includes(t) && !r.tools.includes(t))
    expect(missing, `developer 常驻工具被裁掉了：${missing.join(', ')}`).toEqual([])
  })
})

describe('② 关键词命中即加组（功能不能丢）', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  // [输入, 期望激活的组, 该组里应出现的工具, 用哪个档位验证]
  //   ⚠️ computer_use / browser_actions 的工具只在 developer 档，
  //     在 agent 档里这两个组即使被命中也不会带来新工具 —— 这是预期行为
  //     （agent 档本来就不该给电脑操控能力）。所以用 developer 档验证它们。
  const cases: Array<[string, string, string, 'agent' | 'developer']> = [
    ['帮我整理一下桌面，太乱了', 'desktop_tidy', 'desktop_tidy', 'agent'],
    ['明天有什么日程安排', 'calendar', 'calendar_add', 'agent'],
    ['每天下午三点提醒我喝水', 'tasks_schedule', 'cron_schedule', 'agent'],
    ['帮我截个图', 'system_extra', 'screenshot', 'agent'],
    ['你还记得我之前说过什么吗', 'memory_deep', 'memory_summarize', 'agent'],
    ['帮我操作一下这个软件界面', 'computer_use', 'desktop_click', 'developer'],
    ['去这个网站登录填表', 'browser_actions', 'browser_type', 'developer'],
    ['团队一起做个完整项目', 'team_advanced', 'hire_worker', 'agent'],
  ]

  it.each(cases)('「%s」→ 激活 %s（含 %s，%s 档）', (input, group, expectedTool, mode) => {
    const base = mode === 'developer' ? devTools() : agentTools()
    const r = routeTools(base, mode, input, 's1')
    expect(r.groups, `没匹配到 ${group} 组`).toContain(group)
    expect(r.tools, `激活了组但工具没进去: ${expectedTool}`).toContain(expectedTool)
  })

  it('matchGroups 大小写不敏感、中英都能命中', () => {
    expect(matchGroups('SCHEDULE a meeting')).toContain('calendar')
    expect(matchGroups('用 worktree 并行开发')).toContain('team_advanced')
    expect(matchGroups('随便聊聊天')).toEqual([])
  })
})

describe('③ 粘性：上一轮能用，下一轮还在', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  it('第二轮没有关键词时，第一轮激活的组仍然生效', () => {
    const first = routeTools(agentTools(), 'agent', '帮我整理桌面', 'sess-A')
    expect(first.groups).toContain('desktop_tidy')

    // 第二轮完全无关键词 —— 若没有粘性，desktop_tidy 就会消失
    const second = routeTools(agentTools(), 'agent', '再帮我看看别的', 'sess-A')
    expect(second.groups, '粘性失效：第二轮丢了上一轮激活的组').toContain('desktop_tidy')
    expect(second.tools).toContain('desktop_tidy')
  })

  it('不同会话之间互不影响', () => {
    routeTools(agentTools(), 'agent', '帮我整理桌面', 'sess-A')
    const other = routeTools(agentTools(), 'agent', '你好', 'sess-B')
    expect(other.groups, '会话 B 不该继承会话 A 的组').not.toContain('desktop_tidy')
  })

  it('resetToolRouting 能清掉粘性', () => {
    routeTools(agentTools(), 'agent', '帮我整理桌面', 'sess-C')
    resetToolRouting('sess-C')
    const after = routeTools(agentTools(), 'agent', '你好', 'sess-C')
    expect(after.groups).not.toContain('desktop_tidy')
  })
})

describe('④ 🔓 失败开放：宁可多花 token 也不能没工具', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  it('拿不到用户输入 → 退回全量', () => {
    for (const input of ['', '   ', undefined]) {
      const r = routeTools(agentTools(), 'agent', input as any, 's1')
      expect(r.narrowed, `输入 ${JSON.stringify(input)} 时不该裁剪`).toBe(false)
      expect(r.tools.length).toBe(agentTools().length)
    }
  })

  it('总开关关闭 → 退回全量', () => {
    const r = routeTools(agentTools(), 'agent', '帮我整理桌面', 's1', false)
    expect(r.narrowed).toBe(false)
    expect(r.tools.length).toBe(agentTools().length)
  })

  it('chat 档本来就是最小集，不做裁剪', () => {
    const r = routeTools(['web_search', 'file_read'], 'chat', '你好', 's1')
    expect(r.narrowed).toBe(false)
  })

  it('裁剪结果过少时自动退回全量（保护「读→改→验」闭环）', () => {
    // 只给 5 个候选，远低于阈值 8
    const tiny = ['web_search', 'file_read', 'file_write', 'shell_exec', 'datetime']
    const r = routeTools(tiny, 'agent', '你好', 's1')
    expect(r.narrowed, '候选过少时该退回而不是裁成 3 个').toBe(false)
    expect(r.tools.length).toBe(tiny.length)
  })
})

describe('⑤ 🔴 设计不变量：提示词教过的工具必须常驻', () => {
  beforeAll(() => { registerAllTools() })

  it('PROMPT_TAUGHT_TOOLS 全部在核心层（核心 ∪ developer 额外）', () => {
    const alwaysOn = new Set([...CORE_TOOLS, ...DEVELOPER_CORE_TOOLS])
    const missing = PROMPT_TAUGHT_TOOLS.filter(t => !alwaysOn.has(t))
    expect(
      missing,
      `这些工具在 agentTeamPersonas / systemPrompt 里被明确教给模型，\n` +
      `却被放进了按需组 —— 后果是提示词让模型调一个不在 function list 里的工具，\n` +
      `模型只能幻觉或失败。请把它们移回 CORE_TOOLS：\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('反向检查：按需组里没有"提示词教过"的工具', () => {
    const alwaysOn = new Set([...CORE_TOOLS, ...DEVELOPER_CORE_TOOLS])
    const offenders: string[] = []
    for (const [name, g] of Object.entries(CAPABILITY_GROUPS)) {
      for (const t of g.tools) {
        if (PROMPT_TAUGHT_TOOLS.includes(t) && !alwaysOn.has(t)) {
          offenders.push(`${t}（在组 ${name}）`)
        }
      }
    }
    expect(offenders, `按需组里混入了提示词教过的工具：${offenders.join(', ')}`).toEqual([])
  })

  it('按需组引用的工具名都真实存在（防止改名后静默失效）', () => {
    const all = new Set([...resolveToolset('full')])
    const ghost: string[] = []
    for (const [name, g] of Object.entries(CAPABILITY_GROUPS)) {
      for (const t of g.tools) {
        if (!all.has(t)) {ghost.push(`${name}.${t}`)}
      }
    }
    expect(
      ghost,
      `按需组引用了不存在的工具（改名后忘了同步，会导致该组"激活了但没工具"）：\n  ${ghost.join('\n  ')}`,
    ).toEqual([])
  })

  it('CORE_TOOLS 里的工具名也都真实存在', () => {
    const all = new Set([...resolveToolset('full')])
    const ghost = [...CORE_TOOLS, ...DEVELOPER_CORE_TOOLS].filter(t => !all.has(t))
    expect(ghost, `核心工具表里有不存在的名字：${ghost.join(', ')}`).toEqual([])
  })
})

describe('⑦ 🔴 能力组的工具必须真的在 agent 档（否则组会静默失效）', () => {
  beforeAll(() => { registerAllTools() })

  // 【这个用例为什么必须存在】
  // 2026-10-07 实测踩到：agent 档的 includes 是一张**静态表**，而工具自己
  // 写的 `toolsets: ['agent']` 会被模式层**忽略**。于是有 64 个工具
  // （含 Computer Use、MCP、语音、天气、邮件）声明了 agent 却根本拿不到。
  //
  // 加路由组时如果忘了同步 agent.includes，就会出现最坏的情况：
  // 关键词命中了、日志说「已激活 computer_use」、但候选集里没有那个工具 ——
  // **组看起来在工作，实际什么都没加**，而且没有任何报错。
  // 这个用例就是拦这种「看起来接好了」。
  it('CAPABILITY_GROUPS 里每个工具都能在 agent 或 developer 档拿到', () => {
    const agent = new Set(resolveToolset('agent'))
    const dev = new Set(resolveToolset('developer'))
    const unreachable: string[] = []
    for (const [name, g] of Object.entries(CAPABILITY_GROUPS)) {
      for (const t of g.tools) {
        if (!agent.has(t) && !dev.has(t)) {unreachable.push(`${name}.${t}`)}
      }
    }
    expect(
      unreachable,
      `这些工具在能力组里，但 agent / developer 档都拿不到 ——\n` +
      `后果是「组激活了却没带来任何工具」，且完全静默。\n` +
      `修法：把对应能力层加进 registry.ts 的 agent.includes：\n  ${unreachable.join('\n  ')}`,
    ).toEqual([])
  })

  it('每个能力组在 agent 档至少有一个可用工具（不能是空组）', () => {
    const agent = new Set(resolveToolset('agent'))
    const dev = new Set(resolveToolset('developer'))
    const emptyGroups: string[] = []
    for (const [name, g] of Object.entries(CAPABILITY_GROUPS)) {
      const usable = g.tools.filter(t => agent.has(t) || dev.has(t))
      if (usable.length === 0) {emptyGroups.push(name)}
    }
    expect(emptyGroups, `这些组在 agent/developer 档一个工具都没有，等于空转：${emptyGroups.join(', ')}`)
      .toEqual([])
  })
})

describe('⑧ 招牌场景必须能触发对应能力（README 承诺的口语说法）', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  // 用**用户真的会说的口语**验证，不是用工具名或书面语。
  // 依据：README「她跟别的 AI 不一样」里逐条列出的招牌场景。
  const SIGNATURE_SCENES: Array<[string, string, string]> = [
    // README: "你说'帮我保存这个文件'她就照做" → 电脑操控
    ['帮我打开那个软件点一下确定', 'agent', 'computer_use'],
    ['帮我操作一下这个软件界面', 'agent', 'computer_use'],
    ['鼠标移到那个按钮上点它', 'agent', 'computer_use'],
    // README: 三 Agent 团队
    ['让团队一起帮我写个完整项目', 'agent', 'team_advanced'],
    ['帮我看看团队最近表现怎么样', 'agent', 'team_advanced'],
    // README: 真正的记忆
    ['你还记得我之前说过什么吗', 'agent', 'memory_deep'],
    // README 内置工具清单：天气 / 邮件 / 语音
    ['今天天气怎么样', 'agent', 'weather'],
    ['帮我看看有没有新邮件', 'agent', 'mail'],
    ['朗读一下这段文字', 'agent', 'voice'],
    // README: 团队社交生活
    ['帮我发条朋友圈', 'agent', 'social'],
    // README: MCP 扩展
    ['接一个 MCP 服务', 'agent', 'mcp'],
    // 日常效率
    ['明天有什么日程安排', 'agent', 'calendar'],
    ['每天下午三点提醒我喝水', 'agent', 'tasks_schedule'],
    ['桌面太乱了帮我整理', 'agent', 'desktop_tidy'],
    ['帮我截个图', 'agent', 'system_extra'],
    ['写一篇关于 AI 的文章', 'agent', 'creator'],
    ['帮我提交一下代码', 'agent', 'git_ops'],
  ]

  it.each(SIGNATURE_SCENES)('「%s」→ 激活 %s', (input, mode, expectedGroup) => {
    const base = resolveToolset(mode)
    const r = routeTools(base, mode, input, 'sig')
    expect(
      r.groups,
      `招牌场景「${input}」没能激活 ${expectedGroup} 组。\n` +
      `这会让 README 承诺的能力在真实对话里拿不到 —— 请补关键词。`,
    ).toContain(expectedGroup)
  })
})

describe('⑩ 🔴 自然口语命中率（防关键词退化）', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  // 【这个用例的来历】
  // 2026-10-07 用 67 条**自然口语**压测，命中率只有 **60%** ——
  // 因为关键词当初是照着「工具名 / 书面语」写的，而用户说的是口语：
  //   「我桌面文件太乱了」  ← 关键词只写了「桌面太乱」（顺序不同就漏）
  //   「帮我截个屏」        ← 只写了「截图」
  //   「这个网页打不开」    ← 只写了「网站」
  //   「帮我写个方案」      ← creator 组 4 条全漏
  // 补完关键词后升到 100%。本用例把这些说法固化下来，防止以后改关键词时退化。
  //
  // ⚠️ 注意它**不是**「语义理解」的证明 —— 它只证明这批说法覆盖到了。
  //   关键词永远是长尾，真正的语义路由见 toolRouter.ts 顶部的说明。
  const NATURAL_PHRASINGS: Array<[string, string[]]> = [
    ['computer_use', ['帮我点一下那个按钮', '帮我在那个窗口里输入文字', '打开记事本打几个字', '把鼠标移到右上角', '帮我关了那个弹窗', '这个软件怎么操作', '帮我自动填一下', '屏幕上看不到按钮，帮我找找']],
    ['calendar', ['我下午有什么安排', '帮我看看明天几点开会', '三点要见客户，帮我记一下', '这周有什么日程', '帮我排个时间', '我什么时候有空']],
    ['tasks_schedule', ['半小时后提醒我', '每天早上叫我起床', '到点了提醒我一下', '帮我定个闹钟', '每周一提醒我交周报']],
    ['desktop_tidy', ['我桌面文件太乱了', '帮我收拾一下桌面', '桌面一堆文件帮我归归类', '把桌面清理一下']],
    ['system_extra', ['帮我截个屏', '复制一下这段', '帮我打开这个文件夹', '看看哪个进程占内存', '把这个存到剪贴板']],
    ['memory_deep', ['我们之前聊过什么', '你还记得我上次说的吗', '帮我回忆一下', '把我们聊的总结一下']],
    ['team_advanced', ['让队友帮我一起弄', '这个活太多了，找人分担一下', '帮我做个完整的项目', '让 Yak 看看这段代码']],
    ['mcp', ['接入一个外部工具', '配置一下 MCP']],
    ['voice', ['帮我念出来', '把这段读给我听', '开启语音输入']],
    ['weather', ['今天冷吗', '外面下雨没', '明天要带伞吗']],
    ['mail', ['有没有人给我发邮件', '帮我发封邮件', '回一下这封邮件']],
    ['social', ['帮我发个动态', '在朋友圈发一条']],
    ['creator', ['帮我写个方案', '写一篇公众号', '帮我起个标题', '生成一张图']],
    ['news', ['今天有什么大事', '看看科技圈发生了什么', '给我念念今天的资讯']],
    ['gaming', ['陪我玩会游戏', '帮我看看游戏状态']],
    ['pomodoro', ['我要开始专注了', '帮我计时 25 分钟']],
    ['research', ['帮我深入调研一下这个行业']],
    ['git_ops', ['把改动存一下', '看一下我改了什么', '这个仓库的历史']],
    ['browser_actions', ['这个网页打不开', '帮我登录那个网站', '在页面上填一下表单']],
  ]

  const agent = () => resolveToolset('agent')

  it('每条自然口语都能激活对应能力组（不允许退化）', () => {
    const failures: string[] = []
    let total = 0
    for (const [group, phrases] of NATURAL_PHRASINGS) {
      for (const p of phrases) {
        total++
        _resetAllToolRouting()
        const r = routeTools(agent(), 'agent', p, 'natural')
        if (!r.groups.includes(group)) {failures.push(`「${p}」→ 期望 ${group}，实际 [${r.groups.join(',') || '无'}]`)}
      }
    }
    expect(
      failures,
      `这些自然口语没能激活对应能力组 —— 用户这么说时，那类工具就不会进 function list：\n  ` +
      failures.join('\n  ') +
      `\n\n修法：往 toolRouter 的 CAPABILITY_GROUPS 里补口语化关键词。` +
      `中文口语会把动词拆开（点一下 / 截个屏 / 念出来），只写书面语会漏。`,
    ).toEqual([])
    expect(total).toBeGreaterThanOrEqual(60)
  })

  it('闲聊不应该误触发任何能力组（避免白花 token）', () => {
    const chitChat = ['早上好呀', '今天好累啊', '你在干嘛呢', '哈哈哈哈哈', '嗯嗯好的', '谢谢你']
    const triggered: string[] = []
    for (const c of chitChat) {
      _resetAllToolRouting()
      const r = routeTools(agent(), 'agent', c, 'chat-probe')
      if (r.groups.length > 0) {triggered.push(`「${c}」→ ${r.groups.join(',')}`)}
    }
    expect(triggered, `闲聊不该激活能力组（每激活一组就多花 token）：\n  ${triggered.join('\n  ')}`)
      .toEqual([])
  })
})

describe('⑪ 🧠 语义兜底（方案 C）：只在「关键词没命中 + 确实是行动请求」时才问 LLM', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  // 【方案 C 的核心约束】
  // 每句话都问 LLM（方案 B）会让首字延迟 +0.5~2s，对桌宠是体感上的损失。
  // 所以只在**最可能判断错**的情况下才问：关键词一个都没命中、且像在要求做事。
  // 这两条守卫就是「零延迟保证」的边界。
  it('闲聊一律不触发语义兜底（一次 LLM 都不调）', () => {
    const chitChat = [
      '早上好呀', '今天好累啊', '你在干嘛呢', '哈哈哈哈哈', '嗯嗯好的', '谢谢你',
      '你好', '晚安', '讲个笑话', '你在吗', '无聊死了', '哦', '好的',
    ]
    const leaked = chitChat.filter(t => looksLikeActionRequest(t))
    expect(
      leaked,
      `这些闲聊被判成了「行动请求」，会白白多调一次 LLM、拖慢首字：\n  ${leaked.join('\n  ')}`,
    ).toEqual([])
  })

  it('明显的行动请求要能被识别出来', () => {
    const actions = [
      '帮我整理一下桌面', '把那个文件删了吧', '查一下这个报错', '帮我发封邮件',
      '写个总结', '搜索一下量子计算', '帮我订个闹钟', '这个数据帮我统计一下',
      '麻烦帮我把这段翻译了', '打开那个软件',
    ]
    const missed = actions.filter(t => !looksLikeActionRequest(t))
    expect(missed, `这些明显是请求却没被识别：\n  ${missed.join('\n  ')}`).toEqual([])
  })

  it('过短的输入不触发（不值得为「继续」调一次 LLM）', () => {
    for (const t of ['继续', '嗯', '好', '?', '再来']) {
      expect(looksLikeActionRequest(t), `「${t}」太短，不该触发语义兜底`).toBe(false)
    }
  })

  it('分类提示词里包含所有能力组名（加组时自动同步，不会漏）', () => {
    const names = Object.keys(CAPABILITY_GROUPS)
    const prompt = buildGroupSelectorPrompt('帮我做点什么', names)
    const missing = names.filter(n => !prompt.includes(n))
    expect(missing, `提示词里少了这些组，模型不可能选到它们：${missing.join(', ')}`).toEqual([])
  })

  it('解析器只接受合法组名，模型自创的一律丢弃', () => {
    const names = Object.keys(CAPABILITY_GROUPS)
    // 模型可能输出中文逗号、空格、甚至自创组名
    expect(parseGroupAnswer('calendar, mail', names)).toEqual(['calendar', 'mail'])
    expect(parseGroupAnswer('calendar，mail', names)).toEqual(['calendar', 'mail'])
    expect(parseGroupAnswer('  calendar  mail ', names)).toEqual(['calendar', 'mail'])
    expect(parseGroupAnswer('NONE', names)).toEqual([])
    expect(parseGroupAnswer('none', names)).toEqual([])
    expect(parseGroupAnswer('', names)).toEqual([])
    expect(
      parseGroupAnswer('calendar, totally_made_up_group', names),
      '模型自创的组名不该被接受 —— 它会被当成「组激活了但没工具」',
    ).toEqual(['calendar'])
  })

  it('reasoning 模型的输出也能解析（答案可能在 reasoning 字段里）', () => {
    const names = Object.keys(CAPABILITY_GROUPS)
    // Qwen3.6 这类 reasoning 模型会把内容放进 reasoning_content，text 为空
    expect(parseGroupAnswer('NONE\ncalendar, mail', names)).toEqual(['calendar', 'mail'])
  })

  it('extraGroups 能把语义选出的组带进来（且只接受真实存在的组）', () => {
    const base = resolveToolset('agent')
    _resetAllToolRouting()
    const withExtra = routeTools(base, 'agent', '随便一句话', 'sem', true, ['calendar', '不存在的组'])
    expect(withExtra.groups).toContain('calendar')
    expect(withExtra.groups, '不存在的组不该出现在结果里').not.toContain('不存在的组')
    expect(withExtra.tools).toContain('calendar_add')
  })
})

describe('⑨ 真的省了 token', () => {
  beforeAll(() => { registerAllTools() })
  beforeEach(() => { _resetAllToolRouting() })

  it('agent 档：普通问题（无关键词）至少省 40%', () => {
    const full = schemaTokens(agentTools())
    const r = routeTools(agentTools(), 'agent', '你好，今天过得怎么样', 's1')
    const now = schemaTokens(r.tools)
    const saved = 1 - now / full
    expect(
      saved,
      `agent 档只省了 ${Math.round(saved * 100)}%（${full} → ${now} tokens），低于预期的 40%。\n` +
      `若刚往 CORE_TOOLS 里加了工具，请重新评估这笔固定开销。`,
    ).toBeGreaterThan(0.40)
  })

  it('developer 档：普通问题也至少省 40%', () => {
    const full = schemaTokens(devTools())
    const r = routeTools(devTools(), 'developer', '帮我看看这个 bug', 's1')
    const now = schemaTokens(r.tools)
    const saved = 1 - now / full
    expect(saved, `developer 档只省了 ${Math.round(saved * 100)}%`).toBeGreaterThan(0.40)
  })

  it('即使激活了团队进阶组，仍比全量小', () => {
    const full = schemaTokens(agentTools())
    const r = routeTools(agentTools(), 'agent', '团队一起做个完整项目', 's1')
    const now = schemaTokens(r.tools)
    expect(now, '激活大组后不该反而超过全量').toBeLessThan(full)
  })

  it('核心层本身必须是"小而够用"的（≤ 32 个工具）', () => {
    // 31 个的构成：21 个基础能力 + 14 个提示词教过的团队工具（- 4 重叠）
    // 这个上限不是拍脑袋：它是「每轮固定开销」的直接决定因素。
    expect(
      CORE_TOOLS.length,
      `CORE_TOOLS 已膨胀到 ${CORE_TOOLS.length} 个。核心层每加一个工具，` +
      `每次调用都要多付一次 schema 开销 —— 请先确认它真的该常驻，` +
      `或者考虑把它挪进按需组。`,
    ).toBeLessThanOrEqual(32)
  })
})
