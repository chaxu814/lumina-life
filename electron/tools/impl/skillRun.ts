// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// impl/skillRun.ts — Skill 工具执行 (v2.4.1)
//
// 让 Agent 能调用已安装 Skill 中的工具脚本。
// 使用 skillInstaller 的 runSkillTool / listSkillTools 函数。
//
// 🔧 P1-fix: 新增 use_skill 工具 — 将 SKILL.md 工作流注入 LLM 上下文
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { runSkillTool, listSkillTools, listInstalledSkills } from '../../skillInstaller'
import { app } from 'electron'

/**
 * 🔧 启动崩溃修复（2026-10-03）
 *
 * 【原 bug】`createSkillRunDef()` 在**构造 ToolDef 时**就调用 `listInstalledSkills()`，
 * 它内部走 `app.getPath('userData')`。而 `registerAllTools()` 是在主进程模块顶层
 * （`electron/tools/index.ts` 末尾）被调用的 —— 那时 Electron 的 `app` 还没初始化，
 * 于是 `npm run dev` 直接崩：
 *
 *   TypeError: Cannot read properties of undefined (reading 'getPath')
 *     at getSkillsDir (out/main/index.js:246695)
 *     at listInstalledSkills$1
 *     at createSkillRunDef
 *     at registerAllTools
 *
 * 【为什么症状是「图标不对」而不是「启动失败」】
 * 窗口根本没创建出来，任务栏上剩的是上一次残留或 Electron 默认壳，
 * 看起来就像图标问题。**这才是当时误判的方向。**
 *
 * 【修法】ToolDef 的 description 改成惰性求值：
 * 构造期只放函数指针，真正生成 schema 时才读磁盘。
 * 这样工具注册不再依赖 Electron 运行时状态，`app` 未就绪也安全。
 */

/** 安全读取已安装技能：任何异常都退回空列表，绝不让工具注册崩掉 */
function safeListInstalled(): ReturnType<typeof listInstalledSkills> {
  try {
    // app 未就绪时 getPath 会抛，这里提前挡住
    if (!app || typeof app.getPath !== 'function') {return []}
    return listInstalledSkills()
  } catch {
    return []
  }
}

/** 生成已安装技能的可读清单（失败时给出说明而不是空白） */
function buildSkillInfo(): string {
  const installed = safeListInstalled()
  if (installed.length === 0) {return '  (暂无已安装的 Skill，或技能目录尚未就绪)'}
  return installed.map(s => {
    const tools = listSkillTools(s.id)
    return `  - ${s.id}: ${s.name} — ${s.description.slice(0, 60)}${tools.length ? ` (可用工具: ${tools.join(', ')})` : ''}`
  }).join('\n')
}

/** 惰性生成 skill_run 的描述（供工具注册与 schema 刷新时调用） */
export function resolveSkillRunDescription(): string {
  return `执行已安装 Skill 中的工具脚本。支持 Python/Node/Shell/PowerShell 脚本。

【已安装的 Skill】
${buildSkillInfo()}

用法: skill_run(skill_id, tool_name, args?) → 返回脚本执行输出`
}

/** 动态生成 tool def（包含已安装 skill 列表） */
export function createSkillRunDef(): ToolDef {
  return {
    name: 'skill_run',
    description: resolveSkillRunDescription(),
    params: {
      skill_id: { type: 'string', description: 'Skill ID (从上面列表中选择)', required: true },
      tool_name: { type: 'string', description: '工具名称 (不含扩展名，如 "search" 对应 tools/search.py)', required: true },
      args: { type: 'string', description: '传递给脚本的命令行参数 (可选)', required: false },
    },
    toolsets: ['skills', 'agent'],
  }
}

