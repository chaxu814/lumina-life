with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    t = f.read()

# Fix dep array 
t = t.replace(', addMessage]', ']')

# Fix merged lines
t = t.replace('}      addMsg', '}\n    addMsg')

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(t)
print('done')
