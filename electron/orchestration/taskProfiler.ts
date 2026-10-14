// ============================================================
// orchestration/taskProfiler.ts — 任务类型识别 · 术有专攻 (v1.0)
//
// 【要解决的问题（用户实测反馈）】
//   用户问一道纯数学/组合概率题：
//     「集合 C={1,2,3,...,13} 子集 N 个元素 不含五个连续整数 概率」
//   结果 Lumina 第一反应是 **web_search**，去 Bing 搜这句话，返回一堆
//   无关的百科页。用户的原话是：
//     「不是自动匹配做什么类型的呢？每次都要搜索或同时使用不相关该类型的工具」
//
// 【根因】
//   ① web_search / web_fetch / browser 属于**常驻核心工具**（永远在 function
//      list 里），模型手里永远有它们；
//   ② 但 system prompt 里**没有任何"按问题类型匹配能力"的规则** ——
//      没有一句话告诉模型「纯推理题不要联网」。于是模型遇到任何问题都可能
//      习惯性地"先搜一下"，哪怕这题它自己完全能算。
//
// 【本模块做什么】
//   一个**纯函数**分类器：把用户这句话判成一个 TaskKind，并给出
//     ① 给 system prompt 的一句话「能力匹配」指引（directive）
//     ② 是否应在**本轮**隐藏联网工具（suppressSearch）
//   它不调 LLM、不碰 Electron 运行时、零依赖 —— 可单测、可复盘、绝不阻塞。
//
// 【与 routingDecider 的分工】
//   routingDecider 回答的是「这活该谁干」（Lumina 自己 / Yak / 热茶）；
//   taskProfiler 回答的是「这活该用什么能力」（推理 / 联网 / 文件 / …）。
//   两者互补：先判类型，再判归属。
//
// 【安全前提：只收紧，不放宽】
//   本模块只在**高置信纯推理**时做一件事：把联网类工具从本轮名单里拿掉。
//   它永远不会"因为判断成某类型就多给工具"——与 emotionGating 同一条铁则。
// ============================================================

export type TaskKind =
  /** 纯推理：数学 / 概率 / 组合 / 证明 / 逻辑 / 算法推导 —— 自己算，别联网 */
  | 'reasoning'
  /** 实时信息：天气 / 新闻 / 股价 / 赛事 / 最新 —— 必须联网 */
  | 'realtime'
  /** 编程：写代码 / 调试 / 重构 */
  | 'coding'
  /** 审查：代码审查 / 挑错 / 风险评估 / 方案权衡 */
  | 'review'
  /** 知识解释：XX 是什么 / 有什么区别 / 解释一下 */
  | 'knowledge'
  /** 写作：写文章 / 报告 / 文案 / 总结 */
  | 'writing'
  /** 文件操作：读/写/整理/查找文件 */
  | 'file'
  /** 闲聊寒暄 */
  | 'chat'
  /** 判不出来 */
  | 'unknown'

export interface TaskProfile {
  kind: TaskKind
  confidence: 'high' | 'low'
  /** 命中的信号标签（可读，供日志与测试） */
  signals: string[]
  /**
   * 注入 system prompt 的一句话能力匹配指引。
   * 空串 = 不注入（闲聊/判不出时，避免污染 prompt）。
   */
  directive: string
  /**
   * 是否在本轮隐藏联网搜索类工具。
   * 仅高置信「纯推理」为 true —— 这是本模块唯一的"收紧"动作。
   */
  suppressSearch: boolean
}

// ═══════════════════════════════════════════════════════════
// 信号词表
// ═══════════════════════════════════════════════════════════

/** 实时/最新信息 —— 命中即「必须联网」，优先级最高 */
const REALTIME_SIGNALS = [
  '最新', '今天', '今日', '现在', '实时', '当前', '目前',
  '新闻', '热搜', '时事', '发生了什么', '发生什么', '刚刚',
  '股价', '行情', '汇率', '涨停', '跌停', '市值', '财报',
  '天气', '气温', '下雨', '台风',
  '几点', '几号', '日期', '星期几', '今天是',
  '谁赢了', '比分', '赛程', '赛事', '比赛结果', '冠军',
  '发布会', '官网', '价格是多少', '多少钱', '报价',
  '最新版本', '新版本', '更新了', '发布了吗',
]

