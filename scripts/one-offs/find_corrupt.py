import re, sys
sys.stdout.reconfigure(encoding='utf-8')

with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    text = f.read()

# Pattern: '? followed by comma, paren, brace, newline = corrupted closing quote
# These should be ' followed by the delimiter
# Example: '嗯。有事说事?, → '嗯。有事说事。',
# Example: '回答'? : → '回答者' :

corruptions = re.findall(r"'[^']*\?[^']*'", text)
print(f'Potentially corrupted single-quoted strings: {len(corruptions)}')
for c in corruptions[:30]:
    if '?' in c and len(c) > 3:
        print(f'  {repr(c)}')

# Also template literals
bt_corruptions = re.findall(r'`[^`]*\?[^`]*`', text)
print(f'\nPotentially corrupted template literals: {len(bt_corruptions)}')
for c in bt_corruptions[:20]:
    if '?' in c:
        print(f'  {repr(c[:100])}')
