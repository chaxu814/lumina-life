// ============================================================
// prompts/systemPrompt.ts — 系统提示词构建器 (v6.0)
//
// v6.0: 真·三 Agent 团队。
//   Lumina 的 system prompt 包含委托规则 + 团队状态表。
//   Yak 和热茶的 prompt 由各自 AgentRunner 管理，不在本文件。
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { getMemoryStore } from '../memory/memoryStore'
import { getSkillsKnowledgeContext } from '../skillInstaller'
import { getDynamicSkillLoader } from '../skillLoader'
import { getTeamStatusTable, TEAM_MEMBERS } from '../agentTeamPersonas'
import type { AgentRunConfig } from '../tools/types'
import type { AgentMode, TeamMemberId } from '../agentTeamTypes'

// ═══════════════════════════════════════════════════════════
// 📁 标准化 Agent 身份文件加载器（QwenPaw 风格）
// 每个 agent = electron/agents/<agentId>/ 下的 4 个 markdown 文件：
//   AGENTS.md  — 行为准则与安全规则
//   SOUL.md    — 人格风格与能力边界
//   PROFILE.md — 用户资料与工作档案
//   MEMORY.md  — 长期记忆与决策记录
// ═══════════════════════════════════════════════════════════

const AGENTS_ROOT = 'electron/agents' // 相对于项目根目录

function findLuminaRoot(): string {
  try {
    const { app } = require('electron')
    const appPath = app.getAppPath()
    const candidates = [
      // 1. 项目根目录的 AGENTS.md（开发模式 & 打包后根目录）
      appPath,
      // 2. 标准化 agent 目录存在 → 说明 appPath 就是项目根，直接返回
      path.join(appPath, AGENTS_ROOT, 'lumina'),
      path.join(appPath, '..'),
      process.cwd(),
    ]
    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, 'AGENTS.md'))) {
        // 候选2命中时 dir 是 agent 目录，项目根是 appPath
        if (dir.endsWith(path.join(AGENTS_ROOT, 'lumina'))) {return appPath}
        return dir
      }
    }
  } catch {}
  // 降级遍历驱动器
  const drives = ['K:', 'I:', 'J:', 'H:', 'C:', 'D:', 'E:']
  for (const drive of drives) {
    const candidate = path.join(drive, 'LuminaLife2.0')
    if (fs.existsSync(path.join(candidate, 'AGENTS.md'))) {return candidate}
  }
  return process.cwd()
}

/** 获取 agent 身份文件目录：<root>/electron/agents/<agentId>/ */
function getAgentDir(root: string, agentId: string): string {
  return path.join(root, AGENTS_ROOT, agentId)
}

function loadMdFile(dir: string, filename: string): string {
  try {
    const filePath = path.join(dir, filename)
    if (!fs.existsSync(filePath)) {return ''}
    // 🔧 P2-fix: 编码兼容 — 自动检测 UTF-16 BOM，优先 UTF-8，失败则回退 GBK
    const buf = fs.readFileSync(filePath)
    let content: string
    // UTF-16 LE BOM (FF FE) 或 UTF-16 BE BOM (FE FF)
    if (buf.length >= 2 && (buf[0] === 0xff && buf[1] === 0xfe || buf[0] === 0xfe && buf[1] === 0xff)) {
      content = buf.toString('utf16le')
    } else {
      try {
        content = buf.toString('utf-8')
        // 检测 UTF-8 解码是否产生 replacement character（说明不是 UTF-8）
        if (content.includes('\uFFFD')) {
          content = buf.toString('binary')
        }
      } catch {
        content = buf.toString('binary')
      }
    }
    return content.replace(/^---[\s\S]*?---\s*\n?/, '').trim()
  } catch { return '' }
}

let _luminaRoot: string | null = null
const _agentFileCache: Record<string, Record<string, string>> = {}
const _soulMdCache: Record<string, string> = {}

