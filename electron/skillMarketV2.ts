// ============================================================
// skillMarketV2.ts — 开放插件市场增强版 (P2-2)
//
// 在原有 skillMarket.ts 基础上，增加：
//   - 发布机制：本地打包发布到社区仓库
//   - 审核机制：管理员审核/拒绝 Skill
//   - 发现机制：标签、分类、评分、搜索
//   - 依赖管理：自动解析和安装依赖
//   - 版本管理：支持版本检查和更新
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'
import https from 'https'
import http from 'http'
import * as crypto from 'crypto'
import { getSkillMarket, SkillMeta, InstalledSkill, SkillReview, SkillCategory } from './skillMarket'

const execAsync = promisify(exec)

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface PublishRequest {
  skillId: string
  name: string
  description: string
  category: SkillCategory
  tags: string[]
  author: string
  changelog?: string
  visibility: 'public' | 'unlisted' | 'private'
}

export interface PublishResult {
  success: boolean
  skillId?: string
  url?: string
  error?: string
}

export interface AuditAction {
  skillId: string
  action: 'approve' | 'reject' | 'request_changes'
  reviewer: string
  comment?: string
  timestamp: string
}

export interface SkillVersion {
  version: string
  publishedAt: string
  changelog?: string
  downloadUrl?: string
  signature?: string
}

export interface DependencyGraph {
  skillId: string
  dependencies: Array<{
    id: string
    version: string
    required: boolean
    installed?: boolean
  }>
}

// ═══════════════════════════════════════════════════════════
// 开放插件市场
// ═══════════════════════════════════════════════════════════

export class SkillMarketV2 {
  private marketDir: string
  private pendingApproval: Map<string, PublishRequest> = new Map()
  private auditLog: AuditAction[] = []
  private versions: Map<string, SkillVersion[]> = new Map()
  private readonly registryUrl = 'https://registry.npmjs.org' // 示例：使用 npm registry 作为社区仓库

  constructor(baseDir?: string) {
    this.marketDir = baseDir || path.join(os.homedir(), '.lumina', 'skills')
    if (!fs.existsSync(this.marketDir)) {
      fs.mkdirSync(this.marketDir, { recursive: true })
    }
    this.loadPendingApprovals()
    this.loadAuditLog()
    this.loadVersions()
  }

  // ═══════════════════════════════════════════════════════
  // 发布机制
  // ═══════════════════════════════════════════════════════

