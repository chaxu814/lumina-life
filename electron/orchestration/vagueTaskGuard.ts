// ============================================================
// orchestration/vagueTaskGuard.ts — 模糊任务识别与澄清选项生成
//
// 【要解决什么】
// 发布前评测实测到这一档问题：
//
//   用户：「优化一下这个项目」
//   现状：可能走「简单」直接随便改点东西，也可能走「复杂」启动五阶段门控大张旗鼓
//   两种都不对 —— 用户要的不是随便改，也不是大张旗鼓，而是**先问清楚他要什么**。
//
// 【为什么不能靠模型自己判断】
// 实测里最典型的失败是 1.4B 级模型：它对模糊请求的处理方式是**挑一个看起来最像的
// 解释直接开工**，然后交出一份用户没要的东西。能力越弱的模型越容易这样，
// 因为「猜一个」比「问一句」在它的概率分布里更容易生成出合理的 token。
//
// 换句话说：**这不是模型智力问题，是产品设计问题。**
// 模糊度是任务固有属性，与执行者无关。所以判断应该由确定性的规则做，
// 只把「怎么问」交给模型。
//
// 【设计取舍：宁可多问一次，也不要瞎干一次】
// 问的成本是一次往返（约 3 秒 + 一次点击）；
// 瞎干的成本是——用户花 10 分钟看完你的产出，然后自己重做一遍。
// 对「优化项目」这种涉及他人既有资产的任务，���个成本比不成比例。
// =============================================================

/** 判定档位 */
export type VaguenessLevel =
  /** 目标与范围都清楚，直接干 */
  | 'specific'
  /** 能看出想做什么，但没说清楚「做到什么程度算完成」 */
  | 'underdefined'
  /** 连做什么都不确定，必须问 */
  | 'vague'

export interface VaguenessVerdict {
  level: VaguenessLevel
  /** 是否应该先澄清再动手 */
  needsClarification: boolean
  /** 命中的具体信号，便于日志排障与「为什么它问了我这个」的自查 */
  signals: string[]
  /** 缺失的关键信息类型 */
  missing: string[]
  /** 建议问的问题（已按项目类型给出可点选项） */
  question: string
  options: string[]
}

/**
 * 模糊动词表。
 *
 * 【为什么是这张表而不是让模型判断】
 * 这类词在任何模型里都是高歧义的：中文里「优化」既能指性能、也能指可读性、
 * 还能指界面。把它固化在规则里，等于把「这个词有歧义」这条知识显式化。
 *
 * 注意排除项：表里只有**光杆动词**。「优化这段 SQL 查询」不含裸的优化信号，
 * 因为它带了宾语 —— 判定靠的是「动词后面有没有具体宾语」，见 hasSpecificTarget。
 */
const VAGUE_VERBS = [
  '优化', '改进', '完善', '提升', '优化一下', '搞一搞', '弄一下', '弄好',
  '做得更好', '搞好了', '优化优化', '调整一下', '处理一下', '看看', '检查一下',
  '整理一下', '梳理一下', '优化下', '美化', '重写', '重构一下',
]

/** 缺失信息的分类，用于决定问什么 */
export type MissingKind =
  /** 不知道要动哪个文件/目录 */
  | 'target'
  /** 不知道优化哪个维度 */
  | 'dimension'
  /** 不知道做到什么程度 */
  | 'scope'

/**
 * 具体目标的信号。
 *
 * 【为什么要区分「强信号」和「弱信号」】
 * 强信号（文件路径、函数名、报错码）能唯一确定任务，直接干就对了。
 * 弱信号（"这段"、"这个函数"、一个泛泛的技术名词）看着像在指代，
 * 但在没有上下文时可能指任何东西 —— 拿它当「已明确」会重演瞎干的老问题。
 */
const STRONG_TARGET: RegExp[] = [
  /[A-Za-z]:\\[^\s，。]{2,}/,                    // Windows 绝对路径
  /(?:^|\s)\.{0,2}\/?[\w\-./]+\.[a-z]{1,5}\b/i, // 带扩展名的文件
  /[\w\-./]+\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|c|cpp|h|md|json|ya?ml)\b/,
  /\b(?:function|class|def|func|const|let|var)\s+[\w$]+/,  // 具名符号
  // 中文语境里的函数指代：「getToolsForMode 这个函数」「foo 方法」
  // 【为什么要单独一条】上面那条只认英文关键字，中文一句话里很少真写
  // `function foo`；真实写法是「foo 这个函数」。漏判会把明确任务判成模糊。
  /[\w$]{3,}\s*(?:这个|那个)?\s*(?:函数|方法|类|模块|组件|字段|变量)/,
  /\b\w+\(\)/,                                  // 带括号的方法调用
  // 报错类型：注意不能只写 \bError —— 「TypeError」里 Error 前面紧邻字母，
  // \b 不成立，会漏掉最常见的 TypeError。必须允许前缀。
  /\b\w*(?:Error|Exception)\b/,
  /0x[0-9a-f]+/i,                               // 内存地址
  // 中文行号是「3280 行」——数字在行字前面，与英文 `line 3280` 顺序相反
  /\d+\s*行|line\s*\d+|第\s*\d+\s*行/,
]

