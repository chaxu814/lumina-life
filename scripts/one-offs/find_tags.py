import re, io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find ALL corrupted closing tags: ?/tag> or ?/tag
# Also: tag starting with ? 
for i, line in enumerate(lines):
    if '?/' in line and not line.strip().startswith('//'):
        print(f'Line {i+1}: CORRUPTED CLOSING TAG: {line.rstrip()[:150]}')
    # Corrupted opening tag: <?tag
    if '<?' in line and not line.strip().startswith('//'):
        # Skip `<?` in template literals
        if not ('`' in line and '<?' in line):
            print(f'Line {i+1}: CORRUPTED OPENING TAG: {line.rstrip()[:150]}')
