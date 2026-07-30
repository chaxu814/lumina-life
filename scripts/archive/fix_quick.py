with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    text = f.read()

# Fix ALL '▶,' (bad placeholder from previous fix) → 'x',
text = text.replace("'▶,'", "'x','")

# Fix remaining EMOJI_GROUPS corruption patterns
# The issue: 'x',' should be valid strings
# But we also have legitimate '▶' like in showHistory ternary

# Fix decision context corruption at line 416
# Look for ['?, pattern
text = text.replace("['▶, '", "['是', '")
text = text.replace("['▶, '", "['是', '")  # run twice for multiple matches

# Fix the corrupted arrow in showHistory
text = text.replace("'◀' : '▶'", "'◀' : '▶'")  # already correct now

# Fix line 1461 - title corruption
text = text.replace('title="重命', 'title="重命名"')

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(text)

print('Done')
