# CCE review and phased roadmap (after 0.9.47)

This is a review of `main` at `2376a5a` (0.9.47). It covers UI/UX, performance,
stability, security, and tool calling for non-Claude models. It also folds in
three requested UI changes:

- **R1:** an Overview panel that stays pinned on the right
- **R2:** a smaller composer footbar
- **R3:** conversations in a left sidebar, with the top bars removed

References to other projects: Claude Code Desktop (screenshots 3 and 4) and
OpenCode's model/variant system ([opencode.ai/docs/models](https://opencode.ai/en/docs/models)).

Each item is tagged with how sure the finding is:

- **[bug]**: confirmed by reading the code
- **[gap]**: a missing feature or a mismatch with the references
- **[verify]**: likely, but needs a repro against a real provider first

---

## Status (updated for 0.9.53)

| Phase | Version | State |
|---|---|---|
| 0 Hotfixes (0.1 image cap, 0.2 provider switch, 0.3 effort toasts) | 0.9.48 | shipped |
| 3 Tool calling (3.1 schemas, 3.2 Gemini signatures, 3.3 / 3.4 effort and output cap, 3.5 tool images, 3.8 vision gate) | 0.9.49 | shipped |
| 1 Composer (1.1 provider + model picker, 1.2 per-model effort, 1.3 auto on every provider, 1.4 footbar) | 0.9.50 | shipped (picker is a grouped list, not yet a searchable popover) |
| 2 Layout (2.3 pinned compact Overview) | 0.9.51 | shipped |
| 2 Layout (2.1 sidebar, 2.2 one-line top strip) | 0.9.52 | shipped |
| 4.6 unsent messages, 5.2 queue without images, 5.4 / 5.5 notices and sandbox | 0.9.53 | shipped |

| 1.1 picker, 3.8 tools half (0.9.60); 3.6, 3.7, 3.9, 3.10, 3.11 (0.9.61); 4.2, 4.3 (editors), 4.5 (way back) (0.9.62) | 0.9.60-0.9.62 | shipped |

Notes on the last batch: 4.3's folding was already covered by the transcript virtualization (a 100-row window); only the Monaco release on eviction was missing. 4.4's payload limits already exist (attach and file:read caps, per-channel IPC caps). 4.5 became a "Switch back" offer when the new provider fails before answering, because the engine only emits its first init frame once a message is sent.

| 4.1 ES-module split | 0.9.64 | shipped (chat/, app/, providers/ modules bundled by esbuild) |

Not done, and why:

- **3.6 / 3.7 / 3.9 / 3.10 / 3.11** (Mistral call ids, long tool names, per-model temperature, parallel-call streams, prompt caching) need a reproduction against the real provider before a fix is worth its code.
- **3.8, tools half** (warn when a model cannot call tools): only the vision half shipped.
- **4.2 event-driven Overview**: still refreshes every 6 s while the window is visible (it skips redraws when nothing changed).
- **4.3 transcript folding** for very long chats and **1.1 searchable model popover**: not started.

---

## Phase 0: Hotfixes (ship as 0.9.48)

These are small, confirmed bugs that users run into today.

### 0.1 [bug] "Not sent — IPC payload too large" when a message includes screenshots (screenshot 1)

- **Cause:** `src/main/main.js:757` rejects every IPC payload over 1 MB.
  `chat:send` and `chat:steer` carry pasted images as base64
  (`src/renderer/chat.js:364`). Two 1080p PNG screenshots come to about
  1.09 MB, so the message is blocked.
- **Contradiction:** the attach path allows images up to 4 MB each
  (`chat.js:805`), and the Anthropic API allows 5 MB per image. The 1 MB cap
  breaks a feature the app advertises.
- **Fix:**
  - Downscale pasted and attached images in the renderer before they are
    queued. Cap the long edge at 1568 px, which is Anthropic's recommended
    maximum, and re-encode to JPEG or WebP when that is smaller. A screenshot
    drops to roughly 150–300 KB.
  - Give `handle()` a per-channel limit, e.g. `handle('chat:send', fn, { maxBytes: 24e6 })`,
    and keep 1 MB as the default for every other channel.
  - When a send fails, put the text and images back into the composer instead
    of leaving a "sent" bubble with nothing behind it.
- **Related:** the queued-message path writes base64 images into
  `localStorage` (`chat.js:383`). The roughly 5 MB quota then fails without
  any message. Persist only the text, or write images to a temp file in the
  main process and store the path.

### 0.2 [bug] Switching provider on an open chat breaks the chat, so users are told to open a new one

