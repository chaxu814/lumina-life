// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// agentCompactor.ts — QwenPaw 风格上下文压缩器 (v9.0)
//
// 从 agentRunner.ts 提取，独立负责：
//   1. 结构化摘要生成（QwenPaw 格式）
//   2. 增量更新已有摘要
//   3. Token 预算检查 + 主动压缩触发
//
// 设计原则（借鉴 QwenPaw LightContextManager）：
//   - 压缩前做 token 预算检查
//   - 用结构化格式保留关键信息（目标、决策、进展）
//   - 保留最近 N 轮完整对话，不压缩
//   - 支持增量更新：已有摘要时追加而非重新生成
// ============================================================

import { TokenEstimator } from './tokenEstimator'
import type { AgentMessage } from './tools/types'

// 辅助：将 content 安全转为字符串
function toText(content: AgentMessage['content']): string {
  if (typeof content === 'string') {return content}
  if (Array.isArray(content)) {
    return content.map(part => part.text || '').join('')
  }
  return ''
}

// ═══════════════════════════════════════════════════════════
//  配置常量
// ═══════════════════════════════════════════════════════════

/** Token 预算默认硬上限（当无法获取模型上下文窗口时的兜底值） */
export const COMPACTOR_TOKEN_BUDGET = 131_072

/** 消息条数上限（v6.0-fix: 从 120 降到 80），配合 65% 的压缩阈值压缩更快生效 */
export const COMPACTOR_MESSAGE_LIMIT = 80

/** 保留的最近完整消息数（增大保留窗口，让 LLM 记得更长期的上下文） */
export const COMPACTOR_RECENT_PAIRS = 50

/**
 * 压缩触发阈值（v6.0-fix: 从 90% 降到 65%）
 *   长上下文下 LLM 推理时间随 token 数非线性增长。
 *   90% 才压缩 → 此时推理已极慢，前端 180s 超时仍可能触发。
 *   65% 压缩 → 在推理变慢前主动瘦身，避免超时。
 */
export const COMPACTOR_TRIGGER_RATIO = 0.65

/**
 * 根据模型上下文窗口计算压缩预算
 *   - 小窗口（≤128K）：用窗口的 65%
 *   - 中窗口（128K-512K）：用窗口的 60%（大窗口留更多余量给生成）
 *   - 大窗口（≥512K）：用窗口的 50%（1M 窗口时 50 万 token 才压缩，充分利用长上下文）
 */
export function getCompactorBudget(contextWindow?: number): number {
  if (!contextWindow || contextWindow <= 0) {return COMPACTOR_TOKEN_BUDGET}
  if (contextWindow <= 131_072) {return Math.floor(contextWindow * COMPACTOR_TRIGGER_RATIO)}
  if (contextWindow <= 524_288) {return Math.floor(contextWindow * 0.60)}
  return Math.floor(contextWindow * 0.50)
}

// ═══════════════════════════════════════════════════════════
//  用户约束抽取
//
//  为什么需要这一块：
//   压缩把早期消息摘要掉之后，最容易「无声丢失」的就是用户在对话中途给出的硬约束
//   （用表格 / 不要用 emoji / 英文回答 / 指定文件路径 / 要保留的数字与版本号 …）。
//   丢一条的直接后果是：用户看到「明明说过却没被执行」的结果，
//   而且模型自己也察觉不到约束已经没了，于是按自己以为的方式作答，事后无从排查。
//   所以这里用针对性规则（而不是靠通用正则碰运气）把约束强制提出来，
//   放到摘要最前面，并配一条「不确定就问用户」的诚实声明兜底。
// ═══════════════════════════════════════════════════════════

/** 每类约束最多保留条数（防止摘要膨胀，反过来挤掉真正需要的上下文） */
export const CONSTRAINT_MAX_PER_CATEGORY = 8

/** 所有类别合计的约束上限 */
export const CONSTRAINT_MAX_TOTAL = 24

/** 单条约束的最大长度：用户消息可能极长，只保留足以表达约束的前半句 */
const CONSTRAINT_MAX_LEN = 100

export type ConstraintCategory = 'negation' | 'memory' | 'format' | 'target' | 'literal'

export interface UserConstraint {
  category: ConstraintCategory
  /** 归一化后的文本（用于去重比较） */
  text: string
}

/** 约束分类的中文标签，同时作为摘要里的分组小标题 */
const CONSTRAINT_CATEGORY_LABELS: Record<ConstraintCategory, string> = {
  negation: '否定 / 禁止',
  format: '输出格式 / 语言',
  target: '文件 / 路径 / 标识符',
  literal: '数字与专有名词',
  memory: '长期记忆 / 身份声明',
}

/** 摘要中各约束分组的展示顺序（与识别优先级一致） */
const CONSTRAINT_CATEGORY_ORDER: ConstraintCategory[] = [
  'negation',
  'format',
  'target',
  'literal',
  'memory',
]

