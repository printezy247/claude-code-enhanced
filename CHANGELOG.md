# Change Log

All notable changes to Claude Code Enhanced are documented here.

## [0.9.52] — 2026-10-23

### Changed
- **Conversations moved to a permanent left sidebar**, laid out like Claude Desktop: `New chat` (with resume-latest and reopen-closed-tab icons), the section links, an **Open** list of live chats and terminals (replacing the tab bar: status dot for working / waiting on you / idle, close button on hover), then every past conversation grouped by project and time, with search, pin, archive, rename, fork, transcript, export and delete as before. Open conversations are listed once, under Open. Ctrl+B reveals the sidebar and focuses the search; Escape clears it.
- **The top bar is now one line**: sidebar toggle, the active chat's title (it follows the first message) with its actions, and two same-size icon buttons on the right (tool panel, new window). The second row (New chat / Resume / All conversations / Closed tab), the tab strip, the provider label, the folder / repo / branch / changes chips and the empty bottom status bar are gone; that information is in the sidebar and the Overview.
- On a narrow window (under 1240 px) the sidebar steps aside while the tool panel is open.

### Removed
- The `All conversations` button and the Conversations dropdown (the list is always in the sidebar).

## [0.9.51] — 2026-10-23

### Changed
- **The Overview is docked on the right at all times** and can no longer be hidden or closed. It has its own pane (`#overviewpane`); the Tasks card appears only while the agent has a list, and Background only while something runs in the background.
- **Changes, Files, Terminal, Diff and Preview open in a separate tool panel** beside the Overview. It starts closed, the tabs can still be hidden from the `⋯` chooser (hiding the open tab moves to the next one, hiding all of them closes the panel), and the width you drag it to is remembered. The tool panel is toggled with the `tasks` button / Alt+V.
- **Compact Overview**: tighter cards, long paths, branch names and connector names wrap onto several lines instead of being cut off, the context breakdown shows its top five categories with a `+N more` toggle, and the session's cost, turns and time moved here from the status row under the composer.
- The chat keeps a minimum width; the tool panel gives way first on a narrow window.

### Fixed
- The model picker showed another provider's model as selected (the other-provider groups were listed first). The current provider's models now come first and the current model is selected.

## [0.9.50] — 2026-10-23

### Changed
- Composer footbar is now **workflows · model · mode · effort · context ring**. The `fast build` button moved into the workflows menu (Build › Fast build), the `think` button is gone, and the status text row under the composer only appears for a problem such as "no auth".
- **Model picker doubles as the provider picker.** Every other saved provider is a group of its own models, labelled `model · Provider`; picking one switches the chat to that provider and model and keeps the conversation (the chat is not restarted).
- **Effort is a dropdown that lists only what the model accepts**, like OpenCode's per-model variants: no picker for a model without effort settings (including local or uncatalogued models), `low / medium / high` for a catalogued reasoning model, `low / high` on Google, the full ladder on Anthropic. A provider can pin its own list with `effortLevels`. The picker refreshes when the model or provider changes and resets a level the new model does not have.
- **`auto` mode works on every provider.** On Anthropic's API it is still the engine's classifier. On other providers CCE runs the engine in accept-edits and applies its own policy: read tools, edits in the folder, read-only commands (`ls`, `git status/diff/log`, `grep`, `find` without `-exec`...) and the project's own test / lint / build are approved; anything else asks. Anything with redirects, `$(...)`, backticks, background `&`, new lines or credential paths asks.

### Added
- `src/main/autopolicy.js`, `effortLevels()` and the `chat:effort-levels` channel.

## [0.9.49] — 2026-10-23

### Fixed
- Tool definitions are cleaned per API before they are sent. MCP and plugin tools carry `$schema`, `additionalProperties`, `const`, nullable type arrays and unsupported `format` values; Gemini rejected most of these with a 400, and some OpenAI-compatible servers rejected `$schema`.
- Gemini 3 multi-step tool use: the `thoughtSignature` returned with each function call is now sent back, so the second step no longer fails with a 400. History from a resumed session uses Google's documented skip sentinel.
- Effort, thinking budget and `max_tokens` follow the model catalog: a model marked non-reasoning no longer receives reasoning settings, and the output-token request is capped at the model's limit.
- Images returned by tools (Read of a PNG, screenshots) now reach vision models on OpenAI-compatible, Responses and Gemini providers instead of the text `[image]`. Models without vision get a short note instead of an image they would reject.

### Added
- `modelCaps()` in `modelcontext.js`: reasoning / vision / tools / output limit from models.dev. Only an explicit "no" changes a request, so models missing from the catalog behave as before.

## [0.9.48] — 2026-10-23

