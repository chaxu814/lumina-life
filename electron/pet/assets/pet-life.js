"use strict";
var LuminaLife = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // electron/pet/life/runtime.ts
  var runtime_exports = {};
  __export(runtime_exports, {
    PetPerformanceEngine: () => PetPerformanceEngine,
    scanAlphaBounds: () => scanAlphaBounds
  });

  // electron/pet/live2d/parameterProfile.ts
  var STANDARD_CHANNELS = [
    // 头
    "headPitch",
    "headYaw",
    "headRoll",
    // 眼（开闭 / 笑 / 视线）
    "eyeLOpen",
    "eyeROpen",
    "eyeLSmile",
    "eyeRSmile",
    "eyeBallX",
    "eyeBallY",
    // 眉（上下 / 角度）
    "browLY",
    "browRY",
    "browLAngle",
    "browRAngle",
    // 嘴：A/I/U/E/O 五元音 + 嘴角 + 嘟嘴
    "visemeA",
    "visemeI",
    "visemeU",
    "visemeE",
    "visemeO",
    "mouthUp",
    "mouthDown",
    "mouthAngry",
    // 脸 / 身体 / 呼吸 / 肩
    "cheek",
    "bodyPitch",
    "bodyYaw",
    "bodyRoll",
    "breath",
    "shoulderL",
    "shoulderR"
  ];
  var CHANNEL_RANGES = {
    headPitch: [-30, 30],
    headYaw: [-30, 30],
    headRoll: [-30, 30],
    eyeLOpen: [0, 1.3],
    eyeROpen: [0, 1.3],
    eyeLSmile: [0, 1],
    eyeRSmile: [0, 1],
    eyeBallX: [-1, 1],
    eyeBallY: [-1, 1],
    browLY: [-1, 1],
    browRY: [-1, 1],
    browLAngle: [-1, 1],
    browRAngle: [-1, 1],
    visemeA: [0, 1],
    visemeI: [0, 1],
    visemeU: [0, 1],
    visemeE: [0, 1],
    visemeO: [0, 1],
    mouthUp: [0, 1],
    mouthDown: [0, 1],
    mouthAngry: [0, 1],
    cheek: [0, 1],
    bodyPitch: [-10, 10],
    bodyYaw: [-10, 10],
    bodyRoll: [-10, 10],
    breath: [0, 1],
    shoulderL: [-1, 1],
    shoulderR: [-1, 1]
  };
  var MAO_CHANNEL_MAP = {
    headPitch: "ParamAngleX",
    headYaw: "ParamAngleY",
    headRoll: "ParamAngleZ",
    eyeLOpen: "ParamEyeLOpen",
    eyeROpen: "ParamEyeROpen",
    eyeLSmile: "ParamEyeLSmile",
    eyeRSmile: "ParamEyeRSmile",
    eyeBallX: "ParamEyeBallX",
    eyeBallY: "ParamEyeBallY",
    browLY: "ParamBrowLY",
    browRY: "ParamBrowRY",
    browLAngle: "ParamBrowLAngle",
    browRAngle: "ParamBrowRAngle",
    visemeA: "ParamA",
    visemeI: "ParamI",
    visemeU: "ParamU",
    visemeE: "ParamE",
    visemeO: "ParamO",
    mouthUp: "ParamMouthUp",
    mouthDown: "ParamMouthDown",
    mouthAngry: "ParamMouthAngry",
    cheek: "ParamCheek",
    bodyPitch: "ParamBodyAngleX",
    bodyYaw: "ParamBodyAngleY",
    bodyRoll: "ParamBodyAngleZ",
    breath: "ParamBreath",
    shoulderL: "ParamLeftShoulderUp",
    shoulderR: "ParamRightShoulderUp"
  };
  function genericCandidates(ch) {
    const table = {
      headPitch: ["ParamAngleX"],
      headYaw: ["ParamAngleY"],
      headRoll: ["ParamAngleZ"],
      eyeLOpen: ["ParamEyeLOpen", "ParamEyeOpenL"],
      eyeROpen: ["ParamEyeROpen", "ParamEyeOpenR"],
      eyeLSmile: ["ParamEyeLSmile"],
      eyeRSmile: ["ParamEyeRSmile"],
      eyeBallX: ["ParamEyeBallX"],
      eyeBallY: ["ParamEyeBallY"],
      browLY: ["ParamBrowLY"],
      browRY: ["ParamBrowRY"],
      browLAngle: ["ParamBrowLAngle"],
      browRAngle: ["ParamBrowRAngle"],
      visemeA: ["ParamA"],
      visemeI: ["ParamI"],
      visemeU: ["ParamU"],
      visemeE: ["ParamE"],
      visemeO: ["ParamO"],
      mouthUp: ["ParamMouthUp", "ParamMouthForm"],
      mouthDown: ["ParamMouthDown"],
      mouthAngry: ["ParamMouthAngry"],
      cheek: ["ParamCheek"],
      bodyPitch: ["ParamBodyAngleX"],
      bodyYaw: ["ParamBodyAngleY"],
      bodyRoll: ["ParamBodyAngleZ"],
      breath: ["ParamBreath"],
      shoulderL: ["ParamLeftShoulderUp"],
      shoulderR: ["ParamRightShoulderUp"]
    };
    return table[ch] ?? [];
  }
  function discoverProfile(cdi3, modelName = "Unknown") {
    const params = isRecord(cdi3) && Array.isArray(cdi3.Parameters) ? cdi3.Parameters : [];
    const supported = /* @__PURE__ */ new Set();
    const groups = /* @__PURE__ */ new Set();
    for (const p of params) {
      if (p && typeof p.Id === "string") supported.add(p.Id);
      if (p && typeof p.GroupId === "string") groups.add(p.GroupId);
    }
    const channelMap = {};
    for (const ch of STANDARD_CHANNELS) {
      const exact = MAO_CHANNEL_MAP[ch];
      if (exact && supported.has(exact)) {
        channelMap[ch] = exact;
        continue;
      }
      const cand = genericCandidates(ch).find((id) => supported.has(id));
      if (cand) channelMap[ch] = cand;
    }
    return { modelName, supported, channelMap, groups: Array.from(groups) };
  }
  function maoProfile() {
    const channelMap = {};
    const supported = /* @__PURE__ */ new Set();
    for (const ch of STANDARD_CHANNELS) {
      const id = MAO_CHANNEL_MAP[ch];
      if (id) {
        channelMap[ch] = id;
        supported.add(id);
      }
    }
    return { modelName: "Mao", supported, channelMap, groups: [] };
  }
  function resolveParamId(profile, ch) {
    return profile.channelMap[ch];
  }
  function toParamPatches(profile, pose) {
    const out = [];
    for (const ch of STANDARD_CHANNELS) {
      if (!(ch in pose) || pose[ch] === void 0) continue;
      const id = resolveParamId(profile, ch);
      if (!id) continue;
      const [lo, hi] = CHANNEL_RANGES[ch];
      const value = Math.max(lo, Math.min(hi, pose[ch]));
      out.push({ id, value });
    }
    return out;
  }
  function isRecord(x) {
    return typeof x === "object" && x !== null;
  }

  // electron/pet/life/animationMixer.ts
  var LAYER_PRIORITY = {
    base: 0,
    emotion: 1,
    gaze: 2,
    speech: 3,
    action: 4
  };
  var clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  var lerp = (a, b, t) => a + (b - a) * t;
  var AnimationMixer = class {
    layers = /* @__PURE__ */ new Map();
    prev = {};
    blinkAmount = 0;
    opts;
    constructor(opts = {}) {
      this.opts = {
        maxDeltaAngle: opts.maxDeltaAngle ?? 9,
        maxDeltaNorm: opts.maxDeltaNorm ?? 0.28
      };
    }
    setLayer(id, pose, opts = {}) {
      const now = opts.now ?? 0;
      this.layers.set(id, {
        pose,
        weight: opts.weight ?? 1,
        expiresAt: opts.ttlMs === void 0 ? void 0 : now + opts.ttlMs,
        fadeMs: opts.fadeMs,
        bornAt: now
      });
    }
    clearLayer(id) {
      this.layers.delete(id);
    }
    has(id) {
      return this.layers.has(id);
    }
    setBlink(amount) {
      this.blinkAmount = clamp(amount, 0, 1);
    }
    /** action 层当前 envelope（淡入淡出 0~1）；fadeMs<=0 表示无淡变恒为 1 */
    envelope(l, now) {
      const fade = l.fadeMs && l.fadeMs > 0 ? l.fadeMs : null;
      if (!fade) return 1;
      const fadeIn = clamp((now - l.bornAt) / fade, 0, 1);
      const fadeOut = l.expiresAt === void 0 ? 1 : clamp((l.expiresAt - now) / fade, 0, 1);
      return Math.min(fadeIn, fadeOut);
    }
    /** 计算某一帧最终姿态（纯状态推进；now 注入） */
    frame(now) {
      for (const [id, l] of Array.from(this.layers)) {
        if (l.expiresAt !== void 0 && now >= l.expiresAt) this.layers.delete(id);
      }
      const ordered = Object.keys(LAYER_PRIORITY).filter((id) => this.layers.has(id)).sort((a, b) => LAYER_PRIORITY[a] - LAYER_PRIORITY[b]);
      const out = {};
      const channels = Object.keys(CHANNEL_RANGES);
      for (const ch of channels) {
        let acc;
        for (const id of ordered) {
          const l = this.layers.get(id);
          const val = l.pose[ch];
          if (val === void 0) continue;
          let w = clamp(l.weight, 0, 1);
          if (id === "action") w *= this.envelope(l, now);
          if (w <= 1e-3) continue;
          acc = acc === void 0 ? val : lerp(acc, val, w);
        }
        if (acc !== void 0) out[ch] = acc;
      }
      if (this.blinkAmount > 0) {
        const k = 1 - this.blinkAmount;
        out.eyeLOpen = (out.eyeLOpen ?? 1) * k;
        out.eyeROpen = (out.eyeROpen ?? 1) * k;
      }
      const result = {};
      for (const ch of channels) {
        if (!(ch in out)) continue;
        const [lo, hi] = CHANNEL_RANGES[ch];
        const target = clamp(out[ch], lo, hi);
        const prevVal = this.prev[ch];
        if (prevVal === void 0) {
          result[ch] = target;
        } else {
          const span = hi - lo;
          const isAngle = span > 3;
          const maxD = isAngle ? this.opts.maxDeltaAngle : this.opts.maxDeltaNorm;
          const d = clamp(target - prevVal, -maxD, maxD);
          result[ch] = clamp(prevVal + d, lo, hi);
        }
      }
      this.prev = result;
      return result;
    }
    reset() {
      this.layers.clear();
      this.prev = {};
      this.blinkAmount = 0;
    }
  };

  // electron/pet/life/faceRig.ts
  var clamp01 = (x) => Math.max(0, Math.min(1, x));
  var clamp2 = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  function poseForEmotion(core) {
    const v = core.valence;
    const a = core.arousal;
    const fatigue = core.fatigue;
    const anxiety = core.anxiety;
    const eyeOpen = clamp2(0.6 + a * 0.55 - fatigue * 0.55, 0.05, 1.25);
    const eyeSmile = v > 0.3 ? clamp01((v - 0.2) * 0.9) : 0;
    const smile = v > 0.12 ? clamp01((v - 0.12) * 1.05) : 0;
    const frown = v < -0.1 ? clamp01((-v - 0.1) * 1) : 0;
    const browRaise = a > 0.62 ? clamp01((a - 0.62) * 1.6) : 0;
    const browDroop = v < -0.25 || fatigue > 0.6 ? clamp01(Math.max(-v - 0.1, fatigue - 0.4) * 0.8) : 0;
    const browY = browRaise * 0.8 - browDroop * 0.7;
    const browAngle = clamp01(anxiety * 0.9 + (v < -0.4 ? 0.3 : 0));
    const cheek = clamp01(v * a * 0.55);
    const headPitch = clamp2((v < 0 ? -v * 14 : 0) - (a > 0.85 ? 6 : 0), -12, 16);
    const headRoll = clamp2(v * 7, -9, 9);
    const bodyRoll = headRoll * 0.35;
    const shoulder = clamp01(anxiety * 0.5 + (a > 0.92 ? 0.2 : 0));
    return {
      eyeLOpen: eyeOpen,
      eyeROpen: eyeOpen,
      eyeLSmile: eyeSmile,
      eyeRSmile: eyeSmile,
      mouthUp: smile,
      mouthDown: frown,
      browLY: browY,
      browRY: browY,
      browLAngle: browAngle,
      browRAngle: browAngle,
      cheek,
      headPitch,
      headRoll,
      bodyRoll,
      shoulderL: shoulder,
      shoulderR: shoulder
    };
  }
  function visemePose(viseme, open = 1) {
    const o = clamp01(open);
    const base = { visemeA: 0, visemeI: 0, visemeU: 0, visemeE: 0, visemeO: 0, mouthAngry: 0 };
    if (viseme === "rest") return base;
    base[`viseme${viseme}`] = o;
    if (viseme === "U") base.mouthAngry = 0.25 * o;
    return base;
  }
  function gazePose(x, y, headFollow = 0.25) {
    const gx = clamp2(x, -1, 1);
    const gy = clamp2(y, -1, 1);
    return {
      eyeBallX: gx,
      eyeBallY: gy,
      headYaw: gx * 8 * headFollow,
      headPitch: clamp2(-gy * 6 * headFollow, -8, 8)
    };
  }
  function breathPose(phase) {
    const t = (phase % 1 + 1) % 1;
    return { breath: clamp01(0.5 - 0.5 * Math.cos(t * Math.PI * 2)) };
  }

  // electron/pet/life/emotionCore.ts
  var clamp3 = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
  var MOOD_COORDS = {
    "超开心 🎉": { v: 0.95, a: 0.92 },
    "兴奋 🤩": { v: 0.82, a: 0.95 },
    "幸福 💖": { v: 0.8, a: 0.42 },
    "开心 😊": { v: 0.6, a: 0.62 },
    "平静 😐": { v: 0.05, a: 0.4 },
    "闷闷不乐 😕": { v: -0.42, a: 0.38 },
    "低落 😔": { v: -0.62, a: 0.26 },
    "难过 😢": { v: -0.82, a: 0.32 },
    "疲惫 😩": { v: -0.3, a: 0.12 }
  };
  var MOOD_LIST = Object.keys(MOOD_COORDS);
  function normalizeMood(raw) {
    if (typeof raw !== "string") return null;
    const t = raw.trim();
    if (!t) return null;
    if (MOOD_LIST.includes(t)) return t;
    const table = [
      ["超开心 🎉", ["超开心", "超级开心"]],
      ["兴奋 🤩", ["兴奋", "激动"]],
      ["幸福 💖", ["幸福", "满足", "安心", "温馨"]],
      ["开心 😊", ["开心", "高兴", "快乐", "愉快"]],
      ["平静 😐", ["平静", "一般", "正常", "中性"]],
      ["闷闷不乐 😕", ["闷闷不乐", "郁闷", "不开心", "烦"]],
      ["低落 😔", ["低落", "失落", "沮丧", "委屈"]],
      ["难过 😢", ["难过", "伤心", "哭", "悲伤"]],
      ["疲惫 😩", ["疲惫", "累", "困", "倦", "无力"]]
    ];
    for (const [label, keys] of table) {
      if (keys.some((k) => t.includes(k))) return label;
    }
    return null;
  }
  function moodToCore(label, affinity = 0.5) {
    const { v, a } = MOOD_COORDS[label];
    return {
      valence: v,
      arousal: a,
      joy: clamp3((v + 1) / 2),
      fatigue: label === "疲惫 😩" ? 0.85 : clamp3(1 - a * 1.1),
      focus: label === "平静 😐" ? 0.65 : clamp3(a * 0.6 + 0.25),
      anxiety: v < -0.4 ? clamp3(-v * (0.5 + a * 0.4)) : clamp3(a > 0.85 ? 0.2 : 0.08),
      curiosity: a > 0.8 ? 0.85 : clamp3(a * 0.7),
      affinity: clamp3(affinity)
    };
  }

  // electron/pet/life/lipsync.ts
  var CN_VOWEL = {
    啊: "A",
    呀: "A",
    哇: "A",
    哈: "A",
    啦: "A",
    嘛: "A",
    吧: "A",
    吗: "A",
    哪: "A",
    嘎: "A",
    吖: "A",
    哒: "A",
    咦: "I",
    嘻: "I",
    咿: "I",
    咪: "I",
    希: "I",
    呜: "U",
    呼: "U",
    咕: "U",
    噜: "U",
    噗: "U",
    唔: "U",
    乌: "U",
    诶: "E",
    嘿: "E",
    欸: "E",
    哦: "O",
    噢: "O",
    喔: "O",
    啵: "O",
    咯: "O"
  };
  var CN_DIPHTHONG = {
    喵: ["I", "A"]
  };
  var LATIN_VOWEL = {
    a: "A",
    e: "E",
    i: "I",
    o: "O",
    u: "U",
    y: "I",
    ä: "E",
    ö: "O",
    ü: "U"
  };
  var SHORT_PAUSE = /* @__PURE__ */ new Set(["，", "、", ",", "；", ";"]);
  var LONG_PAUSE = /* @__PURE__ */ new Set(["。", ".", "！", "!", "？", "?", "…", "\n"]);
  function tokenize(text, charMs, shortPauseMs, longPauseMs) {
    const tokens = [];
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (LONG_PAUSE.has(ch)) {
        tokens.push({ kind: "pause", dur: longPauseMs });
        continue;
      }
      if (SHORT_PAUSE.has(ch)) {
        tokens.push({ kind: "pause", dur: shortPauseMs });
        continue;
      }
      if (/\s/.test(ch)) {
        tokens.push({ kind: "pause", dur: charMs * 0.4 });
        continue;
      }
      if (CN_DIPHTHONG[ch]) {
        for (const v of CN_DIPHTHONG[ch]) tokens.push({ kind: "viseme", viseme: v, dur: charMs * 0.7 });
        continue;
      }
      if (CN_VOWEL[ch]) {
        tokens.push({ kind: "viseme", viseme: CN_VOWEL[ch], dur: charMs });
        continue;
      }
      const lower = ch.toLowerCase();
      if (LATIN_VOWEL[lower]) {
        tokens.push({ kind: "viseme", viseme: LATIN_VOWEL[lower], dur: charMs });
        continue;
      }
      if (/[a-z]/.test(lower)) {
        tokens.push({ kind: "close", dur: charMs * 0.55 });
        continue;
      }
      if (/[\u4e00-\u9fff]/.test(ch)) {
        tokens.push({ kind: "viseme", viseme: "A", dur: charMs * 0.8 });
        continue;
      }
    }
    return tokens;
  }
  function textToVisemeSegments(text, opts = {}) {
    const charMs = opts.charMs ?? 120;
    const shortPauseMs = opts.shortPauseMs ?? 170;
    const longPauseMs = opts.longPauseMs ?? 320;
    const tokens = tokenize(text ?? "", charMs, shortPauseMs, longPauseMs);
    const segs = [];
    let t = 0;
    for (const tok of tokens) {
      if (tok.kind === "pause") {
        segs.push({ viseme: "rest", start: t, end: t + tok.dur, open: 0 });
        t += tok.dur;
      } else if (tok.kind === "close") {
        segs.push({ viseme: "rest", start: t, end: t + tok.dur, open: 0 });
        t += tok.dur;
      } else {
        const lead = charMs * 0.12;
        segs.push({ viseme: "rest", start: t, end: t + lead, open: 0 });
        t += lead;
        segs.push({ viseme: tok.viseme, start: t, end: t + tok.dur, open: 1 });
        t += tok.dur;
      }
    }
    return segs;
  }
  function sampleViseme(segs, atMs) {
    for (const s of segs) {
      if (atMs >= s.start && atMs < s.end) return { viseme: s.viseme, open: s.open };
    }
    return { viseme: "rest", open: 0 };
  }
  function opennessFromRms(level, prev = 0, opts) {
    const min = opts?.min ?? 0.05;
    const max = opts?.max ?? 1;
    const attack = opts?.attack ?? 0.55;
    const release = opts?.release ?? 0.28;
    const target = Math.max(min, Math.min(max, level)) * (level > 0.02 ? 1 : 0);
    const k = target > prev ? attack : release;
    return prev + (target - prev) * k;
  }

  // electron/pet/life/performanceDsl.ts
  var BUILTIN_GESTURES = [
    "wave",
    "nod",
    "shake",
    "think",
    "clap",
    "dance",
    "happy",
    "surprised",
    "idle",
    "sleep",
    "wake",
    "walk"
  ];
  var PARAMETRIC_GESTURES = [
    "shrug",
    "tilt",
    "spread_hands",
    "point",
    "look_around",
    "bounce",
    "sad",
    "angry"
  ];
  var GESTURE_WHITELIST = /* @__PURE__ */ new Set([...BUILTIN_GESTURES, ...PARAMETRIC_GESTURES]);
  var EFFECT_WHITELIST = /* @__PURE__ */ new Set([
    "heart",
    "sparkle",
    "stars",
    "aura",
    "heal",
    "smoke",
    "ink",
    "rabbit"
  ]);
  var BASIC_EXPRESSIONS = ["neutral", "happy", "sad", "angry", "surprised", "shy", "thinking", "sleepy"];
  var clamp4 = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  var isObj = (x) => typeof x === "object" && x !== null;
  function asGazeTarget(x) {
    return typeof x === "string" && ["user", "away", "up", "down", "left", "right"].includes(x) ? x : void 0;
  }
  function parsePerformance(input) {
    const errors = [];
    if (!isObj(input)) return { ok: false, command: null, errors: ["performance 必须是对象"] };
    const command = { durationMs: 1200, blend: "override" };
    if (input.expression !== void 0) {
      const mood = normalizeMood(input.expression);
      if (mood) command.expression = mood;
      else if (typeof input.expression === "string" && BASIC_EXPRESSIONS.includes(input.expression))
        command.expression = input.expression;
      else errors.push(`未知 expression: ${String(input.expression)}`);
    }
    if (input.gaze !== void 0) {
      if (isObj(input.gaze)) {
        const g = {};
        const t = asGazeTarget(input.gaze.target);
        if (input.gaze.target !== void 0 && !t) errors.push(`未知 gaze.target: ${String(input.gaze.target)}`);
        if (t) g.target = t;
        if (typeof input.gaze.x === "number") g.x = clamp4(input.gaze.x, -1, 1);
        if (typeof input.gaze.y === "number") g.y = clamp4(input.gaze.y, -1, 1);
        if (g.target !== void 0 || g.x !== void 0 || g.y !== void 0) command.gaze = g;
      } else errors.push("gaze 必须是对象");
    }
    const rawGesture = typeof input.gesture === "string" ? { name: input.gesture } : input.gesture;
    if (rawGesture !== void 0) {
      if (isObj(rawGesture) && typeof rawGesture.name === "string") {
        const name = rawGesture.name;
        if (GESTURE_WHITELIST.has(name)) {
          command.gesture = {
            name,
            intensity: typeof rawGesture.intensity === "number" ? clamp4(rawGesture.intensity, 0, 1) : 1,
            builtin: BUILTIN_GESTURES.includes(name)
          };
        } else errors.push(`手势不在白名单: ${name}`);
      } else if (input.gesture !== void 0) errors.push("gesture 必须是字符串或 {name,intensity}");
    }
    if (input.headTilt !== void 0) {
      if (typeof input.headTilt === "number") command.headTilt = clamp4(input.headTilt, -1, 1);
      else errors.push("headTilt 必须是数字");
    }
    if (input.motion !== void 0) {
      if (typeof input.motion === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(input.motion)) command.motion = input.motion;
      else errors.push(`非法 motion: ${String(input.motion)}`);
    }
    const rawEffect = typeof input.effect === "string" ? { name: input.effect } : input.effect;
    if (rawEffect !== void 0) {
      if (isObj(rawEffect) && typeof rawEffect.name === "string") {
        const name = rawEffect.name;
        if (EFFECT_WHITELIST.has(name))
          command.effect = { name, amount: typeof rawEffect.amount === "number" ? clamp4(rawEffect.amount, 0, 1) : 0.8 };
        else errors.push(`特效不在白名单: ${name}`);
      } else if (input.effect !== void 0) errors.push("effect 必须是字符串或 {name,amount}");
    }
    if (typeof input.durationMs === "number") command.durationMs = clamp4(Math.round(input.durationMs), 300, 6e3);
    if (input.blend === "add" || input.blend === "override") command.blend = input.blend;
    const hasAny = ["expression", "gaze", "gesture", "headTilt", "motion", "effect"].some((k) => command[k] !== void 0);
    if (!hasAny) return { ok: false, command: null, errors: [...errors, "performance 没有任何有效字段"] };
    return { ok: true, command, errors };
  }
  function safePerformance(input) {
    const r = parsePerformance(input);
    return r.ok ? r.command : null;
  }

  // electron/pet/life/alphaTrim.ts
  function scanAlphaBounds(rgba, bw, bh, opts = {}) {
    if (!rgba || bw <= 0 || bh <= 0) return null;
    const step = Math.max(1, Math.round(opts.step ?? 2));
    const ALPHA = opts.alphaThreshold ?? 28;
    const cap = opts.maxSide ?? 0.45;
    let minX = bw, minY = bh, maxX = -1, maxY = -1;
    for (let sy = 0; sy < bh; sy += step) {
      const row = bh - 1 - sy;
      const rowBase = row * bw * 4;
      for (let sx = 0; sx < bw; sx += step) {
        const a = rgba[rowBase + sx * 4 + 3];
        if (a > ALPHA) {
          if (sx < minX) minX = sx;
          if (sx > maxX) maxX = sx;
          if (sy < minY) minY = sy;
          if (sy > maxY) maxY = sy;
        }
      }
    }
    if (maxX < 0) return null;
    const l = Math.min(cap, Math.max(0, (minX - step) / bw));
    const r = Math.min(cap, Math.max(0, (bw - 1 - maxX - step) / bw));
    const t = Math.min(cap, Math.max(0, (minY - step) / bh));
    const b = Math.min(cap, Math.max(0, (bh - 1 - maxY - step) / bh));
    return { l, t, r, b };
  }

  // electron/pet/life/runtime.ts
  var clamp012 = (x) => Math.max(0, Math.min(1, x));
  function parametricGesture(name, intensity) {
    const i = clamp012(intensity);
    switch (name) {
      case "shrug":
        return { shoulderL: i, shoulderR: i, headRoll: 4 * i };
      case "tilt":
        return { headRoll: 14 * i };
      case "sad":
        return { headPitch: 8 * i, browLAngle: 0.6 * i, browRAngle: 0.6 * i, mouthDown: 0.5 * i };
      case "angry":
        return { browLAngle: 0.8 * i, browRAngle: 0.8 * i, mouthAngry: 0.5 * i, headPitch: -4 * i };
      default:
        return {};
    }
  }
  var PetPerformanceEngine = class {
    profile;
    mixer = new AnimationMixer({ maxDeltaAngle: 12, maxDeltaNorm: 0.4 });
    emo;
    segs = [];
    speakStart = 0;
    speaking = false;
    audioOpen = 0;
    speechLevel = 0;
    levelMode = false;
    autoBlink = true;
    nextBlinkAt = 2200;
    blinkStart = -1;
    /** 可替换的随机源（测试确定性） */
    random = Math.random;
    constructor(cdi3, modelName = "Mao") {
      this.profile = cdi3 ? discoverProfile(cdi3, modelName) : maoProfile();
      this.emo = moodToCore("平静 😐");
      this.mixer.setLayer("emotion", poseForEmotion(this.emo), { weight: 1, now: 0 });
    }
    loadCdi3(cdi3, name = "Mao") {
      this.profile = discoverProfile(cdi3, name);
    }
    setBlinkEnabled(on) {
      this.autoBlink = on;
    }
    setMood(labelOrCore, now = 0) {
      if (typeof labelOrCore === "object" && labelOrCore !== null) {
        this.emo = labelOrCore;
      } else {
        this.emo = moodToCore(normalizeMood(labelOrCore) ?? "平静 😐");
      }
      this.mixer.setLayer("emotion", poseForEmotion(this.emo), { weight: 1, now });
    }
    /** 临时视线（DSL/表演用；持续跟随仍由渲染层 focusController 负责） */
    setGaze(x, y, now, ttlMs = 1200) {
      this.mixer.setLayer("gaze", gazePose(x, y, 0.6), { weight: 0.6, ttlMs, now, fadeMs: 220 });
    }
    /** 文本驱动五元音口型（startNow 为该句音频起点 ms） */
    speak(text, startNow) {
      this.segs = textToVisemeSegments(text);
      this.speakStart = startNow;
      this.speaking = this.segs.length > 0;
      this.levelMode = false;
      this.speechLevel = 0;
    }
    /**
     * 接入真实播放音频的实时电平（AnalyserNode RMS）：
     * 元音形状仍按文本，张度改由真实语音能量驱动、停顿自动闭合。
     */
    setSpeechLevel(level) {
      if (!this.speaking) return;
      this.levelMode = true;
      this.speechLevel = clamp012(level);
    }
    isSpeaking(now) {
      if (!this.speaking) return false;
      const last = this.segs[this.segs.length - 1];
      return now - this.speakStart <= (last?.end ?? 0) + 200;
    }
    stopSpeak(now) {
      this.speaking = false;
      this.segs = [];
      this.levelMode = false;
      this.speechLevel = 0;
      this.mixer.clearLayer("speech");
      void now;
    }
    /** 只有实时音频电平（无文本/音素）时，按能量张合嘴（默认 A 元音） */
    setAudioLevel(level, now) {
      this.audioOpen = opennessFromRms(clamp012(level), this.audioOpen);
      if (this.speaking) return;
      if (this.audioOpen > 0.05) {
        this.mixer.setLayer("speech", visemePose("A", this.audioOpen), { weight: 1, now });
      } else {
        this.mixer.clearLayer("speech");
      }
    }
    /** 执行一条高层表演指令；返回需要渲染层补做的事（内置动作/特效/motion） */
    perform(input, now) {
      const cmd = safePerformance(input);
      if (!cmd) return {};
      const hints = {};
      if (cmd.expression) {
        const m = normalizeMood(cmd.expression);
        if (m) this.setMood(m, now);
      }
      if (cmd.gaze) {
        const tx = cmd.gaze.x ?? gazeTargetX(cmd.gaze.target);
        const ty = cmd.gaze.y ?? gazeTargetY(cmd.gaze.target);
        this.setGaze(tx, ty, now, cmd.durationMs);
      }
      const actionPose = {};
      if (cmd.headTilt !== void 0) actionPose.headRoll = cmd.headTilt * 12;
      if (cmd.gesture && !cmd.gesture.builtin) {
        Object.assign(actionPose, parametricGesture(cmd.gesture.name, cmd.gesture.intensity));
      }
      if (Object.keys(actionPose).length) {
        this.mixer.setLayer("action", actionPose, { weight: 1, ttlMs: cmd.durationMs, now, fadeMs: 200 });
      }
      if (cmd.gesture) {
        hints.gesture = cmd.gesture.name;
        hints.builtin = cmd.gesture.builtin;
      }
      if (cmd.effect) hints.effect = cmd.effect;
      if (cmd.motion) hints.motion = cmd.motion;
      return hints;
    }
    /** 每帧推进，返回可直接 setParameterValueById 的参数补丁 */
    update(now) {
      this.mixer.setLayer("base", breathPose(now / 4e3), { weight: 1, now });
      if (this.autoBlink) {
        if (this.blinkStart < 0 && now >= this.nextBlinkAt) {
          this.blinkStart = now;
          this.nextBlinkAt = now + 1800 + this.random() * 3200;
        }
        if (this.blinkStart >= 0) {
          const t = now - this.blinkStart;
          let amount = 0;
          if (t < 70) amount = t / 70;
          else if (t < 150) amount = 1;
          else if (t < 220) amount = 1 - (t - 150) / 70;
          else {
            this.blinkStart = -1;
            amount = 0;
          }
          this.mixer.setBlink(clamp012(amount));
        }
      }
      if (this.speaking) {
        const at = now - this.speakStart;
        const lastEnd = this.segs[this.segs.length - 1]?.end ?? 0;
        if (at > lastEnd + 200) {
          this.stopSpeak(now);
        } else {
          const s = sampleViseme(this.segs, at);
          const open = this.levelMode ? this.speechLevel : s.open;
          this.mixer.setLayer("speech", visemePose(s.viseme, open), { weight: 1, now });
        }
      }
      const pose = this.mixer.frame(now);
      return toParamPatches(this.profile, pose);
    }
  };
  function gazeTargetX(t) {
    if (t === "left") return -0.8;
    if (t === "right") return 0.8;
    if (t === "user") return 0;
    return 0;
  }
  function gazeTargetY(t) {
    if (t === "up") return -0.6;
    if (t === "down") return 0.6;
    return 0;
  }
  return __toCommonJS(runtime_exports);
})();
