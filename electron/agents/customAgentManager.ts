// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// agents/customAgentManager.ts — 自定义 Agent 管理器 (D1/D2/D3)
//
// 目录结构（与内置 lumina/yak/recha 对齐）：
//   electron/agents/custom/<agent-id>/
//     ├── agent.json    — 配置（id/name/icon/人格/模型/工具集/团队角色）
//     ├── SOUL.md       — 人格文件（UTF-8，必需）
//     ├── PROFILE.md    — 用户资料/工作档案（可选，自动生成模板）
//     └── MEMORY.md     — 长期记忆（可选，自动生成模板）
//
// 设计：fs / baseDir 全部可注入，单测用内存 fs，不碰真实磁盘。
// 注册：把自定义 Agent 同步到 global.__lumina_custom_profiles，
//       agentTeamPersonas.getConfiguredMembers() 已读取该全局做合并（D3 团队分工）。
// ============================================================

import * as fs from 'fs'
import * as path from 'path'

/** 自定义 Agent 团队角色 */
export type CustomTeamRole = 'leader' | 'member' | 'solo'

/** 独立模型配置（留空则继承全局 providerManager 的激活供应商） */
export interface CustomAgentModelConfig {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

/** agent.json 配置格式（D1） */
export interface CustomAgentConfig {
  id: string
  name: string
  icon: string
  archetype: string
  personality: string
  soulFile: string
  profileFile: string
  memoryFile: string
  ttsVoice: string
  model: CustomAgentModelConfig
  toolsets: string[]
  visible: boolean
  teamRole: CustomTeamRole
  createdAt: string
}

/** 可注入 fs 接口（Node fs 子集） */
export interface AgentFs {
  readFileSync(p: string, enc: 'utf-8'): string
  writeFileSync(p: string, data: string, enc: 'utf-8'): void
  existsSync(p: string): boolean
  mkdirSync(p: string, opts: { recursive: boolean }): void
  readdirSync(p: string): string[]
  rmSync(p: string, opts: { recursive: boolean; force: boolean }): void
}

const realFs: AgentFs = {
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  writeFileSync: (p, data, enc) => fs.writeFileSync(p, data, enc),
  existsSync: (p) => fs.existsSync(p),
  mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
  readdirSync: (p) => fs.readdirSync(p),
  rmSync: (p, opts) => fs.rmSync(p, opts),
}

/** 合法 id：字母开头，只含字母/数字/下划线/短横，防路径穿越 */
const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{1,40}$/

export function isValidAgentId(id: string): boolean {
  return typeof id === 'string' && ID_RE.test(id)
}

/** 非法 id 抛错（创建/更新时调用） */
export function assertValidId(id: string): void {
  if (!isValidAgentId(id)) {
    throw new Error(`非法 Agent id: "${id}"。需以字母开头，仅含字母/数字/下划线/短横（2-40 位）`)
  }
}

/** 工具集白名单（与内置工具集对齐，防止写入未知工具） */
export const KNOWN_TOOLSETS = ['agent', 'files_core', 'shell', 'web', 'memory', 'delegate', 'vision']

/** 创建时的默认值填充（D1：默认值） */
export function normalizeAgentConfig(input: Partial<CustomAgentConfig> & { id: string }): CustomAgentConfig {
  assertValidId(input.id)
  const toolsets = Array.isArray(input.toolsets) && input.toolsets.length > 0 ? input.toolsets : ['agent', 'files_core']
  return {
    id: input.id,
    name: input.name || input.id,
    icon: input.icon || '🤖',
    archetype: input.archetype || 'custom',
    personality: input.personality || '',
    soulFile: input.soulFile || 'SOUL.md',
    profileFile: input.profileFile || 'PROFILE.md',
    memoryFile: input.memoryFile || 'MEMORY.md',
    ttsVoice: input.ttsVoice || 'zh-CN-XiaoxiaoNeural',
    model: {
      provider: input.model?.provider || '',
      model: input.model?.model || '',
      baseUrl: input.model?.baseUrl || '',
      apiKey: input.model?.apiKey || '',
    },
    toolsets,
    visible: input.visible !== false,
    teamRole: normalizeTeamRole(input.teamRole),
    createdAt: input.createdAt || new Date().toISOString().slice(0, 10),
  }
}

export function normalizeTeamRole(role: unknown): CustomTeamRole {
  if (role === 'leader' || role === 'member' || role === 'solo') {return role}
  return 'member'
}

/** SOUL.md 模板（UTF-8） */
function soulTemplate(cfg: CustomAgentConfig): string {
  return [
    `# ${cfg.name}`,
    '',
    `> 这是 ${cfg.icon} ${cfg.name} 的人格文件。写清楚「你是谁、怎么说话、能做什么、不能做什么」。`,
    '',
    `## 你是谁`,
    cfg.personality || '一个新创建的自定义助手。',
    '',
    '## 说话风格',
    '- 自然、直接，不堆套话',
    '',
    '## 能力边界',
    '- 你只能调用被授予的工具集：' + (cfg.toolsets.join('、') || '无'),
    '',
  ].join('\n')
}

function profileTemplate(cfg: CustomAgentConfig): string {
  return [`# ${cfg.name} · 工作档案`, '', '> 记录这个 Agent 的专长、常处理的任务类型。', ''].join('\n')
}

function memoryTemplate(): string {
  return ['# 长期记忆', '', '> 此文件由系统自动追加重要决策与偏好，请勿手动删除已有段落。', ''].join('\n')
}

/**
 * 自定义 Agent 管理器（绑定 baseDir 与 fs）。
 * baseDir 默认为 <root>/electron/agents/custom。
 */
export class CustomAgentManager {
  constructor(
    private readonly baseDir: string,
    private readonly fsImpl: AgentFs = realFs,
  ) {}