/**
 * ════════════════════════════════════════════════════════════
 *  高精度优先：宁可漏抽，不可误抽（两类错误代价不对称）
 * ════════════════════════════════════════════════════════════
 *   · 漏抽一条约束 → 用户看到「明明说过却没被执行」，代价是一次体验问题；
 *   · 误抽一条约束 → 一条根本不存在的「硬约束」被写进摘要最显眼的位置，
 *     之后每一轮回答都以它为前提推理（"用户要求全英文"其实是助手自己说的话），
 *     错误会自我强化、越滚越歪，事后几乎无法归因。
 * 所以下面每条规则都配了反例，宁可让真实约束漏掉，也不让客套话 / 条件句 / 普通英文单词进表。
 * 实现上用「粗筛正则 + 精筛回调」两层：正则只能挡住字面量，
 * 「不用」在「不用谢」和「不用改」里长得一模一样，区别只在后接的词 —— 这类必须靠回调判断。
 */

/** 中文（CJK 统一表意文字，含扩展 A）字符集：用于判断英文标识符是否嵌在中文语境里 */
const CJK_CLASS = '\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff'
const HAS_CJK = new RegExp(`[${CJK_CLASS}]`)

/** 约束识别规则表。
 *
 * 顺序即优先级：一条句子只归入第一个命中的类别，这样
 * 「不要改 K:\2\app.ts」不会被重复列进「否定」和「文件」两栏（原文已含路径信息）。
 * 顺序与需求清单一致：否定 → 格式 → 文件 → 数字 → 记忆。
 * 「以后都用表格」因此归入"输出格式"（对模型更可执行）而不是"长期记忆"。
 */
interface ConstraintRule {
  category: ConstraintCategory
  /** 粗筛：句中出现候选信号即可，是否真约束交给 accept 判定 */
  re: RegExp
  /** 整句级排除：命中则本条规则整条跳过（用于条件句这种「整句都不是常驻约束」的情况） */
  notRe?: RegExp
  /** 精筛：返回 false = 这次命中是误抽，继续尝试后面的规则 */
  accept?: (sentence: string, m: RegExpExecArray) => boolean
}

// ── 否定类的排除表（误抽重灾区，集中放在这里方便维护） ──────────────

/** 否定词表：命中即强烈暗示「用户在下禁令」 */
const NEGATION_HEAD_RE =
  /(不要|不准|不许|禁止|严禁|不得|不可|不能|不必|别|甭|勿|无需|不用|不需要|没必要|少用|避免|杜绝|去掉|删掉)/
/** 「软」否定词：后面跟人称 / 语气词时通常不是对助手的禁令（"这题不需要你查资料"） */
const NEGATION_SOFT_HEAD_RE = /^(?:不必|别|甭|勿|无需|不用|不需要|没必要|少用)$/
/** 共用客套话后缀：命中即丢弃（"不用谢"、"别急"）。注意不收「太」——"不要太啰嗦"是真约束 */
const NEGATION_POLITE_AFTER_RE = /^(?:谢|谢了|客气|客气话|见怪|多心|多虑|的|了|急)/
/** 只有「别 / 甭 / 勿」才要挡的假否定：别人 / 别处 / 别名（「别+人」是最高频误判） */
const NEGATION_HAIRY_AFTER_RE = /^(?:人|处|名|墅|哭|扭|乡|搁)/
/** 软否定专用的后缀排除：跟的是「委托对象」而不是「被禁动作」 */
const NEGATION_DELEGATE_AFTER_RE = /^(?:你|你们|我|我们|人家|谁)/
/** 「这件事已经做完了」的痕迹：出现它时「不用 X」是在陈述现状，不是在下禁令 */
const DONE_MARKER_RE = /已经|已(?:改|做|完成|处理|修|经)|早就|昨晚|上次|完成|搞定|弄好|改完|做完/
/** 否定词后必须跟一个实词，否则是残句 / 客套（"……不要。"） */
const CONTENT_AFTER_NEGATION_RE = new RegExp(`[${CJK_CLASS}A-Za-z0-9_"'"“”（(【\`]`)

/** 条件句里也会出现否定词，但它不是常驻约束："如果你不用去开会，就……" */
const CONDITIONAL_SENTENCE_RE = /如果|假如|假使|万一|除非|只要|与其|要么/

// ── 格式类的规则片段（按「必须带指示词」拼装，裸词一律不收） ──────────

