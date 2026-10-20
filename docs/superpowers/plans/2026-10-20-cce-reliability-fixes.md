# CCE Reliability Fixes (nudge / context / todos / tabs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five reported CCE bugs: nudge firing while the agent legitimately waits, dead/unclosable tabs after provider-switch rekey, context windows stuck at 200k, todos never appearing for any model, and CCE-specific token waste.

**Architecture:** Four independent code phases in the existing Electron app (main-process env/prompt changes in `src/main/`, lifecycle/parse changes in `src/renderer/chat.js`), each TDD'd against the existing vitest harness (`test/helpers/renderer.js` for renderer, mocked SDK for `ChatManager`). One branch, one PR, phase-per-commit.

**Tech Stack:** Electron 44, vanilla JS (CJS main, ESM renderer tests), vitest 5 + jsdom, `@anthropic-ai/claude-agent-sdk` ^0.3.299.

**Spec:** `docs/superpowers/specs/2026-10-20-cce-reliability-todos-context-tokens-design.md`

## Global Constraints

- No new dependencies.
- Never commit the stray untracked dotfiles in repo root (`.bashrc`, `.profile`, `.zshrc`, `.claude/`, `.idea/`, `.vscode/`, `.mcp.json`, `.gitconfig`, `.gitmodules`, `.ripgreprc`).
- Commit messages end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`; PR description ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Match surrounding comment style: dense `// why` comments, no docstring bloat.
- `npm test` must stay green after every task.
- Version bump to 0.9.34 happens only in Task 5 (`npm run bump`).

## Review Focus

Inputs/conditions the spec implies that most deserve a reviewer's eye — each is pinned to a task below:

1. **Nudge skip must not swallow legitimate nudges** — a result ending "Let me run the tests" with no wait context must still nudge (Task 1 test `still nudges plain next-step text`).
2. **Raise must respect a user-set env var** — `CLAUDE_CODE_MAX_CONTEXT_TOKENS` set by the user in provider env is never overwritten (Task 2 test in `chat-efficiency.test.js`).
3. **Todo parse false positives** — assistant text containing a file excerpt with `- [ ]` lines inside a fenced code block must NOT populate the drawer (Task 3 test).
4. **Rekey regressions** — provider switch must still re-key the registry (existing test) AND click/close must work after rekey (Task 4 new tests); events for the dead old id must not resurrect anything (Task 4 test).
5. **Auto-clear race** — completed todos must not clear while a turn is still running (`chat.busy`), and a stale timer must not wipe a list replaced by new items (Task 3 test).

---

### Task 1: wait-aware nudge

**Files:**
- Modify: `src/renderer/chat.js:524-539` (`maybeNudge`), add helper next to `announcedNextStep` (~line 510)
- Test: `test/renderer-modes.test.js`, inside existing `describe('stalled-turn nudge')`

**Interfaces:**
- Consumes: `chat.bgTasks` (Map), `chat.permCount`, `chat.elicCount`, `msg.result` (string), existing `announcedNextStep`.
- Produces: `waitingOnExternal(text) -> boolean` (module-local helper, used only by `maybeNudge`).

- [ ] **Step 1: Write failing tests**

Add to `describe('stalled-turn nudge')`, reusing its `result()` / `open()` / `sent()` helpers:

```js
it('does not nudge while a background task is live', async () => {
  const { h, chat, send } = await open();
  chat.bgTasks.set('t1', { id: 't1', title: 'build' });
  send(result('I will report back when the build finishes. Let me check the log:'));
  await flush();
  expect(sent(h)).toHaveLength(0);
});

it('does not nudge when the result says it is waiting for CI/merge', async () => {
  const { h, send } = await open();
  send(result('All checks are running. I will merge once the CI goes green, waiting for the pipeline now.'));
  await flush();
  expect(sent(h)).toHaveLength(0);
});

it('does not nudge while a permission prompt is open', async () => {
  const { h, chat, send } = await open();
  chat.permCount = 1;
  send(result('Running the migration. Let me apply the SQL:'));
  await flush();
  expect(sent(h)).toHaveLength(0);
});

it('still nudges plain next-step text', async () => {
  const { h, send } = await open();
  send(result('I understand now. Let me properly set it up by cloning the repo fresh.'));
  await flush();
  expect(sent(h)).toHaveLength(1);
});
```