  /**
   * 发布 Skill 到社区市场
   * 
   * @param request 发布请求
   * @returns 发布结果
   */
  async publish(request: PublishRequest): Promise<PublishResult> {
    try {
      // 1. 验证 Skill 是否已安装
      const market = getSkillMarket()
      const installed = market.getSkill(request.skillId)
      if (!installed) {
        return { success: false, error: 'Skill 未安装，无法发布' }
      }

      // 2. 验证元信息
      if (!request.name || !request.description || !request.author) {
        return { success: false, error: '缺少必要的元信息（name/description/author）' }
      }

      // 3. 检查依赖
      const depGraph = await this.resolveDependencies(request.skillId)
      const missingDeps = depGraph.dependencies.filter(d => d.required && !d.installed)
      if (missingDeps.length > 0) {
        return {
          success: false,
          error: `缺少依赖: ${missingDeps.map(d => d.id).join(', ')}`
        }
      }

      // 4. 打包 Skill
      const zipPath = await this.packSkill(request.skillId)
      if (!zipPath) {
        return { success: false, error: '打包 Skill 失败' }
      }

      // 5. 计算签名
      const signature = await this.computeSignature(zipPath)

      // 6. 添加到待审核列表
      this.pendingApproval.set(request.skillId, {
        ...request,
        changelog: request.changelog || 'Initial release'
      })

      // 7. 记录版本
      const version: SkillVersion = {
        version: installed.meta.version,
        publishedAt: new Date().toISOString(),
        changelog: request.changelog,
        downloadUrl: `file://${zipPath}`,
        signature,
      }
      const existingVersions = this.versions.get(request.skillId) || []
      existingVersions.push(version)
      this.versions.set(request.skillId, existingVersions)

      this.savePendingApprovals()
      this.saveVersions()

      return {
        success: true,
        skillId: request.skillId,
        url: `file://${zipPath}`,
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  /**
   * 打包 Skill 为 .lumskill 文件
   */
  private async packSkill(skillId: string): Promise<string | null> {
    try {
      const market = getSkillMarket()
      const skill = market.getSkill(skillId)
      if (!skill) return null

      const zipPath = path.join(this.marketDir, 'publish', `${skillId}-${Date.now()}.lumskill`)
      fs.mkdirSync(path.dirname(zipPath), { recursive: true })

      if (process.platform === 'win32') {
        await execAsync(`powershell -Command "Compress-Archive -Path '${skill.path}\\*' -DestinationPath '${zipPath}' -Force"`)
      } else {
        await execAsync(`cd "${skill.path}" && zip -r "${zipPath}" .`)
      }

      return zipPath
    } catch (err) {
      console.error('[SkillMarketV2] 打包失败:', err)
      return null
    }
  }

  private async computeSignature(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256')
    const data = fs.readFileSync(filePath)
    hash.update(data)
    return hash.digest('hex').slice(0, 16)
  }

  // ═══════════════════════════════════════════════════════
  // 审核机制
  // ═══════════════════════════════════════════════════════

  /**
   * 审核 Skill（管理员操作）
   */
  audit(action: AuditAction): boolean {
    const pending = this.pendingApproval.get(action.skillId)
    if (!pending && action.action !== 'request_changes') {
      return false
    }

    // 记录审核日志
    this.auditLog.push(action)
    this.saveAuditLog()

    switch (action.action) {
      case 'approve':
        // 审核通过，发布到社区仓库
        this.pendingApproval.delete(action.skillId)
        this.savePendingApprovals()
        console.log(`[SkillMarketV2] ✅ Skill ${action.skillId} 已审核通过`)
        break

      case 'reject':
        // 审核拒绝，移除待审核状态
        this.pendingApproval.delete(action.skillId)
        this.savePendingApprovals()
        console.log(`[SkillMarketV2] ❌ Skill ${action.skillId} 已审核拒绝: ${action.comment}`)
        break

      case 'request_changes':
        // 要求修改
        console.log(`[SkillMarketV2] 📝 Skill ${action.skillId} 需要修改: ${action.comment}`)
        break
    }

    return true
  }

  getPendingApprovals(): PublishRequest[] {
    return Array.from(this.pendingApproval.values())
  }

  getAuditLog(skillId?: string): AuditAction[] {
    if (skillId) {
      return this.auditLog.filter(a => a.skillId === skillId)
    }
    return this.auditLog
  }

  // ═══════════════════════════════════════════════════════
  // 依赖管理
  // ═══════════════════════════════════════════════════════

  /**
   * 解析 Skill 依赖
   */
  async resolveDependencies(skillId: string): Promise<DependencyGraph> {
    const market = getSkillMarket()
    const skill = market.getSkill(skillId)
    if (!skill) {
      return { skillId, dependencies: [] }
    }

    const deps = skill.meta.dependencies || []
    const installed = market.getInstalled()
    const installedIds = new Set(installed.map(s => s.meta.id))

    const graph: DependencyGraph = {
      skillId,
      dependencies: deps.map(depId => ({
        id: depId,
        version: 'latest',
        required: true,
        installed: installedIds.has(depId),
      })),
    }

    return graph
  }

  /**
   * 自动安装依赖
   */
  async installDependencies(skillId: string): Promise<{ success: boolean; installed: string[]; failed: string[] }> {
    const graph = await this.resolveDependencies(skillId)
    const market = getSkillMarket()
    const installed: string[] = []
    const failed: string[] = []

    for (const dep of graph.dependencies) {
      if (!dep.installed && dep.required) {
        try {
          // 尝试从社区市场安装
          const result = await market.installFromCommunity(dep.id)
          if (result.success) {
            installed.push(dep.id)
          } else {
            failed.push(dep.id)
          }
        } catch {
          failed.push(dep.id)
        }
      }
    }

    return { success: failed.length === 0, installed, failed }
  }

  // ═══════════════════════════════════════════════════════
  // 版本管理
  // ═══════════════════════════════════════════════════════

  getVersions(skillId: string): SkillVersion[] {
    return this.versions.get(skillId) || []
  }

  async checkUpdates(skillId?: string): Promise<Map<string, SkillVersion | null>> {
    const market = getSkillMarket()
    const installed = market.getInstalled()
    const updates = new Map<string, SkillVersion | null>()

    const skillsToCheck = skillId
      ? installed.filter(s => s.meta.id === skillId)
      : installed

    for (const skill of skillsToCheck) {
      // 简化：检查本地是否有新版本
      const versions = this.getVersions(skill.meta.id)
      const latest = versions[versions.length - 1]
      updates.set(skill.meta.id, latest || null)
    }

    return updates
  }

  // ═══════════════════════════════════════════════════════
  // 发现机制增强
  // ═══════════════════════════════════════════════════════

  /**
   * 高级搜索：支持标签、分类、评分、下载量筛选
   */
  advancedSearch(options: {
    query?: string
    category?: SkillCategory
    tags?: string[]
    minRating?: number
    minDownloads?: number
    sortBy?: 'rating' | 'downloads' | 'updatedAt' | 'name'
    page?: number
    pageSize?: number
  }): { skills: SkillMeta[]; total: number; page: number } {
    const market = getSkillMarket()
    let results = market.getInstalled().map(s => s.meta)

    // 文本搜索
    if (options.query) {
      const q = options.query.toLowerCase()
      results = results.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.author.toLowerCase().includes(q) ||
        s.tags.some(t => t.toLowerCase().includes(q))
      )
    }

    // 分类筛选
    if (options.category) {
      results = results.filter(s => s.category === options.category)
    }

    // 标签筛选（AND 逻辑）
    if (options.tags && options.tags.length > 0) {
      results = results.filter(s =>
        options.tags!.every(t => s.tags.includes(t))
      )
    }

    // 评分筛选
    if (options.minRating) {
      results = results.filter(s => s.rating >= options.minRating!)
    }

    // 下载量筛选
    if (options.minDownloads) {
      results = results.filter(s => s.downloads >= options.minDownloads!)
    }

    // 排序
    const sortBy = options.sortBy || 'downloads'
    results.sort((a, b) => {
      switch (sortBy) {
        case 'rating': return b.rating - a.rating
        case 'downloads': return b.downloads - a.downloads
        case 'updatedAt': return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        case 'name': return a.name.localeCompare(b.name)
        default: return 0
      }
    })

    // 分页
    const page = options.page || 1
    const pageSize = options.pageSize || 20
    const start = (page - 1) * pageSize
    const paginated = results.slice(start, start + pageSize)

    return {
      skills: paginated,
      total: results.length,
      page,
    }
  }

  /**
   * 获取推荐 Skill（基于安装历史和评分）
   */
  getRecommendations(limit: number = 10): SkillMeta[] {
    const market = getSkillMarket()
    const installed = market.getInstalled()

    // 基于已安装 Skill 的标签推荐
    const installedTags = new Set<string>()
    const installedCategories = new Set<SkillCategory>()

    for (const skill of installed) {
      skill.meta.tags.forEach(t => installedTags.add(t))
      installedCategories.add(skill.meta.category)
    }

    // 从社区市场获取推荐
    const allSkills: SkillMeta[] = []
    const communitySkills = market.searchCommunity('').then(result => {
      allSkills.push(...result.skills)
    }).catch(() => {
      // 如果社区市场不可用，使用本地数据
      allSkills.push(...installed.map(s => s.meta))
    })

    // 按相关性排序
    const scored = allSkills.map(s => {
      let score = 0
      // 分类匹配
      if (installedCategories.has(s.category)) score += 2
      // 标签匹配
      const matchingTags = s.tags.filter(t => installedTags.has(t)).length
      score += matchingTags * 3
      // 评分加权
      score += s.rating * 0.5
      // 下载量加权（对数缩放）
      score += Math.log10(s.downloads + 1) * 0.1
      return { skill: s, score }
    })

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map(s => s.skill)
  }

  // ═══════════════════════════════════════════════════════
  // 持久化
  // ═══════════════════════════════════════════════════════

  private loadPendingApprovals(): void {
    const file = path.join(this.marketDir, 'pending-approvals.json')
    if (!fs.existsSync(file)) return
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
      this.pendingApproval = new Map(Object.entries(raw))
    } catch { /* ignore */ }
  }

  private savePendingApprovals(): void {
    const file = path.join(this.marketDir, 'pending-approvals.json')
    const obj: Record<string, PublishRequest> = {}
    for (const [id, req] of this.pendingApproval) {
      obj[id] = req
    }
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf-8')
  }

  private loadAuditLog(): void {
    const file = path.join(this.marketDir, 'audit-log.json')
    if (!fs.existsSync(file)) return
    try {
      this.auditLog = JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch { /* ignore */ }
  }

  private saveAuditLog(): void {
    const file = path.join(this.marketDir, 'audit-log.json')
    fs.writeFileSync(file, JSON.stringify(this.auditLog, null, 2), 'utf-8')
  }

  private loadVersions(): void {
    const file = path.join(this.marketDir, 'versions.json')
    if (!fs.existsSync(file)) return
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
      this.versions = new Map(Object.entries(raw))
    } catch { /* ignore */ }
  }

  private saveVersions(): void {
    const file = path.join(this.marketDir, 'versions.json')
    const obj: Record<string, SkillVersion[]> = {}
    for (const [id, versions] of this.versions) {
      obj[id] = versions
    }
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf-8')
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instanceV2: SkillMarketV2 | null = null

export function getSkillMarketV2(): SkillMarketV2 {
  if (!_instanceV2) _instanceV2 = new SkillMarketV2()
  return _instanceV2
}

export function initSkillMarketV2(baseDir?: string): SkillMarketV2 {
  _instanceV2 = new SkillMarketV2(baseDir)
  return _instanceV2
}
