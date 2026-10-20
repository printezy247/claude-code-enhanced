# CCE reliability: nudge, tab lifecycle, context window, todos, token usage

Date: 2026-10-20 · Version target: 0.9.34 · Base: main @ 65e2e8d (0.9.33)

## Intent

Five bugs reported against CCE (Claude Code Enhanced, Electron app driving the
Claude agent SDK). All five verified against the 0.9.33 sources on main.

## Goals

1. Auto-nudge never fires while the agent legitimately waits (CI green, merge,
   background tasks, permission prompt).
2. Chat tab never sticks busy/unfocused, especially after `/handoff` and
   "Resume latest".
3. Context window shown and enforced matches the model's real limit for every
   provider, not just Anthropic.
4. Task list works for every model: shows on request, updates on steer,
   checks off finished items, clears itself when everything is done.
5. Token usage reduced where CCE itself causes waste; document settings that
   improve caching.

## Non-goals / anti-goals

- No rework of the compact-in-place flow (shipped in 0.9.33, works).
- No changes to permission, elicitation, or background-task mechanics.
- No new dependencies.
- No LAN listeners, no secrets in files (machine rules).
- Never commit the stray untracked dotfiles in repo root.

## Findings (verified on 0.9.33)

### 1. Nudge forces turns while waiting — `src/renderer/chat.js`

- `NUDGE_TEXT` (line 509), `announcedNextStep` (510), `maybeNudge` (524),
  fired from `result` handler (2571).
- `maybeNudge` gates: setting on, `chat.alive`, `chat.nudges < 1`,
  no queued turns, no draft. **No wait-awareness**: ignores live background
  tasks (`chat.bgTasks`), pending permissions (`chat.permCount`), and result
  text that says "waiting for CI / merge when green".
- Consequence: agent correctly stops to wait for a green merge; CCE fires the
  nudge; the nudge itself costs a full turn and repeats pressure (one per
  real prompt, re-armed at line 321).

### 2. Tab stuck / unclosable — `src/renderer/chat.js`

Symptom (Jack, 2026-10-20): **a stuck tab cannot be closed or viewed at
all**; busy spinner also reported earlier.

**Root cause found (rekey stale closure):** `switchProvider` (chat.js:869)
re-keys the chat onto a new engine id — `chats.delete(oldId);
chats.set(r.id, chat); window.rekeyTab(oldId, r.id)` (885, registry entry
moved in `app.js:1292`) — but the tab element's listeners were bound to the
**old id** at creation:

- `tab.addEventListener('click', () => activateChat(id))` (229)
- `closeBtn.addEventListener('click', … closeChat(id))` (228)

After rekey both resolve `chats.get(oldId)` → `undefined` → early return:
click does nothing (**can't view**), ✕ does nothing (**can't close**). The
tab is permanently dead. Provider switch is the "handoff to a new chat"
Jack sees.

Other provable stuck paths, also fixed:

- `doCompact` (2196): `compactBtn.disabled = true` with **no try/finally** —
  a rejecting `ccx.invoke` kills the button forever.
- `doHandoff` (2209): never checks `chat:send` result, never resets
  `chat.compacting` on failure — next result gets misread as a handoff brief.
- Late `status busy=true` after a handoff `result` re-marks the old tab busy
  with nothing to clear it.
- `closeChat`/`exit` delete tab meta without clearing `meta.busy` first —
  stale spinner can survive into `updateNavState` state.
- Late events for a rekeyed old id are silently dropped (chat.js:2370) —
  after the stale-handler fix this is correct behavior, but note it.

### 3. Context window stuck at 200k — `src/main/chats.js`, `src/main/main.js`

- `leanEngineEnv` (61-70): sets `CLAUDE_CODE_MAX_CONTEXT_TOKENS` **only when
  `ctx > 0 && ctx < ENGINE_DEFAULT_WINDOW` (200_000)** — it can only lower
  the window, never raise it. A 1M model on a translated provider still gets
  200k.
- Early return at line 63: anthropic-protocol providers get `{}` (engine
  defaults handle 1M — this is why only Anthropic shows 1M).
- `modelContext` (`main.js:54-60`): returns 0 when
  `provider.presetId` is missing or models.dev has no entry (OpenCode Go
  ids, date-suffixed ids, custom models). `ctx = 0` → env never set →
  engine default 200k.
