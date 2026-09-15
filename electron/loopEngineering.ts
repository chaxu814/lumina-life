// ============================================================
// loopEngineering.ts — Loop Engineering 模板化 (P1-1)
//
// 对标 QwenPaw Loop Engineering：
//   - Coding Mode / Mission Mode 等可组合模板
//   - 让复杂任务更可靠、可复用
//   - 支持分支、循环、并行执行独立步骤
// ============================================================

import type { AgentMessage, AgentRunConfig } from './tools/types'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface LoopTemplate {
  id: string
  name: string
  description: string
  mode: 'coding' | 'mission' | 'research' | 'writing' | 'custom'
  systemPrompt?: string
  preHook?: (context: LoopContext) => Promise<LoopContext>
  postHook?: (context: LoopContext, result: string) => Promise<LoopContext>
  toolFilter?: (toolName: string) => boolean
  maxIterations?: number
  stopConditions?: string[]
}

export interface LoopContext {
  messages: AgentMessage[]
  config: AgentRunConfig
  iteration: number
  maxIterations: number
  toolResults: Map<string, string>
  workspaceFiles: string[]
  branchResults: Map<string, string>
}

export interface LoopStep {
  name: string
  description: string
  tools?: string[]
  prompt?: string
  maxIterations?: number
  parallel?: boolean
  continueOnError?: boolean
}

export interface LoopResult {
  success: boolean
  result: string
  iterations: number
  toolCalls: number
  workspaceChanges?: string[]
  error?: string
}

// ═══════════════════════════════════════════════════════════
// 内置模板
// ═══════════════════════════════════════════════════════════

/**
 * Coding Mode — 代码开发专用模板
 */
export const CODING_MODE_TEMPLATE: LoopTemplate = {
  id: 'coding',
  name: 'Coding Mode',
  description: '代码开发专用模式，自动读取/写入文件、运行测试、修复错误',
  mode: 'coding',
  systemPrompt: `## Coding Mode

你是一个专业的软件工程师。你现在处于 **Coding Mode**，请遵循以下规则：

### 核心原则
1. **先读后写**：修改任何文件前，先读取并理解当前内容
2. **最小改动**：只修改必要的部分，避免不相关的改动
3. **可运行**：生成的代码必须可以直接运行
4. **测试驱动**：优先考虑添加或运行测试

### 工作流程
1. 分析用户需求，明确要实现的功能
2. 读取相关文件，理解现有代码结构
3. 编写/修改代码
4. 运行测试验证（如果可能）
5. 总结修改内容和运行结果

### 工具使用
- file_read: 读取文件内容
- file_write: 写入文件（仅在必要时使用）
- execute_command: 运行命令（测试、构建等）
- web_search: 搜索文档/API 参考

### 输出格式
- 明确说明修改了哪些文件
- 提供关键代码片段
- 说明测试结果
- 如有必要，提供下一步建议`,
  toolFilter: (name) => !['image_generate', 'video_generate', 'music_generate'].includes(name),
  maxIterations: 20,
  stopConditions: ['测试通过', '构建成功', '代码已修复'],
}

/**
 * Mission Mode — 任务执行专用模板
 */
export const MISSION_MODE_TEMPLATE: LoopTemplate = {
  id: 'mission',
  name: 'Mission Mode',
  description: '复杂任务分解执行，支持多步骤、分支和并行',
  mode: 'mission',
  systemPrompt: `## Mission Mode

你是一个任务执行专家。你现在处于 **Mission Mode**，请遵循以下规则：

### 核心原则
1. **分解任务**：将复杂任务分解为可执行的步骤
2. **进度追踪**：明确当前执行到哪一步
3. **容错恢复**：某步失败时，尝试替代方案或回退
4. **结果汇总**：最终给出完整的任务执行报告

### 工作流程
1. 分析任务目标，分解为具体步骤
2. 按顺序执行每一步
3. 每步完成后验证结果
4. 如果某步失败，尝试恢复或替代方案
5. 汇总所有步骤的结果

### 输出格式
- 任务分解清单（带状态：✅/❌/⏳）
- 每步的详细执行结果
- 最终汇总报告
- 遗留问题或后续建议`,
  maxIterations: 30,
  stopConditions: ['任务完成', '所有步骤执行完毕', '结果已验证'],
}

/**
 * Research Mode — 研究分析专用模板
 */