/** 优化维度信号：用户说了「要什么」，只是没说「对什么做」 */
const DIMENSION_SIGNALS: Array<{ re: RegExp; label: string }> = [
  { re: /性能|速度|慢|卡|延迟|吞吐|内存|占用|优化内存/i, label: '性能' },
  { re: /安全|漏洞|风险|权限|注入|越权/i, label: '安全' },
  // 【为什么要把「维护」「规范」「整洁」单独列出来】
  // 用户极少写「可维护性」，写的是「不好维护」「代码很乱」「不规范」。
  // 只认「可维护」会把最常见的抱怨判成「没提维度」，进而追问一个已经说过的问题。
  { re: /可读|可维护|维护|注释|命名|结构|清晰|整洁|规范|太乱|混乱/i, label: '可维护性' },
  { re: /测试|覆盖率|单测/i, label: '测试' },
  { re: /界面|UI|样式|布局|交互|好看|美观/i, label: '界面' },
  { re: /文档|注释|说明/i, label: '文档' },
  { re: /架构|设计|重构|解耦/i, label: '架构' },
  { re: /兼容|跨平台|迁移/i, label: '兼容性' },
]

/** 指代词：有它但没有强信号，说明用户在指代一个我们看不到的东西 */
const DEICTIC = /这个|那个|这段|那段|这些|那些|它|这|那|当前|刚才|以上|下面/

/**
 * 文本里是否含具体目标（强信号）。
 *
 * 刻意**不**把弱信号算进来：「这个函数」在有对话历史时可能有解，
 * 但守卫拿不到历史（纯函数设计），所以保守处理：宁可问，不赌。
 */
export function hasSpecificTarget(text: string): boolean {
  if (!text) {return false}
  return STRONG_TARGET.some(re => re.test(text))
}

/** 文本里是否含优化维度 */
export function detectDimension(text: string): string | null {
  if (!text) {return null}
  for (const { re, label } of DIMENSION_SIGNALS) {
    if (re.test(text)) {return label}
  }
  return null
}

function hitVagueVerb(text: string): string | null {
  for (const v of VAGUE_VERBS) {
    if (text.includes(v)) {return v}
  }
  return null
}

/** 短文本（< 8 字）几乎必然是模糊的，除非它本身就是一个路径 */
function isTooShort(text: string): boolean {
  const t = text.trim()
  return t.length > 0 && t.length < 8 && !hasSpecificTarget(t)
}

export interface AssessOptions {
  /**
   * 是否按「代码/项目任务」来评估。
   * 默认 true。对纯聊天（「今天天气不错」）返回 vague 会造成无意义的追问，
   * 所以调用方要按场景传 false。
   */
  assumeCoding?: boolean
  /**
   * 上一文是否已经确立了具体目标（用户刚贴了文件 / 刚讨论过某个函数）。
   *
   * 【为什么必须由调用方告诉守卫，而不能自己推断】
   * 守卫是纯函数，看不到对话历史。而「把这个函数改了」里的「这个函数」，
   * 在有上文时指代明确，在无上文时指代空气。
   * 让调用方回答「上文有没有锚点」是唯一的诚实做法 ——
   * 守卫自己猜就是在赌，而赌错的方向是「要么白问一句，要么白干一通」。
   *
   * 默认 false：宁可多问一次。
   */
  deicticsResolvable?: boolean
}

/**
 * 主判定入口。纯函数，无 I/O，便于单测。
 */
