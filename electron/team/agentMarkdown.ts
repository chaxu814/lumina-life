// ============================================================
// agentMarkdown.ts — v3.30 Markdown 化 Agent 定义 + 热加载
//
// 对标 cc-haha 的「agent 定义是文件、可热加载」：每个 .md 文件是一个
// 可雇佣的自定义工种，frontmatter 写元数据，正文是系统提示。
//
// 扫描目录（两个位置都支持）：
//   1. 项目目录 agents/（随仓库走）
//   2. userData/agents/（用户自定义）
//
// 用 fs.watch 热加载：文件改了，下一次雇佣立即生效，无需重启。
//
// Frontmatter 是 YAML 子集（无第三方依赖）：
//   ---
//   id: translator
//   name: 翻译员
//   icon: 🌐
//   model_tier: small        # 可选 small/strong
//   blocked: [shell_exec, file_write]
//   capabilities: 中英互译, 术语统一
//   blind_spots: 不查事实, 不改代码
//   ---
//   （正文：系统提示词）
// ============================================================

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { EventEmitter } from 'events'

export interface MarkdownAgent {
  id: string
  name: string
  icon: string
  /** 正文系统提示 */
  prompt: string
  /** 模型分级：small=杂活小模型，strong=主力（默认 strong） */
  modelTier: 'small' | 'strong'
  blocked: string[]
  capabilities: string[]
  blindSpots: string[]
  description: string
  /** v3.33 投入度：low=少步数快答（默认 8 工具步）/ medium=默认 / high=深做（20 步） */
  effort: 'low' | 'medium' | 'high'
  /** v3.33 路径作用域：该工种只允许读写此目录（写进系统提示与 worktree 规则） */
  pathScope?: string
  source: string
  mtime: number
}

/** 解析 frontmatter（YAML 子集，纯函数可单测） */
export function parseAgentMarkdown(raw: string, source = '<memory>'): MarkdownAgent | null {
  const text = raw.replace(/^\uFEFF/, '')
  const fmMatch = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/)
  if (!fmMatch) {return null}
  const fm = fmMatch[1]
  const body = fmMatch[2].trim()

  const kv: Record<string, string> = {}
  for (const line of fm.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) {continue}
    const idx = line.indexOf(':')
    if (idx < 0) {continue}
    const k = line.slice(0, idx).trim().toLowerCase()
    let v = line.slice(idx + 1).trim()
    // 去引号
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    kv[k] = v
  }

  const id = (kv.id || '').trim()
  if (!id) {return null}
  const splitList = (v: string): string[] => {
    if (!v) {return []}
    // [a, b, c] 或 a,b,c
    const inner = v.replace(/^\[/, '').replace(/\]$/, '')
    return inner.split(/[,，]/).map(s => s.trim()).filter(Boolean)
  }

  return {
    id,
    name: kv.name || id,
    icon: kv.icon || '👷',
    prompt: body,
    modelTier: kv.model_tier === 'small' ? 'small' : 'strong',
    blocked: splitList(kv.blocked || kv.blocklist || ''),
    capabilities: splitList(kv.capabilities || kv.capability || ''),
    blindSpots: splitList(kv.blind_spots || kv.blindspots || ''),
    description: kv.description || body.slice(0, 60),
    effort: kv.effort === 'low' || kv.effort === 'high' ? kv.effort : 'medium',
    ...(kv.path_scope || kv.pathscope ? { pathScope: (kv.path_scope || kv.pathscope).trim() } : {}),
    source,
    mtime: 0,
  }
}

/** 序列化为 .md（生成自定义 agent 时用） */
export function serializeAgentMarkdown(a: Omit<MarkdownAgent, 'source' | 'mtime'>): string {
  const list = (xs: string[]) => xs.length ? `[${xs.join(', ')}]` : '[]'
  return `---
id: ${a.id}
name: ${a.name}
icon: ${a.icon}
model_tier: ${a.modelTier}
blocked: ${list(a.blocked)}
capabilities: ${list(a.capabilities)}
blind_spots: ${list(a.blindSpots)}
effort: ${a.effort || 'medium'}
${a.pathScope ? `path_scope: ${a.pathScope}\n` : ''}description: ${a.description || ''}
---
${a.prompt}
`
}