const FORMAT_PATTERNS: string[] = [
  // 表格：必须带「用/改成/表格形式」这类指示词，裸「表格」不算（"这个表格为空"）
  '(?:做|弄|画|用|以|按|改成|整成|全部|统一)\\s*表格|表格(?:形式|输出|呈现|展示|回答|回复|列出|排列)',
  // 列表 / 分点 / 要点：同理，裸「列表」「要点」都太泛
  '(?:用|以|按|改成|整成|输出)\\s*列表|列表(?:形式|输出|呈现|展示|回答|回复|列出|排列)',
  '(?:分点|分条|逐条|逐点)(?:列出|说明|回答|回复|输出|总结)?',
  '(?:用|以|按|整理成|写成)\\s*要点|要点(?:形式|输出|列出|总结)',
  // 标记语言：必须有「用/输出/格式」或「xxx 格式」这类搭配
  '(?:用|按|转成|改成|输出|返回|以|格式(?:是|为)?)\\s*markdown|markdown\\s*(?:格式|表格|列表|输出)',
  '(?:用|按|转成|改成|输出|返回|以|格式(?:是|为)?)\\s*json|json\\s*(?:格式|输出|返回|对象|数组|模式)',
  '(?:用|按|转成|改成|输出|返回|以|格式(?:是|为)?)\\s*yaml|yaml\\s*(?:格式|输出)',
  // 语言：必须带动词或后缀指示词。「用中文 / 改成英文 / 中文回答」收，裸「这个中文写得不好」不收
  '(?:用|改成|换成|写成|全部|全|统一|回复|回答|输出)\\s*(?:中文|英文)|(?:中文|英文)(?:回答|回复|输出|撰写|表述|说明|解释|交流|沟通|表达)|全中文|全英文',
  // 长度与详略
  '简短|简洁|大段文字|不要(?:太)?长篇|详细(?:回答|说明|解释|介绍|展开|阐述|讲解|一点|些|点)',
  '不超过\\s*\\d+\\s*字|最多\\s*\\d+\\s*字|控制在\\s*\\d+\\s*字|\\d+\\s*字(?:以内|以下)',
]
const FORMAT_RE = new RegExp(FORMAT_PATTERNS.join('|'), 'i')

// ── 文件 / 标识符类 ───────────────────────────────────────────────────

