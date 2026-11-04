# CC Cadence

Chat in your editor with Claude (Max subscription) and any Anthropic-compatible model — switch models, keep the cadence. Driven by the local `claude` CLI. Free, forever, by [Keepware](https://www.keepware.dev).

[![Version](https://img.shields.io/visual-studio-marketplace/v/keepware.cc-cadence?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=keepware.cc-cadence)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/keepware.cc-cadence)](https://marketplace.visualstudio.com/items?itemName=keepware.cc-cadence)

```bash
code --install-extension keepware.cc-cadence
```

## Features

- **Many profiles, one panel** — the built-in Claude profile runs the local `claude -p` on its own `/login` Max subscription. Other profiles point at any Anthropic-compatible endpoint with a Base URL + API key, so every model gets the same tools: read/write files, run commands, subagents.
- **Session history** — conversations are stored by the CLI itself. The clock button at the top right of the panel drops down the session list (search by title); click one to resume it, or × twice to delete it.
- **Attachments** — paste a screenshot from the clipboard, drag files onto the composer, or use ＋. Images go straight to the model as base64 blocks; other files are staged under `.ccprofile/attachments/` and handed to the model as paths.
- **@-mentions** — type `@` to fuzzy-search files and folders and drop a path into the message.
- **Extra Claude Code parameters** — `ccprofile.claudeEnv` injects environment variables (e.g. `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`); `ccprofile.claudeSettings` passes settings keys (e.g. `effortLevel`) via `--settings`.
- **Background tasks** — background subagents and shells show up as live task cards. The CLI waits for them and wakes itself up when they finish, in the same conversation.
- **Interrupt-and-replace** — sending a message while the model is still running stops the current run and starts the new message on the same session. Your latest word always wins.
- **Attachments** — ＋ → Upload from computer opens the picker of the machine VS Code runs on (under Remote that is your laptop, not the server); paste and drag-and-drop work too.
- **Permission modes** — opens with `bypassPermissions` (tools never ask). Switch per window from the composer pill. Only use in trusted workspaces.

## Getting started

1. Log in once: run `claude` in a terminal and `/login` with your Max account.
2. Click the CC Cadence icon in the activity bar to open the Chat panel, or use the editor-title button / "CC Cadence: Open CC Cadence in Editor" to open it as an editor tab (its tab shows the colored logo).
3. Type and press Enter to send (Shift+Enter for a newline). Enter during IME composition never sends.
4. Switch models with the pill at the bottom of the composer: pick the provider, its model (Claude: Default / Opus / Sonnet / Haiku / Fable; other profiles: the aliases mapped in `models`) and the effort level (`--effort` low … max). The pill shows the choice, e.g. `Claude (Max) · fable · high effort`. The same vendor resumes the session; switching vendors starts a new session.
5. Switch the permission mode with the pill next to it (e.g. `plan` for read-only).

If a switch doesn't seem to take effect, run `CC Cadence: Doctor` from the command palette.

## Adding a model profile

Click the model pill → **Add model…**, or edit `ccprofile.profiles` directly:

```jsonc
"ccprofile.profiles": [
  { "id": "claude", "model": "opus" },                 // override the built-in Claude profile
  {
    "id": "my-model", "label": "My Model",
    "baseUrl": "<Anthropic-compatible endpoint>",      // claude appends /v1/messages
    "authEnv": "ANTHROPIC_AUTH_TOKEN",
    "models": { "opus": "<name>", "sonnet": "<name>", "haiku": "<name>" },
    "env": { "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1" }
  }
]
```

API keys are stored in the system keychain, never in settings files.

## Extra parameters

```jsonc
"ccprofile.claudeEnv": {
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "800000",
  "API_TIMEOUT_MS": "3000000"
},
"ccprofile.claudeSettings": {
  "effortLevel": "xhigh"
}
```

Environment apply order: stripped ambient vars → built-in profile mapping → `claudeEnv` → per-profile `env` (profile wins).

## How it works

Every message spawns one process:

```
claude -p --output-format stream-json --verbose --include-partial-messages \
       --input-format stream-json --permission-mode <mode> \
       [--settings <file>] [--resume <id>] [--model <model>]
```

- The message goes to stdin as a single stream-json user line (text plus image blocks); events are read line-by-line from stdout.
- The working directory is the first workspace folder. With no folder open, the panel refuses to run (it never falls back to `$HOME`).
- All `ANTHROPIC_*` / `CLAUDE_CODE_*` variables are stripped from the inherited environment first, so they can't outrank the Max subscription. Explicitly configured `claudeEnv` entries are applied after the strip.
- A turn ends when the process exits — not at the first `result` — which is what lets background tasks wake the conversation back up.

The status line shows the auth source each turn. If the Claude profile is not on the Max subscription, you get a warning.

## Notes

- `env` blocks in `~/.claude/settings.json` or the workspace's `.claude/settings*.json` outrank the process environment and cannot be stripped by the extension. Doctor checks for this.
- Sessions are not portable across vendors: resuming the same session with a different provider re-sends history that may 400 (thinking-block signatures). If that happens, press New chat.
- A session interrupted while background tasks were still running leaves a **Check now** notice to resume and collect their results.

## Privacy

The extension never reads, stores, or forwards your Claude tokens. Third-party API keys live in the OS keychain.

## Development

```bash
npm install
npm test          # compile + offline tests (real event replay, jsdom webview)
npm run smoke     # two real rounds against the local claude; uses some quota
npm run package   # build ccprofile-<version>.vsix
```

Pressing F5 opens an extension development window with the `sandbox/` workspace; under bypass mode, try things there freely.