- **Cause:** `createSession` captures `const id = res.id` (`chat.js:143`).
  `switchProvider` (`chat.js:1082`) changes `chat.id` to the new engine
  session and closes the old one. Several handlers still use the old `id`:
  - `chat:send` (`chat.js:445`)
  - `chat:steer` (`:408`)
  - `chat:interrupt` (`:340` and `:534`)
  - `chat:set-mode` (`:323`)
  - `chat:fork` (`:345`)
  - the init prompt (`:606`)

  The next message after a switch goes to a chat that no longer exists. The
  error fallback then says *"the session is no longer running; open a new
  chat"*.
- **Fix:** read `chat.id` at call time in all six places. Close and activate
  already do this, per the comment at `:271`. Add a regression test that
  switches provider and then sends, interrupts and changes mode.
- **Result:** with this fix, switching provider keeps the transcript and
  continues the chat, as OpenCode does. The main process already resumes the
  session on the new provider (`main.js:1582`).

### 0.3 [bug] Effort and thinking controls fail without telling the user

- `cycleThinkingBudget` shows a success toast without checking the result
  (`chat.js:797`).
- `cycleEffort` offers `xhigh` and `max` to every model (`chat.js:777`). Phase
  1 replaces both controls; until then, check the result.

---

## Phase 1: Composer footbar and model/provider/effort controls (R2)

**Target footbar:** `workflows · model (with provider) · mode · effort`, plus a
small context ring on the right, like Claude Desktop's `Auto … Sonnet 5.5 Medium ◔`.

### 1.1 [gap] A combined model and provider picker

- Replace the `<select>` with a searchable popover:
  - models grouped under their provider, with a "Recent" group at the top
  - a short line per model from models.dev: context size, vision, tools,
    reasoning
- Picking a model from another provider calls `chat:set-provider` and then
  `chat:set-model` in one step. With 0.2 fixed, the conversation continues in
  the same chat.
- Show it as one label, `Provider · Model`. Remove the separate
  `.chat-provider` chip from the header.
- Before switching, warn when the target model can't take what the transcript
  already has. For example, the transcript has images but the target model has
  `attachment: false`, or the target has a smaller context window than the
  tokens already used. Offer "compact first".

### 1.2 [gap] Effort picker that shows only levels the model supports (OpenCode "variants")

- Work out the levels for each model from catalog metadata, as OpenCode does:
  - no `reasoning` flag → no effort control at all (e.g. MiMo flash)
  - Anthropic → `low · medium · high · xhigh · max`, limited to what the engine
    reports through `chat:supported-models`
  - OpenAI reasoning models → `minimal/none · low · medium · high`, plus
    `xhigh` only where the model supports it
  - Google → `low · high`
  - other OpenAI-compatible providers → `low · medium · high` only when
    `reasoning: true`
  - users can add per-model overrides in provider settings, with a
    `variants` list like OpenCode's config
- The control is a dropdown with a check mark on the current level, not a
  click-to-cycle button. Keyboard: `Ctrl+T` cycles levels, as in OpenCode.
- Remove the separate `think:` budget button. Effort maps to a thinking budget
  inside the proxy (see 3.3).

### 1.3 [gap] Mode picker: `auto · accept edits · plan · yolo`, on every provider

- Today `auto` is turned off for any provider with a `baseUrl`
  (`app.js:2203`, `chats.js:1688`). The SDK's auto classifier needs a Claude
  model.
- **Fix:** add a CCE-side auto policy for translated providers, used in
  `canUseTool`:
  - auto-approve read-only tools and edits inside the working directory
  - auto-approve Bash commands that match an allowlist (git status/diff/log,
    ls, cat, test/lint scripts, etc.)
  - ask for anything destructive. `src/main/tools.js` already has the
    destructive-tool patterns.

  This makes `auto` mean the same thing on every model.

### 1.4 [gap] Remove footbar buttons and handle their jobs automatically

- **fast build:** becomes an entry under workflows.
- **think:** folded into effort (1.2).
- **ctx compact button:** replaced by a context ring. Click it to open a
  popover with a breakdown and a **Compact now** button. Auto-compaction
  already exists. Make the threshold depend on the model's real context window
  from models.dev, not a fixed number.
- **Statusline row:** remove it from under the footbar. Session cost and turn
  count move to the Overview › Context card. The `no auth — /login` notice
  becomes an inline banner, shown only when it applies.
- **Queue/Steer toggle:** keep it only while a turn is running, as it is now.

---

## Phase 2: Layout like Claude Desktop (R1 and R3)

### 2.1 [gap] A permanent left sidebar for conversations, replacing the tab bar (screenshot 4)

- Top of the sidebar: Search, then **New**, Usage, Providers, Connectors,
  Settings. These are the current nav items, shown smaller.
- Below that, project groups as collapsible folders. Each group has a `+` for
  a new chat in that folder, and lists its conversations.
  - The running chat shows a spinner, an unread dot or a PR badge.
  - Hover menu: Open PR, Open in, Pin, Mark as unread, Rename, Fork, Move to
    section, Archive, Delete. Pin, Rename, Fork and Archive already exist in
    `#convo-drop` (`app.js:250-400`). This moves them into the sidebar.