/** 文件名必须带"像文件名的词干"，避免把句号 / 缩写尾巴当成扩展名 */
const TARGET_RE =
  /`[^`]{1,80}`|(?<![\w.\-])[\w\-]{1,40}\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|md|png|jpe?g|svg|gif|webp|vue|css|scss|html?|txt|ya?ml|toml|ini|cfg|sql|csv|log|pdf|docx?|xlsx?|pptx?)\b|[A-Za-z]:\\[^\s"'，,。；;、)）]{1,80}|(?<![\w.])\/(?:[\w\-.]+\/){1,}[\w\-.]*\.[A-Za-z0-9]{1,8}\b|(?<![\w.])\/(?:[\w\-.]+\/){2,}/

/** 反引号里必须"像技术标识符"，整句自然语言被 `` ` `` 包起来不算标识符 */
const BACKTICK_TECH_RE = /[/\\._:]|--?\w|[a-z][A-Z]/
const BACKTICK_CMD_RE = /^[\w@+]+(?:\s+[\w@+#:=]+)*$/

// ── 数字 / 命名类 ────────────────────────────────────────────────────

/** 版本号必须自带 v 前缀、三段式、或处于「版本号/版本是/版本为」的语境里。
 *  "价格是 3.5 元"、"2.0 版本的事情" 这类没有版本语境的小数一律不收。 */
const VERSION_CONTEXT_RE = /版本号|版本\s*(?:是|为|号)|\bversion\b|\bver\b/i
const VERSION_RE = /(?<![\d.])[vV]?\d+(?:\.\d+)+(?:[-.][\w.+-]+)?/
/** 驼峰标识符 / 全大写缩写 / 带单位数字。
 *  驼峰必须"小写段+再来一个大写"，否则 This / Please 这类普通英文单词也会命中。 */
const LITERAL_RE =
  /(?:\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b|\b[A-Z]{2,8}\b)|\d+\s*(?:字|行|px|ms|%|％)/

const CONSTRAINT_RULES: ConstraintRule[] = [
  // 1) 否定 / 限定：用户明令禁止的动作，丢一条就等于直接违反
  {
    category: 'negation',
    re: NEGATION_HEAD_RE,
    // 条件句里的否定是「如果…就…」，不是常驻禁令，整句跳过
    notRe: CONDITIONAL_SENTENCE_RE,
    accept: (sentence, m) => {
      const head = m[1]
      const rest = sentence
        .slice((m.index ?? 0) + m[0].length)
        .replace(/^[\s，,、:：;；]+/, '')
      if (NEGATION_POLITE_AFTER_RE.test(rest)) {return false}
      if (NEGATION_HAIRY_AFTER_RE.test(rest) && /^(?:别|甭|勿|少用)$/.test(head)) {return false}
      if (NEGATION_DELEGATE_AFTER_RE.test(rest) && NEGATION_SOFT_HEAD_RE.test(head)) {return false}
      // 「这个方案不用改，昨晚已经改完了」：软否定 + 已完成痕迹 = 陈述现状，丢弃
      if (NEGATION_SOFT_HEAD_RE.test(head) && DONE_MARKER_RE.test(rest)) {return false}
      return CONTENT_AFTER_NEGATION_RE.test(rest)
    },
  },
  // 2) 输出格式 / 语言：最容易被摘要忽略、又最容易被用户当场察觉
  { category: 'format', re: FORMAT_RE },
  // 3) 文件 / 路径 / 标识符：反引号里的技术标识符、带扩展名的文件名、绝对路径
  {
    category: 'target',
    re: TARGET_RE,
    accept: (_sentence, m) => {
      const token = m[0]
      if (token.charCodeAt(0) !== 0x60) {return true} // 路径 / 扩展名 / 盘符命中，无需再判
      const inner = token.slice(1, -1).trim()
      if (!inner || HAS_CJK.test(inner)) {return false} // 含中文 = 自然语言片段
      if (BACKTICK_TECH_RE.test(inner)) {return true}
      return BACKTICK_CMD_RE.test(inner) // 纯命令行形态，如 `npm run build`
    },
  },
  // 4a) 版本号：单独成条，方便用 accept 卡掉「3.5 元」这类普通小数
  {
    category: 'literal',
    re: VERSION_RE,
    accept: (sentence, m) => {
      const token = m[0]
      if (/^[vV]/.test(token)) {return true}
      if ((token.match(/\./g) ?? []).length >= 2) {return true} // 1.2.3 三段式
      return VERSION_CONTEXT_RE.test(sentence)
    },
  },
  // 4b) 专有名词 / 标识符 / 带单位数字
  {
    category: 'literal',
    re: LITERAL_RE,
    accept: (sentence, m) => {
      const token = m[0]
      if (/^\d/.test(token)) {return true} // 带单位的数字本身就是显式字面量
      if ((m.index ?? 0) === 0) {return false} // 句首大写 = 普通英文单词（Hello World 这类）
      // 紧邻的前一个词也是大写开头 → 属于英文短语，不是命名要求（Hello World / New York）
      const prevWord = sentence.slice(0, m.index ?? 0).match(/([A-Za-z]+)\s*$/)
      if (prevWord && /^[A-Z]/.test(prevWord[1])) {return false}
      return HAS_CJK.test(sentence) // 英文标识符必须嵌在中文语境里
    },
  },
  // 5) 长期记忆：跨轮次持续生效的用户声明（名字、偏好）
  //    「以后」必须紧跟一个指令词，"以后有空再聊" 不算约束
  {
    category: 'memory',
    re: new RegExp(
      [
        '(?:记住|记一下|记下|备注一下)',
        '从今以后|从此以后',
        '(?:以后|往后|今后)(?=\\s*(?:都|统一|默认|一律|所有|请|要|用|输出|回答|回复|保持|记得|不要|别|就))',
        '下次(?:再|记得|一定|务必)',
        '我的名字(?:是|叫|叫做)|我叫|我的称呼(?:是|叫)?|我的偏好|我的习惯',
      ].join('|'),
    ),
  },
]

/** 触发"子串级"去重所需的最小长度：太短的串（如「不要」）容易误杀不同约束 */
const MIN_SUBSTRING_KEY_LEN = 6

/** 把长文本切成句子（用户消息是中文，按中文句读切分最稳） */
function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?；;\n]+/)
    .map(s => s.trim().replace(/^[,，、\s]+/, '').replace(/[、\s]+$/, ''))
    .filter(s => s.length >= 2)
}

