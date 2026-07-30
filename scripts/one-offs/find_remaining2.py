import re, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find all lines with unterminated string issues
# Only check for single and double quotes (backticks can be legit in regex)
unbalanced = []
for i, line in enumerate(lines):
    stripped = line.strip()
    if stripped.startswith('//') or stripped.startswith('*'):
        continue
    sq = line.count("'")
    dq = line.count('"')
    if sq % 2 != 0:
        unbalanced.append((i+1, 'single', sq, stripped[:120]))
    if dq % 2 != 0:
        unbalanced.append((i+1, 'double', dq, stripped[:120]))

print(f'Found {len(unbalanced)} lines with unbalanced quotes:')
for ln, qtype, cnt, txt in unbalanced:
    print(f'  Line {ln}: {qtype} ({cnt}): {txt}')
