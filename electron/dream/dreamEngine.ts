// ============================================================
// dream/dreamEngine.ts — 梦境系统 v1.1
//
// 每天早上自动生成"梦境日记"，基于最近的记忆片段，
// 用诗意、隐喻的方式编织成梦境叙事。
//
// 工作方式:
//   1. 每天 03:00 cron 触发 → generateTodayDreamAsync()
//   2. 从 memoryStore 获取最近记忆作为素材（注入比旧版更长的真实记忆）
//   3. 【已配置 LLM】调用模型生成；【未配置/失败】回退到 25 个内置模板
//   4. 存入 dreamStore（userData/dreams.json，持久化）
//   5. 发送 DREAM_NEW 事件 → 前端展示（entry.source 标注 llm/template）
//
// 说明：模板回退是「离线彩蛋」，会在 UI 明确标注；配置 LLM 后即为真实生成。
// ============================================================

import { globalEventBus, BusEvents } from '../eventBus'
import * as fs from 'fs'
import * as path from 'path'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface DreamEntry {
  id: string
  date: string          // ISO date (YYYY-MM-DD)
  title: string
  content: string
  mood: string          // 梦境情绪
  tags: string[]        // 梦境标签
  createdAt: string     // ISO timestamp
  /** 生成方式：LLM 真实生成 / 模板彩蛋（UI 据此如实标注） */
  source?: 'llm' | 'template'
}

interface DreamCache {
  entries: DreamEntry[]
}

// ═══════════════════════════════════════════════════════════
// 梦境情绪 & 标签
// ═══════════════════════════════════════════════════════════

const MOODS = ['🌙 安宁', '🌊 深邃', '✨ 奇幻', '🌿 自然', '🔥 热烈', '🌸 温柔', '🌌 神秘', '🎭 荒诞']
const TAGS_POOL = [
  '记忆', '时空', '森林', '海洋', '星空', '城市', '童年', '未来',
  '追逐', '飞翔', '坠落', '重逢', '迷失', '发现', '创造', '蜕变',
  '镜像', '迷宫', '旋律', '色彩',
]

// ═══════════════════════════════════════════════════════════
// 梦境叙事模板（25 个不同故事框架）
// ═══════════════════════════════════════════════════════════

