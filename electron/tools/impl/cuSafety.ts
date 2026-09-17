// ============================================================
// cuSafety.ts — Computer Use 安全策略（零依赖纯函数，可单测）
//
// destructiveReason: 命中明确不可逆 / 越权的系统命令时返回人类可读原因，
// 否则返回 null。任何权限姿态（auto/ask/strict）下，命中都硬拦截。
//
// 设计原则：只匹配“命令形态”，避免把普通文档里出现的“删除/转账”等文字误判。
// ============================================================

const PATTERNS: Array<[RegExp, string]> = [
  [/\bformat\s+[a-z]:/i, '格式化磁盘'],
  [/\brm\s+-rf\s+(\/|~|\*|\/\*|C:)/i, '递归强制删除根/家目录'],
  [/\bmkfs\b/i, '格式化文件系统'],
  [/\bdiskpart\b/i, '磁盘分区操作'],
  [/\bshutdown\b\s*(\/s|\/r|\/f|-h|-r)\b/i, '关机/重启'],
  [/\b(restart|stop)-computer\b/i, '关机/重启'],
  [/\breg\s+delete\b/i, '删除注册表项'],
  [/\bremove-item\b[\s\S]{0,80}-recurse[\s\S]{0,40}-force/i, '递归强制删除'],
  [/\bdel\s+[^|\n]*\/[fsq]/i, '强制/静默删除'],
  [/\brmdir\s+\/s/i, '递归删除目录'],
  [/\bnet\s+user\b[\s\S]{0,40}\/\w+/i, '修改系统账户'],
  [/\bdd\s+if=[\s\S]*of=\\\\?\.?\\?/i, '直写磁盘设备'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork 炸弹'],
]

export function destructiveReason(text: string | undefined | null): string | null {
  if (!text) return null
  const s = String(text)
  for (const [re, label] of PATTERNS) {
    if (re.test(s)) return `检测到高危/不可逆操作（${label}），已硬拦截`
  }
  return null
}

/** 便捷布尔判定 */
export function isDestructive(text: string | undefined | null): boolean {
  return destructiveReason(text) !== null
}
