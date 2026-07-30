// tests/toolNoiseFilter.test.ts — AgentRunner 工具调用噪声过滤器测试
// 验证 stripFillerText / TOOL_NOISE_PATTERNS 等后处理逻辑
import { describe, it, expect } from 'vitest'

// 从 agentRunner 复制 TOOL_NOISE_PATTERNS 的定义进行测试
// 实际运行时这些正则表达式用于过滤 LLM 输出的工具调用描述文字
const TOOL_NOISE_PATTERNS = [
  /(?:我将|我来|我会|让我|我来试试)(?:使用|调用|通过|用)\s*(?:web_search|browser|file_read|file_write|shell_exec|git_\w+|memory_\w+)\s*(?:工具|技能)?[^。！？\n]{0,50}[。！？]?\s*/gi,
  /<tool_call>[\s\S]*?<\/tool_call>/gi,
  /<(web_search|browser_use|file_read|file_write|shell_exec|memory_save|memory_get)>[\s\S]*?<\/\1>/gi,
  /(?:正在|开始)\s*(?:搜索|浏览|读取|写入|执行|调用|查询|分析|处理)\s*[。！？\n]?\s*/gi,
  /(?:根据|基于|按照)\s*(?:搜索结果|Bing搜索|Google搜索|百度搜索|网页内容|浏览结果)\s*[，,]\s*/gi,
  /^\s*(?:web_search|browser_use|file_read|file_write|shell_exec)\s*[：:]\s*$/gim,
]

/**
 * 模拟 stripFillerText 的剥除逻辑
 */
function stripToolNoise(text: string): string {
  let result = text
  let prev: string
  do {
    prev = result
    for (const pattern of TOOL_NOISE_PATTERNS) {
      result = result.replace(pattern, '')
    }
  } while (result !== prev)
  return result.trim()
}

const FILLER_PATTERNS = [
  /还有什么想问的吗\s*[？?！!\s]*$/,
  /有什么我可以(?:继续|再|还)帮你的吗\s*[？?！!\s]*$/,
  /有什么其他问题吗\s*[？?！!\s]*$/,
  /^好的[，,]\s*/,
  /^好的[！!]\s*/,
  /^当然[，,]\s*/,
  /^没问题[，,]\s*/,
  /^让我(?:来|看看|帮你|为您).{0,30}[：:]\s*/,
]

function stripFillerText(text: string): string {
  let result = text.trim()
  for (const pattern of FILLER_PATTERNS) {
    result = result.replace(pattern, '')
  }
  return result.trim()
}

describe('Tool noise filter', () => {
  it('removes "我将使用 web_search 搜索" patterns', () => {
    const text = '我将使用 web_search 搜索最新的 AI 新闻。然后我再来回答你。'
    const cleaned = stripToolNoise(text)
    expect(cleaned).not.toContain('web_search')
    expect(cleaned).toContain('然后我再来回答你')
  })

  it('removes <tool_call> XML blocks', () => {
    const text = '我来查一下。<tool_call>\n<function=browser>\n<parameter=action>snapshot</parameter>\n</function>\n</tool_call>\n根据结果，答案是 42。'
    const cleaned = stripToolNoise(text)
    expect(cleaned).not.toContain('<tool_call>')
    expect(cleaned).toContain('答案是 42')
  })

  it('removes "正在搜索..." mid-status text', () => {
    const text = '正在搜索。这是结果：xxx'
    const cleaned = stripToolNoise(text)
    expect(cleaned).toBe('这是结果：xxx')
  })

  it('removes "根据搜索结果" meta descriptions', () => {
    const text = '根据搜索结果，今天的天气是晴天。'
    const cleaned = stripToolNoise(text)
    expect(cleaned).toBe('今天的天气是晴天。')
  })

  it('removes standalone tool name lines', () => {
    const text = 'web_search：\nfile_read：\n结果如上。'
    const cleaned = stripToolNoise(text)
    expect(cleaned).toBe('结果如上。')
  })

  it('handles multiple nested noise patterns', () => {
    const text = '让我用 web_search 查一下。<tool_call><function=web_search><parameter=query>test</parameter></function></tool_call>根据搜索结果，答案是 42。'
    const cleaned = stripToolNoise(text)
    expect(cleaned).not.toContain('<tool_call>')
    expect(cleaned).not.toContain('web_search')
    expect(cleaned).not.toContain('根据搜索结果')
    // 可能只剩下 "答案是 42。"
    expect(cleaned).toContain('答案是 42')
  })

  it('does not remove normal user text', () => {
    const text = '我想让你帮我写一个网页爬虫'
    expect(stripToolNoise(text)).toBe(text)
  })
})

describe('Filler text filter', () => {
  it('removes "还有什么想问的吗" at end', () => {
    expect(stripFillerText('以上就是答案。还有什么想问的吗？')).toBe('以上就是答案。')
  })

  it('removes "有什么我可以帮你的吗" at end', () => {
    expect(stripFillerText('已修复完成。有什么我可以再帮你的吗？')).toBe('已修复完成。')
  })

  it('removes leading "好的，"', () => {
    expect(stripFillerText('好的，我来帮你查一下。')).toBe('我来帮你查一下。')
  })

  it('removes leading "让我来"', () => {
    expect(stripFillerText('让我来看看这个代码：')).toBe('这个代码：')
  })

  it('does not modify clean text', () => {
    const text = '这个 bug 的原因是变量未初始化。已修复。'
    expect(stripFillerText(text)).toBe(text)
  })
})
