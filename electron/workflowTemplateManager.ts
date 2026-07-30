// ============================================================
// workflowTemplateManager.ts — 工作流模板管理器 (v8.1)
//
// 复杂任务一键套餐
//   模板 = 预设 System Prompt + Toolset + 工具配置 + 模式
//   一键激活后立即切换 Agent 人格与能力
//
// 功能：
//   - 创建/编辑/删除/列表
//   - 一键激活（切换 mode + reload agent + 注入 system prompt）
//   - 内置模板（搜索助手、编程助手、写作助手、数据分析）
//   - 用户自定义模板
// ============================================================

import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import { getModeManager } from './modeManager'
import { globalEventBus } from './eventBus'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  icon: string
  /** 类别: builtin | custom */
  category: 'builtin' | 'custom'
  /** 激活后切换到的 LuminaMode（可选：如为空则保持当前 mode） */
  targetMode?: string
  /** 自定义系统提示（追加到 mode system prompt 后面） */
  systemPromptExtra: string
  /** 限定工具列表（空 = 使用 mode 默认工具集） */
  toolWhitelist?: string[]
  /** 禁用工具列表 */
  toolBlacklist?: string[]
  /** Agent 温度覆盖 */
  temperatureOverride?: number
  /** 启用主动推送 */
  proactiveEnabled?: boolean
  /** 是否包含自定义模式（创建时自动生成内置模式） */
  autoCreateMode?: boolean
  /** 标签 */
  tags: string[]
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

// ═══════════════════════════════════════════════════════════
// 内置模板
// ═══════════════════════════════════════════════════════════

