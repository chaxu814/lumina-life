// ============================================================
// onboarding/beginnerMode.ts — 新手模式（把上手门槛从"懂配置"降到"点一下"）
// ============================================================
//
// 【要解决的真问题】
// 2026-10-03 发布前审计：Lumina 的**工程完成度很高，但上手门槛偏高** ——
// 用户需要自己装 LM Studio / 配 baseUrl / 填 API Key / 选模型 才能开始对话。
// 对专业开发者无所谓，对普通用户这是硬门槛，也是桌宠品类最大的流失点。
//
// 【为什么不直接内置推理引擎】
// 内置 ONNX/模型分发会带来 +数百 MB 体积、多平台坑、和上游模型生态脱节。
// 我们已经在 `onboarding/localModelDetector` 里能探测本地服务了，
// 所以正确的做法是：**把"该做什么"直接算好给用户，而不是让用户自己判断。**
//
// 【本模块做什么】
// 纯函数：给定探测结果 → 推荐一套配置（provider / baseUrl / model / 说明）。
// 不碰网络、不写文件，可单测。真正的探测在 llmReachability / localModelDetector。
// ============================================================

/** 三档上手路径，面向不同人群 */
export type BeginnerPath = 'zero-config' | 'local' | 'cloud'

export interface BeginnerRecommendation {
  path: BeginnerPath
  /** 给用户看的一句话标题 */
  title: string
  /** 具体怎么做（可复制粘贴的步骤） */
  steps: string[]
  /** 会不会花钱 */
  cost: '完全免费（本地）' | '按量付费' | '取决于你选的云服务'
  /** 该路径的已知限制 —— 诚实列出来，别让用户踩坑才发现 */
  limitations: string[]
  /** 推荐优先级：数字越小越靠前 */
  priority: number
}

/** 探测到的本地服务情况 */
export interface LocalProbe {
  lmstudio: { available: boolean; models: string[] }
  ollama: { available: boolean; models: string[] }
  /** 用户是否已填过云端 API Key */
  hasCloudKey: boolean
  /** 云端 key 的服务商（如果已知） */
  cloudProvider?: string
}

// ═══════════════════════════════════════════════════════════
// 推荐逻辑
// ═══════════════════════════════════════════════════════════

/**
 * 给新手推荐一条上手路径。
 *
 * 规则刻意保守：**永远不假装某条路能走**。只有真的探测到服务才推荐它；
 * 都不通就只给云端，并明说需要自备 API Key。
 */
export function recommendPath(probe: LocalProbe): BeginnerRecommendation {
  // 1. 本地已有可用服务 → 最优先（免费 + 隐私 + 离线）
  if (probe.lmstudio.available && probe.lmstudio.models.length > 0) {
    return {
      path: 'local',
      title: '用本机模型（免费 · 隐私 · 离线）',
      steps: [
        `检测到 LM Studio 已运行，${probe.lmstudio.models.length} 个模型可用。`,
        '在 LM Studio 里加载一个模型（推荐 Qwen / DeepSeek / Mistral 系列的 instruct 模型）。',
        'Lumina 会自动连上，无需填任何 Key。',
      ],
      cost: '完全免费（本地）',
      limitations: [
        '需要你的电脑跑得动模型：建议 16GB 内存，7B 量化模型约需 6~8GB 显存或内存。',
        '首次下载模型可能几 GB。',
        '本地小模型在复杂任务上弱于云端大模型。',
      ],
      priority: 1,
    }
  }

  if (probe.ollama.available && probe.ollama.models.length > 0) {
    return {
      path: 'local',
      title: '用本机模型（免费 · 隐私 · 离线）',
      steps: [
        `检测到 Ollama 已运行，${probe.ollama.models.length} 个模型可用。`,
        '如需更多模型：`ollama pull qwen2.5:7b`',
        'Lumina 会自动连上，无需填任何 Key。',
      ],
      cost: '完全免费（本地）',
      limitations: [
        '需要你的电脑跑得动模型。',
        '本地小模型在复杂任务上弱于云端大模型。',
      ],
      priority: 1,
    }
  }

  // 2. 已有云端 Key → 直接用
  if (probe.hasCloudKey) {
    return {
      path: 'cloud',
      title: `继续用你已配置的${probe.cloudProvider || '云端模型'}`,
      steps: ['你已经配好了云端 API Key，直接开始用就行。'],
      cost: '按量付费',
      limitations: ['对话内容会发送到云服务商。敏感代码请改用本地模型。'],
      priority: 1,
    }
  }

  // 3. 什么都没配 → 老实说，给两条路让用户选
  return {
    path: 'zero-config',
    title: '两条路选一条（都能用）',
    steps: [
      'A. 不想花钱、要隐私 → 装 LM Studio（lmsstudio.org），加载一个模型，本地跑',
      'B. 只想立刻体验 → 填一个云端 API Key（DeepSeek 最便宜，OpenAI/通义千问/硅基流动也行）',
      '两条路随时可以切换，设置里一键换。',
    ],
    cost: 'A 完全免费；B 按量付费',
    limitations: [
      '当前版本不支持"开箱即用"—— 至少需要 A 或 B 其中之一。',
      '这是我们 v0.1 已知的主要门槛，已列入 ROADMAP 的新手模式路线。',
    ],
    priority: 1,
  }
}

