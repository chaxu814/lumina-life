// ============================================================
// registry.ts — 工具注册中心 (v2.4)
//
// v2.4 新增:
//   - mcp toolset (MCP 协议支持)
//   - executeToolWithRetry: 超时+重试机制
//   - executeToolsParallel: 并行执行无依赖工具
//   - detectToolDependencies: 工具依赖图分析
// ============================================================

import type { ToolDef, ToolResult, LLMToolCall } from './types'
import { getSecurityGuard } from '../securityGuard'

type ToolImpl = (args: Record<string, any>) => Promise<ToolResult>

const toolImplementations = new Map<string, ToolImpl>()
const toolDefinitions = new Map<string, ToolDef>()

// ═══════════════════════════════════════════════════════════
// Toolset 定义 (声明式、可组合)
// ═══════════════════════════════════════════════════════════

export interface ToolsetDef {
  description: string
  tools: string[]
  includes?: string[]
}

export const TOOLSETS: Record<string, ToolsetDef> = {
  // ═══════════════════════════════════════════════════════════
  // 【v3.34 修复】ToolDef.toolsets 曾经完全被忽略 —— 声明了 toolsets 的
  // 工具实际永远进不了模型的 function list。实测：132 个已注册工具里有
  // **47 个**不在任何静态 toolset 中（team_message / hire_worker /
  // adversarial_review / desktop_act / creator_* / tavily_* / lsp_* …），
  // 而 agentTeamPersonas.ts 又花了 20 行教模型去调其中 5 个。
  //
  // 【但不能无脑全并】实测 ToolDef.toolsets 里 'agent' 被宽泛标注了
  // **121/132** 次 —— 邮件、创作者、浏览器、搜索全写着 'agent'。若直接
  // 合并，agent 模式会从 34 涨到 121，三档按需加载的分层设计当场作废
  // （每轮 function list 多塞 87 个 schema，纯烧 token 还会稀释选择）。
  //
  // 【采用的方案：模式层静态、能力层声明式】
  //   · 模式层（chat / agent / developer）保持静态表独占 —— 它表达的是
  //     「这一档给用户多少能力」的产品决策，不能被工具自己声明左右。
  //   · 能力层（team / lsp / browser / computer_use / creator / …）改为
  //     声明式自动解析：所有 ToolDef.toolsets 里写了该名字的工具自动并入。
  //     这样新加工具只要写对 toolsets 就能被看见，不用记得改第二张表。
  //   · 新增 full：全量注册工具，供「全部工具」模式 / 高级用户使用。
  //
  // 未被任何 toolset 覆盖的工具会在启动日志里告警（见 tools/index.ts），
  // 防止再次静默沉底。详见 resolveToolset() 与 MODE_TOOLSETS。
  // ═══════════════════════════════════════════════════════════

  /** 全量工具集：所有已注册工具（运行时特殊处理，不受分档限制） */
  full: {
    description: '全量工具 — 不分档，供高级用户 / 调试用',
    tools: [],
  },

  // ═══════════════════════════════════════════════════════════
  // 精简三层工具架构（方案B — 按模式分档加载）
  //   设计原则：
  //     - chat: 纯对话（0 工具，最安全）
  //     - agent: 日常使用（约 32 工具：文件+终端+搜索+记忆+任务+系统+团队）
  //     - developer: agent + git + LSP/AST + 代码工具 + Computer Use + 浏览器
  //   全量注册工具 132 个（含 Computer Use/新闻/创作者/LSP/MCP/邮件等，
  //   按需启用），启动日志会打印实际注册数与各档可达数。
  //   旧有 TOOLSETS 保留在下方，保证 resolveToolset 向下兼容。
  // ═══════════════════════════════════════════════════════════

  /*** 🟢 L1 — 纯对话模式：只看、不做事 */
  chat: {
    description: '纯对话 — 无工具',
    tools: [],
  },

  /*** 🟡 L2 — Agent 日常模式：文件+搜索+记忆+团队 */
  agent: {
    description: 'Agent 模式 — 日常使用工具（能力全集，由 toolRouter 按需暴露）',
    // ═══════════════════════════════════════════════════════════
    // 🔧 2026-10-07 重大修正：补回被静态表漏掉的日常能力
    //
    // 【原来的问题】本表只列了 9 个子集，于是**64 个工具**虽然自己声明了
    //   `toolsets: ['agent']`，却因为「模式层静态表独占」而**声明被忽略** ——
    //   日常模式下完全拿不到。其中包括 README 明确宣传的核心能力：
    //     · 🖥️ Computer Use（README 核心亮点，承诺「你说帮我保存这个文件她就照做」）
    //     · 💬 团队社交生活（README 核心亮点）
    //     · ⏰ 天气 / 邮件（README 内置工具清单里点名）
    //     · 🔌 MCP、🎙️ 语音输入/TTS、✍️ 创作者、🎮 游戏、🍅 番茄钟、📰 资讯
    //   后果：这些工具在 601 次真实调用里全是 0 次 —— **不是不想用，是拿不到**。
    //   而工具作者写 `toolsets: ['agent']` 时，显然以为自己是接好的。
    //
    // 【现在】模式层不再承担「能力多少」的决策，只保留「哪些能力属于这一档」：
    //   · agent = 用户日常可能用到的**全部能力**
    //   · developer = agent + 代码智能（lsp / code / dev_tools）
    //   真正的「这一轮给多少」交给 toolRouter 按意图决定（每轮 31~45 个）。
    //   于是「能力可达」和「每轮开销」不再互相牺牲。
    // ═══════════════════════════════════════════════════════════
    includes: [
      // 原有基础
      'files_core', 'shell', 'web_search', 'memory', 'tasks_core', 'system_core',
      'team', 'productivity', 'skills',
      // 🆕 补回的日常能力（此前被静态表漏掉）
      'computer_use', 'desktop', 'browser',      // 🖥️ 桌面操控 / 浏览器精细操作
      'mcp',                                      // 🔌 扩展协议
      'media', 'hearing', 'voice',                // 🎙️ TTS / 语音输入 / 朗读
      'weather_tool', 'weather_brief',            // ⏰ 天气
      'mail',                                     // 📧 邮件
      'social',                                   // 💬 团队社交生活
      'proactive',                                // 💡 主动关心
      'creator', 'research',                      // ✍️ 创作 / 深度研究
      'pomodoro', 'gaming',                       // 🍅 番茄钟 / 🎮 游戏
      'news', 'bilibili_hot', 'code_daily',       // 📰 资讯
      'files', 'skill_system',                    // 磁盘列表 / 复合技能
      'system',                                   // 剪贴板等（system_extra 组依赖它）
      'git',                                      // 版本控制（「帮我提交一下」是日常请求）
      'self',                                     // 🪞 自我认知（about_lumina：版本/平台/团队/工具/边界）
    ],
    tools: [],
  },

  /*** 🔵 L3 — 开发者模式：Agent + Git + 代码工具 + Computer Use + 浏览器 */
  developer: {
    description: '开发者模式 — Agent + Git + LSP/AST + 代码工具 + Computer Use + 浏览器',
    // v3.34: 补上 lsp / code / computer_use / browser —— 修复前即使工具声明了
    // 自己的 toolsets，开发者模式也拿不到 ast_search / lsp_* / desktop_act
    // 这一整层「写代码真正要用的工具」。
    includes: ['agent', 'git', 'team', 'lsp', 'code', 'computer_use', 'browser', 'desktop', 'dev_tools'],
    tools: [],
  },

  // ── 新精简子集（方案B）──────────────────────────────

  files_core: {
    description: '文件操作（核心）',
    tools: ['file_read', 'file_write', 'file_edit', 'file_list', 'file_search'],
  },

  shell: {
    description: '终端命令',
    tools: ['shell_exec'],
  },

  web_search: {
    description: '搜索 + 抓取 + 浏览器',
    // v3.34: 搜索引擎后端（Tavily / SerpAPI / Bing）走能力层声明，
    // 修复前它们声明的是模式层 'agent'，因而对模型彻底不可达。
    includes: ['search_engines'],
    tools: ['web_search', 'web_fetch', 'browser'],
  },

  memory: {
    description: '记忆系统（三层 + 向量检索）',
    tools: ['memory_save', 'memory_search', 'memory_get', 'memory_all', 'memory_summarize'],
  },

  tasks_core: {
    description: '任务与定时器',
    // ask_decision 放在这里而不是 team：它对**任何** agent 都可用（包括单 agent 模式），
    // 协作性质但不是团队专属。
    tools: ['todo', 'cron_schedule', 'cron_list', 'cron_cancel', 'ask_decision'],
  },

  system_core: {
    description: '系统工具（核心）',
    tools: ['datetime', 'screenshot', 'system_info', 'notification', 'open_file'],
  },

  // ── 生活/效率类工具 ────────────────────────────────
  // 为什么要单开一层：日历、桌面整理这类「帮用户管理他自己的东西」的能力，
  // 既有独立的隐私含义（会碰用户的日程和文件），又不属于开发工作流。
  // 挂进模式层（agent/chat/developer）会破坏分档 —— 模式层是静态表独占，
  // 工具自己声明进不去，写了也会被 resolveToolset 忽略，
  // 结果就是 tests/delegationSafety.test.ts 的孤儿守卫报红。
  productivity: {
    description: '生活效率（日程 / 桌面整理）',
    tools: ['calendar_list', 'calendar_add', 'calendar_remove', 'calendar_free',
            'desktop_tidy_scan', 'desktop_tidy_plan', 'desktop_tidy'],
  },

  // 技能扩展：装第三方技能 = 改变 Agent 自身能力，风险模型与日常工具不同。
  // 与已有的 skills（已装技能的执行入口）合为一层，方便用户一次性开关。
  skills: {
    description: '技能系统（已装技能执行 + 第三方技能搜索/安装）',
    tools: ['skill_run', 'skill_search', 'skill_install'],
  },

  git: {
    description: 'Git 操作',
    tools: ['git_status', 'git_commit', 'git_log', 'git_diff'],
  },

  team: {
    description: '团队协作 — 委托/流水线/通知板/共享上下文/模式切换',
    tools: ['delegate_to', 'run_subagents', 'mode_switch', 'mode_status', 'team_context',
            'delegate_chain', 'write_notice', 'read_notices', 'save_context', 'load_context'],
  },

  // ── 官方示例技能（冷启动）──────────────────────────
  // 与 electron/skills/<name>/SKILL.md 对应，工具实现见 electron/tools/impl/
  bilibili_hot: {
    description: 'B站热搜/热门榜推送',
    tools: ['bilibili_hot_search', 'bilibili_hot_push'],
  },

  weather_brief: {
    description: '每日天气简报（Open-Meteo，无需 Key）',
    tools: ['weather_get', 'weather_brief'],
  },

  code_daily: {
    description: '代码日报/周报（Git 仓库提交统计）',
    tools: ['code_daily_generate', 'code_daily_weekly'],
  },

  pomodoro: {
    description: '番茄钟提醒（工作+休息计时+系统通知）',
    tools: ['pomodoro_start', 'pomodoro_status', 'pomodoro_stop'],
  },

  // ── 旧有子集（保留以供向后兼容）────────────────────

  files: {
    description: '文件操作（旧）',
    tools: ['file_read', 'file_write', 'file_edit', 'file_list', 'file_search', 'disk_list', 'desktop_scan'],
  },

  web: {
    description: '浏览器自动化 + 网页抓取',
    tools: ['browser', 'web_fetch'],
  },

  search: {
    description: '多引擎网页搜索',
    tools: ['web_search'],
  },

  fetch: {
    description: '网页内容抓取',
    tools: ['web_fetch'],
  },

  weather_tool: {
    description: '天气查询',
    tools: ['weather'],
  },

  tasks: {
    description: '任务与定时（旧）',
    tools: ['todo', 'cron_schedule', 'cron_list', 'cron_cancel'],
  },

  system: {
    description: '系统工具（旧）',
    tools: ['datetime', 'screenshot', 'clipboard_get', 'clipboard_set', 'system_info', 'notification', 'open_file'],
  },

  desktop: {
    description: '桌面自动化（旧）',
    // 🔧 2026-10-07: 移除 desktop_mouse_move —— 该工具已弃用（index.ts 里不再注册，
    //   注释写明「极少单独使用，desktopAct 覆盖」），但本表仍在引用它，
    //   导致每次 resolveToolset('desktop') 都打一行「跳过未注册工具」告警，
    //   长期淹没真实告警。
    tools: ['ocr', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_screen_size'],
  },

  oath: {
    description: '誓约与预约',
    tools: ['oath_make', 'oath_list', 'oath_fulfill', 'appointment_set', 'appointment_list'],
  },

  mcp: {
    description: 'MCP 协议 — 连接外部工具服务器',
    tools: ['mcp_list_servers', 'mcp_connect', 'mcp_list_tools', 'mcp_call_tool'],
  },

  /** 🪞 自我认知 — Agent 查询自身实时信息（about_lumina：版本/平台/团队/工具/边界） */
  self: {
    description: '自我认知 — about_lumina（实时自省快照）',
    tools: [],
  },

  skill_system: {
    description: 'Skill 封装系统（旧）',
    includes: ['skills'],
    tools: [
      'browser_click_smart',
      'file_search_smart',
      'web_search_multi',
      'code_review_smart',
      'quick_setup',
      'proactive_check',
      'install_skill',
      'use_skill',
    ],
  },

  hearing: {
    description: '听觉系统 — 语音输入和监听',
    tools: ['hearing_start', 'hearing_stop', 'hearing_status', 'hearing_transcript'],
  },

  input: {
    description: '键盘模拟 — 按键和文本输入',
    tools: ['keyboard_press', 'keyboard_type'],
  },

  proactive: {
    description: '主动对话管理',
    tools: ['proactive_status', 'proactive_trigger'],
  },

  computer_use: {
    description: 'Computer Use — 屏幕理解 + 自动操作鼠标键盘 + 桌面扫描',
    tools: ['desktop_see', 'desktop_act', 'desktop_screen_size', 'desktop_scan'],
  },

  // ── 🎮 Minecraft 游戏集成（双路线：视觉 / Mineflayer 程序化）─────────
  gaming: {
    description: 'Minecraft 游戏集成 — 感知游戏状态并执行移动/攻击/聊天等动作',
    tools: ['game_status', 'game_action', 'game_look', 'game_chat'],
  },

  mail: {
    description: 'Agent 邮件 — Agent 给用户发送邮件提醒',
    tools: ['mail_send', 'mail_list', 'mail_mark_read'],
  },

  memory_v2: {
    description: '结构化记忆（旧，由 memory 替代）',
    tools: ['memory_save', 'memory_search', 'memory_get', 'memory_all', 'memory_summarize'],
  },

  // ── v3.34 新增：能力层占位（tools 为空，由 ToolDef.toolsets 声明式填充）
  //    修复前这些名字在静态表里根本不存在，导致 developer 的 includes 引用它们时
  //    resolveToolset 静默返回 []，lsp_* / ast_search / browser_* 这一整层
  //    「写代码真正要用的工具」即使声明了 toolsets 也拿不到。
  // ────────────────────────────────────────────────────────────────

  lsp: {
    description: 'LSP / AST 代码导航',
    tools: [],
  },

  code: {
    description: '代码智能（开发伴手 / 每日代码报告等）',
    tools: [],
  },

  browser: {
    description: '浏览器自动化（Playwright / CDP）',
    tools: [],
  },

  creator: {
    description: '内容创作工作流（大纲/生成/润色/导出）',
    tools: [],
  },

  research: {
    description: '深度调研',
    tools: [],
  },

  media: {
    description: '多媒体生成',
    tools: [],
  },

  social: {
    description: '团队社交（群聊/朋友圈/社交引擎）',
    tools: [],
  },

  voice: {
    description: '语音输出 / 输入',
    tools: [],
  },

  news: {
    description: '新闻聚合与日报',
    tools: [],
  },

  // ── v3.34：为「8 个孤儿工具」新增的能力层 ────────────────────
  // 真机跑打包版时，孤儿守卫（终于不再被 full 短路）报出 8 个不可达工具。
  // 根因：它们的 ToolDef.toolsets 只写了 'agent' / 'developer' —— 而这两个是
  // **模式层**（MODE_TOOLSETS），按设计由静态表独占，工具自己声明不进去。
  //
  // 修法不是把它们硬塞进模式层（那会破坏分档），而是补两个能力层，
  // 让声明真的能生效。
  dev_tools: {
    description: '开发伴手工具（仅开发者模式）',
    tools: [],
  },

  search_engines: {
    description: '多搜索引擎后端（Tavily / SerpAPI / Bing）',
    tools: [],
  },
}

// ═══════════════════════════════════════════════════════════
// 注册 API
// ═══════════════════════════════════════════════════════════

export function registerTool(def: ToolDef, impl: ToolImpl): void {
  // 🔧 P0-4：注册时自动补齐副作用语义（ToolDef 自己显式声明的优先）。
  //   接入点选在这里而不是 82 个 impl 文件里，是因为这是【唯一】的注册通道 ——
  //   漏过一个文件就会漏过一个安全属性。
  const annotated = withSideEffects(def)
  toolDefinitions.set(annotated.name, annotated)
  toolImplementations.set(annotated.name, impl)
}

export function getToolDef(name: string): ToolDef | undefined {
  return toolDefinitions.get(name)
}

export function getAllToolDefs(): ToolDef[] {
  return Array.from(toolDefinitions.values())
}

export function getToolNames(): Set<string> {
  return new Set(toolDefinitions.keys())
}

/** 按模式分档加载的「模式层」—— 静态表独占，不接受声明式合并
 *
 *  【为什么要单列】
 *  ToolDef.toolsets 里 'agent' 被宽泛标注了 121/132 次（邮件/创作者/浏览器/
 *  搜索全写着 agent）。若无差别合并，agent 模式会从 34 涨到 121，
 *  三档按需加载的分层设计当场作废 —— 每轮 function list 多塞 87 个
 *  schema，既烧 token 又稀释模型的选择。
 *  模式层表达的是「这一档给用户多少能力」的产品决策，不能被工具自己声明左右。
 */
export const MODE_TOOLSETS = new Set(['chat', 'agent', 'developer'])

/** 解析 toolset（支持嵌套 includes + v3.6: blockedInChild 过滤）
 *
 *  🔧 P0-fix: 自动过滤未注册的工具名，避免下游崩溃
 *
 *  🔧 v3.34-fix: 能力层 toolset 改为**声明式** —— 自动并入所有
 *  `ToolDef.toolsets` 里写了本名字的工具。修复前 `ToolDef.toolsets`
 *  字段完全无人读取，导致 132 个已注册工具中有 47 个对模型彻底不可达
 *  （team_message / hire_worker / adversarial_review / desktop_act /
 *   creator_* / lsp_* / tavily_* …），而 agentTeamPersonas.ts 还在
 *   教模型去调其中 5 个。
 *  模式层（chat/agent/developer）例外，见 MODE_TOOLSETS 注释。
 */
export function resolveToolset(
  name: string,
  visited = new Set<string>(),
  /** 🆕 v3.6: 过滤掉 blockedInChild 工具（子Agent 使用） */
  excludeChildBlocked = false,
): string[] {
  if (visited.has(name)) {return []}
  visited.add(name)

  // full：全部已注册工具（除 blockedInChild）
  if (name === 'full') {
    const all = [...toolDefinitions.keys()]
    return excludeChildBlocked ? all.filter(t => !toolDefinitions.get(t)?.blockedInChild) : all
  }

  const ts = TOOLSETS[name]
  if (!ts) {
    // 静默返回 [] 会让「includes 写错名字」这类错误完全隐形（v3.34 踩过：
    // developer 的 includes 里写了 lsp/code/browser，但静态表里没有这三个名字，
    // 于是 lsp_* / ast_search / browser_* 整层工具永远拿不到，没有任何报错）。
    console.warn(
      `[Registry] resolveToolset("${name}"): 未定义的 toolset（返回空集）。` +
      `若它出现在某个 toolset 的 includes 里，该分支的能力将静默丢失。`,
    )
    return []
  }

  const tools = new Set<string>()

  // 只添加已注册的工具
  for (const t of ts.tools) {
    if (toolDefinitions.has(t)) {
      tools.add(t)
    } else {
      console.warn(`[Registry] resolveToolset("${name}"): 跳过未注册工具 "${t}"`)
    }
  }

  // 🆕 v3.34: 能力层声明式合并 —— ToolDef.toolsets 声明了本名字的工具自动并入
  //    模式层与 full 跳过：前者要保持分档，后者已经全量。
  if (!MODE_TOOLSETS.has(name)) {
    for (const [toolName, def] of toolDefinitions) {
      if (def.toolsets?.includes(name)) {
        tools.add(toolName)
      }
    }
  }

  if (ts.includes) {
    for (const inc of ts.includes) {
      for (const t of resolveToolset(inc, visited, excludeChildBlocked)) {
        tools.add(t)
      }
    }
  }

  // 过滤 blockedInChild 工具
  if (excludeChildBlocked) {
    return [...tools].filter(t => {
      const def = toolDefinitions.get(t)
      return !def?.blockedInChild
    })
  }

  return [...tools]
}

/** 获取 toolset 的所有工具定义 */
export function getToolsetTools(toolsetName: string): ToolDef[] {
  const names = resolveToolset(toolsetName)
  const defs = names.map(n => toolDefinitions.get(n)).filter(Boolean) as ToolDef[]

  // 合并 skills/ 目录中的 SKILL.md 描述到 tools
  //   不覆盖已有定义，只补充额外信息
  if (defs.length > 0) {
    try {
      const { loadSkill } = require('../skills/skillsLoader')
      const skill = loadSkill(toolsetName)
      if (skill && skill.tools.length > 0) {
        // SKILL.md 里列出的工具如果没注册，报 warning
        for (const t of skill.tools) {
          if (!toolDefinitions.has(t)) {
            console.warn(`[Registry] 技能 "${toolsetName}" 的工具 "${t}" 未注册`)
          }
        }
      }
    } catch { /* skillsLoader 可选 */ }
  }

  return defs
}

// ═══════════════════════════════════════════════════════════
// 🔀 工具别名重定向（2026-10-07）
//
// 【它替代了什么】原先 tools/index.ts 注册了 4 个「反幻觉占位工具」
//   （tavily_search / tavily_extract / serpapi_search / bing_search），
//   每个都要占 schema 体积、每轮重发，却只 return 一句「本系统没有 Tavily」。
//   而且它们出现在 function list 里，反而在**诱导**模型去调用。
//
// 【现在怎么做】这些名字**不再注册成工具**（省 340 tokens/轮），
//   而是在执行层做一次别名解析：命中即改走真实工具，模型拿到的是真结果。
//   好处：
//     · 覆盖面从「硬编码 3 个」扩大到「任意搜索/抓取类幻觉名」
//     · 零 token 成本（不进 function list）
//     · 模型不需要知道这件事 —— 它以为自己调成功了，实际拿到了真数据
//
// 【安全边界】只映射**只读**工具（搜索 / 抓取）。绝不把幻觉名映射到
//   写文件、执行命令、发邮件这类有副作用的工具上 —— 那等于把「模型编错名字」
//   升级成「模型在错误的工具上执行了真实操作」。
// ═══════════════════════════════════════════════════════════

// 【安全边界】只映射**只读**工具（搜索 / 抓取 / 读文件）。
//   绝不把幻觉名映射到写文件、执行命令、发邮件这类有副作用的工具上 ——
//   那等于把「模型编错名字」升级成「模型在错误的工具上执行了真实操作」，
//   而且会**绕过 worker 的 disabledTools 黑名单**（worker 看不到 shell_exec，
//   但若 `bash` 被映射到它，幻觉一个 `bash` 就能拿到 shell）。
//   因此下面刻意**没有** bash / run_command / write_file / edit_file 这类条目。
//   另有一层保险：executeToolWithRetry 会拿 cfg.deniedTools 再拦一次。
// ═══════════════════════════════════════════════════════════

/** 幻觉名 → 真实工具名。**值只允许是只读工具。** */
const TOOL_ALIASES: Record<string, string> = {
  // 搜索类 → web_search
  bing_search: 'web_search',
  google_search: 'web_search',
  google: 'web_search',
  tavily_search: 'web_search',
  tavily: 'web_search',
  serpapi_search: 'web_search',
  serpapi: 'web_search',
  brave_search: 'web_search',
  duckduckgo_search: 'web_search',
  duckduckgo: 'web_search',
  search_web: 'web_search',
  websearch: 'web_search',
  // 抓取类 → web_fetch
  tavily_extract: 'web_fetch',
  scrape_url: 'web_fetch',
  fetch_url: 'web_fetch',
  webfetch: 'web_fetch',
  // 只读文件类 → 真实只读工具
  read_file: 'file_read',
  list_files: 'file_list',
  ls: 'file_list',
  grep_search: 'file_search',
  glob_search: 'file_search',
}

/**
 * 解析工具别名。命中时返回真实工具名，未命中返回原名。
 * 只做一层映射（别名指向的目标不再继续解析），避免配置成环时无限递归。
 */
export function resolveToolAlias(name: string): { name: string; aliasedFrom?: string } {
  const target = TOOL_ALIASES[String(name || '').toLowerCase()]
  if (target && toolImplementations.has(target)) {return { name: target, aliasedFrom: name }}
  return { name }
}

/** 执行工具（基础版） */
export async function executeTool(name: string, args: Record<string, any>): Promise<ToolResult> {
  // 🔀 别名重定向：模型编错名字时改走真实工具，而不是直接失败
  const resolved = resolveToolAlias(name)
  if (resolved.aliasedFrom) {
    console.log(`[registry] 🔀 工具别名重定向: ${resolved.aliasedFrom} → ${resolved.name}`)
  }
  name = resolved.name
  const impl = toolImplementations.get(name)
  if (!impl) {return { callId: '', ok: false, content: '', error: `未知工具: ${name}` }}
  try {
    const start = Date.now()
    const result = await impl(args)
    result.durationMs = result.durationMs || (Date.now() - start)
    return result
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: err.message || String(err) }
  }
}

