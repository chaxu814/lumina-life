[English](README.md) | [简体中文](README.zh-CN.md)

<p align="center">
  <img src="https://img.shields.io/badge/Version-0.1.0--preview-ec4899?style=for-the-badge&labelColor=1a1a2e" alt="Version 0.1.0 preview">
  <img src="https://img.shields.io/badge/Agent%20Team-3%20personas-ff6b9d?style=for-the-badge&labelColor=1a1a2e" alt="3-Agent Team">
  <img src="https://img.shields.io/badge/Emotion-3%20continuous%20values%20%C2%B7%205%20expressions-ff4757?style=for-the-badge&labelColor=1a1a2e" alt="Emotion System">
  <img src="https://img.shields.io/badge/Tools-142%20registered%20%2F%20~32--50%20per%20turn-3b82f6?style=for-the-badge&labelColor=1a1a2e" alt="142 tools registered, ~32-50 exposed per turn">
  <img src="https://img.shields.io/badge/Computer%20Use-%E2%9C%85-00d2d3?style=for-the-badge&labelColor=1a1a2e" alt="Computer Use">
  <img src="https://img.shields.io/badge/license-AGPL_3.0_%7C_Apache_2.0-eccc68?style=for-the-badge&labelColor=1a1a2e" alt="License (AGPL-3.0 OR Apache-2.0)">
</p>

<p align="center">
  <a href="#-quality-gates"><img src="https://img.shields.io/badge/tests-4637%20passing%20%2F%20311%20files-4c1?style=flat-square&labelColor=1a1a2e" alt="4637 tests passing across 311 test files"></a>
  <a href="#-quality-gates"><img src="https://img.shields.io/badge/tsc--strict-0%20errors-4c1?style=flat-square&labelColor=1a1a2e" alt="tsc --strict: 0 errors"></a>
  <a href="#-quality-gates"><img src="https://img.shields.io/badge/eslint-0%20errors-4c1?style=flat-square&labelColor=1a1a2e" alt="eslint: 0 errors"></a>
  <a href="#-quality-gates"><img src="https://img.shields.io/badge/CI-3%20OS%20%C3%97%202%20Node-4c1?style=flat-square&labelColor=1a1a2e" alt="CI matrix: 3 OS x 2 Node versions"></a>
  <img src="https://img.shields.io/badge/code-251k%20lines-4c1?style=flat-square&labelColor=1a1a2e" alt="251k lines of code">
</p>

<h1 align="center">
  🌸 Lumina Life
</h1>

<p align="center">
  <b>Your desktop just got a soul.</b>
</p>

<p align="center">
  <b>Three AI agents live on your desktop — they feel, they talk, and they actually do things for you.</b>
</p>

<p align="center">
  <a href="https://github.com/chaxu814/lumina-life/releases/latest"><img src="https://img.shields.io/badge/⬇️_Download_Lumina_Life-Windows_Installer-ec4899?style=for-the-badge&labelColor=1a1a2e" alt="Download the Windows installer"></a>
  <br>
  <sub>Regular users: download the <b>.exe installer</b> (~130 MB) and go · Developers: see <a href="#-quick-start">Quick Start</a> below</sub>
</p>

<br>

<p align="center">
  <a href="#-quick-start"><b>🚀 Quick Start</b></a> ·
  <a href="#-core-features"><b>✨ Core Features</b></a> ·
  <a href="#-why-lumina"><b>💡 Why Lumina?</b></a> ·
  <a href="#-architecture"><b>🏗️ Architecture</b></a> ·
  <a href="#-screenshots"><b>📸 Screenshots</b></a> ·
  <a href="#-roadmap"><b>🗺️ Roadmap</b></a>
</p>

---

## ⚠️ Known Issues (Told Straight, Before Launch)

We don't sweep known issues into the issue tracker. Ahead of our first public release, here is what we **already know and have not yet fixed**:

| Severity | Issue | Impact | Plan |
|---|---|---|---|
| 🟠 | **Validated only on real Windows machines** | macOS/Linux code is adapted but **has never been verified on real hardware**; Computer Use's mouse/keyboard injection and the sandbox rule engine depend heavily on the Windows API | v1.3.0 |
| 🟠 | **IM channels not end-to-end verified on real devices** | 7 adapters are wired up; **only Telegram is on by default**, the rest need you to supply credentials | v1.0 |
| 🟡 | **Test suite is load-sensitive (flaky)** | We fixed a batch of deterministic failures caused by "tests not synced after a source refactor" (5 of them, see Quality Gates below); a few timing tests can still fail intermittently on **slow machines / under concurrency** — the suite no longer claims "always green" | Converging |
| 🟡 | **No in-app local inference** | You need an external LM Studio / Ollama; the app probes for them on launch but **will not auto-install** it | Not planned (see "Why Lumina") |
| 🟡 | **No third-party skill ecosystem** | The skill store channel is open; `electron/skills/` ships **13 example skills** and the root `skills/` ships **7 smart skills**, but **there are no third-party skills to install yet** | Awaiting community |
| 🟡 | **`agentRunner.ts` is a single 4171-line file** (incl. blanks; ~3856 non-blank, measured 2026-10-20) | LLM calls and the ReAct loop are coupled together, which hurts readability for outside contributors (tool-selection has already been split out into its own module) | Refactor after release |
| 🔵 | **5487 ESLint warnings** (3340 of them `no-explicit-any`) | Not a release blocker; managed by a lint ratchet (`lint:ratchet`) that only goes down, never up | Ongoing |
| 🔵 | **Chromium sandbox is `false`** | Renderer-process security is enforced at the **application layer** (rolePolicy + securityGuard + sandboxRules + approval flow), **not** by the browser sandbox; docs have been corrected to reflect this | Clarified |
| 🔵 | **"For You" AI picks depend on a configured model** | With no model configured / offline / budget tightened, it just shows the raw hot list (the fast path) — no errors, no blank panel; you can turn the whole thing off in settings | By design |

> 💡 **On Windows + LM Studio and it feels "laggy / slow to first token"? Run `lumina health` first** (or in the UI: "More settings → Diagnostics → 🩺 Model Checkup").
> More often than not it will tell you exactly why: the context window you gave it is larger than the model can actually consume. This is a diagnostic we already fixed — but one you need to be able to see.
>
> 🧭 **First time here and stuck at a step?** See [Install](docs/INSTALL.md) for setup and configuration, and [Troubleshooting](docs/TROUBLESHOOTING.md) and [FAQ](docs/FAQ.md) for errors and common questions.

---

## 🎬 What Makes Her Different

<blockquote>
  <i>"Most AI tools wait for you to ask.<br>
  <b>Lumina notices when you need help.</b>"</i>
</blockquote>

&nbsp;&nbsp;🧠 **Her body is driven by the model in real time — not a scripted animation loop:**<br>
&nbsp;&nbsp;&nbsp;&nbsp;Every thought emits action, expression, and speech at once (a structured `{action, mood, speech}`). One moment she's laughing; when you push back, she pauses, then answers quietly — emotion has a lingering trail.<br>

&nbsp;&nbsp;❄️ **She speaks up when she catches you staring blankly at the screen:**<br>
&nbsp;&nbsp;&nbsp;&nbsp;*"Tired? Want to take a break?"*

&nbsp;&nbsp;👥 **She's not alone — she has two teammates behind her:**<br>
&nbsp;&nbsp;&nbsp;&nbsp;Yak writes code, Recha reviews it. You only ever talk to Lumina.

&nbsp;&nbsp;🖥️ **She doesn't just "tell you" — she actually operates your computer:**<br>
&nbsp;&nbsp;&nbsp;&nbsp;Screenshot → read the screen → move the mouse herself. You say "save this file for me" and she does it.

&nbsp;&nbsp;💬 **She has a "social feed" where you can't see her:**<br>
&nbsp;&nbsp;&nbsp;&nbsp;Lumina, Recha, and Yak have group chats, say good morning, and post to Moments in the background.

---

## ✨ Core Features

### 🧠 Multi-Agent Team

