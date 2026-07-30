with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    t = f.read()

# Replace `addMessage(` with `(addMessage as any)(` at all call sites
import re
# Match `addMessage(` that is NOT preceded by `const ` or `.`
t = re.sub(r'(?<!\.)(?<!const\s)addMessage\(', '(addMessage as any)(', t)

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(t)
print('done')
