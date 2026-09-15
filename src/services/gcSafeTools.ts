// ============================================================
// gcSafeTools.ts — 群聊工具安全策略 (v3.1)
//
// 修复工具名与实际 registry 不匹配的问题
//         新增三级安全模式（用户可自定义）
// ============================================================

// ═══════════════════════════════════════════════════════════
// 团队 Agent 安全模式（用户可配置）
// ═══════════════════════════════════════════════════════════

/** 安全等级说明 */
export type TeamSecurityLevel = 'full_approval' | 'high_only' | 'skip_all'

/** 高风险工具清单（high_only 模式下需审批） */
export const HIGH_RISK_TOOLS = [
  // 文件变更
  'file_write',
  'file_edit',
  // 系统命令（可执行任意代码）
  'shell_exec',
  // 桌面控制（可获取屏幕内容+模拟操作）
  'desktop_see',
  'desktop_act',
  'desktop_click',
  'desktop_type',
  'keyboard_press',
  'keyboard_type',
  // 截图（可能泄露隐私）
  'screenshot',
  // 剪贴板写入
  'clipboard_set',
  // 外部通信
  'mail_send',
  // 定时任务
  'cron_schedule',
  'cron_cancel',
]

/** 安全等级对应行为 */
export const SECURITY_LEVEL_BEHAVIOR: Record<TeamSecurityLevel, string> = {
  full_approval: '所有破坏性操作都需用户确认（最安全）',
  high_only: '仅高风险操作需要确认（文件写入/系统命令/桌面控制/截图/邮件/定时任务）',
  skip_all: '跳过所有审批（信任模式，仅限完全受控环境）',
}

export interface TeamSecurityConfig {
  /** 安全等级 */
  level: TeamSecurityLevel
  /** 是否允许团队 agent 执行 shell 命令 */
  allowShell: boolean
  /** 是否允许团队 agent 打开浏览器 */
  allowBrowser: boolean
  /** 是否允许团队 agent 写入/修改文件 */
  allowFileWrite: boolean
  /** 是否允许团队 agent 控制桌面（屏幕理解/鼠标/键盘） */
  allowDesktop: boolean
  /** 是否允许团队 agent 使用剪贴板 */
  allowClipboard: boolean
}

/** 默认安全配置：允许编程+桌面控制+剪贴板，仅高风险需审批 */
export const DEFAULT_TEAM_SECURITY: TeamSecurityConfig = {
  level: 'high_only',
  allowShell: true,
  allowBrowser: true,
  allowFileWrite: true,
  allowDesktop: true,   // 🆕 v9.0: 团队 Agent 默认允许桌面控制
  allowClipboard: true, // 🆕 v9.0: 团队 Agent 默认允许剪贴板
}

// ═══════════════════════════════════════════════════════════
// 工具分类（按实际 registry 工具名）
// ═══════════════════════════════════════════════════════════

/** 系统操作类 */
const SYSTEM_TOOLS = [
  'shell_exec',         // 命令行执行
  'system_info',        // 系统信息
  'process_list',       // 进程列表
  'notification',       // 系统通知
  'open_file',          // 打开文件
  'screenshot',         // 截屏
]

/** 桌面控制类（高危） */
const DESKTOP_TOOLS = [
  'desktop_see',        // 屏幕理解
  'desktop_act',        // 桌面操作
  'desktop_click',      // 鼠标点击
  'desktop_type',       // 键盘输入
  'desktop_key',        // 按键
  'desktop_screen_size',// 屏幕尺寸
  'keyboard_press',     // 键盘按压
  'keyboard_type',      // 键盘打字
]

/** 文件修改类 */
const FILE_WRITE_TOOLS = [
  'file_write',         // 写入文件
  'file_edit',          // 编辑文件
]

/** 文件读取类（安全） */
const FILE_READ_TOOLS = [
  'file_read',          // 读取文件
  'file_list',          // 列出目录
]

/** 浏览器类 */
const BROWSER_TOOLS = [
  'browser',            // 浏览器操作
  'web_fetch',          // 网页抓取
  'web_search',         // 网页搜索
]

/** Git 操作类 */
const GIT_TOOLS = [
  'git_status',
  'git_commit',
  'git_log',
  'git_diff',
]