/** 纯推理信号 —— 数学 / 逻辑 / 算法推导 */
const REASONING_SIGNALS = [
  // 概率统计
  '概率', '期望', '方差', '标准差', '分布', '随机', '样本空间', '贝叶斯',
  // 组合数学
  '组合', '排列', '子集', '集合', '容斥', '排列组合', '组合数', '排列数',
  // 数论 / 代数
  '素数', '质数', '因数', '余数', '整除', '同余', '最大公约数', '最小公倍数',
  '方程', '不等式', '解集', '数列', '通项',
  // 证明 / 推导
  '证明', '求证', '推导', '归纳', '逆否', '充分必要', '充要', '悖论', '逻辑推理',
  // 微积分 / 线代
  '导数', '微分', '积分', '极限', '矩阵', '行列式', '向量',
  // 几何
  '几何', '三角形', '面积', '体积', '周长',
  // 算法
  '复杂度', '时间复杂度', '空间复杂度', '递归', '递推', '算法导论',
  // 通用求解动词
  '求解', '求值', '算出', '计算得出', '求极限', '求导', '求积分',
  // 🆕 中文口头数学（用户不会写符号，会说「算一下」「等于多少」「次方」）
  '次方', '平方', '立方', '开方', '开根号', '平方根', '阶乘', '倒数', '绝对值',
  '等于多少', '等于几', '是多少', '多少倍', '几倍', '乘以', '除以', '相加', '相减',
  '算一下', '算一算', '算算', '求和', '加和', '一共有多少', '有多少种',
]

/** 数学符号 —— 与数字同时出现才算强信号（避免误伤「C 盘」「API v={x}」等） */
const MATH_SYMBOLS = ['{', '}', '∑', '∫', '√', 'π', '∈', '∉', '≤', '≥', '≠', '≈', '±', '∞', '·', '^', '%']

/** 明确「要联网」的动作词 —— 命中则撤销 suppressSearch（用户就是要搜） */
const EXPLICIT_SEARCH_VERBS = [
  '搜一下', '搜一搜', '搜索', '上网查', '上网搜', '帮我查', '查一下', '查查',
  '找一下资料', '联网', 'google', '百度一下', 'bing',
]

/** 明确是「知识解释」 */
const KNOWLEDGE_SIGNALS = [
  '是什么', '什么是', '什么叫', '解释一下', '解释下', '定义', '概念',
  '有什么区别', '区别是', '差别', '介绍一下', '科普', '原理是什么',
]

/** 写作类 */
const WRITING_SIGNALS = [
  '写一篇', '写一篇', '写个文案', '写文案', '写报告', '写总结', '帮我写',
  '起草', '润色', '写一封', '写邮件正文', '写篇文章', '撰写',
]

/** 文件操作类 */
const FILE_SIGNALS = [
  '读文件', '打开文件', '保存文件', '这个文件', '文件夹', '目录',
  '整理文件', '删除文件', '重命名', '另存为', 'file_read',
]

/**
 * 强编程信号：动词 + 代码产物的组合（如「写个爬虫」「实现一个接口」）。
 * 命中即**优先判为编程**，避免「写个脚本计算 1+2+…」被 mathy 误判成纯推理。
 */
const STRONG_CODING_RE =
  /(写|生成|产出|实现|开发|编写|建个?|加个?)\s*(一个|个|份|套|段)?\s*[\u4e00-\u9fa5]{0,6}?(代码|脚本|函数|组件|页面|程序|爬虫|接口|API|服务|模块|插件|命令行|工具)/i

/** 编程类词（用于轻量标注，不抢推理/写作的判定） */
const CODING_RE =
  /(代码|脚本|函数|爬虫|接口|API|调试|报错|异常|bug|重构|部署|依赖|数据库|单元测试|写个?程序|编译)/i

/** 审查类词 */
const REVIEW_RE =
  /(审查|review|挑错|挑毛病|漏洞|风险|隐患|评估|权衡|优缺点|该不该|值不值得|复盘|复核)/i

/** 闲聊类（与 toolRouter 的 CHIT_CHAT_HINTS 保持同一口径） */
const CHIT_CHAT_HINTS = [
  '你好', 'hi', 'hello', '嗨', '早上好', '中午好', '晚上好', '早安', '晚安',
  '谢谢', '感谢', '嗯嗯', '哈哈', '哈哈哈', '拜拜', '再见',
  '你在吗', '你在干嘛', '你是谁', '你叫什么', '讲个笑话', '无聊',
]

// ═══════════════════════════════════════════════════════════
// 工具分组（用于 suppressSearch）
// ═══════════════════════════════════════════════════════════

/** 联网搜索类工具 —— 纯推理题本轮隐藏它们 */
export const SEARCH_TOOLS: readonly string[] = ['web_search', 'web_fetch', 'browser']

// ═══════════════════════════════════════════════════════════
// 判定
// ═══════════════════════════════════════════════════════════

