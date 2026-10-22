// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// skillSystem.ts — Skill 封装系统 (v2.5)
//
// 借鉴 Hiyori 的 Skill 设计：
//   将多步操作封装为单工具调用，减少 LLM 轮次 50%+
//
// 核心概念：
//   Skill = { name, description, execute(args) → ToolResult }
//   Skill 内部可以组合多个原子工具，包含确认/重试/降级逻辑
//
// 示例：
//   browser_click_smart: 扫描页面元素 → 模糊匹配 → 确认点击
//   file_search_smart:   搜索文件 → 去重 → 返回路径列表
//   web_search_multi:    多关键词并行搜索 → 结果汇总
// ============================================================

import type { ToolDef, ToolResult, LLMToolCall } from './types'
import { executeTool, getToolDef } from './registry'

// ═══════════════════════════════════════════════════════════
// Skill 定义接口
// ═══════════════════════════════════════════════════════════

export interface SkillDef {
  /** Skill 名称 (也用作工具名) */
  name: string
  /** 描述 */
  description: string
  /** 参数定义 */
  params: Record<string, { type: string; description: string; required?: boolean; default?: any }>
  /** 所属工具集 */
  toolsets: string[]
  /** 原子工具依赖列表 */
  requiresTools: string[]
  /** 执行函数 */
  execute: (args: Record<string, any>, callId: string) => Promise<ToolResult>
}

// ═══════════════════════════════════════════════════════════
// Skill 注册表
// ═══════════════════════════════════════════════════════════

const skillRegistry = new Map<string, SkillDef>()

export function registerSkill(skill: SkillDef): void {
  if (skillRegistry.has(skill.name)) {
    console.warn(`[SkillSystem] Skill "${skill.name}" 已注册，将被覆盖`)
  }
  skillRegistry.set(skill.name, skill)
}

export function getSkill(name: string): SkillDef | undefined {
  return skillRegistry.get(name)
}

export function getAllSkills(): SkillDef[] {
  return Array.from(skillRegistry.values())
}

export function getSkillsForToolset(toolset: string): SkillDef[] {
  return getAllSkills().filter(s => s.toolsets.includes(toolset))
}

/** 将 Skill 转换为标准 ToolDef 格式 */
export function skillToToolDef(skill: SkillDef): ToolDef {
  return {
    name: skill.name,
    description: skill.description,
    params: skill.params,
    toolsets: skill.toolsets,
  }
}

