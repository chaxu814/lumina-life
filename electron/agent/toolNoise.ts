// ============================================================
// agent/toolNoise.ts — 工具调用噪声过滤器（从 agentRunner 抽取，v0.1）
//
// 借鉴 QwenPaw：思考过程（reasoning）与最终回复（reply）严格分离。
// 工具调用信息属于思考面板，不应出现在用户看到的气泡内容中。
// 抽为独立纯模块以便单测与复用，正则与原 agentRunner 内实现保持一致。
// ============================================================

/** 匹配 LLM 在文本中嵌入的工具调用描述 */
export const TOOL_NOISE_PATTERNS: RegExp[] = [
  // "我将使用 web_search 搜索..." 模式
  /(?:我将|我来|我会|让我|我来试试)(?:使用|调用|通过|用)\s*(?:web_search|browser|file_read|file_write|shell_exec|git_\w+|memory_\w+)\s*(?:工具|技能)?[^。！？\n]{0,50}[。！？]?\s*/gi,
  // "<tool_call>...</tool_call>" XML格式
  /<tool_call>[\s\S]*?<\/tool_call>/gi,
  // "让我换个更精准的关键词搜索" 等意图句式（输出的是"我要搜"的描述，不是实际工具调用）
  /(?:让我|我来|我先|我去)\s*换[^。！？\n]{0,50}(?:搜索|查找|查询|检索)[：:：]?\s*/gi,
  // 直接 <web_search>...</web_search> 等工具标记（没有外层 <tool_call>）
  /<(web_search|browser_use|file_read|file_write|shell_exec|memory_save|memory_get)>[\s\S]*?<\/\1>/gi,
  // 括号参数风格 <web_search(query="...")>（兼容未闭合 >）
  /<\w+\s*\([^)]*\)\s*>/gi,
  // 额外防护 — <web_search ...> 等未闭合标签
  /<(\w+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi,
  /<(web_search|browser_use|shell_exec)\s[^>]*>/gi,
  // "正在搜索..." / "正在浏览..." 等中间状态描述
  /(?:正在|开始)\s*(?:搜索|浏览|读取|写入|执行|调用|查询|分析|处理)\s*[。！？\n]?\s*/gi,
  // "搜索结果显示..." / "根据搜索结果..." 元描述
  /(?:根据|基于|按照)\s*(?:搜索结果|Bing搜索|Google搜索|百度搜索|网页内容|浏览结果)\s*[，,]\s*/gi,
  // 孤立的工具名行
  /^\s*(?:web_search|browser_use|file_read|file_write|shell_exec)\s*[：:]\s*$/gim,
]

/**
 * 清理 LLM 输出中的工具调用噪声文本。
 * 这些内容本应由思考面板展示，不应出现在用户可见的气泡中。
 *
 * 🔒 核心不变量：**非空输入永远不返回空串。**
 *
 * 为什么会把这条写在这里：
 * 下游的 agentRunner 有一个「连续空回复」保护——连续 3 轮拿到空内容
 * 就会中断循环、启动恢复流程、最后吐出「抱歉，我暂时无法生成有效回复」。
 * 旧实现在「原文全是 tool_call XML」时直接 return ''，
 * 于是模型这一轮的输出就凭空消失了，
 * 而用户看到的只是一句无法归因的报错。
 *
 * 内容凭空消失是最糟的失败方式：
 *   · 用户无法截图反馈「我发的是这个」
 *   · 开发者无法从日志反推模型到底输出了什么
 *   · 表现为「软件时好时坏」，极难定位
 *
 * 所以现在：整段被删光时，返回一句诚实的说明，
 * 告诉用户「我尝试调用了工具，但没能完成」，
 * 既不污染成 XML 噪音，也不让内容凭空蒸发。
 */
export function cleanToolNoiseText(text: string): string {
  if (!text) {return ''}
  let cleaned = text
  for (const pattern of TOOL_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '')
  }
  // 清理多余的空行（超过 2 个连续换行 → 2 个）
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')
  // 去除首尾空白
  cleaned = cleaned.trim()

  // 兜底一：删得太狠但原文有内容 → 保留原文
  //   防止 TOOL_NOISE_PATTERNS 过度匹配导致合法回复被误删
  if (!cleaned && text.trim()) {
    // 兜底二（v2）：原文是纯工具标记 → **不返回空串**
    //   旧实现在这里 return ''，是「暂时无法生成有效回复」故障的直接成因之一。
    //   现在返回一句说明：既不吐 XML 噪音，也不让内容凭空消失。
    return '（我这轮只输出了工具调用标记，没能给出实际内容。你可以让我再说一次，或换个说法。）'
  }
  return cleaned
}
