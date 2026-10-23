# Lumina Troubleshooting Handbook

> Last updated: 2026-07-14 · Find the matching steps by error message (or symptom)

---

## 1. `Error: connect ECONNREFUSED 127.0.0.1:443`

**Symptom:** A network connection refused error on startup.

**Root cause:** The LLM API `baseUrl` is misconfigured, or the network is unreachable.

**Troubleshooting:**
1. In a terminal, run `curl -I https://your-base-url` to see whether you can connect
2. Check whether `baseUrl` in `config.json` ends with `/v1` (the standard OpenAI-compatible format)
3. Check whether a proxy/VPN is intercepting the API address
4. If using a local model (Ollama/LM Studio), confirm the service is running and the port is correct

---

## 2. `401 Unauthorized` / `Authentication Fails`

**Symptom:** The API returns an authentication failure.

**Troubleshooting:**
1. Check the `apiKey` value in `config.json` — copy-pasting may have added spaces or newlines
2. Confirm the API Key hasn't expired (check the platform's console)
3. Some platforms require the `Authorization: Bearer` prefix — confirm whether the provider handles it automatically
4. Try sending a request manually with curl to verify:
   ```bash
   curl https://api.openai.com/v1/chat/completions \
     -H "Authorization: Bearer sk-xxxx" \
     -H "Content-Type: application/json" \
     -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
   ```

---

## 3. `429 Too Many Requests` / Rate Limit

**Symptom:** Requests are being rate-limited.

**Troubleshooting:**
1. Check whether you're sending too many concurrent requests — in group-chat collaboration, 3 Agents call the API at the same time
2. Reduce group-chat iterations (`MAX_CODING_ITERATIONS` in `GroupChatView.tsx`)
3. Add rate-limit config in `config.json`:
   ```json
   { "llm": { "rateLimit": { "requestsPerMinute": 20 } } }
   ```
4. If using a free API (e.g. DeepSeek/Grok), consider upgrading to a paid tier

---

## 4. The LLM returns empty content / the model outputs nothing

**Symptom:** The Agent replies but the content is empty (an empty string or just newlines).

**Troubleshooting:**
1. Check whether the provider supports the model you picked — some providers renamed models without changing the API, which just returns empty
2. If using a local model, chat with it directly in Ollama/LM Studio to test
3. If it's a function-calling model, try `mode: "chat"` (no tool calls) to see whether it replies normally
4. Check whether `maxTokens` is set too low (< 100)

---

## 5. White window / the frontend doesn't render

**Symptom:** The window is blank after the app starts.

**Troubleshooting:**
1. Check whether `out/renderer/index.html` exists — the frontend build may have failed
2. Rebuild the frontend: `pnpm build:renderer`
3. Check whether the Vite dev server started normally (watch the console output when running `pnpm dev`)
4. Clear the browser cache / restart the app

---

## 6. The Agent replies with raw JSON text in group chat

**Symptom:** The Agent replies with raw JSON like `{"role":"assistant","content":"hi"}` instead of natural language.

**Troubleshooting:**
1. This happens when a prompt asks for JSON output but post-processing doesn't strip it — the per-stage task prompts in group-chat collaboration require JSON output
2. Check whether the prompt for the corresponding stage in `GroupChatView.tsx` says something like "output JSON only"
3. Temporary fix: reset the group-chat session (clear `lumina_gc_sessions` from localStorage)
4. Permanent fix: make sure each stage extracts the `content` field with `postProcess` after outputting JSON

---

## 7. The collaborative coding loop won't stop / infinite retries

**Symptom:** The code→review→fix→test loop repeats forever.

