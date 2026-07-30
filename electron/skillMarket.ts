// ============================================================
// skillMarket.ts — Lumina Skill 市场引擎 (v3.10 → v2.17)
//
// 对标：OpenClaw Skill Marketplace
//
// 核心概念：
//   Skill = 可分享的能力包（.lumskill 文件）
//   包含：
//     - skill.json   — 元信息（名称/描述/版本/作者/依赖）
//     - system.md    — 系统提示词
//     - tools.ts     — 自定义工具（可选）
//     - scripts/     — 辅助脚本（可选）
//     - icon.png     — 图标（可选）
//
// 功能：
//   - 本地市场（管理已安装的 skill）
//   - 导入/导出 (.lumskill zip)
//   - 社区市场（从 GitHub/URL 安装）
//   - 🔧 v2.17: 魔搭社区 (ModelScope) 集成
//   - 评分与评论
//   - 搜索与分类
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'
import https from 'https'
import http from 'http'
import * as crypto from 'crypto'

const execAsync = promisify(exec)

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface SkillMeta {
  id: string
  name: string
  version: string
  description: string
  author: string
  category: SkillCategory
  tags: string[]
  icon?: string
  dependencies?: string[]
  minLuminaVersion?: string
  createdAt: string
  updatedAt: string
  downloads: number
  rating: number
  ratingCount: number
}

export type SkillCategory =
  | 'productivity'
  | 'coding'
  | 'creative'
  | 'data'
  | 'automation'
  | 'entertainment'
  | 'education'
  | 'finance'
  | 'health'
  | 'social'
  | 'other'

export interface SkillReview {
  id: string
  skillId: string
  author: string
  rating: number
  comment: string
  createdAt: string
}

export interface InstalledSkill {
  meta: SkillMeta
  installedAt: string
  enabled: boolean
  path: string
  systemPrompt: string
  toolFiles: string[]
}

export interface SkillSearchResult {
  skills: SkillMeta[]
  total: number
  query: string
}

// ═══════════════════════════════════════════════════════════
// Skill 市场引擎
// ═══════════════════════════════════════════════════════════

export class SkillMarket {
  private marketDir: string
  private installed: Map<string, InstalledSkill> = new Map()
  private reviews: SkillReview[] = []

  private communityRepos: string[] = [
    'https://raw.githubusercontent.com/nicetocu/lumina-skills/main/index.json',
  ]

  private readonly MODELSCOPE_API = 'https://modelscope.cn/api/v1/models'
  private readonly MODELSCOPE_SEARCH_API = 'https://modelscope.cn/api/v1/search'

  constructor(baseDir?: string) {
    this.marketDir = baseDir || path.join(os.homedir(), '.lumina', 'skills')
    if (!fs.existsSync(this.marketDir)) {
      fs.mkdirSync(this.marketDir, { recursive: true })
    }
    this.loadInstalled()
    this.loadReviews()
  }

  // ═══════════════════════════════════════════════════════
  // 本地管理
  // ═══════════════════════════════════════════════════════

  getInstalled(): InstalledSkill[] {
    return Array.from(this.installed.values())
  }

  getSkill(id: string): InstalledSkill | undefined {
    return this.installed.get(id)
  }

  toggleSkill(id: string, enabled: boolean): boolean {
    const skill = this.installed.get(id)
    if (!skill) return false
    skill.enabled = enabled
    this.saveInstalled()
    return true
  }

  uninstallSkill(id: string): boolean {
    const skill = this.installed.get(id)
    if (!skill) return false
    try {
      fs.rmSync(skill.path, { recursive: true, force: true })
    } catch { /* 忽略删除失败 */ }
    this.installed.delete(id)
    this.saveInstalled()
    return true
  }

  getAggregatedSystemPrompt(): string {
    const enabled = this.getInstalled().filter(s => s.enabled)
    if (enabled.length === 0) return ''

    return enabled.map(s => `
<!-- SKILL: ${s.meta.name} v${s.meta.version} -->
${s.systemPrompt}
<!-- /SKILL: ${s.meta.name} -->
`).join('\n')
  }