export function assessVagueness(text: string, opts: AssessOptions = {}): VaguenessVerdict {
  const assumeCoding = opts.assumeCoding !== false
  const deicticsResolvable = opts.deicticsResolvable === true
  const t = String(text ?? '').trim()
  const signals: string[] = []
  const missing: MissingKind[] = []

  const verb = hitVagueVerb(t)
  if (verb) {signals.push(`模糊动词「${verb}」`)}

  const dim = detectDimension(t)
  const rawTarget = hasSpecificTarget(t)
  const deictic = DEICTIC.test(t)
  // 上文已确立锚点时，指代词算作已解析
  const hasTarget = rawTarget || (deictic && deicticsResolvable)
  if (deictic && !rawTarget) {
    signals.push(deicticsResolvable
      ? '有指代词，但上文已确立目标（按已解析处理）'
      : '有指代词但无可解析的具体目标')
  }
  // 【短文本不单独构成模糊】
  // 第一版把「< 8 字」直接判模糊，结果「写个爬虫」这种明确的短命令也被追问。
  // 短只是「信息少」，不等于「目标不清」——必须叠加模糊动词才成立。
  if (isTooShort(t)) {signals.push('输入较短（< 8 字）')}
  const shortAndVague = isTooShort(t) && verb !== null

  // 明确的优化维度 = 用户说了要什么，只是没说对什么做
  if (dim) {
    if (!hasTarget) {missing.push('target')}
  } else if (verb) {
    missing.push('dimension')
  }
  if (!hasTarget && !dim) {missing.push('target')}
  if (verb && !dim) {missing.push('scope')}

  const hasAnyVerb = verb !== null
  const clearlyVague = assumeCoding && hasAnyVerb && !hasTarget

  let level: VaguenessLevel
  if (!assumeCoding) {
    level = 'specific'
  } else if (t.length === 0) {
    // 防御：空输入不是「任务清楚」，是「没收到任务」。当模糊处理最安全。
    level = 'vague'
  } else if (hasTarget && (dim || !hasAnyVerb)) {
    level = 'specific'
  } else if (clearlyVague) {
    level = dim ? 'underdefined' : 'vague'
  } else if (hasAnyVerb) {
    // 有动词无宾语：多半是「优化一下 X」里的 X 省略了
    level = hasTarget ? 'specific' : 'vague'
  } else if (deictic && !deicticsResolvable) {
    // 【无模糊动词但有指代词】
    // 「把这个函数改了」没有「优化」这种歧义词，单靠规则看不出模糊。
    // 但「这个」在拿不到上文时指代空气 —— 问一句的成本远低于赌错方向。
    level = 'underdefined'
  } else if (shortAndVague) {
    level = 'vague'
  } else {
    // 无模糊动词、无未解析指代：任务本身可能是清楚的祈使句（写个爬虫）
    level = 'specific'
  }

  const needsClarification = assumeCoding && (level === 'vague' || level === 'underdefined')

  return {
    level,
    needsClarification,
    signals,
    missing: Array.from(new Set(missing)),
    question: buildQuestion(level, dim),
    options: buildOptions(level, dim),
  }
}

/** 生成问句。刻意用「二选一」而不是开放式提问 —— 开放式提问对弱模型用户负担太重。 */
function buildQuestion(level: VaguenessLevel, dim: string | null): string {
  if (level === 'specific') {return ''}
  if (dim) {
    return `你想优化哪一块的「${dim}」？告诉我具体文件或模块，我先看一眼再动手。`
  }
  return '想先做哪一步？我列几个常见的，你点一个就行。'
}

/**
 * 生成可点选项。
 *
 * 【为什么要给固定选项而不是让模型自由发挥】
 * 弱模型在这里最容易自由发挥成一段「我理解你想做 A、B、C 三个方面」的长文，
 * 用户看完更迷茫。固定选项把决策成本从「写一句话」降到「点一下」，
 * 这对普通用户尤其重要 —— 本项目的目标用户里有大量非开发者。
 */
function buildOptions(level: VaguenessLevel, dim: string | null): string[] {
  if (level === 'specific') {return []}
  if (dim) {
    return [
      `先扫一遍项目，找出${dim}最差的地方给我看（先不改）`,
      `只给我一份${dim}改进建议，我自己决定改不改`,
      `我指定文件，你只改那个（我马上告诉你路径）`,
    ]
  }
  return [
    '先扫一遍项目，把主要问题列出来给我看（先不改任何代码）',
    '只审查不修改：出一份问题清单 + 严重度排序',
    '先做最小可验证的一处改动给我看效果',
    '帮我写一份改进计划，我自己排期',
  ]
}

/**
 * 渲染成可以直接塞进 system prompt 的一段规则。
 *
 * 为什么用 prompt 而不是在代码里硬拦：
 * 硬拦（直接拒绝执行）会让用户在「我只是问个问题」时也被拦，体验更差。
 * 规则式的做法是让模型**先问再动**，而问的内容由本模块算好 —— 模型只负责转述。
 */
export function renderClarificationRule(verdict: VaguenessVerdict): string {
  if (!verdict.needsClarification) {return ''}
  return [
    '## ⚠️ 任务过于模糊 —— 先问，不要直接动手',
    '',
    `判定：${verdict.level === 'vague' ? '连目标都不明确' : '目标明确但缺少范围/维度'}`,
    `信号：${verdict.signals.join('；') || '（无）'}`,
    '',
    '请**先**用这句话问用户：',
    `「${verdict.question}」`,
    '',
    '并给出这些选项让用户点选：',
    ...verdict.options.map((o, i) => `${i + 1}. ${o}`),
    '',
    '规则：',
    '1. **不要**在用户回答前调用任何写文件/执行命令的工具。',
    '2. **不要**猜一个解释然后开干 —— 你猜错的代价比问一句大得多。',
    '3. 用户回答后**立即开始**，不要再确认第二次。',
  ].join('\n')
}
