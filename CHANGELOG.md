# Change Log

All notable changes to Claude Code Enhanced are documented here.

## 0.9.80
- Fixed: a connector tool whose schema points into its own definitions (`$ref` to `$defs`/`definitions`) was sent with the pointer but without the definitions, which vLLM's guided decoding and Gemini reject. Local references are now filled in; a recursive or unknown one becomes an open schema.
- Fixed: an image over 5 MB (a large screenshot a tool returned) made the provider refuse the whole request. It is now sent as a short note, on every API format.
- Changed: the translator proxy refuses a request over 96 MB with a 413 instead of buffering it without limit.
- Added: regression tests for interleaved parallel tool calls from Qwen, GLM and Kimi, and for Mistral's 9-character tool ids round-tripping.

## 0.9.79
- Fixed: a thought that streamed in was replaced by the finished message's empty copy, leaving only a "Thought for Xs" pill. The streamed text now stays, and a thought the provider kept to itself says "reasoning not shared by the provider" instead of showing an empty block.
- Fixed: reasoning sent by OpenAI-format providers in `reasoning_text`, `thinking` or OpenRouter's `reasoning_details` was dropped. The proxy now reads every known field, streamed and not streamed.
- Changed: a finished thought stays open until the answer starts, and its pill shows the opening line of the thought.
- Added: Usage, Providers, Connectors and Settings have a "← Conversations" button, and Connectors has a Home › Connectors breadcrumb.
- Changed: the app starts on a blank home page with recent folders, Open folder…, New chat here and Resume latest, instead of opening a chat in the home folder. Settings → Chat behaviour → "Open a chat in the default folder on start" brings the old start back.

## 0.9.78
- Fixed: attaching a file (e.g. a `.pine` script) failed with "totalBytes is not defined".
- Fixed: Claude's thinking is visible again. Newer Claude models omit the thinking text unless the app asks for summaries; CCE now asks. Settings > Session caps & model > "Show thinking" turns it off.