export class AgentMarkdownRegistry extends EventEmitter {
  private agents = new Map<string, MarkdownAgent>()
  private watched = new Set<string>()
  private watchers: fs.FSWatcher[] = []

  /** 扫描目录列表（项目 agents/ + userData/agents/） */
  static defaultDirs(): string[] {
    const dirs: string[] = []
    try {
      // 项目根：app.getAppPath() 在打包后是 asar，开发时是项目根
      const cwd = process.cwd()
      dirs.push(path.join(cwd, 'agents'))
    } catch { /* ignore */ }
    try {
      dirs.push(path.join(app.getPath('userData'), 'agents'))
    } catch { /* 非 Electron 环境 */ }
    return dirs
  }

  reload(dirs: string[] = AgentMarkdownRegistry.defaultDirs()): MarkdownAgent[] {
    const found = new Map<string, MarkdownAgent>()
    for (const dir of dirs) {
      let files: string[] = []
      try {
        files = fs.existsSync(dir)
          ? fs.readdirSync(dir).filter(f => f.endsWith('.md'))
          : []
      } catch {continue}
      for (const f of files) {
        const full = path.join(dir, f)
        try {
          const stat = fs.statSync(full)
          const parsed = parseAgentMarkdown(fs.readFileSync(full, 'utf-8'), full)
          if (!parsed) {continue}
          // userData 自定义 agent 覆盖项目同名 agent
          parsed.mtime = stat.mtimeMs
          found.set(parsed.id, parsed)
        } catch (e) {
          console.warn(`[agentMarkdown] 解析失败 ${f}:`, (e as Error)?.message)
        }
      }
      this.watchDir(dir)
    }
    const before = new Set(this.agents.keys())
    const after = new Set(found.keys())
    this.agents = found
    for (const id of [...before, ...after]) {
      if (!before.has(id) || !after.has(id) || this.agents.get(id) !== found.get(id)) {
        this.emit('change', id)
      }
    }
    return Array.from(found.values())
  }

  private watchDir(dir: string): void {
    if (this.watched.has(dir)) {return}
    try {
      fs.mkdirSync(dir, { recursive: true })
      const w = fs.watch(dir, { persistent: false }, () => {
        // 防抖：编辑器保存常触发多次
        if (this._debounce) {clearTimeout(this._debounce)}
        this._debounce = setTimeout(() => {
          try {this.reload()} catch { /* ignore */ }
        }, 300)
      })
      this.watchers.push(w)
      this.watched.add(dir)
    } catch { /* 目录不可监视时静默 */ }
  }
  private _debounce: ReturnType<typeof setTimeout> | null = null

  get(id: string): MarkdownAgent | undefined {
    return this.agents.get(id)
  }
  list(): MarkdownAgent[] {
    return Array.from(this.agents.values())
  }
  has(id: string): boolean {
    return this.agents.has(id)
  }

  /** 写入一个自定义 agent 到 userData/agents/ */
  save(dir: string, agent: Omit<MarkdownAgent, 'source' | 'mtime'>): MarkdownAgent {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${agent.id}.md`)
    fs.writeFileSync(file, serializeAgentMarkdown(agent), 'utf-8')
    this.reload()
    return this.get(agent.id)!
  }

  dispose(): void {
    for (const w of this.watchers) {try {w.close()} catch { /* ignore */ }}
    this.watchers = []
    this.watched.clear()
  }
}

let _registry: AgentMarkdownRegistry | null = null
export function getAgentMarkdownRegistry(): AgentMarkdownRegistry {
  if (!_registry) {
    _registry = new AgentMarkdownRegistry()
    _registry.reload()
  }
  return _registry
}
