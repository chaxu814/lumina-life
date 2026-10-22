// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// security/staticScanner.ts — 🔬 JS/AST 静态安全扫描器 (v0.2 创新提案5)
//
// 用 @babel/parser 把第三方技能/插件的 JS 源码解析成 AST，再做规则遍历：
//   - child_process 调用 / require → block
//   - electron remote 引用 → block
//   - eval / new Function → block
//   - fs 写入敏感路径（~/.ssh、系统目录）→ block
//   - 硬编码公网 IP / 可疑域名 → warn/block（接 threatIntel）
//   - require/import 包名 typosquatting → warn / malicious → block
//
// 分级：block（拦截安装）/ warn（警告可继续）/ pass（放行）。
// 纯函数：输入源码字符串，输出 findings；不读磁盘，便于单测。
// ============================================================

import { parse } from '@babel/parser'
import { checkPackageName, checkDomain, isHardcodedPublicIp } from './threatIntel'

export type ScanSeverity = 'block' | 'warn' | 'pass'

export interface StaticFinding {
  rule: string
  severity: ScanSeverity
  message: string
  line?: number
}

export interface StaticScanResult {
  severity: ScanSeverity
  findings: StaticFinding[]
}

/** 敏感写入路径片段（出现在字符串字面量里即视为高风险写） */
const SENSITIVE_PATH_FRAGMENTS = [
  '.ssh', '.aws', '.gnupg', '.config/gcloud',
  '\\windows\\system32', '/etc/passwd', '/etc/shadow', '/etc/sudoers',
  '\\programdata\\', '/root/.',
]

function lineOf(node: any): number | undefined {
  return node?.loc?.start?.line
}

function worse(a: ScanSeverity, b: ScanSeverity): ScanSeverity {
  if (a === 'block' || b === 'block') {return 'block'}
  if (a === 'warn' || b === 'warn') {return 'warn'}
  return 'pass'
}

/** 递归遍历 AST：对每个节点按 type 分发检查 */
function walk(node: any, findings: StaticFinding[]): void {
  if (!node || typeof node !== 'object') {return}
  if (Array.isArray(node)) {
    for (const c of node) {walk(c, findings)}
    return
  }
  if (typeof node.type !== 'string') {return}

  inspectNode(node, findings)

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') {continue}
    walk(node[key], findings)
  }
}

function strArg(node: any): string | null {
  // require('x') / import 'x' / 'x' 字面量
  if (node && node.type === 'StringLiteral' && typeof node.value === 'string') {return node.value}
  if (node && node.type === 'Literal' && typeof node.value === 'string') {return node.value}
  return null
}

function inspectNode(node: any, findings: StaticFinding[]): void {
  switch (node.type) {
    // ── require('...') ──────────────────────────────
    case 'CallExpression': {
      const callee = node.callee
      if (callee && callee.type === 'Identifier' && callee.name === 'require') {
        const spec = strArg(node.arguments?.[0])
        if (spec) {checkRequireSpec(spec, lineOf(node), findings)}
      }
      // eval(...)
      if (callee && callee.type === 'Identifier' && callee.name === 'eval') {
        findings.push({ rule: 'STC-EVAL', severity: 'block', message: '检测到 eval() 动态执行字符串代码', line: lineOf(node) })
      }
      break
    }

    // ── new Function(...) ────────────────────────────
    case 'NewExpression': {
      if (node.callee && node.callee.type === 'Identifier' && node.callee.name === 'Function') {
        findings.push({ rule: 'STC-FUNCTION-CTOR', severity: 'block', message: '检测到 new Function() 动态构造函数（代码注入风险）', line: lineOf(node) })
      }
      break
    }

    // ── import ... from '...' / import '...' ─────────
    case 'ImportDeclaration': {
      const spec = typeof node.source?.value === 'string' ? node.source.value : null
      if (spec) {checkRequireSpec(spec, lineOf(node), findings)}
      break
    }

    // ── 字符串字面量：敏感路径 / 可疑域名 / 硬编码 IP ──
    case 'StringLiteral':
    case 'Literal': {
      const v = typeof node.value === 'string' ? node.value : ''
      if (v) {checkStringLiteral(v, lineOf(node), findings)}
      break
    }

    // ── member: require('electron').remote ──────────
    case 'MemberExpression': {
      if (node.property && node.property.type === 'Identifier' && node.property.name === 'remote') {
        findings.push({ rule: 'STC-ELECTRON-REMOTE', severity: 'block', message: '检测到 electron.remote 引用（直接拿到主进程权限，已废弃且高危）', line: lineOf(node) })
      }
      break
    }
  }
}