export async function skillRunHandler(args: Record<string, any>): Promise<ToolResult> {
  const skillId = args.skill_id
  const toolName = args.tool_name
  const scriptArgs = args.args || ''

  if (!skillId || !toolName) {
    return { callId: '', ok: false, content: '', error: '需要 skill_id 和 tool_name 参数' }
  }

  const start = Date.now()

  try {
    const result = runSkillTool(skillId, toolName, scriptArgs)

    if (result.success) {
      return {
        callId: '',
        ok: true,
        content: `✅ skill_run(${skillId}, ${toolName})\n\n${result.output}`,
        durationMs: Date.now() - start,
      }
    } else {
      return {
        callId: '',
        ok: false,
        content: result.output,
        error: result.error,
        durationMs: Date.now() - start,
      }
    }
  } catch (err: any) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: `skill_run 异常: ${err.message}`,
      durationMs: Date.now() - start,
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 🔧 P1-fix: use_skill 工具 — 读取 SKILL.md 工作流到上下文
// ═══════════════════════════════════════════════════════════

/** use_skill 工具的 ToolDef */
export const useSkillDef: ToolDef = {
  name: 'use_skill',
  description: `读取已安装 SKILL.md 的完整工作流到当前上下文。
在开始复杂任务前调用此工具，获取对应 Skill 的工作流指导。

用法: use_skill(skill_id) → 返回 SKILL.md 的完整工作流内容`,
  params: {
    skill_id: {
      type: 'string',
      description: 'Skill ID（目录名，如 browser_click_smart, web_search_multi 等）',
      required: true,
    },
  },
  toolsets: ['skills', 'agent'],
}

export async function useSkillHandler(args: Record<string, any>): Promise<ToolResult> {
  const skillId = args.skill_id
  if (!skillId) {
    return { callId: '', ok: false, content: '', error: '需要 skill_id 参数' }
  }

  const start = Date.now()
  try {
    const fs = require('fs')
    const path = require('path')
    const { app } = require('electron')

    // 搜索 skills/{skillId}/SKILL.md
    // 旧列表里有一条 path.join('J:\\LuminaLife2.0\\skills', ...) —— 那是作者
    // 本机的安装路径，对其他用户永远不存在，属于开发环境残留，已移除。
    // 需要指向自定义 skills 目录时用 LUMINA_SKILLS_DIR 环境变量。
    const skillsRoot = process.env.LUMINA_SKILLS_DIR || ''
    const candidates = [
      path.join(app.getPath('userData'), 'skills', skillId, 'SKILL.md'),
      path.join(app.getAppPath(), 'skills', skillId, 'SKILL.md'),
      path.join(process.cwd(), 'skills', skillId, 'SKILL.md'),
      skillsRoot ? path.join(skillsRoot, skillId, 'SKILL.md') : '',
    ].filter(Boolean)

    for (const mdPath of candidates) {
      try {
        if (fs.existsSync(mdPath)) {
          const content = fs.readFileSync(mdPath, 'utf-8')
          return {
            callId: '',
            ok: true,
            content: `📖 已加载 Skill: ${skillId}\n\n${content}`,
            durationMs: Date.now() - start,
          }
        }
      } catch {}

      // 也尝试用正斜杠路径（跨平台）
      const unixPath = mdPath.replace(/\\/g, '/')
      if (unixPath !== mdPath) {
        try {
          if (fs.existsSync(unixPath)) {
            const content = fs.readFileSync(unixPath, 'utf-8')
            return {
              callId: '',
              ok: true,
              content: `📖 已加载 Skill: ${skillId}\n\n${content}`,
              durationMs: Date.now() - start,
            }
          }
        } catch {}
      }
    }

    // 尝试通过 DynamicSkillLoader 获取
    try {
      const { getDynamicSkillLoader } = require('../../skillLoader')
      const loader = getDynamicSkillLoader()
      const allSkills = await loader.discover()
      const skill = allSkills.find((s: { id: string }) => s.id === skillId)
      if (skill) {
        return {
          callId: '',
          ok: true,
          content: `📖 已加载 Skill: ${skill.name}\n\n描述: ${skill.description}\n\n${skill.workflow}`,
          durationMs: Date.now() - start,
        }
      }
    } catch {}

    return {
      callId: '',
      ok: false,
      content: '',
      error: `找不到 Skill "${skillId}"。请确认 skill_id 是否正确。可用: ${safeListInstalled().map(s => s.id).join(', ') || '(无已安装技能)'}`,
      durationMs: Date.now() - start,
    }

  } catch (err: any) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: `use_skill 异常: ${err.message}`,
      durationMs: Date.now() - start,
    }
  }
}
