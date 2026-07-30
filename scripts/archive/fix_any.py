with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    t = f.read()

# Remove all @ts-ignore comments  
import re
t = re.sub(r'[ \t]*// @ts-ignore\n', '', t)

# Replace ALL useStore.getState().addMessage( with (useStore.getState() as any).addMessage(
t = t.replace('useStore.getState().addMessage(', '(useStore.getState() as any).addMessage(')

# Fix dep array
t = t.replace(', addMessage]', ']')

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(t)
print('done')