// ═══════════════════════════════════════════════════════════
// v2.4: 工具超时+重试
// ═══════════════════════════════════════════════════════════

export interface RetryConfig {
  /** 单次工具调用超时 (ms)，默认 30000 */
  timeoutMs?: number
  /** 最大重试次数，默认 2。
   *  🔧 P0-4：仅对「无副作用或幂等」的工具生效。sideEffect && !idempotent 的工具
   *  会被强制降到 0 —— 超时后返回「结果未知，请确认」，绝不自动重发。 */
  maxRetries?: number
  /** 重试间隔策略: 'fixed' | 'exponential'，默认 'exponential' */
  backoff?: 'fixed' | 'exponential'
  /** 固定重试间隔 (ms)，默认 1000 */
  retryDelayMs?: number
  /** 工具特定的超时覆盖 (ms) */
  toolTimeouts?: Record<string, number>
  /**
   * 🔒 本次运行**禁止执行**的工具名（含别名）。
   *
   * 【为什么执行层还要拦一次】
   * `disabledTools` 原先只在 `getToolsForMode()` 里过滤**暴露给模型的工具列表**。
   * 但「没暴露」不等于「执行不了」——模型仍可能凭幻觉直接调用一个名字。
   * 加了别名重定向后这个缺口更明显：worker 看不到 `web_search`，
   * 却可以幻觉一个 `tavily_search` 让别名把它重定向过去。
   *
   * 所以别名解析后必须再对照本名单拦一次：**白名单是暴露层的规则，
   * 黑名单必须是执行层的规则**，两层都要成立。
   */
  deniedTools?: string[]
  /**
   * 📋 本轮**实际暴露**给模型的工具名。
   *
   * 【为什么要传下来】加了按需筛选后，「工具不存在」和「工具本轮没加载」
   * 是两件完全不同的事：前者是模型在幻觉，后者是筛选判断失误。
   * 执行层需要知道本轮到底给了哪些工具，才能在失败时给模型一条**能立刻走通**的
   * 出路（列出可用工具），而不是笼统地说「不存在」。
   */
  availableTools?: string[]
}

