# code_daily — 代码日报/周报

当用户需要统计某个 Git 仓库的今日/本周代码产出时使用本技能。
通过 `git log` 统计提交数、作者分布与改动文件数，适合下班前汇报或周会复盘。

## 工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `code_daily_generate` | 生成代码日报：统计近 1 天提交数、作者分布、改动文件数。 | `cwd` 仓库绝对路径 |
| `code_daily_weekly` | 生成代码周报：统计近 7 天提交数、作者分布、改动文件数。 | `cwd` 仓库绝对路径 |

## 使用示例

```
用户: "帮我统计一下这个仓库今天写了多少代码"
  → code_daily_generate(cwd="K:/2/Lumina AI")

用户: "出一份本周的代码周报"
  → code_daily_weekly(cwd="K:/2/Lumina AI")
```

## 使用守则

1. **cwd 必须是 Git 仓库**——非 Git 目录会明确报错，不猜测路径。
2. **只读 git log**——本技能只读取历史，不会 commit/push/修改工作区。
3. **提交数过多时截断**——超过 20 条只列前 20 条并提示总数。

## 实现说明

- 用 `child_process.execFile` 调用 `git`（避免 shell 注入，windowsHide=true）。
- 关键命令：
  - `git rev-parse --is-inside-work-tree` 校验仓库
  - `git log --since="1 day ago" --pretty=format:"%h %s (%an)" --no-merges`
  - `git log --since=... --name-only --pretty=format:` 统计改动文件（去重）
- 超时：15 秒；非 git 目录 / 无提交 / git 未安装均有友好错误。