const BUILTIN_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'builtin_search',
    name: '🔍 搜索专家',
    description: '擅长信息检索与资料收集，自动使用多引擎搜索、网页抓取，深度整理答案',
    icon: '🔍',
    category: 'builtin',
    systemPromptExtra: '你现在扮演搜索专家。对用户的每个问题，先分析信息需求，然后用 web_search 搜索，再用 web_fetch 抓取详细内容，最后整合成有结构的回答。引用来源。如果不确定就说不知道。',
    toolWhitelist: ['web_search', 'web_fetch', 'browser_use', 'web_search_multi', 'datetime'],
    temperatureOverride: 0.3,
    proactiveEnabled: false,
    tags: ['搜索', '信息', '效率'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'builtin_coding',
    name: '💻 编程助手',
    description: '专注代码编写、调试与重构，支持多种语言，自动执行测试',
    icon: '💻',
    category: 'builtin',
    targetMode: 'work',
    systemPromptExtra: '你现在扮演资深程序员。回答要包含代码示例。需要时实际执行命令或脚本验证。优先使用安全的文件操作。输出格式整洁，有注释。',
    toolWhitelist: ['execute_command', 'read_file', 'write_file', 'edit_file', 'grep_search', 'glob_search', 'git_status', 'git_diff', 'file_read', 'file_list'],
    temperatureOverride: 0.4,
    proactiveEnabled: false,
    tags: ['编程', '代码', '开发'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'builtin_writing',
    name: '✍️ 写作助手',
    description: '文章创作、翻译、润色、摘要，兼具中文与英文写作能力',
    icon: '✍️',
    category: 'builtin',
    targetMode: 'study',
    systemPromptExtra: '你现在扮演专业写作助手。帮助用户创作、翻译、润色、改写、总结各类文本。注重语言质量、逻辑结构和风格一致性。可以多次迭代改进。',
    temperatureOverride: 0.8,
    proactiveEnabled: true,
    tags: ['写作', '翻译', '创作'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'builtin_research',
    name: '📊 数据分析师',
    description: '数据采集、分析、可视化，生成报告与图表',
    icon: '📊',
    category: 'builtin',
    targetMode: 'work',
    systemPromptExtra: '你现在扮演数据分析师。对数据问题：1) 先收集数据 2) 分析整理 3) 用表格或可视化呈现 4) 给出结论。优先使用 Python 脚本处理数据。',
    toolWhitelist: ['web_search', 'web_fetch', 'execute_command', 'read_file', 'write_file', 'grep_search'],
    temperatureOverride: 0.5,
    proactiveEnabled: false,
    tags: ['数据', '分析', '报告'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'builtin_debug',
    name: '🐛 调试专家',
    description: '专注于错误排查、日志分析、性能优化，给出可复现的修复步骤',
    icon: '🐛',
    category: 'builtin',
    targetMode: 'work',
    systemPromptExtra: '你现在扮演调试专家。收到错误信息后：1) 分析错误类型和根因 2) 检查相关代码/日志 3) 给出具体修复步骤 4) 验证修复。输出要精确、可操作。',
    toolWhitelist: ['execute_command', 'read_file', 'edit_file', 'grep_search', 'glob_search', 'git_diff', 'git_log', 'file_read'],
    temperatureOverride: 0.3,
    proactiveEnabled: false,
    tags: ['调试', '修复', '错误'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
]

// ═══════════════════════════════════════════════════════════
// 模板管理器
// ═══════════════════════════════════════════════════════════

class WorkflowTemplateManager {
  private customTemplates: Map<string, WorkflowTemplate> = new Map()

  private get dataDir(): string {
    try {
      const base = app.getPath('userData')
      return path.join(base, 'workflow-templates')
    } catch {
      return path.join(process.cwd(), 'workflow-templates')
    }
  }

  private get customPath(): string {
    return path.join(this.dataDir, 'custom.json')
  }

  /** 加载自定模板 */
  loadCustomTemplates(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true })
      }
      if (fs.existsSync(this.customPath)) {
        const data: WorkflowTemplate[] = JSON.parse(fs.readFileSync(this.customPath, 'utf-8'))
        for (const tpl of data) {
          this.customTemplates.set(tpl.id, tpl)
        }
        console.log(`[WorkflowTemplates] ✅ 加载 ${data.length} 个自定义模板`)
      }
    } catch (e: any) {
      console.warn('[WorkflowTemplates] 加载失败:', e.message)
    }
  }

  /** 持久化自定义模板 */
  private persist(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true })
      }
      fs.writeFileSync(this.customPath, JSON.stringify(Array.from(this.customTemplates.values()), null, 2), 'utf-8')
    } catch (e: any) {
      console.warn('[WorkflowTemplates] 持久化失败:', e.message)
    }
  }

  /** 列出所有模板（内置 + 自定义） */
  listTemplates(): WorkflowTemplate[] {
    const builtins = BUILTIN_TEMPLATES.map(t => ({ ...t }))
    const customs = Array.from(this.customTemplates.values()).sort((a, b) => b.updatedAt - a.updatedAt)
    return [...builtins, ...customs]
  }

  /** 获取单个模板 */
  getTemplate(id: string): WorkflowTemplate | undefined {
    if (this.customTemplates.has(id)) return this.customTemplates.get(id)
    return BUILTIN_TEMPLATES.find(t => t.id === id)
  }

  /** 创建自定义模板 */
  createTemplate(data: Omit<WorkflowTemplate, 'id' | 'category' | 'createdAt' | 'updatedAt'> & { id?: string }): WorkflowTemplate {
    const now = Date.now()
    const tpl: WorkflowTemplate = {
      ...data,
      id: data.id || `custom_${now}`,
      category: 'custom',
      createdAt: now,
      updatedAt: now,
    }
    this.customTemplates.set(tpl.id, tpl)
    this.persist()
    console.log(`[WorkflowTemplates] 📋 创建模板: ${tpl.id} (${tpl.name})`)
    return tpl
  }

  /** 更新模板 */
  updateTemplate(id: string, data: Partial<WorkflowTemplate>): WorkflowTemplate | null {
    const existing = this.customTemplates.get(id)
    if (!existing) return null
    const updated: WorkflowTemplate = {
      ...existing,
      ...data,
      id, // 防止覆盖 id
      category: 'custom',
      updatedAt: Date.now(),
    }
    this.customTemplates.set(id, updated)
    this.persist()
    return updated
  }

  /** 删除模板 */
  deleteTemplate(id: string): boolean {
    if (!this.customTemplates.has(id)) return false
    this.customTemplates.delete(id)
    this.persist()
    return true
  }

  /**
   * 激活模板 — 一键切换
   * 1. 切换模式（如指定）
   * 2. 注入 system prompt
   * 3. 更新工具配置
   * 4. 广播事件让前端 reload
   */
  activateTemplate(id: string): { ok: boolean; error?: string; template?: WorkflowTemplate } {
    const tpl = this.getTemplate(id)
    if (!tpl) return { ok: false, error: `模板不存在: ${id}` }

    try {
      const modeMgr = getModeManager()

      // 1. 切换模式
      if (tpl.targetMode) {
        modeMgr.setMode(tpl.targetMode as any)
      }

      // 2. 更新系统提示 — 通过 modeConfig 的 agentTone 传递
      if (tpl.systemPromptExtra) {
        const currentMode = tpl.targetMode || modeMgr.getState().current
        modeMgr.updateModeConfig(currentMode as any, {
          agentTone: tpl.systemPromptExtra,
          ...(tpl.temperatureOverride != null ? { temperature: tpl.temperatureOverride } : {}),
          ...(tpl.proactiveEnabled != null ? { proactiveEnabled: tpl.proactiveEnabled } : {}),
        })
      }

      // 3. 广播模板激活事件（前端监听后 reload agent）
      globalEventBus.emit('workflow:activated', {
        templateId: tpl.id,
        templateName: tpl.name,
        toolWhitelist: tpl.toolWhitelist,
        toolBlacklist: tpl.toolBlacklist,
      })

      console.log(`[WorkflowTemplates] 🚀 激活模板: ${tpl.name} (${id})`)
      return { ok: true, template: tpl }
    } catch (e: any) {
      console.error('[WorkflowTemplates] 激活失败:', e.message)
      return { ok: false, error: e.message }
    }
  }

  /** 按标签搜索 */
  searchTemplates(tag: string): WorkflowTemplate[] {
    return this.listTemplates().filter(t => t.tags.some(tg => tg.includes(tag) || t.name.includes(tag) || t.description.includes(tag)))
  }
}

// ── 单例 ──

let instance: WorkflowTemplateManager | null = null

export function getWorkflowTemplateManager(): WorkflowTemplateManager {
  if (!instance) {
    instance = new WorkflowTemplateManager()
  }
  return instance
}

export function initWorkflowTemplateManager(): WorkflowTemplateManager {
  const mgr = getWorkflowTemplateManager()
  mgr.loadCustomTemplates()
  return mgr
}
