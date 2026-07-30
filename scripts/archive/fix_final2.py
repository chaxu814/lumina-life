with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    t = f.read()

# Remove the broken addMessage declaration  
t = t.replace("\n  const addMessage = useStore((s) => s.addMessage)\n", "\n")

# Replace addMessage( with useStore.getState().addMessage(
import re
t = re.sub(r'(?<!\.)(?<!const\s)(?<!=\s)addMessage\(', 'useStore.getState().addMessage(', t)

# Fix dep array reference: remove , addMessage
t = t.replace(', addMessage]', ']')

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(t)
print('done')
