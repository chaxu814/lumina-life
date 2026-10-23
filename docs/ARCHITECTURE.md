---
title: Architecture Overview
---

# Lumina Life Architecture

> ⚠️ **This document was rewritten in v3.34.** The old version described file paths and tool counts that largely no longer match the actual code
> (e.g. placing the three-Agent team under `electron/agents/` and listing the tool count as 88+). Everything has been corrected against the current
> HEAD. **If you see a path like `electron/agents/agentTeamManager.ts` in an older doc, that is wrong** — see the tables below for the real locations.

---

## Overall Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Electron Shell                                │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                     Main Process                             │   │
│  │                     electron/  (~144k lines)                 │   │
│  │                                                              │   │
│  │  ┌────────────┐  ┌──────────────┐  ┌──────────────────┐      │   │
│  │  │ Agent      │  │  Tool System │  │  Memory System   │      │   │
│  │  │ engine     │  │ tools/ (77)  │  │ memory/ (13)     │      │   │
│  │  │ agentRunner│  │ registry     │  │ hybridRecall     │      │   │
│  │  │ delegation │  │ impl/        │  │ evidenceBridge   │      │   │
│  │  │ team/ (17) │  └──────────────┘  └──────────────────┘      │   │
│  │  │ orchest.(11)│                                                │   │
│  │  └────────────┘                                                │   │
│  │  ┌────────────────────────────────────────────────────────┐   │   │
│  │  │  Security layer: rolePolicy (single source of truth) · │   │   │
│  │  │  securityGuard · sandboxRules · shell 4-layer sandbox  │   │   │
│  │  │  · accessControl (settings panel)                      │   │   │
│  │  └────────────────────────────────────────────────────────┘   │   │
│  │  ┌────────────────────────────────────────────────────────┐   │   │
│  │  │  Capability layer: orchestration/ · team/ · proactive/  │   │   │
│  │  │  · skills/ · mcp/ · ipc/ (27)                          │   │   │
│  │  └────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│                             │ IPC                                    │
│  ┌──────────────────────────┴───────────────────────────────────┐   │
│  │           Renderer  src/ (~46k lines)                       │   │
│  │           47 panels · React 19 · Zustand 5 · UnoCSS        │   │
│  │           Plus electron/pet/ (53) for desktop pet rendering │   │
│  │           (multi-window)                                    │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Directory Sizes (measured in v3.34)

| Directory | Files | Lines | Responsibility |
|---|---:|---:|---|
| `electron/` | 501 | 144,341 | All main-process logic |
| `src/` | 146 | 46,239 | Renderer UI |
| `tests/` | 187 | 26,557 | Vitest unit + integration tests |
| `python/` | 12 | 1,055 | Voice / optional dense embedding |
| `docs/` | 60 | 8,179 | Documentation site (VitePress) |
| **Total (excl. node_modules)** | **~1,030 tracked files** | **~218,000** | |

Subdirectory breakdown:

| Directory | Files | Lines | Notes |
|---|---:|---:|---|
| `electron/tools/impl/` | 77 | — | Tool implementations |
| `electron/pet/` | 53 | — | Desktop pet rendering (Live2D / VRM / sprite sheets / MMD / cat) |
| `electron/ipc/` | 27 | — | Main ↔ renderer channels |
| `electron/gaming/` | 21 | — | Game companion (vision route + optional Mineflayer) |
| `electron/team/` | 17 | 4,574 | Team capabilities (adversarial review / temp hires / autonomy / mailbox / board…) |
| `electron/proactive/` | 16 | — | Proactivity engine (gating / backoff / unfinished threads) |
| `electron/core/` | 25 | — | LLM providers, ReAct engine, path resolution |
| `electron/memory/` | 13 | — | Memory storage and retrieval |
| `electron/orchestration/` | 11 | 3,731 | Orchestration (routing / phase gating / complexity / verify loop) |
| `electron/api/` | 11 | — | REST API routes |
| `electron/channels/` | 11 | — | IM channel adapters (**wired up**, but users must configure their own credentials — see "Known Gaps") |
| `electron/stt-server` `whisper/` | 13 | — | Local voice input |

