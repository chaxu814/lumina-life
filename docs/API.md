# 🖥️ Lumina Life REST API 文档

> 版本：1.0.0 · 更新：2026-07-28  
> 基础 URL：`http://localhost:3456/api`

Lumina Life 提供完整的 REST API，无需启动 GUI 即可与 Agent 交互、检索记忆、管理工具。

---

## 目录

- [启用 API](#启用-api)
- [认证](#认证)
- [端点一览](#端点一览)
- [端点详情](#端点详情)
  - [健康检查](#1-健康检查)
  - [发送聊天消息](#2-发送聊天消息)
  - [流式聊天](#3-流式聊天)
  - [获取聊天历史](#4-获取聊天历史)
  - [清空聊天历史](#5-清空聊天历史)
  - [执行工具](#6-执行工具)
  - [列出工具](#7-列出工具)
  - [Agent 管理](#8-agent-管理)
  - [记忆检索](#9-记忆检索)
  - [记忆写入](#10-记忆写入)
  - [技能管理](#11-技能管理)
  - [系统诊断](#12-系统诊断)
  - [配置读写](#13-配置读写)
  - [定时任务管理](#14-定时任务管理)
  - [情绪状态](#15-情绪状态)
  - [安全审批](#16-安全审批)
- [错误处理](#错误处理)
- [调用示例](#调用示例)
- [CLI 快捷命令](#cli-快捷命令)

---

## 启用 API

### 启动方式

```bash
# 方式一：CLI 模式启动
lumina api

# 方式二：环境变量
cross-env LUMINA_API_ENABLED=1 LUMINA_API_PORT=3456 npx electron .

# 方式三：npm script
npm run api
```

启动后终端显示：
```
[Lumina API] 服务已启动 → http://localhost:3456/api
[Lumina API] 文档 → http://localhost:3456/api/docs
```

---

## 认证

默认 API 无认证（仅监听 `127.0.0.1`）。生产环境部署建议：

```bash
# 设置 API Key（环境变量）
LUMINA_API_KEY=your-secret-key

# 请求时在 Header 中携带
Authorization: Bearer your-secret-key
```

---

## 端点一览

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 健康检查 |
| `POST` | `/api/chat` | 发送消息（同步） |
| `POST` | `/api/chat/stream` | 流式聊天（SSE） |
| `GET` | `/api/chat/history` | 获取聊天历史 |
| `DELETE` | `/api/chat/history` | 清空聊天历史 |
| `POST` | `/api/tools/execute` | 执行工具 |
| `GET` | `/api/tools` | 列出已注册工具 |
| `GET` | `/api/agents` | 列出所有 Agent |
| `GET` | `/api/agents/:id` | 获取 Agent 详情 |
| `POST` | `/api/memory/search` | 检索记忆 |
| `POST` | `/api/memory/save` | 写入记忆 |
| `GET` | `/api/skills` | 列出技能 |
| `POST` | `/api/skills/install` | 安装技能 |
| `POST` | `/api/skills/uninstall` | 卸载技能 |
| `GET` | `/api/doctor` | 系统诊断 |
| `GET` | `/api/config` | 读取配置 |
| `PUT` | `/api/config` | 更新配置 |
| `GET` | `/api/cron` | 列出定时任务 |
| `POST` | `/api/cron` | 创建定时任务 |
| `DELETE` | `/api/cron/:id` | 删除定时任务 |
| `GET` | `/api/emotion` | 查看当前情绪状态 |
| `GET` | `/api/approval/pending` | 待审批列表 |
| `POST` | `/api/approval/respond` | 响应审批 |

---

## 端点详情

### 1. 健康检查

```
GET /api/health
```

**响应示例：**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 38271,
  "agent_count": 3,
  "tool_count": 88,
  "memory_count": 1247
}
```

### 2. 发送聊天消息

```
POST /api/chat
Content-Type: application/json

{
  "message": "你好 Lumina",
  "agent_id": "lumina",
  "session_id": "optional-session-id"
}
```

**参数说明：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `message` | `string` | ✅ | — | 用户消息内容 |
| `agent_id` | `string` | ❌ | `"lumina"` | 目标 Agent ID |
| `session_id` | `string` | ❌ | 自动生成 | 会话 ID，续接上下文 |

**响应示例：**

```json
{
  "reply": "你好呀！今天有什么想聊的吗？😊",
  "agent_id": "lumina",
  "session_id": "sess_abc123",
  "emotion": "happy",
  "tokens_used": 142
}
```

### 3. 流式聊天

```
POST /api/chat/stream
Content-Type: application/json

{
  "message": "给我讲个故事",
  "agent_id": "lumina"
}
```

**响应：** Server-Sent Events（SSE）

```
event: token
data: {"token": "从前", "done": false}

event: token
data: {"token": "有", "done": false}

event: token
data: {"token": "一座", "done": false}

event: done
data: {"reply": "从前有一座山……", "agent_id": "lumina", "session_id": "sess_abc", "emotion": "thinking"}
```

### 4. 获取聊天历史

```
GET /api/chat/history?session_id=sess_abc123&limit=20&before=msg_xxx
```

**参数说明：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `session_id` | `string` | ❌ | 当前会话 | 会话 ID |
| `limit` | `number` | ❌ | `20` | 返回消息数上限 |
| `before` | `string` | ❌ | — | 分页游标（消息 ID） |

**响应示例：**

```json
{
  "messages": [
    {
      "id": "msg_001",
      "role": "user",
      "content": "你好",
      "timestamp": "2026-07-28T10:00:00Z"
    },
    {
      "id": "msg_002",
      "role": "assistant",
      "content": "你好呀！",
      "emotion": "happy",
      "timestamp": "2026-07-28T10:00:01Z"
    }
  ],
  "has_more": false
}
```

### 5. 清空聊天历史

```
DELETE /api/chat/history?session_id=sess_abc123
```

**响应：**

```json
{
  "status": "ok",
  "deleted_count": 42
}
```

### 6. 执行工具

```
POST /api/tools/execute
Content-Type: application/json

{
  "tool": "web_search",
  "params": {
    "query": "今日新闻"
  }
}
```

**响应示例：**

```json
{
  "status": "success",
  "result": {
    "results": [
      { "title": "...", "url": "...", "snippet": "..." }
    ]
  },
  "duration_ms": 823
}
```

### 7. 列出工具

```
GET /api/tools
```

**响应示例：**

```json
{
  "tools": [
    {
      "name": "web_search",
      "description": "搜索引擎查询",
      "category": "网络",
      "parameters": {
        "query": { "type": "string", "required": true }
      }
    }
  ],
  "total": 88
}
```

### 8. Agent 管理

```
GET /api/agents
```

```json
{
  "agents": [
    {
      "id": "lumina",
      "name": "Lumina 🐱",
      "role": "Boss Agent",
      "status": "online",
      "emotion": "happy",
      "intimacy": 75
    },
    {
      "id": "recha",
      "name": "热茶 🍵",
      "role": "Developer Agent",
      "status": "online",
      "emotion": "calm",
      "intimacy": 60
    },
    {
      "id": "yak",
      "name": "Yak 📊",
      "role": "Analyst Agent",
      "status": "idle",
      "emotion": "neutral",
      "intimacy": 45
    }
  ]
}
```

```
GET /api/agents/:id
```

```json
{
  "id": "lumina",
  "name": "Lumina 🐱",
  "role": "Boss Agent",
  "personality": "温柔细腻的猫娘主理人",
  "status": "online",
  "emotion": {
    "valence": 0.85,
    "arousal": 0.6,
    "dominance": 0.7,
    "current": "happy",
    "intimacy": 75
  },
  "stats": {
    "total_chats": 1523,
    "total_tokens": 284000,
    "sessions_today": 7
  },
  "tools_count": 88,
  "skills_count": 12
}
```

### 9. 记忆检索

```
POST /api/memory/search
Content-Type: application/json

{
  "query": "上次聊的旅行计划",
  "k": 5,
  "agent_id": "lumina"
}
```

**响应示例：**

```json
{
  "results": [
    {
      "id": "mem_001",
      "content": "用户说想去日本看樱花",
      "score": 0.92,
      "timestamp": "2026-07-25T14:30:00Z",
      "source": "chat_history"
    }
  ]
}
```

### 10. 记忆写入

```
POST /api/memory/save
Content-Type: application/json

{
  "content": "用户喜欢猫，养了一只布偶",
  "agent_id": "lumina",
  "importance": 0.7,
  "tags": ["偏好", "宠物"]
}
```

**响应示例：**

```json
{
  "status": "ok",
  "memory_id": "mem_002"
}
```

### 11. 技能管理

```
GET /api/skills
```

```json
{
  "skills": [
    {
      "name": "web_search",
      "version": "1.0.0",
      "enabled": true,
      "description": "联网搜索"
    }
  ],
  "total": 12
}
```

```
POST /api/skills/install
Content-Type: application/json

{
  "source": "store",
  "name": "weather"
}
```

```
POST /api/skills/uninstall
Content-Type: application/json

{
  "name": "old_skill"
}
```

### 12. 系统诊断

```
GET /api/doctor
```

**响应示例：**

```json
{
  "status": "healthy",
  "checks": {
    "node": { "status": "ok", "version": "22.4.0" },
    "electron": { "status": "ok", "version": "40.0.0" },
    "llm": { "status": "ok", "provider": "LM Studio", "latency_ms": 230 },
    "database": { "status": "ok", "path": "~/.lumina/memory.db" },
    "disk": { "status": "ok", "free_gb": 128 },
    "tools": { "status": "ok", "count": 88 }
  }
}
```

### 13. 配置读写

```
GET /api/config
```

```json
{
  "llm": {
    "provider": "lm-studio",
    "baseUrl": "http://127.0.0.1:1234/v1",
    "model": "qwen-2.5-7b"
  },
  "api": {
    "port": 3456,
    "enabled": true
  },
  "language": "zh-CN",
  "theme": "light"
}
```

```
PUT /api/config
Content-Type: application/json

{
  "llm": {
    "model": "qwen-2.5-14b"
  }
}
```

**注意：** 只传递要更新的字段，不会覆盖未提供的字段。

### 14. 定时任务管理

```
GET /api/cron
```

```json
{
  "jobs": [
    {
      "id": "cron_001",
      "name": "早安报道",
      "schedule": "0 8 * * *",
      "agent_id": "lumina",
      "enabled": true,
      "last_run": "2026-07-28T08:00:00Z"
    }
  ]
}
```

```
POST /api/cron
Content-Type: application/json

{
  "name": "每日总结",
  "schedule": "0 22 * * *",
  "agent_id": "lumina",
  "prompt": "总结今天的工作"
}
```

```
DELETE /api/cron/:id
```

### 15. 情绪状态

```
GET /api/emotion
```

```json
{
  "agent_id": "lumina",
  "emotion": "happy",
  "valence": 0.85,
  "arousal": 0.6,
  "dominance": 0.7,
  "intimacy": 75,
  "history": [
    { "emotion": "happy", "timestamp": "2026-07-28T10:00:00Z" },
    { "emotion": "neutral", "timestamp": "2026-07-28T09:00:00Z" }
  ]
}
```

### 16. 安全审批

```
GET /api/approval/pending
```

```json
{
  "pending": [
    {
      "id": "apr_001",
      "tool": "file_write",
      "params": { "path": "/etc/hosts" },
      "risk_level": "high",
      "requested_at": "2026-07-28T10:05:00Z"
    }
  ]
}
```

```
POST /api/approval/respond
Content-Type: application/json

{
  "id": "apr_001",
  "approve": true
}
```

---

## 错误处理

所有端点统一错误格式：

```json
{
  "error": {
    "code": "INVALID_PARAMS",
    "message": "缺少必填参数: message",
    "details": {}
  },
  "status": 400
}
```

**常见错误码：**

| HTTP 状态码 | error.code | 说明 |
|-------------|------------|------|
| 400 | `INVALID_PARAMS` | 参数校验失败 |
| 401 | `UNAUTHORIZED` | API Key 无效 |
| 404 | `NOT_FOUND` | 资源不存在 |
| 429 | `RATE_LIMITED` | 请求过频 |
| 500 | `INTERNAL_ERROR` | 服务器内部错误 |
| 503 | `LLM_UNAVAILABLE` | LLM 服务不可达 |

---

## 调用示例

### curl

```bash
# 健康检查
curl http://localhost:3456/api/health

# 聊天
curl -X POST http://localhost:3456/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你好","agent_id":"lumina"}'

# 检索记忆
curl -X POST http://localhost:3456/api/memory/search \
  -H "Content-Type: application/json" \
  -d '{"query":"旅行计划","k":3}'

# 系统诊断
curl http://localhost:3456/api/doctor
```

### Python

```python
import requests

BASE = "http://localhost:3456/api"

# 健康检查
print(requests.get(f"{BASE}/health").json())

# 聊天
resp = requests.post(f"{BASE}/chat", json={
    "message": "今天心情怎么样？",
    "agent_id": "lumina"
})
print(resp.json()["reply"])

# 流式聊天
import json
resp = requests.post(f"{BASE}/chat/stream", json={
    "message": "讲个故事",
}, stream=True)
for line in resp.iter_lines():
    if line.startswith(b"data: "):
        data = json.loads(line[6:])
        if not data.get("done"):
            print(data["token"], end="", flush=True)
```

### Node.js

```typescript
const API = "http://localhost:3456/api";

// 聊天
const reply = await fetch(`${API}/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "你好", agent_id: "lumina" }),
}).then(r => r.json());

console.log(reply.reply);
```

---

## CLI 快捷命令

常用操作的 CLI 等效命令：

| 操作 | CLI | API |
|------|-----|-----|
| 聊天 | `lumina chat "你好"` | `POST /api/chat` |
| 系统诊断 | `lumina doctor` | `GET /api/doctor` |
| 列出工具 | `lumina tool list` | `GET /api/tools` |
| Agent 状态 | `lumina agent status` | `GET /api/agents` |
| 搜索记忆 | `lumina memory search "关键词"` | `POST /api/memory/search` |
| 列出技能 | `lumina skill list` | `GET /api/skills` |

---

> 有问题或建议？欢迎提交 [GitHub Issue](https://github.com/lumina-life/lumina-life/issues)。