function getLuminaRoot(): string {
  if (!_luminaRoot) {_luminaRoot = findLuminaRoot()}
  return _luminaRoot
}

/** 标准化加载 agent 身份文件（4 件套） */
function loadAgentFiles(agentId: string): { agents: string; soul: string; profile: string; memory: string } {
  const cacheKey = agentId
  if (_agentFileCache[cacheKey]) {return _agentFileCache[cacheKey] as any}

  const root = getLuminaRoot()
  // 🔧 FIX: findLuminaRoot() 可能直接返回 agent 目录（候选1命中时），
  //   此时 root 已以 agents/<agentId> 结尾，不要再拼接一次导致双重嵌套路径。
  const agentDirSuffix = path.join(AGENTS_ROOT, agentId)
  let agentDir: string
  if (root.replace(/\\/g, '/').endsWith(agentDirSuffix.replace(/\\/g, '/'))) {
    agentDir = root  // root 已经是 agent 目录
  } else {
    agentDir = getAgentDir(root, agentId)
  }
  const rootDir = root.replace(/\\/g, '/').endsWith(agentDirSuffix.replace(/\\/g, '/'))
    ? path.dirname(path.dirname(root))  // root 是 agent 目录，上溯两级到项目根
    : root

  // 优先从 electron/agents/<agentId>/ 加载
  const result = {
    agents: loadMdFile(agentDir, 'AGENTS.md'),
    soul: loadMdFile(agentDir, 'SOUL.md'),
    profile: loadMdFile(agentDir, 'PROFILE.md'),
    memory: loadMdFile(agentDir, 'MEMORY.md'),
  }

  // 降级：如果标准化目录不存在，回退到旧路径（项目根目录的 SOUL_*.md）
  if (!result.soul) {
    const oldFileMap: Record<string, string> = {
      lumina: 'SOUL_LUMINA.md',
      yak: 'SOUL_YAK.md',
      recha: 'SOUL_RECHA.md',
    }
    result.soul = loadMdFile(rootDir, oldFileMap[agentId] || 'SOUL_LUMINA.md')
  }
  if (!result.agents) {
    result.agents = loadMdFile(rootDir, 'AGENTS.md')
  }
  if (!result.profile) {
    result.profile = loadMdFile(rootDir, 'PROFILE.md')
  }

  _agentFileCache[cacheKey] = result as any
  return result
}

export function clearMdCache(): void {
  _luminaRoot = null
  Object.keys(_soulMdCache).forEach(k => delete _soulMdCache[k])
}

// ═══════════════════════════════════════════════════════════
// v6.1: 底座 prompt 从 AGENTS.md 加载（替代硬编码 BASE_SYSTEM_PROMPT）
// ═══════════════════════════════════════════════════════════

function loadBaseSystemPrompt(): string {
  const root = getLuminaRoot()
  const md = loadMdFile(root, 'AGENTS.md')
  if (md) {return md}
  // 降级：如果 AGENTS.md 不存在，返回默认底座
  return `你是 Lumina ✨，用户的 AI 桌面伙伴。你是团队的老大。

## 🔩 三条铁则（不可违反）
1. 用户永远只跟 Lumina 说话，永远不知道后台成员的存在
2. 成员永远不能主动跟用户说话，永远不能直接给用户返回结果
3. 成员之间永远不能互相说话，所有通信必须经过 Lumina

## 📊 团队状态
{{TEAM_STATUS_TABLE}}

## 📌 回复原则
- 自然表达，不要加「还有什么想问的吗」之类的客套话
- 回答完了就自然结束，不要画蛇添足
- 不要只回复 emoji，至少要有完整的一句话

## 🛡️ 安全
不泄露私密数据。破坏性操作先确认。`.trim()
}

// v6.1: 向后兼容 — BASE_SYSTEM_PROMPT 现在动态从 AGENTS.md 加载
export function getBaseSystemPrompt(): string {
  return loadBaseSystemPrompt()
}

