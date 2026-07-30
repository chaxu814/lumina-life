/**
 * 🚨 DEPRECATED — v9.5
 *
 * 热茶（Recha）已由 main.ts 直接创建并注册到 DelegationManager，
 * 本 Runner 为占位封装，不再被委托系统使用。
 * 保留仅作回滚备份；若需恢复可在此重新 export。
 */
export function getRechaRunner() {
  throw new Error('rechaRunner.ts 已废弃：热茶使用 main.ts 注册的独立 AgentRunner，无需此封装。')
}
