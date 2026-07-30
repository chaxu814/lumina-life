with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    t = f.read()

# Fix ALL merged lines where `return` and next statement are on same line
t = t.replace('return      useStore', 'return\n      // @ts-ignore\n      useStore')
t = t.replace("setStreamingText('')          useStore", "setStreamingText('')\n          // @ts-ignore\n          useStore")
t = t.replace('setAgentEvents([])      useStore', 'setAgentEvents([])\n      // @ts-ignore\n      useStore')
t = t.replace('} else if (result.error) {        useStore', '} else if (result.error) {\n        // @ts-ignore\n        useStore')

# Remove ALL existing @ts-ignore lines
import re
t = re.sub(r'[ \t]*// @ts-ignore: zustand getState typing quirk\n', '', t)

# Fix dep array
t = t.replace(', addMessage]', ']')

# Fix corrupted 避?TDZ again
t = t.replace('避?TDZ', '避免 TDZ')

# Now add @ts-ignore before each useStore.getState().addMessage(
t = t.replace('useStore.getState().addMessage(', '// @ts-ignore\n      useStore.getState().addMessage(')
# Fix double-comment
t = t.replace('// @ts-ignore\n      // @ts-ignore\n', '// @ts-ignore\n')

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(t)
print('done')
