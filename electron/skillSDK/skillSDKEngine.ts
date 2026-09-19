// ============================================================
// skillSDK/skillSDKEngine.ts — 技能 SDK 开放平台 v1.0
//
// 允许用户/开发者创建自定义技能
// 提供模板生成、技能验证、安装流程
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface SkillTemplate {
  name: string
  description: string
  version: string
  author: string
  tools: Array<{
    name: string
    description: string
    params: Array<{ name: string; type: string; description: string; required: boolean }>
  }>
}

export interface SkillManifest {
  name: string
  description: string
  version: string
  author: string
  icon?: string
  tools: string[]
  createdAt: string
}

// ═══════════════════════════════════════════════════════════
// 模板定义
// ═══════════════════════════════════════════════════════════

const BASIC_TOOL_TEMPLATE = `// ============================================================
// tools/impl/{toolName}.ts — {toolDescription}
//
// 由 Skill SDK 生成 — 修改后即可使用
// ============================================================

import type { ToolDef, ToolResult } from '../types'

export const {toolName}Def: ToolDef = {
  name: '{toolName}',
  description: '{toolDescription}',
  params: [
    { name: 'input', type: 'string', description: '输入内容', required: true },
  ],
  toolsets: ['agent'],
}

export async function {toolName}(args: { input: string }): Promise<ToolResult> {
  try {
    // TODO: 在这里实现你的技能逻辑
    const result = \`你输入了: \${args.input}\`
    
    return {
      success: true,
      result,
      message: '{toolName} 执行成功',
    }
  } catch (e) {
    return {
      success: false,
      result: null,
      message: \`执行失败: \${e instanceof Error ? e.message : String(e)}\`,
    }
  }
}
`

const ADVANCED_TOOL_TEMPLATE = `// ============================================================
// tools/impl/{toolName}.ts — {toolDescription}
//
// 高级模板 — 包含记忆读写、事件通知、LLM 调用
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { globalEventBus, BusEvents } from '../../eventBus'
import { getMemoryStore } from '../../memory/memoryStore'

export const {toolName}Def: ToolDef = {
  name: '{toolName}',
  description: '{toolDescription}',
  params: [
    { name: 'query', type: 'string', description: '查询内容', required: true },
    { name: 'options', type: 'object', description: '额外选项', required: false },
  ],
  toolsets: ['agent'],
}

export async function {toolName}(args: { query: string; options?: Record<string, any> }): Promise<ToolResult> {
  try {
    // 示例：读取记忆
    const memoryStore = getMemoryStore()
    const memories = memoryStore.search(args.query, 5)
    
    // 示例：发送事件
    globalEventBus.emit(BusEvents.REALITY_SHOW_EVENT, {
      type: 'agent:action',
      agents: ['CustomSkill'],
      title: '{toolName} 被调用了',
      content: \`查询: \${args.query}\`,
    })

    return {
      success: true,
      result: { memories: memories ?? [] },
      message: \`找到了 \${memories?.length ?? 0} 条相关记忆\`,
    }
  } catch (e) {
    return {
      success: false,
      result: null,
      message: \`执行失败: \${e instanceof Error ? e.message : String(e)}\`,
    }
  }
}
`

const SKILL_MANIFEST_TEMPLATE = `{
  "name": "{skillName}",
  "description": "{skillDescription}",
  "version": "1.0.0",
  "author": "{author}",
  "icon": "🔧",
  "tools": ["{toolName}"],
  "createdAt": "{createdAt}"
}`

// ═══════════════════════════════════════════════════════════
// 技能 SDK 引擎
// ═══════════════════════════════════════════════════════════

function getSDKDir(): string {
  const baseDir = path.join(app.getPath('userData'), 'skill-sdk')
  if (!fs.existsSync(baseDir)) {fs.mkdirSync(baseDir, { recursive: true })}
  return baseDir
}

/**
 * 生成技能模板文件
 */
export function generateSkillTemplate(params: {
  skillName: string
  skillDescription: string
  toolName: string
  author: string
  template: 'basic' | 'advanced'
}): { files: Record<string, string>; manifest: SkillManifest } {
  const { skillName, skillDescription, toolName, author, template } = params
  const now = new Date().toISOString()

  const replacements: Record<string, string> = {
    '{skillName}': skillName,
    '{toolName}': toolName,
    '{toolDescription}': skillDescription,
    '{skillDescription}': skillDescription,
    '{author}': author || 'Anonymous',
    '{createdAt}': now,
  }

  let toolCode = template === 'advanced' ? ADVANCED_TOOL_TEMPLATE : BASIC_TOOL_TEMPLATE
  Object.entries(replacements).forEach(([k, v]) => {
    toolCode = toolCode.replaceAll(k, v)
  })

  let manifestJson = SKILL_MANIFEST_TEMPLATE
  Object.entries(replacements).forEach(([k, v]) => {
    manifestJson = manifestJson.replaceAll(k, v)
  })

  const files: Record<string, string> = {
    'manifest.json': manifestJson,
    [`tools/impl/${toolName}.ts`]: toolCode,
    'README.md': `# ${skillName}\n\n${skillDescription}\n\n由 Lumina Skill SDK 生成\n`,
  }

  const manifest: SkillManifest = {
    name: skillName,
    description: skillDescription,
    version: '1.0.0',
    author: author || 'Anonymous',
    tools: [toolName],
    createdAt: now,
  }

  return { files, manifest }
}

/**
 * 将生成的技能导出到本地目录
 */
export function exportSkillToDisk(skillDir: string, files: Record<string, string>): boolean {
  try {
    const basePath = path.join(getSDKDir(), skillDir)
    if (!fs.existsSync(basePath)) {fs.mkdirSync(basePath, { recursive: true })}

    Object.entries(files).forEach(([filePath, content]) => {
      const fullPath = path.join(basePath, filePath)
      const dir = path.dirname(fullPath)
      if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
      fs.writeFileSync(fullPath, content, 'utf-8')
    })

    console.log(`[SkillSDK] ✅ 技能已导出到 ${basePath}`)
    return true
  } catch (e) {
    console.error('[SkillSDK] ❌ 导出失败:', e)
    return false
  }
}

/**
 * 获取 SDK 帮助信息
 */
export function getSDKHelp(): string {
  return `# Lumina Skill SDK

## 快速开始

1. 点击「生成模板」选择基础/高级模板
2. 填写技能名称、描述、工具名称
3. 生成代码 → 导出到本地
4. 将生成的文件放入 \`electron/tools/impl/\` 目录
5. 在 \`electron/tools/index.ts\` 中注册

## 模板类型

- **基础模板**: 简单的输入→处理→输出
- **高级模板**: 包含记忆读写、事件通知、LLM 调用

## API 参考

### ToolDef 接口
- \`name\`: 工具名称（唯一标识）
- \`description\`: 描述（Agent 理解用）
- \`params\`: 参数列表
- \`toolsets\`: 所属工具集

### 可用模块
- \`../../eventBus\` — 事件总线
- \`../../memory/memoryStore\` — 记忆系统
- \`../../gamification/levels\` — XP/等级系统
- \`../../gamification/achievements\` — 成就系统

## 最佳实践

1. 工具名称用 snake_case
2. 参数尽量少且明确
3. 返回结果包含 success/result/message
4. 善用 eventBus 发送事件以提供反馈
`
}
