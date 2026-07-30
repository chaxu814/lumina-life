import re

with open('src/panels/ChatPanel.tsx', 'rb') as f:
    data = f.read()

lines = data.split(b'\n')
fixed = 0

for i, line in enumerate(lines):
    try:
        decoded = line.decode('utf-8')
        # Check if line contains '?' that's likely corruption in string context
        # Only fix lines inside string literals where '?...' patterns exist
    except:
        pass

# Instead of trying to fix byte-by-byte, let's identify ALL lines with TS errors
# by looking for '?' that appears where a multi-byte UTF-8 char was lost
# Pattern: '?...' where ... is a single quote (string boundary issue)

fixed_lines = []
for i, line in enumerate(lines):
    text = line.decode('utf-8', errors='replace')
    if '\ufffd' in text:
        # Skip - we checked and there are no \ufffd
        fixed_lines.append(line)
        continue
    
    # Fix known corruption patterns by matching the '?' placeholder
    new_text = text
    
    # Fix 1: '🎙?, → '🎙️',
    new_text = new_text.replace("'🎙?,", "'🎙️',")
    # Fix 2: '🕊?, → '🕊️', 
    new_text = new_text.replace("'🕊?,", "'🕊️',")
    # Fix 3: regex corruption （[^）]*?g → （[^）]*）/g
    new_text = new_text.replace("（[^）]*?g", "（[^）]*）/g")
    # Fix 4: 链接 ?保留 → 链接 → 保留
    new_text = new_text.replace("链接 ?保留", "链接 → 保留")
    # Fix 5: 新对? → 新对话
    new_text = new_text.replace("新对?", "新对话")
    # Fix 6: emoji ZWJ: 🐕‍?, → 🐕‍🦺',
    new_text = new_text.replace("🐕‍?,", "🐕‍🦺',")
    # Fix 7: 代码?── → 代码块 ──
    new_text = new_text.replace("代码?", "代码块")
    # Fix 8: 传? → 传递
    new_text = new_text.replace("传?", "传递")
    # Fix 9: 🗂? → 🗂️
    new_text = new_text.replace("🗂?", "🗂️")
    # Fix 10: 聊天面板 ?聊天 → 聊天面板 — 聊天
    new_text = new_text.replace("ChatPanel.tsx ?聊天", "ChatPanel.tsx — 聊天")
    # Fix 11: ═? → ══
    new_text = new_text.replace("═?", "══")
    
    if new_text != text:
        fixed_lines.append(new_text.encode('utf-8'))
        fixed += 1
    else:
        fixed_lines.append(line)

with open('src/panels/ChatPanel.tsx', 'wb') as f:
    f.write(b'\n'.join(fixed_lines))

with open('fix_log.txt', 'w', encoding='utf-8') as log:
    log.write(f'Fixed {fixed} lines\n')
print(f'Fixed {fixed} lines')