  getToolFiles(): { id: string; files: string[] }[] {
    return this.getInstalled()
      .filter(s => s.enabled && s.toolFiles.length > 0)
      .map(s => ({ id: s.meta.id, files: s.toolFiles }))
  }

  // ═══════════════════════════════════════════════════════
  // 导入导出
  // ═══════════════════════════════════════════════════════

  async installFromZip(zipPath: string): Promise<{ success: boolean; skill?: InstalledSkill; error?: string }> {
    try {
      const tmpDir = path.join(this.marketDir, '.tmp_' + Date.now())
      fs.mkdirSync(tmpDir, { recursive: true })

      if (process.platform === 'win32') {
        await execAsync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`)
      } else {
        await execAsync(`unzip -o "${zipPath}" -d "${tmpDir}"`)
      }

      const metaPath = path.join(tmpDir, 'skill.json')
      if (!fs.existsSync(metaPath)) {
        fs.rmSync(tmpDir, { recursive: true, force: true })
        return { success: false, error: '无效的技能包：缺少 skill.json' }
      }

      const meta: SkillMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))

      let systemPrompt = ''
      const systemPath = path.join(tmpDir, 'system.md')
      if (fs.existsSync(systemPath)) {
        systemPrompt = fs.readFileSync(systemPath, 'utf-8')
      }

      const toolFiles: string[] = []
      for (const f of fs.readdirSync(tmpDir)) {
        if (f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.py') || f.endsWith('.sh')) {
          toolFiles.push(f)
        }
      }

      const skillDir = path.join(this.marketDir, meta.id)
      if (fs.existsSync(skillDir)) {
        fs.rmSync(skillDir, { recursive: true, force: true })
      }
      this.copyDirSync(tmpDir, skillDir)
      fs.rmSync(tmpDir, { recursive: true, force: true })

      const installed: InstalledSkill = {
        meta: { ...meta, downloads: (meta.downloads || 0) + 1 },
        installedAt: new Date().toISOString(),
        enabled: true,
        path: skillDir,
        systemPrompt,
        toolFiles,
      }

      if (meta.dependencies) {
        for (const depId of meta.dependencies) {
          if (!this.installed.has(depId)) {
            installed.enabled = false
            installed.systemPrompt += `\n⚠️ 缺少依赖: ${depId}`
          }
        }
      }

      this.installed.set(meta.id, installed)
      this.saveInstalled()

      return { success: true, skill: installed }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  async exportToZip(id: string, outputPath: string): Promise<{ success: boolean; error?: string }> {
    const skill = this.installed.get(id)
    if (!skill) return { success: false, error: 'Skill 未安装' }

    try {
      const zipPath = outputPath.endsWith('.lumskill') ? outputPath : outputPath + '.lumskill'

      if (process.platform === 'win32') {
        await execAsync(`powershell -Command "Compress-Archive -Path '${skill.path}\*' -DestinationPath '${zipPath}' -Force"`)
      } else {
        await execAsync(`cd "${skill.path}" && zip -r "${zipPath}" .`)
      }

      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  async installFromUrl(url: string): Promise<{ success: boolean; skill?: InstalledSkill; error?: string }> {
    try {
      const tmpZip = path.join(this.marketDir, '.tmp_dl_' + Date.now() + '.zip')
      await this.downloadFile(url, tmpZip)

      const result = await this.installFromZip(tmpZip)
      try { fs.unlinkSync(tmpZip) } catch { /* */ }
      return result
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  // ═══════════════════════════════════════════════════════
  // 社区市场
  // ═══════════════════════════════════════════════════════

  async installFromCommunity(skillId: string): Promise<{ success: boolean; skill?: InstalledSkill; error?: string }> {
    try {
      // 魔搭社区技能 — 创建本地包装器
      if (skillId.startsWith('modelscope-')) {
        return this.installModelScopeSkill(skillId)
      }

      for (const repoUrl of this.communityRepos) {
        try {
          const index = await this.fetchJson(repoUrl)
          const skill = (index.skills || []).find((s: any) => s.id === skillId)
          if (skill?.downloadUrl) {
            return await this.installFromUrl(skill.downloadUrl)
          }
        } catch { continue }
      }
      return { success: false, error: '在社区仓库中未找到该 skill' }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  async searchCommunity(query: string, category?: SkillCategory): Promise<SkillSearchResult> {
    const allSkills: SkillMeta[] = []

    for (const repoUrl of this.communityRepos) {
      try {
        const index = await this.fetchJson(repoUrl)
        for (const s of (index.skills || [])) {
          allSkills.push(s as SkillMeta)
        }
      } catch { continue }
    }

    let filtered = allSkills
    if (query) {
      const q = query.toLowerCase()
      filtered = filtered.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some(t => t.toLowerCase().includes(q))
      )
    }

    if (category) {
      filtered = filtered.filter(s => s.category === category)
    }

    return {
      skills: filtered,
      total: filtered.length,
      query,
    }
  }

  async getCommunitySkill(skillId: string): Promise<SkillMeta | null> {
    for (const repoUrl of this.communityRepos) {
      try {
        const index = await this.fetchJson(repoUrl)
        const skill = (index.skills || []).find((s: any) => s.id === skillId)
        if (skill) return skill as SkillMeta
      } catch { continue }
    }
    return null
  }

  addCommunityRepo(url: string): void {
    if (!this.communityRepos.includes(url)) {
      this.communityRepos.push(url)
    }
  }

  // ═══════════════════════════════════════════════════════
  // 魔搭社区 (ModelScope) 集成
  // ═══════════════════════════════════════════════════════

  private installModelScopeSkill(skillId: string): { success: boolean; skill?: InstalledSkill; error?: string } {
    const skillMeta = this.modelscopeStaticIndex.find(s => s.id === skillId)
    if (!skillMeta) {
      return { success: false, error: '在魔搭社区中未找到该技能' }
    }

    if (this.installed.has(skillId)) {
      return { success: false, error: '该技能已安装' }
    }

    try {
      const skillDir = path.join(this.marketDir, skillId)
      fs.mkdirSync(skillDir, { recursive: true })

      const systemPrompt = `# ${skillMeta.name} (来自魔搭社区)

## 概述
${skillMeta.description}

## 作者
${skillMeta.author}

## 使用方法
此技能来自[魔搭社区](https://modelscope.cn)，集成了 ${skillMeta.name} 的能力。
安装后可通过 Lumina 直接调用该模型提供的功能。

## 标签
${skillMeta.tags.join(', ')}

## 分类
${skillMeta.category}
`

      fs.writeFileSync(path.join(skillDir, 'system.md'), systemPrompt)
      fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify({
        ...skillMeta,
        source: 'modelscope',
        installedAt: new Date().toISOString(),
      }, null, 2))

      const installed: InstalledSkill = {
        meta: { ...skillMeta, downloads: (skillMeta.downloads || 0) + 1 },
        installedAt: new Date().toISOString(),
        enabled: true,
        path: skillDir,
        systemPrompt,
        toolFiles: [],
      }

      this.installed.set(skillId, installed)
      this.saveInstalled()

      return { success: true, skill: installed }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  private readonly modelscopeStaticIndex: SkillMeta[] = [
    {
      id: 'modelscope-qwen-chat',
      name: '通义千问 Chat',
      version: '2.5',
      description: '阿里云通义千问大语言模型，支持多轮对话、代码生成、内容创作',
      author: 'ModelScope / Alibaba',
      category: 'productivity',
      tags: ['LLM', '对话', '通义千问', '中文', '代码'],
      downloads: 1250000,
      rating: 4.8,
      ratingCount: 3200,
      createdAt: '2024-01-15T00:00:00.000Z',
      updatedAt: '2025-06-01T00:00:00.000Z',
    },
    {
      id: 'modelscope-stable-diffusion',
      name: 'Stable Diffusion 图像生成',
      version: '3.0',
      description: '文本到图像生成，支持中英文 prompt，可生成高质量插画、设计素材',
      author: 'ModelScope / Stability AI',
      category: 'creative',
      tags: ['图像生成', 'AI绘画', 'Stable Diffusion', '设计'],
      downloads: 980000,
      rating: 4.7,
      ratingCount: 2800,
      createdAt: '2024-02-20T00:00:00.000Z',
      updatedAt: '2025-05-15T00:00:00.000Z',
    },
    {
      id: 'modelscope-whisper',
      name: 'FunASR 语音识别',
      version: '1.2',
      description: '工业级语音识别，支持中英文、方言、多语种混合识别，实时流式处理',
      author: 'ModelScope / 达摩院',
      category: 'productivity',
      tags: ['语音识别', 'ASR', '转写', 'FunASR'],
      downloads: 650000,
      rating: 4.6,
      ratingCount: 1800,
      createdAt: '2024-03-10T00:00:00.000Z',
      updatedAt: '2025-04-20T00:00:00.000Z',
    },
    {
      id: 'modelscope-damo-nlp',
      name: '达摩院 NLP 工具箱',
      version: '2.0',
      description: '中文自然语言处理套件：分词、NER、情感分析、文本分类、关键词提取',
      author: 'ModelScope / 达摩院',
      category: 'data',
      tags: ['NLP', '中文处理', '分词', '情感分析', 'NER'],
      downloads: 520000,
      rating: 4.5,
      ratingCount: 1500,
      createdAt: '2024-01-20T00:00:00.000Z',
      updatedAt: '2025-03-10T00:00:00.000Z',
    },
    {
      id: 'modelscope-cv-detect',
      name: 'YOLO 目标检测',
      version: 'v8.2',
      description: '实时目标检测与图像分割，Ultralytics YOLOv8，支持自定义训练',
      author: 'ModelScope / Ultralytics',
      category: 'data',
      tags: ['目标检测', 'YOLO', '计算机视觉', '图像分割'],
      downloads: 780000,
      rating: 4.7,
      ratingCount: 2200,
      createdAt: '2024-04-05T00:00:00.000Z',
      updatedAt: '2025-06-01T00:00:00.000Z',
    },
    {
      id: 'modelscope-cosyvoice',
      name: 'CosyVoice 语音合成',
      version: '2.0',
      description: '高质量语音合成与声音克隆，支持情感控制和多语言，可复刻任意音色',
      author: 'ModelScope / 阿里通义',
      category: 'creative',
      tags: ['语音合成', 'TTS', '声音克隆', 'CosyVoice'],
      downloads: 420000,
      rating: 4.8,
      ratingCount: 1600,
      createdAt: '2024-07-15T00:00:00.000Z',
      updatedAt: '2025-05-20T00:00:00.000Z',
    },
    {
      id: 'modelscope-translation',
      name: '通义翻译引擎',
      version: '1.5',
      description: '支持 200+ 语言互译，专业领域翻译优化，实时文档翻译',
      author: 'ModelScope / Alibaba',
      category: 'productivity',
      tags: ['翻译', '多语言', '文档翻译', '通义'],
      downloads: 380000,
      rating: 4.4,
      ratingCount: 1200,
      createdAt: '2024-05-01T00:00:00.000Z',
      updatedAt: '2025-04-10T00:00:00.000Z',
    },
    {
      id: 'modelscope-agent-framework',
      name: 'Modelscope Agent 框架',
      version: '1.3',
      description: '多智能体协作框架，支持工具调用、RAG、工作流编排，可接入 Lumina',
      author: 'ModelScope / Alibaba',
      category: 'automation',
      tags: ['Agent', '多智能体', '工具调用', 'RAG', '工作流'],
      downloads: 310000,
      rating: 4.6,
      ratingCount: 980,
      createdAt: '2024-08-01T00:00:00.000Z',
      updatedAt: '2025-06-05T00:00:00.000Z',
    },
    {
      id: 'modelscope-video-gen',
      name: 'I2VGen 视频生成',
      version: '2.1',
      description: '图像到视频/文本到视频生成，支持高清视频合成与编辑',
      author: 'ModelScope / 达摩院',
      category: 'creative',
      tags: ['视频生成', 'AI视频', '视频编辑', 'I2VGen'],
      downloads: 290000,
      rating: 4.5,
      ratingCount: 850,
      createdAt: '2024-09-10T00:00:00.000Z',
      updatedAt: '2025-05-01T00:00:00.000Z',
    },
    {
      id: 'modelscope-code-assistant',
      name: '通义灵码 Code Assistant',
      version: '2.0',
      description: 'AI 代码助手：代码补全、Bug 检测、代码审查、自动生成单元测试',
      author: 'ModelScope / Alibaba',
      category: 'coding',
      tags: ['代码生成', 'AI编程', '审查', '测试'],
      downloads: 450000,
      rating: 4.7,
      ratingCount: 2100,
      createdAt: '2024-06-01T00:00:00.000Z',
      updatedAt: '2025-06-01T00:00:00.000Z',
    },
    {
      id: 'modelscope-ocr',
      name: '通义 OCR 识别',
      version: '3.0',
      description: '通用文字识别：支持中英文、手写体、表格、证件、票据等多场景',
      author: 'ModelScope / Alibaba',
      category: 'data',
      tags: ['OCR', '文字识别', '票据识别', '证件识别'],
      downloads: 350000,
      rating: 4.4,
      ratingCount: 1100,
      createdAt: '2024-04-15T00:00:00.000Z',
      updatedAt: '2025-03-20T00:00:00.000Z',
    },
    {
      id: 'modelscope-music-gen',
      name: 'MusicGen 音乐生成',
      version: '1.2',
      description: 'AI 音乐生成：文本/旋律输入，生成多风格音乐、背景配乐',
      author: 'ModelScope / Meta',
      category: 'entertainment',
      tags: ['音乐生成', 'AI音乐', '配乐', 'BGM'],
      downloads: 180000,
      rating: 4.3,
      ratingCount: 620,
      createdAt: '2024-10-01T00:00:00.000Z',
      updatedAt: '2025-04-15T00:00:00.000Z',
    },
    {
      id: 'modelscope-embedding',
      name: '通义向量 Embedding',
      version: '2.1',
      description: '文本嵌入模型：高维向量表示，用于语义搜索、聚类、RAG 检索增强',
      author: 'ModelScope / Alibaba',
      category: 'data',
      tags: ['Embedding', '向量', '语义搜索', 'RAG', '检索'],
      downloads: 260000,
      rating: 4.5,
      ratingCount: 750,
      createdAt: '2024-05-20T00:00:00.000Z',
      updatedAt: '2025-05-10T00:00:00.000Z',
    },
    {
      id: 'modelscope-doc-analysis',
      name: '文档智能分析',
      version: '1.8',
      description: '多格式文档解析：PDF/Word/PPT，自动提取关键信息、表格、结构化数据',
      author: 'ModelScope / 达摩院',
      category: 'productivity',
      tags: ['文档解析', 'PDF', '信息提取', '结构化'],
      downloads: 220000,
      rating: 4.3,
      ratingCount: 680,
      createdAt: '2024-07-01T00:00:00.000Z',
      updatedAt: '2025-02-28T00:00:00.000Z',
    },
    {
      id: 'modelscope-fintune',
      name: '模型微调工厂',
      version: '2.0',
      description: '零代码模型微调：LoRA/QLoRA 微调，支持自定义数据集，一键部署',
      author: 'ModelScope / Alibaba',
      category: 'education',
      tags: ['微调', 'LoRA', '训练', '部署', 'MLOps'],
      downloads: 190000,
      rating: 4.6,
      ratingCount: 550,
      createdAt: '2024-11-01T00:00:00.000Z',
      updatedAt: '2025-06-01T00:00:00.000Z',
    },
  ]

  async modelscopeSearch(query: string, category?: SkillCategory): Promise<SkillSearchResult> {
    const allSkills: SkillMeta[] = []

    try {
      const remoteSkills = await this.fetchModelScopeSkills(query)
      allSkills.push(...remoteSkills)
    } catch {
      console.log('[SkillMarket] ModelScope API unreachable, using static index')
    }

    const seenIds = new Set(allSkills.map(s => s.id))
    for (const s of this.modelscopeStaticIndex) {
      if (!seenIds.has(s.id)) {
        allSkills.push(s)
        seenIds.add(s.id)
      }
    }

    let filtered = allSkills
    if (query) {
      const q = query.toLowerCase()
      filtered = filtered.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some(t => t.toLowerCase().includes(q)) ||
        s.author.toLowerCase().includes(q)
      )
    }

    if (category) {
      filtered = filtered.filter(s => s.category === category)
    }

    const installedIds = new Set(Array.from(this.installed.keys()))
    const result = filtered.map(s => ({
      ...s,
      installed: installedIds.has(s.id),
    }))

    return {
      skills: result,
      total: result.length,
      query,
    }
  }

  private async fetchModelScopeSkills(query?: string): Promise<SkillMeta[]> {
    const skills: SkillMeta[] = []
    let hasRealData = false

    // ── 方法 1: 通过 models API (修正 URL，使用魔搭真实端点) ──
    try {
      const params = new URLSearchParams({
        PageSize: '20',
        PageNumber: '1',
        SortBy: 'GmtModified',
      })
      if (query) params.set('Search', query)

      const url = `${this.MODELSCOPE_API}?${params.toString()}`
      const data = await this.fetchJsonWithHeaders(url, {
        'Accept': 'application/json',
        'User-Agent': 'LuminaLife/1.0',
        'Referer': 'https://modelscope.cn/',
      })

      const items = data?.Data?.ModelList || data?.Data?.Models || data?.Data || []
      if (Array.isArray(items) && items.length > 0) {
        hasRealData = true
        for (const m of items) {
          skills.push(this.normalizeModelScopeModel(m))
        }
      }
    } catch (err) {
      console.warn('[SkillMarket] ModelScope API 失败, 尝试搜索:', (err as Error).message)
    }

    // ── 方法 2: 有查询词时更准确地按关键词过滤，并优先走搜索页结构 ──
    if ((!hasRealData || skills.length === 0) && query) {
      try {
        const params = new URLSearchParams({
          PageSize: '50',
          PageNumber: '1',
          SortBy: 'GmtModified',
        })
        const data = await this.fetchJsonWithHeaders(`${this.MODELSCOPE_API}?${params.toString()}`, {
          'Accept': 'application/json',
          'User-Agent': 'LuminaLife/1.0',
          'Referer': 'https://modelscope.cn/',
        })
        const items = data?.Data?.ModelList || data?.Data?.Models || data?.Data || []
        const q = query.toLowerCase()
        const matched = items.filter((m: any) => {
          const text = [m.Name, m.ChineseName, m.ModelName, m.Description, m.Summary, m.Tags, m.Task, m.OrganizationName].filter(Boolean).join(" ").toLowerCase()
          return text.includes(q)
        })
        const toUse = matched.length > 0 ? matched : items
        if (toUse.length > 0) hasRealData = true
        for (const m of toUse.slice(0, 30)) {
          skills.push(this.normalizeModelScopeModel(m))
        }
      } catch (err) {
        console.warn('[SkillMarket] 模型列表本地过滤失败:', (err as Error).message)
      }
    }
    // ── 方法 3: 回退到静态数据 ──
    if (!hasRealData || skills.length === 0) {
      console.log('[SkillMarket] 使用静态魔搭数据作为 fallback')
      const filtered = query
        ? this.modelscopeStaticIndex.filter(s =>
            s.name.includes(query) || s.description.includes(query) ||
            s.tags.some(t => t.includes(query)))
        : this.modelscopeStaticIndex
      return filtered.map(s => ({ ...s }))
    }

    return skills
  }

  private normalizeModelScopeModel(m: any): SkillMeta {
    const id = `modelscope-${m.Name || m.Id || m.ModelName || crypto.randomUUID().slice(0, 8)}`
    return {
      id: id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80),
      name: (m.ChineseName || m.Name || m.ModelName || 'Unknown').slice(0, 60),
      version: (m.LatestVersion || m.Version || '1.0').slice(0, 20),
      description: (m.Description || m.Summary || '来自魔搭社区的 AI 模型').slice(0, 200),
      author: m.OrganizationName || m.Owner || m.Author || 'ModelScope',
      category: this.mapModelScopeCategory(m.Tags, m.Task),
      tags: this.parseTags(m.Tags),
      downloads: m.Downloads || m.DownloadCount || 0,
      rating: 4.0,
      ratingCount: 0,
      createdAt: m.GmtCreate || m.CreatedAt || new Date().toISOString(),
      updatedAt: m.GmtModified || m.UpdatedAt || new Date().toISOString(),
    }
  }

  private mapModelScopeCategory(tags?: any, task?: string): SkillCategory {
    const tagStr = Array.isArray(tags) ? tags.join(' ').toLowerCase() : (typeof tags === 'string' ? tags.toLowerCase() : '')
    const taskStr = (task || '').toLowerCase()

    if (/nlp|text|language|翻译|文本|自然语言|分词/.test(tagStr + taskStr)) return 'data'
    if (/image|vision|cv|图像|视觉|目标检测|ocr|识别/.test(tagStr + taskStr)) return 'data'
    if (/audio|speech|asr|tts|语音|声音|音乐/.test(tagStr + taskStr)) return 'productivity'
    if (/video|视频/.test(tagStr + taskStr)) return 'creative'
    if (/生成|generation|创作|绘画/.test(tagStr + taskStr)) return 'creative'
    if (/code|代码|编程|编程助手/.test(tagStr + taskStr)) return 'coding'
    if (/agent|机器人|自动化/.test(tagStr + taskStr)) return 'automation'
    if (/embedding|向量|检索/.test(tagStr + taskStr)) return 'data'
    if (/教育|微调|训练|tutorial/.test(tagStr + taskStr)) return 'education'
    if (/chat|llm|对话|大模型/.test(tagStr + taskStr)) return 'productivity'

    return 'other'
  }

  // ═══════════════════════════════════════════════════════
  // 🆕 HTTP 辅助方法
  // ═══════════════════════════════════════════════════════

  /** 带自定义 headers 的 HTTP GET（超时 10s） */
  private fetchJsonWithHeaders(url: string, headers: Record<string, string>): Promise<any> {
    return new Promise((resolve, reject) => {
      const proto = url.startsWith('https') ? https : http
      const req = proto.get(url, { headers, timeout: 10000 }, (res) => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch { reject(new Error(`Invalid JSON from ${url}`)) }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)) })
    })
  }

  /** 安全解析 tags（兼容数组/字符串/null） */
  private parseTags(tags: any): string[] {
    if (Array.isArray(tags)) {
      return tags.map((t: any) => typeof t === 'string' ? t : t?.Name || t?.name || '').filter(Boolean).slice(0, 8)
    }
    if (typeof tags === 'string') {
      return tags.split(/[,;，；]/).map(t => t.trim()).filter(Boolean).slice(0, 8)
    }
    return ['AI模型']
  }

  // ═══════════════════════════════════════════════════════
  // 评分与评论
  // ═══════════════════════════════════════════════════════

  getReviews(skillId: string): SkillReview[] {
    return this.reviews.filter(r => r.skillId === skillId)
  }

  addReview(skillId: string, author: string, rating: number, comment: string): SkillReview {
    const review: SkillReview = {
      id: crypto.randomUUID(),
      skillId,
      author,
      rating: Math.max(0, Math.min(5, rating)),
      comment,
      createdAt: new Date().toISOString(),
    }
    this.reviews.push(review)

    const skillReviews = this.reviews.filter(r => r.skillId === skillId)
    const avgRating = skillReviews.reduce((sum, r) => sum + r.rating, 0) / skillReviews.length

    const installed = this.installed.get(skillId)
    if (installed) {
      installed.meta.rating = Math.round(avgRating * 10) / 10
      installed.meta.ratingCount = skillReviews.length
      this.saveInstalled()
    }

    this.saveReviews()
    return review
  }

  // ═══════════════════════════════════════════════════════
  // 创建新 skill
  // ═══════════════════════════════════════════════════════

  createSkill(
    id: string,
    name: string,
    description: string,
    category: SkillCategory,
    systemPrompt: string,
    author: string = 'Anonymous',
  ): InstalledSkill {
    const skillDir = path.join(this.marketDir, id)
    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true })
    }

    const meta: SkillMeta = {
      id,
      name,
      version: '1.0.0',
      description,
      author,
      category,
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      downloads: 0,
      rating: 0,
      ratingCount: 0,
    }

    fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(meta, null, 2))
    fs.writeFileSync(path.join(skillDir, 'system.md'), systemPrompt)

    const installed: InstalledSkill = {
      meta,
      installedAt: new Date().toISOString(),
      enabled: true,
      path: skillDir,
      systemPrompt,
      toolFiles: [],
    }

    this.installed.set(id, installed)
    this.saveInstalled()

    return installed
  }

  updateSkillSystemPrompt(skillId: string, prompt: string): boolean {
    const skill = this.installed.get(skillId)
    if (!skill) return false

    skill.systemPrompt = prompt
    fs.writeFileSync(path.join(skill.path, 'system.md'), prompt)

    skill.meta.updatedAt = new Date().toISOString()
    fs.writeFileSync(path.join(skill.path, 'skill.json'), JSON.stringify(skill.meta, null, 2))

    this.saveInstalled()
    return true
  }

  // ═══════════════════════════════════════════════════════
  // 内置技能初始化
  // ═══════════════════════════════════════════════════════

  installBundledSkills(): void {
    const bundledSkills = [
      {
        id: 'smart-reminder',
        name: '智能提醒',
        desc: '根据上下文智能提醒：喝水、休息、截止日期',
        category: 'productivity' as SkillCategory,
        tags: ['提醒', '健康', '效率'],
        prompt: `你是一个智能提醒助手。
自动监测用户的工作节奏：
1. 每45分钟提醒休息眼睛
2. 每2小时提醒喝水
3. 检测到深夜工作提醒睡觉
4. 识别对话中的截止日期自动记录
提醒语气温暖自然，不打扰式提醒。`,
      },
    ]

    for (const s of bundledSkills) {
      if (!this.installed.has(s.id)) {
        const installed = this.createSkill(s.id, s.name, s.desc, s.category, s.prompt)
        installed.meta.tags = s.tags
        fs.writeFileSync(path.join(installed.path, 'skill.json'), JSON.stringify(installed.meta, null, 2))
      }
    }
    this.saveInstalled()
  }

  // ═══════════════════════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════════════════════

  private copyDirSync(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)
      if (entry.isDirectory()) {
        this.copyDirSync(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  private async downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const transport = url.startsWith('https:') ? https : http
      transport.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this.downloadFile(res.headers.location, dest).then(resolve).catch(reject)
        }
        const file = fs.createWriteStream(dest)
        res.pipe(file)
        file.on('finish', () => { file.close(); resolve() })
        file.on('error', reject)
      }).on('error', reject)
    })
  }

  private async fetchJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)
      const transport = parsedUrl.protocol === 'https:' ? https : http
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        timeout: 15000,
        headers: {
          'User-Agent': 'LuminaLife/1.0 (Windows; AI Desktop Companion)',
          'Accept': 'application/json',
        },
      }
      const req = transport.request(options, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
      req.end()
    })
  }

  private loadInstalled(): void {
    const indexFile = path.join(this.marketDir, 'installed.json')
    if (!fs.existsSync(indexFile)) return

    try {
      const raw = JSON.parse(fs.readFileSync(indexFile, 'utf-8'))
      this.installed = new Map(Object.entries(raw))
    } catch { /* 忽略损坏的索引 */ }
  }

  private saveInstalled(): void {
    const obj: Record<string, InstalledSkill> = {}
    for (const [id, skill] of this.installed) {
      obj[id] = skill
    }
    fs.writeFileSync(
      path.join(this.marketDir, 'installed.json'),
      JSON.stringify(obj, null, 2)
    )
  }

  private loadReviews(): void {
    const reviewFile = path.join(this.marketDir, 'reviews.json')
    if (!fs.existsSync(reviewFile)) return

    try {
      this.reviews = JSON.parse(fs.readFileSync(reviewFile, 'utf-8'))
    } catch { /* 忽略损坏的评论 */ }
  }

  private saveReviews(): void {
    fs.writeFileSync(
      path.join(this.marketDir, 'reviews.json'),
      JSON.stringify(this.reviews, null, 2)
    )
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: SkillMarket | null = null

export function getSkillMarket(): SkillMarket {
  if (!_instance) _instance = new SkillMarket()
  return _instance
}

export function initSkillMarket(baseDir?: string): SkillMarket {
  _instance = new SkillMarket(baseDir)
  return _instance
}