## 0.9.74
- Changed: connectors switch on and off by themselves. Every connector stays connected; what changes per chat is which ones the model is shown. The per-chat switch on the Overview card and the enable/disable buttons in the live MCP panel are gone, because that change applied to one session and was lost in the next chat.
- Added: tool search for every provider that supports it (the default login, Anthropic's API and translated providers), so the model sees connector tool names and loads a definition only when it asks. A third-party gateway that speaks the Anthropic format is left as it was.
- Added: for a model with a small window (under ~128k) or without tool search, CCE scores each connector against your message (server name, tool names and descriptions, what this project used before, what this chat used) and shows the best fits within a tool budget. It decides before the message is sent, and keeps a connector the chat used in the last few turns.
- Added: the connectors each project uses are remembered, so the second chat in a repo starts with the right ones.
- Added: a connector that is a copy of another (same tools registered twice) is left out of the chat; the better fit stays. Connectors that only share a generic tool name are not touched.
- Added: a failed connector reconnects on its own after 5 s, 15 s, 45 s, 2 min and 5 min, then stops. "Needs sign-in" stays as a Sign in button, since it needs you.
- Added: Settings → Connectors has Auto (default) / Always on / Off for each connector, for all projects or only the open one. Always on is never dropped by the picker or as a duplicate.
- Changed: the Overview card shows a status dot, name, tool count and how each connector is used (auto · loaded, auto · idle, used 3×, pinned), Sign in / Reconnect only where needed, and a Manage connectors link. The "disconnect unused ones" note is gone.

## 0.9.73
- Fixed: four shell commands the auto policy approved but should have asked about: `uniq in out` (writes a file), `tree -o` (writes a file), `tail -f` (never ends and hangs the turn), and `cat ~/.config/gh/hosts.yml` (prints a stored token). `file -C`, `date` with a time to set, and `hostname` with a name are also asked about now.
- Changed: the credential-file list covers `.config/gh`, `.config/gcloud`, `.git-credentials`, `.docker/config.json`, `.kube`, `.azure`, `.pgpass`, shell history, `*.pem`/`*.key`/`*.p12` and `/proc/*/environ`, and it now applies to the Read, Grep and Glob tools too, not only to shell text.
- Changed: WebFetch asks before fetching a site you have not approved, so text in a web page cannot make the agent send data out in a URL unseen. Approved sites come from Settings → Web fetch (one per line; `*.example.com` covers subdomains) and from "Always allow" on the prompt, which saves the site for every later chat. Web search is unchanged.

## 0.9.72
- Fixed: a model that thinks for a long time with no output was treated as a dead connection. The proxy now sends a keep-alive ping every 15 seconds while a reply is open.
- Added: Settings → seconds of silence before a stalled reply is stopped (30–1800, default 180). It was fixed at 180.
- Changed: prompt-size estimates read the request by content type (code and JSON count denser than prose, CJK about a token a character, images a fixed cost, not their base64 length) and are corrected from the provider's real counts for that model. A reply with no reported size is counted from what was streamed instead of from the number of chunks.
- Changed: Read, Grep and Glob results are compacted for the model like shell output (the card keeps the full text). Read keeps a larger share, keeps repeated lines as written, and says how to read a narrower range.
- Fixed: the context-window probe had no timeout, skipped the Anthropic version header, and remembered one failure for the life of the app. It now times out after 8 s, sends the key the way each family expects, and retries after 5 minutes.
- Changed: model-name context table covers GPT-4.1/5, Gemini 3, Claude 4/5, Qwen3-Coder, Kimi K2, GLM-4.5+, Grok and Llama 4, and no longer reads `o1` out of the middle of an unrelated name.
- Fixed: a request that had already reached the provider was sent again after a dropped socket or a 504, paying for the reply twice. Only a failure before the connection is made (refused, DNS, unreachable) is retried, plus 429 and 502.

## 0.9.71
- Fixed: reasoning settings were sent to every OpenAI-compatible provider, and servers that do not know them answered with a 400 (a `reasoning` object was even sent to api.openai.com). They now go only where they are known to work: `reasoning_effort` to OpenAI o-series / GPT-5, Groq gpt-oss / Qwen3, xAI grok-3-mini and Ollama; a `reasoning` object to OpenRouter. Any other server gets neither. A provider entry can override this with `reasoningParam` (`effort`, `openrouter` or `none`).
- Fixed: Claude's `max` effort level is clamped to `high` for OpenAI-style providers.
- Fixed: DeepSeek, Kimi and MiniMax thinking models now get their earlier reasoning back (`reasoning_content`) next to the tool call it led to. DeepSeek answers 400 without it and the others lose the thread. A provider entry can force this on or off with `replayReasoning`.

## 0.9.70
- Changed: the loop guard now judges a repeat by what came back. The same call returning the same result three times is a loop; a call whose result keeps changing (watching a build, polling a status) is not. Repeated reads of task output (TaskOutput, BashOutput, TaskGet, TaskList) are waiting, never a loop.
- Changed: a shell command that changes a file (`>`, `sed -i`, `tee`, `mv`, `cp`, `git commit`...) counts as progress, like Write and Edit, so a test, edit, test cycle done through the shell is no longer flagged.
- Added: the same error three times in a row (even from different commands) is caught as a loop.
- Added: subagents are judged separately from the main agent and from each other.
- Changed: the first time a loop is detected the repeating call is not run; the agent is told why and to change approach, and the turn goes on. If it loops again without any progress, the turn is stopped as before. The chat shows a note for each.

## 0.9.69
- Fixed: a JSON example in the model's prose (`{"name": "rm_everything", …}`) was run as a real tool call. A call recovered from text or reasoning now only counts if it names a tool the request offers; loose spellings (`bash`, `read_file`) are mapped to the real tool, and a request that offers no tools (titles, summaries) recovers nothing.
- Fixed: text next to an unusable JSON blob (`hello {…} bye`) was swallowed; it now stays in the reply.
- Fixed: a call written in the reasoning *and* sent as a structured call ran twice, and reasoning-channel calls could land before the thinking. Calls are now de-duplicated and sent in order at the end of the reply.
- Changed: a model's JSON slip (trailing comma, `True`/`None`, single quotes, a missing closing brace) is mended instead of ending the turn. A call that was cut off (output limit, dropped stream) is still never mended, since closing it would run a write with half its content. A finished reply whose arguments are unusable reaches the engine, which then tells the model what is missing; a stream that dies inside a call with nothing else said is reported so the engine retries.
- Fixed (Gemini): a malformed tool call is retried instead of ending as an empty reply; MAX_TOKENS is a cut; safety stops and blocked prompts say why in the non-streamed path too.
- Fixed (Responses API): argument chunks are matched to their call by item id / position (an unknown id used to be glued onto call 0); calls that arrive only in `output_item.done` are taken; `response.failed`/error events and `incomplete`/`failed` plain replies are reported.

## 0.9.68
- Fixed: the planning/ask-the-user instructions were never sent to the model (they were set on an option the engine ignores); they now travel in the system prompt. Chats resumed from an older session keep their recorded prompt until the next compaction.
- Changed: the instructions no longer push a review or a question into edits, and name a todo tool only when the chat has one. The auto-lean tool set now includes TodoWrite.
- Fixed: a failed tool result now reads `ERROR: …` for OpenAI-format and Gemini providers (they have no error flag), so small models stop re-running a call that failed.

## 0.9.67
- Fixed: plugin/MCP tools whose names contain characters OpenAI-format APIs reject (colons, dots, spaces — e.g. `plugin:ecc:…` browser and device tools) are now sent under a safe alias and mapped back, instead of being refused or dropped for non-Anthropic models.

## 0.9.66
- New: per-model sampling defaults when a request sets none (Qwen 0.55, Gemini 1.0; DeepSeek-R1 and models that reject sampling get none). A provider can pin its own `temperature` / `topP`.
- Fixed: the context-window probe now sends the provider's API key, so gated `/models` endpoints answer.
- New: OpenRouter Gemini models get a prompt-cache breakpoint on the system prompt, like Claude (cache-read tokens already show in the rail).
- Fixed: Mistral dated ids (`mistral-large-2411`, `codestral-2501`) match their catalog entry for capabilities and context.
- New: a provider with no small-fast model gets the cheapest tool-capable flash/mini/lite model from the catalog.

## 0.9.65
- Fixed: a denied-tool note and background-task rows printed raw `<svg …>` text instead of an icon.
- Fixed: terminal colour codes (`[0m`, `[32m`) no longer show up in tool output cards.
- Changed: on wide windows the conversation stays on the window's centre line when the left sidebar is open.
- New: drag the Overview's left edge to resize it (240–560 px, remembered; double-click resets).

## [0.9.64] — 2026-10-24

### Changed
- **The renderer is now ES modules.** The three big scripts that shared one global scope (`chat.js` ~5,400 lines, `app.js` ~3,400, `providers.js`) are split into modules by job — `chat/` (composer, transcript, stream, tool cards, permissions, model picker, panels, slash commands, events, session), `app/` (tabs, conversations sidebar, overview, connectors, settings, usage, provider forms) and `providers/` — each importing what it uses. `main.js` is the entry.
- They are bundled by esbuild (`scripts/build-renderer.js`) into one script, `src/renderer/app.bundle.js`, which `index.html` loads. It is built automatically before `npm start`, `npm run smoke` and `npm run dist`; it is not committed, and the module sources are left out of the package.
- No visible or behavioural change: screenshots of the app before and after are pixel-identical in the scenarios checked (start, picker open, Providers page, request rail), and the app boots in real Electron.

## [0.9.63] — 2026-10-24

### Fixed
- **Models are now told to use the question card.** The system prompt added for every model asks them to call AskUserQuestion (two to four short options) when they need a decision or a missing fact, instead of asking in plain text. It is left out when the tool is not available.
- **The "Lean coding" and "Read-only" tool presets, and automatic lean mode for small-context models, now keep AskUserQuestion**, so small models can still ask you through the card. The custom tool checklist ticks it by default.
- Checked and unchanged: the question card is drawn in the chat, answers go back to the engine as the tool's answers (multi-select as a list), Skip denies it, and the auto policy never approves a question on your behalf.

## [0.9.62] — 2026-10-24

### Changed
- **The Overview updates on events, not on a 6-second timer**: when a turn starts or ends, a session begins, the model or provider changes, or a file-changing tool (Edit, Write, Bash…) finishes. Bursts are coalesced; a hidden window catches up when it returns. A 60-second safety refresh remains.
- **Monaco diff editors are released when their card scrolls out of the page** (the transcript already keeps only a window of rows in view); they rebuild when the card is opened again.

### Added
- **A way back after a provider switch**: if the new provider fails before it has answered anything, the error offers "Switch back to <previous provider>" and the conversation continues there.

## [0.9.61] — 2026-10-24

### Fixed
- **Tool names over 64 characters** (common with MCP connectors) no longer fail on OpenAI-format providers: CCE sends a short stable stand-in and restores the real name in the reply.
- **Mistral** tool-call ids are mapped to the nine-character form it requires, the same way for the call and its result.
- **Sampling settings** (temperature, top_p) are not sent to models the catalog says reject them (reasoning models).
- **Parallel tool calls** whose streamed pieces arrive interleaved, or without an index, are kept apart and reassembled correctly.

### Added
- **Cached tokens** the provider served from its prompt cache are now reported to the engine as cache reads (so context and cost figures are right) and shown in the Overview's session row. Claude models on OpenRouter get an explicit cache breakpoint on the system prompt.

## [0.9.60] — 2026-10-24

### Added
- **Host-owned connector calls (opt-in, `hostConnectors` setting).** The model can call an approved connector tool without ever seeing its URL, headers or sign-in token; the app holds them. Your per-chat tool selection and per-tool permission prompts still apply, expired sign-ins are dropped, and secrets are masked in results and errors.
- **Task-aware model checks.** Before a message is sent, the app checks the selected model against what the message needs (tool calling, image input). If the model clearly cannot do it, the send is refused with a plain message and you can send anyway. If the model is not in the catalog, the send goes through with a note. The app never switches model or provider for you.

## [0.9.60] — 2026-10-24

### Added
- **Searchable model picker**: the footbar model control is now a button that opens a list with a search box. Models are grouped by provider, your five most recent picks sit on top, and a caption shows what the catalog knows about the highlighted model (context size, images, tools, reasoning). Arrow keys and Enter work; Escape closes it.
- **Switch guards**: before switching, CCE warns if the conversation won't fit the new model's context window (and offers to compact first) or if the new model can't read images already in the chat.
- **Text-only mode for models that cannot call tools**: if the catalog says a model has no tool calling, CCE no longer sends it tool definitions (which many providers reject) and tells you the chat will be text-only.

## [0.9.59] — 2026-10-23

### Fixed
- After `/compact`, the wall of plugin-hook text ("Compacted PreCompact [node -e …]") is now one folded line, "Compacted · 2 hooks ran"; click it for the full output. Other long command output folds the same way.
- Connectors you switched off are no longer listed as "MCP not ready"; only connectors that failed to start are.

## [0.9.58] — 2026-10-23

### Fixed
- The Overview, tool panel and their splitter no longer show on the Usage, Providers, Connectors and Settings pages (the Overview used to float over the Providers cards).

## [0.9.57] — 2026-10-23

### Changed
- **The orange progress strip under the top bar is gone**, so the chat reaches the top. Context use is still shown by the ring in the composer footbar and the Overview card.
- **The chat is centred in the window** on wide screens: the Overview floats over the right margin instead of pushing the chat off-centre (below 1500 px it docks as before). The top strip is hidden on the Usage, Providers, Connectors and Settings pages.
- Code pruned after review: dead context-bar code removed, the request rail uses one set of delegated listeners and repaints only when a request is added or removed.

### Fixed
- **Context "+N more" could not be expanded.** Its open/closed state now lives on the Overview itself and reacts on press, so a refresh can no longer swallow or undo it.
- A "model not found" error (for example Haiku mapped to a model the provider lacks) now explains what happened and offers a one-click return to the provider's default model.

## [0.9.56] — 2026-10-23

### Added
- **Request rail**: a thin column of ticks on the left edge of the chat, one per request you sent. Hover a tick to read the request, click to jump to it. It shows only while the left sidebar is hidden and steps aside when the sidebar is open.

## [0.9.55] — 2026-10-23

### Changed
- **The top strip now runs the full width** of the window, past the Overview; the Overview cards start below it.
- **Tasks can be ticked off**: click a step in the Overview's Tasks card (or press Space/Enter) to mark it done or undo it. The card still appears only when a model writes a todo list.

### Fixed
- The Context card's "+N more" button could be lost to a refresh mid-click; refreshes now wait while a button is pressed and the toggle cancels any render in flight.

## [0.9.54] — 2026-10-23

### Changed
- **Overview is now floating cards on black**: no grey panel behind them, each card black with an orange outline and a soft shadow, like Claude Desktop's right rail.
- **Every card folds**: click a header (chevron on the right) to hide its details; the badge still summarises it. The choice is remembered per card. Connectors start folded, being the longest card.
- **Fold-all button** in the Overview header, and an **Overview button in the top strip** that hides or shows the whole column (remembered).
- The long connector notes ("12 connectors live...", the duplicate tool-name list) are now one-line summaries that open on demand instead of filling the card.

## [0.9.53] — 2026-10-23

### Fixed
- A message the engine refuses (too large, session ended, provider error) is no longer lost: the text and images go back into the composer, and the error says so. A newer draft is never overwritten.
- Queued messages are remembered across a crash as text only. Pasted screenshots used to be written into browser storage as base64: they overflowed its quota without a word and sat on disk unencrypted.

### Security
- The preview frame can no longer open popups (`allow-popups` removed from its sandbox); a local dev page still cannot reach the app.
- Switching provider now says that the conversation, history included, goes to the new provider.

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
