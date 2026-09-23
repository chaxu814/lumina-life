# weather_brief — 每日天气简报

当用户询问天气、需要每日早间天气推送、或根据天气决定穿衣/出行时使用本技能。
数据源为 Open-Meteo（免费、无需 API Key），内置常用城市经纬度。

## 工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `weather_get` | 获取指定城市实时天气与今日预报（温度/湿度/风速/高低温/降水概率）。 | `city` 城市名 |
| `weather_brief` | 生成每日天气简报，含天气状况与穿衣建议。 | `city` 城市名 |

## 内置城市

北京、上海、广州、深圳、杭州、成都、武汉、西安、南京、重庆、河池。

## 使用示例

```
用户: "今天天气怎么样？"
  → weather_get(city="北京")

用户: "给我做一份今天的天气简报"
  → weather_brief(city="河池")
```

## 使用守则

1. **城市必须在内置列表**——暂不支持任意经纬度，未收录城市会明确报错并列出支持城市。
2. **weather_brief 用于推送**——它带穿衣建议，适合早间/定时场景。
3. **网络失败要提示**——接口超时返回错误，不编造天气。

## 数据来源说明

- 接口：`https://api.open-meteo.com/v1/forecast`
- 字段：`current.temperature_2m / relative_humidity_2m / weather_code / wind_speed_10m`，
  `daily.temperature_2m_max / temperature_2m_min / precipitation_probability_max`
- weather_code 为 WMO 标准代码，已映射为中文（晴/多云/阴/雨/雪/雷雨等）。
- 超时：10 秒。
