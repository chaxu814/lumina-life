# shell — 终端命令执行

当用户需要运行 Shell 命令、执行脚本、安装包或管理系统时使用本技能。

## 工具

| 工具名 | 描述 |
|--------|------|
| `shell_exec` | 在终端执行命令。可指定 `cwd`、`timeout`。 |

## 使用守则

1. **破坏性命令前先问**——`rm -rf`、`format`、`dd` 等需用户确认。
2. **默认超时 60s**——长时间任务通过 `timeout=` 参数调整。
3. **cd 不持久**——每个 `shell_exec` 是新的 subshell，用 `cwd=` 或 `&&` 链式执行。
4. **Windows** 用 cmd.exe / PowerShell 语法；**Linux/Mac** 用 bash。
