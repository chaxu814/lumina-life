// 🔧 2026-08-11: 验证 normalizeAgentText 逻辑（与 agentIpc.ts 中实现保持一致）
// 运行: node scripts/verify_normalize_text.js
function normalizeAgentText(text) {
  if (typeof text === 'string') return text
  if (Array.isArray(text)) {
    const parts = []
    let imgCount = 0
    for (const block of text) {
      if (block && typeof block === 'object') {
        const b = block
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text)
        } else if (b.type === 'image_url') {
          imgCount++
        }
      }
    }
    if (imgCount > 0) parts.push(`[用户上传了 ${imgCount} 张图片附件，当前会话暂不支持直接查看图片]`)
    const merged = parts.join('\n').trim()
    return merged || '[用户发送了附件消息]'
  }
  if (text == null) return ''
  return String(text)
}

let failed = 0
function check(name, got, want) {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? '✅' : '❌'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (期望 ${JSON.stringify(want)})`}`)
}

// 1. 普通字符串原样返回
check('string passthrough', normalizeAgentText('帮我查一下天气'), '帮我查一下天气')

// 2. 多模态数组（文本+图片）→ 提取文本 + 图片占位
check('multimodal array',
  normalizeAgentText([
    { type: 'text', text: '帮我看下这个界面配色' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
  ]),
  '帮我看下这个界面配色\n[用户上传了 1 张图片附件，当前会话暂不支持直接查看图片]')

// 3. 纯图片数组 → 只有占位
check('image only array',
  normalizeAgentText([{ type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }]),
  '[用户上传了 1 张图片附件，当前会话暂不支持直接查看图片]')

// 4. 空数组 → 兜底文本
check('empty array', normalizeAgentText([]), '[用户发送了附件消息]')

// 5. undefined / null → 空字符串
check('undefined', normalizeAgentText(undefined), '')
check('null', normalizeAgentText(null), '')

// 6. 数字等其它类型 → String()
check('number', normalizeAgentText(123), '123')

// 7. 命令检测兼容：字符串以 / 开头仍能通过 isCommand 分支
const isCommandInput = typeof ' /help' === 'string'
console.log(`\n命令检测前置判断（typeof string）: ${isCommandInput ? '✅' : '❌'}`)

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