- Display (`chat.js:1595/1604`, `app.js:1139`) trusts
  `getContextUsage().maxTokens` from the engine with no fallback to model
  metadata.

### 4. Todos only render when the model calls tools — `src/renderer/chat.js`

- Render paths: `TodoWrite` (3250, 3468), `TaskCreate/Update/List` via
  `applyTaskTool` (3286, 3469). Nothing else feeds `renderTodoItems`.
- Engine system-reminder todo lists (the `[1/5] …` checkbox blocks modern
  engines inject into messages) are **never parsed** — grep for
  `system-reminder` in the renderer: no hits.
- Providers where the model never emits those tools (translated proxies,
  tool-search enabled, smaller models) produce no list at all → side panel
  says "The agent has not made a task list for this turn" (`app.js:1244`).
- No lifecycle: list persists after all items completed (never auto-clears);
  no reset on a new user prompt; steering relies purely on the model
  re-calling the tools.

### 5. Token overhead

- Image 2 breakdown: System 1,628 · MCP 2,489 · Custom agents 4,622 ·
  Memory 578 · Skills 6,308 · Messages 43,686 · Autocompact 33,000.
- 10/10 connectors connected — every connected connector contributes MCP
  preamble each session.
- Translated providers get no prompt caching on the proxy; nudged turns add
  whole extra user/assistant exchanges to `Messages`.
- Mostly settings-side; code side is the nudge fix plus optional defaults.

## Decisions (how)

### Phase 1 — wait-aware nudge (chat.js)

Extend `maybeNudge` with three skip conditions, in order:

1. Live background tasks: `chat.bgTasks.size > 0` → skip.
2. Pending permission/elicitation: `chat.permCount > 0 || chat.elicCount > 0` → skip.
3. Wait-language in `msg.result`: last paragraph matches
   `/\b(waiting|wait for|once (it|the|this) (is |goes )?green|when (it|the) (passes|is green|goes green)|poll|checking (the )?ci|ci (status|check)|merge (once|when)|will merge|checks first|not.*merge yet)\b/i`
   → skip. Implemented as a `waitingOnExternal(text)` helper next to
   `announcedNextStep`, so it is unit-testable on its own.

`chat.nudges` counter unchanged (still max 1 per real prompt). No change to
`NUDGE_TEXT`.

### Phase 2 — context window truth (chats.js, main.js, app.js/chat.js display)

1. `leanEngineEnv`: set the env var whenever `ctx > 0 && ctx !==
   ENGINE_DEFAULT_WINDOW` (raise and lower both; skip when equal so we
   never fight the engine default). User-set env still wins (null check
   kept).
2. `modelContext` fallback chain, return first hit:
   a. models.dev as today (with date-suffix strip);
   b. provider-declared context: `provider.contextWindow` or the provider's
      live/cached model list entry (`provider.models[].context` style fields
      that `provider:listModels` already stores — exact field read confirmed
      during implementation);
   c. 0 (unchanged last resort).
3. Display fallback: `chats.context(id)` (`chats.js` ~644) merges the
   declared limit: if engine `maxTokens` is 0/missing use declared; if
   engine says 200_000 but declared differs and is > 0, report the
   **declared** value (engine was clamped; env fix applies to the next chat
   started). Renderer stays a dumb consumer — no renderer-side fallback.
4. **Trust policy (decided 2026-10-20 by Jack): raise from both sources** —
   models.dev and provider-declared limits both raise `leanEngineEnv` and
   the display merge. Accepted trade-off: a wrong-high catalog entry fails
   hard with "prompt too long" instead of auto-compacting at 200k; user can
   hand-set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (env check in `leanEngineEnv`
   already yields to user-set values).

### Phase 3 — todo lifecycle (chat.js, chats.js)

Builder-check verified: 15 real transcripts on this box contain **zero**
`<system-reminder>` todo blocks — the engine does not inject todo lists into
the stream. So the panel is empty because the model never calls the tools,
not because parsing is missing. Three layers, in order of authority:

1. **Make the model use the tools** (primary): pass an appended system
   prompt (SDK option, exact name confirmed at implementation —
   `systemPrompt` append / `appendSystemPrompt`, whichever the agent-sdk
   ^0.3.299 options accept) for every CCE session: "For any multi-step
   request, create a todo list with TodoWrite (or TaskCreate/TaskUpdate)
   before starting, update it when the user steers, mark items completed as
   they finish." This is the fix that works for *every* model/provider.
