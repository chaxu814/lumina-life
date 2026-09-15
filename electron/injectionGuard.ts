// ============================================================
// injectionGuard.ts — 防注入系统 (v2.5)
// ⚠️ v2.7: 此模块已标记为 deprecated，请使用 securityGuard.ts
//    旧功能保持不变以确保兼容性
// ============================================================

import type { AgentMessage, LLMToolCall, ToolCall } from './tools/types'

/** 将 AgentMessage content 安全转为字符串 */
function toText(content: AgentMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => part.text || '').join('')
  }
  return ''
}

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface InjectionReport {
  clean: boolean
  threatLevel: 'none' | 'low' | 'medium' | 'high' | 'critical'
  detections: string[]
  sanitized: boolean
  originalLength: number
  sanitizedLength: number
}

export interface GuardConfig {
  /** 启用防注入 */
  enabled: boolean
  /** 自动拦截高危注入并告警 */
  blockHighThreats: boolean
  /** 记录所有检测到的事件 */
  logDetections: boolean
  /** 最大消息长度 (超过截断) */
  maxMessageLength: number
}

// ═══════════════════════════════════════════════════════════
// 注入模式库
// ═══════════════════════════════════════════════════════════

/** 已知注入攻击特征 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; threat: 'high' | 'medium' | 'low'; description: string }> = [
  // ── 角色越狱 ────────────────────────────────
  {
    pattern: /忽略(所有|一切|之前|上面|以下|上述).{0,20}(指令|规则|限制|设定|角色|人设)/i,
    threat: 'high',
    description: '尝试忽略角色设定/指令',
  },
  {
    pattern: /你(现在|从现在开始|以后).{0,20}(不是|不再是|忘记).{0,15}(AI|助手|Lumina|机器人)/i,
    threat: 'high',
    description: '尝试改变角色身份',
  },
  {
    pattern: /DAN\s*(模式|mode)|do\s*anything\s*now/i,
    threat: 'high',
    description: 'DAN 越狱模式',
  },
  {
    pattern: /作为\s*(DAN|开发者|系统管理员|root)/i,
    threat: 'high',
    description: '尝试获取特权身份',
  },

  // ── 系统提示词窃取 ──────────────────────────
  {
    pattern: /(显示|输出|打印|告诉我|重复).{0,30}(系统提示|system\s*prompt|你的指令|你的设定|你的规则)/i,
    threat: 'medium',
    description: '尝试获取系统提示词',
  },
  {
    pattern: /(返回|给我|显示).{0,10}(你的|初始|第一条).{0,10}(消息|指令|prompt)/i,
    threat: 'medium',
    description: '尝试获取初始指令',
  },
  {
    pattern: /将上面的内容.*翻译/i,
    threat: 'low',
    description: '可能是翻译注入攻击（通过翻译绕过过滤器）',
  },

  // ── 工具滥用 ─────────────────────────────────
  {
    pattern: /(删除|格式化|清空).{0,20}(系统|C盘|所有文件|\/)/i,
    threat: 'high',
    description: '尝试执行破坏性系统操作',
  },
  {
    pattern: /(下载|执行|运行).{0,10}(恶意|病毒|木马|后门|payload)/i,
    threat: 'high',
    description: '尝试执行恶意代码',
  },
  {
    pattern: /(curl|wget)\s+.*\|\s*(bash|sh|cmd|powershell)/i,
    threat: 'high',
    description: '尝试管道执行远程代码',
  },

  // ── 信息窃取 ─────────────────────────────────
  {
    pattern: /(发送|上传|传输).{0,20}(到|给).{0,10}(外部|远程|我的服务器|webhook)/i,
    threat: 'medium',
    description: '尝试将数据发送到外部',
  },
  {
    pattern: /(读取|获取|列出).{0,20}(\.env|密码|token|api.?key|secret|私钥)/i,
    threat: 'medium',
    description: '尝试读取敏感配置',
  },

  // ── Python/Shell 注入 ────────────────────────
  {
    pattern: /__import__\s*\(|eval\s*\(|exec\s*\(|compile\s*\(/i,
    threat: 'high',
    description: 'Python 代码注入',
  },
  {
    pattern: /\$\{.*\}|`.*`|\$\(.*\)/,
    threat: 'medium',
    description: 'Shell 变量/命令注入',
  },
]

/** 已知的注入前缀/后缀标记 */
const INJECTION_MARKERS = [
  '<<<INJECTION>>>',
  '[INST]',
  '[/INST]',
  '<|im_start|>',
  '<|im_end|>',
  '<<SYS>>',
  '<</SYS>>',
  '[SYSTEM]',
  '[/SYSTEM]',
  'system:',
  'assistant:',
]

// ═══════════════════════════════════════════════════════════
// 防护类
// ═══════════════════════════════════════════════════════════

export class InjectionGuard {
  private config: GuardConfig
  private detectionLog: Array<{ time: number; report: InjectionReport; message: string }> = []

  constructor(config?: Partial<GuardConfig>) {
    this.config = {
      enabled: true,
      blockHighThreats: true,
      logDetections: true,
      maxMessageLength: 16000,
      ...config,
    }
  }

  // ── 用户输入净化 ─────────────────────────────────────

