[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

# 🎉 Contributing to Lumina Life

Thanks for your interest in Lumina Life! Whether you're fixing bugs, adding features, writing docs, or sharing ideas — every contribution is welcome.

---

## 📋 Table of Contents

1. [Code of Conduct](#-code-of-conduct)
2. [Quick Start](#-quick-start)
3. [Development Environment](#-development-environment)
4. [Project Structure](#-project-structure)
5. [Coding Standards](#-coding-standards)
6. [Submitting a Pull Request](#-submitting-a-pull-request)
7. [Testing Guide](#-testing-guide)
8. [Questions & Discussion](#-questions--discussion)

---

## 📜 Code of Conduct

This project adopts the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). In short: **be kind, be respectful, be inclusive**.

---

## 🚀 Quick Start

```bash
# 1. Fork this repository
# 2. Clone your fork
git clone https://github.com/<your-username>/lumina-life.git
cd lumina-life

# 3. Install dependencies
npm install

# 4. Copy the environment config
cp .env.example .env
# Edit .env and fill in your LLM API settings (at least one provider)

# 5. Start development mode
npm run dev
```

> 💡 **Node.js v18+ is required.** We recommend [nvm-windows](https://github.com/coreybutler/nvm-windows) for managing Node versions.

---

## 🛠️ Development Environment

### Required Tools

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 20.0.0 | v20 LTS or v22 recommended (per `engines` in package.json) |
| npm | ≥ 9 | Bundled with Node |
| Git | ≥ 2.30 | Version control |
| Windows | 10+ | Windows-only at the moment |

### Recommended Tools

- **VS Code** — the repo ships with `.vscode/` settings (where present)
- **ESLint** — code style checks
- **Vitest** — test runner

### Available Commands

```bash
npm run dev          # Start dev mode (Electron + Vite HMR)
npm run build        # Production build
npm run pack:win     # Build + package NSIS installer
npm test             # Run tests
npm run test:watch   # Watch mode
npm run cli          # CLI mode (no GUI)
npm run api          # REST API server
npm run doctor       # System diagnostics
```

---

## 📁 Project Structure

> Verified against HEAD on 2026-10-19. For the full breakdown (what each directory does), see
> [docs/DEVELOPER.md](docs/DEVELOPER.md).

```
lumina-life/
├── electron/           # Main process (~148k LOC)
│   ├── agentRunner.ts          # ReAct main loop (4,171 LOC)
│   ├── delegationManager.ts    # Delegation + five-stage gates
│   ├── agentTeamPersonas.ts    # Three Agent personas (single source of truth)
│   ├── rolePolicy.ts           # Hard role-based tool gates
│   ├── securityGuard.ts        # Tiered security review
│   ├── memory/                 # Memory (SQLite + BM25/TF-IDF RRF)
│   ├── tools/                  # 139 registered tools (registry + impl/)
│   ├── team/                   # Adversarial review / dynamic hiring / task board
│   ├── orchestration/          # Routing / complexity / stage gates / verification loop
│   ├── pet/                    # Desktop pet, five forms + standalone chat window
│   ├── cli/  api/  channels/   # CLI / REST API / IM channels
│   └── ipc/                    # 27 IPC channels
├── src/                # Renderer (React 19 + Zustand 5 + UnoCSS)
│   ├── panels/                 # 47 feature panels
│   ├── components/             # Shared UI components
│   ├── stores/                 # Zustand state
│   └── styles/                 # UnoCSS / global styles
├── tests/              # Vitest (305 files / 4,575 cases, flat naming)
├── skills/             # 7 smart skills (SKILL.md directory-based)
├── python/             # Optional voice / vector services
└── docs/               # VitePress documentation site
```

---

## 📐 Coding Standards

### TypeScript

- **Style**: strict mode (`strict: true`)
- **Indentation**: 2 spaces
- **Quotes**: single quotes preferred
- **Semicolons**: required
- **Naming**: `camelCase` (variables/functions), `PascalCase` (types/classes), `UPPER_CASE` (constants)
- **File headers**: every file should carry a module-level doc comment (follow the style of existing files)

### React

- **Function components** + Hooks; no class components
- **State**: Zustand (global) / useState (local)
- **Styling**: UnoCSS (`uno.config.ts`) + inline component styles; no Tailwind

### UI changes: mock it up side-by-side before you commit

Do **not** tweak the CSS and push the change straight away. The same "For You" recommendation bubble was reworked three times on 2026-10-20 (text link → full-width card → small capsule sized to the text), all because the requirement was guessed from a verbal description.

Recommended flow:

1. Render the change to a screenshot with a headless browser (`msedge --headless --screenshot`, or spin up a minimal local HTML page that reuses the real CSS);
2. Confirm **side by side** with the requester on the three things most easily misread: **width / border / layout direction**;
3. Only then change the component, run the gates, and open the PR — with before/after screenshots pasted into the PR description.

Phrases like "remove the box" or "too big" are ambiguous: do they mean the item's own box, or the outer container's? One comparison screenshot is worth a round of rework.

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add emoji reactions to the feed
fix: fix null pointer in memory retrieval
docs: update README screenshots
test: add security-guard edge-case tests
refactor: extract tool registration into its own module
```

---

## 📝 Contributor License Agreement (CLA)

**Important: before opening your first Pull Request, you need to sign our CLA.**

Lumina Life is released under a **dual license** (AGPL-3.0 and Apache-2.0), which requires every contributor to grant the project the right to use their contributions under both licenses.

### How to sign

**Option 1: automatic signing (recommended)**

When you open your first Pull Request, the [CLA Assistant](https://github.com/contributor-assistant/github-action) bot will prompt you to sign with a single click.

**Option 2: sign off in your commit message**

Include the following line in your PR commit messages:

```
Signed-off-by: Your Name <your.email@example.com>
```

Submitting a pull request indicates your agreement to the terms in [CLA.md](CLA.md).

> 💡 You only sign once; it applies automatically to all future PRs.

---

## 🔄 Submitting a Pull Request

1. **Open an Issue first** — discuss what you plan to do to avoid duplicate work
2. **Create a feature branch from main**:
   ```bash
   git checkout main
   git pull upstream main
   git checkout -b feat/my-feature
   ```
3. **Commit your code** — follow the coding standards and make sure tests pass
4. **Write a PR description** — what changed, why, and how you tested it
5. **Wait for review** — maintainers will review as soon as they can

### PR Checklist

- [ ] Code follows the project's coding standards
- [ ] New features include corresponding tests
- [ ] All tests pass (`npm test`)
- [ ] Documentation updated (if needed)
- [ ] A CHANGELOG entry has been added
- [ ] This PR's contributions are licensed under [CLA.md](CLA.md)

---

## 🚦 Maintainer Push Safety

> This section applies only to repository owners / maintainers with push access. External contributors use Fork + PR and are unaffected.

**Only push the main branch explicitly:**

```bash
git push origin master
```

**Strictly forbidden:**

- `git push --all` — pushes every local branch at once (including historical snapshot/backup branches).
- `git push --mirror` — overwrites the remote with your local refs; the most dangerous option.
- Pushing any local backup/snapshot branches: `tmp-backup`, `*-backup`, `legacy-init-snapshot`, and any local branch whose name looks like `archive/*`, `init-*`, or `*-snapshot`. These branches may contain early internal persona/prompt documents (not API keys, but not public either), kept only for local rollback reference.

**Self-check before pushing:**

```bash
git branch --list            # see exactly which local branches exist
git push origin master       # push master only, then verify the remote branch list on GitHub
```

If a backup branch is pushed by accident: go to the GitHub repo → Branches and delete that remote branch, and treat its contents as public (internal prompts and other sensitive design material should be scrubbed from history with filter-repo, not merely by deleting the branch).

---

## 🧪 Testing Guide

```bash
npm test              # run all tests
npm run test:watch    # watch mode (during development)
npx vitest run        # single run (CI)
```

### Test Scope

- **Unit tests**: core logic (Agent Runner, memory system, security review)
- **Integration tests**: cross-module collaboration (delegation system, social engine)
- **E2E tests**: long conversations, memory persistence

### Writing Tests

- Test files live in `tests/`, named `*.test.ts`
- Use `vitest` with `describe/it/expect`
- When mocking Electron, call `vi.mock('electron', ...)` at the top of the file

---

## 💬 Questions & Discussion

- **Bug reports / feature requests** → [GitHub Issues](https://github.com/chaxu814/lumina-life/issues)
- **Technical discussion / usage help** → [GitHub Discussions](https://github.com/chaxu814/lumina-life/discussions)
- **Security vulnerabilities** → report privately; do not open a public Issue

---

## 🙏 Thank You

Every PR, Issue, and docs improvement makes Lumina better. No contribution is too small — thank you! 🐱

---

**Lumina Life** is released under a dual license: [AGPL-3.0](LICENSE) or [Apache-2.0](LICENSE-APACHE), at the user's choice. See [CLA.md](CLA.md) for details.