If `open()` does not expose `chat`, adjust to `h.window.Chat.chats.get(<id>)` like sibling tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/renderer-modes.test.js -t 'stalled-turn nudge'`
Expected: the three new skip tests FAIL (nudge sent), pass-test PASSES already.

- [ ] **Step 3: Implement `waitingOnExternal(text)` and the `maybeNudge` gates**

In `src/renderer/chat.js` above `maybeNudge`:

```js
function waitingOnExternal(text) { /* last-paragraph test, returns boolean */ }
```

Regex on the last paragraph of `text` (split on `\n\s*\n`, take last non-empty):
`/\b(waiting|wait for|once (it|the|this)( is| goes)? green|when (it|the)( passes| is green| goes green)|poll|checking the ci|ci (status|checks?)|merge (once|when)|will merge|pipeline)\b/i`.
Comment: `// The agent stopped to wait for CI/merge, not because it stalled — nudging would only burn a turn.`

In `maybeNudge`, after the queued-turns check (line 528), add in order:

```js
if (chat.bgTasks.size > 0) return false;
if ((chat.permCount || 0) > 0 || (chat.elicCount || 0) > 0) return false;
if (waitingOnExternal(msg.result || '')) return false;
```

- [ ] **Step 4: Run the full nudge suite**

Run: `npx vitest run test/renderer-modes.test.js`
Expected: PASS (all pre-existing nudge tests + new ones).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/chat.js test/renderer-modes.test.js
git commit -m "fix: auto-nudge waits while background tasks, permissions, or CI/merge waits are live

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: context window truth (raise + fallback + display)

**Files:**
- Create: `src/main/modelcontext.js`
- Modify: `src/main/main.js:48,54-60` (use the new module), `src/main/chats.js:61-70` (`leanEngineEnv`), `src/main/chats.js` `context()` (~line 644)
- Test: create `test/modelcontext.test.js`; modify `test/chat-efficiency.test.js:30-35`, `test/chats.test.js`

**Interfaces:**
- Consumes: `modelsdev.model(pid, id)` (existing), provider object shape `{ presetId, model, contextWindow?, models? }`.
- Produces:
  - `modelContext(provider, model) -> number` (exported from `src/main/modelcontext.js`; `main.js` keeps calling it as `modelContext`).
  - `leanEngineEnv({ env, provider, model, settings, contextOf })` — same signature, now also raises.
  - `ChatManager#context(id) -> { totalTokens, maxTokens, percentage, declared }` (`declared` added).

- [ ] **Step 1: Write failing tests for `modelContext`**

`test/modelcontext.test.js` (vitest, `require('../src/main/modelcontext.js')`):

```js
// hits models.dev first (date-suffixed id stripped), then provider-declared context, else 0
it('returns models.dev context for a known model')            // expect > 200000 shape per seed data
it('strips -YYYY-MM-DD suffix before lookup')
it('falls back to provider.contextWindow when models.dev misses') // provider { presetId:'nope', contextWindow: 400000 } → 400000
it('falls back to provider.models[].context by model id')     // models: [{ id: 'm', context: 131072 }] → 131072
it('returns 0 when nothing knows the model')                 // → 0
```

Exact fixture ids: pick one real entry from `src/main/models-dev.seed.json` for the first two tests (inspect seed during implementation).

- [ ] **Step 2: Write failing tests for the env raise**

In `test/chat-efficiency.test.js`, replace the current big-model expectation (lines 32-33 assert `toBeUndefined()`) with:

```js
const big = leanEngineEnv({ provider: QWEN, model: 'm', contextOf: () => 1000000 });
expect(big.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
const same = leanEngineEnv({ provider: QWEN, model: 'm', contextOf: () => 200000 });
expect(same.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();  // engine default already 200k
const userSet = leanEngineEnv({ provider: QWEN, model: 'm', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '50000' }, contextOf: () => 1000000 });
expect(userSet.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('50000'); // user value wins
```

- [ ] **Step 3: Write failing test for the display merge**

