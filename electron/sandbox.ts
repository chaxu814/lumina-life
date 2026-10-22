// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// sandbox.ts — 🧱 文件操作重定向层 / 虚拟围栏 (v1.0)
//
// 第二层沙箱：轻量级文件操作拦截
//   原理：Agent 想说"写文件到 C:/xxx" → Lumina 拦截
//         检查路径是否在"安全区"内 → 是则放行，否则重定向或审批
//
// 安全区定义：
//   1. Agent 默认沙箱目录 ~/Lumina/sandbox/<agentId>/
//   2. 用户在 UI 中手动"授权目录"
//   3. 系统关键路径始终禁止（C:\Windows\System32\ 等）
//
// 与现有系统的关系：
//   - accessControl.ts — 细粒度权限（谁可以用什么工具）
//   - securityGuard.ts — 威胁模式匹配（注入/穿越等）
//   - approvalService.ts — 审批流（>中风险要用户点头）
//   - sandbox.ts — 路径级安全区检查（新增的拦截层）
// ============================================================

import fs from 'fs'
import path from 'path'
import os from 'os'
import { getApprovalService } from './approvalService'
import { ApprovalDecision } from './approvalTypes'
import type { TeamMemberId } from './agentTeamTypes'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface SandboxConfig {
  /** 默认沙箱根目录 */
  defaultRoot: string
  /** 各 Agent 的沙箱配置 */
  agents: Record<string, AgentSandboxConfig>
  /** 用户授权目录列表 */
  authorizedDirs: AuthorizedDir[]
}

export interface AgentSandboxConfig {
  /** 沙箱目录（绝对路径） */
  sandboxDir: string
  /** 是否启用沙箱拦截 */
  enabled: boolean
}

export interface AuthorizedDir {
  /** 唯一 ID */
  id: string
  /** 绝对路径 */
  path: string
  /** 用户友好名称 */
  label: string
  /** 授权时间戳 */
  authorizedAt: number
  /** 允许哪些工具使用（'*' = 全部） */
  tools: string[]
  /** 允许哪些 Agent 使用（'*' = 全部） */
  agentIds: string[]
  /** 写操作是否需要审批（默认 true） */
  requireApprovalForWrite: boolean
}

export type FileOperation = 'read' | 'write' | 'edit'

export interface SandboxCheckResult {
  /** 是否允许此操作 */
  allowed: boolean
  /** 如果应重定向，给出目标路径 */
  redirectTo?: string
  /** 是否需要用户审批 */
  needsApproval: boolean
  /** 审批请求 ID（如果有） */
  approvalRequestId?: string
  /** 原因说明（拒绝或重定向的原因） */
  reason: string
  /** 给 Agent 的建议（拒绝时的替代方案） */
  suggestion?: string
  /** 操作是否被重定向（记日志用） */
  wasRedirected?: boolean
}

// ═══════════════════════════════════════════════════════════
// 系统关键路径（始终禁止写入）
// ═══════════════════════════════════════════════════════════

const SYSTEM_CRITICAL_PATHS: string[] = [
  // Windows
  'C:\\Windows\\System32',
  'C:\\Windows\\SysWOW64',
  'C:\\Windows\\System',
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  // Linux / macOS
  '/etc',
  '/sys',
  '/proc',
  '/dev',
  '/boot',
  '/usr/lib',
  '/usr/bin',
  '/bin',
  '/sbin',
  '/var/lib',
  '/System',
  '/Library',
]

/** 敏感文件扩展名（读取时需审批） */
const SENSITIVE_EXTENSIONS = [
  '.env', '.pem', '.key', '.p12', '.pfx',
  '.credential', '.secret', '.token', '.password',
]

// ═══════════════════════════════════════════════════════════
// SandboxManager
// ═══════════════════════════════════════════════════════════

export class SandboxManager {
  private config: SandboxConfig
  private configPath: string
  private initialized = false

  constructor() {
    const home = os.homedir()
    this.config = {
      defaultRoot: path.join(home, 'Lumina', 'sandbox'),
      agents: {},
      authorizedDirs: [],
    }
    // 配置文件存到用户数据目录
    this.configPath = ''
    try {
      const { app } = require('electron')
      const userData = app.getPath('userData')
      this.configPath = path.join(userData, 'sandbox-config.json')
    } catch {
      // fallback: 存到 home 目录
      this.configPath = path.join(home, '.lumina-sandbox.json')
    }
  }

  // ── 初始化 ─────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) {return}

    // 加载持久化配置
    await this.loadConfig()

