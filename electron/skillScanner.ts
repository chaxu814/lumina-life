// ============================================================
// skillScanner.ts — Skill 安全扫描器 (v1.0)
//
// 在安装 Skill 之前检查 SKILL.md + 工具脚本中是否有
// 恶意代码、路径穿越、敏感操作等安全隐患。
//
// 扫描结果三级：
//   PASS  → 安全，可安装
//   WARN  → 有可疑模式，标记警告但可继续
//   BLOCK → 明确恶意，阻止安装
// ============================================================

import * as fs from 'fs'
import * as path from 'path'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export type ScanLevel = 'PASS' | 'WARN' | 'BLOCK'

export interface ScanFinding {
  level: ScanLevel
  rule: string
  file: string        // 相对路径
  line?: number
  snippet?: string
  message: string
  remediation?: string
}

export interface ScanResult {
  level: ScanLevel
  findings: ScanFinding[]
  summary: string
}

// ═══════════════════════════════════════════════════════════
// 扫描规则 — 针对 Skill 安装场景
// ═══════════════════════════════════════════════════════════

interface ScannerRule {
  id: string
  level: ScanLevel
  name: string
  description: string
  /** 匹配的文件名 glob */
  filePattern: RegExp
  /** 内容匹配模式 */
  contentPattern: RegExp
  remediation?: string
}

