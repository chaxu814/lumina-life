# Lumina Life · Roadmap

> The goal of this roadmap is to be **honest**: it spells out what we can't do yet and what we plan to do next.
> Contributions are welcome — pick off any item, or open a PR to add your own direction (see [CONTRIBUTING.md](https://github.com/chaxu814/lumina-life/blob/master/CONTRIBUTING.md)).

**Current version**: v0.1.0-preview ｜ **Verified platforms**: Windows 10/11 x64

---

## 🚦 Must-Complete Before Public Release (v0.1.0 Release Gate)

- [x] Native module ABI aligned with Electron (`better-sqlite3` rebuild + CI gate)
- [x] Docs numbers aligned with code (tool counts taken from the live registry, not hardcoded in README)
- [x] Auto verify-fix loop converged to a single implementation (eliminated duplicated logic)
- [x] Routing arbitration wired to real callers (ambiguous tasks call the LLM with a 1.2s hard timeout)
- [x] Dead code cleanup (parallel engine hooked into phase gates; intimacy tone wired to the real review prompt)
- [x] Honest capability matrix written into the README (what it does / does its best / can't do)

## v0.1.0 · First Public Release

- [ ] Sign the Windows installer (reduce SmartScreen warnings)
- [ ] Record release demo video / GIF (the desktop pet category spreads visually; a text-only README grows slowly)
- [ ] Onboarding mode: one-click health check + config wizard (right now users must install LM Studio or fill in an API key themselves, which is a high barrier)

## v0.2.0 · Desktop Pet UGC

- [ ] **8-column × 9-row sprite sheet spec** (using the well-established desktop pet action sheet format:
      idle/run/wave/jump/fail/wait/work/gaze, one animation set each; run-left is auto-derived by horizontal flip)
- [ ] Local atlas import toolchain: three paths — single static image / AI-generated action sheet / existing atlas
- [ ] Import validator: dimensions, total pixel count, file size; **reject white-background images outright**
- [ ] Fully local processing — no uploads, no model quota consumption

## v0.3.0 · Desktop Pet = Visualization of Agent Runtime State

> This is the line we want to cross: many comparable desktop pets stop at "status notification" —
> they can't approve permissions for you, and you can't ask them questions directly in the floating window.

- [ ] Expressions and animations bound to **real execution state** (not random emotion animations)
      - When writing code: typing animation + focused expression
      - When reviewing: frowning, magnifying glass
      - When verification fails: facepalm / sigh
      - When waiting for results: pacing back and forth
- [ ] Three-state task visualization (working / waiting on you / needs attention), wired to `taskBoard` state
- [ ] "Why is she quiet today?" explainability panel: show the emotion → behavior threshold → actual decision chain

## v0.4.0 · Cross-Platform (Long-Standing Gap)

> **Honest note**: only Windows has been verified on real hardware so far. The macOS code is written but
> **has never been run on a real Mac**, and Linux is still on the roadmap. This is a hard weakness for the
> desktop pet category and the area where we most need community help.

- [ ] **macOS on-device verification**: coordinate mapping (Retina 2×), accessibility / screen recording permission flow, AppleScript real behavior
- [ ] macOS code signing and notarization
- [ ] Linux: Wayland blocks input injection by the compositor; need an alternative (uinput / XWayland)
- [ ] Cross-device memory sync (the current `electron/sync` exists but isn't productized)

## v1.0 · Ecosystem

- [ ] **End-to-end on-device verification** of IM channels (wiring is done: 7 adapters loaded dynamically via `await import()` and inlined by the bundler; what's missing is live credential testing per channel and usage guidance. Mature implementations in the industry already cover 20+ channels)
- [ ] Skill marketplace ecosystem (install/uninstall/upgrade exist; creator incentives needed)
- [ ] Built-in local inference (WebGPU in-app inference path)

---

## 💡 Future Ideas (Planned / Not Implemented, Direction Only)

> The two items below are directional ideas. **Not scheduled, not implemented** — they record what we want
> to build, not a commitment.

- **Cost-observable demo recording**: when recording release demos and onboarding guides, simultaneously capture "how many tokens this step actually cost" — turning ongoing cost from a black box into a visible number.
- **Marketplace ecosystem for skills / persona appearances**: let third-party creators list skill packs and desktop pet skins, building community supply instead of shipping only built-in content.

---

## 🐛 Known Issues and Gaps (Help Wanted)

| Area | Current State | Difficulty |
|------|---------------|------------|
| macOS desktop control | Code adapted, **zero on-device verification** | Medium (needs a Mac) |
| Linux support | Wayland input injection blocked | Hard |
| Installer size | ~157MB (includes Live2D runtime and local models) | Medium |
| Idle memory | ~775MB / 5 processes | Medium |
| Onboarding barrier | Must bring your own LLM (LM Studio or API key) | Medium (addressed in v0.1.0 onboarding mode) |
| Local inference | Requires external LM Studio; not built into the app | Hard |
| Community | Bus factor = 1; urgently need a second maintainer | — |

---

## 🛠 Environment Variable Tunables

| Variable | Effect | Default |
|----------|--------|---------|
| `LUMINA_MAX_CONCURRENT` | Max concurrent background autonomous tasks (1~8) | 2 |
| `LUMINA_LLM_TIMEOUT` | LLM request HTTP timeout (seconds, 0 = use model recommendation) | per model |
| `LUMINA_API_ENABLED` / `LUMINA_API_PORT` | Enable the REST API | off / 3456 |
| `DO_NOT_TRACK` | Disable anonymous telemetry | telemetry off |

> The default concurrency of 2 is **deliberately conservative**: the desktop pet lives on your desktop,
> and if it runs a pile of tasks by itself at night it burns tokens and battery, and users will
> uninstall it. Power users running multiple projects can raise it via `LUMINA_MAX_CONCURRENT`.

---

*Roadmap is updated as reality evolves. Last updated: 2026-10-14*
