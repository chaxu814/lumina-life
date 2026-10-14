// ============================================================
// billing/priceTable.ts — LLM 单价表（元 / 百万 token）
//
// 【本文件是什么】
//   全应用唯一的「token → 人民币」换算事实源。预算守护者（budgetGuardian）
//   和统一账本（usageLedger）都从这里取价，不允许各自硬编码单价。
//
// 【货币与单位】
//   一律人民币（CNY），单价单位「元 / 百万 token」。
//   记录里的 token 数除以 1_000_000 再乘单价 = 费用（元）。
//
// 【占位条目】
//   DeepSeek 2026-10 现价为核实价（来源见下方注释）；
//   硅基流动 / 通义千问 / OpenAI 的条目字段结构完整但数值为占位，
//   标注 `placeholder: true`——**需用户核对后以配置覆盖**，不得当成真值展示。
//
// 【覆盖】
//   用户可在设置里覆盖任意单价（走 lumina-config.json 的 budget.priceOverrides），
//   lookupPrice 时覆盖优先于内置表。
// ============================================================

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface PriceEntry {
  /** 提供方 id（deepseek / siliconflow / qwen / openai / local…） */
  provider: string
  /** 模型名（可带别名，查表时做后缀匹配） */
  model: string
  /** 输入单价：元 / 百万 token */
  inputPerM: number
  /** 输出单价：元 / 百万 token */
  outputPerM: number
  /**
   * 非高峰折扣系数（0~1）。
   * DeepSeek 官方非高峰时段约 2.5 折 = 0.25。
   * 注意：这里只表达「存在这个折扣字段」，**不编造具体时间段**——
   * 是否处于非高峰由调用方/用户自行判断，缺省一律不打折。
   */
  offPeakDiscount?: number | null
  /** 数值为占位、需用户核对（占位条目必须显式标注，诚实原则） */
  placeholder?: boolean
  /** 备注（来源 / 更新时间） */
  note?: string
}

// ═══════════════════════════════════════════════════════════
// 内置单价表
// ═══════════════════════════════════════════════════════════

/**
 * DeepSeek 2026-10 现价
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *   - v4-flash：输入 ¥1 / 百万 token，输出 ¥2 / 百万 token
 *   - v4-pro  ：输入 ¥12 / 百万 token，输出 ¥24 / 百万 token
 *   - 非高峰时段 2.5 折（offPeakDiscount = 0.25）
 *
 * 模型名按用户配置里可能出现的写法都收进别名匹配（见 lookupPrice 的后缀匹配）。
 */
const BUILTIN_PRICES: PriceEntry[] = [
  {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    inputPerM: 1,
    outputPerM: 2,
    offPeakDiscount: 0.25,
    note: 'DeepSeek 2026-10 官网价；非高峰 2.5 折',
  },
  {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    inputPerM: 12,
    outputPerM: 24,
    offPeakDiscount: 0.25,
    note: 'DeepSeek 2026-10 官网价；非高峰 2.5 折',
  },
  // ── 以下为占位条目：字段结构完整，数值需用户核对 ──────────
  {
    provider: 'siliconflow',
    model: 'siliconflow-default',
    inputPerM: 1,
    outputPerM: 2,
    offPeakDiscount: null,
    placeholder: true,
    note: '占位单价，需用户在设置中核对硅基流动官方价后覆盖',
  },
  {
    provider: 'qwen',
    model: 'qwen-plus',
    inputPerM: 0.8,
    outputPerM: 2,
    offPeakDiscount: null,
    placeholder: true,
    note: '占位单价，需用户在设置中核对通义千问官方价后覆盖',
  },
  {
    provider: 'openai',
    model: 'gpt-4o',
    inputPerM: 17.5, // ≈ $2.5/百万，按 7 汇率粗折
    outputPerM: 70,  // ≈ $10/百万，按 7 汇率粗折
    offPeakDiscount: null,
    placeholder: true,
    note: '占位单价（美元价粗折人民币），需用户核对后覆盖',
  },
]

// ═══════════════════════════════════════════════════════════
// 用户覆盖（内存态，由 IPC 从 lumina-config.json 的 budget.priceOverrides 载入）
// ═══════════════════════════════════════════════════════════

let userOverrides: PriceEntry[] = []