/** 归一化用于去重：忽略反引号 / 空白 / 大小写差异 */
function normalizeConstraint(text: string): string {
  return text.replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 返回该句子命中的约束类别；没命中返回 null。
 *
 *  为什么要 accept 回调：粗筛正则只能看字面量，
 *  「不用谢」和「不用改」在正则眼里完全一样，必须靠后接词判真伪。
 *  accept 判否时不立刻放弃，而是继续往下试后续规则 ——
 *  这样"版本号 v9.0"既能命中 literal，也不会让被误判的普通小数占掉这一句。 */
function matchConstraintCategory(sentence: string): ConstraintCategory | null {
  for (const rule of CONSTRAINT_RULES) {
    if (rule.notRe && rule.notRe.test(sentence)) {continue}
    const m = rule.re.exec(sentence)
    if (!m) {continue}
    if (rule.accept && !rule.accept(sentence, m)) {continue}
    return rule.category
  }
  return null
}

/** 截断过长约束，保留表达约束所需的前半句即可 */
function truncateConstraint(text: string): string {
  return text.length <= CONSTRAINT_MAX_LEN ? text : `${text.slice(0, CONSTRAINT_MAX_LEN)}…`
}

export interface ConstraintExtractionOptions {
  /** 每类上限，默认 CONSTRAINT_MAX_PER_CATEGORY */
  maxPerCategory?: number
  /** 总条数上限，默认 CONSTRAINT_MAX_TOTAL */
  maxTotal?: number
}

/**
 * 从「所有」被驱逐的用户消息中抽取硬约束。
 *
 * 为什么是所有而不只是最后几条：约束最常出现在对话中途（用户看到前面几轮答得不对，
 * 就补一句"以后都用表格"），只扫尾部等于漏掉最典型的场景。
 *
 * @param userTexts 被驱逐的用户消息文本（按时间顺序）
 */
export function extractUserConstraints(
  userTexts: string[],
  options: ConstraintExtractionOptions = {},
): UserConstraint[] {
  const maxPerCategory = options.maxPerCategory ?? CONSTRAINT_MAX_PER_CATEGORY
  const maxTotal = options.maxTotal ?? CONSTRAINT_MAX_TOTAL

  const seen = new Set<string>()
  /** 与 result 一一对应的归一化键（子串级去重时需要就地更新） */
  const keys: string[] = []
  const perCategory: Record<ConstraintCategory, number> = {
    negation: 0,
    format: 0,
    target: 0,
    literal: 0,
    memory: 0,
  }
  const result: UserConstraint[] = []

  for (const raw of userTexts) {
    for (const sentence of splitSentences(raw)) {
      if (result.length >= maxTotal) {return result}
      const category = matchConstraintCategory(sentence)
      if (!category) {continue}
      if (perCategory[category] >= maxPerCategory) {continue}
      const key = normalizeConstraint(sentence)
      if (!key || seen.has(key)) {continue}

      // 子串级去重：用户常把同一条约束换个说法再讲一遍（「不要用 emoji」→「另外还是不要用 emoji」），
      // 完全相等去重拦不住。已有更完整表述就丢弃新的；新的更完整则就地升级为新的。
      let supersededByNew = false
      for (let i = 0; i < result.length; i++) {
        if (result[i].category !== category) {continue}
        const existingKey = keys[i]
        if (
          key.length < MIN_SUBSTRING_KEY_LEN ||
          existingKey.length < MIN_SUBSTRING_KEY_LEN
        ) {continue}
        if (key.includes(existingKey)) {supersededByNew = true; break}
        if (existingKey.includes(key)) {
          result[i] = { category, text: truncateConstraint(sentence) }
          keys[i] = key
          seen.delete(existingKey)
          seen.add(key)
          supersededByNew = true
          break
        }
      }
      if (supersededByNew) {continue}

      seen.add(key)
      keys.push(key)
      perCategory[category]++
      result.push({ category, text: truncateConstraint(sentence) })
    }
  }

  return result
}

/** 把约束列表渲染成摘要区块；无约束时返回 null（保持旧摘要结构不变） */
export function formatConstraintBlock(constraints: UserConstraint[]): string | null {
  if (constraints.length === 0) {return null}

  const lines: string[] = [
    '## 🚫 用户明确提出的约束（必须继续遵守）',
    '',
    '> 以下是用户在本轮对话中明确提出的硬性要求。除非用户明确撤销，否则必须原样继续遵守。',
    '> 这部分来自被压缩的早期消息，不得因为"看不见原文"就忽略或自行放宽。',
  ]

  const categories = CONSTRAINT_CATEGORY_ORDER
  for (const category of categories) {
    const items = constraints.filter(c => c.category === category)
    if (items.length === 0) {continue}
    lines.push('', `### ${CONSTRAINT_CATEGORY_LABELS[category]}`)
    items.forEach((c, i) => lines.push(`${i + 1}. ${c.text}`))
  }

  return lines.join('\n')
}

/**
 * 摘要末尾的诚实声明。
 *
 * 为什么必须有：压缩本质上是有损的，光把约束挖出来还不够 ——
 * 摘要里没写到的细节，模型自己是没有察觉的，
 * 于是它会"自信地按自己以为的样子作答"，用户看到的却是"你没听我说过"。
 * 明确告诉模型"不确定就去问"，是把失忆从静默变成可见。
 */
export const SUMMARY_DISCLAIMER = [
  '⚠️ 诚实声明：以上为早期对话的结构化摘要，可能遗漏细节。',
  '如果你发现无法确定用户的某项要求，应当直接向用户确认，而不是假设。',
].join('\n')

// ═══════════════════════════════════════════════════════════
//  结构化摘要
// ═══════════════════════════════════════════════════════════

export interface CompactorSummary {
  /** 结构化摘要文本 */
  text: string
  /** 压缩掉的中间消息数 */
  compressedCount: number
  /** 是否增量更新 */
  isIncremental: boolean
  /** 压缩后的消息数 */
  retainedCount: number
}

/**
 * Scroll 模式选项
 */
export interface ScrollModeOptions {
  /** 是否启用 Scroll 模式（不压缩，仅索引化） */
  enabled?: boolean
  /** 活跃窗口大小（保留最近 N 条消息） */
  windowSize?: number
}

/**
 * 从消息列表中提取结构化摘要（QwenPaw 风格）
 * 
 * 格式：
 *   📋 【对话摘要】
 *   ## 🚫 用户明确提出的约束（必须继续遵守）← 最高优先级，排在所有内容之前
 *   【历史摘要延续】← 仅增量更新时
 *   ## 用户关注
 *   ## 关键决策
 *   ## 涉及的文件
 *   ## 最近回复
 *   ⚠️ 诚实声明（末尾）
 */
export interface StructuredSummaryOptions {
  /** 是否抽取并前置用户硬约束，默认 true */
  keepConstraints?: boolean
  /** 是否追加末尾诚实声明，默认 true */
  disclaimer?: boolean
  /** 约束抽取条数上限覆盖（测试 / 调参用） */
  constraintLimits?: ConstraintExtractionOptions
}

export function buildStructuredSummary(
  systemMsgs: AgentMessage[],
  midMsgs: AgentMessage[],
  existingSummary: string | null,
  options: StructuredSummaryOptions = {},
): string {
  const entries = midMsgs.filter(m => m.role === 'user' || m.role === 'assistant')

  const userAsks: string[] = []
  /** 约束要扫「所有」被驱逐的用户消息（此处不受下面 600 字截断影响）。
   *  只收 user：助手里出现的「不要」「别」「不用」是它在复述/劝阻，不是用户的约束，
   *  混进来会把助手的话升级成"用户硬约束"，正是这一节要防的最坏情况。 */
  const userFullTexts: string[] = []
  const decisions: string[] = []
  const filePaths: string[] = []
  const agentAnswers: string[] = []

  for (const m of entries) {
    const rawText = toText(m.content)
    const content = rawText.slice(0, 600)
    if (m.role === 'user') {
      userAsks.push(content)
      userFullTexts.push(rawText.slice(0, 4000))
    } else if (m.role === 'assistant') {
      agentAnswers.push(content)
      if (/决定|选[择用]|采用|使用|改为|更(新|改)|修复|确定|确认/i.test(content)) {
        decisions.push(content.slice(0, 150))
      }
      const winPaths = content.match(/[A-Z]:\\[^\s,;)]+/g) || []
      const unixPaths = content.match(/\/[^\s,;)]+/g) || []
      const paths = [...winPaths, ...unixPaths]
      if (paths.length > 0) {filePaths.push(...paths)}
    }
  }

  const parts: string[] = ['📋 【对话摘要 — QwenPaw 风格结构化压缩】']

  // 用户硬约束置于所有内容之前：模型读到摘要的第一眼就该看到"必须继续遵守"的清单，
  // 而不是先读一大段叙述再在末尾发现限制条件。
  if (options.keepConstraints !== false) {
    const constraintBlock = formatConstraintBlock(
      extractUserConstraints(userFullTexts, options.constraintLimits),
    )
    if (constraintBlock) {parts.push(`\n${constraintBlock}`)}
  }

  // 已有摘要 → 增量更新
  if (existingSummary) {
    const existingContent = existingSummary
      .replace(/^📋 【对话摘要[^】]*】\n*/, '')
      .replace(/\n【摘要结束】$/, '')
      .trim()
    if (existingContent) {
      parts.push(`\n【历史摘要延续】\n${existingContent}`)
    }
  }

  const recentUserAsks = userAsks.slice(-12)
  const recentAgentAnswers = agentAnswers.slice(-12)

  if (recentUserAsks.length > 0) {
    parts.push(`\n## 用户关注\n${recentUserAsks.map((q, i) => `${i + 1}. ${q}`).join('\n')}`)
  }

  if (decisions.length > 0) {
    const uniqueDecisions = [...new Set(decisions)]
    parts.push(`\n## 关键决策\n${uniqueDecisions.map((d, i) => `- **决策${i + 1}**: ${d}`).join('\n')}`)
  }

  if (filePaths.length > 0) {
    const uniquePaths = [...new Set(filePaths)]
    parts.push(`\n## 涉及的文件\n${uniquePaths.map(p => `- \`${p}\``).join('\n')}`)
  }

  if (recentAgentAnswers.length > 0) {
    parts.push(`\n## 最近回复\n${recentAgentAnswers.map(a => `- ${a.slice(0, 400)}`).join('\n')}`)
  }

  // 声明必须放在【摘要结束】之前：增量更新时靠 /\n【摘要结束】$/ 剥离尾部，位置换了会失效
  if (options.disclaimer !== false) {
    parts.push(`\n${SUMMARY_DISCLAIMER}`)
  }

  parts.push('\n【摘要结束】')
  return parts.join('\n')
}