    // 确保默认沙箱目录存在
    const defaultDir = this.config.defaultRoot
    if (!fs.existsSync(defaultDir)) {
      await fs.promises.mkdir(defaultDir, { recursive: true })
    }

    // 为已知 Agent 创建沙箱目录
    const knownAgents: TeamMemberId[] = ['lumina', 'yak', 'recha']
    for (const agentId of knownAgents) {
      this.ensureAgentSandbox(agentId)
    }

    this.initialized = true
    console.log(`[Sandbox] 初始化完成. 默认沙箱目录: ${this.config.defaultRoot}`)
    console.log(`[Sandbox] 已授权 ${this.config.authorizedDirs.length} 个外部目录`)
  }

  private ensureAgentSandbox(agentId: TeamMemberId): void {
    const dir = this.getOrCreateAgentSandboxDir(agentId)
    // 默认启用 sandbox（lumina 宽松一些）
    const enabled = agentId !== 'lumina'
    if (!this.config.agents[agentId]) {
      this.config.agents[agentId] = { sandboxDir: dir, enabled }
    }
  }

  private getOrCreateAgentSandboxDir(agentId: string): string {
    const dir = path.join(this.config.defaultRoot, agentId)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  // ── 配置持久化 ─────────────────────────────────────

  private async loadConfig(): Promise<void> {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = await fs.promises.readFile(this.configPath, 'utf-8')
        const saved = JSON.parse(raw)
        // 合并保存的配置（保持结构兼容）
        if (saved.defaultRoot) {this.config.defaultRoot = saved.defaultRoot}
        if (saved.agents) {
          for (const [id, cfg] of Object.entries(saved.agents)) {
            this.config.agents[id] = cfg as AgentSandboxConfig
          }
        }
        if (saved.authorizedDirs) {
          this.config.authorizedDirs = saved.authorizedDirs
        }
      }
    } catch (err) {
      console.warn('[Sandbox] 加载配置失败，使用默认配置:', err)
    }
  }

  private async saveConfig(): Promise<void> {
    try {
      const dir = path.dirname(this.configPath)
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true })
      }
      await fs.promises.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[Sandbox] 保存配置失败:', err)
    }
  }

  // ── 公共 API ───────────────────────────────────────

  /** 获取完整配置 */
  getConfig(): SandboxConfig {
    return { ...this.config, agents: { ...this.config.agents }, authorizedDirs: [...this.config.authorizedDirs] }
  }

  /** 获取某 Agent 的沙箱目录 */
  getAgentSandboxDir(agentId: string): string {
    if (this.config.agents[agentId]) {
      return this.config.agents[agentId].sandboxDir
    }
    return this.getOrCreateAgentSandboxDir(agentId)
  }

  /** 更新 Agent 沙箱配置 */
  async updateAgentConfig(agentId: string, patch: Partial<AgentSandboxConfig>): Promise<void> {
    if (!this.config.agents[agentId]) {
      this.config.agents[agentId] = {
        sandboxDir: this.getOrCreateAgentSandboxDir(agentId),
        enabled: true,
      }
    }
    Object.assign(this.config.agents[agentId], patch)
    await this.saveConfig()
  }

  /** 添加用户授权目录 */
  async addAuthorizedDir(params: {
    path: string
    label?: string
    tools?: string[]
    agentIds?: string[]
    requireApprovalForWrite?: boolean
  }): Promise<AuthorizedDir> {
    const dir: AuthorizedDir = {
      id: `dir_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      path: path.resolve(params.path),
      label: params.label || path.basename(params.path),
      authorizedAt: Date.now(),
      tools: params.tools || ['*'],
      agentIds: params.agentIds || ['*'],
      requireApprovalForWrite: params.requireApprovalForWrite ?? true,
    }
    this.config.authorizedDirs.push(dir)
    await this.saveConfig()
    console.log(`[Sandbox] 已授权目录: ${dir.path} (${dir.label})`)
    return dir
  }

  /** 移除授权目录 */
  async removeAuthorizedDir(dirId: string): Promise<boolean> {
    const idx = this.config.authorizedDirs.findIndex(d => d.id === dirId)
    if (idx === -1) {return false}
    this.config.authorizedDirs.splice(idx, 1)
    await this.saveConfig()
    console.log(`[Sandbox] 已移除授权目录: ${dirId}`)
    return true
  }

  // ── 核心：文件路径检查 ─────────────────────────────

  /**
   * 检查文件操作是否在安全区内
   *
   * 返回:
   *   - allowed=true → 允许（在安全区内或在沙箱内）
   *   - needsApproval=true → 需要用户确认
   *   - allowed=false → 拒绝（系统关键路径）
   *   - redirectTo → 建议重定向到沙箱目录
   */
  async checkFileAccess(
    agentId: string,
    filePath: string,
    operation: FileOperation,
  ): Promise<SandboxCheckResult> {
    // 初始化（如果还没做）
    if (!this.initialized) {await this.init()}

    // 标准化路径
    const normalizedPath = path.normalize(filePath)
    const absolutePath = path.isAbsolute(normalizedPath)
      ? normalizedPath
      : path.resolve(process.cwd(), normalizedPath)

    // ── 0. lumina 是"老大"，所有路径基本放行 ──────────
    //    但仍禁止写入系统关键路径
    if (agentId === 'lumina' && operation !== 'write' && operation !== 'edit') {
      return { allowed: true, needsApproval: false, reason: 'Lumina 可读任何路径' }
    }

    // ── 1. 系统关键路径 → 始终拒绝写入 ───────────────
    if (operation === 'write' || operation === 'edit') {
      const isCritical = SYSTEM_CRITICAL_PATHS.some(sysPath => {
        const normSys = path.normalize(sysPath).toLowerCase()
        const normFile = absolutePath.toLowerCase()
        return normFile.startsWith(normSys)
      })
      if (isCritical) {
        return {
          allowed: false,
          needsApproval: false,
          reason: `⛔ 禁止写入系统关键路径: ${absolutePath}`,
          suggestion: '请将文件写入沙箱目录或用户授权目录',
        }
      }
    }

    // ── 2. 检查是否在 Agent 的沙箱目录内 ─────────────
    const agentCfg = this.config.agents[agentId]
    const sandboxDir = agentCfg?.sandboxDir || this.getOrCreateAgentSandboxDir(agentId)
    const sandboxNorm = path.normalize(sandboxDir).toLowerCase()
    const fileNorm = absolutePath.toLowerCase()

    if (fileNorm.startsWith(sandboxNorm)) {
      // ✅ 在沙箱内 → 允许
      return { allowed: true, needsApproval: false, reason: `在沙箱目录内: ${sandboxDir}` }
    }

    // ── 3. 检查是否在用户授权目录内 ───────────────────
    for (const authDir of this.config.authorizedDirs) {
      const authNorm = path.normalize(authDir.path).toLowerCase()
      if (fileNorm.startsWith(authNorm)) {
        // Agent 白名单检查
        if (!authDir.agentIds.includes('*') && !authDir.agentIds.includes(agentId)) {
          continue // 此 Agent 无权使用该授权目录
        }
        // 工具白名单检查
        const toolMap: Record<FileOperation, string> = { read: 'file_read', write: 'file_write', edit: 'file_edit' }
        if (!authDir.tools.includes('*') && !authDir.tools.includes(toolMap[operation])) {
          continue
        }
        // 写操作是否需要审批
        if ((operation === 'write' || operation === 'edit') && authDir.requireApprovalForWrite) {
          const approvalService = getApprovalService()
          const request = approvalService.requestApproval({
            sessionId: 'sandbox',
            agentId,
            toolName: toolMap[operation],
            toolArgs: { file_path: absolutePath },
            description: `Agent ${agentId} 想写入已授权目录 "${authDir.label}": ${absolutePath}`,
            riskLevel: 'medium',
            threatCategories: ['sandbox_bypass'],
          })
          if (request) {
            // 等待用户决策
            const decision = await approvalService.waitForDecision(request.id, 60000)
            if (decision === ApprovalDecision.APPROVED) {
              return { allowed: true, needsApproval: false, reason: '用户已授权此写入操作', approvalRequestId: request.id }
            }
            return { allowed: false, needsApproval: true, reason: '用户未批准此写入操作', approvalRequestId: request.id }
          }
          // 审批未启用 → 允许（安全守卫会做最终判断）
        }
        return { allowed: true, needsApproval: false, reason: `在授权目录内: ${authDir.label}` }
      }
    }

    // ── 4. 敏感文件读取 → 需要审批 ───────────────────
    if (operation === 'read') {
      const ext = path.extname(absolutePath).toLowerCase()
      if (SENSITIVE_EXTENSIONS.includes(ext)) {
        const approvalService = getApprovalService()
        const request = approvalService.requestApproval({
          sessionId: 'sandbox',
          agentId,
          toolName: 'file_read',
          toolArgs: { file_path: absolutePath },
          description: `Agent ${agentId} 想读取敏感文件: ${absolutePath}`,
          riskLevel: 'high',
          threatCategories: ['sensitive_file_access'],
        })
        if (request) {
          const decision = await approvalService.waitForDecision(request.id, 60000)
          if (decision === ApprovalDecision.APPROVED) {
            return { allowed: true, needsApproval: true, reason: '用户已授权读取敏感文件', approvalRequestId: request.id }
          }
          return { allowed: false, needsApproval: true, reason: '用户未批准读取敏感文件', approvalRequestId: request.id }
        }
        // 审批未启用 → 基于安全守卫的判断放行（securityGuard.ts 会处理敏感文件）
        console.log(`[Sandbox] ℹ️ Agent ${agentId} 读取敏感文件（审批未启用）: ${absolutePath}`)
      }
    }

    // ── 5. 不在任何安全区内 → 重定向或拒绝 ───────────
    if (operation === 'write') {
      // 写操作 → 建议重定向到沙箱目录
      // 生成可读的重定向路径：将盘符转为子目录名
      const driveMatch = absolutePath.match(/^([A-Za-z]):\\?/)
      let relativePath: string
      if (driveMatch) {
        // v3.34 修复：原来漏了盘符与后续路径之间的分隔符。
        //   旧：driveMatch[1] + slice(...)  →  D:lumina-quality/fib.py
        //   新：补上 '/'                   →  D/lumina-quality/fib.py
        // 后果是重定向后目录变成 sandbox/lumina/Dlumina-quality/ —— 用户按提示
        // 去 D:\lumina-quality 找文件永远找不到。注释里写的意图本来就是
        // 「C:\Users\file.txt → C/Users/file.txt」，实现与意图不符。
        relativePath = driveMatch[1] + '/' + absolutePath.slice(driveMatch[0].length).replace(/\\/g, '/')
      } else if (absolutePath.startsWith('/')) {
        // Unix: /home/user/file.txt → home/user/file.txt
        relativePath = absolutePath.slice(1)
      } else {
        relativePath = absolutePath.replace(/[\\/]/g, '/')
      }
      const redirectPath = path.join(sandboxDir, relativePath)

      return {
        allowed: true, // 允许（因为重定向了，不算是拒绝）
        redirectTo: redirectPath,
        needsApproval: false,
        wasRedirected: true,
        reason: `路径不在安全区内，已重定向到沙箱目录`,
        suggestion: `原路径: ${absolutePath}\n重定向到: ${redirectPath}`,
      }
    }

    if (operation === 'edit') {
      // 编辑外部文件 → 需要审批
      const approvalService = getApprovalService()
      const request = approvalService.requestApproval({
        sessionId: 'sandbox',
        agentId,
        toolName: 'file_edit',
        toolArgs: { file_path: absolutePath },
        description: `Agent ${agentId} 想编辑外部文件: ${absolutePath}`,
        riskLevel: 'medium',
        threatCategories: ['sandbox_bypass'],
      })
      if (request) {
        const decision = await approvalService.waitForDecision(request.id, 60000)
        if (decision === ApprovalDecision.APPROVED) {
          return { allowed: true, needsApproval: true, reason: '用户已授权编辑此文件', approvalRequestId: request.id }
        }
        return { allowed: false, needsApproval: true, reason: '用户未批准编辑此文件', approvalRequestId: request.id }
      }
      // 审批未触发（OFF 模式或配置不开审批）→ 允许编辑外部文件
      return { allowed: true, needsApproval: false, reason: '编辑外部文件（审批未启用）' }
    }

    // 读取外部文件 → 放行（路径解析/安全守卫会处理敏感内容）
    // 但记录日志
    console.log(`[Sandbox] ℹ️ Agent ${agentId} 读取外部路径: ${absolutePath}`)
    return { allowed: true, needsApproval: false, reason: '读取外部路径（已记录）' }
  }

  /** 简化的同步检查（用于快速判断，不需审批） */
  isPathInSafeZone(agentId: string, filePath: string): boolean {
    const absolutePath = path.resolve(filePath)
    const fileNorm = absolutePath.toLowerCase()

    // 沙箱目录
    const agentCfg = this.config.agents[agentId]
    const sandboxDir = agentCfg?.sandboxDir || this.getOrCreateAgentSandboxDir(agentId)
    if (fileNorm.startsWith(path.normalize(sandboxDir).toLowerCase())) {return true}

    // 授权目录
    for (const authDir of this.config.authorizedDirs) {
      if (fileNorm.startsWith(path.normalize(authDir.path).toLowerCase())) {return true}
    }

    return false
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let globalSandbox: SandboxManager | null = null

export function getSandbox(): SandboxManager {
  if (!globalSandbox) {
    globalSandbox = new SandboxManager()
  }
  return globalSandbox
}

export async function initSandbox(): Promise<SandboxManager> {
  const sb = getSandbox()
  await sb.init()
  return sb
}
