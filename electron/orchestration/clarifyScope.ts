// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// orchestration/clarifyScope.ts — 模糊任务的「先问再做」
//
// 【要解决的问题】
// 上一轮评测里我把「优化一下这个项目」标成了最危险的问法，原因是：
// 它的字面工作量看起来不大（几个字），但实际含义可以是
// 「重命名变量」「重写架构」「补测试」「降依赖体积」—— 方向差十万八千里。
// Agent 会挑一个自己最擅长的去做，做完用户发现不是想要的。
//
// 而这类问题的特点是：**它没有「做错」的时刻，只有「白做」的时刻。**
// 与其让它在错误方向上跑 10 分钟再被否掉，不如先花一句话对齐。
//
// 【为什么不做成 LLM 调用】
// ① 判定「这句话是不是没头没尾」是**词法问题**，不是语义问题：
//    「优化」「一下」「搞搞」这些信号词 + 没有任何具体对象/验收标准，就够了。
// ② 每条消息多一次 LLM 调用会拖慢首字响应，代价不值。
// 所以做成纯规则 + 同步可读的提示语，挂在 system prompt 上。
//
// 【边界很重要 —— 什么时候不要问】
// 问太多和不问一样烦，会把用户逼到放弃。所以刻意保守：
//   · 句子里有**具体对象**（文件名/函数名/行号/URL/报错原文）→ 一律不问
//   · 句子是**纯答疑**（「解释一下」「这什么意思」）→ 一律不问
//   · 只在「动词很泛 + 无具体对象 + 有工作量暗示」时提示
// 这三条都在 tests/clarifyScope.test.ts 里钉死。
// ============================================================

/** 泛动词：只说「做什么」，不说「对什么做」 */
const VAGUE_VERBS = [
  '优化', '改进', '提升', '完善', '搞一下', '搞搞', '弄一下', '弄好', '处理一下', '处理下',
  '整理一下', '整理下', '收拾一下', '看一下', '看看', '分析一下', '评估一下', '审查一下',
  '修一下', '改一下', '调整一下', '优化下', '重构一下', '美化一下', '加强', '增强',
]

/** 有工作量暗示 → 值得先对齐再动手 */
const WORKLOAD_HINTS = [
  '项目', '工程', '代码库', '仓库', '代码', '模块', '系统', '整个', '全部', '整体', '一遍',
]

/** 纯答疑：问了就直接答，不该拦 */
const ANSWER_ONLY = [
  '什么意思', '是什么', '为什么', '怎么理解', '解释一下', '解释下', '有什么区别', '是什么区别',
  '干什么', '做什么', '能干什么', '能做什么', '有没有', '是不是', '什么原理',
]

/** 具体对象信号：出现任一就说明用户已经说清楚了 */
const CONCRETE_SIGNALS = [
  /\.ts\b/, /\.tsx\b/, /\.js\b/, /\.py\b/, /\.json\b/, /\.md\b/, /\.css\b/, /\.html\b/,
  /\.(rs|go|java|kt|c|cpp|h|sh|yml|yaml|toml|sql)\b/i,
  /[A-Za-z_$][\w$]*\s*\(/,          // 函数调用形态  foo()
  /`[^`]+`/,                        // 反引号里的代码片段
  /L\d+:\d+/, /第\s*\d+\s*行/,      // 行号
  /https?:\/\//,                    // 链接
  /error|exception|错误|报错|异常|stack\s*trace/i,
  /[A-Z][a-z]+[A-Z]\w*/,           // 驼峰标识符
]

export type Vagueness = 'clear' | 'vague' | 'answer_only'

export interface ClarityVerdict {
  kind: Vagueness
  /** 给模型看的提示语；clear / answer_only 时为空串（不注入，避免噪音） */
  hint: string
  /** 建议追问的问题（给模型参考，不是硬编码话术） */
  questions: string[]
}

/** 是否含具体对象 */
function hasConcreteObject(text: string): boolean {
  return CONCRETE_SIGNALS.some(re => re.test(text))
}

function normalize(text: string): string {
  return (text || '').trim()
}

/**
 * 判定一句话是不是「该先问再做」。
 *
 * 纯函数、无 IO、可单测。返回的 hint 是**注入给模型的**，不是回给用户的原话 ——
 * 模型应该用它组织自己的语气，而不是照抄。
 */
export function analyzeClarity(userText: string): ClarityVerdict {
  const text = normalize(userText)
  if (!text) { return { kind: 'clear', hint: '', questions: [] } }

  // 1) 纯答疑 —— 永远不问，问了反而是干扰
  if (ANSWER_ONLY.some(k => text.includes(k))) {
    return { kind: 'answer_only', hint: '', questions: [] }
  }

  // 2) 有具体对象 —— 用户已经说清楚了，别啰嗦
  if (hasConcreteObject(text)) {
    return { kind: 'clear', hint: '', questions: [] }
  }

  // 3) 泛动词 + 工作量暗示 → 真正的模糊区
  const hasVagueVerb = VAGUE_VERBS.some(v => text.includes(v))
  const hasWorkload = WORKLOAD_HINTS.some(w => text.includes(w))

  if (!hasVagueVerb || !hasWorkload) {
    return { kind: 'clear', hint: '', questions: [] }
  }

  // 更长的句子通常已经隐含了范围，降低打扰概率
  if (text.length > 40) {
    return { kind: 'clear', hint: '', questions: [] }
  }

  return {
    kind: 'vague',
    hint:
      '⚠️ 用户的诉求偏笼统（「' + text.slice(0, 40) + '」），方向可以差很远：' +
      '重命名 / 重写架构 / 补测试 / 降体积 / 提性能 做的完全是不同的事。' +
      '**先用一两句问清楚再动手**，把范围和验收标准对齐，然后照着做。' +
      '不要默默挑一个自己擅长的方向闷头做——那种「努力」比不做更糟，因为用户没法验收。',
    questions: [
      '你更想解决的是哪一类问题：跑得慢、跑不起来、还是不好维护？',
      '范围大概多大 —— 只动某个文件，还是整个项目都要看？',
      '做到什么程度算完成？有没有可验证的标准（比如「tsc 过了」「测试全绿」）？',
    ],
  }
}
