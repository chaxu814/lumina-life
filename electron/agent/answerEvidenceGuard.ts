// ============================================================
// agent/answerEvidenceGuard.ts — 「无证据的事实断言」兜底（纯函数，可单测）
//
// 【要解决的真实故障】2026-10-11 实测：
//   用户问「使命召唤 23 的发布日期」，检索工具失败/被封后，模型凭记忆编出
//   「Call of Duty: Modern III，2010 年 11 月 9 日」——产品名是编的、日期也是错的，
//   而且用加粗给出了确定语气。用户没有任何线索能察觉这是编的。
//
// 【为什么提示词纪律不够】
//   上一轮已经加了「不要凭记忆猜事实」的纪律，但**纪律只能降低概率，不能根除**。
//   要真正兜住，必须在**代码层**判断「这是事实型问题 + 这次没有检索证据」，
//   然后由代码（而不是模型自觉）给出「未经核实」的标注。
//
// 【设计原则：宁可少报，不要误伤】
//   只在**三个条件同时成立**时才介入：
//     ① 问题是时间敏感 / 需要查证的（不是写作、翻译、算题、闲聊）
//     ② 这次**没有取得检索证据**（没搜过、搜失败、或工具被暂停）
//     ③ 答案里**确实出现了具体断言**（年份/日期/版本号/价格/数量）
//   缺任何一条都不介入 —— 避免给「泰坦尼克号哪年上映」这类稳定知识乱加免责声明。
//
// 【介入方式是「标注」而不是「拦截」】
//   直接删掉答案对用户是有害的（可能删掉正确答案）。所以只在答案前加一行
//   诚实的来源说明，把判断权交回用户。这是安全且有效的做法。
// ============================================================

/** 需要实时/外部信息才能确认的强信号（这些信息"会变"） */
const CURRENT_INFO_SIGNALS: RegExp[] = [
  /最新|最近|近期|现在|目前|如今|当前|今年|本月|本周|昨天|今天|刚刚|刚才/i,
  /新作|新款|新品|新版本|即将|传闻|爆料|官宣|刚发布/i,
]

/** 需要查证的询问（信息可能稳定，也可能变化） */
const LOOKUP_SIGNALS: RegExp[] = [
  /什么时候|何时|哪年|哪一天|几号|几年|发布日期|发行日期|上市时间|发布时间|时间表/i,
  /价格|多少钱|售价|报价|市值|股价|汇率|销量|排名|榜单|排行榜/i,
  /版本号|第几代|配置|参数|规格|型号/i,
  /新闻|公告|更新日志|发生了什么/i,
]

/** 本地任务 / 创作 / 闲聊 —— 命中则不介入（这些不需要"外部证据"） */
const LOCAL_TASK_SIGNALS: RegExp[] = [
  /(帮我|请|给我)?\s*(写|改写|润色|翻译|总结|整理|生成|做一个|做一份|画|设计|拟)/,
  /写个|写一个|写一段|代码|函数|脚本|报错|调试|重构|接口|正则/i,
  /算一下|计算|求解|证明|推导|求值|解方程/i,
  /^(你好|hi|hello|在吗|谢谢|哈哈|早|晚安)/i,
]

/** 答案里的「具体断言」——这些才是编错了会误导用户的东西 */
const SPECIFIC_CLAIM_PATTERNS: RegExp[] = [
  /\b(19|20)\d{2}\s*年/,                          // 2010 年
  /\b(19|20)\d{2}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}/, // 2010-11-09 / 2010年11月9日
  /\d{1,2}\s*月\s*\d{1,2}\s*日/,                    // 11 月 9 日
  /\bv?\d+\.\d+(\.\d+)?\b/,                        // 版本号 v1.2.3 / 2.0
  /第\s*[一二三四五六七八九十\d]+\s*(代|版|季|部|作)/, // 第 3 代
  /[¥$￥]\s*\d/,                                    // 价格
  /\d+(\.\d+)?\s*(万|亿|元|美元|人次|万台|亿美元)/,     // 规模数字
]

