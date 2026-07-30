# Lumina 操作知识库 — 命令行操作

## Windows CMD 常用命令

| 命令 | 说明 |
|------|------|
| `dir` | 列出目录 |
| `cd <path>` | 切换目录 |
| `type <file>` | 查看文件内容 |
| `mkdir <dir>` | 创建目录 |
| `del <file>` | 删除文件 |
| `copy <src> <dst>` | 复制文件 |
| `move <src> <dst>` | 移动文件 |
| `tasklist` | 查看进程列表 |
| `taskkill /F /IM <name>` | 强制结束进程 |
| `systeminfo` | 系统信息 |

## 文件管理安全规则
- 删除文件前先确认路径
- 不要操作 C:\Windows 和 C:\Program Files 下的文件
- 使用 `trash` 代替 `del`（如果安装了的话）
- 大文件操作（>100MB）前询问用户
