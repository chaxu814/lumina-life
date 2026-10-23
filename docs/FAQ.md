# Lumina Frequently Asked Questions (FAQ)

> Last updated: 2026-07-14

---

## Installation & Startup

### Q1: Nothing happens after double-clicking the installer / the window flashes and disappears

**Possible causes:** Node.js version too old, or dependencies not installed correctly.

**Fix:**
1. Confirm Node.js ≥ 18 (run `node -v` in a terminal)
2. Delete `node_modules` and `pnpm-lock.yaml`, then run `pnpm install` again
3. If it still flashes, open a terminal and run `pnpm dev` to see the error output

### Q2: `pnpm install` fails saying Python / C++ compilation failed

Some of Lumina's dependencies (e.g. `better-sqlite3`) need native modules compiled.

**Fix:**
```bash
# Windows: install Visual Studio Build Tools
npm install --global windows-build-tools

# Or switch to the prebuilt version
pnpm config set node-gyp rebuild false
pnpm install
```

### Q3: No response from the browser/terminal after launch

The terminal log may have been redirected.

**Fix:**
```bash
# Force foreground mode
pnpm dev --no-daemon

# Log file locations
# Windows: %APPDATA%\Lumina\logs\
# macOS/Linux: ~/.lumina/logs/
```

---

## Configuring the LLM

### Q4: How do I configure the AI model? Which one should I use?

Edit the `llm` section in `config.json`:

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4o",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-xxxxxxxxxxx"
  }
}
```

**Recommended models (by value for money):**
1. **GPT-4o** — most stable, best coding experience in group chat
2. **Claude 3.5 Sonnet** — strong coding ability
3. **DeepSeek-V3** — great value, excellent Chinese
4. **Qwen2.5-72B** — free to use

### Q5: I configured the API Key but still get "401 Unauthorized"

**Troubleshooting:**
1. Check the `apiKey` field name in `config.json`
2. Confirm the API Key hasn't expired
3. Check whether `baseUrl` has a trailing slash
4. If you use a proxy/forwarder, confirm the forwarding URL is correct

### Q6: How do I make different Agents use different models?

`config.json` supports per-agent model overrides:

```json
{
  "llm": { "model": "gpt-4o", ... },
  "agents": {
    "yak": { "llm": { "model": "claude-sonnet-4-20250514", ... } },
    "recha": { "llm": { "model": "deepseek-chat", ... } }
  }
}
```

Agents without a config automatically inherit the main model (no error).

### Q7: I configured it but the UI still shows "Model not ready"

**Common causes:**
1. The app wasn't restarted after editing the config file
2. Malformed JSON in `config.json`
3. Wrong config path — on Windows the config file is at `%APPDATA%/Lumina/config.json`

---

## Group Chat & Team Collaboration

### Q8: Agents don't respond in group chat / nobody speaks

**Checklist:**
- ✅ Do all Agents have an LLM configured?
- ✅ Is group chat mode enabled?
- ✅ Did you @mention the right Agent in the message?
- ✅ Are you in "team collaboration" mode?

### Q9: Yak wrote code but Recha doesn't review it / Lumina doesn't test

If an Agent has no LLM configured, the collaboration chain breaks. Since v14.0, the system supports automatic degradation to the main model.

**Fix:**
- Either give Yak / Recha / Lumina each their own model,
- Or let the system degrade automatically (on by default)

### Q10: The Agent always says "let me look it up" but never actually searches

**Cause:** In group chat mode, Agents tend to use tools less.

**Fix (fixed in v14.0+):**
- Use explicit search commands: "help me search for XXX", "look up XXX"
- Avoid vague phrasing: "do you know about XXX?"

### Q11: Raw `<tool_call>` tags appear in the Agent's replies

**Cause:** The LLM emitted a tool-call intent that the parser didn't match (common with bracket-style arguments).

**Workaround:** Switch to a model with standard function calling support (GPT-4o/Claude).

### Q12: How do I retry after collaborative coding tests fail?

Collaborative coding retries automatically, up to 3 rounds. If it still fails after 3 rounds:
1. Look at Lumina's last test output
2. Fix the code manually, then send another message telling Yak to continue
3. Or say "fix the error from just now" in your prompt

---

## Tools & Features

### Q13: Can Lumina access my files?

**Default permissions:**
- ✅ Read/write the workspace directory
- ✅ Read/write the project directory
- ❌ No automatic access to Desktop / Documents / system directories

It asks for confirmation before running dangerous commands (delete/overwrite).

### Q14: The browser tool can't open web pages

**Troubleshooting:**
1. Confirm Chrome/Chromium is installed
2. Check the `browser.headless` setting in `config.json`
3. Some sites (captchas / login walls) may not render properly

### Q15: Search returns "no results found"

**Causes:**
1. Bing search rate limits
2. The search term is too obscure
3. Network issues

**Suggestion:** Try more precise keywords, or open the page directly with `browser`.

### Q16: How do I use the memory system?

```
Short-term memory: the current conversation context (managed automatically)
Long-term memory: operated through the memory_* tools
  - memory_save: save important information
  - memory_search: search past memories
  - memory_summarize: summarize recent activity
```

Each Agent has its own independent memory.

### Q17: How do I add more tools?

Three options:
1. **MCP** (recommended): connect any third-party tool through the MCP protocol
2. **Built-in skills**: write a `SKILL.md` file to register a workflow
3. **Build directly**: add a new tool under `electron/tools/impl/` and register it

---

## Runtime Issues

### Q18: Persistent "Rate Limit" errors / request timeouts

**Fix:**
1. Reduce the number of group-chat collaboration iterations
2. Configure request intervals: `{ "llm": { "rateLimit": { "requestsPerMinute": 30 } } }`
3. Switch to a model with more lenient rate limits

### Q19: Memory usage keeps growing; the app becomes sluggish after a day

**Cause:** Conversation context accumulates too much.

**Optimized (v14.0+):**
- Context auto-compacts past 65%
- Each message is capped at 24,000 characters
- If it's still sluggish, clear conversation history manually or restart

### Q20: How do I do a full reset?

```bash
# Back up your data
mv ~/.lumina ~/.lumina.backup   # macOS/Linux
rename %APPDATA%\Lumina Lumina.backup  # Windows

# Restart (a fresh config is generated automatically)
pnpm dev
```

**Note:** This deletes all conversation history, memory, and config. Back up first.

---

## Contact & Feedback

- GitHub Issues → report bugs / request features
- The project README → other contact channels
