with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    t = f.read()

# 1. Restore clean addMessage declaration (exactly like App.tsx)
t = t.replace("const addMessage = useStore((s: any) => s.addMessage)", "const addMessage = useStore((s) => s.addMessage)")

# 2. Remove ALL (addMessage as any) prefixes
t = t.replace('(addMessage as any)(', 'addMessage(')

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(t)
print('done')