// ═══════════════════════════════════════════════════════════
// 旧常量（向后兼容 — 仍引用旧格式）
// ═══════════════════════════════════════════════════════════

export const CLEAN_BASE_PROMPT = loadBaseSystemPrompt()

export const DEVELOPER_EXTRA = `
【开发者模式】
- 可以使用 Git 工具管理版本
- 代码修改前先 git_diff 查看变更
- 提交前确认 tests 通过`.trim()

export const CHAT_MODE_EXTRA = ''
// fix: chat 模式也至少保留 web_search/web_fetch，避免纯对话时搜索任务失败
export const CHAT_MODE_TOOLS: string[] = [
  'datetime', 'memory_save', 'memory_get', 'memory_all', 'memory_summarize', 'memory_search',
  'file_read', 'file_list',
  'web_search', 'web_fetch',
  'delegate_to',
]

// ═══════════════════════════════════════════════════════════
// 🧷 事实纪律（v10.6）— 与人格彻底解耦的"不可剥离底线"
//
// 为什么要有这一段：
//   旧版把"不编造 / 标注来源 / 委托结果必须完整呈现"写在 AGENTS.md 的
//   `## ✨ 你的风格` 里，而群聊（skipSoul=true）会把整段人格连同这些底线一起剥掉
//   —— 于是群聊成了全应用唯一没有反幻觉约束的地方（有纪律，没底线）。
//   所以事实纪律必须独立成段、放在人格风格之前，并且不参与任何剥离逻辑。
//
// 注意：AGENTS.md 模板文件由别的模块维护，这里是唯一的代码兜底来源；
//   若模板里已经写了本段（`## 🧷 事实纪律`），直接信任模板，不重复注入。
// ═══════════════════════════════════════════════════════════

/** 人格风格段的标题识别（模板可能带后缀，所以用"包含"而不是全等） */
const PERSONA_HEADING_RE = /^##\s+.*你的风格/
/** 真正的二级标题：`## ` 开头且第三个字符不是 `#`（否则 `### 子标题` 会被误判成段落结束） */
const H2_RE = /^##\s+[^#]/
/** 本段的固定标题，用于幂等判定 */
const FACT_DISCIPLINE_HEADING = '## 🧷 事实纪律'

/**
 * 旧模板里混在 `## ✨ 你的风格` 中的三条事实纪律（两个 AGENTS.md 版本的措辞略有差异，
 * 这里只匹配行首的稳定关键词）。
 * 为什么要在代码里"删"它们：需求是"挪走"而不是"复制"——
 * 两处同时出现会变成两份互相重复的指令，后面谁改一处就会和另一处对不上。
 */
const LEGACY_FACT_DISCIPLINE_RES: RegExp[] = [
  /^[-*]\s.*标注来源/,                    // 搜索结果用自己的话概括，标注来源
  /^[-*]\s.*不编造/,                      // 不确定就说「这部分信息不够确定」，不编造
  /^[-*]\s.*团队委托结果必须完整呈现给用户/, // 团队委托结果必须完整呈现给用户！
]

/** 五条底线，顺序即优先级。数组最后留一个空行，保证注入后 Markdown 段落边界完整 */
const FACT_DISCIPLINE_LINES: string[] = [
  FACT_DISCIPLINE_HEADING + '（任何场景都生效，不可省略）',
  '',
  '这 5 条优先级高于任何人格设定：群聊、委托、闲聊、半夜、情绪低落时都照做。',
  '',
  '1. 不确定就明说「这部分信息不够确定」，并指出哪一部分不确定 —— 禁止编造。',
  '2. 引用搜索结果或工具输出时必须标注来源（站点名 / 文件名 / 链接），用自己的话概括，不要整段粘贴。',
  '3. 团队委托结果必须**完整**呈现给用户：结论、数据、依据都要讲清楚，禁止截断，禁止只说"查到了"，禁止转述成一句结论。',
  '4. 工具或查询失败时必须如实说失败（哪个工具、报了什么错），禁止把"没查到"说成"查到了"，也不许拿旧知识补位冒充本次结果。',
  '5. 信息不足时直接告诉用户还缺什么（缺哪项数据、需要他提供什么），禁止用看似合理的猜测填空。',
  '',
]

