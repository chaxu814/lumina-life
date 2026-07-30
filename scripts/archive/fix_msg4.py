with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    t = f.read()

# Replace the wrapper with the direct useStore selector (same as App.tsx does)
# And remove the wrapper
t = t.replace(
    "  // Wrapper: sidestep zustand selector 1-arg overload\n  const addMessage = (convId: string, role: string, content: string) => {\n    useStore.getState().addMessage(convId, role as any, content)\n  }\n",
    "  const addMessage = useStore((s: any) => s.addMessage)\n"
)

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(t)
print('done')
