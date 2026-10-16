// ============================================================
// services/llmPersist.ts — LLM 配置持久化唯一入口
//
// 【为什么需要这个文件】
// 审计发现：项目里有 5 条能改 LLM 配置的路径，其中 **3 条只改内存不落盘**：
//
//   ✗ ModelSelector（顶栏切换，最高频）  → setLLMConfig
//   ✗ OnboardingWizard.useFound（新手第一步）→ setLLMConfig
//   ✗ SettingsLLM.applyLocal（本地模型接入）→ 原先也是（已单独修过）
//
// 后果都一样：**界面变了、提示成功、重启复原**。
// 用户感知是「配置不生效 / 老是有个固定的东西」。
// 这类 bug 极难定位，因为每次复现都要重启一次。
//
// 【解决方式】
// 不去逐个改那 3 处（改了还会有人新增第 4 处），
// 而是提供 `persistLLMConfig()` 作为唯一落盘入口，并让
// `switchLLMProvider` 之后**显式调用**它。
//
// 为什么要显式调用而不是自动落盘：
// switchLLMProvider 是纯 reducer-ish 的同步状态更新，
// 塞进 async IO 会让它的语义变浑浊、也让单测变脆。
// 保持「改内存」和「落盘」两步显式，调用方能清楚知道发生了什么，
// 也能在落盘失败时给出用户可见的提示。
// ============================================================

import type { LLMConfig } from '../stores/appStore'

export interface PersistResult {
  ok: boolean
  /** 落盘失败时的原因 */
  error?: string
}

/**
 * 把当前 LLM 配置写入 lumina-providers.json，并设为激活供应商。
 *
 * 后端 providerManager.setProviderConfig 还会自动同步到
 * agent-llm-configs.json（lumina/yak/recha 三方），
 * 因此调这一个函数就能让两个配置源保持一致。
 *
 * @param providerId 供应商 id（lmstudio / ollama / openai …）
 * @param cfg        要保存的配置；未给出的字段沿用后端已有值
 * @param opts.notifyOnError 落盘失败时是否抛给调用方提示用户
 */
export async function persistLLMConfig(
  providerId: string,
  cfg: Partial<LLMConfig> = {},
  opts: { notifyOnError?: boolean } = {},
): Promise<PersistResult> {
  if (!providerId) {
    return { ok: false, error: '缺少供应商 id' }
  }
  try {
    const res = await (window as any).luminaAPI?.providerSaveConfig?.(providerId, {
      baseUrl: cfg.baseUrl || '',
      apiKey: cfg.apiKey || '',
      model: cfg.model || '',
      enabled: true,
      timeout: (cfg as any).timeout || 600,
      maxContextTokens: cfg.contextWindow || 256000,
    })
    if (res && res.success === false) {
      return { ok: false, error: res.error || '保存到配置失败' }
    }
    await (window as any).luminaAPI?.providerSetActive?.(providerId)
    await refreshAgentLlmConfigs()
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/**
 * 保存 LLM 配置后，刷新前端「per-agent 配置」缓存。
 *
 * 【为什么必须刷新】
 * 后端在保存供应商时会顺手把配置同步写进 agent-llm-configs.json
 * （lumina/yak/recha 三方）。但前端 store 里的 `agentLlmConfigs` 只在
 * 「团队群聊」首次挂载时加载过一次 —— 保存完不刷新的话，群聊页会继续
 * 拿**旧端点 + 旧 Key** 去探测，于是界面一直报「未配置 LLM / 鉴权失败」，
 * 而磁盘上的配置其实已经是对的。
 *
 * 用户侧的表现就是最气人的那种：「我明明配好了，它还是不认」。
 *
 * 动态 import 而非顶层 import：appStore 是重量级模块，顶层引入会让
 * 这条纯工具链把整个 store 拖进依赖图（也避免潜在的循环依赖）。
 */
export async function refreshAgentLlmConfigs(): Promise<void> {
  try {
    const { useStore } = await import('../stores/appStore')
    await useStore.getState().loadAgentLlmConfigs()
  } catch {
    // 刷新失败不影响保存结果：保存本身已经成功，最坏情况是界面晚一步才更新
  }
}

/**
 * 便捷包装：先改内存（复用 store 的 switchLLMProvider 语义），再落盘。
 *
 * 适用于「用户在 UI 上点选一个新模型/供应商」这类场景——
 * 一次调用完成两件事，调用方不再需要记得自己写两遍。
 */
export async function switchAndPersist(
  store: {
    switchLLMProvider: (id: string, url: string, model: string) => void
    setLLMConfig: (c: Partial<LLMConfig>) => void
    llmConfig: LLMConfig
  },
  providerId: string,
  baseUrl: string,
  model: string,
  extra: Partial<LLMConfig> = {},
): Promise<PersistResult> {
  try {
    store.switchLLMProvider(providerId, baseUrl, model)
    if (model) {store.setLLMConfig({ model, ...extra })}
    const st = store.llmConfig
    return await persistLLMConfig(providerId, {
      baseUrl: baseUrl || st.baseUrl,
      apiKey: st.apiKey,
      model: model || st.model,
      contextWindow: st.contextWindow,
    })
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}
