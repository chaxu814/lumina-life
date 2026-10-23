# 🛠️ Developer Guide — Lumina Life

> For anyone who wants to understand how Lumina works under the hood, build on top of it, or contribute code.
> Target audience: developers with working knowledge of Node.js / TypeScript / Electron.

---

## 📋 Table of Contents

1. [Development Requirements](#-development-requirements)
2. [Quick Start](#-quick-start)
3. [Project Structure](#-project-structure)
4. [Core Architecture](#-core-architecture)
5. [Development Workflow](#-development-workflow)
6. [Configuration](#-configuration)
7. [Database Schema](#-database-schema)
8. [Testing](#-testing)
9. [Packaging and Release](#-packaging-and-release)
10. [Developer FAQ](#-developer-faq)

---

## ✅ Development Requirements

| Dependency | Minimum | Recommended | Purpose |
|------------|---------|-------------|---------|
| Node.js | 20.x | 22.x | Runtime (package.json `engines` requires ≥20) |
| npm | 9.x | 10.x | Package management |
| Git | 2.30+ | 2.40+ | Version control |
| Python | 3.10 (optional) | 3.12 | Voice / vector features |
| Editor | — | VS Code | Recommended |

**Windows extras:**
- Windows 10+ (Windows 11 recommended)
- Build tools: `npm install -g windows-build-tools` (if native module compilation fails)

**macOS extras:**
- Xcode Command Line Tools: `xcode-select --install`
- If you hit code-signing issues in dev, skip signing: `export CSC_IDENTITY_AUTO_DISCOVERY=false`

**Linux extras:**
```bash
sudo apt-get install -y libappindicator1 libayatana-appindicator3-1 libnss3 libfuse2
```

---

## 🚀 Quick Start

```bash
# 1. Clone
git clone https://github.com/chaxu814/lumina-life.git
cd lumina-life

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
# Edit .env and fill in your LLM settings (LM Studio is preconfigured by default)

# 4. Start in dev mode
npm run dev

# 5. Optional: install Python deps (voice / vectors)
pip install -r python/requirements.txt
```

> 💡 After the first launch, configure your LLM connection in the settings panel and you're ready to chat.

---

## 📁 Project Structure

> ⚠️ **Rewritten 2026-10-19 against the actual HEAD.** Earlier versions described directories like
> `electron/lumina-core/`, `electron/services/`, `src/components/ChatWindow/`, `src/store/`, `tests/unit/`
> that **do not exist in the current repo** — following the old tree will get you lost.
> The tree below was verified with `git ls-files` (major directories only).

```
lumina-life/
├── electron/                     # 👈 Main process (~148k lines, 577 tracked files)
│   ├── main.ts                   #    Entry: BrowserWindow, IPC, tray, CLI/API routing
│   ├── preload.ts                #    Preload script (contextBridge)
│   ├── agentRunner.ts            #    ReAct main loop (4,171 lines, see "Known Tech Debt")
│   ├── agentRunner.*.ts          #    Split-out constants / preprocessing / text / tool selection
│   ├── delegationManager.ts      #    Delegation flow + five-phase phaseGatedDelegate gates
│   ├── agentTeamPersonas.ts      #    Three-Agent personas and system prompts (single source of truth)
│   ├── agentConfig.ts            #    Per-Agent LLM configuration
│   ├── agentPool.ts               #    Agent instance pool and lifecycle
│   ├── agentSocialEngine.ts       #    Group chat / morning ritual / social feed
│   ├── rolePolicy.ts             #    Hard tool gates per role (YAK_ALLOW / RECHA_ALLOW)
│   ├── securityGuard.ts           #    Message/param-level security review (6 levels × 10 categories)
│   ├── sandboxRules.ts           #    Shell command rule set (BLOCK/CRITICAL/WARN)
│   ├── tools/                     #    🔧 Tool system
│   │   ├── registry.ts           #       Registry / tiers / execution and retry
│   │   ├── toolRouter.ts         #       Trim tool subset per turn
│   │   ├── types.ts               #       ToolDef schema
│   │   └── impl/                 #       80 implementation files / 139 registered tools
│   ├── team/                     #    Team capabilities (adversarial review / dynamic hiring / task board / mail…)
│   ├── orchestration/            #    Orchestration (routing / complexity / phase gates / verify loop / parallelism)
│   ├── memory/                   #    Memory (SQLite + BM25/TF-IDF RRF + evidence bridge)
│   ├── proactive/                 #    Proactivity engine (gates / backoff / unfinished topics)
│   ├── pet/                      #    Desktop pet 5-form renderer + state bridge + standalone chat window
│   ├── cli/                      #    Command line (doctor/health/chat/tool/agent/memory…)
│   ├── api/                      #    REST API routes
│   ├── channels/                 #    IM channel adapters (7, off by default)
│   ├── security/                 #    Command policy / static scan / threat intel
│   ├── permission/               #    Permission tiers and approval
│   ├── ipc/                      #    27 main ↔ renderer channels
│   ├── core/                     #    LLM providers / ReAct engine / platform adapters
│   └── agents/                   #    Identity files for built-in Agents (AGENTS/SOUL/PROFILE/MEMORY)
│
├── src/                          # 👈 Renderer (React 19 + Zustand 5 + UnoCSS, ~55k lines)
│   ├── App.tsx                   #    Root component
│   ├── main.tsx                  #    Entry
│   ├── panels/                   #    Feature panels (47: Chat/Settings/GroupChat/…)
│   ├── components/               #    Shared components (Icons / PersonaAvatar / TopBar…)
│   ├── stores/                   #    Zustand state (appStore / agentRuntimeStore…)
│   ├── services/                 #    Frontend services (LLM persistence / TTS / STT…)
│   ├── hooks/  data/  i18n/  lib/  utils/  styles/  types/
│   └── assets/                   #    Static assets (lumina-avatar.png, etc.)
│
├── tests/                        # 🧪 Vitest (310 test files / 4,632 cases, flat naming)
│   ├── *.test.ts                 #    Same name as the module under test (agentRunner.test.ts…)
│   └── fixtures/  gaming/  onboarding/  customAgent/
│
├── skills/                       # 📦 7 built-in skills (SKILL.md directory format)
├── docs/                         # 📖 Docs site (VitePress, 42 tracked files)
│   ├── .vitepress/               #    Site config
│   ├── ARCHITECTURE.md           #    Architecture and known tech debt (read before release)
│   ├── BENCHMARKS.md             #    Quality benchmarks and measurement methodology
│   ├── API.md                    #    REST API reference
│   ├── DEVELOPER.md              #    👈 You are here
│   └── FAQ.md / INSTALL.md / TROUBLESHOOTING.md / ROADMAP.md
│
├── python/                       # 🐍 Optional voice/vector service (edge-tts / whisper / embeddings)
├── scripts/                      #    Build, gates, one-off tools (lint ratchet / bundle-requires)
├── public/                       #    Renderer static assets (favicon, etc.)
├── resources/                    #    App icons and packaging assets (icon.ico / icon.png / icon-16/32)
│
├── out/                          #    Build output (electron-vite, gitignored)
├── dist/                         #    Packaging output (electron-builder, gitignored)
├── package.json                  #    Scripts + electron-builder config (no separate builder yml)
├── tsconfig.json
├── electron.vite.config.ts
└── vitest.config.ts
```

---

## 🧠 Core Architecture

### Three-Agent Collaboration Model

```
┌─────────────────────────────────────────────┐
│                    User                      │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│             Lumina 🐱 (BOSS)               │
│  Role: team lead                          │
│  Duties: take user requests, coordinate    │
│           the team, emotional interaction  │
└───────┬──────────────────────┬─────────────┘
        │                      │
┌───────▼──────────┐  ┌───────▼──────────────┐
│  Yak 📊 (DEV)    │  │  Recha 🍵 (REVIEW)   │
│ Role: Dev Agent  │  │ Role: Review Agent   │
│ Duties: write    │  │ Duties: review,      │
│         code,     │  │         find bugs,   │
│         debug     │  │         assess risk  │
│ Tools: files,    │  │ Tools: read-only     │
│        terminal  │  │        view, search  │
└──────────────────┘  └──────────────────────┘
```

### Agent Delegation Flow

```
User request → Lumina decides → need to write code?   → delegate to Yak
                               → need review / bug-hunt? → delegate to Recha
                               → ordinary chat         → Lumina answers directly
```

### Emotion System

5-dimensional emotion model:
- **Valence** (pleasure): −1 ~ +1
- **Arousal** (activation): 0 ~ 1
- **Dominance** (control): 0 ~ 1
- Emotion states: `happy` · `sad` · `angry` · `surprised` · `fearful` · `neutral` · `excited` · `calm`
- Intimacy: 0 ~ 100 (grows with interaction)

### Memory System

```
User input → short-term memory (current session)
           → important? → long-term memory (SQLite)
                         → vectorized → semantic search (vector DB)
                         → summarized → daily memory (MMR)
```

---

## 🔧 Development Workflow

### Adding a New Tool

```typescript
// electron/tools/impl/my-tool.ts
import { ToolDefinition } from '../registry';

export const MyTool: ToolDefinition = {
  name: 'my_tool',
  description: 'My custom tool',
  category: 'utility',
  parameters: {
    input: { type: 'string', required: true, description: 'Input text' },
  },
  handler: async (params: { input: string }) => {
    return { result: `You entered: ${params.input}` };
  },
};
```

Export and register it in `electron/tools/impl/index.ts`.

### Adding a New Skill

See the skill development guide (coming soon). A skill is a standalone directory containing a `SKILL.md` descriptor file.

### Running Tests

```bash
# All tests
npm test

# Watch mode
npm run test:watch

# Single file
npx vitest run tests/unit/emotion.test.ts

# Coverage
npx vitest run --coverage
```

### Linting

```bash
# TypeScript type check
npx tsc --noEmit

# ESLint (if installed)
npx eslint electron/ src/ --ext .ts,.tsx
```

---

## ⚙️ Configuration

### `.env`

| Variable | Default | Description |
|----------|---------|-------------|
| `LUMINA_API_PORT` | `3456` | API port |
| `LUMINA_API_ENABLED` | `false` | Enable the REST API |
| `LUMINA_API_KEY` | — | API auth key |
| `LLM_PROVIDER` | `lm-studio` | LLM provider |
| `LLM_BASE_URL` | `http://127.0.0.1:1234/v1` | API base URL |
| `LLM_MODEL` | — | Model name |
| `MEMORY_DB_PATH` | `~/.lumina/memory.db` | Memory database path |
| `LOG_LEVEL` | `info` | Log level |

### User Config (`~/.lumina/config.json`)

```json
{
  "llm": {
    "provider": "lm-studio",
    "baseUrl": "http://127.0.0.1:1234/v1",
    "model": "qwen-2.5-7b"
  },
  "language": "en-US",
  "theme": "light",
  "api": {
    "port": 3456,
    "enabled": true,
    "key": ""
  },
  "security": {
    "sandbox_level": "medium",
    "auto_approve": false
  }
}
```

---

## 🗄️ Database Schema

### Memory table (memory)

```sql
CREATE TABLE memory (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  embedding   BLOB,              -- vector embedding
  agent_id    TEXT NOT NULL,
  importance  REAL DEFAULT 0.5,  -- importance 0~1
  tags        TEXT,              -- JSON array
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_memory_agent ON memory(agent_id);
```

### Sessions table (sessions)

```sql
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  messages    TEXT,              -- JSON array
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Emotion log (emotion_log)

```sql
CREATE TABLE emotion_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL,
  emotion     TEXT NOT NULL,
  valence     REAL,
  arousal     REAL,
  dominance   REAL,
  intimacy    INTEGER,
  reason      TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 📦 Packaging and Release

### Local Packaging

```bash
# Windows
npm run pack:win

# macOS
npm run pack:mac

# Linux
npm run pack:linux

# All platforms
npm run pack:all
```

Output directory: `dist/`

### CI/CD Auto Release

Pushing a `v*` tag automatically triggers a GitHub Release (see `.github/workflows/test.yml`):

```bash
git tag v1.0.1
git push origin v1.0.1
```

CI builds installers for all three platforms and creates a Draft Release.

### Versioning

Follows [SemVer](https://semver.org/):

```
v<major>.<minor>.<patch>
  ↑ breaking change  ↑ new feature  ↑ bug fix
```

---

## ❓ Developer FAQ

### `npm install` fails with native module compilation errors

```bash
# Windows
npm install -g windows-build-tools

# macOS
xcode-select --install

# Linux
sudo apt-get install build-essential python3
```

### White screen in Electron during development

Make sure `electron-vite dev` is running and there is no port conflict (default 5173).

### Changes to electron/ are not taking effect

Main-process code changes require restarting Electron (`electron-vite dev` restarts automatically).

### How do I view logs?

Logs print to the terminal. Set `LOG_LEVEL=debug` for verbose output.

### Debugging the main process

```bash
# VSCode: add this to .vscode/launch.json
{
  "type": "node",
  "request": "attach",
  "name": "Attach to Electron",
  "port": 9229
}
```

After launching, add `debugger;` statements in main-process code to set breakpoints.

---

## 🔗 References

- [Electron Docs](https://www.electronjs.org/docs/latest)
- [React 19 Docs](https://react.dev/)
- [Zustand](https://github.com/pmndrs/zustand)
- [VitePress](https://vitepress.dev/)
- [electron-vite](https://electron-vite.org/)
- [electron-builder](https://www.electron.build/)

---

> Last updated: 2026-07-28 · Questions welcome — open an Issue.
