// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// security/commandPolicy.ts — 命令护栏演进框架（阶段 1 策略库）
//
// 【本文件是什么 / 不是什么】
//   这是一个**纯逻辑策略库**：定义「高危命令显式清单」并给出
//   evaluateCommand(command) → verdict 的判定。
//
//   ⚠️ 当前**没有接线**到 shell.ts / reactEngine 的默认拦截路径。
//      现状（阶段 0）仍由 securityGuard.ts 的规则库 + shell.ts 的
//      DANGEROUS_PATTERNS + 审批流负责拦截。本模块是为「阶段 1：
//      高危命令显式清单 → 一律强制审批/拒绝」预备的单一事实源，
//      接线条件见 SECURITY.md「命令护栏演进路线」。
//
//   为什么不直接接线：本模块与 securityGuard.ts 规则库存在重叠。
//   在默认行为不变的前提下先落地「可单测的策略表达」，待阶段 1
//   评审通过后，再让 reactEngine 在 securityGuard 之后追加调用一次
//   evaluateCommand()，把 verdict 映射成 reject / requiresApproval。
//
// 【设计约束】
//   1. 零 Electron / 零运行时依赖，可直接单测（与 rolePolicy.ts 同风格）。
//   2. 误报要小：日常开发命令（npm install、git commit、tsc、build）
//      绝不能进 reject 名单 —— 护栏一旦变噪音，用户就会无脑点「同意」，
//      真实告警反而被淹没。这是 securityGuard.ts CMD-004 注释里的教训。
//   3. 判定是**分层**的：先命中即返回（reject > require_approval > allow），
//      并在 dimensions 里给出可审计的判定依据，而不是黑盒 yes/no。
// ============================================================

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/** 最终裁决 */
export type CommandVerdict = 'allow' | 'require_approval' | 'reject'

/** 判定维度 —— 让每个裁决都可解释、可审计 */
export interface CommandDimensions {
  /** 是否不可逆（删/覆写/格式化/关机类，没有撤销按钮） */
  irreversible: boolean
  /** 是否触碰系统关键目录 / 注册表 / 安全软件 */
  touchesSystem: boolean
  /** 是否存在外联（curl/wget/Invoke-WebRequest 等出站请求） */
  networkOutbound: boolean
  /** 是否把文件写到工作区之外（重定向/安装目标） */
  writesOutsideWorkspace: boolean
}

export interface CommandPolicyVerdict {
  /** 最终裁决 */
  decision: CommandVerdict
  /** 命中的策略规则 id（用于日志/复盘） */
  matchedRule?: string
  /** 人类可读理由（多条） */
  reasons: string[]
  /** 判定维度 */
  dimensions: CommandDimensions
}

interface PolicyRule {
  id: string
  description: string
  pattern: RegExp
  /** 命中后写入 dimensions 的哪些位 */
  flags: Partial<CommandDimensions>
}

// ═══════════════════════════════════════════════════════════
// REJECT 层 —— 不可逆 / 灾难性，命中即拒绝（阶段 1 强制拒绝清单）
//
// 与 securityGuard.ts 的 CRITICAL 规则对齐，但这里显式列出、集中管理，
// 便于阶段 1 评审「到底哪类命令是无条件拒绝的」。
// ═══════════════════════════════════════════════════════════

