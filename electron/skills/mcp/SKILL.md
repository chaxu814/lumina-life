# mcp — MCP 服务器工具（动态发现）

MCP（Model Context Protocol）是 QwenPaw 的设计核心：LLM 通过 MCP 协议发现和调用外部工具。
本技能从 `electron/mcpServer.ts` 加载已连接的 MCP 服务器列表，把每台服务器的工具
动态注入到可用工具集。

## 触发条件

以下情况使用 MCP：
- 用户提到“连上 MCP 服务器”、“启动 MCP”
- 用户想用某个外部系统（如 Jira、GitHub、数据库、Slack）但本系统不直接支持
- `electron/mcpServer.ts` 已配置并可用

## 工具列表

通过 MCP 协议动态发现的工具（运行时由 `mcpServer.ts` 注册到 `registry.ts`）。
以下列出常见的 MCP 服务器及其提供的能力：

| 工具名（示例） | 描述 | MCP 服务器 |
|---|---|---|
| `mcp_call` | 调用 MCP 服务器的任意工具 | 任意已连接服务器 |
| `mcp_list_tools` | 列出 MCP 服务器支持的所有工具 | 任意已连接服务器 |
| `mcp_connect` | 手动连接到 MCP 服务器 | mcp 协议 |
| `mcp_disconnect` | 断开 MCP 服务器连接 | mcp 协议 |

## 使用守则

1. **自动发现**——MCP 服务器的工具会在连接后自动注册到 registry，无需手动配置。
2. **优先用 MCP**——如果用户需求匹配 MCP 服务器的能力，优先用 MCP 工具而非自定义实现。
3. **连接前确认**——连接 MCP 服务器前询问用户，特别是涉及企业内网或敏感数据的服务器。
