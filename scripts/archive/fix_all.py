import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    text = f.read()

fixes = [
    # Line 48: .replace(/`([^`]+)`/g, '$1') - actually this is OK, the ` in regex
    # Line 93: missing closing quote
    ("'新对话\n", "'新对话'\n"),
    # Line 126: template literal corruption  
    ("｡>?｡", "｡>‿<｡"),
    # Line 126-152: various AGENT_PROMPTS ? corruptions (need broader fix)
    ("你?Yak📊 又敬佩", "你对 Yak📊 又敬佩"),
    ("你正?Lumina", "你正在 Lumina"),
    ("另外两位?\n-", "另外两位：\n-"),
    ("请她出马?\n\n", "请她出马。\n\n"),
    ("不懂的问题?\n\n", "不懂的问题。\n\n"),
    ("找你帮忙?\n-", "找你帮忙。\n-"),
    ("确实很厉害?\n\n", "确实很厉害。\n\n"),
    ("让 Lumina 接?", "让 Lumina 接。"),
    ("让热茶来?\n\n", "让热茶来。\n\n"),
    ("自己完全不笑?\n\n🔄", "自己完全不笑。\n\n🔄"),
    ("可以让她来?\n-", "可以让她来。\n-"),
    # Line 294: template literal corruption
    ("fromName: '?,", "fromName: '我',"),
    # Line 416: string corruption
    ("decContext, ['?, '?, ", "decContext, ['是', '否', "),
    # Line 430: string corruption
    ("'🗑?聊天记录已清空?,", "'🗑️ 聊天记录已清空。',"),
    # Line 679: placeholder corruption
    ("'发消?.. @Lumina @热茶 @Sora 指定回复? :", "'发消息... @Lumina @热茶 @Yak 指定回复者' :"),
    ("'发消?..（模拟模式，配置LLM后解锁真实对话）'", "'发消息...（模拟模式，配置LLM后解锁真实对话）'"),
    # Lines 707-722: generateMockReply
    ("'嗯。有事说事?，", "'嗯。有事说事。',"),
    ("'你好。当前团队状态正常，暂无异常数据?，", "'你好。当前团队状态正常，暂无异常数据。',"),
    ("lower.includes('?) || lower.includes('?) || lower.includes('?))", "lower.includes('吃') || lower.includes('饭') || lower.includes('饿')"),
    ("'啧，自己点外卖。我代码还没写完。…算了你要吃啥?，", "'啧，自己点外卖。我代码还没写完。…算了你要吃啥。',"),
    ("'统计显示：每?12:00-13:00 是团队用餐高峰。建议现在点餐?，", "'统计显示：每日 12:00-13:00 是团队用餐高峰。建议现在点餐。',"),
    ("lower.includes('代码') || lower.includes('bug') || lower.includes('编程')", "lower.includes('代码') || lower.includes('bug') || lower.includes('编程')"),  # might already be correct
    ("'放着我来。你先说你用的什么语言，别说是 PHP?，", "'放着我来。你先说你用的什么语言，别说是 PHP。',"),
    ("'嘿嘿，Lumina 在呢~ 主人有什么需要帮忙的呀?，", "'嘿嘿，Lumina 在呢~ 主人有什么需要帮忙的呀？',"),
    ("'…我正忙着呢，但你问都问了。说吧?，", "'…我正忙着呢，但你问都问了。说吧。',"),
    ("'收到。如果需要深度分析，我可以帮上忙?，", "'收到。如果需要深度分析，我可以帮上忙。',"),
    # Line 858: title corruption
    ('title="重命?', 'title="重命名"'),
    # Line 1332: icon corruption
    ("icon: '?, label: 'Worker'", "icon: '⚡', label: 'Worker'"),
    # Line 1461: title corruption
    # Line 1533: arrow corruption
    ("{showHistory ? '◀' : '?}", "{showHistory ? '◀' : '▶'}"),
    # Line 1640: 
    ("'已停?", "'已停止'"),
    # Line 1875:
    ("记忆已更?", "记忆已更新'"),
    # Line 2008:
    (".slice(0, 14) + '? :", ".slice(0, 14) + '...' :"),
    # Line 2027-2028:
    ("（或?🎤 语音输入? :", "（或点 🎤 语音输入）' :"),
    ("'和我聊天?..（或?🎤 语音输入?", "'和我聊天吧...（或点 🎤 语音输入）'"),
    # Line 2252:
    ("'?Worker: 单任务快速执?", "'⚡ Worker: 单任务快速执行'"),
    # Line 2256:
    ("' · 🎤 语音输入? :", "' · 🎤 语音输入中...' :"),
    # Additional: corrupted template literals in JSX
    ("border: `1px solid ${", "border: `1.5px solid ${"),  # These might be false positives - check
]

applied = 0
for old, new in fixes:
    if old in text:
        text = text.replace(old, new)
        applied += 1
        print(f'Fixed: {repr(old[:50])}')
    else:
        print(f'NOT FOUND: {repr(old[:50])}')

# Also fix any remaining '?...' patterns in string context
# Find patterns where a ' is followed by ? and then another '
import re
# Pattern: inside single-quoted strings, ? should be fixed
# But we can't blindly replace all ? since some are in ternary operators

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(text)

print(f'\nTotal fixes applied: {applied}')