const REJECT_RULES: PolicyRule[] = [
  {
    id: 'REJ-DESTROY-001',
    description: '递归强制删除根目录 / 家目录 / 整个盘符（不可逆数据丢失）',
    // rm -rf / · rm -rf /* · rm -rf ~ · rm -rf $HOME · rm -rf C: · del /f /s /q C:\
    pattern: /(?:^|[;&|]\s*|\s)(?:rm|rmdir|del)\s+(?:-[a-zA-Z]+\s+|\/[a-zA-Z]+\s+)*(?:\/|\/\*|~\/?|\$HOME|[A-Za-z]:[\\/]?)(?:\s|$|\*)/i,
    flags: { irreversible: true },
  },
  {
    id: 'REJ-DISK-002',
    description: '格式化磁盘 / 直接覆写块设备 / diskpart',
    pattern: /\b(?:format\s+[A-Za-z]:|mkfs(?:\.\w+)?\s|dd\b[^|;&]*\bof=\/dev\/|diskpart)/i,
    flags: { irreversible: true, touchesSystem: true },
  },
  {
    id: 'REJ-POWER-003',
    description: '关机 / 重启 / 休眠宿主系统',
    pattern: /(?:^|[;&|]\s*)(?:shutdown|reboot|poweroff|halt)(?:\s|$)/i,
    flags: { irreversible: true },
  },
  {
    id: 'REJ-REG-004',
    description: '删除注册表项 / regini 改写注册表',
    pattern: /(?:^|[;&|]\s*)(?:reg\s+delete|regini)\b/i,
    flags: { irreversible: true, touchesSystem: true },
  },
  {
    id: 'REJ-DOWNEXEC-005',
    description: '下载远程脚本并直接管道执行（无审查的远程代码）',
    pattern: /(?:curl|wget|Invoke-WebRequest|iwr)\b.{0,80}\|\s*(?:sh|bash|zsh|python|python3|node|powershell|pwsh|cmd)/i,
    flags: { networkOutbound: true, irreversible: true },
  },
  {
    id: 'REJ-FORKBOMB-006',
    description: 'fork 炸弹 / 无限自我复制',
    pattern: /:\s*\(\)\s*\{[^}]*\}\s*\S|:\(\)\{:|:&|%0\|%0/,
    flags: { irreversible: true },
  },
]

// ═══════════════════════════════════════════════════════════
// REQUIRE_APPROVAL 层 —— 高危但在人工确认下可放行
//
// 这一层是阶段 1 的增量：把过去「混在黑名单里一刀切拒绝」或
// 「完全没覆盖」的高危动作，统一收敛到「强制审批」。
// ═══════════════════════════════════════════════════════════

const APPROVAL_RULES: PolicyRule[] = [
  {
    id: 'APR-REG-EDIT-001',
    description: '写入 / 导入注册表（reg add / reg import）',
    pattern: /(?:^|[;&|]\s*)(?:reg\s+(?:add|import))\b/i,
    flags: { touchesSystem: true, irreversible: true },
  },
  {
    id: 'APR-SECURITY-SOFT-002',
    description: '停止 / 关闭安全软件或防火墙（net stop / sc config / Set-MpPreference）',
    pattern: /(?:net\s+stop|sc\s+config|Set-MpPreference|Disable-\w*Firewall|netsh\s+firewall\s+set)\b/i,
    flags: { touchesSystem: true, irreversible: true },
  },
  {
    id: 'APR-SYSTEMDIR-003',
    description: '向系统关键目录写入（C:\\Windows、Program Files、/etc、/usr/bin）',
    pattern: /(?:>>?\s*(?:C:[\\/]+(?:Windows|Program\s?Files)|\/(?:etc|boot|usr\/bin|usr\/sbin)\b))/i,
    flags: { touchesSystem: true, writesOutsideWorkspace: true },
  },
  {
    id: 'APR-PERM-004',
    description: '宽松权限授予（chmod 777 / chown 全盘递归）',
    pattern: /\b(?:chmod\s+777|chmod\s+-R|chown\s+-R)\b/i,
    flags: { irreversible: true, touchesSystem: true },
  },
  {
    id: 'APR-PIPE-INTERP-005',
    description: '把命令输出管道交给解释器二次执行',
    pattern: /\|\s*(?:sh|bash|zsh|python|python3|node|pwsh|powershell)\b/i,
    flags: { irreversible: true },
  },
  {
    id: 'APR-PRIV-ESC-006',
    description: '提权执行（sudo / runas / gsudo / Start-Process -Verb RunAs）',
    pattern: /\b(?:sudo|runas|gsudo)(?:\s|$)|-Verb\s+RunAs/i,
    flags: { touchesSystem: true },
  },
  {
    id: 'APR-DATA-OUT-007',
    description: '向外部服务器 POST/PUT 数据（疑似外泄通道）',
    pattern: /\b(?:curl|wget|Invoke-WebRequest|iwr)\b.{0,120}(?:-[dF]\b|--data|--data-binary|-Method\s+PUT|-Method\s+POST)/i,
    flags: { networkOutbound: true, writesOutsideWorkspace: true },
  },
  {
    id: 'APR-PKG-INSTALL-008',
    description: '全局安装 / 卸载系统包（npm i -g、apt、choco、scoop）',
    pattern: /\b(?:npm\s+(?:install|i)\s+(-g|--global)|pnpm\s+(?:add|i)\s+-g|yarn\s+global|apt(?:-get)?\s+(?:install|remove)|choco\s+(?:install|uninstall)|scoop\s+(?:install|uninstall))\b/i,
    flags: { writesOutsideWorkspace: true },
  },
]

