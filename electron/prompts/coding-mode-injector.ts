// ============================================================
// prompts/coding-mode-injector.ts — 动态 CodingMode Prompt 注入器
//
// 借鉴 QwenPaw PromptBuilder + CodingModeMixin 设计：
//   - 检测任务类型 → 动态注入对应 prompt
//   - 支持编程 / 审查 / 重构 / Bug 修复等场景模式
//   - 每次 reasoning 前评估是否需要注入/更新
//
// 与旧 systemPrompt.ts 的关系：
//   旧：静态拼接 AGENTS.md + SOUL.md + PROFILE.md
//   新：静态基础 + 动态场景注入
// ============================================================

import type { AgentMessage } from '../tools/types'

// ═══════════════════════════════════════════════════════════
// 场景模式枚举
// ═══════════════════════════════════════════════════════════

export type CodingScenario =
  | 'general'       // 通用编程
  | 'debug'         // Bug 修复
  | 'refactor'      // 重构
  | 'review'        // 代码审查
  | 'implement'     // 新功能实现
  | 'test'          // 写测试
  | 'git'           // Git 操作
  | 'architecture'  // 架构设计

// ═══════════════════════════════════════════════════════════
// 场景检测关键词
// ═══════════════════════════════════════════════════════════

const SCENARIO_TRIGGERS: Record<CodingScenario, string[]> = {
  general: ['写代码', '编程', 'write code', 'implement', '实现'],
  debug: ['bug', '报错', '不工作', '修一下', 'debug', 'fix', '修复', 'error'],
  refactor: ['重构', 'refactor', '整理', '优化结构', 'clean up'],
  review: ['审查', 'review', '看看这段', '检查', 'code review'],
  implement: ['加功能', '添加', '新增', '实现', 'feature', 'add'],
  test: ['测试', 'test', '单元测试', 'test case', '覆盖率'],
  git: ['git', 'commit', '提交', 'push', 'merge', 'rebase'],
  architecture: ['架构', '设计', 'architecture', '方案', 'design'],
}

// ═══════════════════════════════════════════════════════════
// 各场景的专用 Prompt 扩展
// ═══════════════════════════════════════════════════════════

const SCENARIO_PROMPTS: Record<CodingScenario, string> = {
  general: `
## 🔧 Coding Mode（通用编程）

【三步闭环】file_read → file_edit → shell_exec，不可跳过。
【报错协议】读报错→定位行号→改→验证，最多3轮。
【输出规范】不要完整贴代码，一句讲清思路。`.trim(),

  debug: `
## 🐛 Bug 修复模式

【第一步】复现 — 用 shell_exec 跑一遍确认报错
【第二步】定位 — file_read 读报错文件，定位到具体行
【第三步】修复 — file_edit 只改相关行，不要大面积重写
【第四步】验证 — shell_exec 重新运行确认修复

【铁律】
- 先复现，再修复。不复现就改 = 盲修
- 一次只改一个 bug
- 改完后跑完整的测试套件（不只跑那一个 case）
`.trim(),

  refactor: `
## 🔄 重构模式

【第一步】理解现状 — file_read 读目标文件 + 相关引用
【第二步】制定计划 — 创建 REFACTOR_TODO.md
【第三步】小步迭代 — 每一步：改→验证→commit
【第四步】回归验证 — 跑完整测试

【铁律】
- 先理解再动手。不理解就重构 = 制造 bug
- 每步都要验证，不能批量改完再验证
- 保持向后兼容
`.trim(),

  review: `
## 🔍 代码审查模式

【审查维度】
1. 正确性 — 逻辑是否对？边界情况？
2. 安全性 — 注入风险？权限问题？
3. 性能 — 不必要的循环？N+1 查询？
4. 可维护性 — 命名清晰？职责单一？

【输出格式】
- 严重问题（必须修）→ 🔴
- 建议改进 → 🟡
- 风格建议 → 🔵
- 每个问题注明文件和行号
`.trim(),

  implement: `
## 🆕 新功能实现模式

【第一步】明确需求 — 创建 {slug}_TODO.md
【第二步】设计接口 — 函数签名、类型定义
【第三步】实现核心逻辑 — 小步验证
【第四步】集成测试 — 与现有代码联调
【第五步】清理 — 删除调试代码，完善注释

【铁律】
- 先写类型/接口，再写实现
- 每完成一个步骤立即验证
`.trim(),

  test: `
## 🧪 测试模式

【要求】
- 覆盖正常路径 + 边界情况 + 错误路径
- 每个 test case 独立，不依赖执行顺序
- 测试命名：describe('模块', () => { it('应该做什么', () => {}) })

【流程】
1. file_read 读被测文件
2. 写测试文件
3. shell_exec 跑测试
4. 分析失败 case
5. 修复 → 重新跑
`.trim(),

  git: `
## 📦 Git 操作模式

【流程】
1. git_diff 查看当前变更
2. 分析变更内容
3. 写有意义的 commit message（做了什么，不是"fix bug"）
4. commit → 确认 → push

【commit message 格式】
<type>: <简短描述>

类型: feat/fix/refactor/test/docs/chore
`.trim(),

  architecture: `
## 🏗️ 架构设计模式

【分析框架】
1. 现状分析 — 当前架构的问题
2. 方案对比 — 至少 2 个备选方案
3. 推荐方案 — 含理由和风险
4. 实施路径 — 分阶段计划

【输出格式】用表格对比方案，清晰标注推荐
`.trim(),
}

