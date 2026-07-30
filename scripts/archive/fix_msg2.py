with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    t = f.read()

# 1. Fix `const store = useStore` → getState to avoid hook issues
t = t.replace('const store = useStore\n', '// store.getState() used directly where needed\n')

# 2. Fix leftover `addMessage` in dep arrays  
t = t.replace(', addMessage]', ']')
t = t.replace('[addMessage]', '[]')

# 3. Fix `store.getState().addMessage(` calls — the issue is that getState() returns 
#    a state that might have Typed addMessage incorrectly
#    Let me just inline the addMessage implementation directly
#    Actually: let me revert to the 3-arg call but use a helper
#    Replace `store.getState().addMessage(` with a local wrapper

# Actually simplest: use `(useStore.getState() as any).addMessage(` 
t = t.replace('store.getState().addMessage(', '(useStore.getState() as any).addMessage(')
# Double-replace in case some were already prefixed
t = t.replace('(useStore.getState() as any).(useStore.getState() as any).addMessage(', '(useStore.getState() as any).addMessage(')

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(t)
print('done')
