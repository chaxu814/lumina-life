f = open('src/panels/ChatPanel.tsx', 'rb')
data = f.read()
f.close()

# Count corrupted ? positions
text = data.decode('utf-8', errors='replace')
count_fffd = text.count('\ufffd')
count_q = text.count('?')

# Check where 🍵 should be but isn't
import re
# Find template literals containing '热茶'
matches = list(re.finditer(r'热茶.', text))
print(f'Template literals with 热茶: {len(matches)}')
for m in matches[:10]:
    ctx = text[m.start():m.start()+30]
    print(f'  {repr(ctx)}')

# Find all template literals with ? that might be corruption
# (backtick strings with suspicious ? patterns)
bt_matches = list(re.finditer(r'`[^`]*\?[^`]*`', text))
print(f'\nTemplate literals with ?: {len(bt_matches)}')
for m in bt_matches[:10]:
    ctx = text[m.start():min(m.start()+60, m.end())]
    print(f'  {repr(ctx)}')