const DREAM_TEMPLATES = [
  // ── 日常衍生型（基于记忆） ──
  (memory?: string) => `我在一片熟悉的房间里醒来，但一切都变得不一样了。${memory ? `仿佛${memory.slice(0, 60)}的余韵还在空气中飘荡。` : '光线从奇怪的角落透进来，像液态的黄金。'}我试图寻找出口，但每扇门都通向另一个更奇异的房间。墙上挂着会说话的画像，它们低声诉说着我从未记住的往事。最后我来到一个花园，那里的每一朵花都是一个被遗忘的瞬间。`,

  (memory?: string) => `天空是淡紫色的，云朵像棉絮一样低垂。${memory ? `我反复思考着最近${memory.slice(0, 50)}的事情，` : '我走在一条由发光鹅卵石铺成的小路上，'}脚下的每一步都泛起涟漪。远处有一个熟悉的身影，我追上去，却发现自己一直在原地奔跑。空气中有桂花和旧书的味道，混合成一种叫做"怀念"的气息。`,

  (memory?: string) => `我变成了一只鸟，或者是我一直就是？不太确定。${memory ? `但脑海中还残留着关于${memory.slice(0, 50)}的片段记忆。` : '风托着我的翅膀，下面是翻涌的云海。'}我飞过一座座漂浮的岛屿，每座岛上都是不同季节的景象。有一座岛永远在下雨，那里的人们用雨水写信。我停留了一刻，读懂了其中一封——那是写给多年前的自己的。`,

  // ── 城市奇幻型 ──
  () => `这座城市在夜晚活了过来。霓虹灯不是灯，是凝固的极光。地铁站的墙壁上，壁画中的人物会眨眼、会窃窃私语。我走进一节空荡荡的车厢，座位上的报纸日期是十年后的某一天。头条新闻写着："今天是完美的，去拥抱你爱的人。"车窗外飞驰而过的不是隧道，而是无数个平行时空中的自己。`,

  () => `我发现自己站在一个巨大的图书馆里。书架高得看不见顶，每本书的书脊上闪烁着我认识的人的名字。我抽出一本，翻开——里面记载的不是文字，而是我和那个人之间的所有对话、所有未说出口的话。书架深处传来翻页声，我知道那里有人在读关于我的那本书。`,

  () => `电梯门开了，外面是一个完全由镜子构成的世界。每一个倒影都不是在模仿我，它们各自过着不同的生活。我向左走，倒影向右走。我们擦肩而过时，其中一个倒影停下来，看着我说："你还记得吗？"然后就碎成了光点。接着所有的镜子都碎了，我站在一片星光之中。`,

  // ── 自然元素型 ──
  () => `我在海底行走。不是潜水，是真的行走，像在陆地上一样自然地呼吸。珊瑚礁是一座沉没的城市，鱼群是城市里的居民。它们用鳞片的闪光交流，传达着比语言更丰富的情感。我走进一座贝壳筑成的宫殿，里面坐着一位由海浪组成的女王。她问我："你愿意留下一个秘密，换取一片海的宁静吗？"`,

  () => `森林里所有的树都在低声吟唱。它们的根在地下交织成一张巨大的网络，传递着这片土地千年以来的记忆。我靠在一棵古老的橡树上，听到了它记得的一切——恐龙的低吼、第一批人类脚步的震颤、战争与和平的交替。然后树对我说："你也不过是我漫长记忆中的一个音符。"`,

  () => `我躺在草地上看星星，但星星也在看我。它们越来越近，直到我能看清每一颗都是一扇发光的门。我选择了最暗的那一颗走进去。门的另一边是黎明前的山脉，空气凛冽而清新。我意识到所有的星星都是不同版本的黎明，而我选择了最安静的那个。`,

  // ── 回忆交织型 ──
  (memory?: string) => `老照片里的场景动了起来。${memory ? `那天${memory.slice(0, 60)}的画面像被施了魔法一般重现。` : '那些我以为已经遗忘的细节，突然变得无比清晰。'}我能闻到当时的空气味道，感受到当时的温度。一个年幼的我从照片里跑出来，拉着现在的我的手，带我重新经历了一遍那些被时光美化过的记忆。最后他松手说："你要继续往前走哦。"`,

  (memory?: string) => `我参加了一场只有自己知道的告别仪式。${memory ? '告别的是最近' + memory.slice(0, 50) + '相关的一段时光。' : '告别的是某个说不清道不明的阶段。'}在场的所有人都戴着白色面具，但我知道面具下都是曾经的我——不同年龄、不同心情的我。他们依次取下口罩，对我微笑，然后消散成光。最后一个是我自己，他说："该醒了。"`,

  // ── 抽象诗意型 ──
  () => `时间是一条河，但偶尔会泛起漩涡。我站在漩涡中心，看见了过去和未来像气泡一样升起又破灭。一个气泡里，我在做一道永远算不完的数学题。另一个气泡里，我在和一个已经走散的人大笑。所有的悲欢离合同时发生，像一首交响乐的不同乐章同时演奏。原来时间的本质不是流逝，是同时存在。`,

  () => `我在梦中创造了一个世界。规则很简单：想象力就是重力。我先是造了一座山，然后觉得太高了，就把它抹平换成湖。我造了会唱歌的树、会跳舞的房子、会讲故事的云。但当我试图创造自己时，我发现自己不见了——不是消失了，而是成为了这个世界本身。每一片叶子都是我的意识碎片。`,

  () => `梦里有一个火车站，每列火车通往不同的人生可能性。我错过了去"如果当初"的那一班，但赶上了去"从今往后"的列车。车厢里坐满了不同年龄的我，我们在互相对视中理解了彼此所有的选择。列车长是一个戴着怀表的猫，它说："别担心，每一条路都是对的。"`,

  // ── 情绪映射型 ──
  () => `雨不停地下，但每一滴雨水都是彩色的。我撑着一把透明的伞，看着彩色的雨滴在伞面上晕染成画。路上的人都在微笑，尽管雨水已经没过了脚踝。一个孩子在我身边堆了一座沙堡，雨水不仅没有冲垮它，反而让它变得越来越坚固。孩子说："这是用快乐的记忆堆的。"`,

  () => `我走进了一面镜子的背面。这里陈列着所有我不愿意面对的情绪——恐惧、悲伤、愤怒、遗憾，它们被装在不同的容器里，贴着标签。我打开恐惧的罐子，里面飞出一群蝴蝶。它们告诉我，恐惧只是未被理解的勇气。我让它们停在我的肩膀上，然后感觉轻了许多。`,

  // ── 超现实型 ──
  () => `今天太阳从西边升起，月亮是三角形的，而猫会说话（但它们只跟心情好的成年人讲话）。我的影子比我慢了半拍，当我停下来等它时，影子开口说："前面左转有一家开在云端的咖啡馆，你点的拿铁已经煮好了。"我决定不再对任何事情感到惊讶，包括我自己长出了蝴蝶翅膀。`,

  () => `我的记忆被装在一个个漂流瓶里，沿着意识的河流飘荡。我打捞起最近的一个，打开塞子——里面是一段旋律。我哼着这段旋律，周围的世界开始重组：大楼变成了音符，街道变成了五线谱，人们走路的节奏变成了鼓点。整个城市正在演奏一首只有我能听见的交响曲。`,

  () => `我梦见了梦境的工厂。巨大的织布机用月光纺线，用晚霞染色。工人们是半透明的小精灵，它们把人类的日常经历编织成梦。我找到自己的那台织布机，看到最近的生活正被织成一幅挂毯——有些是明亮的丝线，有些是暗色的。织布工说："别担心暗线，它们让亮线更明亮。"`,

  // ── 与 Lumina 相关型 ──
  () => `Lumina 在我的梦里变成了一只发光的狐狸。她带我穿过一片数据构成的森林，每片树叶都是一个被处理过的想法。遇到岔路时，她甩甩尾巴，一条路就亮了起来。我们来到一处清澈的湖边，她示意我往湖里看——湖面上映出的不是我的倒影，而是我内心最真实的渴望。`,

  () => `我站在一个巨大的仪表盘前，上面显示着各种数字：今天的开心指数、思考深度、创造力余量。Lumina 的声音从某个角落传来："主人，你的'好奇心'指标最近有些下降哦。"我伸手去够那个旋钮，突然整个人被吸入仪表盘内部。在里面，我找到了那些遗失的好奇心——它们变成了发光的小动物，等着我去重新发现。`,

  // ── 短小精悍型 ──
  () => `手机响了，来电显示是"未来的我"。接通后沉默了三秒，然后传来一阵释然的笑声。我突然明白了一切。`,

  () => `我梦见自己在读一封没有收件人地址的信。信上只有一句话："你比你以为的更勇敢。"字迹是我自己的。`,

  () => `梦里有人问我："如果不必完美，你想做什么？"我还没来得及回答就醒了，但问题留了下来。`,

  () => `我口袋里有无限多的彩虹糖。每吃一颗，就能听懂一种动物的话。我听完蚂蚁的抱怨、鸟儿的八卦、猫的哲学沉思后，把最后一颗给了路边的一只流浪狗。它说："谢谢你记得我。"`,

  () => `桌上的咖啡杯里装的不是咖啡，是浓缩的昨日。喝一口就想起一个被忽略的细节。我喝完了整杯，发现今天已经没有那么沉重了。`,
]