/**
 * 组装「LLM 压缩」分支的摘要正文。
 *
 * 为什么单独抽一个函数：LLM 压缩与规则压缩最终都要落到 system message 上，
 * 而用户约束 + 防编造声明是**两条分支共同的底线**。
 * 之前这两步只写在规则压缩里，LLM 压缩成功时直接拼裸摘要 ——
 * 结果就是「对话一长就丢约束」：用户中途说的「不要用 emoji / 用表格 / 英文回答」
 * 在触发 LLM 压缩的那一刻突然失效，而且模型自己毫无察觉。
 * 把共用部分抽成函数，两条分支就不可能再各写各的。
 *
 * @param llmSummary LLM 生成的摘要正文
 * @param midMsgs    本次被驱逐（被摘要掉）的中间消息，约束从这里抽取
 */
export function buildLLMCompressedSummary(
  llmSummary: string,
  midMsgs: AgentMessage[],
  options: StructuredSummaryOptions = {},
): string {
  const parts: string[] = ['📋 【对话摘要 — LLM 压缩】']

  if (options.keepConstraints !== false) {
    // 只收 user：助手复述的「不要 / 别」是它在劝阻，不是用户的约束。
    // 单条截 4000 字与规则分支保持一致，防止超长消息把抽取器喂崩。
    const userFullTexts = midMsgs
      .filter(m => m.role === 'user')
      .map(m => toText(m.content).slice(0, 4000))
    const constraintBlock = formatConstraintBlock(
      extractUserConstraints(userFullTexts, options.constraintLimits),
    )
    if (constraintBlock) {parts.push(`\n${constraintBlock}`)}
  }

  parts.push(`\n${llmSummary.trim()}`)

  // 声明必须紧挨在【摘要结束】之前：增量更新时靠 /\n【摘要结束】$/ 剥离尾部
  if (options.disclaimer !== false) {
    parts.push(`\n${SUMMARY_DISCLAIMER}`)
  }

  parts.push('\n【摘要结束】')
  return parts.join('\n')
}