export const RESEARCH_MODE_TEMPLATE: LoopTemplate = {
  id: 'research',
  name: 'Research Mode',
  description: '深度研究分析，多源信息收集与综合',
  mode: 'research',
  systemPrompt: `## Research Mode

你是一个研究分析师。你现在处于 **Research Mode**，请遵循以下规则：

### 核心原则
1. **多源验证**：从多个来源收集信息并交叉验证
2. **结构化输出**：使用清晰的结构组织研究发现
3. **引用来源**：明确标注信息来源
4. **客观分析**：区分事实与观点，保持客观

### 工作流程
1. 明确研究问题和范围
2. 收集相关信息（搜索、读取文档等）
3. 分析和整理信息
4. 验证关键信息
5. 输出结构化的研究报告

### 输出格式
- 执行摘要
- 研究发现（分主题）
- 信息来源
- 结论与建议`,
  maxIterations: 15,
  stopConditions: ['研究完成', '信息已收集', '分析已完成'],
}

// ═══════════════════════════════════════════════════════════
// Loop Engineering 引擎
// ═══════════════════════════════════════════════════════════

export class LoopEngineering {
  private templates = new Map<string, LoopTemplate>()
  private activeLoops = new Map<string, LoopContext>()

  constructor() {
    // 注册内置模板
    this.registerTemplate(CODING_MODE_TEMPLATE)
    this.registerTemplate(MISSION_MODE_TEMPLATE)
    this.registerTemplate(RESEARCH_MODE_TEMPLATE)
  }

  /** 注册模板 */
  registerTemplate(template: LoopTemplate): void {
    this.templates.set(template.id, template)
  }

  /** 获取模板 */
  getTemplate(id: string): LoopTemplate | undefined {
    return this.templates.get(id)
  }

  /** 列出所有模板 */
  listTemplates(): LoopTemplate[] {
    return Array.from(this.templates.values())
  }

  /**
   * 执行 Loop 模板
   */
  async executeTemplate(
    templateId: string,
    context: Omit<LoopContext, 'iteration' | 'toolResults' | 'branchResults'>,
  ): Promise<LoopResult> {
    const template = this.templates.get(templateId)
    if (!template) {
      return {
        success: false,
        result: '',
        iterations: 0,
        toolCalls: 0,
        error: `模板未找到: ${templateId}`,
      }
    }

    const loopContext: LoopContext = {
      ...context,
      iteration: 0,
      maxIterations: template.maxIterations || 10,
      toolResults: new Map(),
      branchResults: new Map(),
    }

    this.activeLoops.set(templateId, loopContext)

    try {
      // 执行 pre-hook
      if (template.preHook) {
        Object.assign(loopContext, await template.preHook(loopContext))
      }

      // 注入系统提示词
      if (template.systemPrompt) {
        loopContext.messages.unshift({
          role: 'system',
          content: template.systemPrompt,
        })
      }

      // 执行主循环（由外部调用者负责实际 LLM 调用）
      // 这里返回模板化后的上下文，供 AgentRunner 使用
      return {
        success: true,
        result: '模板已应用，上下文已准备',
        iterations: 0,
        toolCalls: 0,
        workspaceChanges: loopContext.workspaceFiles,
      }
    } catch (err: any) {
      return {
        success: false,
        result: '',
        iterations: loopContext.iteration,
        toolCalls: 0,
        error: err.message,
      }
    } finally {
      this.activeLoops.delete(templateId)
    }
  }

  /**
   * 创建自定义步骤序列
   */
  createStepSequence(steps: LoopStep[]): LoopTemplate {
    const systemPrompt = steps.map((step, i) => {
      return `### Step ${i + 1}: ${step.name}\n${step.description}\n${step.prompt ? `\n${step.prompt}\n` : ''}`
    }).join('\n\n')

    return {
      id: `custom-${Date.now()}`,
      name: 'Custom Sequence',
      description: `自定义步骤序列 (${steps.length} 步)`,
      mode: 'custom',
      systemPrompt,
      maxIterations: steps.reduce((sum, s) => sum + (s.maxIterations || 3), 0),
      stopConditions: steps.map(s => `${s.name} 完成`),
    }
  }

  /** 获取活跃 Loop 上下文 */
  getActiveLoop(templateId: string): LoopContext | undefined {
    return this.activeLoops.get(templateId)
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: LoopEngineering | null = null

export function getLoopEngineering(): LoopEngineering {
  if (!_instance) {
    _instance = new LoopEngineering()
  }
  return _instance
}

export function initLoopEngineering(): LoopEngineering {
  _instance = new LoopEngineering()
  return _instance
}