/** 外部通信类（危险） */
const EXTERNAL_TOOLS = [
  'mail_send',          // 发送邮件
  'mail_list',          // 邮件列表
  'mail_mark_read',     // 标记已读
  'mcp_list_servers',   // MCP 服务器列表
  'mcp_connect',        // MCP 连接
  'mcp_list_tools',     // MCP 工具列表
  'mcp_call_tool',      // MCP 调用
]

/** 定时任务类 */
const CRON_TOOLS = [
  'cron_schedule',      // 创建定时任务
  'cron_list',          // 列出定时任务
  'cron_cancel',        // 取消定时任务
]

/** 隐私敏感类 */
const PRIVACY_TOOLS = [
  'ocr',                // OCR 扫描
  'oath_make',          // 创建誓约
  'oath_list',          // 誓约列表
  'oath_fulfill',       // 履行誓约
  'hearing_start',      // 开始监听
  'hearing_stop',       // 停止监听
  'hearing_status',     // 监听状态
  'hearing_transcript', // 监听转录
]

/** 行为修改类 */
const BEHAVIOR_TOOLS = [
  'todo',               // 待办（修改状态）
  'proactive_status',   // 主动状态
  'proactive_trigger',  // 主动触发
  'appointment_set',    // 设置预约
  'appointment_list',   // 预约列表
]

/** 记忆/技能/团队类（安全） */
const SAFE_TOOLS = [
  'memory_save',         // 保存记忆
  'memory_get',          // 读取记忆
  'memory_all',          // 全部记忆
  'memory_summarize',    // 记忆摘要
  'memory_search',       // 搜索记忆
  'memory_save_v2',      // v2 保存记忆
  'memory_search_v2',    // v2 搜索记忆
  'memory_team_context', // 团队上下文
  'skill_run',           // 运行技能
  'datetime',            // 日期时间
  'weather',             // 天气
  'delegate_to',         // 委托任务
  'query_teammate',      // 查询队友
  'ask_teammate',        // 询问队友
  'use_skill',           // 使用技能
  'list_skills',         // 列出技能
  'team_context',        // 团队上下文
  'set_project_context', // 设置项目上下文
]

// ═══════════════════════════════════════════════════════════
// 根据安全配置生成禁用工具列表
// ═══════════════════════════════════════════════════════════

export function getDisabledTools(config: TeamSecurityConfig): string[] {
  const disabled: string[] = []

  // 始终禁用：外部通信、定时任务、隐私敏感、行为修改
  disabled.push(...EXTERNAL_TOOLS)
  disabled.push(...CRON_TOOLS)
  disabled.push(...PRIVACY_TOOLS)
  disabled.push(...BEHAVIOR_TOOLS)

  // 根据安全配置决定
  if (!config.allowShell) {
    disabled.push(...SYSTEM_TOOLS)
  }

  if (!config.allowFileWrite) {
    disabled.push(...FILE_WRITE_TOOLS)
  } else {
    // 允许写文件但保留部分危险系统工具禁用
    // 只禁用 system_info/process_list/notification（信息泄露风险）
    disabled.push('system_info', 'process_list', 'notification')
  }

  if (!config.allowBrowser) {
    disabled.push(...BROWSER_TOOLS)
  }

  // 🆕 v9.0: 桌面控制可配置（之前始终禁用）
  if (!config.allowDesktop) {
    disabled.push(...DESKTOP_TOOLS)
  }

  // 🆕 v9.0: 剪贴板可配置（之前始终禁用）
  if (!config.allowClipboard) {
    disabled.push('clipboard_get', 'clipboard_set')
  }

  return disabled
}

/** 兼容旧接口：默认禁用列表（v3.0 行为） */
export const GC_DISABLED_TOOLS = getDisabledTools(DEFAULT_TEAM_SECURITY)

// ═══════════════════════════════════════════════════════════
// ✅ 群聊可用工具（仅用于系统提示词，不是实际过滤）
// ═══════════════════════════════════════════════════════════

export interface ToolInfo {
  name: string
  desc: string
  icon: string
  category?: string
}