export interface FactualQuestionVerdict {
  /** 是否属于「需要外部证据」的问题 */
  needsEvidence: boolean
  /** 命中的原因（可读，用于日志/调试） */
  reasons: string[]
}

/**
 * 判断问题是否需要外部证据（时间敏感 / 需查证），且不是本地任务。
 */
export function assessQuestionEvidenceNeed(text: string): FactualQuestionVerdict {
  const s = String(text || '')
  if (!s.trim()) {return { needsEvidence: false, reasons: [] }}

  // 本地任务优先排除（写作/翻译/算题/闲聊都不需要"外部证据"）
  for (const re of LOCAL_TASK_SIGNALS) {
    if (re.test(s)) {return { needsEvidence: false, reasons: ['本地任务/创作类'] }}
  }

  const reasons: string[] = []
  for (const re of CURRENT_INFO_SIGNALS) { if (re.test(s)) {reasons.push('实时信息') ; break} }
  for (const re of LOOKUP_SIGNALS) { if (re.test(s)) {reasons.push('需查证') ; break} }

  return { needsEvidence: reasons.length > 0, reasons }
}

/** 答案里是否包含具体的、可验证的事实断言 */
export function containsSpecificClaims(answer: string): boolean {
  const s = String(answer || '')
  if (!s.trim()) {return false}
  return SPECIFIC_CLAIM_PATTERNS.some(re => re.test(s))
}

export interface EvidenceGuardInput {
  /** 用户这一轮的问题 */
  question: string
  /** 本轮是否尝试过检索（web_search / web_fetch / browser 等） */
  retrievalAttempted: boolean
  /** 本轮是否**成功**取得过检索结果（非空内容） */
  retrievalSucceeded: boolean
  /** 模型给出的最终答案 */
  answer: string
}

export interface EvidenceGuardDecision {
  /** 是否介入 */
  intervene: boolean
  /** 要加在答案前面的一行说明（intervene 时非空） */
  warning: string
  reasons: string[]
}

/**
 * 未核实答案的统一提示语（放在答案最前面，避免用户被具体数字误导）。
 *
 * 措辞要对「稳定知识」和「会变的信息」都成立 —— 所以不说"实时资料"，
 * 只说"来自既有知识、本轮未检索核实"。
 */
export const UNVERIFIED_WARNING =
  '⚠️ 以下内容来自我的既有知识（本轮未检索核实），涉及的具体日期 / 数字请以官方信息为准：'

/**
 * 决定是否给答案加「未经核实」警示。
 *
 * 三条件同时成立才介入：需要证据 + 无检索证据 + 答案含具体断言。
 */
export function decideEvidenceGuard(input: EvidenceGuardInput): EvidenceGuardDecision {
  const q = assessQuestionEvidenceNeed(input.question)
  const reasons: string[] = []

  if (!q.needsEvidence) {return { intervene: false, warning: '', reasons: ['问题不需要外部证据'] }}
  reasons.push(...q.reasons)

  if (input.retrievalSucceeded) {
    return { intervene: false, warning: '', reasons: [...reasons, '已取得检索证据'] }
  }
  reasons.push(input.retrievalAttempted ? '检索未取得有效结果' : '本轮未检索')

  if (!containsSpecificClaims(input.answer)) {
    return { intervene: false, warning: '', reasons: [...reasons, '答案未含具体断言'] }
  }
  reasons.push('答案含具体事实断言')

  return { intervene: true, warning: UNVERIFIED_WARNING, reasons }
}

/** 便捷封装：把警示拼到答案前（intervene 为 false 时原样返回） */
export function applyEvidenceGuard(input: EvidenceGuardInput): string {
  const d = decideEvidenceGuard(input)
  if (!d.intervene) {return String(input.answer || '')}
  return `${d.warning}\n\n${String(input.answer || '')}`
}

/** 这些工具算「检索」——用来判断本轮有没有尝试取得外部证据 */
export const RETRIEVAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'web_search', 'web_fetch', 'browser', 'browser_cdp', 'deep_research',
  'news_collector', 'content_collector', 'search',
])
