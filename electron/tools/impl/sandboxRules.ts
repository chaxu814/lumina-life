// ============================================================
// sandboxRules.ts — 智能沙箱威胁分类规则库（F1，零依赖纯函数，可单测）
//
// 卖点：7 级严重度 × 8 类威胁的可枚举规则库。
//   Severity       SAFE/INFO/LOW/MEDIUM/HIGH/CRITICAL/BLOCK  （7 级）
//   ThreatCategory 命令注入/路径穿越/数据外泄/敏感文件/凭证泄露/
//                  提示注入/代码执行/提权系统破坏           （8 类）
//
// 与旧 cuSafety 的关系：
//   - 本模块是唯一事实源；旧的 13 条高危正则全部迁移为结构化规则。
//   - cuSafety.ts 保留 destructiveReason/isDestructive 旧 API 做兼容，
//     内部委托 evaluateCommand（severity >= HIGH 即视为高危硬拦截）。
//
// 设计原则（沿用 cuSafety）：
//   - 只匹配「命令形态」，不把普通文档里的"删除/转账"文字误判。
//   - 一条命令可命中多条规则；最终 severity 取所有命中的最大值。
// ============================================================

// ──────────────────────────────────────────────────────────
// 7 级严重度
// ──────────────────────────────────────────────────────────
export enum Severity {
  /** 无威胁，直接放行 */
  SAFE = 0,
  /** 信息性（记录，不干预） */
  INFO = 1,
  /** 低风险（记录，默认放行） */
  LOW = 2,
  /** 中风险（记录日志，可提示） */
  MEDIUM = 3,
  /** 高风险（触发 Low IL 降级 / 审批） */
  HIGH = 4,
  /** 严重（硬拦截或强审批） */
  CRITICAL = 5,
  /** 阻断（无论何种权限姿态都硬拦截） */
  BLOCK = 6,
}

// ──────────────────────────────────────────────────────────
// 8 类威胁
// ──────────────────────────────────────────────────────────
export enum ThreatCategory {
  /** 命令注入 / 元字符拼接执行 */
  COMMAND_INJECTION = 'COMMAND_INJECTION',
  /** 路径穿越（../ 跳出工作目录） */
  PATH_TRAVERSAL = 'PATH_TRAVERSAL',
  /** 数据外泄 / 向远端发送本地数据 */
  DATA_EXFIL = 'DATA_EXFIL',
  /** 敏感文件读取（配置/密钥/隐私目录） */
  SENSITIVE_FILE = 'SENSITIVE_FILE',
  /** 凭证泄露（ssh key / token / .env / 证书） */
  CREDIT_LEAK = 'CREDIT_LEAK',
  /** 提示词注入（文本里夹带越狱/越权指令） */
  PROMPT_INJECTION = 'PROMPT_INJECTION',
  /** 任意代码执行（管道到 shell / 解释器直跑） */
  CODE_EXECUTION = 'CODE_EXECUTION',
  /** 提权 / 系统破坏（磁盘/注册表/账户/关机） */
  PRIVILEGE_ESCALATION = 'PRIVILEGE_ESCALATION',
}

// ──────────────────────────────────────────────────────────
// 规则结构
// ──────────────────────────────────────────────────────────

/**
 * 规则适用平台。默认 'all'（所有平台）。
 *   - 'win32'：仅 Windows（C:\、reg.exe、net user、del/rmdir /s 等 Windows 形态）
 *   - 'posix'：仅 POSIX（macOS/Linux：mkfs、dd 裸设备、chmod 777 等）
 * 加载时按 process.platform 取 'all' + 对应平台子集；Windows 上规则数量与行为保持不变。
 */
export type RulePlatform = 'all' | 'win32' | 'posix'

export interface SandboxRule {
  /** 规则唯一 id（如 BLOCK-001） */
  id: string
  severity: Severity
  category: ThreatCategory
  /** 匹配正则（对整条命令/待执行文本做 test） */
  pattern: RegExp
  /** 人类可读描述（命中后展示给用户/审批 UI） */
  description: string
  /** 处置建议（审批 UI / 日志展示） */
  remediation: string
  /** 适用平台；缺省 'all' */
  platform?: RulePlatform
}

