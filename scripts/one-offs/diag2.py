import re, sys
sys.stdout.reconfigure(encoding='utf-8')

with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    text = f.read()

# Find template literals with 热茶 that are corrupted
matches = list(re.finditer(r'热茶.', text))
print(f'Template literals with 热茶: {len(matches)}')
for m in matches[:10]:
    ctx = text[m.start():m.start()+40]
    print(f'  pos={m.start()}: {repr(ctx)}')

# Find all template literals with `?` corruption
bt_matches = list(re.finditer(r'`[^`]*\?[^`]*`', text))
print(f'\nTemplate literals with ?: {len(bt_matches)}')

# Find ALL unterminated strings: lines where a ' or ` or " doesn't have a matching closer
# Simple check: count quotes per line
lines = text.split('\n')
for i, line in enumerate(lines):
    sq = line.count("'")
    dq = line.count('"')
    bt = line.count('`')
    if sq % 2 != 0 or dq % 2 != 0 or bt % 2 != 0:
        print(f'Line {i+1}: unbalanced quotes (sq={sq} dq={dq} bt={bt}): {line[:100]}')
