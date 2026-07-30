// ============================================================
// manualSystem.ts — 说明书/知识库系统 (v2.5)
//
// 借鉴 Hiyori: 将操作流程编写为 Markdown 说明书，
// 动态注入 System Prompt，让 AI 更懂特定操作
//
// 设计:
//   1. 说明书存放在 electron/manual/ 目录
//   2. 每份说明书包含: 标题、适用场景、步骤流程、注意事项
//   3. Agent 模式运行时，根据任务关键词自动匹配说明书
//   4. 匹配到的说明书内容注入 System Prompt
// ============================================================

import fs from 'fs'
import path from 'path'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface ManualEntry {
  id: string
  title: string
  description: string
  keywords: string[]
  content: string
  priority: number
}

// ═══════════════════════════════════════════════════════════
// 内置说明书
// ═══════════════════════════════════════════════════════════

const BUILTIN_MANUALS: ManualEntry[] = [
  // ── 浏览器操作 ─────────────────────────────────
  {
    id: 'browser-search',
    title: '浏览器搜索流程',
    description: '使用浏览器搜索信息并分析结果的标准流程',
    keywords: ['搜索', '查找', '浏览器', 'search', 'bing', 'google', '百度'],
    priority: 8,
    content: `## 浏览器搜索标准流程

### 步骤
1. **打开浏览器**: 使用 browser 工具，command: "open https://www.bing.com/search?q=关键词"
2. **查看结果**: command: "snapshot" 获取搜索页面内容
3. **打开详情**: 如果某个结果看起来有用，command: "navigate to URL" 
4. **提取内容**: 使用 web_fetch 工具获取页面纯文本
5. **总结分析**: 基于提取的内容给出答案

### 注意事项
- 优先使用 Bing/DuckDuckGo，避免依赖单一搜索引擎
- 多个关键词可并行搜索（使用 web_search_multi Skill）
- 搜索结果可能有过时信息，注意时效性`,
  },

  // ── 文件操作 ─────────────────────────────────
  {
    id: 'file-operations',
    title: '文件操作最佳实践',
    description: '安全操作文件的标准流程',
    keywords: ['文件', '读写', '编辑', '创建', '删除', 'file', '保存'],
    priority: 9,
    content: `## 文件操作标准流程

### 安全原则
1. **先读后写**: 修改前必须用 file_read 读取原内容
2. **备份意识**: 重要文件修改前建议先备份
3. **确认后删除**: 删除操作必须经用户确认
4. **路径检查**: 确保路径在工作目录或用户明确指定的范围内

### 标准操作流程
1. 读取文件: \`file_read(path="文件路径")\`
2. 分析内容
3. 用 file_edit 精确修改（优于 file_write 全量覆盖）
4. 修改后确认结果

### 编码注意事项
- Windows 中文路径使用 UTF-8 编码
- 跨平台路径使用 / 或 path.join()`,
  },

  // ── 代码开发 ─────────────────────────────────
  {
    id: 'code-development',
    title: '代码开发工作流',
    description: '在 Lumina 中进行代码开发的标准工作流',
    keywords: ['代码', '编程', '开发', '写代码', 'debug', '调试', '重构', 'code'],
    priority: 7,
    content: `## 代码开发标准工作流

### 1. 理解需求
- 先理解用户要做什么，不要急于写代码
- 确认技术栈（TypeScript/Python/Java/等）

### 2. 读取上下文
- file_read 读取相关文件
- file_list 了解项目结构
- 理解现有代码后再修改

### 3. 实施修改
- 优先使用 file_edit（精确修改）而非 file_write（全量覆盖）
- 保持代码风格一致
- 添加必要的注释

### 4. Git 管理
- git_status 查看变更
- git_diff 确认修改内容
- git_commit 提交（写清晰的 commit message）

### 5. 工具使用
- shell_exec 运行编译/测试命令
- 使用 code_review_smart Skill 自查代码质量`,
  },

  // ── 系统操作 ─────────────────────────────────
  {
    id: 'system-operations',
    title: '系统操作指南',
    description: '执行系统级操作的标准流程',
    keywords: ['系统', '关机', '重启', '进程', '任务', '安装', '配置', 'system'],
    priority: 6,
    content: `## 系统操作标准流程

### Shell 命令使用
- 优先用 shell_exec 执行命令
- 危险操作（rm -rf, format, del /f 等）必须先确认
- Windows 命令用 cmd 语法，Linux/macOS 用 bash 语法
- 长时间命令设置合理的 timeout

### 进程管理
- system_info 查看系统状态
- process_list 查看运行中的进程
- 结束进程前确认进程名

### 快捷操作
- keyboard_press 模拟按键（如 Win+R 打开运行）
- keyboard_type 输入文本到当前窗口
- desktop_click 点击桌面元素`,
  },

  // ── 多Agent协作 ────────────────────────────────
  {
    id: 'multi-agent-workflow',
    title: '多Agent协作工作流',
    description: '使用多Agent系统完成复杂任务',
    keywords: ['多Agent', '协作', '多个Agent', 'orchestrator', '任务分解'],
    priority: 5,
    content: `## 多Agent协作标准流程

### 适用场景
- 复杂任务需要多视角分析
- 代码审查 + 文档编写同时进行
- 研究 + 实现并行

### 使用方式
- orchestrator:execute 启动协作
- 任务自动分解为子任务
- Researcher/Coder/Writer/Assistant 四角色分工
- 结果自动汇总`,
  },
]