/** 载入用户价格覆盖（来自 lumina-config.json，每次启动/变更时调用） */
export function setPriceOverrides(entries: PriceEntry[]): void {
  userOverrides = Array.isArray(entries) ? entries.filter(e => e && typeof e.model === 'string') : []
}

export function getPriceOverrides(): PriceEntry[] {
  return [...userOverrides]
}

/** 全部条目（内置 + 覆盖，供 UI 展示） */
export function listAllPrices(): PriceEntry[] {
  return [...BUILTIN_PRICES, ...userOverrides]
}

// ═══════════════════════════════════════════════════════════
// 模型名别名：DeepSeek 官方 API 模型名 → 我们的档位条目
//   用户在设置里照官方文档填的通常是 deepseek-chat / deepseek-reasoner，
//   与内置档位名不完全一致，这里显式映射（不猜、不模糊匹配）。
// ═══════════════════════════════════════════════════════════

const MODEL_ALIASES: Record<string, { provider: string; model: string }> = {
  'deepseek-chat': { provider: 'deepseek', model: 'deepseek-v4-flash' },
  'deepseek-reasoner': { provider: 'deepseek', model: 'deepseek-v4-pro' },
  'deepseek-v4': { provider: 'deepseek', model: 'deepseek-v4-pro' },
}

// ═══════════════════════════════════════════════════════════
// 查表
// ═══════════════════════════════════════════════════════════

/**
 * 按 provider + model 查单价。
 *
 * 匹配顺序：
 *   1. 别名表（deepseek-chat → v4-flash 等官方模型名写法）
 *   2. 精确匹配（provider+model 全等）
 *   3. provider 命中 + model 关键词包含兜底
 * 用户覆盖优先于内置表。查不到返回 null（按 0 计费并如实标注）。
 */
export function lookupPrice(provider: string, model: string): PriceEntry | null {
  const p = String(provider || '').toLowerCase()
  const m = String(model || '').toLowerCase()
  if (!m) {return null}

  // 1) 别名
  const aliasKey = Object.keys(MODEL_ALIASES).find(k => m === k || m.endsWith('/' + k))
  if (aliasKey) {
    const a = MODEL_ALIASES[aliasKey]
    return lookupPrice(a.provider, a.model)
  }

  const pool = [...userOverrides, ...BUILTIN_PRICES]

  // 2) 精确
  for (const e of pool) {
    if (e.provider.toLowerCase() === p && e.model.toLowerCase() === m) {return e}
  }
  // 3) provider 命中 + model 关键词包含（flash/pro 等档位词）
  for (const e of pool) {
    if (e.provider.toLowerCase() === p && m.includes(e.model.toLowerCase())) {return e}
  }
  return null
}

// ═══════════════════════════════════════════════════════════
// 费用计算
// ═══════════════════════════════════════════════════════════

export interface CostEstimate {
  /** 估算费用（元） */
  cost: number
  /** 是否命中非高峰折扣 */
  offPeakApplied: boolean
  /** 用到的单价条目（未命中时为 null） */
  entry: PriceEntry | null
}

/**
 * 按单价条目算一次调用的费用。
 *
 * @param entry           lookupPrice 的结果；null 时返回 0（未知 provider 不计费）
 * @param promptTokens    输入 token
 * @param completionTokens 输出 token
 * @param offPeak         是否按非高峰价计费（默认 false——宁可少估折扣，不可多送折扣）
 */
export function estimateCost(
  entry: PriceEntry | null,
  promptTokens: number,
  completionTokens: number,
  offPeak = false,
): CostEstimate {
  if (!entry) {
    return { cost: 0, offPeakApplied: false, entry: null }
  }
  let inputPrice = entry.inputPerM
  let outputPrice = entry.outputPerM
  let offPeakApplied = false
  if (offPeak && entry.offPeakDiscount && entry.offPeakDiscount < 1) {
    inputPrice *= entry.offPeakDiscount
    outputPrice *= entry.offPeakDiscount
    offPeakApplied = true
  }
  const cost = (promptTokens / 1_000_000) * inputPrice + (completionTokens / 1_000_000) * outputPrice
  // 四舍五入到 0.0001 元（小数点后 4 位），避免浮点噪声
  return {
    cost: Math.round(cost * 10_000) / 10_000,
    offPeakApplied,
    entry,
  }
}