---

## Core Modules

### 1. Agent Engine

> ⚠️ Older docs placed these files under `electron/agents/` — **that directory actually only contains
> `customAgentManager.ts` and three `agent.json` files**; the engine itself lives entirely in the `electron/` root.

| File | Size | Responsibility |
|---|---:|---|
| `agentRunner.ts` | **173 KB** | ReAct main loop: message → LLM → tool → result → continue. See "Known Tech Debt" below |
| `delegationManager.ts` | 47 KB | Delegation main flow, retry convergence, **five-phase gating** `phaseGatedDelegate` |
| `agentCompactor.ts` | 34 KB | Context compaction (tiered by model window, triggers at 65%/60%/50%) |
| `agentConfig.ts` | 30 KB | Per-Agent LLM config, `buildRunConfig`, disabled-tool set computation |
| `agentSocialEngine.ts` | 31 KB | Group chat, morning rituals, Moments feed |
| `agentSkills.ts` | 24 KB | Skill registration and matching |
| `agentTeamPersonas.ts` | 22 KB | The three Agents' personas, system prompts, and role boundaries (**the real source of personas**) |
| `agentTeamTypes.ts` | 15 KB | Team type definitions |
| `agentPool.ts` | 11 KB | Agent instance pool and lifecycle |
| `agentProfileManager.ts` | 11 KB | Reads `agents/<id>/agent.json` |
| `agentTeamContext.ts` | 11 KB | Shared context |
| `teamProactiveSystem.ts` | 13 KB | Team-level proactivity coordination |
| `agentRelationships.ts` | 8 KB | Inter-Agent intimacy/trust evolution |
| `core/reactEngine.ts` | 37 KB | Tool-call parsing (XML + JSON dual paths) + role gate |
| `core/llmProvider.ts` | — | Unified LLM calls, watchdog, capability degradation |

### 2. The Three-Agent Team

| Agent | Role | Visible to user | Tool boundary | Responsibilities |
|---|---|---|---|---|
| **Lumina** 🐱 | `boss` | ✅ The only interface | Full access | Chat · emotion awareness · delegating work · summarizing results |
| **Recha** 🍵 | `worker` | ❌ | Read-only (`RECHA_ALLOW`, 12 items) | Code review · error-spotting · risk assessment |
| **Yak** 💻 | `worker` | ❌ | Writable, executable, committable (`YAK_ALLOW`, 27 items); no second-order delegation | Writing code · debugging · refactoring · running tests |

**Persona source** (important): `agents/<id>/agent.json` only manages LLM and tool config; **personas live in two places**:
1. `electron/agentTeamPersonas.ts` — role definitions and system prompts (primary)
2. `electron/agents/<id>/{AGENTS,SOUL,PROFILE,MEMORY}.md` — the 4-piece identity files per Agent

Delegation flow:
```
User question
  → routingDecider judges complexity (high-confidence rules are used directly; ambiguity triggers one LLM arbitration; failures fall back to rules silently)
  → simple → delegate_to direct dispatch
  → complex → phase_gate_delegate → Research→Plan→Execute→Verify→Review
                              → each output goes through adversarial_review (concurrent multi-perspective delegation to Recha)
  → Lumina consolidates → replies to the user
```

**Team capability modules** (`electron/team/`, 4,574 lines):