/**
 * Scroll 模式：将超出活跃窗口的消息提取出来，供调用方索引化。
 * 返回 { retained, evicted }，不修改原数组。
 */
export function splitScrollWindow(
  messages: AgentMessage[],
  windowSize = COMPACTOR_RECENT_PAIRS,
): { retained: AgentMessage[]; evicted: AgentMessage[] } {
  if (messages.length <= windowSize) {
    return { retained: messages, evicted: [] }
  }
  return {
    retained: messages.slice(-windowSize),
    evicted: messages.slice(0, messages.length - windowSize),
  }
}

/**
 * 判断是否需要压缩
 * @param estimatedTokens 当前估算的 token 数
 * @param messageCount 当前消息条数
 * @param contextWindow 模型上下文窗口大小（可选，用于动态预算）
 * @returns true = 需要压缩
 */
export function needsCompaction(
  estimatedTokens: number,
  messageCount: number,
  contextWindow?: number,
): boolean {
  const budget = getCompactorBudget(contextWindow)
  if (estimatedTokens >= budget) {
    return true
  }
  if (messageCount >= COMPACTOR_MESSAGE_LIMIT) {
    return true
  }
  return false
}

/**
 * 执行上下文压缩，返回压缩结果
 * 
 * 支持降级：LLM 压缩函数不可用时自动回退到文本截断
 * 
 * @param messages 当前完整的消息列表
 * @param compressedSummary 已有的压缩摘要（可为 null）
 * @param llmCompressFn 可选的 LLM 压缩函数（异步），失败时回退到规则压缩
 * @returns 压缩后的消息列表 + 摘要信息，或 null（不需要压缩）
 */
export async function compactMessagesAsync(
  messages: AgentMessage[],
  compressedSummary: string | null,
  llmCompressFn?: (text: string) => Promise<string>,
): Promise<{
  messages: AgentMessage[]
  summary: CompactorSummary
} | null> {
  const estimator = new TokenEstimator()
  const estimatedTokens = estimator.estimateMessages(messages)

  if (!needsCompaction(estimatedTokens, messages.length) && !compressedSummary) {
    return null
  }

  // 如果有 LLM 压缩函数，尝试 LLM 压缩（可提供更高质量的摘要）
  if (llmCompressFn) {
    try {
      // 尝试 LLM 压缩
      const allContent = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => `[${m.role}]: ${toText(m.content).slice(0, 500)}`)
        .join('\n---\n')
      const llmSummary = await llmCompressFn(allContent)
      if (llmSummary && llmSummary.length > 50) {
        // LLM 压缩成功 — 使用 LLM 生成的摘要，但仍然要过约束抽取 + 诚实声明这一关
        const systemMsgs = messages.filter(m => m.role === 'system')
        const recentMsgs = messages.slice(-COMPACTOR_RECENT_PAIRS)
        const midMsgs = messages.slice(systemMsgs.length, messages.length - COMPACTOR_RECENT_PAIRS)
        const summaryText = buildLLMCompressedSummary(llmSummary, midMsgs)
        return {
          messages: [
            ...systemMsgs,
            { role: 'system', content: summaryText },
            ...recentMsgs,
          ],
          summary: {
            text: summaryText,
            compressedCount: midMsgs.length,
            isIncremental: !!compressedSummary,
            retainedCount: COMPACTOR_RECENT_PAIRS,
          },
        }
      }
    } catch {
      console.warn('[agentCompactor] LLM 压缩失败，回退到规则压缩')
    }
  }

  // 降级：使用规则压缩（同步，无 LLM 调用）
  return compactMessages(messages, compressedSummary)
}