// ═══════════════════════════════════════════════════════════
// 🔧 P0-4 副作用判定（2026-10-05）
//
// 【背景：本文件 636 行原本写着】
//   「底层 promise 并没被取消，重试会叠加出一串仍在后台跑的任务。」
// 注释准确地描述了问题，但没有解决它。配合 maxRetries=2，
// 一次「超时」实际会发起【3 次】执行。
//
// 【放大因素：超时文案不匹配短路名单】
// 超时抛的是 `工具 "x" 执行超时 (60000ms)`，而 NETWORK_FATAL_ERRORS
// 只包含 ETIMEDOUT / ECONNREFUSED 等【网络错误码】，不含这个中文文案。
// 于是超时不短路，直接进入重试循环 —— 这正是重复执行的主要入口。
//
// 【业界对照】
//   · 业界踩过同一个坑（issue #766），做法是「已 yield 的尝试永不重放」。
//   · OpenClaw 设了终止性错误码 PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE，
//     把「已投递但结果不明」明确判为不可重放。
// 我们没有这两个机制，所以补了一个显式的声明层。

/** 工具是否可安全重试。缺省【不可重试】—— 不确定时保守是对的。 */
function isRetryableTool(name: string): { retryable: boolean; reason: string } {
  const def = toolDefinitions.get(name)
  if (!def) {
    // 未知工具：不执行到重试层，这里按可重试（错误会在 executeTool 里先报出来）
    return { retryable: true, reason: '工具未注册' }
  }
  // 显式声明了 idempotent=true 的，无论是否改外部世界都可重试
  if (def.idempotent === true) {return { retryable: true, reason: '显式声明幂等' }}
  // 显式声明了 sideEffect=false 的，只读操作，可重试
  if (def.sideEffect === false) {return { retryable: true, reason: '显式声明无副作用' }}
  // 缺省（两侧都没声明）→ 保守：不重试
  return { retryable: false, reason: '未声明副作用语义，按「可能有副作用」处理，不自动重发' }
}