In `test/chats.test.js` (fake SDK's `getContextUsage` is per-test replaceable — set `ctrl.getContextUsage.mockResolvedValue(...)` pattern or extend the fake):

```js
it('context() reports the declared limit when the engine clamped to 200k', async () => {
  // contextOf: () => 400000, engine maxTokens: 200000 → maxTokens 400000, declared 400000
});
it('context() keeps a real non-default engine limit', async () => {
  // contextOf: () => 0, engine maxTokens: 100 → maxTokens 100, declared 0
});
it('context() falls back to declared when engine reports 0', async () => {
  // contextOf: () => 131072, engine maxTokens: 0 → maxTokens 131072
});
```

Manager is constructed with `contextOf` — the test harness already passes it via `ChatManager({...})`; check existing constructor call in the test file and supply a per-test `contextOf`.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run test/modelcontext.test.js test/chat-efficiency.test.js test/chats.test.js`
Expected: FAIL (module missing / old behavior).

- [ ] **Step 5: Implement**

1. Create `src/main/modelcontext.js`:
   ```js
   const modelsdev = require('./modelsdev');
   const ENGINE_DEFAULT_WINDOW = 200_000;  // duplicated from chats.js? NO — export from here, chats.js requires it
   function modelContext(provider, model) { /* pid/strip → modelsdev; else provider.contextWindow; else provider.models find; else 0 */ }
   module.exports = { modelContext, ENGINE_DEFAULT_WINDOW };
   ```
   Note: move `ENGINE_DEFAULT_WINDOW` to this module; `chats.js` requires it from here (single source).
2. `main.js`: delete local `modelContext`, `const { modelContext } = require('./modelcontext');` — keep `new ChatManager({ proxyToken, contextOf: modelContext })` line untouched.
3. `leanEngineEnv` (chats.js:65-68): change condition to
   `if (env.CLAUDE_CODE_MAX_CONTEXT_TOKENS == null && typeof contextOf === 'function') { const ctx = Number(contextOf(provider, model)) || 0; if (ctx > 0 && ctx !== ENGINE_DEFAULT_WINDOW) out.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(ctx); }`
   (The user-set guard `== null` already exists — keep it.)
4. `ChatManager#context(id)`: after awaiting `getContextUsage()`, compute `const declared = Number(this._contextOf(provider, model)) || 0` (provider/model from the chat record, same fields `leanEngineEnv` uses); merge:
   `maxTokens: u.maxTokens || declared || 200000`, overridden to `declared` when `u.maxTokens === 200000 && declared > 0 && declared !== 200000`; include `declared` in the returned object. If the constructor does not retain `contextOf`, store it (`this._contextOf = contextOf`) — check constructor.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/modelcontext.test.js test/chat-efficiency.test.js test/chats.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/modelcontext.js src/main/main.js src/main/chats.js test/modelcontext.test.js test/chat-efficiency.test.js test/chats.test.js
git commit -m "fix: honor real context windows — env raises above 200k, provider-declared fallback, declared display

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: todo lifecycle (mandate + parse + auto-clear + reset)

**Files:**
- Modify: `src/main/chats.js:267+` (options block — `appendSystemPrompt`), `src/renderer/chat.js` (`handleMessage` text path, `renderTodoItems` ~3314, `send()` ~321)
- Test: `test/chats.test.js`, `test/renderer-features.test.js`

**Interfaces:**
- Consumes: `renderTodoItems(chat, items)` (existing, items `{content, status, activeForm?}`), `handleMessage`'s content loop + `drawn` uuid dedup (chat.js:2470-2510), `resultText(block.content)`.
- Produces: `parseTodoChecklist(text) -> Array<{content, status}> | null` (module-local; `null` when no checklist), `chat.todosCleared` timer token.

- [ ] **Step 1: Write failing test — session prompt mandate**

In `test/chats.test.js`:

```js
it('appends the todo mandate to the session system prompt', () => {
  // after creating a chat: expect(lastOptions.appendSystemPrompt).toMatch(/todo/i)
  //   and .toMatch(/TodoWrite/)
});
```

- [ ] **Step 2: Write failing tests — parse, auto-clear, reset**

In `test/renderer-features.test.js` (extend `describe('todos drawer (#5)')`; helpers `pane()`, tool-use emitter already exist):

```js
it('renders a checklist from assistant plain text', async () => {
  // assistant message, content: [{type:'text', text:'Plan:\n- [ ] read file\n- [x] edit it'}]
  // → drawer shows todos 1/2, second item done
});

it('ignores checkboxes inside fenced code blocks', async () => {
  // text: '```diff\n- [ ] not a todo\n```' → drawer stays hidden
});

it('clears the drawer 1.5s after every item completes', async () => {
  // TodoWrite all completed → vi.advanceTimersByTime(1600) → drawer hidden,
  //   sys-note /todos finished/ present; run with fake timers
});

it('does not clear while the chat is busy', async () => {
  // all completed, chat.busy = true → advance 1600 → drawer still visible
});

it('keeps unfinished todos when a new user prompt is sent', async () => {
  // list with a pending item → chat.send() → drawer still visible
});

it('clears finished todos on a new user prompt without the note', async () => {
  // all completed (before timer) → chat.send() → drawer hidden, no /todos finished/ note
});
```

Use `vi.useFakeTimers()` for the timer tests; restore after.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/chats.test.js test/renderer-features.test.js`
Expected: the new tests FAIL.

- [ ] **Step 4: Implement**

1. **Mandate** — in `chats.js` options block (right after `options.systemPrompt = {…}` at line 365):
   ```js
   // Every model/provider gets the todo discipline, not just the ones that
   // remember it: plan before multi-step work, update on steer, check off as
   // items finish. #todos-every-model
   options.appendSystemPrompt = 'For any multi-step request, before starting: create a todo list with TodoWrite (or TaskCreate/TaskUpdate if those tools are available). Update the list when the user steers the request. Mark each item completed as soon as it finishes. When all items are finished, say the list is complete.';
   ```
   (Verify at implementation that line 365's `systemPrompt` object form does not suppress `appendSystemPrompt` — sdk.d.ts:2369 says append is ignored when `systemPrompt` is a *string*; the object form is fine. If 365 only runs for some providers, set `appendSystemPrompt` unconditionally in the options literal.)
2. **Parse** — `parseTodoChecklist(text)`:
   - Strip fenced blocks: `text.replace(/```[\s\S]*?```/g, '')`.
   - Match consecutive lines `/^\s*[-*] \[( |x|X)\] (.+)$/gm` — require ≥2 matches in one run (collect runs; single stray checkbox = null).
   - Return `[{content, status: checked ? 'completed' : 'pending'}]` or `null`.
   - Call from `handleMessage` where assistant/text blocks render, **inside the fresh-message branch guarded by the `drawn` uuid dedup** (replay guard): `const items = parseTodoChecklist(text); if (items) renderTodos(chat, { todos: items });`
   - Precedence note in a comment: stream is ordered, so last writer wins; tool renders (`TodoWrite`/`Task*`) and parses simply overwrite each other — no extra stamping needed.
3. **Auto-clear** — in `renderTodoItems`, when `items.length && items.every(t => t.status === 'completed')` and `!chat.busy`:
   `clearTimeout(chat.todosCleared); chat.todosCleared = setTimeout(() => { if (chat.busy || !chat.todosList.children.length || ![...chat.todosList.children].every(li => li.classList.contains('done'))) return; chat.todosList.innerHTML=''; chat.todosEl.classList.add('hidden'); chat.msgs.appendChild(el('div','sys-note','✓ todos finished')); scrollDownSoft(chat); notify(); }, 1500);`
   When not all completed: `clearTimeout(chat.todosCleared)`.
   H4 already shows `todos n/m`; on the delayed clear also call `notify()` (rail refresh).
4. **Reset on prompt** — in `send()` next to `if (text !== NUDGE_TEXT) chat.nudges = 0;` (line 321): if the drawer has items and every `.todo-item` has class `done` → `clearTimeout(chat.todosCleared); chat.todosList.innerHTML=''; chat.todosEl.classList.add('hidden');` (no note). Unfinished lists untouched.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/chats.test.js test/renderer-features.test.js test/side-panel.test.js`
Expected: PASS (side-panel must not regress).

- [ ] **Step 6: Commit**

```bash
git add src/main/chats.js src/renderer/chat.js test/chats.test.js test/renderer-features.test.js
git commit -m "feat: todos for every model — session mandate, checklist parse, auto-clear, prompt reset

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: tab lifecycle (rekey closure + stuck-state guards)

**Files:**
- Modify: `src/renderer/chat.js:228-229` (listeners), `doCompact` (2196-2206), `doHandoff` (2209-2216), handoff result branch (2556-2572), `setBusy` (2402), `closeChat` (578-596) + `exit` handler (2395-2399)
- Test: `test/renderer-provider-switch.test.js`, `test/chat-reliability.test.js`

**Interfaces:**
- Consumes: `chat` object identity stable across rekey (only `chat.id` changes), `window.__tabs` registry, `registerTab`, `rekeyTab`.
- Produces: `chat.handedOff` (boolean flag, set in handoff result branch).

- [ ] **Step 1: Write failing tests — rekey click/close**

In `test/renderer-provider-switch.test.js` (existing `chat:set-provider` stub returns `{ok:true, id:'c2', …}` per its rekey test — reuse its ipc setup):

```js
it('tab click activates the chat after a provider switch (stale-closure fix)', async () => {
  // switch provider (existing rekey flow) → tabEl.click() →
  //   expect(chat.pane.classList.contains('active')).toBe(true)
});

it('close button removes the chat after a provider switch', async () => {
  // switch → tabEl.querySelector('.close').click() → await flush() →
  //   expect(h.window.Chat.chats.has('c2')).toBe(false) && tabEl removed from DOM
});

it('events for the pre-switch id are ignored after rekey', async () => {
  // send handleEvent message with id 'c1' after switch → no throw, no new DOM nodes in chat.pane
});
```

- [ ] **Step 2: Write failing tests — stuck-state guards**

In `test/chat-reliability.test.js` (or `renderer-lifecycle.test.js` if reliability has no result-frame helpers — check first):

```js
it('re-enables the compact button when chat:send throws', async () => {
  // ipc 'chat:send' → throw; click chat.compactBtn; await flush();
  //   expect(chat.compactBtn.disabled).toBe(false)
});

it('a failed handoff send does not hijack the next result', async () => {
  // ipc 'chat:send' → {ok:false}; send '/handoff' → then emit result frame (success, brief text) →
  //   expect no 'chat:create' call
});

it('handoff ignores a late busy status', async () => {
  // emit result with subtype success while chat.compacting → chat:create called (handoff) →
  //   emit {kind:'status', busy:true} for old id → expect chat.busy false and dot not .busy
});

it('clears tab busy state on session exit', async () => {
  // start turn (status busy true) → emit {kind:'exit'} →
  //   expect window.__tabs.get(id).busy === false
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/renderer-provider-switch.test.js test/chat-reliability.test.js`
Expected: new tests FAIL (stale closure: click/close no-ops; compact button stays disabled; etc.)

- [ ] **Step 4: Implement**

1. **Rekey closure** (chat.js:228-229): bind to the object, read id at click time:
   ```js
   closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeChat(chat.id); });
   tab.addEventListener('click', () => activateChat(chat.id));
   ```
   (`chat` is in scope — it's built above line 228; verify the binding order, the chat object literal ends ~line 203.) Also `registerTab(id, {…})` at 233: keep as-is (registry entry is moved by `rekeyTab`); but change its `cwd: chat.cwd` to stay valid — it already reads the object.
2. **`doCompact`**: wrap the `ccx.invoke` in `try/finally`; move `chat.compactBtn.disabled = false` into `finally`.
3. **`doHandoff`**: `const r = await ccx.invoke('chat:send', …); if (!r || !r.ok) { chat.compacting = false; appendError(chat, 'Could not hand off: ' + ((r && r.error) || 'session not running')); }`
4. **Handoff busy race**: in the `chat.compacting` success branch (after `createSession(...)`), set `chat.handedOff = true`. In `setBusy`, first line: `if (chat.handedOff && busy) return;` (comment: `// Late status frames from the dead engine must not resurrect a handed-off tab.`)
5. **Meta clear**: in `closeChat` before `window.__tabs.delete(id)`, and in the `exit` handler before/after `setBusy(chat, false)`: if `const m = window.__tabs && window.__tabs.get(id)` → `m.busy = false; m.needsYou = false;` then `updateNavState()` if available. (In `exit`, meta stays — just clear flags.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/renderer-provider-switch.test.js test/chat-reliability.test.js test/renderer-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/chat.js test/renderer-provider-switch.test.js test/chat-reliability.test.js
git commit -m "fix: dead tabs after provider switch, compact/handoff stuck states, stale busy spinners

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: version bump + full suite + git ops

**Files:**
- Modify: `package.json` (version only), `package-lock.json` (via bump)

**Interfaces:** none (release hygiene).

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: all files PASS. Fix any cross-task fallout before proceeding (a failure here blocks the PR).

- [ ] **Step 2: Lint**

Run: `npm run lint` (if the script exists; skip silently otherwise — check `package.json` scripts: `start/test/dist/lint/bump` — lint exists).
Expected: clean.

- [ ] **Step 3: Bump version**

Run: `npm run bump` → 0.9.33 → 0.9.34.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: 0.9.34

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 5: Push + PR (git ops, sandbox bypassed for push)**

Branch `fix/reliability-todos-context`. Push with `dangerouslyDisableSandbox: true` (sandbox cannot read GitHub login). Open PR via GitHub MCP against `main`, title `fix: wait-aware nudge, real context windows, todos for every model, dead-tab lifecycle (0.9.34)`, body covering the five fixes with the spec link, ending with the 🤖 attribution line. Check CI, report status. Do NOT merge until Jack says so.

---

## Self-review notes (already run)

- Spec coverage: Phase 1→Task 1, Phase 2→Task 2, Phase 3→Task 3, Phase 4→Task 4, Phase 5 (token report) is intentionally not a code task — delivered in the final chat report after merge.
- Types/names consistent: `waitingOnExternal`, `modelContext`, `ENGINE_DEFAULT_WINDOW` (single home: `modelcontext.js`), `appendSystemPrompt`, `parseTodoChecklist`, `chat.handedOff`, `chat.todosCleared`.
- Review Focus pins: 1→Task 1, 2→Task 2, 3→Task 3, 4→Task 4, 5→Task 3.
