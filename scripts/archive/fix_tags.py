with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    text = f.read()

fixes = [
    ("}>?/span>}", "}></span>}"),
    ("}>?/div>", "}></div>"),
    ("我?Lumina，你?AI 桌宠助手?/div>", "我是 Lumina，你的 AI 桌宠助手</div>"),
    ("'rotate(0deg)' }}>?/span>", "'rotate(0deg)' }}></span>"),
    ("'#3b82f6' }}>?/span>}", "'#3b82f6' }}></span>}"),
    ("txt?/div>", "txt</div>"),
    ("支持多?/div>", "支持多种格式</div>"),
    ("单文??0MB", "单文件 ≤10MB"),
]

for old, new in fixes:
    if old in text:
        text = text.replace(old, new)
        print(f'OK: {old[:50]}')
    else:
        print(f'NOT FOUND: {old[:50]}')

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(text)
print('Done')