// ═══════════════════════════════════════════════════════════
// 🔧 P0-4 副作用标注表（2026-10-05）
//
// 【为什么用集中表，而不是在 82 个 impl 文件里逐个加字段】
// 1. 副作用与否是【安全属性】，不是业务属性。它由「这个工具改不改变外部世界」
//    决定，不该和工具实现耦合。
// 2. 82 个文件的逐个标注必然漏；漏一个就是一次重复执行事故。
//    漏在这里只是「多一次重试」，漏在那里是「发 3 封邮件」。
// 3. 需要长期维护的是【这张表】，而不是 82 个文件的 diff。
//
// 【分三类的理由】
//   · NO_SIDE_EFFECT  —— 纯读。超时重试安全，最多慢一点。
//   · IDEMPOTENT      —— 会改外部世界，但重复执行等价。
//     （git_status 看着像只读，但会写 .git 索引；同一参数重复调用等价）
//   · （未列出）       —— 按「可能有副作用」处理，不重试。
//
// 【如何新增一个只读工具】
// 往 READ_ONLY 集合里加一个名字即可。新增不读的就【不要】加 ——
// 漏加的代价是一次多余重试，多加的代价是一次重复副作用操作。
// ═══════════════════════════════════════════════════════════

/** 纯只读工具：可安全重试 */
const READ_ONLY_TOOLS = new Set<string>([
  'datetime', 'system_info', 'disk_list', 'desktop_scan',
  'file_list', 'file_read', 'file_search', 'ast_search', 'grep_search', 'glob_search', 'read_file',
  'web_search', 'web_fetch', 'browser', 'browser_cdp', 'content_collect', 'trafilatura_extract',
  'mcp_list_servers', 'mcp_list_tools', 'mcp_read_resource', 'mcp_search',
  'ocr', 'desktop_see', 'screenshot', 'voice_transcribe', 'hearing_read',
  'weather', 'weather_get', 'bilibili_hot_search', 'news_collect', 'news_digest',
  'memory_search', 'memory_chat_search', 'memory_recall', 'memory_list',
  'proactive_status', 'team_status', 'team_list', 'agent_status',
  'todo_list', 'calendar_list', 'skill_search', 'skill_list', 'code_daily_generate',
  'creator_outline', 'social_engine', 'time_capsule', 'pomodoro_status', 'oath_make',
  'deep_research', 'weather_brief', 'desktop_tidy_scan', 'developer_companion_check',
  'desktop_scan_hardware', 'process_list', 'window_list', 'run_subagents_status',
])