| File | Capability |
|---|---|
| `adversarialReview.ts` | Concurrent multi-perspective adversarial review (delegated simultaneously via `Promise.all`) |
| `dynamicWorker.ts` | Dynamic hiring of temp workers, parallel execution, independent blacklists |
| `teamAutonomy.ts` | Workers self-claim work driven by intrinsic motivation (proactivity rises with idle time) |
| `teamSharedBoard.ts` | Shared team task board |
| `workflowScript.ts` | Scripted workflows (batched concurrency) |
| `teamMailbox.ts` `teamPolicy.ts` `teamCheckpoint.ts` `teamDailyLog.ts` | Mailbox / approvals / snapshots / daily log |
| `workerStats.ts` `llmTrace.ts` `relationshipDrama.ts` `modelTier.ts` | Profiles / tracing / relationship evolution / model tiers |
| `gitWorktree.ts` `cuCrew.ts` `teachRecorder.ts` `agentMarkdown.ts` | Isolated worktrees / Computer Use crews / teaching recordings / Markdown Agent |

**Orchestration modules** (`electron/orchestration/`, 3,731 lines):

| File | Capability |
|---|---|
| `phaseGate.ts` | Five-phase state machine (reached via the `phase_gate_delegate` tool) |
| `complexityAnalyzer.ts` | Task complexity scoring |
| `routingDecider.ts` | Three-tier routing arbitration (dynamic `require()` to avoid circular dependencies) |
| `internPool.ts` | Intern pool |
| `verifyLoop.ts` `yakParallel.ts` `taskBoard.ts` | Verify loop / parallel batches / task board |
| `emotionGating.ts` | Emotion-participated tool tightening (**can only tighten, never loosen**) |
| `delegationPrompt.ts` `theater.ts` `theaterBridge.ts` | Delegation prompts / theater |

### 3. Tool System

**Registry**: `electron/tools/registry.ts` + `electron/tools/index.ts` (registration entry) + `impl/` (77 implementation files)

**Measured scale (v3.34)**:

| Metric | Count |
|---|---:|
| Registered and passing validation | **132** |
| Orphans unreachable by any toolset | **0** |
| Visible in `chat` mode | 0 |
| Visible in `agent` mode | **48** |
| Visible in `developer` mode | **69** |
| `full` (everything, newly added) | 132 |

**Tiering mechanism** (rewritten in v3.34 — read this carefully):
- **Mode layer** (`chat` / `agent` / `developer`) is marked by `MODE_TOOLSETS`, a **static table that owns the tiers exclusively**.
  It expresses the product decision of "how much capability does this tier give the user", and is not swayed by the tools' own declarations.
- **Capability layers** (`team` / `lsp` / `browser` / `computer_use` / `creator` / `research` /
  `media` / `social` / `voice` / `news`) are now **declarative**: any tool whose
  `ToolDef.toolsets` lists that name is automatically included. New tools become visible simply by declaring `toolsets` correctly.
- `full` = all registered tools, for power users / debugging.
- Startup logs print the reachable count per tier and warn about tools unreachable by any toolset.

> **Why this changed**: before v3.34, `resolveToolset()` only read the static `TOOLSETS` constant table
> and **completely ignored `ToolDef.toolsets`** (even though it is a required field declared in 58 files).
> The result: of 132 registered tools, **47** were completely unreachable by the model — including
> `team_message` / `hire_worker` / `adversarial_review` / `desktop_act` /
> `creator_*` / `lsp_*`, while `agentTeamPersonas.ts` was still teaching the model to call 5 of them.
> See `docs/BENCHMARKS.md` and CHANGELOG v3.34 for details.

**Tool definition schema** (`ToolDef`, `electron/tools/types.ts`):
```ts
{ name, description, params, toolsets: string[], dangerous?, blockedInChild? }
```

### 4. Memory System

Storage: SQLite (better-sqlite3). `electron/memory/`, 13 files.

