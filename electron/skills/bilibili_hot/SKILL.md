# bilibili_hot — B站热搜推送

当用户想了解 B站正在流行什么、追热门视频、或需要定时推送热门榜时使用本技能。
数据来自 B站官方公开接口（`api.bilibili.com/x/web-interface/popular`），无需登录或 API Key。

## 工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `bilibili_hot_search` | 拉取 B站热门视频榜，返回排名/标题/UP主/播放量/链接。 | `limit` 条数(1-20，默认10) |
| `bilibili_hot_push` | 主动推送模式：格式化榜单并通过系统通知提醒。 | `limit` 条数(1-10，默认5) |

## 使用示例

```
用户: "B站现在有什么热门视频？"
  → bilibili_hot_search(limit=10)

用户: "每天早上给我推一下 B站热门榜前5"
  → 搭配定时任务使用 bilibili_hot_push(limit=5)
```

## 使用守则

1. **只读不写**——本技能只读取公开榜单，不会点赞、投币、发评论。
2. **网络错误要提示**——接口超时或被限流时，告诉用户稍后再试，不要编造榜单。
3. **push 用于主动唤起**——`bilibili_hot_push` 会弹系统通知，适合配合 cron/定时，不要在普通对话里滥用。

## 数据来源说明

- 接口：`https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1`
- 字段：`data.list[].title / owner.name / stat.view / short_link_v2 / bvid`
- 超时：10 秒；失败返回明确错误信息，不抛未捕获异常。