/** 幂等工具：会改变外部世界，但重复执行等价，可安全重试 */
const IDEMPOTENT_TOOLS = new Set<string>([
  'git_status',        // 读操作，但会写 .git 索引；同参数重复等价
  'memory_save',       // 同一条记忆重复写入为幂等（upsert 语义）
  'file_edit',         // 按内容定位替换，重复应用结果等价
  'mode_switch',       // 切到同一模式重复调用等价
  'cron_delete',       // 删不存在的任务等价
  'pomodoro_stop',     // 停已停止的计时器等价
  'desktop_tidy_scan', // 扫描是只读，保守起见也归入幂等
])

/** 构建一个带副作用标注的 ToolDef（注册时调用，声明优先于默认表） */
export function withSideEffects<T extends { name: string; sideEffect?: boolean; idempotent?: boolean }>(
  def: T,
): T {
  if (def.sideEffect !== undefined || def.idempotent !== undefined) {return def}
  if (IDEMPOTENT_TOOLS.has(def.name)) {
    return { ...def, sideEffect: true, idempotent: true }
  }
  if (READ_ONLY_TOOLS.has(def.name)) {
    return { ...def, sideEffect: false, idempotent: true }
  }
  // 未列出：不擅自假设。保持 undefined → isRetryableTool 走保守分支。
  return def
}

// deniedTools / availableTools 刻意**不**给默认值：它们不是「默认参数」，
// 而是「调用方必须显式声明本次运行的限制与暴露面」。给空数组默认值会让人以为
// 「没传 = 没有限制」，而真实语义是「没传 = 这层保护/提示没生效」。
// 用 Omit 把它们排除在 Required 之外。
const DEFAULT_RETRY_CONFIG: Required<Omit<RetryConfig, 'deniedTools' | 'availableTools'>> = {
  timeoutMs: 60000,  // 🔧 v3.8.1: 30→60s（大项目文件搜索 30s 不够）
  maxRetries: 2,
  backoff: 'exponential',
  retryDelayMs: 1000,
  toolTimeouts: {},
}

// ═══════════════════════════════════════════════════════════
// 失败信号 — 「没做成」必须显式失败（ok:false）
//
// 为什么：以前「工具不存在 / 被安全守卫拦截 / 需用户批准」三条路径
// 都返回 ok:true。于是这三件事会以**普通成功结果**的形式回灌给 LLM，
// 模型分不清「工具跑通了并返回内容」和「这件事根本没发生」，
// 很容易把「⛔ 被拦截」当事实继续推理 —— 这正是幻觉/编造的温床。
//
// 为什么不写 ok:true 就"不断链"：ReAct 循环会不会断，跟 ok 无关。
// agentRunner 拿到结果后无条件 push 一条 role:'tool' 消息，然后
// continue 下一轮（runReActLoop 里单工具分支的 push + 循环末尾
// continue）。所以这里改 ok:false **不会**中断循环，只会让回灌给模型
// 的文本从"看起来像结果"变成明确的失败信号。
// ═══════════════════════════════════════════════════════════

/** 交给模型的失败信号尾部：模型最容易在这里自作聪明，所以写死口径 */
const NOT_EXECUTED_GUIDANCE =
  '禁止据此作答，也禁止把这段内容当作事实依据继续推理；请改用可用工具重试，或直接告诉用户你做不到以及原因。'

/**
 * 构造一次「没有真的执行」的失败结果
 *
 * content 面向人和模型阅读（含原因 + 补救建议）；
 * error 也重复带上「未执行 + 别当事实」这句 —— 因为 agentRunner 在
 * ok:false 时只回灌 `工具错误: ${result.error}`，content 会被丢弃，
 * 不写进 error 这条防幻觉提示就永远到不了模型眼前。
 */
export function buildNotExecutedResult(reason: string, detail: string): ToolResult {
  return {
    callId: '',
    ok: false,
    content: `⛔ 未执行成功（原因：${reason}）。以下是失败说明，不是结果。${NOT_EXECUTED_GUIDANCE}\n\n${detail}`,
    error: `未执行成功（原因：${reason}）。${NOT_EXECUTED_GUIDANCE}`,
    durationMs: 0,
  }
}

/**
 * 带超时和重试的工具执行
 *
 * 超时策略:
 *   - browser/web_search: 15s (网络操作)
 *   - shell_exec: 60s (可能长时间运行)
 *   - 其他工具: 30s (默认)
 *
 * 重试策略:
 *   - 网络类工具: 指数退避 (1s → 4s → 16s)
 *   - 其他: 固定间隔 (1s)
 */