export function getAvailableTools(config: TeamSecurityConfig): ToolInfo[] {
  const tools: ToolInfo[] = []

  // 始终可用
  tools.push(
    { name: 'web_search',       desc: '搜索互联网',          icon: '🔍',  category: '网络' },
    { name: 'web_fetch',        desc: '抓取网页内容',        icon: '📄',  category: '网络' },
    { name: 'file_read',        desc: '读取本地文件内容',    icon: '📁',  category: '文件' },
    { name: 'file_list',        desc: '列出文件目录',        icon: '📂',  category: '文件' },
    { name: 'weather',          desc: '查询天气',            icon: '🌤️', category: '信息' },
    { name: 'datetime',         desc: '获取当前时间',        icon: '🕐',  category: '信息' },
    { name: 'memory_search',    desc: '搜索记忆',            icon: '🔎',  category: '记忆' },
    { name: 'memory_get',       desc: '读取记忆',            icon: '🧠',  category: '记忆' },
    { name: 'memory_save',      desc: '保存记忆',            icon: '💾',  category: '记忆' },
  )

  if (config.allowBrowser) {
    tools.push(
      { name: 'browser',         desc: '打开/控制浏览器',    icon: '🌐',  category: '桌面' },
    )
  }

  if (config.allowShell) {
    tools.push(
      { name: 'shell_exec',      desc: '执行终端命令',       icon: '💻',  category: '系统' },
      { name: 'open_file',       desc: '打开文件/文件夹',    icon: '📂',  category: '系统' },
      { name: 'screenshot',      desc: '截取屏幕截图',       icon: '📸',  category: '系统' },
    )
  }

  if (config.allowFileWrite) {
    tools.push(
      { name: 'file_write',      desc: '写入/创建文件',      icon: '✏️',  category: '文件' },
      { name: 'file_edit',       desc: '编辑已有文件',       icon: '📝',  category: '文件' },
    )
  }

  // 🆕 v9.0: 桌面控制工具
  if (config.allowDesktop) {
    tools.push(
      { name: 'desktop_see',     desc: '理解屏幕内容',      icon: '👁️',  category: '桌面' },
      { name: 'desktop_click',   desc: '点击屏幕坐标',      icon: '🖱️',  category: '桌面' },
      { name: 'desktop_type',    desc: '屏幕输入文字',       icon: '⌨️',  category: '桌面' },
      { name: 'keyboard_press',  desc: '按下键盘按键',       icon: '🎹',  category: '桌面' },
      { name: 'keyboard_type',   desc: '键盘输入文字',       icon: '⌨️',  category: '桌面' },
    )
  }

  // 🆕 v9.0: 剪贴板工具
  if (config.allowClipboard) {
    tools.push(
      { name: 'clipboard_get',   desc: '读取剪贴板',        icon: '📋',  category: '系统' },
      { name: 'clipboard_set',   desc: '写入剪贴板',        icon: '📋',  category: '系统' },
    )
  }

  // 团队协作工具（始终可用）
  tools.push(
    { name: 'delegate_to',       desc: '委托任务给队友',    icon: '🤝',  category: '团队' },
    { name: 'query_teammate',    desc: '咨询队友意见',       icon: '💬',  category: '团队' },
    { name: 'skill_run',         desc: '运行内置技能',       icon: '⚡',  category: '技能' },
  )

  return tools
}

export const GC_AVAILABLE_TOOLS = getAvailableTools(DEFAULT_TEAM_SECURITY)

// ═══════════════════════════════════════════════════════════
// 工具通知描述（用于 UI 提示）
// ═══════════════════════════════════════════════════════════

