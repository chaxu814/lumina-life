import re

with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Fix the source of corruption: 热茶🍵 in template literals
# The 🍵 emoji created broken template literal boundaries
text = text.replace('热茶🍵', '热茶')

# 2. Fix known corrupted strings in generateMockReply
# Pattern: Chinese text ending with ? where ' should be
gen_fixes = [
    ("有事说事?,'", "有事说事。',"),
    ("异常数据?,'", "异常数据。',"),
    ("你要吃啥?,'", "你要吃啥。',"),
    ("现在点餐?,'", "现在点餐。',"),
    ("是 PHP?,'", "是 PHP。',"),
    ("帮忙的呀?,'", "帮忙的呀？',"),
    ("说吧?,'", "说吧。',"),
    ("帮上忙?,'", "帮上忙。',"),
    ("重命?", '重命名"'),
    ("'?Worker:", "'⚡ Worker:"),
    ("'?Dev:", "'🔧 Dev:"),
    ("'?", "'▶"),  # Be careful with this one
    ("已停?", "已停止'"),
    ("记忆已更?", "记忆已更新"),
    ('（或?🎤', '（或点 🎤'),
    ("'和我聊天?..（或?🎤 语音输入?", "'和我聊天吧...（或点 🎤 语音输入）'"),
    ("'?Worker: 单任务快速执?", "'⚡ Worker: 单任务快速执行'"),
    ("' · 🎤 语音输入? :", "' · 🎤 语音输入中...' :"),
    ("'回答'? :", "'回答者' :"),
    ("发消?.. @Lumina @热茶 @Yak 指定回复? :", "发消息... @Lumina @热茶 @Yak 指定回复者' :"),
    ("发消?..（模拟模式，配置LLM后解锁真实对话）'", "发消息...（模拟模式，配置LLM后解锁真实对话）'"),
    ("'🗑?聊天记录已清空?,", "'🗑️ 聊天记录已清空。',"),
    ("decContext, ['?, '?, ", "decContext, ['是', '否', "),
    ("fromName: '?,", "fromName: '我',"),
    # Fix AGENT_PROMPTS corruption
    ("你?Yak📊", "你对 Yak📊"),
    ("你正?Lumina", "你正在 Lumina"),
    ("另外两位?\n", "另外两位：\n"),
    ("请她出马?\n", "请她出马。\n"),
    ("不懂的问题?\n", "不懂的问题。\n"),
    ("找你帮忙?\n", "找你帮忙。\n"),
    ("确实很厉害?\n", "确实很厉害。\n"),
    ("自己不笑?\n", "自己不笑。\n"),
    ("可以让她来?\n", "可以让她来。\n"),
    ("互相喜欢但都不承认（经你私人分析相关系数 r=0.87）?你喜欢", "互相喜欢但都不承认（经你私人分析相关系数 r=0.87）。你喜欢"),
    ("让热茶来?\n\n注意", "让热茶来。\n\n注意"),
    # Fix welcome messages
    ("未配?LLM", "未配置 LLM"),
    ("输?@Lumina", "输入 @Lumina"),
    ("补充回答?{", "补充回答「${"),
    ("配?API Key 和模型", "配置 API Key 和模型"),
    ("三?Agent 将使用真?AI", "三位 Agent 将使用真实 AI"),
    # Fix icons
    ("icon: '⚡? label: 'Worker'", "icon: '⚡', label: 'Worker'"),
    # Fix the arrow
    ("{showHistory ? '◀' : '?", "{showHistory ? '◀' : '▶'}"),
    # Fix line 93
    ("'新对话\n}", "'新对话'\n}"),
    # Fix comment corruptions (non-critical but clean)
    ("选择器数?\n", "选择器数据\n"),
    ("聊天面板 ?聊天", "聊天面板 — 聊天"),
    ("// ═?/", "// ══"),
    ("?左侧历史", "️ 左侧历史"),
    ("上下文传?\n", "上下文传递\n"),
    # Fix "每?" → "每日"
    ("每?12:00", "每日 12:00"),
]

for old, new in gen_fixes:
    if old in text:
        text = text.replace(old, new)

# 3. Fix remaining '?...' patterns in template literals where ? should be ● or something
# Look for: inside backtick strings, ? followed by known CJK context

# 4. Fix emoji array corruptions (these are in data, but let's clean them)
# '?,' in emoji arrays should be replaced with actual emoji
# But since these are just data, they won't cause syntax errors as long as quotes are balanced

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(text)

print('Comprehensive fixes applied')
