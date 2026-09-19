// ============================================================
// pet/live2d/parameterProfile.ts — 🎛️ Live2D 语义通道 / 模型参数 Profile (v0.2)
//
// 不同 Live2D 模型暴露的参数 Id 与数量不同。为了让上层（情绪/口型/混合器）只面对
// 一套「语义通道」（headYaw、eyeLOpen、visemeA…），本模块负责：
//   1) 定义标准语义通道与取值范围；
//   2) 内置 Mao 的通道→真实 ParamId 映射；
//   3) 从任意模型的 *.cdi3.json 自动发现参数，按 Id 前缀尽力映射（UGC 模型也能驱动）。
// 纯 TS、零依赖，可单测。
// ============================================================

export const STANDARD_CHANNELS = [
  // 头
  'headPitch', 'headYaw', 'headRoll',
  // 眼（开闭 / 笑 / 视线）
  'eyeLOpen', 'eyeROpen', 'eyeLSmile', 'eyeRSmile', 'eyeBallX', 'eyeBallY',
  // 眉（上下 / 角度）
  'browLY', 'browRY', 'browLAngle', 'browRAngle',
  // 嘴：A/I/U/E/O 五元音 + 嘴角 + 嘟嘴
  'visemeA', 'visemeI', 'visemeU', 'visemeE', 'visemeO',
  'mouthUp', 'mouthDown', 'mouthAngry',
  // 脸 / 身体 / 呼吸 / 肩
  'cheek', 'bodyPitch', 'bodyYaw', 'bodyRoll', 'breath', 'shoulderL', 'shoulderR',
] as const

export type StandardChannel = (typeof STANDARD_CHANNELS)[number]

/** 每个语义通道的合法取值范围（min,max, 默认 0 或中性） */
export const CHANNEL_RANGES: Record<StandardChannel, [number, number]> = {
  headPitch: [-30, 30], headYaw: [-30, 30], headRoll: [-30, 30],
  eyeLOpen: [0, 1.3], eyeROpen: [0, 1.3], eyeLSmile: [0, 1], eyeRSmile: [0, 1],
  eyeBallX: [-1, 1], eyeBallY: [-1, 1],
  browLY: [-1, 1], browRY: [-1, 1], browLAngle: [-1, 1], browRAngle: [-1, 1],
  visemeA: [0, 1], visemeI: [0, 1], visemeU: [0, 1], visemeE: [0, 1], visemeO: [0, 1],
  mouthUp: [0, 1], mouthDown: [0, 1], mouthAngry: [0, 1],
  cheek: [0, 1],
  bodyPitch: [-10, 10], bodyYaw: [-10, 10], bodyRoll: [-10, 10],
  breath: [0, 1], shoulderL: [-1, 1], shoulderR: [-1, 1],
}

/** Mao（mao_pro）语义通道 → 真实 ParamId */
export const MAO_CHANNEL_MAP: Record<StandardChannel, string | null> = {
  headPitch: 'ParamAngleX', headYaw: 'ParamAngleY', headRoll: 'ParamAngleZ',
  eyeLOpen: 'ParamEyeLOpen', eyeROpen: 'ParamEyeROpen',
  eyeLSmile: 'ParamEyeLSmile', eyeRSmile: 'ParamEyeRSmile',
  eyeBallX: 'ParamEyeBallX', eyeBallY: 'ParamEyeBallY',
  browLY: 'ParamBrowLY', browRY: 'ParamBrowRY', browLAngle: 'ParamBrowLAngle', browRAngle: 'ParamBrowRAngle',
  visemeA: 'ParamA', visemeI: 'ParamI', visemeU: 'ParamU', visemeE: 'ParamE', visemeO: 'ParamO',
  mouthUp: 'ParamMouthUp', mouthDown: 'ParamMouthDown', mouthAngry: 'ParamMouthAngry',
  cheek: 'ParamCheek',
  bodyPitch: 'ParamBodyAngleX', bodyYaw: 'ParamBodyAngleY', bodyRoll: 'ParamBodyAngleZ',
  breath: 'ParamBreath',
  shoulderL: 'ParamLeftShoulderUp', shoulderR: 'ParamRightShoulderUp',
}

export interface ModelProfile {
  modelName: string
  /** 模型实际支持的 ParamId 集合 */
  supported: Set<string>
  /** 语义通道 → 该模型 ParamId（仅包含模型真正支持的） */
  channelMap: Partial<Record<StandardChannel, string>>
  /** 参数分组（调试/UI 用） */
  groups: string[]
}

