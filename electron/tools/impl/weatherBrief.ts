// ============================================================
// impl/weatherBrief.ts — 每日天气简报工具
//
// 数据源: Open-Meteo (https://api.open-meteo.com)
//   - 免费、无需 API Key、支持任意经纬度
//   - current: 温度/湿度/天气代码/风速
//   - daily:   最高温/最低温/最大降水概率
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { httpGet } from '../utils/httpClient'

const REQUEST_TIMEOUT_MS = 10000

/** 内置常见城市经纬度映射（含用户所在城市河池） */
const CITY_COORDS: Record<string, { lat: number; lon: number; name: string }> = {
  '北京': { lat: 39.9042, lon: 116.4074, name: '北京' },
  '上海': { lat: 31.2304, lon: 121.4737, name: '上海' },
  '广州': { lat: 23.1291, lon: 113.2644, name: '广州' },
  '深圳': { lat: 22.5431, lon: 114.0579, name: '深圳' },
  '杭州': { lat: 30.2741, lon: 120.1551, name: '杭州' },
  '成都': { lat: 30.5728, lon: 104.0668, name: '成都' },
  '武汉': { lat: 30.5928, lon: 114.3055, name: '武汉' },
  '西安': { lat: 34.3416, lon: 108.9398, name: '西安' },
  '南京': { lat: 32.0603, lon: 118.7969, name: '南京' },
  '重庆': { lat: 29.5630, lon: 106.5516, name: '重庆' },
  '河池': { lat: 24.6926, lon: 108.0854, name: '河池' },
}

/** WMO weather_code → 中文描述 */
function weatherCodeToText(code: number): string {
  if (code === 0) {return '晴'}
  if (code === 1) {return '大致晴'}
  if (code === 2) {return '多云'}
  if (code === 3) {return '阴'}
  if (code === 45 || code === 48) {return '雾'}
  if (code >= 51 && code <= 57) {return '毛毛雨'}
  if (code >= 61 && code <= 67) {return '雨'}
  if (code >= 71 && code <= 77) {return '雪'}
  if (code >= 80 && code <= 82) {return '阵雨'}
  if (code >= 85 && code <= 86) {return '阵雪'}
  if (code >= 95) {return '雷雨'}
  return `未知(${code})`
}

/** 根据温度和天气给出穿衣建议 */
function clothingAdvice(tempC: number, code: number, precipProb: number): string {
  const tips: string[] = []

  if (tempC >= 30) {tips.push('天气炎热，穿短袖/薄衫，注意防晒补水')}
  else if (tempC >= 22) {tips.push('舒适宜人，短袖或薄长袖即可')}
  else if (tempC >= 15) {tips.push('早晚偏凉，建议带件薄外套')}
  else if (tempC >= 5) {tips.push('较冷，穿厚外套/风衣')}
  else if (tempC >= 0) {tips.push('寒冷，注意保暖，穿羽绒服/厚棉衣')}
  else {tips.push('严寒，全副武装防冻，注意防滑')}

  if (precipProb >= 50) {tips.push('降水概率高，记得带伞')}
  if (code >= 71 && code <= 86) {tips.push('有雨雪，注意路滑')}
  if (code >= 95) {tips.push('可能有雷雨，减少户外活动')}

  return tips.join('；')
}

interface WeatherPayload {
  cityName: string
  temp: number
  humidity: number
  code: number
  wind: number
  tempMax: number
  tempMin: number
  precipProb: number
}

/** 调用 Open-Meteo 拉取天气 */
async function fetchWeather(city: string): Promise<WeatherPayload> {
  const coord = CITY_COORDS[city]
  if (!coord) {
    throw new Error(`暂不支持城市 "${city}"。内置城市: ${Object.keys(CITY_COORDS).join('、')}`)
  }

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${coord.lat}&longitude=${coord.lon}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=auto`

  const resp = await httpGet(url, { 'User-Agent': 'Lumina/1.0' }, REQUEST_TIMEOUT_MS)
  if (!resp.ok) {
    throw new Error(`天气接口返回 HTTP ${resp.status}`)
  }

  let json: any
  try {
    json = JSON.parse(resp.text)
  } catch {
    throw new Error('天气接口返回内容不是合法 JSON')
  }

  const cur = json?.current || {}
  const daily = json?.daily || {}
  const code = Number(cur.weather_code ?? 0)

  return {
    cityName: coord.name,
    temp: Number(cur.temperature_2m ?? 0),
    humidity: Number(cur.relative_humidity_2m ?? 0),
    code,
    wind: Number(cur.wind_speed_10m ?? 0),
    tempMax: Number(Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : 0),
    tempMin: Number(Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : 0),
    precipProb: Number(Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max[0] : 0),
  }
}

/** 格式化为天气简报文本 */
export function formatWeatherBrief(w: WeatherPayload): string {
  const cond = weatherCodeToText(w.code)
  const advice = clothingAdvice(w.temp, w.code, w.precipProb)
  return [
    `🌤️ ${w.cityName} 天气简报`,
    ``,
    `当前: ${w.temp}°C（${cond}）  湿度 ${w.humidity}%  风速 ${w.wind} km/h`,
    `今日: ${w.tempMin}°C ~ ${w.tempMax}°C  降水概率 ${w.precipProb}%`,
    ``,
    `👕 建议: ${advice}`,
  ].join('\n')
}

// ── 工具 1: 获取原始天气数据 ────────────────────────────

export const weatherGetDef: ToolDef = {
  name: 'weather_get',
  description: `获取指定城市的实时天气与今日预报（Open-Meteo，免费无需 Key）。
内置城市: ${Object.keys(CITY_COORDS).join('、')}

参数:
- city: 城市名称（需在内置城市列表中）`,
  params: {
    city: { type: 'string', description: '城市名称', required: true },
  },
  toolsets: ['agent'],
}

export async function weatherGet(args: Record<string, any>): Promise<ToolResult> {
  const city = String(args.city || '').trim()
  if (!city) {
    return { callId: '', ok: false, content: '', error: '需要提供 city 参数' }
  }

  try {
    const w = await fetchWeather(city)
    return { callId: '', ok: true, content: formatWeatherBrief(w) }
  } catch (err: any) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: `天气查询失败: ${err?.message || err}`,
    }
  }
}

// ── 工具 2: 每日天气简报（含穿衣建议）──────────────────

export const weatherBriefDef: ToolDef = {
  name: 'weather_brief',
  description: `生成每日天气简报：当前温度、今日高低温、降水概率、天气状况，并给出穿衣建议。
适合每日早间推送。

参数:
- city: 城市名称（需在内置城市列表中）`,
  params: {
    city: { type: 'string', description: '城市名称', required: true },
  },
  toolsets: ['agent'],
}

export async function weatherBrief(args: Record<string, any>): Promise<ToolResult> {
  const city = String(args.city || '').trim()
  if (!city) {
    return { callId: '', ok: false, content: '', error: '需要提供 city 参数' }
  }

  try {
    const w = await fetchWeather(city)
    const brief = formatWeatherBrief(w)
    return {
      callId: '',
      ok: true,
      content: `📰 每日天气简报已生成\n\n${brief}`,
    }
  } catch (err: any) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: `生成天气简报失败: ${err?.message || err}`,
    }
  }
}