- Open chats are no longer tabs. The selected row is the active chat, and
  inactive ones stay alive in the background. Keep `Ctrl+Tab` and `Ctrl+1…9`
  to move between the most recently used chats.
- Footer: account and provider badge, plus Remote/Window buttons.
- `Ctrl+\` collapses the sidebar to icons. Width can be resized and is
  remembered.

### 2.2 [gap] Remove the top bars

Remove `#tabbar` and `#convo-quick`. Their contents move as follows:

| Today | Moves to |
|---|---|
| ☰ sidebar, Conversations ▾ | Title-bar strip, like Desktop's `≡ ◫ ← →` |
| tasks | Title-bar icon (opens the right panel) |
| ⧉ window | Sidebar footer or `⋯` menu |
| New chat / Resume latest / All conversations / Closed tab | Sidebar (New, project `+`, search, recently closed in `⋯`) |
| folder / repo / branch / changed / memory chips | Overview › Environment |
| provider label, continue, `⋯` | Footbar model picker; continue shows inline in the transcript when the model stops early |

- What remains is one 36–40 px title strip:
  - left: chat title with a rename caret, as in Desktop's "Code review and bug fixes ▾"
  - right: icon buttons for Overview, Terminal, Diff, Preview, Files and `⋯`
- All buttons in the strip are the same size: 28 px square icon buttons, each
  with a tooltip and an aria-label.

### 2.3 [gap] Overview always on the right; other panels open beside it (R1)

- Overview becomes its own right-side column, not a tab:
  - It cannot be hidden through the tab chooser. Collapsing it to zero width
    is still possible from the title-bar icon.
  - Changes, Files, Terminal, Diff and Preview open as a second panel next to
    it, and each can be hidden, as today through `cce.splitHidden`.
- **Background tasks** section: shown only while at least one task is
  running. The data is already in `chat.bgTasks`.
- Make it more compact, matching screenshot 3:
  - collapsible section headers with a chevron
  - each row in a 13 px label/value grid
  - long values wrap onto several lines instead of being cut off with "…"
    (`white-space: normal; overflow-wrap: anywhere`)
  - Context card: one bar, the top 4 categories, the rest behind an "MCP
    tools / Memory files / Custom agents ›" expander
  - Connectors card: collapsed by default to a summary such as "8 live · 3
    off"; expand it to toggle connectors
  - Changes: list PRs and branches, as Desktop does
- Remove the 6 s full redraw (`app.js:982`). Redraw only on events (see 4.2).

---

## Phase 3: Tool calling and harness for all models

The goal is for non-Claude models to behave like Claude models in CCE.
`src/main/adapters.js` and `proxy.js` already recover tool calls written as
text and fix up the system prompt. These are the remaining gaps.

| # | Tag | Problem | Fix |
|---|---|---|---|
| 3.1 | [bug] | Tool schemas are passed through unchanged (`adapters.js:199`, `:449`). Gemini's native API rejects `$schema`, `additionalProperties`, `exclusiveMinimum`, `propertyNames` and `const`. Strict OpenAI-compatible servers (vLLM, some Groq and Mistral models) reject some of these as well. | Add a `sanitizeSchema(schema, dialect)` step for each dialect, as OpenCode's provider transform does. Gemini can instead use `parametersJsonSchema`. |
| 3.2 | [bug] | Gemini 3 needs the `thoughtSignature` from earlier `functionCall` parts sent back. `buildGeminiBody` drops it, so a multi-step tool loop fails with a 400. | Store the signature on the translated `tool_use` block (in a hidden field) and send it back. |
| 3.3 | [bug] | `reasoning_effort` and `reasoning:{max_tokens}` are sent to every model (`adapters.js:132-136`). OpenAI models without reasoning, DeepSeek and most local servers return a 400, or ignore it. | Send effort only when models.dev says `reasoning: true`. Map effort to the right field for the dialect. Never send both fields. |
| 3.4 | [bug] | `max_tokens` is not limited to the model's output limit. | Clamp it to `limit.output` from models.dev. |
| 3.5 | [bug] | Images inside a `tool_result` (Read of a PNG, screenshot tools) become the text `[image]` (`adapters.js:226`). The Gemini path also drops images in user messages (`:421`). | For models with vision, send the image as a user message after the tool result (OpenAI) or as `inlineData` (Gemini). For models without vision, insert a short text note. |
| 3.6 | [verify] | Tool-call IDs are passed through unchanged (`toolu_…`). Mistral requires 9-character alphanumeric IDs. | Map IDs for each dialect, both ways. |
| 3.7 | [verify] | Tool names longer than 64 characters (`mcp__plugin_…__…`) or containing characters some providers don't accept. | Shorten the name, keep a lookup table, and translate it back in the response. |
| 3.8 | [gap] | No per-model capability gate. Images are sent to models without vision, and tools to models with `tool_call: false`. | Use the existing `attachment` and `tool_call` fields from models.dev (`modelsdev.js:76`). If a model can't call tools, warn the user and switch it to a text-only "ask" mode. |
| 3.9 | [gap] | No per-model defaults for temperature and top_p. | Add a small built-in table, e.g. Qwen 0.55, Gemini 1.0, and DeepSeek-R1 with no temperature, with overrides in provider settings. |
| 3.10 | [gap] | Parallel tool calls: some providers return several calls with the same index, or interleave their deltas. | Check `pickToolSlot` (`proxy.js:993`) against Kimi, GLM and Qwen stream captures. Add fixture tests. |
| 3.11 | [gap] | Prompt caching on providers that support it (OpenRouter Anthropic and Gemini, DeepSeek automatic, OpenAI automatic). | Send `cache_control` or let the provider cache automatically. Show cache-read tokens in Overview › Context. |

