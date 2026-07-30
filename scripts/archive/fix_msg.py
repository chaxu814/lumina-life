with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    t = f.read()
t = t.replace('addMessage(', 'store.getState().addMessage(')
with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(t)
print('done')