  /**
   * 检查并净化用户输入
   * @returns 净化后的文本和检测报告
   */
  sanitizeUserInput(input: string): { sanitized: string; report: InjectionReport } {
    const report: InjectionReport = {
      clean: true,
      threatLevel: 'none',
      detections: [],
      sanitized: false,
      originalLength: input.length,
      sanitizedLength: input.length,
    }

    let sanitized = input

    if (!this.config.enabled) {
      return { sanitized, report }
    }

    // L1: 移除注入标记
    for (const marker of INJECTION_MARKERS) {
      if (sanitized.includes(marker)) {
        sanitized = sanitized.replace(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '')
        report.detections.push(`移除注入标记: ${marker}`)
        report.sanitized = true
      }
    }

    // L2: 模式检测
    for (const rule of INJECTION_PATTERNS) {
      if (rule.pattern.test(sanitized)) {
        report.detections.push(`[${rule.threat.toUpperCase()}] ${rule.description}`)
        report.clean = false

        if (rule.threat === 'high') report.threatLevel = 'high'
        else if (rule.threat === 'medium' && report.threatLevel !== 'high') report.threatLevel = 'medium'
        else if (report.threatLevel === 'none') report.threatLevel = 'low'
      }
    }

    // L3: 长度限制
    if (sanitized.length > this.config.maxMessageLength) {
      sanitized = sanitized.slice(0, this.config.maxMessageLength)
      report.detections.push(`消息过长，已截断到 ${this.config.maxMessageLength} 字符`)
      report.sanitized = true
    }

    report.sanitizedLength = sanitized.length

    // 记录
    if (this.config.logDetections && report.detections.length > 0) {
      this.detectionLog.push({
        time: Date.now(),
        report: { ...report },
        message: input.slice(0, 200),
      })
      console.warn(`[InjectionGuard] 检测到 ${report.detections.length} 个风险:\n${report.detections.join('\n')}`)
    }

    return { sanitized, report }
  }

  // ── 工具调用参数验证 ─────────────────────────────────

  /**
   * 验证工具调用参数是否安全
   */
  validateToolCall(call: ToolCall): { safe: boolean; warnings: string[] } {
    const warnings: string[] = []

    if (!this.config.enabled) return { safe: true, warnings: [] }

    // Shell 命令检查
    if (call.name === 'shell_exec' && call.args.command) {
      const cmd = String(call.args.command)
      // 检测危险模式
      for (const rule of INJECTION_PATTERNS) {
        if (rule.pattern.test(cmd)) {
          warnings.push(`[${rule.threat.toUpperCase()}] Shell命令可能包含: ${rule.description}`)
        }
      }
    }

    // 文件路径检查
    if ((call.name === 'file_write' || call.name === 'file_edit') && call.args.path) {
      const filePath = String(call.args.path)
      const sensitivePaths = ['/etc/', 'C:\\Windows\\', 'C:\\Program Files\\', '.env', 'id_rsa']
      for (const sp of sensitivePaths) {
        if (filePath.includes(sp)) {
          warnings.push(`[HIGH] 尝试写入敏感路径: ${sp}`)
        }
      }
    }

    return {
      safe: warnings.filter(w => w.includes('[HIGH]')).length === 0,
      warnings,
    }
  }

  // ── AI 回复中检测注入 ────────────────────────────────

  /**
   * 检查 AI 回复是否包含注入痕迹（被攻击成功的标志）
   */
  checkResponseForInjection(response: string): InjectionReport {
    const report: InjectionReport = {
      clean: true,
      threatLevel: 'none',
      detections: [],
      sanitized: false,
      originalLength: response.length,
      sanitizedLength: response.length,
    }

    // 检测系统提示词泄露
    if (/你是.*(AI|助手|Lumina|机器人).*(的|一个)/.test(response) &&
        response.length > 500 &&
        response.includes('你的角色是')) {
      report.detections.push('[CRITICAL] AI 回复中疑似包含系统提示词泄露!')
      report.clean = false
      report.threatLevel = 'critical'
    }

    // 检测角色被篡改
    if (/我是.*(不是|不再是).*(AI|助手|Lumina)/.test(response)) {
      report.detections.push('[HIGH] AI 身份可能被篡改')
      report.clean = false
      report.threatLevel = 'high'
    }

    return report
  }

  // ── 批量消息检查 ─────────────────────────────────────

  /**
   * 检查整个消息数组的安全性
   */
  checkMessages(messages: AgentMessage[]): { safe: boolean; threats: string[] } {
    const threats: string[] = []

    for (const msg of messages) {
      if (msg.role === 'user') {
        const { report } = this.sanitizeUserInput(toText(msg.content))
        if (!report.clean) {
          threats.push(...report.detections)
        }
      }
    }

    return {
      safe: threats.length === 0 || !this.config.blockHighThreats,
      threats,
    }
  }

  // ── 配置 ─────────────────────────────────────────────

  updateConfig(updates: Partial<GuardConfig>): void {
    this.config = { ...this.config, ...updates }
  }

  getConfig(): GuardConfig {
    return { ...this.config }
  }

  getDetectionLog(limit = 20): Array<{ time: string; report: InjectionReport }> {
    return this.detectionLog.slice(-limit).map(e => ({
      time: new Date(e.time).toISOString(),
      report: e.report,
    }))
  }

  clearLog(): void {
    this.detectionLog = []
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _guard: InjectionGuard | null = null

export function getInjectionGuard(): InjectionGuard {
  if (!_guard) {
    _guard = new InjectionGuard()
  }
  return _guard
}
