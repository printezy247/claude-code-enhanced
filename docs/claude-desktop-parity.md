# Claude Desktop parity — upgrades & fixes (from `claude-desktop_2.42304.2`)

Source deb unpacked at `/tmp/claude-deb`; static analysis via REA (`analyze-javascript-application`)
over `resources/app.asar` (447 files, 432 parsed, 72 modules, 8,243 findings). Desktop app is
`@ant/desktop` 2.42304.2 on `@anthropic-ai/claude-agent-sdk` 0.3.299.

## Findings (functions / surfaces present in the desktop build)

- Agent SDK chat: streaming SSE, tool_use/tool_result, permission prompts, MCP elicitation,
  context usage (`getContextUsage`), file checkpointing + rewind, subagent transcript forwarding,
  hook events, task create/update, prompt suggestions, output styles.
- Connectors: `ccd_connectors`, `connectorTools`, `sessionConnectors`, `setSessionConnectorEnabled`,
  `reconnectMcpServer`, `mcpServerStatus`, proxied connector calls, destructive-tool detection,
  connector sign-in / OAuth homes, `list_connectors` / `suggest_connectors`.
- Tool calling: `canUseTool`, `onElicitation` (url/form), permission suggestions, blocked paths,
  tool search, subagent spawn depth limits, concurrent subagents.
- Right rail: Environment (cwd + git), Changes (uncommitted files), Context (token usage),
  Tasks (agent todo list), plus terminal, preview, diff, rewind/checkpoints.
- Terminal: real PTY host (`pty-host`), scrollback, shell integration, multiple sessions.
- Minimalist/premium UI: neutral surfaces, no 3D transforms; shadows used only for elevation.

## Gaps in CCE vs desktop (priority)

1. Connectors / tool calling
   - CCE adds MCP servers via `claude mcp add`, but chat-side tool availability and toggles are
     not surfaced in the right rail; add a "Connectors" card showing `mcpServerStatus()` and
     `toggleMcpServer()` with per-server on/off + reconnect, mirroring desktop.
   - Ensure MCP tool schemas are not dropped by `leanTools` allowlists (currently `options.tools`
     is set to the lean list only; MCP tools remain, but verify with a smoke test).
   - Surface connector OAuth elicitations (already wired via `onElicitation`) in the UI card, not
     only as a toast.

2. Minimalist UI
   - Remove decorative gradients (`--metal`) and heavy box-shadows in `styles.css`; keep a single
     accent + neutral elevation. Replace gradient metal with flat token.
   - Standardize spacing/radius tokens; no transforms beyond focus rings.

3. Right rail completeness
   - Split view kinds exist (tasks, terminal, changes, preview, diff) but the terminal pane did
     not re-attach after switching kinds (fixed). Add "Context" and "Connectors" cards and a
     "Rewind / checkpoints" card using `chat.checkpoints()` + `rewind()`.
   - Context card currently only shows token counts; add category breakdown from
     `getContextUsage()` (categories) when present.
   - Tasks card should mirror desktop wording (Tasks n/m with ✓/○/▸) — already done; keep.

4. Chat bootstrap
   - Every chat now appends caveman (lite), rtk command compression, and superpowers
     (brainstorming first) to the Claude Code system prompt, with connector tool access. rtk must
     be installed on PATH for compression to take effect.

5. Tool-calling workflow parity
   - Permission card already supports suggestions, blocked paths, display names. Add tool search
     surfacing and subagent progress summaries (already enabled via `promptSuggestions` /
     `agentProgressSummaries`).
   - Add checkpoint/rewind UI affordance in the chat header (currently only API exists).
   - Upgrade SDK from 0.3.292 to 0.3.299 to match desktop.

6. Terminal
   - Right-rail terminal pane fixed to re-open/re-fit; consider sharing the active session's PTY
     instead of a separate shell.

## Files touched

- `src/main/chats.js` — system-prompt bootstrap (caveman/rtk/superpowers + connectors).
- `src/renderer/app.js` — right-rail terminal re-attach fix.
- `docs/claude-desktop-parity.md` — this report.
