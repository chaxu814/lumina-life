// ============================================================
// security/threatIntel.ts — 🧲 离线威胁情报列表 (v0.2 创新提案5)
//
// 内置一份「离线规则」：已知恶意/仿冒包名、可疑域名黑名单。
// 不依赖网络，启动时即加载；后续可通过 update() 从云端覆盖/合并。
// 这是静态扫描器的配套情报源，本身不做 AST，只做集合查找。
// ============================================================

/** 已知恶意/高风险 npm 包名（小写）。来源于历史投毒事件的公开名单摘录。 */
export const MALICIOUS_PACKAGES: ReadonlySet<string> = new Set([
  // event-stream 事件及其家族
  'event-stream', 'flatmap-stream',
  // 知名 typosquatting / 投毒包（节选历史公开样本）
  'coa', 'rc', 'rc-is', 'ua-parser-js',
  'cryptocurrency-address', 'bitcoin-address', 'ether-address',
  'libnode', 'npmlinks', 'shadow-layer',
  // 仿冒常用工具（编辑距离小、历史上出现过的影子包）
  'crossenv', 'cross-env.js', 'dsnp',
  'elektron', 'electront', 'electron-json-storage-xss',
])

/** 已知恶意/高风险域名（小写，含主机名或后缀）。 */
export const MALICIOUS_DOMAINS: ReadonlySet<string> = new Set([
  'pastebin.com', // 大量恶意脚本通过 pastebin 分发（仅作可疑，非绝对恶意）
  'hastebin.com',
  'transfer.sh',
  'fake-domain.xyz',
  'evil-node-utils.example',
])

/** 被高度滥用的 C2 / 回连特征域名片段（命中即 warn） */
export const C2_DOMAIN_FRAGMENTS: ReadonlySet<string> = new Set([
  'ngrok.io', 'ngrok-free.app', 'serveo.net', 'localtunnel.me',
])

export interface ThreatIntelData {
  maliciousPackages: Set<string>
  maliciousDomains: Set<string>
  c2Fragments: Set<string>
  /** 情报版本号，便于前端展示「规则新鲜度」 */
  version: string
  updatedAt: number
}

let current: ThreatIntelData = {
  maliciousPackages: new Set(MALICIOUS_PACKAGES),
  maliciousDomains: new Set(MALICIOUS_DOMAINS),
  c2Fragments: new Set(C2_DOMAIN_FRAGMENTS),
  version: 'builtin-2026-09-24',
  updatedAt: Date.now(),
}

export function getThreatIntel(): ThreatIntelData {
  return current
}

export interface PackageThreatHit {
  kind: 'malicious' | 'typosquat' | null
  /** 命中的黑名单包名（malicious 时） */
  matchedName?: string
  /** typosquat 时最接近的知名包 */
  looksLike?: string
  distance?: number
}

/** 编辑距离（Levenshtein），小写后比较，用于 typosquatting 检测 */
export function levenshtein(a: string, b: string): number {
  if (a === b) {return 0}
  if (!a.length) {return b.length}
  if (!b.length) {return a.length}
  const dp: number[] = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) {dp[j] = j}
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      prev = tmp
    }
  }
  return dp[b.length]
}

/** 常见知名包名白名单，用于 typosquatting 比对 */
export const POPULAR_PACKAGES: ReadonlySet<string> = new Set([
  'lodash', 'react', 'react-dom', 'vue', 'angular', 'axios', 'express',
  'webpack', 'vite', 'typescript', 'electron', 'fs-extra', 'moment',
  'underscore', 'request', 'debug', 'chalk', 'commander', 'dotenv',
  'cross-env', 'ws', 'got', 'node-fetch', 'undici', 'tar', 'semver',
])

/**
 * 判断一个包名是否命中威胁情报。
 * - 先查黑名单（malicious）；
 * - 再与知名包算编辑距离，≤2 且自身不在白名单 → typosquat。
 */
export function checkPackageName(name: string): PackageThreatHit {
  const n = String(name || '').trim().toLowerCase()
  if (!n) {return { kind: null }}

  if (current.maliciousPackages.has(n)) {
    return { kind: 'malicious', matchedName: n }
  }
  // 自带命名空间的包（@scope/name）只比对 name 段
  const short = n.startsWith('@') ? n.split('/')[1] || n : n
  if (current.maliciousPackages.has(short)) {
    return { kind: 'malicious', matchedName: short }
  }

  if (POPULAR_PACKAGES.has(n) || POPULAR_PACKAGES.has(short)) {
    return { kind: null }
  }

  let best: { name: string; dist: number } | null = null
  for (const pop of POPULAR_PACKAGES) {
    const d = levenshtein(short, pop)
    if (d > 0 && d <= 2 && (!best || d < best.dist)) {
      best = { name: pop, dist: d }
    }
  }
  if (best) {
    return { kind: 'typosquat', looksLike: best.name, distance: best.dist }
  }
  return { kind: null }
}

/** 判断一个主机名/域名是否命中黑名单或 C2 特征 */
export function checkDomain(host: string): { level: 'block' | 'warn' | 'pass'; reason?: string } {
  const h = String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]
  if (!h) {return { level: 'pass' }}
  // 去掉端口
  const hostOnly = h.split(':')[0]

  if (current.maliciousDomains.has(hostOnly)) {
    return { level: 'block', reason: `域名在恶意名单中: ${hostOnly}` }
  }
  for (const frag of current.c2Fragments) {
    if (hostOnly === frag || hostOnly.endsWith('.' + frag) || hostOnly.endsWith(frag)) {
      return { level: 'warn', reason: `疑似临时回连隧道域名: ${hostOnly}` }
    }
  }
  return { level: 'pass' }
}

/** 是否为硬编码公网 IP（非 127./私有段） */
export function isHardcodedPublicIp(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host || '').trim())
  if (!m) {return false}
  const [a, b] = [Number(m[1]), Number(m[2])]
  // 私有/回环/链路本地不报警
  if (a === 10 || a === 127) {return false}
  if (a === 192 && b === 168) {return false}
  if (a === 172 && b >= 16 && b <= 31) {return false}
  if (a === 0) {return false}
  return true
}

/** 允许云端情报覆盖合并（未来接口；MVP 仅本地内置） */
export function updateThreatIntel(patch: {
  addPackages?: string[]
  addDomains?: string[]
  addC2Fragments?: string[]
  version?: string
}): ThreatIntelData {
  if (patch.addPackages) {patch.addPackages.forEach((p) => current.maliciousPackages.add(p.toLowerCase()))}
  if (patch.addDomains) {patch.addDomains.forEach((d) => current.maliciousDomains.add(d.toLowerCase()))}
  if (patch.addC2Fragments) {patch.addC2Fragments.forEach((d) => current.c2Fragments.add(d.toLowerCase()))}
  if (patch.version) {current.version = patch.version}
  current.updatedAt = Date.now()
  return current
}