function hits(text: string, list: readonly string[]): string[] {
  const out: string[] = []
  for (const k of list) {
    if (text.includes(k.toLowerCase())) {out.push(k)}
  }
  return out
}

/** 是否含数学表达式特征：有数字 + 有数学符号，或数字密度明显偏高 */
function looksMathy(text: string): boolean {
  const hasDigit = /\d/.test(text)
  if (!hasDigit) {return false}
  const hasSymbol = MATH_SYMBOLS.some(s => text.includes(s))
  // 数字+运算符（如 1+2、a=b、x^2）
  const hasOperator = /[+\-*/=^]/.test(text)
  return hasSymbol || hasOperator
}

/**
 * 识别用户问题的类型。
 *
 * 判定顺序（先判"必须联网"的，再判"别联网"的；强编程信号一路优先）：
 *   ① 闲聊（短） → chat
 *   ② 实时信息 → realtime（强制联网）—— 但让位于明确编程请求
 *   ③ 纯推理（推理词 或 数学表达式） → reasoning（隐藏联网工具）
 *   ④ 知识解释 → knowledge
 *   ⑤ 写作（非编程） → writing
 *   ⑥ 文件操作 → file
 *   ⑦ 审查 → review（先于编程，避免"审查代码"被"代码"抢走）
 *   ⑧ 编程 → coding
 *   ⑨ 判不出 → unknown
 */
export function profileTask(input: string): TaskProfile {
  const text = String(input || '').trim()
  if (!text) {
    return { kind: 'unknown', confidence: 'low', signals: [], directive: '', suppressSearch: false }
  }
  const lower = text.toLowerCase()

  // ① 闲聊：最短路径，绝不注入任何指引
  const chatHits = hits(lower, CHIT_CHAT_HINTS)
  if (chatHits.length > 0 && text.length <= 12) {
    return { kind: 'chat', confidence: 'high', signals: chatHits, directive: '', suppressSearch: false }
  }

  const realtimeHits = hits(lower, REALTIME_SIGNALS)
  // 强编程信号优先：「写个爬虫抓取新闻」里的"新闻"是数据目标，不是实时查询，
  // 不能被实时规则抢走。
  const strongCoding = STRONG_CODING_RE.test(text)

  // ② 实时信息 —— 命中即必须联网，优先于推理（但让位于明确的编程请求）
  if (realtimeHits.length > 0 && !strongCoding) {
    return {
      kind: 'realtime',
      confidence: 'high',
      signals: realtimeHits,
      directive:
        '【能力匹配 · 实时信息】这个问题涉及实时/最新信息。请**用 web_search 联网查询**后再回答，' +
        '不要凭训练记忆作答；回复里标注来源（站点名/链接）。',
      suppressSearch: false,
    }
  }

  // ③ 纯推理 —— 这是本次修复的核心。
  //   强编程信号优先：像「写个脚本算 1+2+…」既含数字又含「写」，那是编程不是纯推理。
  const reasonHits = hits(lower, REASONING_SIGNALS)
  const mathy = looksMathy(text)
  const isReasoning = !strongCoding && (reasonHits.length > 0 || mathy)
  if (isReasoning) {
    // 用户显式要求搜索 → 尊重用户，不抑制
    const explicitSearch = hits(lower, EXPLICIT_SEARCH_VERBS)
    const signals = [...reasonHits, ...(mathy ? ['数学表达式'] : [])]
    if (explicitSearch.length > 0) {
      return {
        kind: 'reasoning',
        confidence: 'high',
        signals,
        directive:
          '【能力匹配 · 推理+检索】用户要你查资料/搜索，那就先 web_search，' +
          '但涉及计算与推导的部分必须自己算准，不要照抄搜索结果里的数字。',
        suppressSearch: false,
      }
    }
    // 高置信：有明确推理词，或（数学表达式 + 问题偏短、像是自成一体的题）
    const high = reasonHits.length > 0 || (mathy && text.length <= 200)
    return {
      kind: 'reasoning',
      confidence: high ? 'high' : 'low',
      signals,
      directive:
        '【能力匹配 · 纯推理】这是数学/逻辑/算法推理题。请**直接推理作答，不要调用 web_search / ' +
        'browser 联网搜索** —— 这类问题联网只会返回无关的百科条目，答案必须由你自己推导。' +
        '把关键推理步骤写清楚，最后给出结论。',
      // 只要是推理题（无论置信度）就隐藏联网工具：
      //   推理题的答案只能靠推导，联网几乎永远是错的工具。
      //   用户若明确要搜，上面的 explicitSearch 分支已经提前返回、不抑制。
      suppressSearch: true,
    }
  }

  // ④ 知识解释
  const knowHits = hits(lower, KNOWLEDGE_SIGNALS)
  if (knowHits.length > 0) {
    return {
      kind: 'knowledge',
      confidence: 'high',
      signals: knowHits,
      directive:
        '【能力匹配 · 知识解释】这是概念/知识类问题。**优先用你自己的知识作答**；' +
        '只有当问题涉及「最新版本 / 具体实时数据 / 你不确定的事实」时才联网，并在联网时标注来源。',
      suppressSearch: false,
    }
  }

  // ⑤ 写作 —— 放在编程之前：写作信号更具体，避免「写一篇…文章」被编程的裸「写」抢走。
  //   ⚠️ 但强编程信号要优先：「帮我写一个爬虫脚本」含「帮我写」，那是编程不是写作。
  const writeHits = hits(lower, WRITING_SIGNALS)
  if (!strongCoding && writeHits.length > 0) {
    return {
      kind: 'writing',
      confidence: 'high',
      signals: writeHits,
      directive:
        '【能力匹配 · 写作】这是写作任务：自己起草；长文可让热茶审校。' +
        '除非要引用实时资料，否则不需要联网。',
      suppressSearch: false,
    }
  }

  // ⑥ 文件
  const fileHits = hits(lower, FILE_SIGNALS)
  if (fileHits.length > 0) {
    return {
      kind: 'file',
      confidence: 'high',
      signals: fileHits,
      directive: '【能力匹配 · 文件】这是文件操作：直接用文件工具（file_read/file_edit/file_list 等）。',
      suppressSearch: false,
    }
  }

  // ⑦ 审查 / 编程：交给 routingDecider 的委派规则，这里只给一句轻提示。
  //   审查先判：「审查这段代码的风险」同时含「代码」与「审查」，应归审查而非编程。
  if (REVIEW_RE.test(text)) {
    return {
      kind: 'review',
      confidence: 'low',
      signals: ['审查类词'],
      directive:
        '【能力匹配 · 审查】这是审查/评估类任务：委托热茶（只读审查，带证据与风险分级）。',
      suppressSearch: false,
    }
  }
  if (strongCoding || CODING_RE.test(text)) {
    return {
      kind: 'coding',
      confidence: 'low',
      signals: ['编程类词'],
      directive:
        '【能力匹配 · 编程】这是编程任务：需要动手改代码/调试时，委托 Yak，' +
        '或你自己用 file_read → file_edit → shell_exec 完成并**真实验证**。',
      suppressSearch: false,
    }
  }

  // ⑧ 判不出
  return { kind: 'unknown', confidence: 'low', signals: [], directive: '', suppressSearch: false }
}