2. **Assistant-text fallback parse** (secondary): extract `- [ ] / - [x]`
   checkbox lists from **assistant message text only** (never tool results,
   file contents, or system-reminders — 6,696 literal `- [ ]` lines exist
   in tool output in one transcript). Strict shape: ≥2 consecutive checkbox
   lines. Feed `renderTodoItems`.
3. **Precedence + replay guard** (my call, per builder-check Q3):
   - `TodoWrite`/`Task*` tool state wins over parsed text; a parse only
     applies when no tool update has arrived since the message's uuid.
   - Replay (resume/fork/reconnect re-emitted turns): the existing
     `drawn` uuid dedup (chat.js:2470-2510) is the boundary — parse
     side effects run only for messages that pass that dedup as fresh.
   - A stale parsed snapshot after a newer tool update is dropped by the
     per-uuid stamp (record uuid → source at each render).
4. **Auto-clear when done**: in `renderTodoItems`, when every item is
   `completed`, show the list 1.5 s, then clear `todosList`, hide the pane,
   append sys-note `✓ todos finished`, notify the rail. Never clear while
   `chat.busy` — the delayed clear re-checks busy and re-arms.
5. **Reset on new real prompt**: in `send()` where `chat.nudges = 0` resets
   (line 321): if the list is all-completed → clear; unfinished → keep.
6. **Steer**: `pendingMsgs` already re-enters the engine; layers 1-2
   repaint the panel on the refreshed list.
7. Rail `renderTasks` keeps its current empty-state copy.

### Phase 4 — tab lifecycle (chat.js, app.js)

1. **Rekey stale-closure fix (the "can't close/can't view" bug)**: bind
   tab listeners to the chat object, not the creation-time id:
   - `closeBtn` handler → `closeChat(chat.id)`
   - `tab` click → `activateChat(chat.id)`
   - `registerTab` closure keeps `chat` and reads `chat.id`/`chat.cwd`
     lazily (registry entry itself is moved by `rekeyTab`).
   Regression test: simulate `switchProvider` rekey, assert click/close
   resolve the new id, and that events for the old id after rekey are
   ignored (existing drop path).
2. `doCompact`: `try/finally` re-enables `compactBtn`; error note on throw.
3. `doHandoff`: check `chat:send` result; on failure reset
   `chat.compacting = false` + error note (prevents the next result being
   misread as a handoff brief).
4. Handoff busy race: mark the handed-off chat `chat.handedOff = true` in
   the handoff result branch; `setBusy` becomes a no-op for handed-off
   chats so a late `status busy=true` cannot resurrect the spinner.
5. `publishTabState`: on `kind === 'exit'` and in `closeChat`, set
   `meta.busy = false; meta.needsYou = false` before deleting meta — no
   stale spinner in the tab bar.
6. Regression tests: busy clears on `exit`, after handoff, after close;
   `resumeLatest` result shows the new session as active pane.

### Phase 5 — token guidance (report only, no code)

Settings recommendations delivered in the final report, not code:

- Disconnect unused connectors (MCP preamble per session).
- Prune unused skills/agents from `~/.claude` for sessions that don't need
  them (Skills 6.3k + Agents 4.6k tokens).
- Prefer anthropic-protocol providers when possible (prompt caching);
  translated proxies do not cache.
- Keep `autoNudge` on only after Phase 1 lands (it becomes cheap).
- `contextMode: auto`, `toolSearch` on for translated providers — unchanged.

## Constraints

- Tests: vitest (`npm test`), jsdom; follow existing patterns in
  `test/renderer-chat.test.js`, `test/chats.test.js`.
- TDD: failing test first per behavior change.
- Style: match surrounding comments (dense, `// why`), no new deps.
- Git: branch → commit (Co-Authored-By line) → push (sandbox bypass) → PR
  via GitHub MCP (🤖 line) → CI → merge on Jack's word.
- Untracked dotfiles in repo root stay untracked.

## Open for the builder

What's left to the implementer: exact regexes/field names where marked
"confirmed during implementation", test case tables, and ordering inside
each phase (test first, then code).