// ═══════════════════════════════════════════════════════════
// 说明书管理器
// ═══════════════════════════════════════════════════════════

export class ManualSystem {
  private manuals: ManualEntry[] = []

  constructor() {
    this.manuals = [...BUILTIN_MANUALS]
    this.loadExternalManuals()
  }

  /** 加载外部说明书文件 */
  private loadExternalManuals(): void {
    try {
      const manualDir = path.join(process.cwd(), 'electron', 'manual')
      if (!fs.existsSync(manualDir)) {
        // 自动创建目录和示例文件
        fs.mkdirSync(manualDir, { recursive: true })
        this.writeExampleManual(manualDir)
        return
      }

      const files = fs.readdirSync(manualDir).filter(f => f.endsWith('.md'))
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(manualDir, file), 'utf-8')
          const entry = this.parseManualFile(content, file)
          if (entry) this.manuals.push(entry)
        } catch (err) {
          console.warn(`[ManualSystem] 解析说明书失败: ${file}`, err)
        }
      }
    } catch (err) {
      console.warn('[ManualSystem] 加载外部说明书失败:', err)
    }
  }

  /** 写入示例说明书 */
  private writeExampleManual(dir: string): void {
    const example = `---
id: custom-example
title: 自定义操作流程
description: 这是一个示例说明书，修改它来添加你的操作流程
keywords: [示例, example]
priority: 1
---

## 自定义操作流程

在这里编写你的操作步骤...

### 步骤 1
描述第一步

### 步骤 2
描述第二步

### 注意事项
- 注意事项 1
- 注意事项 2
`
    fs.writeFileSync(path.join(dir, 'example-manual.md'), example, 'utf-8')
  }

  /** 解析说明书文件 (YAML front matter + Markdown) */
  private parseManualFile(content: string, filename: string): ManualEntry | null {
    const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!frontMatterMatch) return null

    const frontMatter = frontMatterMatch[1]
    const body = frontMatterMatch[2]

    // 简单解析 YAML front matter (不用 yaml 库，保持零依赖)
    const extract = (key: string): string => {
      const match = frontMatter.match(new RegExp(`${key}:\\s*(.+)`))
      return match ? match[1].trim() : ''
    }
    const extractList = (key: string): string[] => {
      const match = frontMatter.match(new RegExp(`${key}:\\s*\\[(.+?)\\]`))
      if (!match) return []
      return match[1].split(',').map(s => s.trim())
    }

    return {
      id: extract('id') || filename.replace('.md', ''),
      title: extract('title') || filename.replace('.md', ''),
      description: extract('description') || '',
      keywords: extractList('keywords'),
      content: body.trim(),
      priority: parseInt(extract('priority')) || 1,
    }
  }

  // ── 搜索与注入 ───────────────────────────────────────

  /**
   * 根据任务描述匹配相关说明书
   * @param taskDescription 任务描述文本
   * @param maxManuals 最多返回份数
   * @returns 匹配到的说明书内容，按优先级排序
   */
  searchRelevant(taskDescription: string, maxManuals = 3): string {
    const scored = this.manuals
      .map(m => {
        let score = 0
        const lowerTask = taskDescription.toLowerCase()
        for (const kw of m.keywords) {
          if (lowerTask.includes(kw.toLowerCase())) {
            score += 10
          }
        }
        // 标题部分匹配额外加分
        if (lowerTask.includes(m.title.toLowerCase())) score += 20
        score += m.priority
        return { manual: m, score }
      })
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxManuals)

    if (scored.length === 0) return ''

    return scored
      .map(s => `【${s.manual.title}】\n${s.manual.content}`)
      .join('\n\n---\n\n')
  }

  /**
   * 生成注入到 System Prompt 的知识上下文
   */
  getKnowledgeContext(taskDescription?: string): string {
    if (!taskDescription) return ''

    const relevant = this.searchRelevant(taskDescription)
    if (!relevant) return ''

    return `\n【操作知识库】\n以下是你掌握的标准化操作流程，请参考执行：\n\n${relevant}\n`
  }

  /** 获取所有说明书列表 */
  listManuals(): { id: string; title: string; description: string; keywords: string[] }[] {
    return this.manuals.map(m => ({
      id: m.id,
      title: m.title,
      description: m.description,
      keywords: m.keywords,
    }))
  }

  /** 获取完整说明书内容 */
  getManual(id: string): ManualEntry | undefined {
    return this.manuals.find(m => m.id === id)
  }

  /** 添加动态说明书 */
  addManual(entry: ManualEntry): void {
    const idx = this.manuals.findIndex(m => m.id === entry.id)
    if (idx >= 0) {
      this.manuals[idx] = entry
    } else {
      this.manuals.push(entry)
    }
  }

  /** 删除说明书 */
  removeManual(id: string): boolean {
    const idx = this.manuals.findIndex(m => m.id === id)
    if (idx >= 0) {
      this.manuals.splice(idx, 1)
      return true
    }
    return false
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _manualSystem: ManualSystem | null = null

export function getManualSystem(): ManualSystem {
  if (!_manualSystem) {
    _manualSystem = new ManualSystem()
  }
  return _manualSystem
}