  private dirOf(id: string): string {
    return path.join(this.baseDir, id)
  }

  private jsonPath(id: string): string {
    return path.join(this.dirOf(id), 'agent.json')
  }

  /** 列出全部自定义 Agent（按名字排序） */
  listCustomAgents(): CustomAgentConfig[] {
    if (!this.fsImpl.existsSync(this.baseDir)) {return []}
    const out: CustomAgentConfig[] = []
    for (const entry of this.fsImpl.readdirSync(this.baseDir)) {
      if (!isValidAgentId(entry)) {continue}
      const cfg = this.readRaw(entry)
      if (cfg) {out.push(cfg)}
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    return out
  }

  /** 读取单个 Agent 配置；不存在返回 null */
  getAgent(id: string): CustomAgentConfig | null {
    if (!isValidAgentId(id)) {return null}
    return this.readRaw(id)
  }

  private readRaw(id: string): CustomAgentConfig | null {
    const file = this.jsonPath(id)
    if (!this.fsImpl.existsSync(file)) {return null}
    try {
      const raw = this.fsImpl.readFileSync(file, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<CustomAgentConfig>
      return normalizeAgentConfig({ ...parsed, id })
    } catch {
      return null
    }
  }

  /** 创建 Agent：建目录 + 写 agent.json + SOUL/PROFILE/MEMORY 模板 */
  createAgent(input: Partial<CustomAgentConfig> & { id: string }): CustomAgentConfig {
    assertValidId(input.id)
    if (this.getAgent(input.id)) {
      throw new Error(`Agent "${input.id}" 已存在，请换个 id`)
    }
    const cfg = normalizeAgentConfig(input)
    const dir = this.dirOf(cfg.id)
    if (!this.fsImpl.existsSync(dir)) {this.fsImpl.mkdirSync(dir, { recursive: true })}
    this.writeJson(cfg)
    this.fsImpl.writeFileSync(path.join(dir, cfg.soulFile), soulTemplate(cfg), 'utf-8')
    this.fsImpl.writeFileSync(path.join(dir, cfg.profileFile), profileTemplate(cfg), 'utf-8')
    this.fsImpl.writeFileSync(path.join(dir, cfg.memoryFile), memoryTemplate(), 'utf-8')
    return cfg
  }

  /** 更新 Agent：合并 patch；同时可重写 SOUL.md 内容 */
  updateAgent(id: string, updates: Partial<CustomAgentConfig> & { soulContent?: string }): CustomAgentConfig {
    assertValidId(id)
    const existing = this.readRaw(id)
    if (!existing) {throw new Error(`Agent "${id}" 不存在`)}
    const { soulContent, ...cfgPatch } = updates
    const merged = normalizeAgentConfig({ ...existing, ...cfgPatch, id })
    this.writeJson(merged)
    if (typeof soulContent === 'string') {
      this.fsImpl.writeFileSync(path.join(this.dirOf(id), merged.soulFile), soulContent, 'utf-8')
    }
    return merged
  }

  /** 删除 Agent 目录（递归） */
  deleteAgent(id: string): void {
    assertValidId(id)
    const dir = this.dirOf(id)
    if (this.fsImpl.existsSync(dir)) {
      this.fsImpl.rmSync(dir, { recursive: true, force: true })
    }
  }

  /** 读取 SOUL.md 文本 */
  readSoul(id: string): string {
    const cfg = this.readRaw(id)
    if (!cfg) {return ''}
    const p = path.join(this.dirOf(id), cfg.soulFile)
    if (!this.fsImpl.existsSync(p)) {return ''}
    return this.fsImpl.readFileSync(p, 'utf-8')
  }

  private writeJson(cfg: CustomAgentConfig): void {
    this.fsImpl.writeFileSync(this.jsonPath(cfg.id), JSON.stringify(cfg, null, 2), 'utf-8')
  }
}

// ═══════════════════════════════════════════════════════════
// D3: 注册到团队（global.__lumina_custom_profiles）
// ============================================================

/** 注入到 agentTeamPersonas 的 profile 形状 */
export interface RegisteredCustomProfile {
  id: string
  name: string
  icon: string
  role: string
  description: string
  systemPrompt: string
  capabilities: string[]
  teamRole: CustomTeamRole
}

/**
 * 扫描全部自定义 Agent，注册到 global.__lumina_custom_profiles。
 * 与内置三 Agent 共存：member → 后台 worker（可被 Lumina 委托）；
 * leader → 对用户可见（可在设置中切换为默认）；solo → 不参与团队。
 */
export function registerCustomAgents(manager: CustomAgentManager): RegisteredCustomProfile[] {
  const agents = manager.listCustomAgents()
  const profiles: RegisteredCustomProfile[] = agents
    .filter((a) => a.visible)
    .map((a) => ({
      id: `custom_${a.id}`,
      name: a.name,
      icon: a.icon,
      role: a.teamRole === 'leader' ? 'boss' : 'worker',
      description: a.personality || `自定义 Agent：${a.name}`,
      systemPrompt: manager.readSoul(a.id),
      capabilities: a.toolsets,
      teamRole: a.teamRole,
    }))
  ;(global as any).__lumina_custom_profiles = profiles
  return profiles
}

/** 解析自定义 Agent 的 baseDir（主进程用：项目根/electron/agents/custom） */
export function resolveCustomAgentsDir(root?: string): string {
  let base: string = (root || process.cwd())
  if (!base) {
    try {base = require('electron').app.getAppPath()} catch {base = process.cwd()}
  }
  return path.join(base, 'electron', 'agents', 'custom')
}

let _defaultManager: CustomAgentManager | null = null

/** 主进程单例 */
export function getCustomAgentManager(root?: string): CustomAgentManager {
  if (!_defaultManager) {
    _defaultManager = new CustomAgentManager(resolveCustomAgentsDir(root))
  }
  return _defaultManager
}
