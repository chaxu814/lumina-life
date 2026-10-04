// ================================================================
// services/teamVisibility.ts — 群聊成员显示开关
//
// 【要解决什么】
// 团队群聊里 Yak 和 热茶 会持续产出内容。默认全开时，
// 消息流会变得眼花缭乱 —— 尤其对不熟悉这个产品的用户，
// 他们分不清哪句是主线、哪句是后台成员的自言自语。
//
// 2026-10-04 按用户要求：让用户能在「团队管理」里自己决定谁参与群聊。
//
// 【为什么不用 zustand】
// 这是纯 UI 偏好，不是业务状态。用 localStorage 有两个好处：
//   1. 刷新/重启立刻生效，不需要等 store 重新水合
//   2. 不进 persist 白名单，**不会污染 lumina-config.json**（那份是给用户看的配置）
//
// 【不变式：Lumina 永远可见】
// Lumina 是用户唯一的对话对象，隐藏她等于产品不可用。
// 所以开关只对 yak / recha（以及未来的动态成员）开放，UI 上也不给 Lumina 渲染。
// ================================================================

const STORAGE_KEY = 'gc-visible-agents'

/** 固定成员 id。Lumina 不在可控范围内。 */
export type ControllableAgentId = 'yak' | 'recha'

export const DEFAULT_VISIBLE: Record<ControllableAgentId, boolean> = {
  yak: true,
  recha: true,
}

function read(): Record<ControllableAgentId, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) { return { ...DEFAULT_VISIBLE } }
    const parsed = JSON.parse(raw)
    // 逐个字段校验：localStorage 里的东西可能被手改、被旧版本写坏
    return {
      yak: parsed?.yak !== false,
      recha: parsed?.recha !== false,
    }
  } catch {
    return { ...DEFAULT_VISIBLE }
  }
}

function write(v: Record<ControllableAgentId, boolean>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)) } catch { /* 隐私模式等 */ }
  // 通知同页其他订阅者（TeamPanel 与 GroupChatView 各自 useSyncExternalStore）
  window.dispatchEvent(new CustomEvent('gc-visible-agents-changed', { detail: v }))
}

/** 读当前可见性 */
export function getVisibleAgents(): Record<ControllableAgentId, boolean> {
  return read()
}

/** 设置单个成员是否在群聊里出现 */
export function setAgentVisible(id: ControllableAgentId, visible: boolean): void {
  const cur = read()
  if (cur[id] === visible) { return }
  write({ ...cur, [id]: visible })
}

/** 某个 agent 当前是否应在群聊显示（Lumina 恒为 true） */
export function isAgentVisible(id: string): boolean {
  if (id === 'lumina') { return true }
  const v = read()
  if (id === 'yak' || id === 'recha') { return v[id] }
  // 动态成员：默认显示（没有显式关闭过）
  // 动态成员：没被显式关掉就显示（v 里没有它的键时 !== false 成立）
  return (v as Record<string, boolean>)[id] !== false
}

/** 被隐藏的成员在消息流里替换成一行折叠摘要，不完全消失 */
export function hiddenSummary(count: number): string {
  if (count <= 0) { return '' }
  return `🤫 ${count} 条后台成员发言已折叠（可在「团队管理」里打开）`
}
