f=open('src/panels/ChatPanel.tsx','r',encoding='utf-8')
lines=f.readlines()
f.close()
# Write specific lines to a file to avoid console encoding issues
out=open('debug_lines.txt','w',encoding='utf-8')
for i in [28,29,30,31,42,43,44,92,93,94,100,101,102]:
    out.write(f'=== Line {i+1} ===\n')
    out.write(lines[i])
    out.write('\n')
out.close()
print('Done')