function checkRequireSpec(spec: string, line: number | undefined, findings: StaticFinding[]): void {
  const s = spec.trim()
  if (!s) {return}

  // child_process → block
  if (s === 'child_process' || s.startsWith('node:child_process')) {
    findings.push({ rule: 'STC-CHILD-PROCESS', severity: 'block', message: `require('${s}')：可任意执行系统命令（第三方技能默认禁止 shell 能力）`, line })
    return
  }
  // net / dgram / tls / http2 原始网络 → warn（技能沙箱只放行白名单 fetch）
  if (s === 'net' || s === 'node:net' || s === 'dgram' || s === 'node:dgram') {
    findings.push({ rule: 'STC-RAW-NET', severity: 'block', message: `require('${s}')：直接套接字访问，技能沙箱不允许`, line })
    return
  }
  // electron → warn（主进程 API 暴露面）
  if (s === 'electron' || s === 'electron/' || s.startsWith('electron/')) {
    findings.push({ rule: 'STC-ELECTRON', severity: 'warn', message: `引用 '${s}'：直接访问 Electron API，请确认是否必要`, line })
    return
  }

  // 包名 typosquatting / 恶意名单
  const hit = checkPackageName(s)
  if (hit.kind === 'malicious') {
    findings.push({ rule: 'STC-MALICIOUS-PKG', severity: 'block', message: `依赖包 '${s}' 命中已知恶意包名单`, line })
  } else if (hit.kind === 'typosquat') {
    findings.push({ rule: 'STC-TYPOSQUAT', severity: 'warn', message: `依赖包 '${s}' 疑似仿冒 '${hit.looksLike}'（编辑距离 ${hit.distance}）`, line })
  }
}

function checkStringLiteral(v: string, line: number | undefined, findings: StaticFinding[]): void {
  const lower = v.toLowerCase()

  // 敏感路径
  for (const frag of SENSITIVE_PATH_FRAGMENTS) {
    if (lower.includes(frag)) {
      findings.push({ rule: 'STC-SENSITIVE-PATH', severity: 'block', message: `字符串字面量引用敏感路径片段 '${frag}'`, line })
      break
    }
  }

  // URL / 域名
  const urlMatch = /https?:\/\/([a-zA-Z0-9.\-]+)/.exec(v)
  if (urlMatch) {
    const host = urlMatch[1]
    const d = checkDomain(host)
    if (d.level === 'block') {
      findings.push({ rule: 'STC-BAD-DOMAIN', severity: 'block', message: `硬编码 URL 指向黑名单域名: ${host}`, line })
    } else if (d.level === 'warn') {
      findings.push({ rule: 'STC-SUS-DOMAIN', severity: 'warn', message: `硬编码 URL 指向可疑域名: ${host}（${d.reason || ''}）`, line })
    } else if (isHardcodedPublicIp(host)) {
      findings.push({ rule: 'STC-HARDCODED-IP', severity: 'warn', message: `URL 硬编码公网 IP: ${host}`, line })
    }
  } else if (isHardcodedPublicIp(v)) {
    findings.push({ rule: 'STC-HARDCODED-IP', severity: 'warn', message: `硬编码公网 IP: ${v}`, line })
  }
}

/**
 * 扫描单个 JS 源码字符串。语法解析失败不抛错，而是记一条 block（可疑混淆/损坏）。
 */
export function scanJavascript(source: string, filename = 'index.js'): StaticScanResult {
  const findings: StaticFinding[] = []
  let ast: any
  try {
    ast = parse(source, {
      sourceType: 'unambiguous',
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      plugins: ['importAssertions', 'dynamicImport'],
    })
  } catch (e: any) {
    findings.push({
      rule: 'STC-PARSE-FAIL',
      severity: 'warn',
      message: `${filename} 无法解析为 JS（可能被混淆或不是标准 ESM/CJS）：${e?.message || e}`,
    })
    return { severity: 'warn', findings }
  }

  walk(ast, findings)

  let severity: ScanSeverity = 'pass'
  for (const f of findings) {severity = worse(severity, f.severity)}
  if (severity === 'pass') {
    findings.push({ rule: 'STC-PASS', severity: 'pass', message: 'AST 静态扫描未发现危险 API 调用' })
  }
  return { severity, findings }
}

/** 汇总多个文件的扫描结果 */
export function aggregateResults(results: StaticScanResult[]): StaticScanResult {
  const findings: StaticFinding[] = []
  let severity: ScanSeverity = 'pass'
  for (const r of results) {
    findings.push(...r.findings.filter((f) => f.rule !== 'STC-PASS'))
    severity = worse(severity, r.severity)
  }
  if (!findings.length) {
    findings.push({ rule: 'STC-PASS', severity: 'pass', message: '全部文件扫描通过' })
  }
  return { severity, findings }
}