const SCANNER_RULES: ScannerRule[] = [
  // ── 命令注入 ────────────────────────────────────
  {
    id: 'SK-RM-001',
    level: 'BLOCK',
    name: '危险命令 — 强制删除',
    description: '检测到 rm -rf / 或 del /f /s 等强制删除根目录命令',
    filePattern: /\.(py|js|mjs|ts|sh|bat|ps1|md)$/i,
    contentPattern: /rm\s+[-/]rf\s+[/\\]|del\s+[/-][fs]\s+[A-Z]:[\\/]|format\s+[A-Z]:/i,
    remediation: '禁止包含系统级删除操作的 Skill',
  },
  {
    id: 'SK-RM-002',
    level: 'WARN',
    name: '危险命令 — 递归删除',
    description: '检测到 rm -rf / del /s 等递归删除操作',
    filePattern: /\.(py|js|mjs|ts|sh|bat|ps1|md)$/i,
    contentPattern: /rm\s+[-/]rf|del\s+[/-](f\s*)?[/-]s|rd\s+[/-]s[/-]q/i,
    remediation: '确认删除操作仅限于 Skill 工作区目录',
  },
  {
    id: 'SK-DL-001',
    level: 'BLOCK',
    name: '远程下载+执行',
    description: '检测到下载远程脚本并执行',
    filePattern: /\.(py|js|mjs|ts|sh|bat|ps1|md)$/i,
    contentPattern: /(curl|wget|Invoke-WebRequest|urllib\.urlopen|axios\.get|fetch)\s*\(?.{0,60}[)\]]?\s*[|;]\s*(sh|bash|python|node|powershell|cmd)/i,
    remediation: '禁止自动下载并执行远程代码',
  },
  {
    id: 'SK-BASE64-001',
    level: 'WARN',
    name: '可疑 — Base64 解码执行',
    description: '检测到 Base64 解码后执行（常被用于隐藏恶意代码）',
    filePattern: /\.(py|js|mjs|ts|sh|ps1)$/i,
    contentPattern: /(base64|atob|btoa|Buffer\.from).{0,30}(eval|exec|Function|setTimeout)/i,
    remediation: '如需编码数据，请使用配置文件而非动态解码执行',
  },
  {
    id: 'SK-CONNECT-001',
    level: 'BLOCK',
    name: '可疑 — 反弹 Shell',
    description: '检测到反弹 Shell 特征（bash -i >& /dev/tcp/ 等）',
    filePattern: /\.(sh|py|js|ps1)$/i,
    contentPattern: /bash\s+-i\s*[>]?&?\s*\/dev\/(tcp|udp)|Invoke-PowerShellTcp|New-Object\s+System\.Net\.Sockets/i,
    remediation: '禁止包含反弹 Shell 的 Skill',
  },
  {
    id: 'SK-CONNECT-002',
    level: 'WARN',
    name: '网络外连 — 不明 URL',
    description: '检测到 HTTP 请求到不明外部地址',
    filePattern: /\.(py|js|mjs|ts|md)$/i,
    contentPattern: /https?:\/\/(?!api\.|localhost|127\.|0\.0\.0)[^\s"']{20,}\.(com|org|net|io|app|dev|xyz)\/[^\s"']{0,100}(api|v1|v2|data|upload|collect|track)/i,
    remediation: '确认外部 URL 为 Skill 功能必需且可信任',
  },

  // ── 路径穿越 ────────────────────────────────────
  {
    id: 'SK-PATH-001',
    level: 'WARN',
    name: '路径穿越 — 写入上级目录',
    description: '检测到文件操作写入 .. / 上级目录',
    filePattern: /\.(py|js|mjs|ts|md)$/i,
    contentPattern: /['"`][.]{2,}[/\\]/,
    remediation: '建议将文件操作限制在 Skill 工作区内',
  },
  {
    id: 'SK-PATH-002',
    level: 'BLOCK',
    name: '路径穿越 — 写入系统目录',
    description: '检测到尝试写入系统关键路径',
    filePattern: /\.(py|js|mjs|ts|md)$/i,
    contentPattern: /['"`](C:\\Windows|C:\\Program\s*Files|\/etc|\/usr|\/boot|\/sys|\/var\/lib)['"`]/i,
    remediation: '禁止写入系统关键目录',
  },

  // ── 敏感访问 ────────────────────────────────────
  {
    id: 'SK-SENS-001',
    level: 'WARN',
    name: '敏感文件 — 凭证读取',
    description: '检测到读取 .env / .key / 凭证文件',
    filePattern: /\.(py|js|mjs|ts|md|sh|ps1)$/i,
    contentPattern: /(read|open|cat|Get-Content|fs\.readFile)\s*\(?['"`][^'"]+\.(env|pem|pfx|key|credential|secret|token)['"`]/i,
    remediation: '如果 Skill 需要凭据，应该通过配置参数传递而非直接读取文件',
  },
  {
    id: 'SK-SENS-002',
    level: 'BLOCK',
    name: '敏感文件 — 系统密码文件',
    description: '检测到读取系统密码/账户文件',
    filePattern: /\.(py|js|mjs|ts|md|sh|ps1)$/i,
    contentPattern: /['"`](C:\\Windows\\System32\\config|\/etc\/(passwd|shadow)|\/var\/db)['"`]/i,
    remediation: '禁止读取系统密码文件',
  },

  // ── 过度权限 ────────────────────────────────────
  {
    id: 'SK-PRIV-001',
    level: 'BLOCK',
    name: '权限提升 — sudo / 管理员',
    description: '检测到使用 sudo 或以管理员身份运行',
    filePattern: /\.(py|js|mjs|ts|sh|bat|ps1|md)$/i,
    contentPattern: /sudo\s+|runas\s+|Start-Process\s+.*-Verb\s+RunAs|shell_exec\s*\(\s*['"`]sudo/i,
    remediation: 'Skill 不应请求管理员权限',
  },
  {
    id: 'SK-PRIV-002',
    level: 'WARN',
    name: '权限提升 — chmod 777',
    description: '检测到设置文件权限为 777',
    filePattern: /\.(py|js|mjs|ts|sh|md)$/i,
    contentPattern: /chmod\s+777|chmod\s+a\+rwx/i,
    remediation: '建议使用最小必要权限',
  },

  // ── Skill 元数据 ────────────────────────────────
  {
    id: 'SK-META-001',
    level: 'WARN',
    name: '缺失 — SKILL.md 内容过少',
    description: 'SKILL.md 内容不足 50 字符，缺乏必要的使用说明',
    filePattern: /SKILL\.md$/,
    contentPattern: /^.{0,50}$/s,
    remediation: '建议 SKILL.md 包含：用途、前置条件、使用示例',
  },

  // ── SKILL.md 中的 shell_exec 危险命令 ──────────
  {
    id: 'SK-SHELL-001',
    level: 'WARN',
    name: 'SKILL.md — 包含危险 shell 命令',
    description: 'SKILL.md 中描述了使用 shell 执行危险操作',
    filePattern: /SKILL\.md$/,
    contentPattern: /(rm\s+-rf|del\s+\/f|format|dd\s+if=|mkfs|fdisk|shutdown|reboot|init\s+0)/i,
    remediation: '如果确实需要，请用户手动确认。考虑使用专用的工具脚本替代直接 shell 命令',
  },
]

// ═══════════════════════════════════════════════════════════
// 核心扫描
// ═══════════════════════════════════════════════════════════

/**
 * 扫描 Skill 目录中的所有文件
 * @param skillDir 已解压的 Skill 目录路径
 * @returns 扫描结果
 */
export function scanSkill(skillDir: string): ScanResult {
  const findings: ScanFinding[] = []

  // 确保目录存在
  if (!fs.existsSync(skillDir)) {
    return {
      level: 'BLOCK',
      findings: [{
        level: 'BLOCK',
        rule: 'SK-GEN-001',
        file: '',
        message: `Skill 目录不存在: ${skillDir}`,
      }],
      summary: '❌ Skill 目录不存在',
    }
  }

  // 递归遍历所有文件
  const walkDir = (dir: string, relativeDir: string = '') => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        // 跳过 node_modules
        if (entry.name === 'node_modules' || entry.name === '.git') {continue}
        walkDir(fullPath, relativePath)
        continue
      }

      // 尝试读取文件内容
      let content: string
      try {
        content = fs.readFileSync(fullPath, 'utf-8')
      } catch {
        continue  // 跳过二进制文件
      }

      // 对每个文件运行所有规则
      const lines = content.split('\n')
      for (const rule of SCANNER_RULES) {
        // 检查文件模式
        if (!rule.filePattern.test(entry.name) && !rule.filePattern.test(relativePath)) {continue}

        // 检查内容模式
        const match = content.match(rule.contentPattern)
        if (!match) {continue}

        // 找到匹配行号
        let lineNum = 0
        let snippet = ''
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].match(rule.contentPattern)) {
            lineNum = i + 1
            snippet = lines[i].trim().slice(0, 120)
            break
          }
        }

        findings.push({
          level: rule.level,
          rule: rule.id,
          file: relativePath,
          line: lineNum || undefined,
          snippet,
          message: rule.description,
          remediation: rule.remediation,
        })
      }
    }
  }

  walkDir(skillDir)

  // 汇总级别：有 BLOCK → BLOCK，有 WARN → WARN，全部 PASS → PASS
  let level: ScanLevel = 'PASS'
  for (const f of findings) {
    if (f.level === 'BLOCK' && level !== 'BLOCK') {
      level = 'BLOCK'
    }
    if (f.level === 'WARN' && level === 'PASS') {
      level = 'WARN'
    }
  }

  // 如果没有发现，加一条 PASS 说明
  if (findings.length === 0) {
    findings.push({
      level: 'PASS',
      rule: 'SK-PASS-001',
      file: '',
      message: '未发现安全隐患',
    })
  }

  // 汇总
  const blockCount = findings.filter(f => f.level === 'BLOCK').length
  const warnCount = findings.filter(f => f.level === 'WARN').length
  const passText = level === 'BLOCK' ? `❌ 拦截 (${blockCount} 项阻塞)`
    : level === 'WARN' ? `⚠️ 警告 (${warnCount} 项可疑)`
    : '✅ 安全'

  return {
    level,
    findings,
    summary: `${passText} | 共扫描 ${findings.length} 项`,
  }
}

/**
 * 格式化扫描结果为可读文本
 */
export function formatScanResult(result: ScanResult): string {
  const lines: string[] = []

  lines.push('')
  lines.push('╔══════════════════════════════════════════╗')
  lines.push('║   🛡️ Skill 安全扫描报告                 ║')
  lines.push('╚══════════════════════════════════════════╝')
  lines.push('')

  for (const f of result.findings) {
    const icon = f.level === 'BLOCK' ? '❌' : f.level === 'WARN' ? '⚠️' : '✅'
    const fileInfo = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''
    lines.push(`  ${icon} [${f.rule}]${fileInfo}`)
    lines.push(`     ${f.message}`)
    if (f.snippet) {
      lines.push(`     → ${f.snippet}`)
    }
    if (f.remediation) {
      lines.push(`     修复: ${f.remediation}`)
    }
    lines.push('')
  }

  lines.push(`📊 ${result.summary}`)
  lines.push('')

  return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════
// 直接导出供 cli/skill.ts 调用
// ═══════════════════════════════════════════════════════════

export default { scanSkill, formatScanResult }