/** 通用前缀匹配：在没有精确映射时，按通道含义在模型参数里找最像的 Id */
function genericCandidates(ch: StandardChannel): string[] {
  const table: Partial<Record<StandardChannel, string[]>> = {
    headPitch: ['ParamAngleX'], headYaw: ['ParamAngleY'], headRoll: ['ParamAngleZ'],
    eyeLOpen: ['ParamEyeLOpen', 'ParamEyeOpenL'], eyeROpen: ['ParamEyeROpen', 'ParamEyeOpenR'],
    eyeLSmile: ['ParamEyeLSmile'], eyeRSmile: ['ParamEyeRSmile'],
    eyeBallX: ['ParamEyeBallX'], eyeBallY: ['ParamEyeBallY'],
    browLY: ['ParamBrowLY'], browRY: ['ParamBrowRY'],
    browLAngle: ['ParamBrowLAngle'], browRAngle: ['ParamBrowRAngle'],
    visemeA: ['ParamA'], visemeI: ['ParamI'], visemeU: ['ParamU'], visemeE: ['ParamE'], visemeO: ['ParamO'],
    mouthUp: ['ParamMouthUp', 'ParamMouthForm'], mouthDown: ['ParamMouthDown'],
    mouthAngry: ['ParamMouthAngry'],
    cheek: ['ParamCheek'],
    bodyPitch: ['ParamBodyAngleX'], bodyYaw: ['ParamBodyAngleY'], bodyRoll: ['ParamBodyAngleZ'],
    breath: ['ParamBreath'],
    shoulderL: ['ParamLeftShoulderUp'], shoulderR: ['ParamRightShoulderUp'],
  }
  return table[ch] ?? []
}

/** 从 *.cdi3.json 内容发现模型 profile */
export function discoverProfile(cdi3: unknown, modelName = 'Unknown'): ModelProfile {
  const params: Array<{ Id?: unknown; GroupId?: unknown }> =
    isRecord(cdi3) && Array.isArray((cdi3 as any).Parameters) ? (cdi3 as any).Parameters : []
  const supported = new Set<string>()
  const groups = new Set<string>()
  for (const p of params) {
    if (p && typeof p.Id === 'string') {supported.add(p.Id)}
    if (p && typeof p.GroupId === 'string') {groups.add(p.GroupId)}
  }

  const channelMap: Partial<Record<StandardChannel, string>> = {}
  for (const ch of STANDARD_CHANNELS) {
    // 1) Mao 精确映射且模型支持
    const exact = MAO_CHANNEL_MAP[ch]
    if (exact && supported.has(exact)) { channelMap[ch] = exact; continue }
    // 2) 通用候选
    const cand = genericCandidates(ch).find(id => supported.has(id))
    if (cand) {channelMap[ch] = cand}
  }

  return { modelName, supported, channelMap, groups: Array.from(groups) }
}

/** 内置 Mao 的完整 profile（未加载 cdi3 前假定其全部标准参数可用） */
export function maoProfile(): ModelProfile {
  const channelMap = {} as Record<StandardChannel, string>
  const supported = new Set<string>()
  for (const ch of STANDARD_CHANNELS) {
    const id = MAO_CHANNEL_MAP[ch]
    if (id) { channelMap[ch] = id; supported.add(id) }
  }
  return { modelName: 'Mao', supported, channelMap, groups: [] }
}

/** 取某语义通道在该模型上的真实 ParamId（不支持则 undefined） */
export function resolveParamId(profile: ModelProfile, ch: StandardChannel): string | undefined {
  return profile.channelMap[ch]
}

/** 把语义姿态（通道→值）翻译成可直接 setParameterValueById 的参数补丁（仅含模型支持项），并 clamp */
export function toParamPatches(
  profile: ModelProfile,
  pose: Partial<Record<StandardChannel, number>>,
): Array<{ id: string; value: number }> {
  const out: Array<{ id: string; value: number }> = []
  for (const ch of STANDARD_CHANNELS) {
    if (!(ch in pose) || pose[ch] === undefined) {continue}
    const id = resolveParamId(profile, ch)
    if (!id) {continue}
    const [lo, hi] = CHANNEL_RANGES[ch]
    const value = Math.max(lo, Math.min(hi, pose[ch] as number))
    out.push({ id, value })
  }
  return out
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}
