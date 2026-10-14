/**
 * featureFlags.ts — 统一功能开关
 *
 * 设计原则：
 * - 新行为一律挂 flag，默认值保守（破坏性/实验性默认关，成熟增强默认开）
 * - 运行时可改：userData/feature-flags.json + 环境变量 LUMINA_FF_<NAME>=1|0 覆盖
 * - 类型安全：key 集中在 FeatureKey 联合类型，避免散落字符串
 * - 读取是同步的（启动时一次性加载），不要在热路径里反复 IO
 */
import { app } from 'electron';
import { stateFilePath } from './pathsFallback';
import * as fs from 'fs';
import * as path from 'path';

export type FeatureKey =
  // F1 沙箱
  | 'sandbox.severityMatrix'
  | 'sandbox.visualization'
  // F2 团队社交深化
  | 'social.deepTeam'
  // F3 VRM 情绪动作（达到 Live2D 对等后可默认开）
  | 'pet.vrmExpressive'
  // F4 梦境 LLM 生成
  | 'dream.llmGeneration'
  // F5 副人格（实验，默认关）
  | 'personality.subPersona'
  // I1 团队关系剧本化
  | 'team.relationshipDrama'
  // I2 情绪外显 + 冷战/原谅
  | 'emotion.expressiveness'
  | 'emotion.coldWar'
  // I3 Recha 开发者陪伴（只读 review）
  | 'developer.companion'
  // I4 关系事件记忆
  | 'memory.relationshipEvents'
  // 🆕 记忆与进化（设置页）
  | 'memory.conversation'
  | 'memory.localSkills'
  // 🆕 记忆会话级双开关（业界会话级记忆实践）
  //   memory.recall  —— 「使用记忆」：是否把长期记忆注入对话上下文 / 允许检索
  //   memory.write   —— 「生成记忆」：是否把本轮对话沉淀为新记忆
  //   拆成两个独立开关，是因为「读」和「写」的风险不同：
  //   有人希望「你可以用我的记忆，但别再记新的」，反之亦然。
  | 'memory.recall'
  | 'memory.write'
  // 🆕 中文词表分词增强（零依赖；关闭回到纯 unigram+bigram）
  | 'memory.cjkDict'
  // I6 隐私引导/自托管叙事
  | 'onboarding.privacy'
  // I7 精简模式（v0.1 公开版只露三件事）
  | 'mode.minimal'
  // P2-8 阶段1：命令策略审批层（REJECT 层无 flag 默认开；APPROVAL 层灰度）
  | 'security.commandApproval';

const DEFAULTS: Record<FeatureKey, boolean> = {
  // F1：7×8 威胁分类规则库——随代码落地即开（规则库是纯增量，不改旧路径）
  'sandbox.severityMatrix': true,
  // I5：沙箱透明可视化 UI——开（只读展示，无副作用）
  'sandbox.visualization': true,
  // F2：团队社交深化（剧本事件、亲密度后果）——开
  'social.deepTeam': true,
  // F3：VRM 情绪动作——beta，默认关，等对等 Live2D 再开
  'pet.vrmExpressive': false,
  // F4：梦境 LLM 生成——开（未配 LLM 时自动回退模板，诚实标注）
  'dream.llmGeneration': true,
  // F5：副人格——实验，默认关
  'personality.subPersona': false,
  // I1：团队关系剧本化——开
  'team.relationshipDrama': true,
  // I2：情绪外显行为（话术变短/透明度/动作）——开
  'emotion.expressiveness': true,
  // I2：冷战/原谅长周期——开
  'emotion.coldWar': true,
  // I3：Recha 开发者陪伴（只读 review）——开
  'developer.companion': true,
  // I4：关系事件记忆——开
  'memory.relationshipEvents': true,
  // 🆕 对话记忆——默认开（记住对话中的重要信息）
  'memory.conversation': true,
  // 🆕 本地记忆与技能——默认开（工作过程自动记录并优化技能，仅存本地）
  'memory.localSkills': true,
  // 🆕 使用记忆（召回）——默认开：允许把长期记忆注入对话
  'memory.recall': true,
  // 🆕 生成记忆（写入）——默认开：允许把对话沉淀为长期记忆
  'memory.write': true,
  // 🆕 中文词表分词——默认开：严格增量（只加匹配机会），可关闭回退
  'memory.cjkDict': true,
  // I6：隐私引导文案——开
  'onboarding.privacy': true,
  // I7：精简模式——默认关，公开版打包时通过环境变量打开
  'mode.minimal': false,
  // P2-8 阶段1：命令策略「审批」层——灰度默认关。
  // REJECT 层是纯增量拒绝（与既有黑名单叠加），不需要 flag；
  // 审批层会改变命令执行节奏（先不执行、等人 /approve），先灰度观察。
  'security.commandApproval': false,
};

const overrides: Partial<Record<FeatureKey, boolean>> = {};
let loaded = false;

function userFlagsPath(): string {
  try {
    return path.join(app.getPath('userData'), 'feature-flags.json');
  } catch {
    // ⚠️ 不要退回 process.cwd()：开发态 cwd 就是项目根，会把状态写进 Git 工作区
    return stateFilePath('feature-flags.json');
  }
}

export function loadFeatureFlags(): void {
  loaded = true;
  // 1) 文件
  try {
    const p = userFlagsPath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      for (const k of Object.keys(raw) as FeatureKey[]) {
        if (k in DEFAULTS) {overrides[k] = !!raw[k];}
      }
    }
  } catch {
    /* 坏文件不崩，用默认值 */
  }
  // 2) 环境变量 LUMINA_FF_<DOTS_TO_UNDERSCORE>=1|0
  for (const k of Object.keys(DEFAULTS) as FeatureKey[]) {
    const envKey = 'LUMINA_FF_' + k.replace(/\./g, '_').toUpperCase();
    const v = process.env[envKey];
    if (v === '1' || v === 'true') {overrides[k] = true;}
    else if (v === '0' || v === 'false') {overrides[k] = false;}
  }
}

export function isEnabled(key: FeatureKey): boolean {
  if (!loaded) {loadFeatureFlags();}
  if (key in overrides) {return overrides[key]!;}
  return DEFAULTS[key];
}

export function setFlag(key: FeatureKey, value: boolean): void {
  overrides[key] = value;
  try {
    const p = userFlagsPath();
    const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
    existing[key] = value;
    fs.writeFileSync(p, JSON.stringify(existing, null, 2), 'utf-8');
  } catch {
    /* 写不下去只影响本次进程 */
  }
}

export function allFlags(): Record<FeatureKey, boolean> {
  if (!loaded) {loadFeatureFlags();}
  const out = { ...DEFAULTS };
  for (const k of Object.keys(overrides) as FeatureKey[]) {out[k] = overrides[k]!;}
  return out;
}
