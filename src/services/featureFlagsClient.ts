/**
 * featureFlagsClient.ts — 渲染端功能开关客户端（I7）
 *
 * 主进程 electron/core/featureFlags.ts 是单一事实源；本文件是渲染端的薄客户端：
 * - 启动时通过 IPC 拉取全量开关（集成方在 preload/main 接线 featureFlagsGetAll/featureFlagsSet）
 * - IPC 未就绪时（开发期/未接线）回退到本地默认 + localStorage 镜像，保证「跑起来不崩」
 * - 提供同步读取与一个 React hook；精简模式 mode.minimal 由此驱动 UI 显隐
 *
 * 注意：这里的 key 列表与主进程 FeatureKey 保持一致；跨进程边界无法直接 import，
 *       改主进程开关时请同步这里的 LABELS（仅用于展示，不影响逻辑）。
 */

export type RendererFlagKey =
  | 'sandbox.severityMatrix'
  | 'sandbox.visualization'
  | 'social.deepTeam'
  | 'pet.vrmExpressive'
  | 'dream.llmGeneration'
  | 'personality.subPersona'
  | 'team.relationshipDrama'
  | 'emotion.expressiveness'
  | 'emotion.coldWar'
  | 'developer.companion'
  | 'memory.relationshipEvents'
  | 'memory.conversation'
  | 'memory.localSkills'
  | 'memory.recall'
  | 'memory.write'
  | 'memory.cjkDict'
  | 'onboarding.privacy'
  | 'mode.minimal'

/** 渲染端回退默认值（与主进程 DEFAULTS 对齐；IPC 就绪后以主进程为准） */
const CLIENT_DEFAULTS: Record<RendererFlagKey, boolean> = {
  'sandbox.severityMatrix': true,
  'sandbox.visualization': true,
  'social.deepTeam': true,
  'pet.vrmExpressive': false,
  'dream.llmGeneration': true,
  'personality.subPersona': false,
  'team.relationshipDrama': true,
  'emotion.expressiveness': true,
  'emotion.coldWar': true,
  'developer.companion': true,
  'memory.relationshipEvents': true,
  'memory.conversation': true,
  'memory.localSkills': true,
  'memory.recall': true,
  'memory.write': true,
  'memory.cjkDict': true,
  'onboarding.privacy': true,
  'mode.minimal': false,
}

/** 给「功能开关」UI 用的中文名与说明 */
export const FLAG_META: Array<{ key: RendererFlagKey; name: string; desc: string; group: string }> = [
  { key: 'sandbox.severityMatrix', name: '沙箱威胁分级', desc: '7 级严重度 × 8 类威胁规则库', group: '安全' },
  { key: 'sandbox.visualization', name: '沙箱可视化', desc: '透明玻璃房：实时展示拦截/降级/审批', group: '安全' },
  { key: 'emotion.expressiveness', name: '情绪外显', desc: '焦虑时话术变短、疲劳时桌宠动作变化', group: '情绪' },
  { key: 'emotion.coldWar', name: '冷战与原谅', desc: '连续多天不理会进入冷战，主动搭话后修复', group: '情绪' },
  { key: 'team.relationshipDrama', name: '团队关系剧本', desc: '内部互怼、护主、三人亲密度演化', group: '团队' },
  { key: 'social.deepTeam', name: '团队社交深化', desc: '剧本化事件、亲密度的实际行为后果', group: '团队' },
  { key: 'developer.companion', name: '开发者陪伴', desc: '只读 review diff/commit，长时间调试后关怀', group: '团队' },
  { key: 'memory.relationshipEvents', name: '关系事件记忆', desc: '承诺/共同完成的事/你上次难过的原因', group: '记忆' },
  { key: 'memory.conversation', name: '对话记忆', desc: '记住对话中的重要信息，让后续回答更贴合你', group: '记忆' },
  { key: 'memory.recall', name: '使用记忆', desc: '允许 Lumina 在回答前检索并参考长期记忆（建议在新对话开始前设定）', group: '记忆' },
  { key: 'memory.write', name: '生成记忆', desc: '允许把本轮对话沉淀为新记忆，可随时开关', group: '记忆' },
  { key: 'memory.cjkDict', name: '中文词表分词', desc: '零依赖词表增强中文召回精度，关闭即回退按字切分', group: '记忆' },
  { key: 'memory.localSkills', name: '本地记忆与技能', desc: '自动记录工作过程并优化技能，数据仅保存在你的设备上', group: '记忆' },
  { key: 'dream.llmGeneration', name: '梦境 LLM 生成', desc: '未配 LLM 时自动回退模板并诚实标注', group: '记忆' },
  { key: 'pet.vrmExpressive', name: 'VRM 情绪动作(beta)', desc: '与 Live2D 对等前保持 beta、默认关', group: '桌宠' },
  { key: 'personality.subPersona', name: '副人格(实验)', desc: '长期记忆+情绪驱动的人格漂移，实验性默认关', group: '实验' },
  { key: 'onboarding.privacy', name: '隐私引导', desc: '首次启动展示「你的数据在哪」', group: '隐私' },
  { key: 'mode.minimal', name: '精简模式', desc: 'v0.1 公开版只露：聊天+情绪 / 记忆 / 一键办事', group: '发布' },
]

const LS_KEY = 'lumina-feature-flags'

let cache: Record<RendererFlagKey, boolean> = { ...CLIENT_DEFAULTS }
let loaded = false

function readLocalMirror(): Partial<Record<RendererFlagKey, boolean>> {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function writeLocalMirror() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cache)) } catch { /* 隐私模式等 */ }
}

/** 拉取主进程开关；失败则用默认 + localStorage 镜像（绝不抛） */
export async function loadFlags(): Promise<Record<RendererFlagKey, boolean>> {
  const api = (window as any).luminaAPI
  let remote: Partial<Record<RendererFlagKey, boolean>> = {}
  try {
    if (api && typeof api.featureFlagsGetAll === 'function') {
      remote = await api.featureFlagsGetAll()
    }
  } catch { /* 未接线/主进程忙 */ }
  const mirror = readLocalMirror()
  cache = { ...CLIENT_DEFAULTS, ...mirror, ...(remote || {}) }
  loaded = true
  return { ...cache }
}

/** 同步读取（组件首屏渲染用；未加载时先返回本地镜像/默认） */
export function getFlag(key: RendererFlagKey): boolean {
  if (!loaded) {
    const mirror = readLocalMirror()
    return key in mirror ? mirror[key]! : CLIENT_DEFAULTS[key]
  }
  return cache[key]
}

export function isMinimalMode(): boolean {
  return getFlag('mode.minimal')
}

/** 写回主进程 + 本地镜像；返回最新值（写失败时仅本地生效） */
export async function setFlagRemote(key: RendererFlagKey, value: boolean): Promise<boolean> {
  cache[key] = value
  writeLocalMirror()
  const api = (window as any).luminaAPI
  try {
    if (api && typeof api.featureFlagsSet === 'function') {
      await api.featureFlagsSet(key, value)
    }
  } catch { /* 未接线：仅本地 */ }
  return value
}

/** 导出全量（供设置页渲染） */
export function snapshotFlags(): Record<RendererFlagKey, boolean> {
  return { ...cache }
}