| File | Responsibility |
|---|---|
| `memoryStore.ts` | 63 KB core store. Six layers: facts / reflections / persona / profile / config / summaries |
| `hybridRecall.ts` | **BM25 + TF-IDF cosine, fused via RRF** (zero-dependency, CJK-friendly) |
| `evidenceBridge.ts` | New in v3.34: wires the five-dimensional scoring of `memoryEvidence.ts` into the read/write path |
| `scrollContext.ts` | Scroll mode: long-context eviction becomes indexing instead of compaction |
| `layeredMemory.ts` `layeredMemoryAdapter.ts` | Layered memory |
| `relationshipEvents.ts` | Relationship event stream (gated by a feature flag) |
| `remeLight.ts` | ReMeLight index (silently degrades when the Electron ABI is unavailable; does not affect the main flow) |
| `summarizer.ts` `unified.ts` `federation.ts` `base-memory-manager.ts` `affinityDecay.ts` | Summarization / unified interface / federation / base class / intimacy decay |

**Two confidence mechanisms (now wired up in v3.34)**:

| Mechanism | Location | Role | Status |
|---|---|---|---|
| `SOURCE_CONFIDENCE` | `memoryStore.ts:55` | A hard constraint at write time — memory authority is **determined solely by `source`**; the model cannot self-assign `confidence: 1.0` | Always on |
| Five-dimensional evidence scoring | `memoryEvidence.ts` | Read-time ranking and lifecycle (confirmed/pending/outdated/contradicted) | **Wired in v3.34** (16 KB of dead code before) |

The two are connected through `evidenceBridge.ts` **without rewriting either one**. Invariant: adding a second mechanism must not introduce a second "who decides".

Default retrieval is BM25 + TF-IDF dual-path RRF fusion (zero-dependency). Dense semantic vectors (Ollama
nomic-embed-text or an external embedding service) are **optional and off by default**.

### 5. Security System

| Layer | File | Responsibility |
|---|---|---|
| **Hard role gate** | `rolePolicy.ts` | Single source of truth. `isToolAllowedForRole()`, deny-first |
| Execution-layer check | `core/reactEngine.ts:133` | `checkRoleGate()`; **both** XML and JSON parse paths call it |
| Advertisement-layer filter | `agentRunner.ts:3313` | Filters through rolePolicy again before the schema is handed to the LLM |
| Message/parameter level | `securityGuard.ts` | 6 levels × 10 categories of rules; CRITICAL defaults to `blockCritical` |
| Command level | `sandboxRules.ts` | 7 levels × 8 categories, 26 rules |
| Shell 4-layer sandbox | `tools/impl/shell.ts` | ① process-tree isolation ② network cage (HTTP_PROXY hijack + domain whitelist) ③ file wall (OS Integrity Level downgrade) ④ rule base |
| Approval flow | 3 places in `agentRunner.ts` | `requestApproval()` — ask the user before dangerous operations |
| Settings panel | `accessControl.ts` | User-inspectable, user-adjustable path/domain/command permissions |
| Crash fallback | `crashGuard.ts` | `unhandledRejection` logs and keeps running; `uncaughtException` saves a snapshot before exiting |

> ⚠️ `rolePolicy.ts` and `accessControl.ts` describe the same thing but were written independently.
> `tests/rolePolicyAccessControlParity.test.ts` is the parity guard added in v3.34:
> if either side changes without the other catching up, the test goes red immediately and points out the diff. **This is drift prevention,
> not duplicate elimination** — truly merging the two tables should be a separate task, at which point the diff should always be empty.

### 6. Proactivity

`electron/proactiveEngine.ts` (56 KB) + `electron/proactive/` (16 files)

8 kinds of timers: regular triggers (60s) · screen awareness (10min) · trending-topic awareness (30min) · daily reset ·
routine learning (30min) · Daily Paper · opportunity awareness (60s) · health care (3 independent timers)

Data sources are real network requests (Bilibili + Weibo + arXiv fetched concurrently). Gating is comprehensive:
`gate.ts` (trigger gate) · `backoff.ts` (exponential backoff) · `notificationPolicy.ts` ·
`unfinishedThread.ts` (unfinished threads) · `followupTopics.ts` · `innerThoughts.ts`.