/**
 * 执行上下文压缩，返回压缩结果
 * 
 * @param messages 当前完整的消息列表
 * @param compressedSummary 已有的压缩摘要（可为 null）
 * @returns 压缩后的消息列表 + 摘要信息，或 null（不需要压缩）
 */
export function compactMessages(
  messages: AgentMessage[],
  compressedSummary: string | null,
  // 🔧 P1-4 修正（2026-10-05）：把 contextWindow 传下去。
  //   函数体第 636 行已经在用 getCompactorBudget(contextWindow) 了，
  //   但参数列表里【根本没有这个形参】—— 调用方传不传都拿到 undefined，
  //   于是每次都走 `return COMPACTOR_TOKEN_BUDGET`（131_072）这个硬编码分支。
  //   结果：压缩触发线固定在 131072 × 0.65 ≈ 85K token。
  //
  //   后果：模型真实窗口只有 32K 时，对话在 32K 就溢出了，
  //   而压缩器要到 85K 才会动手 —— 永远不会触发。
  //   修好之后：getCompactorBudget(32768) → 32768 × 0.65 ≈ 21K 就开始压缩。
  //
  //   形参缺省保留 undefined 行为（向后兼容），但调用方 agentRunner 已改为显式传入。
  contextWindow?: number,
): {
  messages: AgentMessage[]
  summary: CompactorSummary
} | null {
  const estimator = new TokenEstimator()
  const estimatedTokens = estimator.estimateMessages(messages)

  if (!needsCompaction(estimatedTokens, messages.length) && !compressedSummary) {
    return null
  }

  const systemMsgs = messages.filter(m => m.role === 'system')

  // 找出旧的压缩摘要
  const existingSummaryIndex = systemMsgs.findIndex(
    m => typeof m.content === 'string' && m.content.startsWith('📋 【对话摘要')
  )
  const existingSummaryInMessages: string | null = existingSummaryIndex >= 0
    ? (systemMsgs[existingSummaryIndex].content as string)
    : null
  const effectiveExistingSummary = compressedSummary || existingSummaryInMessages

  // 保留最近完整消息
  //
  // 🐛 2026-10-10（P2-8）修复：原来直接 `messages.slice(-COMPACTOR_RECENT_PAIRS)`。
  //   当 messages.length ≤ COMPACTOR_RECENT_PAIRS（50）时，这个切片会把**全部**
  //   消息都留下 —— 其中就包含 system 块；而下面 return 时又拼了一次
  //   `cleanedSystemMsgs`，于是系统提示词在结果里出现**两份**。
  //   （触发：Scroll 模式，或恢复路径把 messages 砍到 ~15 条后再次 compactContext。）
  //   修法：recentMsgs 只取非 system —— system 的归属由 cleanedSystemMsgs 统一负责。
  const nonSystemMsgs = messages.filter(m => m.role !== 'system')
  const recentMsgs = nonSystemMsgs.slice(-COMPACTOR_RECENT_PAIRS)

  // 中间消息（需要被压缩的部分）
  const systemEndIndex = systemMsgs.length
  const midMsgs = messages.slice(
    systemEndIndex,
    messages.length - COMPACTOR_RECENT_PAIRS,
  )
  if (midMsgs.length < 3 && !effectiveExistingSummary) {return null}

  // 生成结构化摘要
  const summaryText = buildStructuredSummary(systemMsgs, midMsgs, effectiveExistingSummary)

  // 移除旧的摘要 system message
  const cleanedSystemMsgs = existingSummaryIndex >= 0
    ? [...systemMsgs.slice(0, existingSummaryIndex), ...systemMsgs.slice(existingSummaryIndex + 1)]
    : systemMsgs

  return {
    messages: [
      ...cleanedSystemMsgs,
      { role: 'system', content: summaryText },
      ...recentMsgs,
    ],
    summary: {
      text: summaryText,
      compressedCount: midMsgs.length,
      isIncremental: !!effectiveExistingSummary,
      retainedCount: COMPACTOR_RECENT_PAIRS,
    },
  }
}
