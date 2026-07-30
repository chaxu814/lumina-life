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

/** 动态生成 tool def（包含已安装 skill 列表） */
export function createSkillRunDef(): ToolDef {
  const installed = listInstalledSkills()
  const skillInfo = installed.length > 0
    ? installed.map(s => {
        const tools = listSkillTools(s.id)
        return `  - ${s.id}: ${s.name} — ${s.description.slice(0, 60)}${tools.length ? ` (可用工具: ${tools.join(', ')})` : ''}`
      }).join('\n')
    : '  (暂无已安装的 Skill)'

  return {
    name: 'skill_run',
    description: `执行已安装 Skill 中的工具脚本。支持 Python/Node/Shell/PowerShell 脚本。

【已安装的 Skill】
${skillInfo}

用法: skill_run(skill_id, tool_name, args?) → 返回脚本执行输出`,
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
    const candidates = [
      path.join(app.getPath('userData'), 'skills', skillId, 'SKILL.md'),
      path.join(app.getAppPath(), 'skills', skillId, 'SKILL.md'),
      path.join(process.cwd(), 'skills', skillId, 'SKILL.md'),
      // 也检查 J:\LuminaLife2.0\skills\
      path.join('J:\\LuminaLife2.0\\skills', skillId, 'SKILL.md'),
    ]

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
      error: `找不到 Skill "${skillId}"。请确认 skill_id 是否正确。可用: ${listInstalledSkills().map(s => s.id).join(', ') || '(无已安装技能)'}`,
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