export async function executeToolWithRetry(
  name: string,
  args: Record<string, any>,
  config?: RetryConfig
): Promise<ToolResult> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config }

  // 🔀 别名重定向：模型编错名字（bing_search / tavily_search / read_file …）时
  //   改走真实工具，而不是回一句「工具不存在」然后让它重试一轮。
  //   这一层取代了原先 4 个「反幻觉占位工具」的职责，且不占任何 schema 体积。
  const resolvedAlias = resolveToolAlias(name)
  if (resolvedAlias.aliasedFrom) {
    console.log(`[registry] 🔀 工具别名重定向: ${resolvedAlias.aliasedFrom} → ${resolvedAlias.name}`)
    name = resolvedAlias.name
  }

  // 🔒 执行层拒绝名单：原始名与重定向后的真实名**都要**检查。
  //   只查真实名会漏掉「显式屏蔽 tavily_search」这类意图；
  //   只查原始名则别名重定向可以绕过黑名单。所以两个都查。
  if (cfg.deniedTools && cfg.deniedTools.length > 0) {
    const denied = new Set(cfg.deniedTools)
    const hitOriginal = denied.has(resolvedAlias.aliasedFrom || '')
    const hitResolved = denied.has(name)
    if (hitOriginal || hitResolved) {
      const blocked = hitOriginal ? (resolvedAlias.aliasedFrom as string) : name
      console.warn(`[registry] 🔒 工具 "${blocked}" 在执行层被拒绝（disabledTools）`)
      return buildNotExecutedResult(
        `工具 "${blocked}" 在当前角色/模式下不可用`,
        '本次调用完全没有发生。请改用当前可用工具，或请用户手动执行。',
      )
    }
  }

  // 🚧 本轮未暴露的工具 → 拒绝，并如实说明（区别于「不存在」）
  //
  // 【为什么拦】暴露列表由 toolRouter 按用户这句话决定（核心 31 个常驻 + 关键词
  //   命中的能力组）。模型调了一个**没暴露**的工具，说明筛选判断失误。
  //   这里刻意**不**放行：
  //     · 暴露边界在这个产品里一直是「能力边界」，静默绕过会与设计矛盾
  //     · 更重要的是，这是一条**该被看见的信号** —— 放行等于把「路由判断错了」
  //       悄悄吸收掉，我们永远不知道关键词该补什么。所以拒绝 + 大声记日志。
  if (cfg.availableTools && cfg.availableTools.length > 0
      && !cfg.availableTools.includes(name)) {
    const isRegistered = toolDefinitions.has(name)
    console.warn(
      `[registry] 🚧 模型调用了本轮未暴露的工具 "${name}"` +
      `（已注册=${isRegistered}）—— 路由可能判断失误，请检查 toolRouter 关键词`,
    )
    return buildNotExecutedResult(
      isRegistered
        ? `工具 "${name}" 本轮未加载（该能力存在，但你这句请求里没有触发它的信号）`
        : `工具 "${name}" 不存在`,
      `本次调用完全没有发生。` +
      (isRegistered
        ? `\n如果确实需要这个能力，请先说明你要做什么（例如「帮我看看明天的日程」），` +
          `或改用下面已提供的工具完成。`
        : `\n请只使用下面列出的工具名，不要自创工具名。`) +
      `\n\n本轮实际可用的工具（共 ${cfg.availableTools.length} 个）：\n${cfg.availableTools.join(', ')}`,
    )
  }

  // 工具不存在 → 显式失败，避免 LLM 把「换一个工具」的引导语当成执行结果
  if (!toolImplementations.has(name)) {
    // 🔧 2026-10-07：原来的提示只列了 3 个搜索工具，无论模型调的是什么都是这一句，
    //   对「模型想要一个日历工具」这种请求毫无帮助。现在如实说明 + 列出可用工具。
    //   （「已注册但本轮未暴露」的情况在上面的 🚧 分支已处理，这里只剩真·不存在。）
    const avail = cfg.availableTools
    const availHint = avail && avail.length > 0
      ? `\n\n本轮实际可用的工具（共 ${avail.length} 个）：\n${avail.join(', ')}`
      : '\n\n请只使用已提供的工具名，不要自创工具名。'
    return buildNotExecutedResult(
      `工具 "${name}" 不存在`,
      `本次调用完全没有发生。请只使用已提供的工具，不要自创工具名。${availHint}`,
    )
  }

  // 安全检查 — 集成 SecurityGuard 对危险操作进行检测和拦截
  const toolDef = toolDefinitions.get(name)
  if (toolDef?.dangerous) {
    try {
      const guard = getSecurityGuard()
      const guardResult = guard.checkToolCall({ id: '', type: 'function', function: { name, arguments: JSON.stringify(args) } })
      if (!guardResult.allowed) {
        const reasons = guardResult.findings.map(f => `  [${f.severity}] ${f.title}: ${f.description}`).join('\n')
        console.warn(`[SecurityGuard] ⛔ 拦截危险操作 "${name}":\n${reasons}`)
        return buildNotExecutedResult(
          `操作被安全策略拦截（${name}）`,
          `拦截原因:\n${reasons}\n\n请调整操作参数后重试。`,
        )
      }
      if (guardResult.requiresApproval) {
        const reasons = guardResult.findings.map(f => `  [${f.severity}] ${f.title}`).join('\n')
        return buildNotExecutedResult(
          `该操作需要用户批准（${name}），未获批准故未执行`,
          `触发项:\n${reasons}\n\n请简化为更安全的操作，或请用户手动执行。`,
        )
      }
    } catch (err) {
      // 安全检查失败不阻断工具执行（防御性编程）
      console.warn('[SecurityGuard] 安全检查异常，放行:', err)
    }
  }

  // 工具特定的超时
  const netTools = ['web_search', 'browser', 'mcp_call_tool', 'mcp_connect', 'mcp_list_tools']
  const shellTools = ['shell_exec']
  const ocrTools = ['ocr', 'desktop_click', 'desktop_type']
  const fileSearchTools = ['file_search', 'file_read', 'grep_search', 'glob_search', 'read_file']

  let timeoutMs = cfg.timeoutMs
  if (netTools.includes(name)) {timeoutMs = cfg.toolTimeouts?.[name] || 15000}
  else if (shellTools.includes(name)) {timeoutMs = cfg.toolTimeouts?.[name] || 120000}   // 🔧 120s
  else if (ocrTools.includes(name)) {timeoutMs = cfg.toolTimeouts?.[name] || 20000}
  else if (fileSearchTools.includes(name)) {timeoutMs = cfg.toolTimeouts?.[name] || 120000}  // 🔧 v3.8.1: 大项目搜索需更长时间

  // v3.34: 工具自带的 timeoutMs 优先级最高（写在 ToolDef 上，跟着工具走）。
  //   起因：phase_gate_delegate 跑完整五阶段编排（每阶段都可能 LLM 调用 60s+），
  //   走默认 60s 必然超时。而「超时」不等于「停止」—— Promise.race 只是不等了，
  //   底层 promise 并没被取消，重试会叠加出一串仍在后台跑的任务。
  const selfTimeout = toolDefinitions.get(name)?.timeoutMs
  if (typeof selfTimeout === 'number' && selfTimeout > 0) {timeoutMs = selfTimeout}

  let lastError: string | undefined
  let lastResult: ToolResult | undefined

  // ── 不可重试的网络错误（网络不可达，重试无意义） ──
  const NETWORK_FATAL_ERRORS = ['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED']

  // 🔧 P0-4：本次调用到底允不允许重发。
  //   effectiveMaxRetries 而不是直接用 cfg.maxRetries —— 副作用工具强制降到 0。
  const { retryable, reason: retrySkipReason } = isRetryableTool(name)
  const effectiveMaxRetries = retryable ? cfg.maxRetries : 0
  if (!retryable) {
    console.warn(`[registry] ⚠️ 工具 "${name}" 禁用自动重试：${retrySkipReason}`)
  }

  for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
    try {
      // 带超时的 Promise.race
      // ⚠️ Promise.race 不会取消输掉的分支 —— 这正是下面禁用副作用重试的原因：
      //    超时后底层调用仍在跑，重试等于再跑一次。
      const result = await Promise.race([
        executeTool(name, args),
        new Promise<ToolResult>((_, reject) =>
          setTimeout(() => reject(new Error(`工具 "${name}" 执行超时 (${timeoutMs}ms)`)), timeoutMs)
        ),
      ])

      if (result.ok) {return result} // 成功，直接返回

      // 工具返回了错误但没抛异常
      lastError = result.error
      lastResult = result
    } catch (err: any) {
      lastError = err.message || String(err)
    }

    // 网络级致命错误 → 不重试，直接返回清晰错误
    const isFatalNetwork = NETWORK_FATAL_ERRORS.some(code =>
      lastError && lastError.includes(code)
    )
    if (isFatalNetwork) {
      return {
        callId: '',
        ok: false,
        content: '',
        error: `网络不可达: ${lastError}。请检查 VLM/LLM API 地址是否正确、网络是否连通。当前目标: ${process.env.LUMINA_VLM_BASE_URL || process.env.LLM_BASE_URL || '未配置'}`,
      }
    }

    // 🔧 P0-4：超时且工具可能有副作用 → 不得重发。
    //   「超时」不等于「没执行」——最危险的情况就是它已经发出去 / 写下去了，
    //   只是我们没等到响应。此时重发就是制造重复。
    const wasTimeout = !!lastError && lastError.includes('执行超时')
    if (wasTimeout && !retryable) {
      console.warn(`[registry] 🛑 工具 "${name}" 超时且可能有副作用，拒绝重发（${retrySkipReason}）`)
      return {
        callId: '',
        ok: false,
        content:
          `工具「${name}」执行超过 ${Math.round(timeoutMs / 1000)}s，已停止等待。\n`
          + '⚠️ 重要：这类操作可能【已经生效】（例如邮件已发出、文件已写入、命令已执行），'
          + '只是没有收到响应。为了避免重复执行，系统没有自动重试。\n'
          + '请先人工确认实际结果，再决定是否需要重新执行。',
        error: `工具「${name}」超时，执行结果未知（未自动重试以避免重复操作）。${lastError}`,
      }
    }

    if (attempt < effectiveMaxRetries) {
      const delay = cfg.backoff === 'exponential'
        ? cfg.retryDelayMs * Math.pow(2, attempt)
        : cfg.retryDelayMs
      console.log(`[registry] 工具 "${name}" 第 ${attempt + 1}/${effectiveMaxRetries} 次重试 (${delay}ms 后)... 错误: ${lastError}`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  // 所有重试均失败
  if (lastResult) {return lastResult}
  return { callId: '', ok: false, content: '', error: lastError || '未知错误' }
}

// ═══════════════════════════════════════════════════════════
// v2.4: 工具并行执行
// ═══════════════════════════════════════════════════════════

/**
 * 工具依赖分类:
 *   file_write 可能依赖 file_read 的结果
 *   file_edit 依赖 file_read 确认内容
 *   shell_exec(cd) 可能影响后续 shell_exec
 *   memory_save 通常独立
 *
 * 简化规则: 同类型工具且不是写操作 → 可并行
 */
export function areToolsIndependent(tool1: string, tool2: string): boolean {
  // 写操作不能和其他同类型操作并行
  const writeOps = ['file_write', 'file_edit', 'shell_exec', 'git_commit', 'memory_save']
  const readOnlyOps = ['file_read', 'file_list', 'web_search', 'datetime', 'memory_get', 'memory_all',
    'system_info', 'git_status', 'git_log', 'git_diff', 'clipboard_get', 'screenshot',
    'mcp_list_servers', 'mcp_list_tools']

  // 两个都是读操作 → 可并行
  if (readOnlyOps.includes(tool1) && readOnlyOps.includes(tool2)) {return true}

  // 任何一个涉及写操作 → 不能与其他并行（保守策略）
  if (writeOps.includes(tool1) || writeOps.includes(tool2)) {return false}

  // 不同类别的操作默认可并行
  const categories: Record<string, string> = {
    file_read: 'file', file_write: 'file', file_edit: 'file', file_list: 'file',
    web_search: 'web', browser: 'web',
    memory_save: 'memory', memory_get: 'memory', memory_all: 'memory', memory_summarize: 'memory',
    todo: 'tasks', cron_schedule: 'tasks', cron_list: 'tasks',
    datetime: 'system', screenshot: 'system', clipboard_get: 'system', clipboard_set: 'system',
    system_info: 'system', notification: 'system', open_file: 'system',
    ocr: 'desktop', desktop_click: 'desktop', desktop_type: 'desktop', desktop_key: 'desktop',
    oath_make: 'oath', oath_list: 'oath', oath_fulfill: 'oath',
    git_status: 'git', git_commit: 'git', git_log: 'git', git_diff: 'git',
    shell_exec: 'shell',
    mcp_connect: 'mcp', mcp_list_servers: 'mcp', mcp_list_tools: 'mcp', mcp_call_tool: 'mcp',
  }

  const cat1 = categories[tool1] || tool1
  const cat2 = categories[tool2] || tool2

  // 同类别不能并行（可能有隐藏依赖）
  if (cat1 === cat2) {return false}

  return true
}

/**
 * 将工具调用分组为可并行执行的批次
 */
export function groupParallelBatches(toolCalls: LLMToolCall[]): LLMToolCall[][] {
  if (toolCalls.length <= 1) {return [toolCalls]}

  const batches: LLMToolCall[][] = []
  const remaining = [...toolCalls]

  while (remaining.length > 0) {
    const batch: LLMToolCall[] = [remaining.shift()!]
    const stillRemaining: LLMToolCall[] = []

    for (const call of remaining) {
      // 检查是否与批次中所有工具都独立
      const independent = batch.every((b) =>
        areToolsIndependent(b.function.name, call.function.name)
      )
      if (independent) {
        batch.push(call)
      } else {
        stillRemaining.push(call)
      }
    }

    batches.push(batch)
    remaining.length = 0
    remaining.push(...stillRemaining)
  }

  return batches
}

/**
 * 并行执行一批工具调用
 */
export async function executeToolsParallel(
  toolCalls: LLMToolCall[],
  retryConfig?: RetryConfig
): Promise<Array<{ call: LLMToolCall; result: ToolResult }>> {
  if (toolCalls.length === 0) {return []}

  // 串行执行的情况
  if (toolCalls.length === 1) {
    const call = toolCalls[0]
    let args: Record<string, any> = {}
    try {
      args = JSON.parse(call.function.arguments || '{}')
    } catch {
      // 🔧 P0 修复（假成功）
      // 旧实现：解析失败就用空对象继续执行，工具会「正常跑完」并返回 ok:true，
      // 违反本文件自己写的铁律：「没做成」必须显式失败 ok:false，
      // 否则模型会把空参数执行当成真实结果继续推理（编造就是这么来的）。
      //
      // securityGuard 已在执行前拦截这类调用并要求审批，
      // 但用户在审批时点「同意」是合理选择——那时应明确告诉模型
      // 「参数有问题，没执行」，而不是悄悄跑个空参数版。
      const result = buildNotExecutedResult(
        `工具 "${call.function.name}" 的参数不是合法 JSON，未执行。`,
        '模型输出格式异常，请让它重新生成参数后重试。',
      )
      return [{ call, result }]
    }
    const result = await executeToolWithRetry(call.function.name, args, retryConfig)
    return [{ call, result }]
  }

  // 分组并行执行
  const batches = groupParallelBatches(toolCalls)
  const allResults: Array<{ call: LLMToolCall; result: ToolResult }> = []

  for (const batch of batches) {
    if (batch.length === 1) {
      // 单工具批次: 直接用 executeToolWithRetry
      const call = batch[0]
      let args: Record<string, any> = {}
        try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        // 🔧 P0 修复（假成功）
        // 旧实现：解析失败就用空对象继续执行，工具会「正常跑完」并返回 ok:true，
        // 违反本文件自己写的铁律：「没做成」必须显式失败 ok:false，
        // 否则模型会把空参数执行当成真实结果继续推理（编造就是这么来的）。
        //
        // securityGuard 已在执行前拦截这类调用并要求审批，
        // 但用户在审批时点「同意」是合理选择——那时应明确告诉模型
        // 「参数有问题，没执行」，而不是悄悄跑个空参数版。
        const result = buildNotExecutedResult(
          `工具 "${call.function.name}" 的参数不是合法 JSON，未执行。`,
          '模型输出格式异常，请让它重新生成参数后重试。',
        )
        return [{ call, result }]
      }
      const result = await executeToolWithRetry(call.function.name, args, retryConfig)
      allResults.push({ call, result })
    } else {
      // 多工具批次: 并行执行
      const promises = batch.map(async (call) => {
        let args: Record<string, any> = {}
            try {
          args = JSON.parse(call.function.arguments || '{}')
        } catch {
          // 🔧 P0 修复（假成功）
          // 旧实现：解析失败就用空对象继续执行，工具会「正常跑完」并返回 ok:true，
          // 违反本文件自己写的铁律：「没做成」必须显式失败 ok:false，
          // 否则模型会把空参数执行当成真实结果继续推理（编造就是这么来的）。
          //
          // securityGuard 已在执行前拦截这类调用并要求审批，
          // 但用户在审批时点「同意」是合理选择——那时应明确告诉模型
          // 「参数有问题，没执行」，而不是悄悄跑个空参数版。
          const result = buildNotExecutedResult(
            `工具 "${call.function.name}" 的参数不是合法 JSON，未执行。`,
            '模型输出格式异常，请让它重新生成参数后重试。',
          )
          return { call, result }
        }
        const result = await executeToolWithRetry(call.function.name, args, retryConfig)
        return { call, result }
      })

      const results = await Promise.allSettled(promises)
      for (const r of results) {
        if (r.status === 'fulfilled') {
          allResults.push(r.value)
        } else {
          // Promise rejected (不应该发生，因为 executeToolWithRetry 内部捕获了)
          console.error('[registry] 并行工具执行异常:', r.reason)
        }
      }
    }
  }

  return allResults
}