### Fixed
- Sending a message with screenshots no longer fails with "IPC payload too large". Pasted and attached images are shrunk to at most 1568 px on the long edge (re-encoded as JPEG when smaller), and the send channels accept up to 24 MB. Every other channel keeps the 1 MB cap.
- Switching provider mid-chat keeps the chat usable. Send, stop, steer, fork and mode changes used the old engine session id, so the next message failed with "open a new chat".
- The effort and thinking-budget buttons report an error instead of a false "success" when the change is rejected.

### Docs
- `docs/roadmap-0.9.48-review.md`: review of UI/UX, performance, stability, security and multi-model tool calling, with the phased plan.

## [0.9.47] — 2026-10-23

### Fixed
- Composer footbar: the model picker shrinks to fit, so the ctx/compact button stays on the same row as the other buttons.

## [0.9.46] — 2026-10-23

### Fixed
- Chats no longer stop mid-turn with "Interrupted while tools were running": the loop guard no longer kills a turn after many reads/searches, and a test, edit, test fix cycle no longer counts as a repeat.
- Composer footbar wraps instead of clipping the compact button; the output-style picker is removed.

### Removed
- Unused code: about dialog helper, `isRepo`, `smallModel`, `isCoolingDown`, empty policy arrays, skill-toggle aliases and about 17 dead CSS rules.

## [0.9.45] — 2026-10-23

### Fixed & Improved
- **Anti-Over-Investigation Discipline**:
  - Removed aggressive automatic `superpowers` brainstorming prompts from bootstrap; prompts now instruct direct action over speculative exploration (`src/main/bootstrap.js`, `src/main/chats.js`).
  - Added dedicated **Fast Build** button in the chat footbar for instant direct-action implementation.
- **Thinking Token Budget Control**:
  - Added interactive Thinking Budget selector in the composer footbar (`think: auto`, `1k`, `2k`, `4k`, `8k`, `off`) with dynamic `chat:effort` runtime updates (`src/renderer/chat.js`).
  - Configured default thinking budget to 2048 tokens to eliminate unbounded reasoning token burn (`src/main/store.js`).
- **Token Conservation**:
  - Disabled `autoNudge` by default to prevent burning full turns on closing remarks.
- **UI Performance**:
  - Fine-grained context card DOM updates to eliminate context window flickering in the right-hand session rail (`src/renderer/app.js`).

## [0.9.44] — 2026-10-23

No commits since last tag.

## [0.9.40] - 2026-10-22

Parity with **Claude Desktop 3.1623.3** (deb sha256 `851be2cc…`, app.asar
sha256 `840551c1…`), reviewed with REA 6.7.0 (evidence
`ev_dc6120b6da000401010742fbff63c0d6646f6e6f0f1d12d390e147d4990fd360`).
The full review and the gap list: `docs/claude-desktop-3.1623.3-parity.md`.

### Added
- **The host-side MCP client** (`src/main/mcpclient.js`): HTTP and SSE
  transports, an OAuth 2.1 device-code flow, a one-shot tool call and an
  `McpAuthError` for a 401. No new dependency — Node's `fetch` and the
  existing SSE reader. The desktop can hold an MCP connection in the host;
  CCE now can too (stdio stays with the CLI).
- **The connector policy track** (`src/main/tools.js`): a fourth state,
  `always_ask_session` — the user is asked once and the answer holds for the
  rest of the chat, and the grant dies with the chat. The track is separate
  from the session permission mode, and a destructive connector tool always
  needs a confirmation.
- **The managed policy file** (`src/main/managedconfig.js`):
  `managed-settings.json` (or `CLAUDE_CODE_MANAGED_SETTINGS_PATH`) is read
  and handed to the engine, so a managed workstation no longer runs the GUI
  unmanaged.
- **20 more SDK options** (`src/main/sdkoptions.js`), each behind a settings
  row: scoped MCP servers (`mcpServers` + `strictMcpConfig`), subagent
  definitions, the task budget, the plan-mode instructions, the tool
  aliases, the session mirror, the per-task stop, the plugin delivery, the
  user dialog, the project config root.
- **The git surface** (`src/main/gitsurface.js`): the diff, the diff stats,
  the commit list, one commit's patch and a cached status — the desktop's
  side panel.
- **The plugin manager** (`src/main/plugins.js`): a DXT/MCPB archive is
  checked (manifest, then signature) before anything is installed or
  registered with the CLI. A plugin that cannot be verified is not run.
- **The skills manager** (`src/main/skilltoggle.js`): list, read, enable and
  re-scan the skills on disk, next to the existing toggle.
- **The transcript search** (`chats:search`): a full-text search over the
  stored transcripts, on a worker thread.

### Fixed
- `session:subagents` was handled in the main process but blocked by the
  preload allowlist, so the renderer could never call it. The preload↔main
  channel sets are now checked in **both** directions by a test.