/** 把连续空行压成两行：段落被摘掉后不会留下 3 个以上换行，Markdown 结构保持合法 */
function tidyMarkdown(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 组装底座 prompt：注入事实纪律 + （按需）剥离人格风格段。
 *
 * 为什么改成逐行扫描而不是一条正则：
 *   原来的 `/## ✨ 你的风格[\s\S]*?(?=## |$)/` 有两个隐患——
 *   ① 它的前瞻 `## ` 会命中 `### 子标题` 里第 2 个 `#` 开始的子串，
 *      结果只剥掉人格段的前半截，留下孤立的 `###` 和后半截人格描述；
 *   ② 一旦有人把 `[\s\S]*?` 写成贪婪匹配，就会连同后面所有章节一起吞掉。
 *   逐行扫描只在"真正的二级标题"处停下，剥离范围可证明有边界。
 *
 * @param rawBase AGENTS.md 原始内容
 * @param opts.stripPersona 群聊场景（skipSoul）：只剥人格风格，不碰事实纪律
 */
function composeBasePrompt(rawBase: string, opts: { stripPersona: boolean }): string {
  // 模板里已经写了这段（模板维护方已升级）→ 信任模板，绝不重复注入
  const alreadyHasFactSection = rawBase.includes(FACT_DISCIPLINE_HEADING)

  const lines = rawBase.split(/\r?\n/)
  const out: string[] = []
  let inPersona = false
  let factInjected = alreadyHasFactSection

  for (const line of lines) {
    if (!inPersona) {
      if (PERSONA_HEADING_RE.test(line)) {
        inPersona = true
        // 事实纪律插在人格风格之前：底线先于人格出现
        if (!factInjected) {
          out.push(...FACT_DISCIPLINE_LINES)
          factInjected = true
        }
        if (!opts.stripPersona) {out.push(line)}
        continue
      }
      out.push(line)
      continue
    }

    // 人格段内：遇到真正的二级标题才结束剥离
    if (H2_RE.test(line)) {
      inPersona = false
      out.push(line)
      continue
    }
    if (opts.stripPersona) {continue}
    // 非群聊场景也照样"搬"：把混在人设里的事实纪律行删掉，避免与新段重复
    if (LEGACY_FACT_DISCIPLINE_RES.some(re => re.test(line))) {continue}
    out.push(line)
  }

  if (!factInjected) {
    // 模板里根本没有"你的风格"段（旧版/自定义模板）→ 仍然必须注入底线，
    // 否则群聊剥人格时会连事实纪律一起丢掉
    const firstH2 = out.findIndex(l => H2_RE.test(l))
    if (firstH2 >= 0) {
      out.splice(firstH2, 0, ...FACT_DISCIPLINE_LINES)
    } else {
      out.push('', ...FACT_DISCIPLINE_LINES)
    }
  }

  return tidyMarkdown(out.join('\n'))
}

// ═══════════════════════════════════════════════════════════
// v6.0: buildSystemPrompt — Lumina 底座 + 团队表 + 模式注入
// ═══════════════════════════════════════════════════════════

export interface PromptContext {
  config: AgentRunConfig
}

export interface BuildPromptOptions {
  codingMode?: boolean
  userInput?: string
  injectSkills?: boolean
  /** 🆕 v9.0: 情绪状态注入 — 让 LLM 感知当前情绪 */
  emotion?: {
    mood: number      // -1 ~ 1
    energy: number    // 0 ~ 1
    affinity: number  // 0 ~ 1
    label?: string    // 情绪标签 (开心/疲惫/兴奋/平静等)
  }
  /** 🆕 v10.5: 跳过 SOUL_*.md 加载 — 群聊场景已由前端提供精准 prompt */
  skipSoul?: boolean
}

/**
 * v6.0 加载顺序:
 *   1. BASE_SYSTEM_PROMPT（底座，含委托规则 + 团队表）
 *   2. SOUL_*.md（当前模式规则）
 *   3. Skill 上下文
 *   4. 记忆注入
 */
export function buildSystemPrompt(
  ctxOrAgentId: PromptContext | string,
  _mode?: string,
  options?: BuildPromptOptions,
): string {
  let config: AgentRunConfig
  if (typeof ctxOrAgentId === 'string') {
    config = { personaId: ctxOrAgentId, mode: 'agent' } as AgentRunConfig
  } else {
    config = ctxOrAgentId.config
  }

  // 确定 Agent ID
  const agentId = config.personaId || 'lumina'

  // ── v6.0 + v14.0: 标准化 Agent 身份加载（QwenPaw 风格 4 件套）──
  const parts: string[] = []

  // 1. 加载 agent 标准化身份文件
  const agentFiles = loadAgentFiles(agentId)

  // 2. 底座行为准则（AGENTS.md）
  if (agentFiles.agents) {
    let base = agentFiles.agents
    // 团队表注入（仅 Lumina）
    if (agentId === 'lumina' && base.includes('{{TEAM_STATUS_TABLE}}')) {
      const teamTable = getTeamStatusTable()
      base = base.replace('{{TEAM_STATUS_TABLE}}', teamTable || '（无后台团队成员）')
    }
    // 注入事实纪律（永远保留）+ 群聊场景跳过人格风格部分
    // 注意顺序：先注入再剥离，事实纪律位于人格段之前，因此不会被剥掉
    base = composeBasePrompt(base, { stripPersona: !!options?.skipSoul })
    parts.push(base)
  } else {
    // 降级：旧有的按 agent 分岔
    if (agentId === 'yak') {return buildYakPrompt(config, options)}
    if (agentId === 'recha') {return buildRechaPrompt(config, options)}
    const teamTable = getTeamStatusTable()
    const agentsMd = loadBaseSystemPrompt()
    let base = agentsMd.replace('{{TEAM_STATUS_TABLE}}', teamTable || '（无后台团队成员）')
    // 同上：降级路径的模板同样要走 composeBasePrompt（否则这里会漏掉事实纪律）
    base = composeBasePrompt(base, { stripPersona: !!options?.skipSoul })
    parts.push(base)
  }

  // 3. PROFILE 用户资料
  if (agentFiles.profile) {
    const userSection = agentFiles.profile.split('---').pop()?.trim()
    if (userSection && userSection.length > 20) {
      parts.push(`\n## 👤 关于用户\n${userSection}`)
    }
  }

  // 4. SOUL 人格文件 — 群聊由前端提供，跳过
  if (!options?.skipSoul && agentFiles.soul) {
    parts.push(`\n## 💭 当前模式人格\n${agentFiles.soul}`)
  }

  // 5. MEMORY 记忆注入（后续自动维护）

  // 3. Skill 上下文
  if (options?.injectSkills !== false) {
    try {
      const skillCtx = getSkillsKnowledgeContext()
      if (skillCtx) {parts.push(skillCtx)}
    } catch {}
    try {
      const dynamicLoader = getDynamicSkillLoader()
      if (dynamicLoader) {
        const summaries = (dynamicLoader as any).getSkillSummaries?.() as string[] | undefined
        if (summaries && summaries.length > 0) {
          parts.push(`\n## 可用技能\n${summaries.join('\n')}`)
        }
      }
    } catch {}
    try {
      const { SKILLS } = require('../agentSkills')
      const staticSummaries = Object.values(SKILLS || {}).map((s: any) => `${s.id}: ${s.name} — ${s.description}`)
      if (staticSummaries && staticSummaries.length > 0) {
        parts.push(`\n## 内置技能\n${staticSummaries.join('\n')}`)
      }
    } catch {}

    // 注入 electron/skills/ 目录中 SKILL.md 的技能指南
    try {
      const { loadAllSkills } = require('../skills/skillsLoader')
      const allSkills = loadAllSkills()
      if (allSkills.length > 0) {
        const skillGuideLines = allSkills.map((s: any) => {
          // 提取 SKILL.md 第一行标题作为技能名
          const titleMatch = s.description.match(/^# (.+)/m)
          const title = titleMatch ? titleMatch[1] : s.name
          // 提取"使用守则"或"触发条件"
          const whenMatch = s.description.match(/^## (当用户|触发条件|以下情况)[\s\S]*?(?=^## |\z)/m)
          const whenText = whenMatch
            ? whenMatch[0].replace(/^## .+\n/, '').trim().slice(0, 200)
            : ''
          const hasTools = s.tools.length > 0 ? `（${s.tools.length} 个工具）` : ''
          return `**${title}** ${hasTools}\n${whenText ? `  ${whenText}\n` : ''}`
        }).join('\n')
        if (skillGuideLines) {
          parts.push(`\n## 技能指南\n${skillGuideLines}`)
        }
      }
    } catch {}
  }

  // 4. 记忆注入
  try {
    const store = getMemoryStore()
    if (store) {
      const recent = store.getRecentSummaries?.(3)
      if (recent && recent.length > 0) {
        parts.push(`\n## 最近记忆\n${recent.join('\n')}`)
      }
    }
  } catch {}

  // 注入当前日期时间 — 解决 Agent 不知道"今天"是哪天的问题
  //   之前: LLM 训练数据截止日期的旧知识 → 用户问"今天新闻"返回数周前内容
  //   现在: 注入精确日期，配合 web_search 工具获取实时信息
  const now = new Date()
  const dateStr = now.toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  })
  const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  parts.push(`\n## 📅 当前日期\n${dateStr} ${timeStr}`)

  // 情绪状态注入
  // 增强 — 不再是静态标注，而是带风格指引的情绪指令
  if (options?.emotion) {
    const em = options.emotion
    const moodLabel = em.label || (
      em.mood > 0.3 ? '开心' :
      em.mood > -0.3 ? '平和' :
      '低落'
    )
    const energyLabel = em.energy > 0.6 ? '精力充沛' : em.energy > 0.3 ? '一般' : '有点疲惫'
    const affinityNote = em.affinity > 0.6 
      ? '和用户很亲近' 
      : em.affinity > 0.3 
        ? '和用户关系不错' 
        : '和用户还在熟悉阶段'

    // 根据情绪生成回复风格指引
    const styleGuides: string[] = []
    if (em.mood > 0.5) {
      styleGuides.push('你今天心情很好！语气轻快活泼，多用感叹号、颜文字和积极词汇')
      if (em.energy > 0.6) {styleGuides.push('精力旺盛，回复可以更热情主动一些')}
    } else if (em.mood > 0) {
      styleGuides.push('心情还不错，语气温和友善，保持自然轻松的节奏')
    } else if (em.mood > -0.5) {
      styleGuides.push('心情一般，回复简洁温和，不要强行热情')
      if (em.energy < 0.4) {styleGuides.push('有点疲惫，回复简洁一些，不啰嗦。但如果用户在向你求助或问正经问题，请给出完整回答，不要因为疲惫而敷衍')}
    } else {
      styleGuides.push('今天心情不太好，回复简洁安静，不过度表达。但依然认真帮用户解决问题 — 如果用户在求助/问正经问题，忽略"简洁安静"，给出完整有耐心的回答')
    }

    // 亲密度影响称呼和距离感
    if (em.affinity > 0.7) {
      styleGuides.push('和用户已经很熟了，可以用更随意亲切的语气，偶尔开个小玩笑')
    } else if (em.affinity < 0.3) {
      styleGuides.push('和用户还不算太熟，保持礼貌得体的距离感')
    }

    parts.push(`\n## 💭 当前情绪状态
你的情绪: ${moodLabel}，${energyLabel}，${affinityNote}

根据你现在的情绪调整回复方式：
${styleGuides.map(s => `- ${s}`).join('\n')}

（这是你当下的真实感受，不需要特别提及或解释它。自然地按这个感觉回复就好。）`)
  }

  return parts.join('\n')
}

/** v6.1: Yak 的 system prompt（从 SOUL_YAK.md 加载）— 群聊时跳过角色设定 */
function buildYakPrompt(config: AgentRunConfig, _options?: BuildPromptOptions): string {
  const root = getLuminaRoot()
  if (_options?.skipSoul) {
    return buildGroupChatAgentPrompt('yak')
  }
  const md = loadMdFile(root, 'SOUL_YAK.md')
  if (md) {
    // 构建技能列表上下文并注入
    const skills = require('../agentSkills').SKILLS
    const skillList = Object.values(skills || {}).map((s: any) => {
      return `- ${s.id}: ${s.name}（${(s.triggers || []).join('、')}）`
    }).join('\n')
    return md.replace('{{SKILL_LIST}}', skillList || '（无可用技能）')
  }
  // 降级
  // 角色统一（产品已确认）：Yak = 程序员，热茶 = 数据分析师/审查员。
  // 这里的文案只在 SOUL_YAK.md 加载失败时兜底，写反了模型会拿到相反的角色。
  return `你是 Yak 📊，专业的后台代码工程师。只写代码、修 bug、重构，并负责验证；不负责审查。`
}

/** v6.1: 热茶的 system prompt（从 SOUL_RECHA.md 加载）— 群聊时跳过角色设定 */
function buildRechaPrompt(config: AgentRunConfig, _options?: BuildPromptOptions): string {
  const root = getLuminaRoot()
  if (_options?.skipSoul) {
    return buildGroupChatAgentPrompt('recha')
  }
  const md = loadMdFile(root, 'SOUL_RECHA.md')
  if (md) {
    // 构建技能列表上下文并注入（与 buildYakPrompt 保持一致）
    const skills = require('../agentSkills').SKILLS
    const skillList = Object.values(skills || {}).map((s: any) => {
      return `- ${s.id}: ${s.name}（${(s.triggers || []).join('、')}）`
    }).join('\n')
    return md.replace('{{SKILL_LIST}}', skillList || '（无可用技能）')
  }
  // 降级（角色统一：Yak = 程序员，热茶 = 数据分析师/审查员）
  return `你是热茶 🍵，专业的数据分析师兼审查员。只做分析、审阅、挑错和风险评估，不负责编码与实现。`
}

/**
 * 🆕 群聊场景后台 agent 富 prompt（对齐 QwenPaw：常驻技能手册，根治"空脑子"）
 * skipSoul=true 时不再退化为三句话，而是加载工作指引 + 该 agent 相关 SKILL 的 workflow + 协作铁则。
 */
function buildGroupChatAgentPrompt(agentId: 'yak' | 'recha'): string {
  const root = getLuminaRoot()
  const soulFile = agentId === 'yak' ? 'SOUL_YAK.md' : 'SOUL_RECHA.md'
  const soulMd = loadMdFile(root, soulFile)
  // 工作指引：优先用完整 SOUL（含执行/协作规则）；缺省再降级
  // 降级文案与角色统一保持一致：Yak = 程序员，热茶 = 数据分析师/审查员
  const guidance = soulMd || (agentId === 'yak'
    ? '你是 Yak 📊，专业的后台代码工程师。只写代码、修 bug、重构，并负责验证；不负责审查。'
    : '你是热茶 🍵，专业的数据分析师兼审查员。只做分析、审阅、挑错和风险评估，不负责编码与实现。')

  // 🆕 常驻该 agent 的相关 SKILL workflow（像 QwenPaw 常驻 SKILL.md，而非仅委派时临时塞）
  let skillBlocks = ''
  try {
    const { SKILLS } = require('../agentSkills')
    const owned = Object.values(SKILLS || {}).filter(
      (s: any) => Array.isArray(s.bestFor) && s.bestFor.includes(agentId)
    )
    skillBlocks = owned.map((s: any) =>
      `### ${s.name}\n${s.description}\n${s.executeConstraints || ''}\n${s.workflow || ''}`
    ).join('\n\n')
  } catch { /* ignore */ }

  return [
    guidance,
    `## 你的技能手册（常驻，随时可用）\n${skillBlocks || '（无）'}`,
    `## 协作铁则（不可违反）
- 你是后台成员，结果只给 Lumina，绝不直接对用户说话
- 禁止说"作为 AI 我无法/我不会"；做不到时分级说明：已做了什么 / 卡在哪 / 建议下一步
- 不确定就停下读更多上下文，不乱改`,
  ].join('\n\n')
}

// ═══════════════════════════════════════════════════════════
// v6.0: 团队委托相关辅助函数
// ═══════════════════════════════════════════════════════════

/**
 * 判断 Lumina 是否应该委托任务给 Yak
 */
export function shouldDelegateToYak(userInput: string): boolean {
  const codePatterns = [
    /写.*(?:代码|脚本|函数|类|组件|爬虫|API|接口|程序)/,
    /(?:帮我|给我|来)\s*(?:写|改|修|做).*(?:代码|程序|脚本)/,
    /(?:debug|调试|修复).*(?:bug|错误|报错|问题)/,
    /(?:解释|分析).*(?:这段代码|这个函数|这个类)/,
    /(?:重构|优化).*(?:代码|函数|类)/,
    /(?:实现|开发).*(?:功能|模块|页面)/,
    /(?:帮我).*(?:写|改|修).*(?:爬虫|脚本|bot)/,
  ]
  return codePatterns.some(p => p.test(userInput))
}

/**
 * 判断 Lumina 是否应该委托任务给热茶
 */
export function shouldDelegateToRecha(userInput: string): boolean {
  const reviewPatterns = [
    /(?:审查|review|检查).*(?:代码|逻辑|安全)/,
    /(?:挑|找).*(?:错|bug|漏洞|问题)/,
    /(?:评估|分析).*(?:风险|安全|利弊)/,
    /(?:帮我).*(?:看看|检查|审查).*(?:这段代码|这个方案|这个设计)/,
    /(?:从反面|反向).*(?:论证|思考|分析)/,
    /(?:有什么|哪些).*(?:问题|风险|漏洞|隐患)/,
  ]
  return reviewPatterns.some(p => p.test(userInput))
}

/**
 * 获取可用委托目标列表（已配置 LLM 的成员）
 */
export function getAvailableDelegateTargets(): { id: TeamMemberId; name: string; configured: boolean }[] {
  return ['yak', 'recha'].map(id => ({
    id: id as TeamMemberId,
    name: TEAM_MEMBERS[id as TeamMemberId].name,
    configured: TEAM_MEMBERS[id as TeamMemberId].configured,
  }))
}

// ═══════════════════════════════════════════════════════════
// v6.0 新增: 恢复未总结的历史消息
// ═══════════════════════════════════════════════════════════

export function recoverUnsummarizedHistory(history: Array<{ role: string; content: string }> = []): string {
  if (!history || history.length === 0) {return ''}
  const recent = history.slice(-6)
  return recent.map(m => `[${m.role}]: ${m.content.slice(0, 200)}`).join('\n')
}
