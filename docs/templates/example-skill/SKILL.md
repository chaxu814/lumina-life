# daily-quote 每日一言

一个演示用的最小 Lumina 技能包。它不申请任何权限（无网络、无文件读写），
纯本地计算，每天返回一句格言。

## 工具

- `daily_quote({ mood?: string })` — 返回当天的一言。可选传入 `mood`（如 "tired" / "focus"）调整语气。

## 打包成 .lumina-skill

把本目录三个文件打成 zip，改后缀为 `.lumina-skill`：

```
daily-quote.lumina-skill/
├── skill.json
├── SKILL.md
└── index.js
```

在 Lumina「更多设置 → 技能管理」里选择该文件安装。安装前会自动跑静态扫描 + 权限审批。