- The tool deny list only applied in lean mode: a blocked tool was allowed
  in the normal mode. It now applies in every mode.
- A credential in a connector URL was printed on the permission card. The
  secret parts of a URL are now masked before they reach the screen
  (`src/shared/secrets.js`).
- The file browser walked the tree synchronously in the main process, which
  froze the window on a big folder. The walk now runs on the worker thread
  that existed but was never called.

### Changed
- The Agent SDK moved from 0.3.303 to **0.3.308** — the version the desktop
  ships. No new capability (the option key set the desktop uses was already
  accepted), but the options CCE relies on are now typed.

## [0.9.39] - 2026-10-22

### Fixed & Improved
- **Security & Navigation Sandboxing**:
  - Hardened Electron `will-navigate` handler to strictly confine local `file://` navigations within `rendererDir`, preventing arbitrary file URL escapes (`src/main/main.js`).
  - Added safe error wrapping in `setWindowOpenHandler` to reject malformed external URLs.
  - Re-anchored renderer root path resolution to module initialization to prevent TDZ scope issues.
- **Reliability & Transcript Virtualization**:
  - Synchronized `msgs.removeChild` in chat virtualization to keep `_allNodes` and virtualized window bounds consistent with the DOM (`src/renderer/chat.js`).
  - Corrected user message reconciliation during engine reconnection replays to search across all virtualized nodes (`_allNodes`), preventing prompt duplication.
- **Stability & Model Cache Management**:
  - Automatically invalidate proxy fallback cache (`clearLastGoodModel`) upon explicit user model selection (`src/main/chats.js`).
- **Crash-Safe Persistence**:
  - Converted pending auto-memory proposals to atomic writes (`atomicWriteJson`) and safe parsing (`readJsonSafe`), preventing file corruption on abrupt system interruptions (`src/main/automemory.js`).

## [0.9.38] - 2026-10-22

### Added
- **Provider Robustness (Phase A)**:
  - Generalized environment variable credential resolution across the 230+ model catalog (`src/main/providers.js`).
  - Per-provider key/URL mismatch detection (Anthropic vs OpenAI routes, missing `/v1`, scheme errors).
  - Reliable model listing falling back to models.dev catalog with `catalog: true` tagging.
  - Context window probe and cache for unlisted models via provider `/models` endpoints (`src/main/modelcontext.js`).
  - Per-provider fallback model declarations and structured error handling for malformed tool payloads (`src/main/proxy.js`).
  - Rate-limit (HTTP 429) backoff honoring `Retry-After` headers up to 60s with host cooldown tracking (`src/main/adapters.js`).
- **Claude Code Parity & Tool Policy (Phase B)**:
  - Host-side `canUseTool` pipeline parity: VM path denial, read-only session mode, write tool block rules, and `updatedInput` pinning (`src/main/tools.js`, `src/main/chats.js`).
  - Connector tool permission policies (`always_ask`, `always_allow`, `always_deny`) and active tool selection (`src/main/connectors.js`).
  - Dedicated worker threads for heavy operations (file indexing, transcript search, shell path resolution) with in-process fallbacks (`src/main/workers/`).
  - Hardened sender frame origin validation for all IPC invoke channels (`src/main/main.js`).
- **Performance & UI Improvements (Phase C)**:
  - Transcript virtualization keeping bounded message windows in DOM for massive conversations (`src/renderer/chat.js`).
  - DOM diffing for right-hand session rail cards to prevent unnecessary repaints (`src/renderer/app.js`).
  - Skill and agent pruning interface with persistent toggle switches (`src/main/skilltoggle.js`, `src/renderer/chat.js`).
  - Exponential backoff on MCP reconnects with status peeking (`src/main/connectors.js`).
  - Window state persistence and restoration per workspace (`src/main/windows.js`).
- **Quality & CI (Phase D)**:
  - Immunity to ambient `CLAUDE_CODE_MAX_CONTEXT_TOKENS` test flakes.
  - Dependency-free E2E smoke harness using Chrome DevTools Protocol (`test/e2e/smoke.mjs`).
  - Stryker mutation testing configuration (`stryker.config.json`).
  - Enhanced GitHub Actions CI workflow with lint, test, build, and E2E jobs.

## [0.9.37] - 2026-10-22
- Added Steer vs Queue mode toggle with immediate interrupt on steering.
- Auto-allowed WebFetch and WebSearch tool calls with `~/.claude` path exemptions.
- Replaced expand button and Ctrl+E with dynamic auto-expanding textarea in composer.

## [0.9.36] - 2026-10-22
- Review fixes: clamped context budget, live poll teardown, dead-chat routing, truthful header.