// ═══════════════════════════════════════════════════════════
// v2.4: 依赖检测 (供 AgentRunner 使用)
// ═══════════════════════════════════════════════════════════

/**
 * 检测工具调用之间的依赖关系
 * 返回依赖图: { toolCallId → 依赖的 toolCallId 列表 }
 */
export function detectToolDependencies(toolCalls: LLMToolCall[]): Map<string, string[]> {
  const deps = new Map<string, string[]>()

  // 简化依赖检测:
  // - file_write/ file_edit 可能依赖同轮的 file_read
  // - shell_exec 如果有路径参数，可能依赖前面的 file_list
  // 此处做保守检测

  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i]
    const depsList: string[] = []

    // file_write 依赖同文件名的 file_read
    if (call.function.name === 'file_write' || call.function.name === 'file_edit') {
      for (let j = 0; j < i; j++) {
        const prev = toolCalls[j]
        if (prev.function.name === 'file_read' || prev.function.name === 'file_list') {
          // 如果参数中有相同路径引用，标记依赖
          const prevArgs = prev.function.arguments || ''
          const currArgs = call.function.arguments || ''
          // 粗略检测: 如果参数重叠
          if (prevArgs.length > 0 && currArgs.length > 0) {
            depsList.push(prev.id)
          }
        }
      }
    }

    deps.set(call.id, depsList)
  }

  return deps
}

