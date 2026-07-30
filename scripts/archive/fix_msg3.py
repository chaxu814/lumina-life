with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    t = f.read()

# 1. Remove the broken addMessage line and (useStore.getState() as any).addMessage
t = t.replace(
    "const addMessage = useStore(s => s.addMessage) as any as (convId: string, role: string, content: string) => void\n",
    "const _addMsg = useStore.getState().addMessage\n"
)

# 2. Replace all (useStore.getState() as any).addMessage( back to addMessage(
t = t.replace('(useStore.getState() as any).addMessage(', 'addMessage(')

# 3. Add a local wrapper that calls getState
# The problem: we need the non-hook zustand API. Use getState().
# Replace `addMessage(` with `useStore.getState().addMessage(`
# But we need to make sure `useStore` is imported
# Let me check
t = t.replace('const _addMsg = useStore.getState().addMessage\n', '')

# Pure approach: after the useStore declarations, add a function
# that wraps the store's addMessage properly
# Find where to insert
insert_after = 'const setIsProcessing = useStore(s => s.setIsProcessing)\n'
if insert_after in t:
    helper = '\n  // Wrapper: sidestep zustand selector 1-arg overload\n  const addMessage = (convId: string, role: string, content: string) => {\n    useStore.getState().addMessage(convId, role as any, content)\n  }\n'
    t = t.replace(insert_after, insert_after + helper)

# Fix the `addMessage(` calls that have `(useStore.getState() as any)` prefix still
t = t.replace('(useStore.getState() as any).addMessage(', 'addMessage(')

# Fix dep array references
t = t.replace(', addMessage]', ']')

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(t)
print('done')
