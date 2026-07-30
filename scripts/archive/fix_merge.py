with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    t = f.read()

# Fix merged lines: `setStreamingText('')          useStore` → separate lines
t = t.replace("setStreamingText('')          useStore", "setStreamingText('')\n          useStore")

# Fix line 1223: check for similar issue
t = t.replace("setIsProcessing(false)\n      // @ts-ignore", "setIsProcessing(false)\n      // @ts-ignore")

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(t)
print('done')