export interface RuleHit {
  id: string
  severity: Severity
  category: ThreatCategory
  description: string
  remediation: string
}

export interface CommandEvaluation {
  /** 本次评估的最高严重度（所有命中取 max） */
  severity: Severity
  /** 命中的全部规则 */
  hits: RuleHit[]
  /** 是否硬拦截（severity >= CRITICAL；BLOCK 在任何姿态下都拦） */
  blocked: boolean
  /** 是否需要 Low IL 降级（severity >= HIGH） */
  degraded: boolean
  /** 是否需要用户审批（severity >= HIGH 且非纯 BLOCK 自动拦） */
  needsApproval: boolean
  /** 简要结论（人类可读） */
  summary: string
}

// ──────────────────────────────────────────────────────────
// 规则库
// ──────────────────────────────────────────────────────────

const SENSITIVE_PATHS = String.raw`(?:\.ssh|id_rsa|id_ed25519|\.gnupg|\.aws|\.config[\\/]?(?:gh|git|npm|pip)|\.env(?:\.local)?|\.pem|\.key|\.p12|\.keychain|credentials?|\.npmrc|\.pypirc|\.netrc|\.aws[\\/]?credentials)`

const RULES: SandboxRule[] = [
  // ── BLOCK：任何权限姿态下硬拦截 ──
  {
    id: 'BLOCK-001', severity: Severity.BLOCK, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\bformat\s+[a-z]:/i,
    description: '格式化磁盘', remediation: '硬拦截：不可逆的磁盘格式化，禁止执行',
    platform: 'win32',
  },
  {
    id: 'BLOCK-002', severity: Severity.BLOCK, category: ThreatCategory.PRIVILEGE_ESCALATION,
    // 注意：只匹配「根/家目录自身/通配」，不命中 ~/.ssh（那条走 CREDIT_LEAK 的 CRIT-001）
    pattern: /\brm\s+-rf\s+(\/|~\/?$|~\/\*|\/\*|C:\\\*)/i,
    description: '递归强制删除根/家目录', remediation: '硬拦截：会清空用户数据，禁止执行',
  },
  {
    // v0.1 macOS 变体：macOS 的 home 是 /Users/<name>，BLOCK-002 的 `~` 形式不覆盖绝对路径写法。
    // `rm -rf /Users/alice` 与 `rm -rf ~/` 意图完全相同，必须同级硬拦。
    id: 'BLOCK-002P', severity: Severity.BLOCK, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\brm\s+-[rRfF]{2,}\s+(?:\/Users\/[A-Za-z0-9._-]+|\$HOME|\/home\/[A-Za-z0-9._-]+)\s*(?:$|[\s;|&])/i,
    description: '递归强制删除用户主目录（/Users/xxx、$HOME、/home/xxx）',
    remediation: '硬拦截：会清空用户数据，禁止执行',
    platform: 'posix',
  },
  {
    id: 'BLOCK-003', severity: Severity.BLOCK, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\bmkfs(?:\.\w+)?\b/i,
    description: '格式化文件系统', remediation: '硬拦截：不可逆文件系统格式化',
  },
  {
    id: 'BLOCK-004', severity: Severity.BLOCK, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\bdiskpart\b|\bfdiskk?\b/i,
    description: '磁盘分区操作', remediation: '硬拦截：磁盘分区表操作不可逆',
  },
  {
    id: 'BLOCK-005', severity: Severity.BLOCK, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\bdd\s+if=[\s\S]*of=\\\\?\.?\\?/i,
    description: 'dd 直写磁盘设备', remediation: '硬拦截：裸设备写入会损坏分区表',
  },
  {
    id: 'BLOCK-006', severity: Severity.BLOCK, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\b(del|erase|rmdir|rd|Remove-Item|Remove-ItemProperty)\b[\s\S]{0,120}([\\/](Windows|System32|SysWOW64|Program Files(?:\s\(x86\))?)[\\/]?)/i,
    description: '删除系统目录（Windows/System32）', remediation: '硬拦截：删除系统关键目录会导致系统损坏',
    platform: 'win32',
  },
  {
    // v0.1 macOS 对应物：BLOCK-006 的 POSIX 形态。
    // 没有这条，macOS 上 `rm -rf /System/Library/...` / `rm -rf /Applications/X.app`
    // 在规则库里**一条都命中不了**——沙箱会直接退化为无保护。
    id: 'BLOCK-006P', severity: Severity.BLOCK, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\b(rm|rmdir|unlink)\b[\s\S]{0,80}(-[\w-]+\s+)*\/?(System\/Library|System\/Applications|Library\/Keychains|usr\/(?:bin|lib|local)|Applications\/[^/\s]+\.app)/i,
    description: '删除/清空 macOS 系统目录或应用包（/System、/Library、.app）',
    remediation: '硬拦截：删除系统关键目录会导致系统损坏或应用无法运行',
    platform: 'posix',
  },
  {
    id: 'BLOCK-007', severity: Severity.BLOCK, category: ThreatCategory.CODE_EXECUTION,
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    description: 'fork 炸弹（递归自我复制耗尽系统资源）', remediation: '硬拦截：fork 炸弹会立即卡死机器',
  },
  {
    id: 'BLOCK-008', severity: Severity.BLOCK, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\bnet\s+user\b[\s\S]{0,40}\/\w+/i,
    description: '修改系统账户', remediation: '硬拦截：创建/修改本地账户需要人工在场确认',
    platform: 'win32',
  },
  {
    id: 'BLOCK-009', severity: Severity.BLOCK, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\breg\s+delete\b/i,
    description: '删除注册表项', remediation: '硬拦截：注册表删除不可逆，可能导致系统/软件损坏',
    platform: 'win32',
  },

  // ── CRITICAL：严重，硬拦截或强审批 ──
  {
    id: 'CRIT-001', severity: Severity.CRITICAL, category: ThreatCategory.CREDIT_LEAK,
    pattern: new RegExp(String.raw`\b(rm|del|erase|Remove-Item)\b[\s\S]{0,80}(${SENSITIVE_PATHS})`, 'i'),
    description: '删除凭证/密钥文件（.ssh/.env/证书/token）', remediation: '强审批：删除密钥会导致凭证永久丢失，请人工确认',
  },
  {
    id: 'CRIT-002', severity: Severity.CRITICAL, category: ThreatCategory.CODE_EXECUTION,
    pattern: /(?:curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[\s\S]{0,120}[\s|>]+[\s]*(bash|sh|zsh|powershell|pwsh|cmd|node|python|perl)\b/i,
    description: '远程脚本直接管道到解释器执行', remediation: '强审批：未审计的远程代码执行，建议先下载审阅',
  },
  {
    id: 'CRIT-003', severity: Severity.CRITICAL, category: ThreatCategory.CODE_EXECUTION,
    pattern: /\b(eval|iex|Invoke-Expression)\s*\(|\b(iex|eval)\s+\$|base64\s+-d?\s?[\s\S]{0,40}\|/i,
    description: '动态求值 / base64 解码后执行（隐蔽代码执行）', remediation: '强审批：混淆后的代码执行，需要审计原文本',
  },
  {
    id: 'CRIT-004', severity: Severity.CRITICAL, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\bshutdown\b\s*(\/s|\/r|\/f|-h|-r|-s)\b|\b(restart|stop)-computer\b/i,
    description: '关机/重启系统', remediation: '强审批：会中断所有工作，需用户在场确认',
  },
  {
    id: 'CRIT-005', severity: Severity.CRITICAL, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\bRemove-Item\b[\s\S]{0,80}-recurse[\s\S]{0,40}-force|\brmdir\s+\/s\b|\brd\s+\/s\b/i,
    description: '递归强制删除目录', remediation: '强审批：-Recurse -Force 不可逆，需确认目标',
    platform: 'win32',
  },
  {
    // v0.1 macOS 对应物：CRIT-005 的 POSIX 形态。
    // 缺这条时 `rm -rf ~/Documents` 在 macOS 上严重度为 SAFE（完全放行），
    // 而等价 Windows 命令是 CRITICAL——同一意图在两平台防护等级相差 5 级。
    id: 'CRIT-005P', severity: Severity.CRITICAL, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\brm\b[\s\S]{0,60}-[rRfF]{2,}|\brm\b[\s\S]{0,40}-[rR]\b[\s\S]{0,20}-[fF]\b|\bfind\b[\s\S]{0,60}-delete\b|\btrash\b[\s\S]{0,40}-\w+\s+\//i,
    description: '递归强制删除目录（POSIX rm -rf / find -delete）',
    remediation: '强审批：递归强删不可逆，需确认目标路径',
    platform: 'posix',
  },
  {
    id: 'CRIT-006', severity: Severity.CRITICAL, category: ThreatCategory.DATA_EXFIL,
    pattern: /\b(scp|rsync|sftp|ftp)\b[\s\S]{0,120}(${SENSITIVE_PATHS}|id_rsa)/i,
    description: '把凭证/密钥文件外传到远端', remediation: '强审批：疑似 SSH 私钥/凭证外传，禁止静默执行',
  },

  // ── HIGH：触发 Low IL 降级 / 审批 ──
  {
    id: 'HIGH-001', severity: Severity.HIGH, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\bdel\s+[^|\n]*\/[fsq]|\berase\b[\s\S]{0,40}\/[fsq]/i,
    description: '强制/静默删除（不提示）', remediation: '降级 Low IL 并审批：静默删除不可恢复',
    platform: 'win32',
  },
  {
    id: 'HIGH-002', severity: Severity.HIGH, category: ThreatCategory.SENSITIVE_FILE,
    pattern: new RegExp(String.raw`\b(cat|type|more|less|Get-Content|gc|head|tail)\b[\s\S]{0,60}(${SENSITIVE_PATHS})`, 'i'),
    description: '读取凭证/密钥文件内容', remediation: '降级 Low IL 并审批：防止私钥/ token 被打印到日志',
  },
  {
    id: 'HIGH-003', severity: Severity.HIGH, category: ThreatCategory.DATA_EXFIL,
    pattern: /\bcurl\b[\s\S]{0,80}-[dF][= ][^&\n]*@[\s\S]{0,80}https?:\/\//i,
    description: '把本地文件作为表单/数据上传到远端', remediation: '降级 Low IL 并审批：确认上传目标是你信任的服务器',
  },
  {
    id: 'HIGH-004', severity: Severity.HIGH, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\bchmod\s+[0-7]*777\b|\bchown\s+-?R?\b[\s\S]{0,30}(root|Administrators)/i,
    description: '权限过度放开 / 改属主为管理员', remediation: '降级 Low IL：777 或 root/Administrators 属主过宽',
    platform: 'posix',
  },
  {
    // v0.1 macOS 对应物：HIGH-001（Windows `del /f` 静默强删）的 POSIX 形态。
    id: 'HIGH-001P', severity: Severity.HIGH, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\brm\b[\s\S]{0,40}-[a-zA-Z]*f[a-zA-Z]*\b/i,
    description: '强制删除不提示（POSIX rm -f）', remediation: '降级 Low IL 并审批：静默删除不可恢复',
    platform: 'posix',
  },
  {
    // v0.1 macOS 提权/系统破坏补充：diskutil / SIP / Gatekeeper / 系统偏好改写。
    // Windows 侧有 diskpart / net user / reg delete 的对位，macOS 原本完全没有。
    id: 'HIGH-006', severity: Severity.HIGH, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\bdiskutil\b[\s\S]{0,40}(erase|reformat|apfs delete)|\bcsrutil\s+disable|\bspctl\s+--master-disable|\bdefaults\s+write\b[\s\S]{0,60}\b(com\.apple|global)\b/i,
    description: '破坏系统安全或磁盘（diskutil 擦盘、关闭 SIP/Gatekeeper、改系统偏好）',
    remediation: '降级 Low IL 并审批：会削弱系统安全边界或损坏磁盘',
    platform: 'posix',
  },
  {
    // macOS 特有凭据入口：Keychain 导出。Windows 侧有 reg/DPAPI 对位，macOS 无。
    id: 'HIGH-007', severity: Severity.HIGH, category: ThreatCategory.CREDIT_LEAK,
    pattern: /\bsecurity\s+(?:find-generic-password|find-internet-password|dump-keychain|unlock-keychain)\b/i,
    description: '读取/导出 macOS 钥匙串凭据', remediation: '降级 Low IL 并审批：钥匙串含全机密码，禁止静默导出',
    platform: 'posix',
  },

  // ── MEDIUM：记录日志，可提示 ──
  {
    id: 'MED-001', severity: Severity.MEDIUM, category: ThreatCategory.PATH_TRAVERSAL,
    pattern: /(?:\.\.[\\/]){2,}/,
    description: '多级路径穿越（跳出当前工作目录）', remediation: '记录：确认目标路径仍在授权目录内',
  },
  {
    id: 'MED-002', severity: Severity.MEDIUM, category: ThreatCategory.DATA_EXFIL,
    pattern: /(?:^|\s)(curl|wget|Invoke-WebRequest|iwr)\s/i,
    description: '发起网络下载/请求', remediation: '记录：出站网络流量已记入审计',
  },
  {
    id: 'MED-003', severity: Severity.MEDIUM, category: ThreatCategory.PRIVILEGE_ESCALATION,
    pattern: /\b(sudo|runas|Start-Process\s+-Verb\s+RunAs)\b/i,
    description: '请求更高权限执行', remediation: '记录：提权动作已审计，Low IL 下无法提权',
  },
  {
    id: 'MED-004', severity: Severity.MEDIUM, category: ThreatCategory.COMMAND_INJECTION,
    pattern: />>?\s*(\/etc\/|\/private\/etc|C:\\Windows\\|\\ProgramData\\)/i,
    description: '向系统配置/启动项写入', remediation: '记录：修改系统级配置需要留意',
  },
  {
    id: 'MED-005', severity: Severity.MEDIUM, category: ThreatCategory.PROMPT_INJECTION,
    // 启发式：待输入/待执行文本里夹带越狱话术（误报可接受，仅 MEDIUM）
    pattern: /(?:ignore|disregard|forget)\s+(?:all\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)|忽略(?:以上|之前|前面|上述)(?:的)?(?:指令|提示|规则)|你现在是(?:DAN|jailbreak)|<\s*\|?system\s*>/i,
    description: '疑似提示词注入文本', remediation: '记录：检测到越权指令话术，建议人工复核内容来源',
  },

  // ── LOW：记录，默认放行 ──
  {
    id: 'LOW-001', severity: Severity.LOW, category: ThreatCategory.COMMAND_INJECTION,
    pattern: /[;`]|\$\([^)]*\)|\b\|\s*(?:xargs|sh|bash)\b/i,
    description: '命令拼接 / 间接执行（元字符）', remediation: '记录：复合命令结构已审计',
  },
  {
    id: 'LOW-002', severity: Severity.LOW, category: ThreatCategory.CODE_EXECUTION,
    pattern: /\bfind\b[\s\S]{0,80}-exec\b|\bxargs\b/i,
    description: 'find -exec / xargs 间接执行', remediation: '记录：批量执行器，确认作用范围',
  },
]

// ──────────────────────────────────────────────────────────
// 平台规则集：按平台取 'all' + 平台专属子集
// ──────────────────────────────────────────────────────────

/** 判断某规则在给定平台是否启用。Windows 上启用 'all'+'win32'，规则集与历史完全一致。 */
export function ruleAppliesOn(rule: SandboxRule, platform: string): boolean {
  const p = rule.platform || 'all'
  if (p === 'all') {return true}
  if (p === 'win32') {return platform === 'win32'}
  // 'posix'：darwin / linux / 其它非 win32
  return platform !== 'win32'
}

/** 当前平台（或显式传入平台）生效的规则子集。 */
export function activeRulesFor(platform: string = process.platform): SandboxRule[] {
  return RULES.filter(r => ruleAppliesOn(r, platform))
}

// ──────────────────────────────────────────────────────────
// 纯函数：评估一条命令
// ──────────────────────────────────────────────────────────

/**
 * 评估一条 shell 命令 / 待键入文本的安全风险。
 * 纯函数，无 I/O，可直接单测。
 *
 * @param cmd 原始命令或待键入文本
 * @returns 最高 severity + 全部命中规则 + 处置建议
 */
export function evaluateCommand(cmd: string | undefined | null): CommandEvaluation {
  const empty: CommandEvaluation = {
    severity: Severity.SAFE,
    hits: [],
    blocked: false,
    degraded: false,
    needsApproval: false,
    summary: '安全',
  }
  if (!cmd) {return empty}
  const s = String(cmd)
  const active = activeRulesFor(process.platform)

  const hits: RuleHit[] = []
  let max: Severity = Severity.SAFE
  for (const rule of active) {
    // 重置 lastIndex（全局/粘性正则有状态；这里不用 g 标志，但保险起见每次重测前重置）
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(s)) {
      hits.push({
        id: rule.id,
        severity: rule.severity,
        category: rule.category,
        description: rule.description,
        remediation: rule.remediation,
      })
      if (rule.severity > max) {max = rule.severity}
    }
  }

  const blocked = max >= Severity.CRITICAL
  const degraded = max >= Severity.HIGH
  const needsApproval = max >= Severity.HIGH

  let summary: string
  if (max >= Severity.BLOCK) {summary = '阻断级：系统不可逆操作，已硬拦截'}
  else if (max >= Severity.CRITICAL) {summary = '严重：硬拦截或强审批'}
  else if (max >= Severity.HIGH) {summary = '高风险：Low IL 降级 + 审批'}
  else if (max >= Severity.MEDIUM) {summary = '中风险：已记录审计'}
  else if (max >= Severity.LOW) {summary = '低风险：放行'}
  else {summary = '安全'}

  return { severity: max, hits, blocked, degraded, needsApproval, summary }
}

/** 严重度 → 中文短标签（UI 用） */
export function severityLabel(sev: Severity): string {
  switch (sev) {
    case Severity.SAFE: return '安全'
    case Severity.INFO: return '信息'
    case Severity.LOW: return '低'
    case Severity.MEDIUM: return '中'
    case Severity.HIGH: return '高'
    case Severity.CRITICAL: return '严重'
    case Severity.BLOCK: return '阻断'
    default: return '未知'
  }
}

/** 严重度 → 颜色（UI 用） */
export function severityColor(sev: Severity): string {
  switch (sev) {
    case Severity.SAFE: return '#22c55e'
    case Severity.INFO: return '#64748b'
    case Severity.LOW: return '#84cc16'
    case Severity.MEDIUM: return '#f59e0b'
    case Severity.HIGH: return '#f97316'
    case Severity.CRITICAL: return '#ef4444'
    case Severity.BLOCK: return '#991b1b'
    default: return '#64748b'
  }
}

/** 威胁类别 → 中文短标签 */
export function categoryLabel(cat: ThreatCategory): string {
  switch (cat) {
    case ThreatCategory.COMMAND_INJECTION: return '命令注入'
    case ThreatCategory.PATH_TRAVERSAL: return '路径穿越'
    case ThreatCategory.DATA_EXFIL: return '数据外泄'
    case ThreatCategory.SENSITIVE_FILE: return '敏感文件'
    case ThreatCategory.CREDIT_LEAK: return '凭证泄露'
    case ThreatCategory.PROMPT_INJECTION: return '提示注入'
    case ThreatCategory.CODE_EXECUTION: return '代码执行'
    case ThreatCategory.PRIVILEGE_ESCALATION: return '提权破坏'
    default: return cat
  }
}

/** 规则总数（供自监测/UI 展示「7×8」卖点用；统计当前平台生效子集） */
export function ruleStats(): { total: number; bySeverity: Record<number, number>; byCategory: Record<string, number> } {
  const bySeverity: Record<number, number> = {}
  const byCategory: Record<string, number> = {}
  const active = activeRulesFor(process.platform)
  for (const r of active) {
    bySeverity[r.severity] = (bySeverity[r.severity] || 0) + 1
    byCategory[r.category] = (byCategory[r.category] || 0) + 1
  }
  return { total: active.length, bySeverity, byCategory }
}