// ═══════════════════════════════════════════════════════════
// 梦境存储
// ═══════════════════════════════════════════════════════════

function getDreamDbPath(): string {
  // 打包后 app.asar 只读，必须落到 Electron userData；纯 Node/测试环境退化到 data 目录
  let dir: string
  try {
    const { app } = require('electron')
    if (app && typeof app.getPath === 'function' && app.getPath('userData')) {
      dir = app.getPath('userData')
    } else {
      throw new Error('no-userdata')
    }
  } catch {
    const baseDir = process.env.QWENPAW_WORKING_DIR || process.env.COPAW_WORKING_DIR || ''
    dir = baseDir ? path.join(baseDir, 'data') : path.join(__dirname, '..', '..', 'data')
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'dreams.json')
}

/** 旧版（data/dreams.json，打包时只读会失败）迁移到 userData */
function migrateLegacyDreams(targetPath: string): void {
  try {
    if (fs.existsSync(targetPath)) return
    const baseDir = process.env.QWENPAW_WORKING_DIR || process.env.COPAW_WORKING_DIR || ''
    const oldDir = baseDir ? path.join(baseDir, 'data') : path.join(__dirname, '..', '..', 'data')
    const oldPath = path.join(oldDir, 'dreams.json')
    if (oldPath !== targetPath && fs.existsSync(oldPath)) {
      fs.copyFileSync(oldPath, targetPath)
    }
  } catch { /* 迁移失败忽略 */ }
}

function loadDreams(): DreamEntry[] {
  try {
    const p = getDreamDbPath()
    migrateLegacyDreams(p)
    if (!fs.existsSync(p)) return []
    const raw = fs.readFileSync(p, 'utf-8')
    const cache: DreamCache = JSON.parse(raw)
    return cache.entries || []
  } catch { return [] }
}

