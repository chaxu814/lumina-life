# Experimental Features

> This page covers the six new features wired up in v0.1. They all live under **Settings → Experimental Features**:
> except for Budget Guardian (on by default), the other five are **off by default**, and you can toggle each one individually.
> "Experimental" means: the mechanics are real, we're still in the observation period, and nothing will disturb you by default without your consent.

---

## 🛡️ Budget Guardian — on by default

Lumina periodically calls the LLM in the background (proactive chatter, team social, rituals), and the bill quietly adds up. Budget Guardian folds all of this into one ledger:

- **Unified accounting**: every LLM call is accounted for at the call layer, preferring the real usage returned by the model;
  when usage is unavailable, estimates are **explicitly labeled "estimated"** — an estimate is never disguised as a measured value.
- **Configurable price table**: built-in provider pricing for DeepSeek / SiliconFlow / Qwen / OpenAI, adjustable in settings.
- **Daily budget**: supports ¥/day tiers and custom amounts, auto-resetting at midnight.
- **Three tiers of tightening only**:
  - **80%**: gentle reminder; the desktop pet switches to a "tightening the purse strings" behavior;
  - **95%**: automatically degrades to a cheaper model and pauses non-essential background calls;
  - **100%**: only conversations you initiate are kept; every background self-call stops.

**The design principle is "tighten, never loosen"** — the budget mechanism can never exceed the cap you set, and it will never let things through just because "today feels generous". Every step leaves an audit causal chain you can review in the ledger.

---

## 📼 Day Replay — off by default

At the end of a day, you often can't remember "what did Lumina actually do for me today?" Day Replay aggregates records scattered across the app into a single timeline:

- Aggregates the day's **ledger, command audit, task board, and hiring execution records**;
- Review them in a panel: what was done, which files were changed, how many conversation turns, how many delegations, how many tokens were spent;
- Supports exporting **Markdown / plain text** for archiving or sharing.

It only reads existing records and adds no background calls, so turning it on costs nothing extra.

---

## 📊 Emotion × Productivity Dashboard — off by default

Lumina's emotion genuinely tightens the tool permissions in her hands (emotion gating). This dashboard watches the other way around: **does emotion actually make her work more reliable?**

- Snapshots the emotion vector and execution result at the moment of delegation and tool execution, then buckets them and charts trends;
- Supports **CSV / JSON** export so you can plot and verify it yourself.

Two honest design choices we insist on:

1. **A/B control toggle**: once you turn on the "control group", the UI warns you explicitly — the control group **disables the emotion-gating tightening mechanism**. That's what a controlled experiment requires, not a bug.
2. **Sample threshold**: when a bucket has fewer than 30 samples, the panel shows "not enough data to draw a conclusion" instead of forcing a plausible-looking trend line.

---

## 🌙 Ritual Loop — off by default

Turns "bedtime review" and "morning briefing" into two scheduled rituals:

- **Bedtime review** (default 23:00): aggregates the day's Day Replay → the LLM generates a script → TTS reads it aloud with matching pet animations;
- **Morning briefing** (default 8:00): aggregates weather, calendar, todos, and unfinished items for a lightweight opening.

The degradation chain is honest: **without TTS it falls back to a text bubble; without an LLM it uses template copy labeled "source: llm / template"** — it will never pretend that paragraph was written by a large model. When the budget is exceeded, rituals pause automatically instead of running at a loss.

---

## ⚖️ Three-Column Decision — off by default

When you're torn about "how should I handle this?", type `/decide` (or say "help me decide…"):

- **Executor's view**: lists the pros and cons of this path;
- **Reviewer's view**: picks at the risks and counterarguments;
- **Lumina's final recommendation**: three cards side by side, with Lumina giving one consistent conclusion.

You always talk to Lumina through a single entry point — the division of labor behind the scenes is not exposed in the UI.

---

## 🤝 Handover Mode — off by default

When you're away from the computer, you may want to hand "where things stand right now" to another device. Handover mode does it like this:

- **Handover card**: aggregates a Day Replay summary, pending approvals, todos, and the current state of the three Agents, with a timestamp and TTL;
- **Local encrypted export**: the passphrase derives keys via scrypt / pbkdf2 and encrypts with AES-256-GCM; the file extension is `.lumina-handover`;
- **View on your phone**: a QR code points to a **LAN URL**; after the phone opens the `/m` handover view, **the passphrase is entered and decrypted only on the phone's browser page** — it is never sent to the computer;
- **Approve / reject**: reuses the existing approval API; snapshots expire automatically.

Please respect the security boundary: **use it only on the LAN; never expose the port to the public internet.** See the "handover security model" section of `SECURITY.md` in the repo root.

---

## Also: command guardrails are already on by default

No toggle needed: the REJECT layer's 6 dangerous commands (recursive root delete, format, shutdown/reboot, registry deletion, download-and-pipe-execute, fork bomb) are **on by default and blocked the moment they match**; the APPROVAL layer's 8 commands (write registry, disable firewall, write to system directories, privilege escalation, data exfiltration, etc.) go through the `security.commandApproval` gradual rollout switch, which is **off by default** while we observe false positives, before graduating to permanent.
