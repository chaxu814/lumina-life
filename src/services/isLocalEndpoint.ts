// ═══════════════════════════════════════════════════════════
// isLocalEndpoint.ts — 「这是不是本地 / 内网模型服务」判定的单一事实来源
//
// 为什么要抽出来
//
// 改动前这个判定散在 6+ 处，写法各不相同：
//   · GroupChatView   : localhost / 127.0.0.1 / ollama
//   · llmProvider     : localhost / 127. / 0.0.0.0 / 192.168. / ^https?://10.
//   · providerAdapter : localhost / 127.0.0.1
//   · systemIpc       : 127.0.0.1 / localhost
//   · agentRunner     : localhost / 127.0.0.1 / ollama
//   · agentConfig     : 127.0.0.1
//
// 同一个问题得到不同答案。真实踩中的坑：用户把 LM Studio 跑在内网另一台机器
// （http://192.168.1.2:1234/v1），GroupChatView 判不出是本地 →
//   · 本该显示的「本地模型未加载」提示不显示
//   · 反过来会误显示「云端 API · tokens 消耗」警告
//
// 判定的语义：**这个端点是不是不需要公网账号、流量不出本机的服务**。
// ═══════════════════════════════════════════════════════════

/** 私有网段 + 本机回环。锚定在 host 部分，避免误伤 URL 里的其它数字。 */
const LOCAL_HOST_RE = new RegExp(
  [
    '^localhost$',
    '^127\\.',                    // 127.0.0.0/8 回环
    '^0\\.0\\.0\\.0$',
    '^\\[?::1\\]?$',              // IPv6 回环
    '^10\\.',                     // 10.0.0.0/8
    '^192\\.168\\.',              // 192.168.0.0/16
    '^172\\.(1[6-9]|2\\d|3[01])\\.', // 172.16.0.0/12
    '\\.local$',                  // mDNS
  ].join('|'),
  'i',
)

/**
 * 从 baseUrl 里取出 host（不含协议、端口、路径）。
 * 容错：不是合法 URL 时（如用户手打错），退化成整串判断。
 */
export function extractHost(baseUrl: string | undefined | null): string {
  if (!baseUrl) {return ''}
  const raw = String(baseUrl).trim()
  if (!raw) {return ''}
  try {
    return new URL(raw).hostname
  } catch {
    // 例如 "192.168.1.2:1234/v1" 缺协议
    return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].split(':')[0]
  }
}

/** 端点是否属于本地 / 内网（含局域网另一台机器） */
export function isLocalEndpoint(baseUrl: string | undefined | null): boolean {
  const host = extractHost(baseUrl)
  if (!host) {return false}
  return LOCAL_HOST_RE.test(host)
}

/**
 * 是否是「明确指名的本地推理运行时」。
 * 比 isLocalEndpoint 更窄：只有 LM Studio / Ollama 这类才有 /v1/models 可探测。
 * 用于「要不要去探测本地已加载模型」这种判断 —— 云端 API 没有这个接口。
 */
export function isLocalInferenceRuntime(baseUrl: string | undefined | null): boolean {
  const url = String(baseUrl || '').toLowerCase()
  return isLocalEndpoint(baseUrl) || url.includes('ollama') || url.includes('lmstudio') || url.includes('lm-studio')
}