export function getToolNotification(toolName: string, args: Record<string, any>): string {
  const descriptions: Record<string, (args: any) => string> = {
    // 网络
    web_search: (a) => `🔍 正在搜索：「${a.query || a.q || '...'}」`,
    web_fetch: (a) => `📄 正在读取网页：${(a.url || '').slice(0, 50)}`,
    browser: (a) => {
      const url = a.url || ''
      const action = a.action || ''
      if (action === 'launch' || action === 'open' || action === 'navigate') return `🌐 正在打开浏览器：${url.slice(0, 50)}`
      if (action === 'snapshot') return `🌐 正在截取网页快照`
      if (action === 'click') return `🌐 正在点击网页元素`
      return `🌐 浏览器操作：${action || url.slice(0, 50) || '...'}`
    },
    // 文件
    file_read: (a) => `📁 正在读取文件：${(a.filePath || a.path || a.file_path || '').slice(0, 40)}`,
    file_list: (a) => `📂 正在浏览目录：${(a.dirPath || a.path || '').slice(0, 40)}`,
    file_write: (a) => `✏️ 正在写入文件：${(a.filePath || a.path || a.file_path || '').slice(0, 40)}`,
    file_edit: (a) => `📝 正在编辑文件：${(a.filePath || a.path || a.file_path || '').slice(0, 40)}`,
    // 系统
    shell_exec: (a) => `💻 正在执行命令：${(a.command || a.cmd || '').slice(0, 50)}`,
    open_file: (a) => `📂 正在打开：${(a.target || a.path || a.filePath || '').slice(0, 40)}`,
    screenshot: () => `📸 正在截图...`,
    // 🆕 v9.0: 桌面控制
    desktop_see: () => `👁️ 正在查看屏幕内容...`,
    desktop_click: (a) => `🖱️ 正在点击屏幕坐标 (${a.x || '?'}, ${a.y || '?'})`,
    desktop_type: (a) => `⌨️ 正在屏幕输入：${(a.text || '').slice(0, 30)}`,
    keyboard_press: (a) => `🎹 正在按键：${a.key || '?'}`,
    keyboard_type: (a) => `⌨️ 正在键盘输入：${(a.text || '').slice(0, 30)}`,
    // 🆕 v9.0: 剪贴板
    clipboard_get: () => `📋 正在读取剪贴板...`,
    clipboard_set: (a) => `📋 正在写入剪贴板：${(a.text || '').slice(0, 30)}`,
    // 信息
    weather: () => '🌤️ 正在查询天气...',
    datetime: () => '🕐 正在确认时间...',
    // 记忆
    memory_search: (a) => `🔎 正在搜索记忆：「${(a.query || '').slice(0, 30)}」`,
    memory_get: (a) => `🧠 正在读取记忆：${(a.key || a.query || '').slice(0, 30)}`,
    memory_save: (a) => `💾 正在保存记忆：${(a.key || '').slice(0, 30)}`,
    memory_save_v2: (a) => `💾 正在保存记忆(v2)：${(a.key || '').slice(0, 30)}`,
    memory_search_v2: (a) => `🔎 正在搜索记忆(v2)：「${(a.query || '').slice(0, 30)}」`,
    // 团队
    delegate_to: (a) => `🤝 正在委托任务给 ${a.agent || a.to || '队友'}...`,
    query_teammate: (a) => `💬 正在咨询 ${a.agent || a.to || '队友'}...`,
    ask_teammate: (a) => `💬 正在询问 ${a.agent || a.to || '队友'}...`,
    // 技能
    skill_run: (a) => `⚡ 正在运行技能：${a.skill || a.name || '...'}`,
  }
  const fn = descriptions[toolName]
  return fn ? fn(args) : `🔧 正在使用工具：${toolName}`
}

// ═══════════════════════════════════════════════════════════
// 🧠 智能工具分配 — 根据用户意图动态决定启用哪些工具
// ═══════════════════════════════════════════════════════════

export type ToolCategory =
  | 'general'      // 通用对话（默认，所有工具可用）
  | 'file'         // 有文件附件
  | 'math'         // 纯数学/推理
  | 'search'       // 网络搜索
  | 'shell'        // 系统命令
  | 'desktop'      // 桌面控制
  | 'clipboard'    // 剪贴板
  | 'memory'       // 记忆
  | 'team'         // 团队协作
  | 'info'         // 信息查询

/** 工具意图 */
export interface ToolIntent {
  categories: ToolCategory[]
  isPureReasoning: boolean
}

/** 群聊工具信息 */
export interface GCToolInfo {
  name: string
  description: string
  category: ToolCategory
  dangerous: boolean
}

/**
 * 🧠 智能意图检测 — 分析用户消息和附件
 *
 * 设计原则（v9.1 重写）：
 * 1. 默认 general — 所有工具可用，不要轻易剥夺 LLM 的能力
 * 2. 只有明确有附件时才标记 file
 * 3. 不做关键词匹配 — 学习领域太广，无法穷举
 * 4. 让 LLM 自己决定用什么工具
 */
export function detectToolIntent(userMessage: string, hasAttachments?: boolean): ToolIntent {
  if (hasAttachments) {
    return { categories: ['general', 'file'], isPureReasoning: false }
  }
  // 默认：通用模式，所有工具可用
  return { categories: ['general'], isPureReasoning: false }
}

/**
 * 根据意图返回可用工具列表（过滤掉不需要的）
 */