// ═══════════════════════════════════════════════════════════
// 生成 OpenAI function calling Schema
// ═══════════════════════════════════════════════════════════

export function toOpenAIFunction(def: ToolDef | undefined): any {
  // 防御性检查 — getToolDef 可能返回 undefined（TOOLSETS 引用未注册工具名）
  if (!def) {return null}

  const properties: Record<string, any> = {}
  const required: string[] = []

  // 🔧 2026-10-07 修复：本函数原先**只**读 `def.params`，完全忽略 `def.parameters`。
  //   而 `ToolDef` 同时定义了这两个字段（见 types.ts），`parameters` 的注释就是
  //   「JSON Schema 格式」。于是凡是用 `parameters` 声明的工具（ask_decision、
  //   voice_* 共 5 个），暴露给模型时参数是**空的** —— 模型看得到一个
  //   `ask_decision` 却不知道要传 question，只能瞎调或干脆不用。
  //   实测日志里那行「工具 "ask_decision" 缺少 params 字段，跳过」就是它。
  //   现在：`params` 优先（旧的简写格式），缺失时回退到 `parameters` 原样透传。
  if (!def.params || typeof def.params !== 'object') {
    const jsonSchema = (def as any).parameters
    if (jsonSchema && typeof jsonSchema === 'object') {
      return {
        type: 'function',
        function: {
          name: def.name,
          description: def.description,
          parameters: {
            type: 'object',
            properties: jsonSchema.properties || {},
            required: jsonSchema.required,
          },
        },
      }
    }
    // 两个字段都没有 —— 保留原来的兜底（空参数 schema），但不再谎称「跳过」：
    // 它确实被暴露了，只是没有参数。措辞改成「无可声明参数」以免误导排查。
    console.warn(`[registry] 工具 "${def.name}" 既无 params 也无 parameters，按无参工具暴露`)
    return {
      type: 'function',
      function: {
        name: def.name,
        description: def.description,
        parameters: { type: 'object', properties: {}, required: [] },
      },
    }
  }

  for (const [key, param] of Object.entries(def.params)) {
    properties[key] = {
      type: param.type,
      description: param.description,
    }
    if (param.enum) {properties[key].enum = param.enum}
    if (param.required) {required.push(key)}
  }

  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined,
      },
    },
  }
}

/** 批量生成 OpenAI functions */
export function toOpenAIFunctions(defs?: (ToolDef | undefined)[]): any[] {
  // 🔧 P0-fix: 支持无参调用（agent-core base-layer 需要）
  if (!defs) {
    const allDefs = Array.from(toolDefinitions.values())
    return allDefs.map(toOpenAIFunction).filter(Boolean)
  }
  return defs.map(toOpenAIFunction).filter(Boolean)
}

// ═══════════════════════════════════════════════════════════
// 🔧 P0-fix: 工具注册表校验
// ═══════════════════════════════════════════════════════════

/**
 * 校验工具注册表 — 检查所有已注册工具是否都有定义和实现
 * 返回缺失的工具有序列表（空 = 全部健康）
 */
export function validateToolRegistry(): { ok: boolean; missingDefs: string[]; missingImpls: string[] } {
  const allNames = new Set([...toolDefinitions.keys(), ...toolImplementations.keys()])
  const missingDefs: string[] = []
  const missingImpls: string[] = []

  for (const name of allNames) {
    if (!toolDefinitions.has(name)) {
      missingDefs.push(name)
    }
    if (!toolImplementations.has(name)) {
      missingImpls.push(name)
    }
  }

  return {
    ok: missingDefs.length === 0 && missingImpls.length === 0,
    missingDefs,
    missingImpls,
  }
}