/** 给「零配置」路径的最小可行云端推荐：便宜、中文好、注册简单 */
export const CHEAP_CLOUD_SUGGESTIONS: ReadonlyArray<{
  provider: string
  baseUrl: string
  note: string
}> = [
  { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', note: '中文好、最便宜，适合先试' },
  { provider: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', note: '一个 Key 调多个模型' },
  { provider: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', note: '国内速度快' },
  { provider: 'OpenAI', baseUrl: 'https://api.openai.com/v1', note: '生态最好，稍贵' },
] as const

/** 新手第一次用，建议先试的三件事 —— 降低"不知道能干嘛"的迷茫 */
export const FIRST_RUN_EXAMPLES: readonly string[] = [
  '你好，你能做什么？',
  '帮我把这个文件夹里的图片按类型分一下类',
  '帮我看看这段代码有没有问题',
  '明天天气怎么样？',
] as const

/** 按新手模式应自动开启的设置项 */
export interface BeginnerToggles {
  /** 桌宠主动说话（新手建议关，避免一上来就被打扰） */
  proactiveChat: boolean
  /** 全屏注视（新手建议关，容易觉得被盯着） */
  screenAwareness: boolean
  /** 后台自主任务（新手必须关，否则半夜自己干活会吓到人） */
  backgroundAutonomy: boolean
  /** 屏幕感知日志（默认关，涉及隐私） */
  screenPrivacyMask: boolean
}

/**
 * 新手模式的推荐开关。
 *
 * 默认**偏保守**：主动说话、全屏注视、后台自主任务都关掉。
 * 理由：这些功能对老用户是卖点，对新用户第一次打开时是惊吓。
 * 想要的人自己去设置里开 —— 这比"默认全开然后被骂"好。
 */
export const BEGINNER_DEFAULT_TOGGLES: BeginnerToggles = {
  proactiveChat: false,
  screenAwareness: false,
  backgroundAutonomy: false,
  screenPrivacyMask: true,
}

/** 生成一段给新手看的开场白（讲人话，不讲架构） */
export function buildBeginnerGreeting(petName = 'Lumina'): string {
  return [
    `你好呀，我是 ${petName} 🐱`,
    '',
    '我已经准备好了，不过有件事得先说清楚：',
    '**我需要一个模型才能思考。** 就像大脑需要知识一样。',
    '',
    '两条路选一条：',
    '· **本地模型**（免费、隐私好、不联网）→ 装 LM Studio',
    '· **云端模型**（立刻可用、按量付费）→ 填一个 API Key',
    '',
    '第一次用不知道能问什么？试试：',
    ...FIRST_RUN_EXAMPLES.map(e => `  · ${e}`),
    '',
    '有任何问题直接问我就行。',
  ].join('\n')
}