export function getToolsForIntent(
  config: TeamSecurityConfig,
  intent: ToolIntent,
): ToolInfo[] {
  const allTools = getAvailableTools(config)

  if (intent.isPureReasoning) {
    // 纯推理 — 不提供任何工具
    return []
  }

  // general → 保留所有允许的工具
  if (intent.categories.includes('general')) {
    return allTools
  }

  // 按分类过滤
  const categoryMap: Record<ToolCategory, string[]> = {
    math: [],
    search: ['web_search', 'web_fetch', 'browser', 'open_file'],
    file: ['file_list', 'file_read', 'file_write', 'file_edit', 'open_file'],
    shell: ['shell_exec', 'open_file'],
    desktop: ['desktop_see', 'desktop_click', 'desktop_type', 'keyboard_press', 'keyboard_type'],
    clipboard: ['clipboard_get', 'clipboard_set'],
    memory: ['memory_search', 'memory_get', 'memory_save', 'memory_save_v2', 'memory_search_v2'],
    team: ['delegate_to', 'query_teammate', 'ask_teammate', 'skill_run'],
    info: ['weather', 'datetime'],
    general: [],
  }

  const allowedTools = new Set<string>()
  intent.categories.forEach(cat => {
    (categoryMap[cat] || []).forEach(t => allowedTools.add(t))
  })

  return allTools.filter(t => allowedTools.has(t.name))
}

/**
 * 根据意图生成工具提示词
 * v9.1: 简化 — 几乎所有场景都用完整工具提示，只有纯数学才精简
 */
export function getGCToolsPromptForIntent(
  config?: TeamSecurityConfig,
  intent?: ToolIntent,
): string {
  // 通用模式（默认）→ 使用完整工具提示
  if (!intent || intent.categories.includes('general') || !intent.isPureReasoning) {
    return getGCToolsPrompt(config)
  }
  // 纯数学推理 → 精简提示，但仍保留搜索能力
  return '【💡 推理/数学模式 — 直接分析并回答问题。如果需要搜索相关定理、公式或数据，可以使用 web_search。你也可以使用 file_read 查看用户上传的文件。】'
}

// ═══════════════════════════════════════════════════════════
// 群聊 System Prompt 的工具说明（显式参数+示例）
// ═══════════════════════════════════════════════════════════