---

## Phase 4: Performance and stability

| # | Tag | Item |
|---|---|---|
| 4.1 | [gap] | `chat.js` is 4,984 lines and `app.js` is 3,191, as browser globals with no modules. Split them into ES modules (composer, transcript, tool cards, permissions, picker, sidebar, overview) and build with esbuild, which is already a dev dependency. This is needed before Phase 2 can be done safely. |
| 4.2 | [gap] | Overview polls every 6 s and context every 5 s (`app.js:982`, `chat.js:1940`). Switch to event-driven updates: `result` and `usage` events from the SDK, file-watch events for git, and the existing `git:cache-invalidate`. Keep one slow fallback poll every 30 s. |
| 4.3 | [verify] | The transcript uses `content-visibility` (`styles.css:366`), but nodes are never removed. A chat with 2,000+ tool cards keeps growing. Fold transcript segments older than N turns into a placeholder that can be expanded. Dispose Monaco diff editors as they scroll out of view, not only when the chat closes. |
| 4.4 | [bug] | After 0.1, check other large-payload channels (`file:share`, the attach-files response, `file:read` at up to 2 MB) and set a sensible limit for each channel. |
| 4.5 | [gap] | During a provider switch the old engine session is closed after the new one starts. If `chats.create` throws, the user is left with a chat that is still alive but no longer selected. Keep the old session until the new one has answered its first `init`. |
| 4.6 | [gap] | Failed sends: keep the user's text and images, offer **Retry**, and show the real cause (auth, quota, oversize) instead of "open a new chat". |
| 4.7 | [gap] | Add `vitest` tests for: switch provider then send (0.2); a 3 MB image send (0.1); schema sanitizing for each dialect (3.1); effort variant derivation (1.2). |

---

## Phase 5: Security hardening

The baseline is already good: renderer has `contextIsolation` + `sandbox`;
IPC fails closed on bad origins; `file:read` is limited to open projects and
blocks sensitive files; the proxy listens on 127.0.0.1 and requires a token;
`openExternal` is allowlisted. The remaining items:

| # | Tag | Item |
|---|---|---|
| 5.1 | [gap] | Per-channel payload limits (0.1) should be an allowlist. Unknown channels keep 1 MB. |
| 5.2 | [gap] | Pasted screenshots in `localStorage` (0.1) are not encrypted. Keep image bytes in main-process temp files with mode 0600, deleted on send. |
| 5.3 | [verify] | Check that the CCE auto-mode allowlist (1.3) can't be bypassed with shell metacharacters (`;`, `&&`, `$(…)`, backticks, redirects). Parse the command or reject compound commands, rather than matching prefixes. |
| 5.4 | [gap] | Cross-provider switching (1.1) resumes the transcript on another vendor. Show a one-time notice that the conversation history will be sent to the new provider. |
| 5.5 | [gap] | The preview iframe has `allow-scripts allow-same-origin allow-popups` (`app.js:1005`). It loads a localhost origin, not `file://`, so it can't reach the app shell or `ccx`. Still, drop `allow-popups` unless a page needs it, and pass popups through the existing `setWindowOpenHandler` allowlist. |

---

## Suggested order

1. **0.9.48:** Phase 0, plus 4.6 and the tests for it. Small, and fixes both
   reported errors.
2. **0.9.49:** Phase 3, items 3.1–3.5 and 3.8. This makes Gemini, OpenAI and
   local models more reliable.
3. **0.9.50:** Phase 4.1, the module split. Needed before the layout work.
4. **0.10.0:** Phases 1 and 2, the new footbar, left sidebar, title strip and
   pinned Overview. Ship behind a `cce.layout=desktop` setting for one release,
   then make it the default.
5. **After that:** Phase 5 and the remaining [verify] items as they are
   reproduced.
