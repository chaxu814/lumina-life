with open('src/panels/ChatPanel.tsx', 'r', encoding='utf-8') as f:
    text = f.read()

# Fix ALL '▶,' patterns (broken placeholder from previous fix) → closed string
text = text.replace("'▶,'", "'●','")

# Fix the '☀?] corruption
text = text.replace("'☀?]", "'☀️']")

# Fix AGENT_PROMPTS template literal corruptions
prompt_fixes = [
    ("暗?热茶", "暗恋热茶"),
    ("她太理性?\n", "她太理性。\n"),
    ("凌晨?\n", "凌晨。\n"),
    ("让热茶来?\n\n注意", "让热茶来。\n\n注意"),
    ("说「Sora，该你了」?\n", "说「Sora，该你了」。\n"),
    ("互相喜欢但都不承认（经你私人分析相关系数 r=0.87）?你喜欢", "互相喜欢但都不承认（经你私人分析相关系数 r=0.87）。你喜欢"),
    ("配合度极高?\n", "配合度极高。\n"),
    ("这个建?Lumina", "这个建议让 Lumina"),
    ("她的专长是数据分析」，然后 Lumina 接上。编程细节让 热茶 来?", "她的专长是数据分析」，然后 Lumina 接上。编程细节让热茶来。"),
    ("让热茶来?\n\n注意：回复冷静", "让热茶来。\n\n注意：回复冷静"),
]

for old, new in prompt_fixes:
    if old in text:
        text = text.replace(old, new)

with open('src/panels/ChatPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(text)

print('Fixed AGENT_PROMPTS and ▶ placeholders')
