// ============================================================
// electron/gaming/gameConfig.ts — 游戏模块配置解析
//
// 从环境变量读取，默认全部关闭。纯函数，可单测。
// ============================================================

import type { GameConfig, GameRoute, ResolvedRoute } from './types'

/** 读取单个环境变量（测试时可注入 env） */
function readEnv(name: string): string | undefined {
  return process.env[name]
}

/** 解析布尔值（'true'/'1'/'yes' → true，其余 → false） */
function parseBool(v: string | undefined): boolean {
  if (v == null) {return false}
  return ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())
}

/** 解析端口（非法返回默认值） */
function parsePort(v: string | undefined, fallback: number): number {
  if (!v) {return fallback}
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n < 65536 ? Math.floor(n) : fallback
}

/**
 * 从环境变量构建 GameConfig。
 * 测试时可直接传 env 对象覆盖 process.env。
 *
 * 新增（向后兼容，不设时行为与旧版完全一致）：
 *   - LUMINA_GAME_PROFILE：默认 profile id（'minecraft' | 'factorio' | 'auto'），
 *     'auto' 或缺省 = 运行时按窗口/进程自动探测，探测不到回退 'minecraft'。
 *   - LUMINA_GAME_ENABLED_GAMES：逗号分隔的启用游戏 id 白名单，
 *     空 = 未限定（安全默认仍由 LUMINA_GAME_ENABLED 总开关控制）。
 */
export function loadGameConfig(env: NodeJS.ProcessEnv = process.env): GameConfig {
  const enabled = parseBool(env.LUMINA_GAME_ENABLED)
  const routeRaw = (env.LUMINA_GAME_ROUTE || 'auto').trim().toLowerCase()
  const route: GameRoute = (['auto', 'visual', 'bot'] as const).includes(routeRaw as any)
    ? (routeRaw as GameRoute)
    : 'auto'

  const host = (env.LUMINA_MINECRAFT_HOST || '').trim()
  const port = parsePort(env.LUMINA_MINECRAFT_PORT, 25565)
  const username = (env.LUMINA_MINECRAFT_USERNAME || 'lumina_bot').trim() || 'lumina_bot'
  const version = (env.LUMINA_MINECRAFT_VERSION || '1.20.4').trim() || '1.20.4'

  // bot 启用条件：显式配置了 host（且非默认回环空值）
  const botConfigured = host.length > 0

  // 多游戏 Profile 配置
  const profileRaw = (env.LUMINA_GAME_PROFILE || '').trim().toLowerCase()
  const activeProfile = profileRaw && profileRaw !== 'auto' ? profileRaw : undefined
  const enabledGamesRaw = (env.LUMINA_GAME_ENABLED_GAMES || '').trim()
  const enabledGames = enabledGamesRaw
    ? enabledGamesRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : undefined

  return {
    enabled,
    route,
    windowTitle: (env.LUMINA_GAME_WINDOW_TITLE || 'Minecraft').trim() || 'Minecraft',
    bot: {
      host,
      port,
      username,
      version,
      enabled: botConfigured,
    },
    ...(activeProfile ? { activeProfile } : {}),
    ...(enabledGames ? { enabledGames } : {}),
  }
}

/**
 * 根据配置决定实际运行路线。
 *   - visual: 始终视觉路线
 *   - bot:    仅在 bot 已配置且 mineflayer 可用时走 bot，否则回退 visual
 *   - auto:   bot 可用走 bot，否则 visual
 *
 * @param botAvailable mineflayer 是否可动态 import（由调用方探测）
 */
export function resolveRoute(
  config: GameConfig,
  botAvailable: boolean,
): ResolvedRoute {
  const botReady = config.bot.enabled && botAvailable
  if (config.route === 'visual') {return 'visual'}
  if (config.route === 'bot') {return botReady ? 'bot' : 'visual'}
  // auto
  return botReady ? 'bot' : 'visual'
}