// ═══════════════════════════════════════════════════════════
// 判定
// ═══════════════════════════════════════════════════════════

function emptyDimensions(): CommandDimensions {
  return {
    irreversible: false,
    touchesSystem: false,
    networkOutbound: false,
    writesOutsideWorkspace: false,
  }
}

function mergeFlags(d: CommandDimensions, flags: Partial<CommandDimensions>): CommandDimensions {
  return {
    irreversible: d.irreversible || !!flags.irreversible,
    touchesSystem: d.touchesSystem || !!flags.touchesSystem,
    networkOutbound: d.networkOutbound || !!flags.networkOutbound,
    writesOutsideWorkspace: d.writesOutsideWorkspace || !!flags.writesOutsideWorkspace,
  }
}

/**
 * 对一条 shell 命令做策略裁决。
 *
 * 分层顺序：REJECT 命中即拒绝（最高优先）；否则 APPROVAL 命中即要求审批；
 * 都没命中才放行。任一规则命中都会把其 flags 并入 dimensions，
 * 即使最终是 allow，也能在日志里看到「这条命令碰了网络/写了工作区外」。
 *
 * @param command 原始命令字符串
 * @param opts.enabledApproval 是否把 APPROVAL_RULES 纳入判定（默认 true）。
 *                             留这个开关是为了阶段 1 灰度：
 *                             先只看 REJECT、不强制审批，观察一周无误报后再开。
 */
export function evaluateCommand(
  command: string,
  opts: { enabledApproval?: boolean } = {},
): CommandPolicyVerdict {
  const enabledApproval = opts.enabledApproval ?? true
  const reasons: string[] = []
  let dimensions = emptyDimensions()

  // ── REJECT 层 ──
  for (const rule of REJECT_RULES) {
    if (rule.pattern.test(command)) {
      dimensions = mergeFlags(dimensions, rule.flags)
      reasons.push(rule.description)
      return {
        decision: 'reject',
        matchedRule: rule.id,
        reasons,
        dimensions,
      }
    }
  }

  // ── APPROVAL 层（可灰度关闭）──
  if (enabledApproval) {
    for (const rule of APPROVAL_RULES) {
      if (rule.pattern.test(command)) {
        dimensions = mergeFlags(dimensions, rule.flags)
        reasons.push(rule.description)
        return {
          decision: 'require_approval',
          matchedRule: rule.id,
          reasons,
          dimensions,
        }
      }
    }
  }

  // ── 放行：仍做一次轻量维度标注（供审计，不改变裁决）──
  if (/\b(?:curl|wget|Invoke-WebRequest|iwr)\b/.test(command)) {
    dimensions.networkOutbound = true
  }

  return {
    decision: 'allow',
    reasons,
    dimensions,
  }
}

/** 供文档 / UI 展示：当前 REJECT 与 APPROVAL 清单的规则 id 与描述 */
export function listPolicyRules(): Array<{ tier: 'reject' | 'approval'; id: string; description: string }> {
  return [
    ...REJECT_RULES.map(r => ({ tier: 'reject' as const, id: r.id, description: r.description })),
    ...APPROVAL_RULES.map(r => ({ tier: 'approval' as const, id: r.id, description: r.description })),
  ]
}