// ═══════════════════════════════════════════════════════════
// CodingModeInjector
// ═══════════════════════════════════════════════════════════

export class CodingModeInjector {
  private activeScenario: CodingScenario | null = null
  private injected = false

  // ═════════════════════════════════════════════════════════
  // 场景检测
  // ═════════════════════════════════════════════════════════

  /**
   * 从用户输入中检测编程场景
   */
  detectScenario(userInput: string): CodingScenario | null {
    const lower = userInput.toLowerCase()

    // 按优先级检测（更具体的场景优先）
    const priorityOrder: CodingScenario[] = [
      'debug',
      'review',
      'git',
      'test',
      'refactor',
      'architecture',
      'implement',
      'general',
    ]

    for (const scenario of priorityOrder) {
      const triggers = SCENARIO_TRIGGERS[scenario]
      if (triggers.some(t => lower.includes(t))) {
        return scenario
      }
    }

    return null
  }

  // ═════════════════════════════════════════════════════════
  // 动态注入
  // ═════════════════════════════════════════════════════════

  /**
   * 获取 CodingMode prompt（根据检测到的场景）
   */
  getCodingModePrompt(userInput: string): string | null {
    const scenario = this.detectScenario(userInput)
    if (!scenario) return null

    this.activeScenario = scenario
    return SCENARIO_PROMPTS[scenario]
  }

  /**
   * 将 CodingMode prompt 注入到 system prompt 中
   * @returns 修改后的 messages（新增了 system prompt），或 null 表示无需注入
   */
  inject(messages: AgentMessage[], userInput: string): AgentMessage[] | null {
    const prompt = this.getCodingModePrompt(userInput)
    if (!prompt || this.injected) return null

    this.injected = true

    // 检查是否已包含 CodingMode
    const systemMsg = messages[0]
    if (systemMsg && systemMsg.role === 'system') {
      if (systemMsg.content.includes('Coding Mode')) return null
      systemMsg.content = systemMsg.content + '\n\n' + prompt
      return messages
    }

    return null
  }

  /**
   * 获取当前激活的编程场景
   */
  getActiveScenario(): CodingScenario | null {
    return this.activeScenario
  }

  /**
   * 重置注入状态（新的编程任务时调用）
   */
  reset(): void {
    this.activeScenario = null
    this.injected = false
  }
}
