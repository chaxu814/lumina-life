---
layout: home

hero:
  name: LuminaLife
  text: A team of Agents with a body · Multimodal · Full-stack
  tagline: A three-Agent team that lives on your desktop (Lumina / Yak / Recha) — anthropomorphic avatar, real execution, and safety approval — bringing the LLM to life on your desktop and making it actually get work done.
  image:
    src: /logo.png
    alt: LuminaLife
  actions:
    - theme: brand
      text: Quick Start
      link: /FAQ
    - theme: alt
      text: Troubleshooting
      link: /TROUBLESHOOTING
    - theme: alt
      text: GitHub
      link: https://github.com/chaxu814/lumina-life

features:
  - icon: 🖥️
    title: Electron Desktop
    details: Built on Electron 40. Windows 10/11 x64 is the **only platform verified on real hardware**; macOS is marked beta and Linux is on the roadmap. It stays resident in the system tray.
  - icon: 👥
    title: Multi-Agent Team
    details: Lumina (the boss) + Yak (code engineer) + Recha (reviewer). Pipeline delegation, three-perspective adversarial review, dynamic intern hiring, and parallel execution of independent tasks.
  - icon: 😊
    title: Emotion System
    details: 5-dimensional emotion plus continuous mood, energy, and intimacy values, with inertia, random drift, and a circadian rhythm. Intimacy is driven by real delegation events and persisted to disk.
  - icon: 🎭
    title: Five Desktop Pet Forms
    details: Live2D / VRM / PNGTuber / MMD / cat. Facial expressions are driven in real time by model output and can be bound to **real Agent execution state**.
  - icon: 🧠
    title: Real Memory
    details: Three-layer memory (facts / reflections / persona) plus a zero-dependency hybrid recall that fuses BM25 and TF-IDF via RRF, with a source-confidence mechanism that **prevents hallucination hardening**.
  - icon: 🛠️
    title: 139 Tools
    details: Three tiers loaded on demand, with MCP extension support and a skill store.
  - icon: 🛡️
    title: Smart Sandbox
    details: Two-layer security review (message/parameter level + 32 command-level rules), approval flows, permission whitelists, and privacy masking.
  - icon: 🎤
    title: Voice Interaction
    details: Microphone recording + local Whisper ONNX recognition + multi-provider TTS output.
  - icon: 🔄
    title: MCP Integration
    details: Extend tools through the MCP protocol and connect external Agent services.
---

## Project Structure

```
lumina-life/
├── electron/                  # Main process — the Agent engine
│   ├── main.ts                # Entry point (windows, IPC, tray)
│   ├── agentRunner.ts         # Agent main loop (ReAct)
│   ├── delegationManager.ts    # Delegation orchestration + auto-verify/fix loop
│   ├── tools/                  # 139 tools (registry + impl/)
│   ├── team/                  # Team: dynamic hiring / adversarial review / autonomy / teaching
│   ├── orchestration/          # Task board / phase gating / routing / parallel engine
│   ├── memory/                 # Three-layer memory + hybrid recall + anti-hallucination
│   ├── proactive/              # Proactive-speech gating (interruption budget)
│   ├── pet/                    # Desktop pet: five forms + sprite sheets + state bridge
│   ├── security/               # Two-layer security review
│   └── core/platform/          # Windows / macOS / Linux adaptation layer
├── src/                       # Renderer process (React 19 + Zustand)
├── tests/                     # 310 files / 4632 cases (Vitest)
├── agents/                    # Config for the three Agents (tool allow/deny lists)
├── skills/                    # Skill directory
├── docs/                      # Documentation site (VitePress)
└── package.json
```

## Feature Overview

| Module | Status | Notes |
|------|------|------|
| Basic chat | ✅ | Multi-provider LLM (LM Studio / Ollama / cloud APIs), streaming output |
| Three-Agent team | ✅ | Pipeline delegation + three-perspective adversarial review + dynamic hiring + parallel independent tasks |
| Five desktop pet forms | ✅ | Live2D / VRM / PNGTuber / MMD / cat |
| Pet bound to Agent state | ✅ | Types while coding, frowns while reviewing, covers its face on failure; zero LLM overhead |
| Sprite sheet UGC | ✅ | 8×9 spec + AI-generated prompts + import validator |
| Long-term memory | ✅ | Three layers + BM25/TF-IDF RRF hybrid recall + anti-hallucination hardening + evidence chain |
| Proactive speech | ✅ | Gating + quota + backoff + do-not-disturb at night + energy floor |
| Computer Use | ✅ | Screenshot / OCR / mouse & keyboard / UIA element tree / privacy masking |
| Security sandbox | ✅ | Two-layer review (26 command rules) + approval flow + permission whitelist |
| Tool system | ✅ | 139 tools, three tiers loaded on demand + MCP + skill store |
| Desktop automation | ✅ | Cross-platform adaptation layer (**verified on Windows only**) |
| Game companion | ⚠️ Optional extension | Minecraft / Factorio, requires extra plugins |
| Voice input & output | ✅ | Local Whisper ONNX recognition + multi-provider TTS |
| REST API / CLI | ✅ | 10+ endpoints + the `lumina` command line |
| Team social | ✅ | Group chat + Moments feed + morning rituals |
| Scheduled tasks | ✅ | Cron-style scheduling |
| macOS desktop control | ⚠️ beta | Code is adapted, **never verified on real hardware** |
| Linux | 🔜 | Roadmap (Wayland forbids global mouse/keyboard injection) |
| In-app local inference | 🔜 | Currently requires an external LM Studio |

---

> Questions? Start with the [FAQ](/FAQ) and [Troubleshooting](/TROUBLESHOOTING).
