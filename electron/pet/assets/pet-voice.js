"use strict";
var LuminaVoice = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // electron/pet/lifeSpeech/voiceClient.ts
  var voiceClient_exports = {};

  // electron/pet/lifeSpeech/fullDuplexController.ts
  function cleanSpokenReply(raw) {
    if (!raw) return "";
    let t = String(raw);
    t = t.replace(/```[\s\S]*?```/g, "，");
    t = t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
    t = t.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, " ");
    t = t.replace(/【[^】]*】/g, "");
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s*[-*+]\s+/gm, "");
    t = t.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
    return t;
  }
  var FullDuplexController = class {
    bridge;
    enabled = false;
    /** 最近一次从导演拿到的代际（过期响应据此丢弃） */
    latestGen = 0;
    /** 打断序号：每次 cancel_speech 自增，让正在逐句播放的动作循环立即作废 */
    speechSeq = 0;
    /** 当前执行中的代际（用于打断后让进行中的 TTS/LLM 放弃） */
    running = Promise.resolve();
    constructor(bridge) {
      this.bridge = bridge;
    }
    setEnabled(on) {
      this.enabled = on;
      if (on) {
        this.bridge.onState?.("listening");
      } else {
        this.speechSeq++;
        this.bridge.cancelSpeech();
        this.bridge.onState?.("idle");
        this.sendEvent({ type: "reset" }).catch(() => {
        });
      }
    }
    isEnabled() {
      return this.enabled;
    }
    /** VAD/STT 检测到用户开始说话（AI 在说则打断） */
    async userStarted() {
      if (!this.enabled) return;
      const r = await this.sendEvent({ type: "user_start" });
      await this.runActions(r.actions);
    }
    /** 识别到中间结果（仅做 UI 提示，不进状态机） */
    partial(text) {
      if (!this.enabled) return;
      this.bridge.onPartial?.(text);
    }
    /** 一句话识别完成 */
    async userUtterance(text) {
      if (!this.enabled) return;
      const t = (text || "").trim();
      if (!t) {
        const r2 = await this.sendEvent({ type: "user_utterance", text: "" });
        await this.runActions(r2.actions);
        return;
      }
      const r = await this.sendEvent({ type: "user_utterance", text: t });
      this.running = this.runActions(r.actions);
      await this.running;
    }
    /** 手动重置 */
    async reset() {
      this.speechSeq++;
      this.bridge.cancelSpeech();
      const r = await this.sendEvent({ type: "reset" });
      this.latestGen = r.generation;
      if (this.enabled) this.bridge.onState?.("listening");
    }
    async sendEvent(params) {
      const r = await this.bridge.sendEvent(params);
      if (typeof r.generation === "number") this.latestGen = r.generation;
      return r;
    }
    /** 该代际是否已被新发言作废 */
    stale(gen) {
      return gen !== this.latestGen;
    }
    async runActions(actions) {
      const seq = this.speechSeq;
      for (const a of actions) {
        if (a.type === "cancel_speech") {
          this.speechSeq++;
          this.bridge.cancelSpeech();
          continue;
        }
        if (a.type === "start_listening") {
          this.bridge.onState?.("listening");
          continue;
        }
        if (a.type === "stop_listening") {
          this.bridge.onState?.("thinking");
          continue;
        }
        if (a.type === "call_llm") {
          await this.runLlm(a.text, a.generation, seq);
          if (this.speechSeq !== seq) return;
          continue;
        }
        if (a.type === "enqueue_speak") {
          await this.runSpeak(a.text, a.generation, seq);
          if (this.speechSeq !== seq) return;
          continue;
        }
      }
    }
    async runLlm(text, gen, seq) {
      this.bridge.onState?.("thinking");
      let reply = "";
      try {
        reply = await this.bridge.callLlm(text, gen);
      } catch (e) {
        this.bridge.onError?.(e?.message || "对话失败");
        return;
      }
      if (this.stale(gen) || this.speechSeq !== seq) return;
      reply = cleanSpokenReply(reply);
      if (!reply) {
        this.bridge.onState?.("listening");
        return;
      }
      const r1 = await this.sendEvent({ type: "assistant_chunk", text: reply, generation: gen });
      if (this.stale(gen) || this.speechSeq !== seq) return;
      const r2 = await this.sendEvent({ type: "assistant_end", generation: gen });
      if (this.stale(gen) || this.speechSeq !== seq) return;
      await this.runActions([...r1.actions, ...r2.actions]);
    }
    async runSpeak(text, gen, seq) {
      if (this.stale(gen) || this.speechSeq !== seq) return;
      this.bridge.onState?.("speaking");
      try {
        await this.bridge.speakSentence(text, gen);
      } catch {
      }
      if (this.stale(gen) || this.speechSeq !== seq) return;
      const r = await this.sendEvent({ type: "sentence_spoken" });
      await this.runActions(r.actions);
    }
  };

  // electron/pet/lifeSpeech/voiceClient.ts
  var electron = (typeof __require === "function" ? __require("electron") : window.electron) || {};
  var ipc = electron.ipcRenderer || null;
  function downsampleTo16k(input, inRate) {
    if (inRate === 16e3) return input;
    const ratio = inRate / 16e3;
    const newLen = Math.round(input.length / ratio);
    const out = new Float32Array(newLen);
    let oPos = 0;
    for (let i = 0; i < newLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(input.length - 1, i0 + 1);
      const frac = pos - i0;
      out[oPos++] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }
  function encodeWav16k(pcm, sampleRate = 16e3) {
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buf);
    const writeStr = (off2, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off2 + i, s.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + pcm.length * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, pcm.length * 2, true);
    let off = 44;
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      view.setInt16(off, s < 0 ? s * 32768 : s * 32767, true);
      off += 2;
    }
    let binary = "";
    const bytes = new Uint8Array(buf);
    const CHUNK = 32768;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  }
  var VoiceClient = class {
    opts = { ttsEngine: "edge-tts", volume: 100, spatial: true, lang: "zh-CN", whisperModel: "Xenova/whisper-base" };
    hooks = {};
    controller = null;
    running = false;
    sttMode = "off";
    // ── TTS ──
    audioCtx = null;
    currentSrc = null;
    ttsToken = 0;
    synthAbort = null;
    // ── Web Speech ──
    recognition = null;
    restarting = false;
    // ── 本地 mic VAD ──
    micStream = null;
    micCtx = null;
    micNode = null;
    setOptions(o) {
      this.opts = { ...this.opts, ...o };
    }
    isRunning() {
      return this.running;
    }
    // ─────────────────────────────────────────────
    start(opts = {}, hooks = {}) {
      this.opts = { ...this.opts, ...opts };
      this.hooks = hooks;
      if (this.running) return;
      this.running = true;
      this.controller = new FullDuplexController({
        sendEvent: async (p) => {
          if (!ipc) return { actions: [], generation: 0, queueSize: 0 };
          return ipc.invoke("pet:live-speech:event", p);
        },
        callLlm: async (text) => {
          const r = await ipc.invoke("pet:voice-chat", { text });
          if (!r || !r.ok) throw new Error(r?.error || "语音对话失败");
          return r.text || "";
        },
        speakSentence: (text) => this.speak(text),
        cancelSpeech: () => this.cancelSpeech(),
        onState: (s) => this.hooks.onState?.(s),
        onPartial: (t) => this.hooks.onPartial?.(t),
        onError: (m) => this.hooks.onError?.(m)
      });
      this.controller.setEnabled(true);
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SR) {
        this.startWebSpeech(SR);
      } else {
        this.hooks.onStatus?.("浏览器不支持在线语音识别，切换本地语音…", "warn");
        this.startLocalMic();
      }
    }
    stop() {
      if (!this.running) return;
      this.running = false;
      try {
        this.controller?.setEnabled(false);
      } catch {
      }
      try {
        this.recognition?.stop();
      } catch {
      }
      try {
        this.recognition?.abort?.();
      } catch {
      }
      this.stopMic();
      this.cancelSpeech();
      this.hooks.onState?.("idle");
    }
    // ── Web Speech 流式识别 ──────────────────────────
    startWebSpeech(SR) {
      if (!this.running) return;
      this.sttMode = "web";
      const rec = new SR();
      this.recognition = rec;
      rec.lang = this.opts.lang || "zh-CN";
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      let firedStart = false;
      rec.onstart = () => {
        this.hooks.onStatus?.("全双工已开启（在线流式识别）", "info");
      };
      rec.onaudiostart = () => {
      };
      rec.onresult = (e) => {
        let interim = "";
        let finalText = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        const heard = (finalText || interim).trim();
        if (heard && !firedStart) {
          firedStart = true;
          this.controller?.userStarted().catch(() => {
          });
        }
        if (interim) this.controller?.partial(interim);
        if (finalText.trim()) {
          this.controller?.userUtterance(finalText.trim()).catch(() => {
          });
          firedStart = false;
        }
      };
      rec.onerror = (e) => {
        const err = e?.error || "";
        if (err === "no-speech" || err === "aborted") return;
        if (err === "network" || err === "service-not-allowed" || err === "not-allowed" || err === "audio-capture" || err === "language-not-supported") {
          if (this.sttMode === "web") {
            this.hooks.onStatus?.("在线语音识别不可用（" + err + "），切换本地识别…", "warn");
            try {
              rec.abort?.();
            } catch {
            }
            this.startLocalMic();
          }
        }
      };
      rec.onend = () => {
        if (this.running && this.sttMode === "web") {
          this.restarting = true;
          setTimeout(() => {
            if (this.running && this.sttMode === "web") {
              try {
                rec.start();
              } catch {
              }
            }
            this.restarting = false;
          }, 180);
        }
      };
      try {
        rec.start();
      } catch (e) {
        this.hooks.onStatus?.("在线识别启动失败，切换本地识别…", "warn");
        this.startLocalMic();
      }
    }
    // ── 本地麦克风：能量 VAD 切句 → Whisper 离线识别 ─────
    startLocalMic() {
      if (!this.running) return;
      this.sttMode = "local";
      const constraints = {
        audio: this.opts.micDevice ? { deviceId: { exact: this.opts.micDevice } } : true
      };
      navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
        if (!this.running || this.sttMode !== "local") {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        this.micStream = stream;
        const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16e3 });
        this.micCtx = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const inRate = ctx.sampleRate || 16e3;
        const node = ctx.createScriptProcessor(4096, 1, 1);
        this.micNode = node;
        const collect = [];
        let speaking = false;
        let silenceMs = 0;
        let speechMs = 0;
        let noiseFloor = 0.01;
        let lastT = Date.now();
        const FRAME_MS = 4096 / inRate * 1e3;
        const finish = () => {
          if (!speaking) {
            collect.length = 0;
            return;
          }
          const total = collect.reduce((n, c) => n + c.length, 0);
          const merged = new Float32Array(total);
          let p = 0;
          for (const c of collect) {
            merged.set(c, p);
            p += c.length;
          }
          collect.length = 0;
          speaking = false;
          speechMs = 0;
          silenceMs = 0;
          if (total < inRate * 0.3) return;
          const pcm = downsampleTo16k(merged, inRate);
          const b64 = encodeWav16k(pcm);
          this.hooks.onStatus?.("本地识别中…", "info");
          ipc.invoke("pet:transcribe-utterance", { audioBase64: b64, model: this.opts.whisperModel }).then((r) => {
            if (r && r.ok && r.text) {
              this.hooks.onPartial?.(r.text);
              this.controller?.userUtterance(r.text).catch(() => {
              });
            } else if (r && r.missingDependency) {
              this.hooks.onError?.("本地语音模型未安装（@xenova/transformers / whisper-base），请在设置中安装或改用在线识别。");
            } else {
              this.hooks.onStatus?.("没听清，可以再说一次～", "info");
            }
          }).catch(() => {
          });
        };
        node.onaudioprocess = (ev) => {
          if (!this.running || this.sttMode !== "local") return;
          const chunk = ev.inputBuffer.getChannelData(0);
          const now = Date.now();
          let sum = 0;
          for (let i = 0; i < chunk.length; i += 4) {
            const v = chunk[i];
            sum += v * v;
          }
          const rms = Math.sqrt(sum / (chunk.length / 4));
          if (!speaking) noiseFloor = noiseFloor * 0.98 + Math.min(noiseFloor, rms) * 0.02;
          const threshold = Math.max(0.012, noiseFloor * 3.5);
          if (rms > threshold) {
            if (!speaking) {
              speaking = true;
              speechMs = 0;
              this.controller?.userStarted().catch(() => {
              });
            }
            silenceMs = 0;
            speechMs += FRAME_MS;
            collect.push(chunk.slice(0));
          } else if (speaking) {
            silenceMs += FRAME_MS;
            speechMs += FRAME_MS;
            collect.push(chunk.slice(0));
            if (silenceMs >= 700) finish();
            else if (speechMs >= 12e3) finish();
          }
          lastT = now;
        };
        const mute = ctx.createGain();
        mute.gain.value = 0;
        src.connect(node);
        node.connect(mute);
        mute.connect(ctx.destination);
        this.hooks.onStatus?.("全双工已开启（本地识别）", "info");
      }).catch((err) => {
        this.sttMode = "off";
        this.hooks.onError?.("麦克风不可用：" + (err?.message || err));
      });
    }
    stopMic() {
      this.sttMode = "off";
      try {
        this.micNode?.disconnect?.();
      } catch {
      }
      try {
        this.micCtx?.close?.();
      } catch {
      }
      this.micStream?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
        }
      });
      this.micStream = null;
      this.micNode = null;
      this.micCtx = null;
    }
    // ── 句级 TTS：可 await、可被立即打断 ───────────────
    async synth(text, token) {
      const engine = this.opts.ttsEngine || "edge-tts";
      if (engine === "indextts") {
        try {
          this.synthAbort = new AbortController();
          const res = await fetch("http://127.0.0.1:18927/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, lang: "ZH" }),
            signal: this.synthAbort.signal
          });
          if (res.ok) {
            const data = await res.json();
            if (data.audio) {
              const hex = data.audio;
              const bytes = new Uint8Array(hex.length / 2);
              for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
              const blob = new Blob([bytes], { type: "audio/wav" });
              return URL.createObjectURL(blob);
            }
          }
        } catch (e) {
          if (token !== this.ttsToken) throw new Error("cancelled");
        }
      }
      const r = await ipc.invoke("edge-tts:speak", { text });
      if (token !== this.ttsToken) throw new Error("cancelled");
      return r?.audio || "";
    }
    async speak(text) {
      if (!text) return;
      const token = ++this.ttsToken;
      this.cancelPlaybackOnly();
      try {
        const url = await this.synth(text, token);
        if (token !== this.ttsToken || !url) return;
        const ctx = this.ensureAudioCtx();
        const buf = await (await fetch(url)).arrayBuffer();
        const audio = await ctx.decodeAudioData(buf);
        if (token !== this.ttsToken) return;
        await new Promise((resolve) => {
          const src = ctx.createBufferSource();
          src.buffer = audio;
          const gain = ctx.createGain();
          gain.gain.value = (Number(this.opts.volume) || 100) / 100;
          src.connect(gain);
          let out = gain;
          if (this.opts.spatial !== false && ctx.createStereoPanner && window.__petModelX !== void 0 && window.innerWidth) {
            const pan = ctx.createStereoPanner();
            pan.pan.value = Math.max(-0.8, Math.min(0.8, window.__petModelX / window.innerWidth * 2 - 1));
            gain.connect(pan);
            out = pan;
          }
          out.connect(ctx.destination);
          this.currentSrc = src;
          const engine = window.__petLifeEngine;
          try {
            engine?.speak?.(text, performance.now());
          } catch {
          }
          src.onended = () => {
            try {
              engine?.stopSpeak?.(performance.now());
            } catch {
            }
            if (this.currentSrc === src) this.currentSrc = null;
            resolve();
          };
          src.start();
        });
      } catch {
      }
    }
    ensureAudioCtx() {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioCtx.state === "suspended") this.audioCtx.resume().catch(() => {
      });
      return this.audioCtx;
    }
    cancelPlaybackOnly() {
      try {
        this.synthAbort?.abort?.();
      } catch {
      }
      if (this.currentSrc) {
        try {
          this.currentSrc.onended = null;
          this.currentSrc.stop();
        } catch {
        }
        this.currentSrc = null;
      }
      try {
        window.__petLifeEngine?.stopSpeak?.(performance.now());
      } catch {
      }
    }
    cancelSpeech() {
      this.ttsToken++;
      this.cancelPlaybackOnly();
    }
  };
  var client = new VoiceClient();
  window.LuminaVoice = {
    start: (o, h) => client.start(o, h),
    stop: () => client.stop(),
    setOptions: (o) => client.setOptions(o),
    isRunning: () => client.isRunning()
  };
  return __toCommonJS(voiceClient_exports);
})();