Workers self-claim work in `team/teamAutonomy.ts`: proactivity rises with idle time (peaks at 3 minutes)
plus jitter; the global concurrency cap defaults to 2 (`LUMINA_MAX_CONCURRENT`, adjustable 1–8), renewed every 45s via heartbeat.
The deliberately conservative default is intentional — lines 57–70 of that file explain why: the desktop pet lives on the user's desktop,
and running tasks on its own at night burns tokens, drains the battery, and eats CPU, and users will just uninstall it.

---

## Known Tech Debt

Listed honestly; better that than hiding it until an issue digs it up.

| Debt | Size | Status |
|---|---:|---|
| `agentRunner.ts` is a huge single file | 173 KB | A single file carrying the whole ReAct main loop; intimidating for outside contributors. `agentRunner.constants.ts` has been split out, but the main file still needs further splitting |
| Circular dependencies: gate exists, 13 runtime rings remain (ratchet-locked) | 13 rings | v3.34 moved `registerAllTools()` from the `agentRunner` module top level into the constructor (`registrationFlag.ts` holds the flag). **2026-10-19**: introduced `scripts/check-circular.cjs` (madge, `skipTypeImports` semantics, CI gate `npm run check:circular`) — measured 13 runtime rings in electron/, 0 in src/; mostly "tools registry ↔ consuming impl" shapes, sidestepped with in-function lazy singletons to avoid init-time TDZ. The baseline is locked in `scripts/circular-baseline.json` and may only shrink. Ring breaking is a P2 refactor (same risk level as splitting agentRunner) and does not block releases |
| `electron/channels/adapters/` off by default, never verified on real hardware | 11 files | **The wiring exists** (`main.ts` loads bridges dynamically with `await import()`, the bundler inlines them, and all 7 adapters have real implementations). The real gaps: adapters only start when configured with `enabled: true`, users must supply their own credentials, and no end-to-end real-hardware verification has been done. **Corrected 2026-10-04**: this used to say "not wired" — that was because a batch of project checks grep for static imports, while the adapters use dynamic imports, so scanners missed them and misjudged them as unwired |
| `electron/mission/` has zero references | 5 files / 767 lines | Complete, unreferenced |
| ~~`electron/mcp/mcpConfigLoader.ts` not wired~~ | — | **Corrected 2026-10-19: this directory was deleted during the dead-code cleanup.** The real MCP implementation lives in `electron/mcpServer.ts` and `tools/impl/mcp.ts` (client tools `mcp_connect` / `mcp_call_tool` etc. are registered and available) |
| `electron/persona/subPersona.ts` has no consumers | 9 KB | Even with the `personality.subPersona` feature flag on, nobody reads it |
| `dangerous` flags on `tools/impl/duo`-class tools | — | Suggest adding a static CI check |
| Coverage gate scope is narrow | 17 files | The three cores — `agentRunner` / `delegationManager` / `memoryStore` — are all outside the gate |
| macOS / Linux desktop control unverified on real hardware | — | The code is adapted but **has never run on real hardware**. Windows is the only platform verified on real hardware |

---

## Related Documentation

- [API.md](API.md) — REST API
- [custom-agent-guide.md](custom-agent-guide.md) — Custom Agents
- [skill-tutorial.md](skill-tutorial.md) — Skill development
- [BENCHMARKS.md](BENCHMARKS.md) — Quality benchmarks and self-test metrics (three gates, code and test scale, core-mechanism self-checks)
- [ROADMAP.md](ROADMAP.md) — Roadmap and known-gap ownership
- [gaming-overview.md](gaming-overview.md) — Game companion

> ℹ️ Historical audit reports from before releases are kept in a local `archive/` (not shipped with the repo),
> so no link to them is given here — a link that doesn't open on GitHub
> is worse than no link at all. The current numbers are governed by the "Known Tech Debt" table in this file and [BENCHMARKS.md](BENCHMARKS.md).
