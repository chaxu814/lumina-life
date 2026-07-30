with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    t = f.read()

# Remove ALL (useStore.getState() as any).addMessage patterns
import re
t = re.sub(r'\(useStore\.getState\(\) as any\)\.addMessage\(', 'addMsg(', t)

# Fix dep array
t = t.replace(', addMessage]', ']')

# Now insert the addMsg wrapper after setIsProcessing line
insert_after = "const setIsProcessing = useStore(s => s.setIsProcessing)\n"
wrapper = "  const addMsg = (...args: any[]) => (useStore.getState() as any).addMessage(...args)\n"
t = t.replace(insert_after, insert_after + wrapper)

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(t)
print('done')
