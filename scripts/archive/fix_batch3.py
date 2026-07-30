import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    text = f.read()

# Remaining corruptions: fix ALL '? patterns in JSX/string context
fixes = [
    # JSX corruptions — ? where a character should be
    ("已停止'/>}", "已停止</span>}"),
    ("已停止'</span>}", "已停止</span>}"),
    ("已停止'/span>}", "已停止</span>}"),
    ("'条消?", "'条消息'"),  # already fixed
    ("'切换了模?", "'切换了模式'"),
    ("'休息一?\n", "'休息一下。\n"),
    ("'设?Agent", "'设置 Agent'"),
    
    # Double-quote corruptions in JSX attributes
    ('style={{fontSize: 9}} title="已置?>', 'style={{fontSize: 9}} title="已置顶">'),
    
    # Template literal corruptions 
    ("生成代理回复时出?", "生成代理回复时出错"),
    ("未知错?", "未知错误"),
    ("'模?不", "'模式不"),
    ("'群聊模?", "'群聊模式'"),
    
    # More comprehensive: find ALL '??? patterns (corrupted CJK)
    ('回?中...', '回复中...'),
    ('思考中?...', '思考中...'),
    ('执?中...', '执行中...'),
]

count = 0
for old, new in fixes:
    while old in text:
        text = text.replace(old, new)
        count += 1

# Also fix any remaining "<?" patterns in HTML (should be </tag or <tag)
import re
# '<?" ' → '<div '  or similar
# This is tricky

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(text)

print(f'Applied {count} fixes')
