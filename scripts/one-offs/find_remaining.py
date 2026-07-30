import re

with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find all lines with unterminated string issues
# Check for lines where opening/closing quotes (single, double, backtick) are imbalanced
for i, line in enumerate(lines):
    # Skip comments
    stripped = line.strip()
    if stripped.startswith('//') or stripped.startswith('*'):
        continue
    sq = line.count("'")
    dq = line.count('"')
    bt = line.count('`')
    if sq % 2 != 0:
        print(f'Line {i+1}: UNBALANCED single quotes ({sq}): {stripped[:120]}')
    if dq % 2 != 0:
        print(f'Line {i+1}: UNBALANCED double quotes ({dq}): {stripped[:120]}')
    if bt % 2 != 0:
        print(f'Line {i+1}: UNBALANCED backticks ({bt}): {stripped[:120]}')

# Also check for '?' that might be corrupted
print('\n--- Lines with ? in suspicious positions ---')
for i, line in enumerate(lines):
    if '?' in line:
        stripped = line.strip()
        # Only show lines likely corrupted (ignore ternary q-mark)
        if stripped.count('?') > 0 and not ('?' in stripped and stripped.count('?') == 1):
            # Check if ? is inside a string context
            if "'?" in stripped or '"? ' in stripped:
                print(f'Line {i+1}: {stripped[:120]}')
