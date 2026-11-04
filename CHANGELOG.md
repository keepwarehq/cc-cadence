# Changelog

## 0.0.15 — Multi-session editor tabs

2026-11-04

- **Every editor tab is its own chat.** Open as many CC Cadence tabs as you like — each has its own
  transcript, session and running turn. Model, effort and profile stay shared across the app.
- **Per-tab permission mode.** Run one tab in `plan` and another in `bypassPermissions`.
- **Session History** button in the editor title bar.
- **Thinking blocks.** Reasoning renders as an expandable section; redacted thinking shows a token
  estimate instead of an empty expander.
- **Better @-mentions.** Picking a mention replaces only the typed query, folders insert `@dir/` and
  re-query inside it, and a new **@** toolbar button opens the picker at the caret.
- Refreshed logo: a solid tech-blue disc with dark cadence bars.

## 0.0.11 — Popup fix

2026-11-03

- Fixed the model/mode popup that could not be closed: an `#id` display rule beat the browser's
  `[hidden]` rule. Added an explicit `[hidden]` guard, scrollable popups and a CSS regression test.

## 0.0.10 — Editor tab beside your files

2026-11-03

- **Open in Editor** now opens CC Cadence in its own locked editor group, split beside your files.

## 0.0.9 — Hello, CC Cadence

2026-11-03

- Renamed to **CC Cadence** with the tech-blue cadence-bars logo.
- New editor-tab mode with a colored tab icon.

## 0.0.8 — Editor title button and calmer stops

2026-11-03

- Editor title-bar button to open the chat.
- Direct file picker for attachments.
- Clicking outside a popup closes it.
- Stopping a run shows a calm info notice instead of a red error.

## 0.0.5 — UI polish

2026-11-03

- Your messages are right-aligned bubbles.
- Permission mode moved into a popup menu.
- Tooltip on the upload button; dropped the status bar item.

## 0.0.4 — Activity bar icon fix

2026-11-03

- Flat, mask-safe activity bar icon that renders correctly in every theme.
- Background agents pill with an agent-map popup.

## 0.0.3 — Hardening pass

2026-11-03

- Attachments directory is created on demand; oversized pastes are rejected.
- Guard against send races, drop double-attach and staging-name collisions.
- Array-content user messages replay correctly from history.

## 0.0.2 — First usable release

2026-11-03

- Chat panel driven by `claude -p` with stream-json input and output.
- Session history picker backed by the CLI's own session storage.
- Attachments (paste, drag-and-drop, picker) and `@`-mentions.
- Interrupt-and-replace sending: your latest message always wins.
- Live task cards for background subagents and shells.
- `claudeEnv` and `claudeSettings` for extra Claude Code parameters.