export function getGCToolsPrompt(config?: TeamSecurityConfig): string {
  const cfg = config || DEFAULT_TEAM_SECURITY
  const lines: string[] = []

  lines.push(`【⚡ 你可以使用的工具 — 像真实的 AI 助手一样用工具帮用户做事】`)
  lines.push(``)
  lines.push(`⚠️ 重要：当用户叫你「查阅」「搜索」「查一下」「找资料」时，你必须用 web_search + web_fetch 去搜索，不要凭记忆回答。`)
  lines.push(`⚠️ 重要：如果你需要实时信息，直接输出 <web_search(query="你的搜索关键词")> 让系统执行搜索，不要说"让我查一下"而不执行。`)
  lines.push(`⚠️ 重要：数学计算、知识问答、翻译、写作等不需要工具，直接回答即可。不要对这些场景调用 shell_exec 或任何工具。`)
  lines.push(``)

  // ── 打开东西（最高频操作）──
  lines.push(`📂 打开文件/文件夹/网站：【用 open_file，不要用 shell_exec start！】`)
  lines.push(`  - open_file(target="路径或URL")  → 用系统默认程序打开任何东西`)
  lines.push(`    例：open_file(target="C:\\Users\\xxx\\Desktop")  → 打开桌面`)
  lines.push(`    例：open_file(target="https://bilibili.com")    → 打开网站`)
  lines.push(`    例：open_file(target="notepad.exe")            → 打开记事本`)
  lines.push(``)

  // ── 浏览器 ──
  if (cfg.allowBrowser) {
    lines.push(`🌐 浏览器与网络：`)
    lines.push(`  - browser(action="launch", url="网址")  → 在浏览器中打开URL`)
    lines.push(`    例：browser(action="launch", url="https://bilibili.com")`)
    lines.push(`  - web_search(query="关键词", engine="搜索引擎")  → 多引擎搜索 (支持 bing/google/baidu)`)
    lines.push(`    例：web_search(query="AI Agent 对比", engine="google")`)
    lines.push(`    例：web_search(query="中国股市 最新", engine="baidu")`)
    lines.push(`  - web_fetch(url="网址")                  → 抓取网页内容`)
    lines.push(``)
  }

  // ── 文件浏览 ──
  lines.push(`📁 查看文件：`)
  lines.push(`  - file_list(dirPath="目录路径")  → 列出目录中的文件`)
  lines.push(`    例：file_list(dirPath="C:\\Users\\xxx\\Desktop")`)
  lines.push(`  - file_read(filePath="文件路径") → 读取文本文件内容`)
  lines.push(`    例：file_read(filePath="C:\\project\\README.md")`)
  if (cfg.allowFileWrite) {
    lines.push(`  - file_write(filePath="路径", content="内容") → 写入文件`)
    lines.push(`  - file_edit(filePath="路径", old_text="旧文本", new_text="新文本") → 编辑文件`)
  }
  lines.push(``)

  // ── 系统命令 ──
  if (cfg.allowShell) {
    lines.push(`💻 系统命令：【仅用于 open_file 做不到的事！】`)
    lines.push(`  - shell_exec(command="命令")  → 执行终端命令`)
    lines.push(`    例：shell_exec(command="pip install requests")  → 安装 Python 包`)
    lines.push(`    例：shell_exec(command="npm install -g openclaw")  → 安装 npm 包`)
    lines.push(`    例：shell_exec(command="winget install Git.Git")  → 用 winget 安装软件`)
    lines.push(`    ⚠️ 绝不用来打开文件/文件夹/URL — 用 open_file 代替！`)
    lines.push(`  - screenshot()                 → 截屏`)
    lines.push(``)
  }

  // ── 桌面控制 ──
  if (cfg.allowDesktop) {
    lines.push(`🖥️ 桌面控制：【可直接操作电脑屏幕和输入设备】`)
    lines.push(`  - desktop_see()                  → 理解当前屏幕内容`)
    lines.push(`  - desktop_click(x=数字, y=数字)  → 点击屏幕坐标`)
    lines.push(`  - desktop_type(text="内容")      → 在当前焦点输入文字`)
    lines.push(`  - keyboard_press(key="按键")     → 按下键盘按键（如 Enter、Tab）`)
    lines.push(`  - keyboard_type(text="内容")     → 键盘输入文字`)
    lines.push(`    例：desktop_see() → desktop_click(x=100, y=200) → 操作屏幕上的元素`)
    lines.push(``)
  }

  // ── 剪贴板 ──
  if (cfg.allowClipboard) {
    lines.push(`📋 剪贴板：`)
    lines.push(`  - clipboard_get()              → 读取剪贴板内容`)
    lines.push(`  - clipboard_set(text="内容")   → 写入剪贴板`)
    lines.push(``)
  }

  // ── 信息 ──
  lines.push(`🔍 信息查询：`)
  lines.push(`  - weather(city="城市名")  → 查天气`)
  lines.push(`  - datetime()              → 获取当前时间`)
  lines.push(``)

  // ── 记忆 ──
  lines.push(`🧠 记忆系统：`)
  lines.push(`  - memory_search(query="关键词")      → 搜索团队记忆`)
  lines.push(`  - memory_save(key="键", value="值")   → 保存重要信息`)
  lines.push(``)

  // ── 团队 ──
  lines.push(`🤝 团队协作：`)
  lines.push(`  - delegate_to(agent="agentID", task="任务描述")  → 委托队友干活`)
  lines.push(`  - query_teammate(agent="agentID", question="问题") → 咨询队友`)
  lines.push(`  - skill_run(skill="技能名")                       → 运行技能`)
  lines.push(``)

  // ── 铁律 ──
  lines.push(`📋 【工具使用铁律 — 必须遵守！】`)
  lines.push(`  1. 打开任何东西（文件/文件夹/URL/软件）→ 用 open_file，绝不用 shell_exec start`)
  lines.push(`  2. 打开网站 → open_file 或 browser(action="launch")`)
  lines.push(`  3. 搜索网络 → web_search`)
  lines.push(`  4. 查看目录 → file_list`)
  lines.push(`  5. shell_exec 仅用于：npm/pip安装、构建编译、运行脚本`)
  lines.push(`  6. 路径支持正斜杠：C:/Users/xxx/Desktop 和 C:\\Users\\xxx\\Desktop 都行`)
  lines.push(`  7. 用完工具拿到结果后，用你的语气总结给用户（简短自然）`)
  lines.push(`  8. ⚠️ 能直接回答的问题（数学计算、知识问答、翻译、写作、闲聊）→ 直接回答，不要调用任何工具`)
  lines.push(`  9. ⚠️ 只有用户明确要求操作电脑、或你需要搜索/读文件/执行命令时才用工具`)

  return lines.join('\n')
}
