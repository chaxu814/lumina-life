// ============================================================
// chatCommands.ts — 聊天命令系统 (v2.7)
//
// 借鉴 QwenPaw command_dispatch.py:
//   聊天框内 / 命令前置拦截，不发送给 LLM
//   支持命令别名 + 参数 + 权限检查
//
// 命令列表:
//   /help          — 显示所有命令
//   /compact       — 手动触发上下文压缩
//   /new           — 开始新对话
//   /stop          — 停止当前 Agent
//   /skills        — 列出已安装 skills
//   /agents        — 列出可用 Agent
//   /switch <name> — 切换角色 (lumina/yak/recha)
//   /yak <task>    — 🆕 强制派活给 Yak（跳过路由仲裁，确定性）
//   /recha <task>  — 🆕 强制派活给 热茶（跳过路由仲裁，确定性）
//   /lumina <task> — 🆕 强制由 Lumina 自己答（跳过路由仲裁）
//   /approve <id>  — 审批操作
//   /deny <id>     — 拒绝操作
//   /plan <desc>   — 创建执行计划
//   /stats         — 查看用量统计
//   /clear         — 清空聊天记录
//   /export        — 导出对话
// ============================================================

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface CommandDef {
  name: string
  aliases: string[]
  description: string
  usage: string
  /** 所需的最小参数数量 */
  minArgs: number
  /** 是否需要 Agent 在运行 */
  requiresAgent?: boolean
  /** 是否需要审批服务 */
  requiresApproval?: boolean
}

export interface ParsedCommand {
  command: CommandDef
  args: string[]
  rawInput: string
}

export type CommandHandler = (parsed: ParsedCommand) => Promise<CommandResult>

export interface CommandResult {
  success: boolean
  message: string
  data?: any
}

// ═══════════════════════════════════════════════════════════
// 命令注册表
// ═══════════════════════════════════════════════════════════

const COMMANDS: CommandDef[] = [
  {
    name: 'help',
    aliases: ['h', '?'],
    description: '显示所有可用命令',
    usage: '/help [命令名]',
    minArgs: 0,
  },
  {
    name: 'compact',
    aliases: ['压缩'],
    description: '手动触发上下文压缩',
    usage: '/compact',
    minArgs: 0,
    requiresAgent: true,
  },
  {
    name: 'new',
    aliases: ['reset', '新对话'],
    description: '开始新对话（保留压缩上下文）',
    usage: '/new',
    minArgs: 0,
  },
  {
    name: 'stop',
    aliases: ['停止'],
    description: '停止当前 Agent 运行',
    usage: '/stop',
    minArgs: 0,
    requiresAgent: true,
  },
  {
    name: 'skills',
    aliases: ['技能'],
    description: '列出已安装的 Skills',
    usage: '/skills [workspace]',
    minArgs: 0,
  },
  {
    name: 'agents',
    aliases: ['角色', 'agent'],
    description: '列出可用 Agent 角色',
    usage: '/agents',
    minArgs: 0,
  },
  {
    name: 'switch',
    aliases: ['切换', 'use'],
    description: '切换当前 Agent 角色（lumina / yak / recha）',
    usage: '/switch <lumina|yak|recha>',
    minArgs: 1,
  },
  // 🆕 确定性派活命令 —— 给专业用户的「逃生舱」
  //   背景：默认路由由模型裁量（routingDecider 只注入提示语），同一问题两次
  //   可能派活不同。专业用户最在意确定性，这三条命令跳过路由仲裁，直接把
  //   这一条消息强制交给指定角色（一次性，不影响后续消息）。
  {
    name: 'yak',
    aliases: ['码', 'code'],
    description: '强制把这条任务派给 Yak（代码工程师），跳过自动路由',
    usage: '/yak <任务描述>',
    minArgs: 1,
    requiresAgent: true,
  },
  {
    name: 'recha',
    aliases: ['茶', 'review'],
    description: '强制把这条任务派给 热茶（审查员），跳过自动路由',
    usage: '/recha <任务描述>',
    minArgs: 1,
    requiresAgent: true,
  },
  {
    name: 'lumina',
    aliases: ['自己答', 'self'],
    description: '强制由 Lumina 自己作答，不外派',
    usage: '/lumina <任务描述>',
    minArgs: 1,
    requiresAgent: true,
  },
  {
    name: 'approve',
    aliases: ['同意', 'yes', '允许'],
    description: '批准待审批的操作',
    usage: '/approve <审批ID>',
    minArgs: 1,
    requiresApproval: true,
  },
  {
    name: 'deny',
    aliases: ['拒绝', 'no'],
    description: '拒绝待审批的操作',
    usage: '/deny <审批ID>',
    minArgs: 1,
    requiresApproval: true,
  },
  {
    name: 'plan',
    aliases: ['计划'],
    description: '为复杂任务创建执行计划',
    usage: '/plan <任务描述>',
    minArgs: 1,
    requiresAgent: true,
  },
  {
    name: 'stats',
    aliases: ['统计', '用量'],
    description: '查看 Token 用量统计',
    usage: '/stats',
    minArgs: 0,
  },
  {
    name: 'clear',
    aliases: ['清屏', 'cls'],
    description: '清空当前聊天显示（不影响记忆）',
    usage: '/clear',
    minArgs: 0,
  },
  {
    name: 'export',
    aliases: ['导出'],
    description: '导出当前对话',
    usage: '/export [json|markdown]',
    minArgs: 0,
  },
  // 新增命令
  {
    name: 'mission',
    aliases: ['任务', 'm'],
    description: '启动自主任务执行 (Mission Mode)',
    usage: '/mission <任务描述> [--verify "命令"] [--max-iterations N]',
    minArgs: 1,
    requiresAgent: true,
  },
  {
    name: 'hooks',
    aliases: ['hook'],
    description: '列出所有注册的 Hook',
    usage: '/hooks [enable|disable <hook_id>]',
    minArgs: 0,
  },
  {
    name: 'model',
    aliases: ['模型'],
    description: '显示当前模型信息',
    usage: '/model',
    minArgs: 0,
  },
  {
    name: 'context',
    aliases: ['上下文', 'ctx'],
    description: '显示当前上下文大小',
    usage: '/context',
    minArgs: 0,
    requiresAgent: true,
  },
  {
    name: 'retry',
    aliases: ['重试'],
    description: '重试上次失败的操作',
    usage: '/retry',
    minArgs: 0,
    requiresAgent: true,
  },
  {
    name: 'decide',
    aliases: ['决定', '定'],
    description: '生活决策三栏辩论：执行者拆可行性、审查员挑风险、Lumina 给最终建议',
    usage: '/decide <问题，如：买电动车还是油车>',
    minArgs: 1,
    requiresAgent: false,
  },
]