**Troubleshooting:**
1. Check that `MAX_CODING_ITERATIONS` in `GroupChatView.tsx` defaults to 3
2. The `testFailed` regex may false-positive (treating "error" as a failure when it's actually a word in successful output)
3. Temporary fix: close and reopen the group-chat window
4. If it happens often, add extra negation conditions to the `testFailed` check to exclude false positives

---

## 8. The Agent doesn't call tools / only talks without acting

**Symptom:** You ask the Agent to search or run a command, but it only replies with a text description instead of actually doing it.

**Troubleshooting:**
1. Check the current mode: `mode: "chat"` doesn't allow tool calls; `mode: "agent"` does
2. In `agentRunner.ts`, `isToolCapable = mode !== 'chat' && tools > 0`
3. Check the `mode` setting in `config.json`, or the mode parameter the frontend sends to the backend
4. If using a local model, confirm it supports function calling — otherwise the XML fallback parser is used

---

## 9. `<tool_call>` tags leaking into the conversation

**Symptom:** The user sees raw tags like `<tool_call><web_search(query="xxx")></tool_call>`.

**Troubleshooting:**
1. This is leftover output where the LLM emitted a tool call the parser didn't fully handle
2. Common when the model emits bracket-style arguments (`<web_search(query="...")`) instead of closed-tag style
3. Check the `cleanXmlToolCalls` regex in `reactEngine.ts` — if it only matches closed `</tool_call>` tags, unclosed ones won't be cleaned
4. Temporary fix: switch to a model with standard function calling support
5. Permanent fix: update the parser to handle bracket-style arguments

---

## 10. You search "what's the weather today" but the Agent makes up an answer

**Symptom:** The Agent answers from memory without searching, and the answer may be inaccurate.

**Troubleshooting:**
1. `preExecuteSearch` (in `agentRunner.ts`) detects search intent — if it doesn't trigger, the Agent may not search
2. Check whether the user's message contains a "search cue" (e.g. "search for", "look up")
3. In group-chat mode, `socialMode: true` → no pre-search by default — fixed in v14.0+ so detected search intent is always executed
4. Confirm the WebSearch tool works (try `web_search` in a terminal)

---

## 11. Memory leak / slowing down after running for hours

**Symptom:** The app gets slower the longer it runs.

**Troubleshooting:**
1. Open Task Manager and watch the Node.js process memory usage
2. Long-lived Agent sessions accumulate context — past `COMPRESS_TRIGGER_RATIO` (0.65) it compacts automatically
3. Check whether `agentRunner.ts` pushes messages into `this.messages` without bounds every turn
4. Temporary fix: restart the app
5. Long-term fix: set a hard cap on conversation context (e.g. force-truncate at 500 messages)

---

## 12. The config file has no effect / editing it changes nothing

**Symptom:** You edited `config.json` but the app's behavior didn't change.

**Troubleshooting:**
1. **Did you restart the app?** Lumina only reads config at startup; restart after editing
2. Check the config file path:
   - Windows: `%APPDATA%\Lumina\config.json`
   - macOS: `~/Library/Application Support/Lumina/config.json`
   - Linux: `~/.config/Lumina/config.json`
3. Check the JSON format — verify with `node -e "JSON.parse(require('fs').readFileSync('path/to/config.json','utf8'))"`
4. If you use environment variable overrides (`LUMINA_LLM_MODEL`, etc.), environment variables take precedence over the config file

---

## 13. Channel messages won't send (DingTalk / WeChat / Slack / Telegram)

**Symptom:** You configured an external channel but messages can't be sent or received.

**Troubleshooting:**
1. Check whether the channel config is correct (Webhook URL / Bot Token / Client ID)
2. DingTalk: in Stream mode, confirm the Stream URL and Client Secret
3. WeChat: WeCom webhooks need an IP whitelist
4. Slack: requires Events API subscription and signature verification
5. Telegram: requires a Bot Token and a publicly reachable Webhook URL
6. Test directly in a terminal: `curl -X POST "your-webhook-url" -d '{"text":"test"}'`

---

## 14. Skills won't load / errors when executing

**Symptom:** A skill is registered but errors on invocation, or fails silently.

**Troubleshooting:**
1. Check whether the `SKILL.md` file format is compliant — the YAML frontmatter is required
2. Check whether the Skill Scanner blocked the skill (`PASS/WARN/BLOCK`)
3. Look for `[SkillSystem]` output in the logs
4. Try running it from a terminal: `qwenpaw skills run <skill-name>`
5. If a skill calls tools that aren't installed, it fails silently — check that the tools it depends on are ready

---

## 15. Stuck on "initializing..." at startup

**Symptom:** The app stays on the loading screen forever.

**Troubleshooting:**
1. LLM model initialization timed out — first model load can take a while (especially local models)
2. Check the logs for provider initialization errors
3. Try disconnecting the network (with a local model, network issues can cause DNS resolution timeouts)
4. Delete the cache files under `~/.lumina/` and try again
5. If using a custom provider, check whether the URL is reachable

---

## 16. Native dependency compilation fails (better-sqlite3 / sharp / onnxruntime-node)

**Symptom:** `npm install` dies midway with a `node-gyp` stack trace, `MSBUILD : error`, `gyp ERR!`, `make: g++: command not found`, or the app at startup says `The module was compiled against a different Node.js version`.

**Root cause:** `better-sqlite3` is a C++ native module and must be recompiled for the current Electron ABI; it depends on the local C/C++ toolchain and Python 3. `sharp` / `onnxruntime-node` / `screenshot-desktop` usually ship prebuilt binaries, but a few platforms/architectures still fall back to compilation.

**Set up the toolchain per OS:**

- **Windows:**
  1. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload.
  2. Install Python 3 (needed by node-gyp): https://www.python.org/downloads/
  3. Re-align in an administrator PowerShell: `npm run rebuild:electron`

- **macOS:**
  1. Install Xcode command line tools: `xcode-select --install`
  2. Confirm Python 3 is available: `python3 --version`
  3. Re-align: `npm run rebuild:electron`

- **Linux (Debian/Ubuntu):**
  1. Install the toolchain: `sudo apt install build-essential python3 make`
  2. Fedora/RHEL: `sudo dnf groupinstall "Development Tools" && sudo dnf install python3`
  3. Re-align: `npm run rebuild:electron`

**Other checks:**
1. Temporarily skip native alignment (only when running pure Node tests): `set LUMINA_SKIP_REBUILD=1` (PowerShell) / `export LUMINA_SKIP_REBUILD=1` (bash), then `npm install`.
2. Confirm the Node version: the repo requires Node.js 18+ (CI runs Node 20/22).
3. Clean and reinstall: `rm -rf node_modules package-lock.json && npm install`.
4. If native module loading fails only in the packaged app, confirm `build.asarUnpack` in `package.json` includes better-sqlite3 / sharp / onnxruntime-node / @xenova / @img (already configured in the repo — don't delete it).
5. **Electron binary download failures on networks in China** (TLS / `unable to verify the first certificate` / timeouts): set the npmmirror mirror first:
   ```powershell
   $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
   npm install
   ```

---

## How do I read the logs?

The first step of every troubleshooting: **read the logs.**

```bash
# Terminal logs (printed when started in foreground)
pnpm dev

# Log file locations
Windows: %APPDATA%\Lumina\logs\
macOS/Linux: ~/.lumina/logs/

# Logs are split by day; grep for keywords
grep "ERROR\|Error\|error\|❌\|failed" ~/.lumina/logs/latest.log
```

---

> **Still stuck?** Open a GitHub issue with the log file attached, along with your OS, Node.js version, and config file (remember to redact your API Key).