/**
 * 「术有专攻」总则 —— 无论本轮判成什么类型，都给模型一张**能力匹配速查表**，
 * 让它在没有精确 directive 时也有据可依。刻意保持精简（约 8 行），避免 prompt 膨胀。
 */
export const CAPABILITY_MATCHING_GUIDE = [
  '## 🎯 能力匹配（术有专攻）',
  '按问题类型选能力，**不要用不相关的工具**：',
  '- 纯推理题（数学/概率/组合/证明/逻辑/算法）→ **自己推理作答，不要联网搜索**（搜索只会返回无关百科页）',
  '- 实时信息（天气/新闻/股价/赛事/最新版本）→ **必须 web_search**，并标注来源',
  '- 概念/知识解释 → 先用你自己的知识答；只有涉及"最新/具体数据/不确定"时才联网',
  '- 写代码/调试/重构 → 委托 Yak，或自己用 file_read→file_edit→shell_exec 并验证',
  '- 审查/挑错/风险评估 → 委托热茶',
  '- 闲聊/寒暄 → 直接聊，不调工具',
  '',
  '**单点打击（重要）**：每次只解决当前这一个问题 ——',
  '· 能靠推理或自身知识解决，就**不要调任何工具**；',
  '· 确需工具时，**只调最相关的那一个**，用完拿到结果就直接作答；',
  '· **不要**为了"保险"把不相关的工具一起调、也不要把整轮工具试一遍。',
  '工具是手段，不是仪式。',
].join('\n')

/**
 * 组装要注入 system prompt 的能力匹配段：
 * 总则 + （有明确类型时）本轮针对性 directive。
 * 闲聊 / 判不出 → 只注入总则（保持行为一致，且不啰嗦）。
 */
export function renderCapabilityMatching(profile: TaskProfile): string {
  const parts = [CAPABILITY_MATCHING_GUIDE]
  if (profile.directive) {
    parts.push('', `**本轮判定：** ${profile.directive}`)
  }
  return parts.join('\n')
}
