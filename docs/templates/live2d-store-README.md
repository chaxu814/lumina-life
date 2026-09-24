# Live2D 配件商城后端部署说明（Cloudflare Workers + R2）

客户端 MVP **不依赖**本后端即可工作：未配置云端时，`ModelStorePanel` 自动进入「本地/离线模式」，
支持浏览本机模型库、一键热切换、从文件夹导入。本文件是**未来上线在线商城**时的后端模板。

## 架构

```
客户端 ModelStorePanel
   │  (GET/POST)
   ▼
Cloudflare Worker (live2d-store-worker.js)
   ├── R2 Bucket：MODEL  存模型 .zip 文件（无 egress 费用）
   └── KV Namespace：INDEX 存模型索引 JSON（名称/作者/下载量）
```

## 前置条件

1. 一个 Cloudflare 账号（免费额度足够早期）。
2. Node.js + Wrangler CLI：`npm i -g wrangler`。

## 部署步骤

### 1. 创建 R2 Bucket

```bash
wrangler r2 bucket create lumina-live2d-models
```

### 2. 创建 KV Namespace

```bash
wrangler kv namespace create MODEL_INDEX
# 记下输出的 id，填到下面 wrangler.toml 的 KV 绑定里
```

### 3. 新建 `wrangler.toml`

```toml
name = "lumina-live2d-store"
main = "live2d-store-worker.js"
compatibility_date = "2026-09-01"

[[r2_buckets]]
binding = "MODELS"
bucket_name = "lumina-live2d-models"

[[kv_namespaces]]
binding = "INDEX"
id = "<上一步 KV id>"

[vars]
# 上传鉴权 token（写操作才需要；客户端拉模型公开）
# 用 `openssl rand -hex 32` 生成一个强随机值
AUTH_TOKEN = "replace-with-a-long-random-token"
```

### 4. 发布

```bash
wrangler deploy
```

发布后得到形如 `https://lumina-live2d-store.<your-sub>.workers.dev` 的地址。

### 5. 客户端接入

把这个地址填到 `electron/ipc/modelStoreIpc.ts` 顶部的 `CLOUD_STORE_URL` 常量，
重新构建客户端即可。当前 MVP 该常量为空字符串，因此前端显示「本地/离线模式」。

## 接口一览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/models` | 公开 | 模型列表 |
| GET | `/api/models/:id` | 公开 | 单个模型元数据 |
| POST | `/api/upload` | Bearer | 上传模型 zip（multipart：`file` + `meta` JSON） |
| GET | `/api/download/:id` | 公开 | 下载模型，下载量 +1 |
| POST | `/api/purchase/:id` | — | **占位**，永远返回 501（不做支付） |

## 关于支付/分成

按提案评估，MVP **不接支付**。`/api/purchase/:id` 永远返回 501 `not implemented`。
正式分成需要：微信支付/支付宝商户号（申请周期 2-4 周）、公司主体、ICP 备案与网络文化经营许可证。
在法务与合规就位前，商城只做免费模型索引与下载。

## 安全提示

- `AUTH_TOKEN` 只用于写操作，不要下发给客户端；客户端只调公开的 GET 接口。
- 上传的模型包仍会在**客户端导入时**经过 `modelValidator`（schema + 恶意脚本扫描），
  即使后端被绕过，本地这道闸也会拦截带 `.js`/可执行脚本的模型。