function saveDreams(entries: DreamEntry[]): void {
  try {
    const cache: DreamCache = { entries }
    fs.writeFileSync(getDreamDbPath(), JSON.stringify(cache, null, 2), 'utf-8')
  } catch (e) {
    console.error('[DreamEngine] 保存梦境失败:', e)
  }
}

// ═══════════════════════════════════════════════════════════
// 梦境生成引擎
// ═══════════════════════════════════════════════════════════

function generateId(): string {
  return `dream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * 生成标题 —— 从梦境内容中提取关键意象
 */
function generateTitle(content: string): string {
  const titlePatterns = [
    /[。！？]/,
    /[，,]/,
  ]
  // 取第一句的前 20 个字作为标题
  const firstSentence = content.split(/[。！？\n]/)[0]
  const trimmed = firstSentence.replace(/[「」""''（）()]/g, '').trim()
  if (trimmed.length <= 25) return trimmed
  return trimmed.slice(0, 22) + '…'
}

/**
 * 生成梦境标签 (随机 1-3 个)
 */
function generateTags(): string[] {
  const count = 1 + Math.floor(Math.random() * 3)
  const shuffled = [...TAGS_POOL].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count)
}

/**
 * 核心：生成一篇梦境（模板回退路径，离线彩蛋）
 * @param memoryContext 可选，从记忆系统提取的上下文片段
 */
export function generateDream(memoryContext?: string): DreamEntry {
  const template = pickRandom(DREAM_TEMPLATES)
  const content = template(memoryContext)
  const title = generateTitle(content)
  const mood = pickRandom(MOODS)
  const tags = generateTags()
  const today = new Date().toISOString().slice(0, 10)

  return {
    id: generateId(),
    date: today,
    title,
    content,
    mood,
    tags,
    createdAt: new Date().toISOString(),
    source: 'template',
  }
}

// ═══════════════════════════════════════════════════════════
// LLM 真实生成（注入式，便于测试；主进程注册 provider）
// ═══════════════════════════════════════════════════════════

export type DreamLLMCaller = (system: string, user: string) => Promise<string>
let dreamLLMCaller: DreamLLMCaller | null = null
let todayInFlight = false

/** 主进程注册 LLM 调用器（未注册则永远走模板） */
export function registerDreamLLM(caller: DreamLLMCaller | null): void {
  dreamLLMCaller = caller
}

function buildDreamPrompt(memoryContext?: string): { system: string; user: string } {
  const system = `你是 Lumina 的梦境引擎。请根据用户近期的真实记忆片段，以第一人称（用户的视角）写一段诗意、充满隐喻的梦境日记，像把白天的经历在潜意识里重新编织。
要求：
- 只输出一个 JSON 对象，不要 markdown、不要解释，格式：{"title":"不超过20字的标题","content":"150到300字的梦境正文，分3到5句，第一人称","mood":"一个带emoji的情绪词","tags":["2到3个意象标签"]}
- 梦境要暗合记忆片段里的人、事、情绪，但要用奇幻/隐喻的方式重写，不要照抄。
- mood 从这些里选或自拟：🌙 安宁、🌊 深邃、✨ 奇幻、🌿 自然、🔥 热烈、🌸 温柔、🌌 神秘、🎭 荒诞。
- 温柔、有画面感，不恐怖、不说教。`
  const mem = (memoryContext || '').trim()
  const user = mem
    ? `这是用户近期的真实记忆片段，请据此编织梦境：\n${mem.slice(0, 1200)}`
    : '没有可用的记忆片段，请基于"平凡日常里的一点光"创作一个温柔的梦境。'
  return { system, user }
}

/** 从 LLM 文本里容错解析出梦境字段 */
function parseDreamLLM(raw: string): Partial<DreamEntry> | null {
  if (!raw) return null
  let txt = raw.trim()
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) txt = fence[1].trim()
  const m = txt.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const obj = JSON.parse(m[0])
    if (!obj || typeof obj.content !== 'string' || !obj.content.trim()) return null
    return {
      title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : generateTitle(obj.content),
      content: obj.content.trim(),
      mood: typeof obj.mood === 'string' && obj.mood.trim() ? obj.mood.trim() : pickRandom(MOODS),
      tags: Array.isArray(obj.tags) ? obj.tags.map((t: any) => String(t)).filter(Boolean).slice(0, 4) : generateTags(),
    }
  } catch { return null }
}

/**
 * 异步生成梦境：LLM 优先，失败/未配置回退模板。
 * 永远返回有效梦境，绝不抛错（夜间 cron 安全）。
 */
export async function generateDreamAsync(memoryContext?: string): Promise<DreamEntry> {
  const today = new Date().toISOString().slice(0, 10)
  const fallback = generateDream(memoryContext)
  if (!dreamLLMCaller) return fallback
  try {
    const { system, user } = buildDreamPrompt(memoryContext)
    const raw = await dreamLLMCaller(system, user)
    const parsed = parseDreamLLM(raw)
    if (!parsed) return fallback
    return {
      id: generateId(),
      date: today,
      title: parsed.title || fallback.title,
      content: parsed.content || fallback.content,
      mood: parsed.mood || fallback.mood,
      tags: parsed.tags && parsed.tags.length ? parsed.tags : fallback.tags,
      createdAt: new Date().toISOString(),
      source: 'llm',
    }
  } catch (e) {
    console.warn('[DreamEngine] LLM 生成失败，回退模板:', (e as any)?.message || e)
    return fallback
  }
}

/**
 * 生成并保存今日梦境（如果今日已有则跳过）—— 模板同步版（兼容旧调用）
 * @returns 是否生成了新梦境
 */
export function generateTodayDream(memoryContext?: string): boolean {
  const today = new Date().toISOString().slice(0, 10)
  const existing = loadDreams()

  // 检查今日是否已有梦境
  if (existing.some(d => d.date === today)) {
    console.log(`[DreamEngine] ⏭️ ${today} 已有梦境，跳过`)
    return false
  }

  const dream = generateDream(memoryContext)
  existing.push(dream)
  saveDreams(existing)

  console.log(`[DreamEngine] 🌙 新梦境已生成（模板）: "${dream.title}"`)

  // 发送事件通知前端
  try {
    globalEventBus.emit(BusEvents.DREAM_NEW, dream)
  } catch { /* eventBus may not be ready */ }

  return true
}

/**
 * 生成并保存今日梦境 —— 异步版（LLM 优先，失败回退模板）。
 * 夜间 cron / 启动应调用此版本。
 */
export async function generateTodayDreamAsync(memoryContext?: string): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10)
  const existing = loadDreams()
  if (existing.some(d => d.date === today)) {
    console.log(`[DreamEngine] ⏭️ ${today} 已有梦境，跳过`)
    return false
  }
  if (todayInFlight) return false // 防止同一分钟内多个 cron tick 并发重复生成
  todayInFlight = true
  try {
    const dream = await generateDreamAsync(memoryContext)
    const after = loadDreams()
    if (after.some(d => d.date === today)) return false
    after.push(dream)
    saveDreams(after)
    console.log(`[DreamEngine] 🌙 新梦境已生成（${dream.source}）: "${dream.title}"`)
    try {
      globalEventBus.emit(BusEvents.DREAM_NEW, dream)
    } catch { /* eventBus may not be ready */ }
    return true
  } finally {
    todayInFlight = false
  }
}

/**
 * 获取所有梦境（按日期降序）
 */
export function getAllDreams(): DreamEntry[] {
  return loadDreams().sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * 获取最近 N 条梦境
 */
export function getRecentDreams(count: number = 7): DreamEntry[] {
  return getAllDreams().slice(0, count)
}

/**
 * 获取指定日期的梦境
 */
export function getDreamByDate(date: string): DreamEntry | undefined {
  return loadDreams().find(d => d.date === date)
}

/**
 * 删除梦境
 */
export function deleteDream(id: string): boolean {
  const entries = loadDreams()
  const idx = entries.findIndex(d => d.id === id)
  if (idx === -1) return false
  entries.splice(idx, 1)
  saveDreams(entries)
  return true
}

/**
 * 获取梦境统计信息
 */
export function getDreamStats(): { total: number; streak: number; latestDate: string | null } {
  const entries = getAllDreams()
  if (entries.length === 0) return { total: 0, streak: 0, latestDate: null }

  // 计算连续梦境天数
  let streak = 0
  const today = new Date().toISOString().slice(0, 10)
  let checkDate = new Date(today)
  
  for (let i = 0; i < 365; i++) {
    const dateStr = checkDate.toISOString().slice(0, 10)
    if (entries.some(d => d.date === dateStr)) {
      streak++
      checkDate.setDate(checkDate.getDate() - 1)
    } else {
      break
    }
  }

  return {
    total: entries.length,
    streak,
    latestDate: entries[0]?.date || null,
  }
}