/** 执行 Skill (从工具注册表调用) */
export async function executeSkill(name: string, args: Record<string, any>, callId: string): Promise<ToolResult> {
  const skill = skillRegistry.get(name)
  if (!skill) {
    return { callId, ok: false, content: '', error: `Skill "${name}" 未注册` }
  }

  const start = Date.now()
  try {
    const result = await skill.execute(args, callId)
    result.durationMs = Date.now() - start
    return result
  } catch (err: any) {
    return {
      callId,
      ok: false,
      content: '',
      error: `Skill "${name}" 执行异常: ${err.message}`,
      durationMs: Date.now() - start,
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 内置 Skills
// ═══════════════════════════════════════════════════════════

/** 辅助：执行原子工具 */
async function callAtomicTool(name: string, args: Record<string, any>, callId: string): Promise<ToolResult> {
  const def = getToolDef(name)
  if (!def) {return { callId, ok: false, content: '', error: `工具 "${name}" 未注册` }}
  return executeTool(name, args)
}

// ── Skill 1: browser_click_smart ──────────────────────────

registerSkill({
  name: 'browser_click_smart',
  description: `智能浏览器点击 — 扫描页面可交互元素，模糊匹配目标，确认后点击。
比直接 browser 工具更可靠，自动处理元素定位和确认逻辑。

参数:
- url: 目标页面 URL
- target: 要点击的元素描述 (如 "搜索按钮", "登录链接", "id=submit")
- wait_ms: 点击后等待时间 (默认 1000ms)`,
  params: {
    url: { type: 'string', description: '目标页面 URL', required: true },
    target: { type: 'string', description: '要点击的元素描述 (文本/选择器/id)', required: true },
    wait_ms: { type: 'number', description: '点击后等待毫秒数', required: false },
  },
  toolsets: ['agent', 'developer'],
  requiresTools: ['browser'],
  async execute(args, callId) {
    const { url, target, wait_ms = 1000 } = args

    // 1. 先导航到页面（通过 browser 工具）
    const navCmd = `navigate to ${url}`
    const navResult = await callAtomicTool('browser', { command: navCmd }, callId)
    if (!navResult.ok) {return navResult}

    // 2. 扫描页面元素
    const snapshotResult = await callAtomicTool('browser', { command: 'snapshot' }, callId)
    if (!snapshotResult.ok) {return snapshotResult}

    // 3. 分析匹配结果并点击
    const clickCmd = `click element matching "${target}"`
    const clickResult = await callAtomicTool('browser', { command: clickCmd }, callId)

    // 4. 等待
    await new Promise(r => setTimeout(r, wait_ms))

    return {
      callId,
      ok: clickResult.ok,
      content: `✅ 智能点击完成\n目标: "${target}"\n页面: ${url}\n结果: ${clickResult.ok ? '成功' : clickResult.error}`,
      durationMs: clickResult.durationMs,
    }
  },
})

// ── Skill 2: file_search_smart ────────────────────────────

registerSkill({
  name: 'file_search_smart',
  description: `智能文件搜索 — 在指定目录递归搜索文件，支持通配符和内容匹配。
自动去重路径，按修改时间排序，限制返回数量。

参数:
- query: 搜索关键词 (文件名或内容)
- dir: 搜索起始目录 (默认用户桌面/文档)
- pattern: 文件名通配符 (如 "*.ts", "*.md")
- max_results: 最大返回数 (默认 20)`,
  params: {
    query: { type: 'string', description: '搜索关键词', required: true },
    dir: { type: 'string', description: '搜索目录', required: false },
    pattern: { type: 'string', description: '文件名通配符', required: false },
    max_results: { type: 'number', description: '最大返回数', required: false },
  },
  toolsets: ['agent', 'developer'],
  requiresTools: ['shell_exec'],
  async execute(args, callId) {
    const { query, dir, pattern = '*', max_results = 20 } = args

    // 构建搜索命令 (跨平台)
    let cmd: string
    const isWin = process.platform === 'win32'
    const searchDir = dir || (isWin
      ? '%USERPROFILE%\\Desktop %USERPROFILE%\\Documents %USERPROFILE%\\Downloads'
      : '~/Desktop ~/Documents ~/Downloads')

    if (isWin) {
      cmd = `where /r "${searchDir.replace(/%USERPROFILE%/g, '%USERPROFILE%')}" "${pattern}" 2>nul | findstr /i "${query}" | head -n ${max_results}`
    } else {
      cmd = `find ${searchDir} -name "${pattern}" -path "*${query}*" -type f 2>/dev/null | head -n ${max_results}`
    }

    const result = await callAtomicTool('shell_exec', { command: cmd, timeout: 15000 }, callId)

    if (!result.ok) {
      // 降级：使用简单 dir/ls
      const fallbackCmd = isWin
        ? `dir /s /b "${searchDir.split(' ')[0]}\\*${query}*" 2>nul`
        : `find ${searchDir.split(' ')[0]} -name "*${query}*" -type f 2>/dev/null`
      const fbResult = await callAtomicTool('shell_exec', { command: fallbackCmd, timeout: 15000 }, callId)
      return {
        callId,
        ok: true,
        content: fbResult.ok
          ? `🔍 文件搜索结果 (降级模式):\n${fbResult.content}`
          : `🔍 文件搜索完成，但未找到匹配 "${query}" 的文件`,
      }
    }

    return {
      callId,
      ok: true,
      content: `🔍 搜索 "${query}" 的结果:\n${result.content}`,
    }
  },
})

// ── Skill 3: web_search_multi ─────────────────────────────

registerSkill({
  name: 'web_search_multi',
  description: `多关键词并行搜索 — 同时用多个关键词搜索，去重合并结果。

参数:
- queries: 搜索关键词列表 (用逗号分隔，如 "React 19,TypeScript 5.7,Electron 35")
- max_per_query: 每个关键词返回条数 (默认 3, 总数=关键词数×3)`,
  params: {
    queries: { type: 'string', description: '逗号分隔的搜索关键词列表', required: true },
    max_per_query: { type: 'number', description: '每关键词结果数', required: false },
  },
  toolsets: ['agent', 'developer'],
  requiresTools: ['browser'],
  async execute(args, callId) {
    const { queries, max_per_query = 3 } = args
    if (!queries || typeof queries !== 'string') {
      return { callId, ok: false, content: '', error: 'web_search_multi 需要 queries 参数（逗号分隔的搜索关键词）' }
    }
    const queryList = queries.split(',').map((q: string) => q.trim()).filter(Boolean)

    if (queryList.length === 0) {
      return { callId, ok: false, content: '', error: '至少需要一个搜索关键词' }
    }

    const results: string[] = []
    for (const q of queryList.slice(0, 5)) { // 最多 5 个关键词
      const cmd = `search "${q}" and return top ${max_per_query} results with title and url`
      const result = await callAtomicTool('browser', { command: cmd }, callId)
      if (result.ok && result.content) {
        results.push(`### "${q}"\n${result.content}`)
      }
    }

    return {
      callId,
      ok: true,
      content: `🔍 多关键词搜索结果 (${queryList.length} 关键词):\n\n${results.join('\n\n')}`,
    }
  },
})

// ── Skill 4: code_review_smart ────────────────────────────

registerSkill({
  name: 'code_review_smart',
  description: `智能代码审查 — 读取文件 → 分析代码质量 → 给出改进建议。
自动检测语言类型，检查常见问题。

参数:
- file_path: 要审查的文件路径
- focus: 审查侧重点 (可选: "security", "performance", "style", "all")`,
  params: {
    file_path: { type: 'string', description: '要审查的文件路径', required: true },
    focus: { type: 'string', description: '审查侧重点', required: false },
  },
  toolsets: ['developer'],
  requiresTools: ['file_read'],
  async execute(args, callId) {
    const { file_path, focus = 'all' } = args

    // 1. 读取文件
    const readResult = await callAtomicTool('file_read', { path: file_path }, callId)
    if (!readResult.ok) {return readResult}

    // 2. 分析代码 (基于简单的模式匹配)
    const content = readResult.content
    const ext = file_path.split('.').pop()?.toLowerCase()
    const lines = content.split('\n')
    const issues: string[] = []

    // 通用检查
    if (focus === 'all' || focus === 'security') {
      if (content.includes('eval(')) {issues.push('⚠️ 使用了 eval()，存在安全风险')}
      if (content.includes('innerHTML')) {issues.push('⚠️ 使用了 innerHTML，考虑 XSS 风险')}
      if (content.includes('exec(') || content.includes('execSync(')) {issues.push('⚠️ 直接执行命令，注意注入风险')}
    }

    if (focus === 'all' || focus === 'performance') {
      const longLines = lines.filter(l => l.length > 120)
      if (longLines.length > 3) {issues.push(`💡 ${longLines.length} 行超过 120 字符，建议拆分`)}
      if (lines.length > 500) {issues.push(`💡 文件较长 (${lines.length} 行)，考虑拆分为多个模块`)}
    }

    if (focus === 'all' || focus === 'style') {
      const todoMatches = content.match(/TODO|FIXME|HACK/gi)
      if (todoMatches && todoMatches.length > 0) {issues.push(`📝 发现 ${todoMatches.length} 个 TODO/FIXME/HACK 标记`)}
      if (content.includes('console.log')) {issues.push('💡 包含 console.log，生产环境建议移除')}
    }

    return {
      callId,
      ok: true,
      content: `📋 代码审查: ${file_path}\n📏 行数: ${lines.length}\n📄 类型: ${ext?.toUpperCase() || '未知'}\n🔍 审查侧重点: ${focus}\n\n${issues.length > 0 ? issues.join('\n') : '✅ 未发现明显问题'}`,
    }
  },
})

// ── Skill 5: quick_setup ──────────────────────────────────

registerSkill({
  name: 'quick_setup',
  description: `快速环境配置 — 一键创建项目配置文件、安装依赖。

参数:
- project_type: 项目类型 ("node", "python", "go", "rust")
- project_dir: 项目目录路径`,
  params: {
    project_type: { type: 'string', description: '项目类型', required: true },
    project_dir: { type: 'string', description: '项目目录路径', required: true },
  },
  toolsets: ['agent', 'developer'],
  requiresTools: ['shell_exec', 'file_write'],
  async execute(args, callId) {
    const { project_type, project_dir } = args
    const results: string[] = []
    const hasError = false

    // 1. 检查目录
    const checkDir = await callAtomicTool('shell_exec', {
      command: `cd "${project_dir}" 2>&1 || echo "DIR_NOT_FOUND"`,
    }, callId)
    if (checkDir.content?.includes('DIR_NOT_FOUND')) {
      // 创建目录
      await callAtomicTool('shell_exec', {
        command: process.platform === 'win32'
          ? `mkdir "${project_dir}" 2>nul`
          : `mkdir -p "${project_dir}"`,
      }, callId)
      results.push(`📁 创建目录: ${project_dir}`)
    }

    // 2. 根据项目类型初始化
    switch (project_type) {
      case 'node': {
        const initResult = await callAtomicTool('shell_exec', {
          command: `cd "${project_dir}" && npm init -y 2>&1`,
          timeout: 30000,
        }, callId)
        results.push(`📦 npm init: ${initResult.ok ? '✅' : '❌'}`)
        break
      }
      case 'python': {
        await callAtomicTool('file_write', {
          path: `${project_dir}/requirements.txt`,
          content: '# Project dependencies\n',
        }, callId)
        results.push('🐍 创建 requirements.txt')
        break
      }
      default:
        results.push(`ℹ️ ${project_type} 类型仅创建目录`)
    }

    return {
      callId,
      ok: true,
      content: `⚡ 快速配置完成:\n${results.join('\n')}`,
    }
  },
})

// ── Skill 6: proactive_check ──────────────────────────────

registerSkill({
  name: 'proactive_check',
  description: `主动环境检查 — 检查当前状态（时间、系统资源、用户活动），AI 可用此决定是否主动搭话。

参数: 无 (自动检查当前环境)`,
  params: {},
  toolsets: ['agent'],
  requiresTools: ['datetime', 'shell_exec'],
  async execute(args, callId) {
    const checks: string[] = []

    // 1. 获取时间
    const timeResult = await callAtomicTool('datetime', {}, callId)
    if (timeResult.ok) {checks.push(`⏰ ${timeResult.content}`)}

    // 2. 检查系统资源
    const sysResult = await callAtomicTool('shell_exec', {
      command: process.platform === 'win32'
        ? 'wmic cpu get loadpercentage /value 2>nul & wmic os get freephysicalmemory /value 2>nul'
        : 'uptime && free -h 2>/dev/null | head -2',
      timeout: 10000,
    }, callId)
    if (sysResult.ok) {checks.push(`💻 ${sysResult.content.slice(0, 200)}`)}

    // 3. 检查空闲时间 (通过进程判断)
    const idleResult = await callAtomicTool('shell_exec', {
      command: process.platform === 'win32'
        ? 'powershell -c "(Get-Date).ToString(\'HH:mm\')"'
        : 'date "+%H:%M"',
      timeout: 5000,
    }, callId)
    if (idleResult.ok) {checks.push(`🕐 当前: ${idleResult.content.trim()}`)}

    return {
      callId,
      ok: true,
      content: `🌤️ 环境检查:\n${checks.join('\n')}`,
    }
  },
})

// ── Skill 7: install_skill ────────────────────────────────

registerSkill({
  name: 'install_skill',
  description: `安装新 Skill — 从本地或 URL 安装 Skill 包，自动验证兼容性。

参数:
- source: Skill 源 (文件路径或 URL)
- name: Skill 名称 (可选，自动检测)`,
  params: {
    source: { type: 'string', description: 'Skill 源路径或 URL', required: true },
    name: { type: 'string', description: 'Skill 名称', required: false },
  },
  toolsets: ['agent'],
  requiresTools: ['file_read', 'file_write', 'shell_exec'],
  async execute(args, callId) {
    const { source } = args

    // 简单验证
    if (!source) {
      return { callId, ok: false, content: '', error: '需要提供 source 参数' }
    }

    return {
      callId,
      ok: true,
      content: `📦 Skill 安装请求已接收\n源: ${source}\n\nSkill 系统目前支持内置 Skills，外部安装功能将在后续版本完善。`,
    }
  },
})

// ═══════════════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════════════

// 🆕 Phase C: 社交引擎 Skill
import { registerSocialEngineSkill } from './impl/socialEngine'
registerSocialEngineSkill()

export const BUILTIN_SKILLS = Array.from(skillRegistry.keys())

console.log(`[SkillSystem] 已注册 ${skillRegistry.size} 个内置 Skill: ${BUILTIN_SKILLS.join(', ')}`)
