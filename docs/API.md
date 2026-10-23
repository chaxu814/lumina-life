# 🖥️ Lumina Life REST API Reference

> Version: 1.0.0 · Updated: 2026-07-28
> Base URL: `http://localhost:3456/api`

Lumina Life ships with a full REST API so you can talk to Agents, search memory, and manage tools without launching the GUI.

---

## Table of Contents

- [Enable the API](#enable-the-api)
- [Authentication](#authentication)
- [CORS and Security](#cors-and-security)
- [Endpoints Overview](#endpoints-overview)
- [Endpoint Details](#endpoint-details)
  - [Health Check](#1-health-check)
  - [Send a Chat Message](#2-send-a-chat-message)
  - [Streaming Chat](#3-streaming-chat)
  - [Get Chat History](#4-get-chat-history)
  - [Clear Chat History](#5-clear-chat-history)
  - [Execute a Tool](#6-execute-a-tool)
  - [List Tools](#7-list-tools)
  - [Agent Management](#8-agent-management)
  - [Memory Search](#9-memory-search)
  - [Write to Memory](#10-write-to-memory)
  - [Skill Management](#11-skill-management)
  - [System Diagnostics](#12-system-diagnostics)
  - [Read and Write Config](#13-read-and-write-config)
  - [Cron Job Management](#14-cron-job-management)
  - [Emotion State](#15-emotion-state)
  - [Security Approval](#16-security-approval)
- [Error Handling](#error-handling)
- [Examples](#examples)
- [CLI Shortcuts](#cli-shortcuts)

---

## Enable the API

### How to start

```bash
# Option 1: start in CLI mode
lumina api

# Option 2: environment variables
cross-env LUMINA_API_ENABLED=1 LUMINA_API_PORT=3456 npx electron .

# Option 3: npm script
npm run api
```

On startup the terminal prints:
```
[Lumina API] Service started → http://localhost:3456/api
[Lumina API] Docs → http://localhost:3456/api/docs
```

---

## Authentication

The API binds to the loopback address `127.0.0.1` by default, so **only local processes can reach it**, and auth is off by default.
Once you change the listen address to `0.0.0.0` or expose the API to a LAN / public network, **always set an Access Token at the same time**.

### Set an Access Token

Set `LUMINA_API_KEY` in `.env` (use a long random string):

```bash
LUMINA_API_KEY=your-random-secret-token
```

On startup the log shows `🔑 API key authentication enabled`. After that, every request must carry the credential, or you get `401`:

```http
# Option 1: X-API-Key header
X-API-Key: your-random-secret-token

# Option 2: Bearer token
Authorization: Bearer your-random-secret-token
```

### Send the token with curl

```bash
curl http://localhost:3456/api/health -H "X-API-Key: your-random-secret-token"
```

---

## CORS and Security

### Localhost only by default

- The service listens on `127.0.0.1` by default (configurable via `LUMINA_API_HOST`); **neither LAN nor public networks can reach it directly**.
- The CORS allowlist only permits local origins:
  `http://127.0.0.1:<port>` and `http://localhost:<port>`.
- **Requests with no Origin** (`curl`, CLI scripts, desktop clients) are not subject to CORS and pass through — this is intentional so local automation works smoothly.

### Browser Cross-Origin Behavior

| Request Origin | `Access-Control-Allow-Origin` in response | Browser result |
|----------------|------------------------------------------|----------------|
| `http://localhost:3456` (allowlisted) | Echoes back `http://localhost:3456` (+ `Vary: Origin`) | ✅ allowed |
| `http://localhost:5173` (unconfigured local frontend) | Header omitted | ❌ blocked |
| `http://evil.example.com` (external site) | Header omitted | ❌ blocked |
| No Origin (curl / CLI) | Header not set | ✅ not subject to CORS |

To let your own local frontend (e.g. Vite's `http://localhost:5173`) call the API, add its origin to the allowlist in `.env`:

```bash
LUMINA_API_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:3456
```

Setting `LUMINA_API_ALLOWED_ORIGINS=*` opens it up to every origin — **only do this on a network you fully trust**.

### ⚠️ Risk of exposing to LAN / public network

After changing `LUMINA_API_HOST` to `0.0.0.0`, anyone who can reach that port can:
- make your Agents execute tools, read and write memory and config;
- trigger cron jobs and call the LLM (incurring cost).

Therefore:
1. **Always** set a strong random `LUMINA_API_KEY`;
2. Prefer a reverse proxy + HTTPS over exposing it directly;
3. Don't use `*` in `LUMINA_API_ALLOWED_ORIGINS` unless necessary;
4. Turn it off when done (`LUMINA_API_ENABLED=0`).

---

## Endpoints Overview

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/chat` | Send a message (synchronous) |
| `POST` | `/api/chat/stream` | Streaming chat (SSE) |
| `GET` | `/api/chat/history` | Get chat history |
| `DELETE` | `/api/chat/history` | Clear chat history |
| `POST` | `/api/tools/execute` | Execute a tool |
| `GET` | `/api/tools` | List registered tools |
| `GET` | `/api/agents` | List all Agents |
| `GET` | `/api/agents/:id` | Get Agent details |
| `POST` | `/api/memory/search` | Search memory |
| `POST` | `/api/memory/save` | Write to memory |
| `GET` | `/api/skills` | List skills |
| `POST` | `/api/skills/install` | Install a skill |
| `POST` | `/api/skills/uninstall` | Uninstall a skill |
| `GET` | `/api/doctor` | System diagnostics |
| `GET` | `/api/config` | Read config |
| `PUT` | `/api/config` | Update config |
| `GET` | `/api/cron` | List cron jobs |
| `POST` | `/api/cron` | Create a cron job |
| `DELETE` | `/api/cron/:id` | Delete a cron job |
| `GET` | `/api/emotion` | Current emotion state |
| `GET` | `/api/approval/pending` | Pending approvals |
| `POST` | `/api/approval/respond` | Respond to an approval |

---

## Endpoint Details

### 1. Health Check

```
GET /api/health
```

**Response example:**

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

### 2. Send a Chat Message

```
POST /api/chat
Content-Type: application/json

{
  "message": "Hello Lumina",
  "agent_id": "lumina",
  "session_id": "optional-session-id"
}
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | `string` | ✅ | — | User message content |
| `agent_id` | `string` | ❌ | `"lumina"` | Target Agent ID |
| `session_id` | `string` | ❌ | auto-generated | Session ID to continue context |

**Response example:**

```json
{
  "reply": "Hi there! Anything you'd like to chat about today? 😊",
  "agent_id": "lumina",
  "session_id": "sess_abc123",
  "emotion": "happy",
  "tokens_used": 142
}
```

### 3. Streaming Chat

```
POST /api/chat/stream
Content-Type: application/json

{
  "message": "Tell me a story",
  "agent_id": "lumina"
}
```

**Response:** Server-Sent Events (SSE)

```
event: token
data: {"token": "Once", "done": false}

event: token
data: {"token": "upon", "done": false}

event: token
data: {"token": "a time", "done": false}

event: done
data: {"reply": "Once upon a time there was a mountain...", "agent_id": "lumina", "session_id": "sess_abc", "emotion": "thinking"}
```

### 4. Get Chat History

```
GET /api/chat/history?session_id=sess_abc123&limit=20&before=msg_xxx
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session_id` | `string` | ❌ | current session | Session ID |
| `limit` | `number` | ❌ | `20` | Max number of messages to return |
| `before` | `string` | ❌ | — | Pagination cursor (message ID) |

**Response example:**

```json
{
  "messages": [
    {
      "id": "msg_001",
      "role": "user",
      "content": "Hello",
      "timestamp": "2026-07-28T10:00:00Z"
    },
    {
      "id": "msg_002",
      "role": "assistant",
      "content": "Hi there!",
      "emotion": "happy",
      "timestamp": "2026-07-28T10:00:01Z"
    }
  ],
  "has_more": false
}
```

### 5. Clear Chat History

```
DELETE /api/chat/history?session_id=sess_abc123
```

**Response:**

```json
{
  "status": "ok",
  "deleted_count": 42
}
```

### 6. Execute a Tool

```
POST /api/tools/execute
Content-Type: application/json

{
  "tool": "web_search",
  "params": {
    "query": "today's news"
  }
}
```

**Response example:**

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

### 7. List Tools

```
GET /api/tools
```

**Response example:**

```json
{
  "tools": [
    {
      "name": "web_search",
      "description": "Search engine query",
      "category": "Web",
      "parameters": {
        "query": { "type": "string", "required": true }
      }
    }
  ],
  "total": 88
}
```

### 8. Agent Management

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
      "name": "Recha 🍵",
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
  "personality": "Warm, thoughtful catgirl lead",
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

### 9. Memory Search

```
POST /api/memory/search
Content-Type: application/json

{
  "query": "the travel plan we discussed last time",
  "k": 5,
  "agent_id": "lumina"
}
```

**Response example:**

```json
{
  "results": [
    {
      "id": "mem_001",
      "content": "User wants to go to Japan to see cherry blossoms",
      "score": 0.92,
      "timestamp": "2026-07-25T14:30:00Z",
      "source": "chat_history"
    }
  ]
}
```

### 10. Write to Memory

```
POST /api/memory/save
Content-Type: application/json

{
  "content": "User likes cats and owns a Ragdoll",
  "agent_id": "lumina",
  "importance": 0.7,
  "tags": ["preference", "pet"]
}
```

**Response example:**

```json
{
  "status": "ok",
  "memory_id": "mem_002"
}
```

### 11. Skill Management

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
      "description": "Web search"
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

### 12. System Diagnostics

```
GET /api/doctor
```

**Response example:**

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

### 13. Read and Write Config

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
  "language": "en-US",
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

**Note:** Only send the fields you want to update; omitted fields are left untouched.

### 14. Cron Job Management

```
GET /api/cron
```

```json
{
  "jobs": [
    {
      "id": "cron_001",
      "name": "Morning check-in",
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
  "name": "Daily summary",
  "schedule": "0 22 * * *",
  "agent_id": "lumina",
  "prompt": "Summarize today's work"
}
```

```
DELETE /api/cron/:id
```

### 15. Emotion State

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

### 16. Security Approval

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

## Error Handling

All endpoints return a unified error format:

```json
{
  "error": {
    "code": "INVALID_PARAMS",
    "message": "Missing required parameter: message",
    "details": {}
  },
  "status": 400
}
```

**Common error codes:**

| HTTP Status | error.code | Description |
|-------------|------------|-------------|
| 400 | `INVALID_PARAMS` | Parameter validation failed |
| 401 | `UNAUTHORIZED` | Invalid API key |
| 404 | `NOT_FOUND` | Resource not found |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Internal server error |
| 503 | `LLM_UNAVAILABLE` | LLM service unreachable |

---

## Examples

### curl

```bash
# Health check
curl http://localhost:3456/api/health

# Chat
curl -X POST http://localhost:3456/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","agent_id":"lumina"}'

# Search memory
curl -X POST http://localhost:3456/api/memory/search \
  -H "Content-Type: application/json" \
  -d '{"query":"travel plan","k":3}'

# System diagnostics
curl http://localhost:3456/api/doctor
```

### Python

```python
import requests

BASE = "http://localhost:3456/api"

# Health check
print(requests.get(f"{BASE}/health").json())

# Chat
resp = requests.post(f"{BASE}/chat", json={
    "message": "How are you feeling today?",
    "agent_id": "lumina"
})
print(resp.json()["reply"])

# Streaming chat
import json
resp = requests.post(f"{BASE}/chat/stream", json={
    "message": "Tell me a story",
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

// Chat
const reply = await fetch(`${API}/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "Hello", agent_id: "lumina" }),
}).then(r => r.json());

console.log(reply.reply);
```

---

## CLI Shortcuts

Equivalent CLI commands for common operations:

| Operation | CLI | API |
|-----------|-----|-----|
| Chat | `lumina chat "Hello"` | `POST /api/chat` |
| System diagnostics | `lumina doctor` | `GET /api/doctor` |
| List tools | `lumina tool list` | `GET /api/tools` |
| Agent status | `lumina agent status` | `GET /api/agents` |
| Search memory | `lumina memory search "keywords"` | `POST /api/memory/search` |
| List skills | `lumina skill list` | `GET /api/skills` |

---

> Questions or suggestions? Open a [GitHub Issue](https://github.com/chaxu814/lumina-life/issues).