// ═══════════════════════════════════════════════════════════
// CommandRouter
// ═══════════════════════════════════════════════════════════

export class CommandRouter {
  private handlers = new Map<string, CommandHandler>()

  /** 注册命令处理器 */
  register(commandName: string, handler: CommandHandler): void {
    this.handlers.set(commandName, handler)
  }

  /** 批量注册 */
  registerAll(handlers: Record<string, CommandHandler>): void {
    for (const [name, handler] of Object.entries(handlers)) {
      this.register(name, handler)
    }
  }

  // ── 命令检测 ───────────────────────────────────────

  /** 检查输入是否以 / 开头 */
  static isCommand(input: string): boolean {
    return input.trimStart().startsWith('/')
  }

  /** 是否为 /plan 命令（带参数，不是独立命令） */
  static isPlanCommand(input: string): boolean {
    const trimmed = input.trimStart()
    const parts = trimmed.slice(1).split(/\s+/)
    return parts[0] === 'plan' && parts.length > 1
  }

  /** 解析命令 */
  parse(input: string): ParsedCommand | null {
    const trimmed = input.trimStart()
    if (!trimmed.startsWith('/')) {return null}

    const parts = trimmed.slice(1).split(/\s+/)
    const commandName = parts[0].toLowerCase()
    const args = parts.slice(1).filter(a => a.length > 0)

    // 查找命令 (精确匹配 + 别名匹配)
    let command = COMMANDS.find(c => c.name === commandName)
    if (!command) {
      command = COMMANDS.find(c => c.aliases.some(a => a.toLowerCase() === commandName))
    }

    if (!command) {return null}

    return {
      command,
      args,
      rawInput: trimmed,
    }
  }

  // ── 执行命令 ───────────────────────────────────────

  async execute(parsed: ParsedCommand): Promise<CommandResult> {
    // 检查参数数量
    if (parsed.args.length < parsed.command.minArgs) {
      return {
        success: false,
        message: `参数不足。用法: ${parsed.command.usage}`,
      }
    }

    // 查找处理器
    const handler = this.handlers.get(parsed.command.name)
    if (!handler) {
      return {
        success: false,
        message: `命令 "${parsed.command.name}" 尚未实现。`,
      }
    }

    try {
      return await handler(parsed)
    } catch (err: any) {
      return {
        success: false,
        message: `命令执行失败: ${err.message}`,
      }
    }
  }

  // ── 生成帮助文本 ───────────────────────────────────

  generateHelp(commandName?: string): string {
    if (commandName) {
      const cmd = COMMANDS.find(c => c.name === commandName || c.aliases.includes(commandName))
      if (!cmd) {return `未知命令: ${commandName}`}
      return `${cmd.name} — ${cmd.description}\n用法: ${cmd.usage}\n别名: ${cmd.aliases.join(', ')}`
    }

    const lines: string[] = ['## 可用命令\n']

    // 按类别分组
    const categories: Record<string, CommandDef[]> = {
      '对话控制': COMMANDS.filter(c => ['compact', 'new', 'stop', 'clear'].includes(c.name)),
      '强制派活': COMMANDS.filter(c => ['yak', 'recha', 'lumina'].includes(c.name)),
      'Agent 管理': COMMANDS.filter(c => ['switch', 'agents', 'skills', 'mission'].includes(c.name)),
      '审批': COMMANDS.filter(c => ['approve', 'deny'].includes(c.name)),
      '工具': COMMANDS.filter(c => ['plan', 'stats', 'export', 'help'].includes(c.name)),
      '运行状态': COMMANDS.filter(c => ['model', 'context', 'retry', 'hooks'].includes(c.name)),
    }

    const shown = new Set<string>()
    for (const [category, cmds] of Object.entries(categories)) {
      if (cmds.length === 0) {continue}
      lines.push(`### ${category}`)
      for (const cmd of cmds) {
        lines.push(`- \`${cmd.usage}\` — ${cmd.description}`)
        shown.add(cmd.name)
      }
      lines.push('')
    }

    // 兜底：任何没被归类的命令也列出来，避免「新增了命令但 /help 看不到」
    const unlisted = COMMANDS.filter(c => !shown.has(c.name))
    if (unlisted.length > 0) {
      lines.push('### 其他')
      for (const cmd of unlisted) {
        lines.push(`- \`${cmd.usage}\` — ${cmd.description}`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  // ── 列出命令 ────────────────────────────────────────

  static listCommands(): CommandDef[] {
    return [...COMMANDS]
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let globalCommandRouter: CommandRouter | null = null

export function getCommandRouter(): CommandRouter {
  if (!globalCommandRouter) {
    globalCommandRouter = new CommandRouter()
  }
  return globalCommandRouter
}