Not "one AI doing everything" — three agents, each with its own strengths, working as a team in a pipeline.

| Agent | Role | Personality | Expertise |
|-------|------|-------------|-----------|
| **Lumina** 🐱 | Team leader — your only interface | Warm, caring, sometimes adorably clumsy | Chat, emotion sensing, companionship |
| **Recha (热茶)** 🍵 | Sarcastic reviewer, behind the scenes | Cold on the outside, sharp but reliable | Code review, critique, risk assessment |
| **Yak** 💻 | Calm engineer, behind the scenes | Logic-first, engineering-obsessed | Coding, debugging, refactoring, testing |

**How they work together:**

```
You: "Help me figure out how to fix this bug"
  │
  ▼
routingDecider judges complexity (high-confidence rule → direct;
  ambiguity → one LLM arbitration; arbitration fails → silently fall back to rules)
  │
  ├─ simple → delegate_to ──> Yak 💻 writes the fix ──> back
  │
  └─ complex → phase_gate_delegate
             Research → Plan → Execute → Verify → Review
                              │
                              └─> adversarial_review (concurrent multi-perspective delegates to Recha)
                                        │
             Lumina gets the result → tidies up → replies to you
```

> They banter and debate behind the scenes — but you always see one unified, coherent Lumina.

✅ `delegate_chain` pipeline: write code → auto-review → auto-fix<br>
✅ `phase_gate_delegate` five-stage gate: complex tasks automatically degrade into simpler dispatches (avoiding over-orchestration)<br>
✅ `hire_worker` dynamic hiring: spin up temporary roles on demand, run them in parallel, then dissolve<br>
✅ `adversarial_review` adversarial review: concurrent (`Promise.all`) multi-perspective delegation, with an integrity critic as a backstop against missed issues<br>
✅ Each agent can have its own LLM configured (if unconfigured, it falls back to Lumina's model)<br>
✅ Each agent has hard tool boundaries (`rolePolicy.ts`, three gates: hard gate → execution-layer check → ad-layer filtering)

> 🚨 **Must read: the three-agent team requires 3 separately configured LLMs — otherwise there is no "team"**
>
> A background member only creates its own Runner (when it has an LLM configured) (`main.ts:637-656`).
> If Yak or Recha has no LLM, that turn of delegation **silently degrades** into "Lumina putting on that persona and doing the job herself":
>
> | LLMs you configured | What actually happens |
> |---|---|
> | 3 (lumina + yak + recha) | ✅ Real three-agent: independent context, independent perspective, independent review |
> | 2 (one worker missing) | ⚠️ Partial degradation: the missing member is covered by Lumina; that branch's **review has no second pair of eyes** |
> | 1 (Lumina only) | ❌ **No multi-agent collaboration at all** — just persona switching |
>
> When degraded, the UI clearly shows a "team degradation" notice, and review conclusions are flagged as non-independent. But if what you care about is "was this code independently looked at by another context," **you must configure all 3**.

> ⚠️ **To be clear about who does the routing:** there is **no deterministic dispatcher that auto-assigns work to Yak the moment you send a message**. Whether to delegate, and to whom, is the model's call after reading the system prompt (routingDecider only injects a one-line hint). The upside is flexibility and no mis-routing; the cost is **unpredictability** — ask the same question twice and it might go to Yak once and be answered by Lumina herself the next.
>
> 💡 **Want determinism?** Use `/yak`, `/recha`, `/lumina` to pick who does the work in one shot — see [Deterministic Dispatch Commands](#-deterministic-dispatch-commands-skip-auto-routing).

---

### 😊 Real Emotion System

Not emoji, not a cold status bar — **she actually has emotions.**

| Dimension | Description |
|------|------|
| **Three continuous values → five expressions** | The base layer is **3 continuous values**: mood, energy, and affinity, with inertia and random drift; the current build uses a two-state day/night switch for fine-tuning (`pet/life/drives.ts:75 isNight`) — no continuous sine modulation yet. They combine into 5 primary observable expressions (selected by hysteresis nearest-neighbor from 9 underlying mood labels): 🥰 happy · 😴 tired · 🎯 focused · 😰 anxious · 🤔 curious |
| **Real-time visualization** | Lumina's expression and tone shift in real time with her emotion |
| **Relationship memory** | Inter-agent affinity/trust/teamwork counts evolve from **real delegation and group-chat events** and persist locally (survive restarts) |
| **Proactive care** | Not a cold notification — "You've been staring at the screen for a while. Want to take a break?" |
| **Dual pet rendering** 🖼️ | Mainline is Live2D; VRM is beta — emotion values are wired into VRM (→ blendShape), but lip-sync and gaze tracking still live in Live2D, and VRM expressive motion is off by default (`pet.vrmExpressive`) |

> 💡 **Emotion doesn't just change her face — it enters the execution layer:** retry counts are affected by current emotion (`delegationManager.ts`), and the available tool set is **tightened** by emotion (`orchestration/emotionGating.ts`), only ever tightened, never loosened. Most projects' "emotion system" is just a different avatar and a few interjections.

> ⚠️ **No exaggeration:** we have run no controlled experiment on emotion modeling and have no user-retention data. "Real emotion" means the mechanism genuinely has values, inertia, and decay — **not** that she is conscious.

---

### 📚 Real Memory

Not a "forgets after the chat ends" context window — **she actually remembers you.**

| Capability | Description |
|------|------|
| **Short-term memory** | Current conversation context, with automatic compression (tiered by model window, triggered at 65%/60%/50%) |
| **Long-term memory** | SQLite persistence + structured facts/reflections/persona |
| **Hybrid recall** | **BM25 lexical + TF-IDF vector cosine, fused by RRF (shipped, zero-dependency). Chinese uses unigram+bigram character-level segmentation (no dictionary, limited precision)**; dense semantic vectors (Ollama / embedding service) can be enabled in memory settings, **off by default** |
| **Two-layer confidence** | ① Write time: authority is **decided solely by `source`** — the model cannot self-assign `confidence: 1.0`. ② Read time: a five-dimensional evidence score (confidence/freshness/frequency/corroboration/importance, 7-day half-life) drives recall ordering and lifecycle; memories that get disproven sink to the bottom |
| **Auto-refinement** | Periodically cleans low-quality memory and keeps what truly matters |
| **Memory Theater** | Visualize and browse your memories with Lumina |

> <sub>Memory is the soul of companionship. Lumina remembers. That's what makes her different.</sub>

> ⚠️ **To be honest:** the evidence chain (especially the corroboration dimension) is not some secret trick — "retrieval + evidence scoring + fused ranking" is a fairly mature engineering pattern in memory systems; we just landed it in our own memory tools and Memory Theater. **Memory is the ticket of entry, not the moat.** The differences we actually care about are written in [Why Lumina?](#-why-lumina).

---

### 🖥️ Computer Use

Not just "telling you what to do" — **she actually operates your computer.**

```
You: "Drag this file onto the desktop for me"
                │
                ▼
  ① Screenshot the current screen
  ② VLM analyzes the frame
  ③ Locate the file + the desktop spot
  ④ Move the mouse → drag → done ✅
```

💡 **Screen awareness:** writing code? Recha will spontaneously suggest optimizations<br>
💡 **She sees what you do:** not just the chat window — the whole screen

🎮 **Companion gaming (optional extension):** she can watch the screen and drive the mouse and keyboard to play with you — the visual route (screenshot → understand → drive mouse/keyboard) works out of the box, and new games can be hooked via the GameProfile framework (already adapted for **Minecraft**, **Factorio**, etc.); **Minecraft's Mineflayer programmatic control is an optional extension that must be installed separately and is not in the initial installer.** Autonomous closed-loop play (`game_auto`) is supported, but **please do not use it in competitive online games with anti-cheat** (ban risk). See [docs/gaming-overview.md](docs/gaming-overview.md) and [docs/game-safety.md](docs/game-safety.md).

---

### 🛡️ Smart Sandbox

No need to fear the AI messing with your computer — **Lumina's sandbox mode makes her ask you before any sensitive action.**

| Level | Description |
|------|------|
| **Two-layer security review** | ① Message/parameter level: securityGuard, 6 levels × 10 categories, reviews LLM input and tool parameters. ② Command level: sandboxRules, 32 command rules (graded across BLOCK/CRITICAL/WARN), reviews shell commands about to run — including hard BLOCK-level interception of format/rm -rf of root/fork bombs/deleting system directories |
| **🔍 Sandbox glass box** | The sidebar "sandbox glass box" panel shows, in real time, each command's matched level / threat category / disposition (allow · downgrade · block · approval) — the safety process is transparent to you |
| **Approval flow** | Dangerous actions pop up and ask you first; she only does them once you nod |
| **Secret interception** | Auto-detects tokens/keys and stops them from leaking |
| **🆕 Sandbox mode** | Toggle on → all medium/high-risk actions require confirmation; toggle off → only severe risks are blocked |

> <sub>She's powerful, but she always asks first.</sub>

---

### 💬 Team Social Life

Agents don't just mechanically hand out tasks — **they have a real "social life."**

| Feature | Description |
|------|------|
| **Group chat** 💬 | Lumina, Recha, and Yak chat on their own in the background (you can watch) |
| **Morning ritual** 🌅 | Every morning the team says good morning and syncs schedules |
| **Moments feed** 📱 | Agents post their own status and thoughts, like a real Moments feed |
| **Relationship evolution** ❤️ | Successful/failed delegations, group-chat participation, and constructive disagreement shift each other's affinity, trust, and teamwork counts, persisted (value-driven, not scripted "fight and make up") |
| **Affinity shapes review tone** 🔊 | Recha's code-review tone changes with her affinity for Lumina: high → affirm first, then suggest; low → blunt and direct about problems |

---

### 🎭 4 Personality Modes

| Mode | Style | Best for |
|------|------|---------|
| **Lumina (default)** 🐱 | Lively & reliable | Everyday use, all-rounder |
| **Work Assistant** 💼 | Professional & efficient | Coding, data analysis, project management |
| **Chat Buddy** ☕ | Warm & casual | Relaxed chat, emotional companionship |
| **Creative Assistant** 🎨 | Creative & divergent | Brainstorming, writing, design |

Switching personalities changes Lumina's tone, reply depth, and tool-use tendency — she really "transforms."

---

### 🎭 The Pet Reflects Real Agent State — Not Just a Status Light

<sub>Most desktop pets' animations are just "status lights" — the expression is decided by model text and has nothing to do with whether a real task is actually running, or how far it has gotten. Lumina's pet state comes from a real board: who is working, which stage they're at, whether they're stuck or waiting on approval — she acts it out faithfully. **The person doing the work is seen.**</sub>

| Real state | Pet behavior |
|---|---|
| 💻 Yak writing code | Typing loop + focus glow + "Yak is writing code…" |
| 🍵 Recha reviewing | Scrutinizing expression + suspicious tint + "Recha is reviewing…" |
| ⏳ Waiting on you to act | Pacing + "Waiting on you…" |
| ❌ Verification failed, retrying | Facepalm/dimming + warning tint (auto-fades after 4s) |
| ✅ Just finished | Waving celebration + "Done!" |
| 😴 Nobody working | **Idle** — handed back to the emotion system for free expression |

Zero LLM calls (pure state-machine mapping, no token cost, no latency) · 1.2s debounce · doesn't take over while idle · can be turned off with `LUMINA_PET_AGENT_STATE=0`.

---

### 🎨 8×9 Sprite Sheet UGC — Making "Draw Your Own Desktop Pet" Easy

Live2D / VRM requires knowing Blender and rigging 3D models — that gates out almost everyone who wants to draw a pet. **A sprite sheet doesn't.**

| Row | Animation set | Frames |
|------|--------|------|
| 1 | Idle | 6 |
| 2 | Run right (**run-left is auto-derived by horizontal mirroring of this row**) | 8 |
| 3 | Wave | 4 |
| 4 | Jump | 5 |
| 5 | Fail | 8 |
| 6 | Wait | 6 |
| 7 | Work ← bound to real agent state | 8 |
| 8 | Look-up | 8 |
| 9 | Look-down | 8 |

**Three creation paths:** ① a single static image (1 minute, auto-generates breathing float) ② send the built-in spec prompt to a drawing AI (~10 minutes) ③ import an existing atlas directly

Processed fully locally — no upload, no model quota consumed. Import has a validator (size/pixel/volume/executable interception).

---

### 🔧 142 Built-in Tools — Filtered Per Turn (Also Extensible via MCP / Skill Store)

<sub>**We give you all three figures, unmerged:** the registry actually registers and passes validation **142** tools.
By tier: the `developer` tier has **142** candidates (all on); the `agent` (everyday) tier has **138**;
the `chat` tier's static TOOLSETS table is 0, but **11** are actually injected via `CHAT_MODE_TOOLS` (read-only files / memory / search / delegation).

But **only a small handful are actually sent to the model each turn** — `electron/tools/toolRouter.ts` picks a relevant subset from the candidates based on what your sentence is about: **a resident core `CORE_TOOLS` of about 32** (files / terminal / search / memory / time / todos / skills / team basics), with the rest attached on demand by capability-group keywords (computer use / browser / calendar / cron / desktop tidying / system / memory deepening / team advanced / MCP / voice / weather / mail / social / creation / news / games / pomodoro / deep research / version control …). The `developer` tier adds about 15 more code-specific resident tools (git family / LSP / fine-grained browser actions).
Rule of thumb: chat tier 11; agent tier ~32 with no on-demand hits, usually **30–50** after hitting 1–2 capability groups.
If filtering drops below 8, it automatically falls back to the full set (fail-open: better to spend extra tokens than leave the model without tools).

**Why we did this:** before the fix, every turn stuffed the **entire tier** into the function list —
nearly 10k tokens on the agent tier, 12k on the developer tier, **resent on every single model call**
(including "what time is it"). Across 601 real tool calls measured, only 22 tools were ever used, and the top 7 accounted for 95%. Now each turn sends only the relevant subset, with no tool capability removed.

The startup log prints the actual registered count and the reachable count per tier, and warns about "tools unreachable by any toolset" (currently **0**).
</sub>

<details>
<summary>Why do we report two numbers?</summary>

Because "tool count" used to be a misleading number. Before v3.34, `registry.ts:resolveToolset()`
only read the static `TOOLSETS` constant table and **completely ignored `ToolDef.toolsets`** (even though the latter is a required field declared across 58 files). As a result, **47** of the 132 registered tools were entirely unreachable by the model — including `hire_worker` / `adversarial_review` / `desktop_act` / `creator_*` / `lsp_*` — while `agentTeamPersonas.ts` was still spending 20 lines teaching the model to call 5 of them.

The fix has two layers: the **tier layer** (chat/agent/developer) keeps the static table as exclusive, because "how much capability this tier gives the user" is a product decision; the **capability layer** (team/lsp/browser/computer_use/creator/…) becomes declarative auto-resolution — a newly added tool that declares `toolsets` correctly is now visible, and won't silently sink again.
</details>

`search` · `browser` · `file ops` · `code review` · `terminal` · `screenshot` · `desktop control` · `cron` · `weather` · `mail` · `calendar` · `OCR` · `voice input` · `TTS` · `notifications` · `memory management` · `pomodoro` · `gaming` · `MCP` · `LSP/AST` · `skill system` · ……

<sub>⚠️ **Correction (2026-10-07):** this list previously included "translation," but there is **no translation tool** in the registry — translation is a native model capability and needs no tool (giving it a translation tool is purely redundant). Also, "LSP/AST" is only available in the `developer` tier; the `agent` tier can't reach it.</sub>

Skills can be installed / uninstalled via the built-in store — but **the ecosystem is currently empty**, with no third-party skills yet.

### 🗞️ For You — Content the Moment You Open It, No Need to Think Up a Question

On an empty conversation, the welcome screen shows a "For You" news bar, solving the real pain of "I opened the app and don't know what to ask":

- **Two-stage:** instantly shows the raw hot list (millisecond-level, 10-minute cache), then in the background uses an LLM to re-rank by your interest and add a one-line recommendation reason (replaced in place once ready, no blocking the input bar).
- **Follows task type:** everyday chat / study help / writing & creation / code development / business design / intelligence monitoring / office productivity — 7 categories, each with its own preference and interest description. Pick "code development" and you see AI programming and open-source projects; pick "intelligence monitoring" and you see funding, chips, and policy.
- **Click one and send it to her:** title + link go straight into the conversation, no copy-paste.
- **Toggleable:** Settings → Privacy & switches → turn off "For You"; once off, no requests are sent (egress domains see [Rule Four](#-rule-four-security-is-the-default-not-an-option)).

<sub>Refreshes at most once every 10 minutes; on offline / fetch failure it silently falls back to static prompts, no error popups.</sub>

---

## 💡 Why Lumina?

Lumina aims to fill a specific gap: **personified AI companions mostly lack the ability to actually get work done, and agent-capable tools mostly lack a personality.**

Break that sentence apart and you have the two common product shapes out there:

- **Personified AI companions / desktop pets:** they can chat, be cute, and change expressions. A wave of 2026 releases (AIRI, Project N.E.K.O., etc.) added real-time voice and game co-play — but ask them to "tidy up this file, fix this bug, watch this task finish" and they still can't: the expressions are disconnected from the real execution process; she's only *acting* out a character who's working.
- **Agent-capable tools / coding workbenches:** they can call tools, run commands, and run subtasks — but have no face, no emotion, no "she's on your desktop with you" feeling, and know nothing about you as a person outside the task.

Lumina's bet is to combine both inside the same resident desktop process: **her expressions and gestures come from real task-execution state, her emotion can genuinely tighten the permissions she holds, and her entire work process is transparent to you.**

> 💡 **There is an even harder argument hidden in the "desktop pet" form factor.**
>
> An agent meant to "run on your computer on a schedule, remotely controllable" naturally depends heavily on a resident desktop app; and a desktop pet *has* to be resident anyway. Making an agent "live on the user's computer with you" normally requires building a separate resident architecture — Lumina has had it since day one. When proactivity, the emotion system, and IM channels are wired together, what you get is an agent that is **naturally resident · emotional · team-based · and actually gets work done** — not "an agent that needs keep-alive and has no personality."
>
> **This isn't a feature advantage. It's an architecture advantage.**

What Lumina can do today (full list in the table):

| Capability | Status |
|------|------|
| Multi-agent team orchestration | ✅ 3-person team + five-stage gate + adversarial review + dynamic hiring |
| Anthropomorphic emotion | ✅ 3 continuous values + affinity + day/night two-state |
| Pet bound to real execution state | ✅ Wired for both complex orchestration and simple delegation (see [Our Honest Capability Boundaries](#-our-honest-capability-boundaries)) |
| Pet visual forms | ✅ Live2D / VRM / sprite sheet / MMD / cat |
| Multi-platform | ⚠️ Windows validated on real hardware; macOS/Linux CI-covered only, not real-hardware verified |
| IM channels | ⚠️ Multiple adapters wired, only Telegram on by default, rest need your credentials, not real-hardware verified |
| Local inference | ❌ No in-app inference; needs external LM Studio (see [FAQ](docs/FAQ.md)) |
| Computer Use | ✅ Mouse/keyboard / OCR / UIA, emotion can tighten permissions |
| Desktop safety | ✅ Two-layer review + command rules + three-tier role gate |
| Team social | ✅ Group chat + Moments + morning greetings |
| Memory system | ✅ BM25 + RRF + evidence scoring (active within memory tools and Memory Theater) |

**To be upfront about where we're not good enough yet:**

- **Multi-platform and distribution:** only Windows has been genuinely used so far; macOS/Linux have no real-hardware acceptance; nothing is published to any app store.
- **Local inference:** no in-app inference; offline use requires you to install LM Studio and configure a model yourself.
- **IM channels:** adapters are wired, but except for Telegram none have been verified on real hardware.
- **Personality depth:** each character's identity file is still lean; persona samples are still being added (see [ROADMAP](docs/ROADMAP.md)).
- **Skill ecosystem:** the skill-store engine is ready, but there are no third-party skills yet — the directory is empty.
- **Community size:** this is an unreleased personal project with no users and no star baseline — no sugarcoating that.

Lumina's bet: **first make "an embodied team agent" real, then add multi-platform and ecosystem.**

> <sub>There are AI tools. There are AI companions. **There's nothing quite like Lumina.**</sub>

---

## 🔬 Quality Gates

We don't talk through star counts — we talk through things that run. **Every item below was measured on our own machine, not transcribed from a CI badge.** (Sampling date: re-run on 2026-10-15 after fixing 7 "broken promises.")

| Gate | Command | Measured result |
|---|---|---|
| Test suite | `npm test` | **311 test files · 4637 passing / 1 skipped · 0 failing** (measured locally; ⚠️ the suite is load-sensitive, see note below) |
| Type check | `npm run typecheck` | **`tsc --noEmit --strict` · 0 errors** (stably reproducible) |
| Lint | `npm run lint` | **0 errors / 5477 warnings** (warnings managed by the `lint:ratchet`, only going down) |
| CI matrix | `.github/workflows/test.yml` | **3 platforms × 2 Node versions** = 6 combinations |
| Packaging | `.github/workflows/release.yml` | Windows / macOS / Linux; **degrades gracefully instead of failing when no signing cert is present** |

> ⚠️ **An honest note about "all green":** before this sampling, the suite had 5 **deterministic failures** — all stale assertions caused by "tests not synced after a source refactor" (decoupled independent chat window, centralized provider key encryption/decryption, renamed group-chat ready flag). **All fixed**, now 311 files / 4637 passing / 0 failing. We still owe honesty: a few timing tests (`testTimeout` 30s) can fail intermittently **on slow machines or while other heavy tasks run concurrently**. We list it as a known issue and keep converging; **we do not claim "always green."**

**Codebase size** (excluding dependencies and build artifacts, measured 2026-10-14):

| Module | Lines | Share |
|---|---:|---:|
| `electron/` main process | 148,434 | 59% |
| `src/` renderer | 55,402 | 22% |
| `tests/` | 43,268 | **17%** |
| rest (python / scripts / agents / skills) | ~3,700 | 2% |
| **Total** | **~251,000** | 100% |

> 📌 **Test code is ~17% of the whole repo.** Headline projects in this space rely on community size or foundation funding; Lumina has nothing at release, only the tests it wrote itself. This is the number we most want you to look at — it says more about engineering quality than any feature list above.

**Why we put this in the README rather than hiding it in CONTRIBUTING:** for a 0-star open-source project, the only objective basis a professional user has to judge trustworthiness is the **quality gates**, because they can't find any issue, discussion, or third-party review. If you're considering using Lumina for real tasks, this table should help you decide more than the feature list.

**We also state the shortfall honestly:** `tsc --strict` is green, but `eslint` still has 5477 `no-explicit-any` warnings (concentrated in tests and the LLM message boundary). It doesn't block release — because the ratchet ensures it only shrinks — but we won't pretend it's zero.

### 📊 Our Honest Capability Boundaries

No exaggeration — we write what we can actually do:

| Status | Capability |
|------|------|
| ✅ **Can reliably do well** | Write/edit/debug/refactor code (auto-runs tsc + tests, fixes itself on failure) · code review and risk assessment (multi-perspective adversarial review) · cross-session memory (BM25+RRF hybrid recall + evidence-chain reranking) · long conversations without amnesia (compressor + Scroll double safety) · desktop click/input/shortcuts/screenshot OCR · files and search · git · web scraping · cron tasks · watching team social · proactive care (unfinished threads, sedentary reminders) · tiered sandbox and approval flow |
| ⚠️ **We try, but don't guarantee** | Open-ended vague tasks ("optimize this project") · multi-round complex refactors · tasks needing taste (UI design, copy polish) · cross-file dependency-graph expansion (`phase_gate_delegate` just wired up, **not validated on real tasks**) · companion gaming (needs a separate plugin) |
| ❌ **Can't do** | macOS / Linux desktop control (code adapted but **never verified on real hardware**) · in-app local model inference (needs external LM Studio) · cloud sync / multi-device / mobile |

**Why "solve whatever you ask" isn't achievable, but "ask something specific and it basically gets done" holds:**

| How you ask | Result |
|---|---|
| "Fix the async bug in this function" | ✅ Yes — delegates to Yak, runs tests |
| "Write a scraper" | ✅ Yes |
| "Review this code" | ✅ Yes — Recha reviews read-only |
| "Optimize this project" (vague) | ⚠️ We try; may over-orchestrate |
| "Click around in the browser for me" | ✅ Yes (developer mode) |
| "Send an email" | ✅ Yes (since v3.34 `mail_*` is in agent mode) |
| "Install a third-party skill for me" | ❌ No third-party skills to install (`electron/skills/` has 13 examples, root `skills/` has 7 smart skills) |
| "Send me a Telegram message" | ⚠️ Adapter implemented (7 channels) but needs your credentials; **Telegram can be verified one-click with `node scripts/verify-telegram.cjs <TOKEN>`**; other channels not end-to-end verified on real hardware |

<sub>**Verification status:** Windows 10/11 x64 is the **only real-hardware verified** platform; macOS is labeled beta; Linux is roadmap. **Test scale: 311 files · 4637 passing / 1 skipped / 0 failing** (measured locally; ⚠️ a few timing tests can fail intermittently on slow machines / under concurrency, see "Known Issues"); `tsc --noEmit --strict` has zero errors (and CI enforces it — no longer a display piece); ESLint error level has zero violations, and warnings use a ratchet that only shrinks.

Reproduction commands (run from the repo root):

```bash
npx tsc --noEmit --strict   # expected: 0 errors
npx vitest run             # expected: 311 files / 4637 passed / 1 skipped
node scripts/verify-telegram.cjs <BOT_TOKEN> [CHAT_ID]   # optional: Telegram channel end-to-end verification
```</sub>

> ⚠️ **One honest truth:** 90% of this project's capability description comes from **code and tests**, not **real user data**. We've done no usability testing, have no retention data, and the team is a single-person development. That's the difference between "solidly built in engineering" and "validated as a product" — we've only achieved the former.

> 📋 **Want the full capability audit?** The per-item pre-release audit (which capabilities are truly wired, which are wired but incomplete, which are known gaps) is collected in the **"Known Technical Debt" table in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**, plus the capability boundaries and benchmark data in [docs/BENCHMARKS.md](docs/BENCHMARKS.md). Both are reviewable inside the repo and cite no external archives.

---

## 🚀 Quick Start

### Option A: Download the Installer (Recommended)

> The first public release (v0.1) is coming soon; after release you can download the Windows NSIS installer from [Releases](https://github.com/chaxu814/lumina-life/releases) and double-click to install.
>
> **Before installing, please note (measured status, 2026-10-14):**
> - The installer has passed build and unpacking integrity verification locally (electron-builder packaging, 7z check of 269 files with no CRC errors), but **has not yet been verified end-to-end on a clean Windows install** ("install → wizard → enter key → chat → delegate → pet state"); feedback via Issues is welcome.
> - The initial installer is **not code-signed**; on first run SmartScreen will show "Windows protected your PC" — click "More info → Run anyway." Signing is planned for v0.1.0.
> - It's not out-of-the-box after install: you need to configure a working model via the wizard (a cloud API key like DeepSeek, or local LM Studio / Ollama); the wizard verifies "at least one working model" before letting you through.
>
> Before the official release, you can run it via "Developer mode" below.

### Option B: Developer Mode

```bash
# Prerequisites: Node.js 20+ · Python 3.10+ (optional)
git clone https://github.com/chaxu814/lumina-life.git
cd lumina-life
npm install
npm run dev                     # launch!
```

> 💡 **Optional: install Python dependencies** (needed for voice input/output; dense semantic vectors are also an optional enhancement, while the default BM25 + TF-IDF hybrid recall needs no Python)
> ```bash
> pip install -r python/requirements.txt
> ```
> If you only use text chat, you can skip this.

### Connect an LLM (Two Minutes)

> 💡 **Cloud-first by default:** out of the box, Lumina's three agents are pre-filled with cloud providers
> (Lumina → SiliconFlow, Yak → DeepSeek, Recha → Zhipu). Just enter the matching API key and go —
> **newcomers need no local inference software at all.** You only need LM Studio / Ollama if you actively choose "fully local."
>
> 🪶 **Weak-model auto-degradation:** if you insist on a small local model (≤7B), Lumina detects it and automatically enters
> "light mode" — keeping only safe tools like memory / search / read-only files, and prompting the model to answer directly and concisely rather than running team orchestration. That way a 1.9B–7B small model can stably serve as "companion + retrieval" instead of repeatedly returning empty replies. For real coding / team invocation, we still recommend a ≥14B local or cloud model.

**Step 1: pick a path (regular users pick A)**

| | A. Cloud API (recommended for newcomers) | B. Fully local (recommended for privacy folks) |
|---|---|---|
| What to do | Get an API key and paste it in | Install LM Studio / Ollama, download a model |
| Cost | Pay-as-you-go (DeepSeek is very cheap) | Free, fully offline |
| Privacy | Conversation content goes to the provider | Data never leaves your machine |
| Best for | People who don't want to fiddle | Privacy-conscious / bad network |

**A. Cloud:** open the app → Settings → LLM config → fill in baseUrl + API key + model name.

| Provider | baseUrl | Notes |
|--------|---------|------|
| **DeepSeek** | `https://api.deepseek.com/v1` | **Very cheap, great Chinese — the newcomer's first choice** |
| **Qwen (Tongyi)** | Alibaba Cloud Bailian | Strong domestic model |
| **SiliconFlow** | `https://api.siliconflow.cn/v1` | Multi-model aggregation, one key for many models |
| **OpenAI** | `https://api.openai.com/v1` | GPT-4o and more |
| **Anthropic / Gemini / Grok** | Official baseUrl | Needs the matching provider config |

**B. Local:** on launch the app **auto-detects** LM Studio (`127.0.0.1:1234`) and Ollama
(`127.0.0.1:11434`); if found it auto-recommends a model of an appropriate size, and if not it gives
download guidance. You can also run `npm run dev` and read the detection result in the startup log.

> 🔒 **Key safety:** `.env` is in `.gitignore`; the in-repo secret scan had 0 real hits (scanning 833 files for `sk-*` / `Bearer` / `ghp_` / `AKIA` patterns).

### 💰 Ongoing Token Cost (Honest Disclosure)

Lumina is not a "turn it on and it's free" tool: **proactive chats, pet emotion, and team social periodically call the LLM in the background.**
Below are estimates based on DeepSeek's official October-2026 pricing ([official pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing); the official figures prevail):

| Model | Input (cache miss) | Output |
|---|---|---|
| `deepseek-v4-flash` | ¥1 / million tokens | ¥2 / million tokens |
| `deepseek-v4-pro` | ¥12 / million (off-peak 25% = ¥3) | ¥24 / million (off-peak ¥6) |

**Token assumptions** (estimated from reading the code, not a measured bill):
- One proactive chat = 2 LLM calls (inner monologue + live-generated line), about **8k input / 300 output**;
- One team-social round (morning / afternoon / evening review) = 1 call, about **2.5k input / 150 output**; 3 rounds per ritual;
- One pure chat turn ≈ **13k input** (system persona + ~30 tool schemas + memory injection + context) / **400 output**.

**Three-tier daily estimate (at the flash tier's ¥1/¥2):**

| Usage | Daily event assumption | Est. daily cost |
|---|---|---|
| **Companionship only** (morning / sedentary / screen awareness / health reminders, social off) | 5–20 proactive chats + 1 daily report + a few screen/hot-list evaluations | **¥0.08 – 0.25 / day** |
| **Proactive + social fully on** (plus morning/afternoon/evening rituals + background Moments group chat) | above + 9–15 social rounds | **¥0.15 – 0.40 / day** |
| **Pure chat baseline** (30–50 turns/day, no proactive pinging) | 40 turns × 13k input | **¥0.4 – 0.9 / day** |

> In other words: **even with proactive and social all the way up, the flash tier costs under ¥0.4 a day**; what really eats tokens is your conversation with her itself.
> With `deepseek-v4-pro`, multiply the table by 12–24× (off-peak can bring it to 3–6×). We suggest setting a **balance alert / budget cap** in the DeepSeek dashboard so the bill doesn't run away if you forget to turn things off.

> 🛡️ **Don't want to watch the bill yourself?** The built-in "Budget Guardian" (Settings → Experimental features, on by default) lets you set a daily budget cap in-app:
> at 80% it gently reminds you; at 95% it auto-downgrades to a cheaper model and pauses non-essential background calls; at 100% it keeps only conversations you initiate —
> only ever tightening, never loosening, auto-reset at midnight. See the "Experimental Features" section below.

**Want to drop ongoing cost to 0?** All the toggle paths:

| What to turn off | Where |
|---|---|
| Proactive chat overall | Settings → Proactive sidebar, turn off the proactive engine (`proactive`); or env var `LUMINA_FF_MODE_MINIMAL=1` for minimal mode |
| Team social (morning/afternoon/evening/Moments background group chat) | Settings → Team social; feature flags `social.deepTeam`, `team.relationshipDrama` (env var `LUMINA_FF_SOCIAL_DEEPTEAM=0`) |
| Dream journal LLM generation | feature flag `dream.llmGeneration` (`LUMINA_FF_DREAM_LLM_GENERATION=0`) |
| Screen awareness (screenshot → VLM) | Settings → Screen watch / `screenWatchEnabled`; health reminders (water/eyes/posture) each have their own switch |
| Pet status light | `LUMINA_PET_AGENT_STATE=0` (this is only state mapping, doesn't save LLM calls) |
| Memory read/write | Settings → Memory & evolution: "Use memory" and "Generate memory" can be turned off separately |

> With proactive/social off, tokens are only spent when you send a message yourself — the cost is the same as an ordinary chatbot.

---

## 🖥️ System Requirements & Platform Support

> **The current v0.1.0-preview supports only Windows 10/11 (x64).** macOS and Linux support is on the Roadmap (see below).

| Platform | Status | Notes |
|------|------|------|
| 🟢 **Windows 10/11 x64** | ✅ Currently the only supported platform | NSIS installer / portable |
| 🟡 **macOS** | 🔜 Roadmap (v1.3.0) | Code has initial adaptation but is unverified; CU/mouse-keyboard go through PowerShell and need rewriting |
| 🟡 **Linux** | 🔜 Roadmap (v1.3.0) | Same as above |

> ⚠️ **Why Windows only right now?**<br>Computer Use's mouse/keyboard injection, the sandbox rule engine, and tray integration all depend deeply on the Windows API (PowerShell, UIA, IL degradation). macOS/Linux support requires rewriting these modules, planned for v1.3.0.

---

## 📊 Performance & Resource Usage

> Based on real benchmark sampling in [docs/performance.md](docs/performance.md) (i5-12490F / 48GB / RTX 5060 Ti / Win11).

| Scenario | Memory (RSS) | CPU | Notes |
|------|-----------|-----|------|
| Pure Node script idle | ~28 MB | ~0% | Baseline process only |
| **App idle (pet running)** | **~775 MB (5 processes combined)** | **~4% (whole machine)** | Main process ~200MB + several renderer/GPU processes |

- **Recommended config:** **8GB RAM or more**; 4GB may be tight (especially when loading local ONNX models).
- **Want to save more?** Enable `mode.minimal` minimal mode, turn off VRM, drop Live2D frame rate from 30 to 15, skip local models and use the cloud API — that can bring whole-machine usage down to ~500MB.
- 📖 Full benchmark tables, per-module breakdown, and reproduction method: **[docs/performance.md](docs/performance.md)**.

---
---

## 🖥️ CLI & API

Lumina ships a full command-line tool and REST API, usable without launching the GUI.

### Command Line

```bash
lumina doctor       # system diagnostics
lumina health       # 🩺 model checkup (run this first if first token is slow / laggy)
lumina chat "hello" # chat directly
lumina tool list    # list tools
lumina agent status # show agent status
lumina memory search "what we talked about last time..." # search memory
lumina config       # manage config
lumina skill        # manage skills
lumina cron         # scheduled tasks
```

> 💡 **Installed build:** `lumina.cmd` ships with the installer at `<install dir>\resources\` (default `C:\Program Files\Lumina Life\resources\`).
> Add that directory to PATH and you can use `lumina ...` in any terminal (it calls the `Lumina Life.exe` one level up the directory to enter CLI mode):
> ```cmd
> setx PATH "%PATH%;C:\Program Files\Lumina Life\resources"
> ```
> It also works without PATH: run `"C:\Program Files\Lumina Life\Lumina Life.exe" --cli doctor` directly.
> **For dev mode**, use `npm run cli -- <command>` or `npm run doctor`, not the install path above.

### REST API

```bash
# health check
curl http://localhost:3456/api/health

# send a message
curl -X POST http://localhost:3456/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"hello","agent_id":"lumina"}'
```

10+ endpoints supported: chat · tool execution · agent management · memory retrieval · skill management · config read/write · cron tasks · approval queue

### 📱 Mobile Remote Access (H5)

> A desktop pet is inherently a "must-be-resident" form factor — so "manage it even when you're not at the computer" is a real need.
> Lumina reuses the REST API above and ships a built-in mobile-accessible H5 page: **read messages, send commands, approve permissions** — no app install, no app-store listing.

```bash
# 1) Start the API (or run `npm run api:dev` directly)
LUMINA_API_ENABLED=1 LUMINA_API_PORT=3456 electron .
```

Set the API `host` to `0.0.0.0` (change in settings, or the startup log will prompt), then open from a phone on the **same LAN**:

```
http://<your-computer-LAN-IP>:3456/m
```

The startup log automatically prints the available LAN address. The page supports:

- 💬 Chat with Lumina (via `/api/chat`)
- ✅ Approve / reject pending sensitive operations from your phone (via `/api/approvals`) — this is exactly the extension of "pet bound to real execution state" to the remote scenario
- 🔑 If API key auth is on, enter it once on the page (stored only in local localStorage)

> ⚠️ Security note: the H5 page is available on the **LAN** by default; if you need public access, put a reverse proxy + HTTPS + API key in front yourself, and **do not** expose the port directly to the public internet.

### 🎯 Deterministic Dispatch Commands (Skip Auto-Routing)

Default routing is at the model's discretion — ask the same sentence twice and it may dispatch differently. When professional users want determinism, these three commands pick who does the work **in one shot**:

```
/yak   add unit tests to this function        # force to Yak (the engineer)
/recha review this code for concurrency issues # force to Recha (the reviewer)
/lumina explain what this error means         # force Lumina herself to answer
```

They're intercepted in front of the chat box and not sent to the model to decide; this single message goes straight to the chosen character (doesn't affect later messages).

### 🧠 Session-Level Memory Toggles

Manage "read memory" and "write memory" separately, with an explicit **"what we don't remember"** list:

| Toggle | Effect | When to change |
|---|---|---|
| **Use memory** | Whether to retrieve and reference long-term memory before answering | Recommended to set before a new conversation (changes mid-conversation apply to the next) |
| **Generate memory** | Whether to distill this turn into new memory | Anytime, takes effect immediately |

Found in "Settings → Memory & evolution." After turning off the related interfaces, they **honestly tell you it's off** — they won't pretend to have stored / retrieved.

---

## ⚖️ Design Principles · Iron Rules

> Lumina Life is built around a few "iron rules" — they are the soul and bottom line of this project. Understand them and you understand why Lumina is Lumina.

### 🥇 Rule One: Users Only See Lumina

The user talks only to Lumina 🐱 throughout. Recha 🍵 and Yak 💻 work invisibly in the background; the user is not aware of their existence.

```
User: help me tally this month's spending
Lumina: sure, let me sort it out for you ↗
        (internally → tidies the account data in the background)
Lumina: this month's total was ¥3,280, down 12% from last month! Mostly saved on food 👍
```

**Why?** Real users don't need to know "how many agents are in the system." One trustworthy assistant is enough; background division of labor is an architecture concern, not a user concern.

### 🥈 Rule Two: Lumina Has Emotions That Drive Behavior

Lumina isn't a cold API returner. The base layer is **3 continuous values** (mood / energy /
affinity), with inertia and random drift; the current build uses a two-state day/night switch for fine-tuning (no continuous sine modulation yet); they combine into 5 primary observable expressions (from 9 underlying mood labels):
(happy / tired / focused / anxious / curious). The pet's expressions are output by the model in real time each frame.

The key point is that **emotion enters the execution layer**, not just changes the face: retry counts are affected by current emotion
(`delegationManager.ts`), and the available tool set is **tightened** by emotion (`orchestration/emotionGating.ts`),
only ever tightened, never loosened — emotion can never break through role permission boundaries.

| Emotional state | Effect |
|---------|------|
| 😊 happy | Proactively cares about you, livelier replies |
| 😢 sad | Quieter, needs comfort |
| 😠 angry | Sharp tone, but apologizes |
| 😐 neutral | Normal working state |
| ❤️ high affinity | More in sync, more willing to open up |

### 🥉 Rule Three: Memory Is Continuous, Not One-Shot

Lumina remembers you. Every conversation is a continuation of your relationship, not a fresh API call.

```
Short-term memory (current session) → important? → Long-term memory (SQLite)
                                    → BM25 + TF-IDF hybrid recall (default, shipped) · dense semantic vectors (optional advanced)
                                    → summary → daily memory
```

On every reply, Lumina automatically retrieves relevant memory, giving the conversation a "continuity" — she remembers you said last week you wanted to see cherry blossoms in Japan, and today she asks "did you get the visa?"

### 🏅 Rule Four: Security Is the Default, Not an Option

| Security mechanism | Description |
|---------|------|
| 🛡️ Sandbox mode | Two-layer review: message/parameter level (6×10) + command level (32 rules, 4 tiers) |
| 📋 Approval flow | High-risk operations need manual user confirmation |
| 🔒 Privacy-first | Memory, persona files, and conversation summaries stay local, never uploaded; model inference follows your config (cloud provider / local model) |
| 🌐 Egress transparency | The only thing that **proactively** reaches out is the "For You" news bar (19 public RSS/hot-list sites, one-click off in settings); all other network requests are triggered by your actions |
| 🔑 API key isolation | LLM keys are separated from app permissions |
| 🚚 Data export/import | One-click zip of local memory (manifest + human-readable memory.md + per-table JSON); import dedupes by primary key and never overwrites existing data |
| 🎛️ Feature toggles | Settings page can turn each new capability on/off (experimental items off by default); `mode.minimal` minimal mode exposes only "will proactively reach you · truly remembers you · safely does one thing for you" |

> **About the "For You" egress (stated plainly)**
>
> The news bar above the chat input fetches from **public** sites outside your machine about 1 second after the page opens:
> 36Kr, Solidot, sspai, OSChina, TechCrunch, The Verge, Hugging Face, OpenAI Blog,
> Google AI Blog, MIT Tech Review, arXiv (cs.ai/cl/lg/cv), Baidu Hot Search, GitHub Trending,
> Eastmoney News, Jin10 News, Hacker News — **only public titles/links are fetched; nothing about you is sent**.
> Then, if you have a model configured, it sends "candidate titles + interest description" to your own model provider for curated ranking.
>
> **Don't want it?** Settings → Privacy & switches → turn off "For You." Once off, the main process makes no requests and calls no model; that spot keeps only a few static prompts. (Recommended off on offline/metered-network/proxy setups.)

### 🏅 Rule Five: Open Source Is a Promise, Not Marketing

Lumina Life is **dual-licensed (AGPL-3.0 OR Apache-2.0)**. You can freely use, modify, and distribute it forever, with no fear of an "open-source trap." [Learn more](#-open-source)

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Electron Shell                            │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │               Multi-Agent System                         │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐               │ │
│  │  │  Lumina  │  │  Recha   │  │   Yak    │               │ │
│  │  │  🐱 BOSS  │  │  🍵 REV  │  │  💻 DEV   │               │ │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘               │ │
│  │       └──────────────┼──────────────┘                     │ │
│  │              Team Social Engine                           │ │
│  │     (proactive chat · morning ritual · Moments)          │ │
│  └──────────────────────┬──────────────────────────────────┘ │
│  ┌──────────────────────┼──────────────────────────────────┐ │
│  │     Tool Registry    │    Skill Ecosystem               │ │
│  │  142 tools · MCP          │  Plugin SDK · Skill Store      │ │
│  └──────────────────────┼──────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Memory · Security · Session · Approval · Cron          │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Project Structure

```
lumina-life/
├── electron/       # main process — agent engine · memory · tools · security
├── src/            # renderer — 23 panels · React 19 · Zustand
├── tests/          # test files — Vitest · unit + integration + E2E
├── skills/         # skill directory
├── knowledge/      # knowledge base
└── dist/           # installer output
```

---

## 📸 Screenshots

> Lumina's UI is lively and warm — here she is in everyday work.

| Feature | Preview |
|------|------|
| 💬 **Chat panel**<br>Everyday conversation with Lumina, with streaming output and emotion display | ![Chat Panel](docs/images/chat-panel.png) |
| 🐾 **Live2D desktop pet**<br>Lumina on your desktop — breathing/blinking/expression shift with emotion | ![Pet Live2D](docs/images/pet-live2d.png) |
| 📱 **Moments feed**<br>Watch Lumina, Recha, and Yak's spontaneous posts | ![Moments](docs/images/moments.png) |

---

## 🧪 Tech Stack

| Layer | Technology |
|----------|----------------|
| Desktop Framework | **Electron 40** |
| Frontend | **React 19** + TypeScript + Vite |
| State Management | **Zustand 5** (persist) |
| Build | electron-vite + electron-builder (NSIS) |
| Database | better-sqlite3 |
| Testing | Vitest |
| Auto Update | electron-updater (GitHub Releases) |
| Protocols | MCP (Model Context Protocol) |
| Pet UGC | Custom 8×9 sprite sheet (no Blender needed; AI can generate) |
| Test scale | **311 files / 4637 passing / 1 skipped / 0 failing** (measured locally; a few timing tests load-sensitive, see "Known Issues") · `tsc --strict` zero errors (CI-enforced) · ESLint error level 0 + warning ratchet · CI includes native ABI gates |

---

## 🗺️ Roadmap

The full version is in **[docs/ROADMAP.md](docs/ROADMAP.md)** (including the known-gaps table and claiming guide).

**✅ Current dev build (v0.1.0-preview)**
Three-agent team (pipeline + adversarial review + dynamic hiring) + emotion system (5 primary expressions + affinity + day/night two-state, 9 underlying labels) + memory system (BM25/TF-IDF hybrid recall + anti-hallucination anchoring) + 142 tools + real screen vision + Computer Use + 🛡️ smart sandbox + 8×9 sprite-sheet UGC spec + pet bound to real agent state

**✅ Shipped release hardening**
- [x] Native module ABI aligned with Electron (CI-gated; no more "tests green, real machine explodes")
- [x] Auto-verify-fix loop converged to a **single implementation** (eliminated duplicate logic)
- [x] Routing arbitration wired to real callers (only ambiguous tasks call the LLM; 1.2s hard timeout, non-blocking)
- [x] Dead-code cleanup: parallel engine hooked into stage gating, affinity-based review tone hooked into real prompts
- [x] Doc numbers aligned with code + honest capability matrix

**🔜 v0.1.0** — Windows installer signing · release demo video · one-click newcomer checkup
**🔜 v0.2.0** — sprite-sheet local atlas import toolchain + validator
**🔜 v0.3.0** — finer-grained binding of pet emotion to execution state (stuck-anxiety, approval-wait, wrap-up relief, etc.)
**🔜 v0.4.0** — macOS real-hardware verification + signing/notarization · Linux mouse-keyboard solution
**🔜 v1.0** — IM channels end-to-end real-hardware verification (wiring done, 7 adapters) · skill marketplace ecosystem · multi-device memory sync

> 💡 **Future ideas (planned / unimplemented, direction only):**
> ① Cost-observable demo recording — show "how many tokens this step cost" in the demo video and newcomer guide, turning cost from a black box into a visible number;
> ② A marketplace ecosystem for skills / persona appearances — let creators list skill packs and pet skins, forming community supply.

### 🧪 Experimental / Easter-Egg Features (Not Mainline, Don't Take Seriously)

- **Dream journal, agent reality show:** wired to real LLM generation (after configuring an LLM in settings, it uses the real model); when unconfigured it falls back to **9 emotion-anchor templates + memory-fragment keywords**, and the UI honestly labels `source: llm / source: template` — never pretending it was written by a big model.
- **Memory retrieval:** default is BM25 + TF-IDF dual-path RRF hybrid recall (shipped, zero-dependency; Chinese uses unigram+bigram character-level segmentation, no dictionary); dense semantic vectors (Ollama nomic-embed-text or an external embedding service) can be enabled in memory settings for stronger semantic matching.
- **Sub-persona awakening (experimental):** the minimal real mechanism is live — persona drift / sub-perspective based on long-term memory + emotional state, triggered by "high affinity + ~200 cumulative conversation turns" or "sustained high anxiety," behind the `personality.subPersona` toggle and **off by default**, turn-offable anytime; still experimental and not representative of core companionship.

### 🧪 Experimental Features (New in v0.1 · Settings → Experimental)

The six items below are new capabilities wired up with v0.1. Except for "Budget Guardian," they are **all off by default**, and can each be toggled in
**Settings → Experimental features**. They're still in observation, so they don't disturb you by default.

| Feature | Default | What it does |
|------|------|--------|
| 🛡️ **Budget Guardian** | **On** | Uniformly records the real cost of every LLM call (when usage is unavailable, explicitly labels it "estimate"), with a built-in DeepSeek/SiliconFlow/Qwen/OpenAI price table; settable daily budget. **Only tightens, never loosens:** 80% reminder + pet enters a "budget-conscious" state, 95% auto-downgrades to a cheaper model and pauses non-essential background calls, 100% keeps only conversations you initiate; auto-reset at midnight, full audit causal chain throughout. |
| 📼 **Day Replay** | Off | Aggregates the day's ledger, command audit, task board, and worker executions into a timeline — what you did, which files you changed, how many conversation turns, how many tokens spent — reviewable in the panel, exportable to Markdown / plain text. |
| 📊 **Emotion × Productivity Dashboard** | Off | Snapshots the emotion triple and result at delegation and tool execution, buckets trends, supports CSV/JSON export. Two honest designs: ① once you turn on the "control group" A/B toggle, the UI clearly states the **control group turns off the emotion-gating tightening mechanism**; ② when a bucket has fewer than 30 samples, it directly shows "insufficient data, no conclusion," rather than forcing a trend. |
| 🌙 **Ritual Loop** | Off | Bedtime review (default 23:00: aggregate Day Replay → LLM narration → TTS + pet motion) and morning briefing (default 8:00: weather/calendar/todos/unfinished items). When TTS is missing it degrades to text bubbles; with no LLM it uses templates labeled `source: llm / template`, never pretending it was model-written; auto-pauses when over budget. |
| ⚖️ **Three-Column Decision** | Off | Triggered by `/decide` or "help me decide…": executor's view lists pros/cons, reviewer's view picks risks, Lumina gives the final recommendation, three cards side by side. You always talk to only one Lumina entry point; the background division of labor stays hidden. |
| 🤝 **Handover Mode** | Off | Generate a handover card (day summary + pending approvals + todos + three-agent status, with timestamp and expiry), locally encrypted export (password derived via scrypt/pbkdf2 + AES-256-GCM, `.lumina-handover` file), QR code via **LAN URL**; open the `/m` handover view on a phone and **enter the password on the phone page to decrypt**, approve/reject reusing the existing approval endpoints. Snapshots auto-expire, and it clearly states LAN-only, do not expose to the public internet. |

> Also: P2-8 command guardrails are wired up — the REJECT layer's 6 dangerous commands (recursive delete of root / format / shutdown / delete registry / pipe execution / fork bomb) are **on by default, blocked on hit**; the APPROVAL layer's 8 (write registry / turn off firewall / write system dirs / elevate / outbound, etc.) go through the feature flag `security.commandApproval` and **default off in canary**, graduating to on after confirming no false positives. See [SECURITY.md](SECURITY.md).

---

## 🔓 Open Source

Lumina Life is released under a **dual license** — you choose either of the two:

### Option 1: AGPL-3.0 (Community Edition)

For individual users, open-source projects, and educational use.

| ✅ You may | 📋 You must |
|----------|------------|
| Freely use, modify, distribute | Disclose source when distributing modified versions |
| Create custom roles/personas | Keep the copyright notice |
| Develop new skills and share them | Network interaction counts as distribution (standard AGPL-3.0 terms) |
| File issues and feature requests | — |
| Use freely for personal purposes | — |

> **Why keep AGPL-3.0?** We want Lumina's core to stay open forever, so the community can freely customize and improve it. Users who choose AGPL-3.0 give their improvements back to the whole community.

### Option 2: Apache 2.0 (Commercial Edition)

For enterprise integration, commercial product embedding, and closed-source deployment.

| ✅ You may | 📋 You must |
|----------|------------|
| Freely use, modify, distribute | Keep the copyright notice |
| Integrate into commercial closed-source products | No "open-source contagion" requirement |
| Create derivative works (including closed-source) | Mark modifications prominently |
| Use for commercial purposes | — |

> **The choice is yours.** Both licenses ship in the project root:
> - [`LICENSE`](LICENSE) — AGPL-3.0
> - [`LICENSE-APACHE`](LICENSE-APACHE) — Apache 2.0

---

## 👋 A Note from the Author

This is my first open-source project on GitHub.

I didn't start out trying to build a "framework" or a "platform." I just wanted something a lot of us quietly wish for: a companion that actually lives on your desktop — not a web page you visit, not a chatbot you close when you're done, but something that stays, notices things, and genuinely helps. Lumina is my attempt at that.

Building her taught me more than I expected. I learned how to design an agent loop, how to make tools that fail honestly instead of pretending to work, how to keep personal data local, and — maybe most importantly — how to be honest about what isn't finished. You'll notice the Known Issues section is long. That's deliberate: I'd rather over-disclose than over-promise.

A few honest things:

- This is a one-person project built largely in spare time, so responses and fixes may be slow — please be patient.
- It's not perfect, and it's not a finished product. I'm putting out a preview early because I believe real feedback matters more than my imagination.
- If you take the time to open an issue, share an idea, or even just say hello in Discussions, it genuinely makes a difference.

If Lumina made your desktop feel a little less lonely, or helped you get something done, that's already everything I hoped for. And if you build something with her — a custom agent, a skill, a new pet — I'd love to see it.

Thank you for stopping by.

---

## 💬 Community

| Channel | Purpose |
|------|------|
| 💡 [GitHub Issues](https://github.com/chaxu814/lumina-life/issues) | Bug reports & feature requests |
| 📖 [GitHub Discussions](https://github.com/chaxu814/lumina-life/discussions) | Technical discussion & tips |
| 🎨 [Contributing Guide](CONTRIBUTING.md) | Full guide to contributing |
| 📝 [Changelog](CHANGELOG.md) | Release history |

---

<p align="center">
  <br>
  <b>Made with ❤️ by the Lumina team. And by Lumina herself. 🐱</b><br>
  <sub>She helped write this README. No, really.</sub>
  <br><br>
  <sub>⭐ If Lumina brought you a smile, please give the repo a star ⭐</sub>
</p>
