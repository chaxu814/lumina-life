with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    t = f.read()

# Fix merged lines
t = t.replace('} else if (result.error) {        useStore', '} else if (result.error) {\n        useStore')
t = t.replace('setAgentEvents([])      useStore', 'setAgentEvents([])\n      useStore')

# Fix corrupted 避?TDZ
t = t.replace('避?TDZ', '避免 TDZ')

# Remove addMessage from dep array
t = t.replace(', addMessage]', ']')

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(t)
print('done')
