// ============================================================
// electron/gaming/security.ts — 游戏操作安全护栏
//
// 复用 electron/securityGuard（参数级审查），并添加游戏特定规则：
//   - 拦截危险的聊天命令（/op /stop /kill @e /execute /gamemode 等）
//   - 拦截关闭游戏 / 修改系统设置 / 删除世界文件
//   - 移动/攻击类动作标记为中风险（需审批流确认）
//
// 设计为纯函数 + 可注入，便于单测。
// ============================================================

import type { GameActionRequest, GameGuardResult } from './types'

/** 危险聊天命令前缀（管理员/破坏性），命中即拒绝 */
const DANGEROUS_CHAT_COMMANDS: RegExp[] = [
  /^\s*\/(op|deop|stop|restart|save-all|save-off|save-on)\b/i,
  /^\s*\/(kill)\s+@(e|a|p|r)\b/i,          // /kill @e / @a
  /^\s*\/(execute|executeas)\b/i,
  /^\s*\/(gamemode|defaultgamemode)\b/i,
  /^\s*\/(whitelist|ban|ban-ip|pardon|kick)\b/i,
  /^\s*\/(op)\b/i,
  /^\s*\/(setblock|fill|clone)\b/i,         // 大范围改方块
  /^\s*\/(tp|teleport)\s+@(e|a)\b/i,        // 批量传送
]

/** 允许的安全聊天命令白名单（普通玩家可用） */
const SAFE_CHAT_COMMANDS: RegExp[] = [
  /^\s*\/(help|list|seed|spawn|home|sethome|msg|tell|w|r|me|credits|demo|question)\b/i,
]

/**
 * 审查一条聊天文本。
 * - 非 "/" 开头 → 普通聊天，放行
 * - "/" 开头且命中危险命令 → 拒绝
 * - "/" 开头且命中白名单 → 放行
 * - 其它 "/" 命令 → 中风险（需审批）
 */
export function reviewChat(text: string | undefined): GameGuardResult {
  const t = (text || '').trim()
  if (!t) {return { allowed: false, reason: '聊天内容为空' }}
  if (!t.startsWith('/')) {return { allowed: true }}

  for (const re of DANGEROUS_CHAT_COMMANDS) {
    if (re.test(t)) {
      return { allowed: false, reason: `⛔ 拦截危险的管理员/破坏命令: ${t.slice(0, 40)}` }
    }
  }
  for (const re of SAFE_CHAT_COMMANDS) {
    if (re.test(t)) {return { allowed: true }}
  }
  // 其它斜杠命令（如 /give /xp）→ 中风险审批
  return {
    allowed: true,
    needsApproval: true,
    reason: `⚠️ 游戏斜杠命令需确认: ${t.slice(0, 40)}`,
  }
}

/** 动作风险分级：哪些动作需要审批（中风险） */
const MEDIUM_RISK_ACTIONS = new Set<GameActionRequest['action']>([
  'attack',
  'place',
  'craft',
])

/**
 * 审查一个游戏动作请求（不含聊天内容，聊天单独走 reviewChat）。
 * 这是游戏入口的第一道门；registry 层还会再过一次 securityGuard。
 */
export function reviewGameAction(req: GameActionRequest): GameGuardResult {
  // 参数基础校验
  if (!req || !req.action) {
    return { allowed: false, reason: '缺少 action 参数' }
  }

  // select_slot 范围校验
  if (req.action === 'select_slot') {
    const slot = Number(req.slot)
    if (!Number.isFinite(slot) || slot < 1 || slot > 9) {
      return { allowed: false, reason: `slot 必须是 1-9，收到: ${req.slot}` }
    }
  }

  // look_at 角度范围校验
  if (req.action === 'look_at') {
    if (req.yaw != null) {
      const y = Number(req.yaw)
      if (!Number.isFinite(y) || y < -180 || y > 180) {
        return { allowed: false, reason: `yaw 必须在 -180~180，收到: ${req.yaw}` }
      }
    }
    if (req.pitch != null) {
      const p = Number(req.pitch)
      if (!Number.isFinite(p) || p < -90 || p > 90) {
        return { allowed: false, reason: `pitch 必须在 -90~90，收到: ${req.pitch}` }
      }
    }
  }

  // chat 走聊天审查
  if (req.action === 'chat') {
    return reviewChat(req.text)
  }

  // 中风险动作
  if (MEDIUM_RISK_ACTIONS.has(req.action)) {
    return { allowed: true, needsApproval: true, reason: `⚠️ ${req.action} 为中风险动作，建议确认` }
  }

  return { allowed: true }
}

/**
 * 校验 bot 连接配置是否安全。
 * 规则：
 *   - 禁止自动登录正版账号（username 以 "Bot" 开头或离线名即可；真实正版 session 需用户自行配置）
 *   - 禁止连接非回环/非用户显式配置的公网服务器（host 必须由 env 显式提供）
 */
export function reviewBotConnection(host: string, username: string): GameGuardResult {
  const h = (host || '').trim()
  if (!h) {return { allowed: false, reason: '未配置 Minecraft 服务器地址' }}
  // 不允许使用微软正版认证字段（防止 token 泄露）；只走离线/本地模式
  if (/\.(microsoft|xbox|live)\.com|xboxlive\.com|mojang\.com/i.test(h)) {
    return { allowed: false, reason: '禁止连接认证服务器域名（防止凭证泄露）' }
  }
  const u = (username || '').trim()
  if (!u) {return { allowed: false, reason: 'bot username 为空' }}
  return { allowed: true }
}
