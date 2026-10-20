# Multi-window, streaming tool output and shell-output filtering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three open roadmap items: multiple app windows that each own their own chats and terminals, live shell output inside tool cards, and a compacted shell result for the model while the card keeps the full text.

**Architecture:** The chat and session managers stay global — their ids come from one counter each, so a second manager would mint the same ids and two windows would fight over one chat. Window ownership lives in a new `WindowRegistry` keyed by `webContents.id`: every session and chat is claimed by the window that created it, main→renderer pushes route to the owner, and a window that closes takes its sessions and chats with it. Live shell output rides the engine's own `get_task_output` control request (last 8 KiB tail), polled while a `local_bash` task runs. Output filtering is a `PostToolUse` SDK hook: the hook returns `updatedToolOutput` (the compacted text the model reads) and separately ships the original text to the renderer as a `tool-original` event, so the card still shows everything.

**Tech Stack:** Electron 44, plain CommonJS, `@anthropic-ai/claude-agent-sdk` 0.3.x, node-pty, vitest (node + jsdom).

**Spec:** the roadmap section of `README.md` and the design notes in this document.

## Global Constraints

- The managers (`chats`, `sessions`) stay **global**. Per-window manager instances would mint colliding ids (`s1`, `c1`).
- The renderer never gains a generic `invoke`; every new IPC channel is added to `src/preload/preload.js` `INVOKE_CHANNELS` **and** registered in `src/main/main.js`. `test/security.test.js` fails the build on drift.
- The engine is never patched. Everything goes through the SDK's own surfaces (`options.hooks`, `Query.getTaskOutput`).
- The compaction is **display-transparent**: the model reads the compacted text, the card shows the original.
- `outputFilter` defaults to `'on'`, `outputFilterMaxChars` to `8000` (clamped to 500…100000).
- The main process keeps working with the electron test stub: `require('electron')` resolves to `test/stubs/electron.js`, whose `BrowserWindow` and `webContents` are inert.

## Review Focus

Five inputs the spec implies but no happy-path test exercises:

1. **A window is closed while a chat is running.** The engine process must be torn down, and the chat's later frames must not be delivered to a dead window or to another window.
2. **A second window asks for a chat it does not own** (e.g. `chat:close` on another window's id). The call must be refused, not silently mutate the other window's session.
3. **A shell command whose output is huge and repetitive** (a build log). The compaction must keep a usable head and tail and must not grow past the budget.
4. **A `tool-output` frame that arrives before its tool card** (out-of-order frames). The live text must be buffered and applied when the card appears, not dropped.
5. **The engine refuses `get_task_output`** for a task that is not a shell task. The poll must fail soft — no unhandled rejection, no busy loop.

---

### Task 1: Window ownership registry

**Files:**
- Create: `src/main/windows.js`
- Test: `test/windows.test.js`

**Interfaces:**
- Produces: `class WindowRegistry` with `add(win) -> id`, `remove(id)`, `entry(id)`, `winOf(id)`, `windows()`, `size`, `claim(id, kind, itemId) -> boolean`, `release(kind, itemId)`, `ownerOf(kind, itemId) -> id|null`, `itemsOf(id, kind) -> string[]`; and `route(registry, kind, itemId, fallback) -> win|null`.

- [ ] **Step 1: Write the failing test** — `test/windows.test.js`: two fake windows; an item claimed by window A routes to A and never to B; `route` returns `null` once the owner is destroyed; `release` frees the claim; `ownerOf` returns `null` for an unknown item.
- [ ] **Step 2: Run it to verify it fails** — `npx vitest run test/windows.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement `src/main/windows.js`** — a `Map` of `webContents.id -> { win, chats:Set, sessions:Set }`.
- [ ] **Step 4: Run it to verify it passes.**
- [ ] **Step 5: Commit** — `git add src/main/windows.js test/windows.test.js && git commit -m "feat: window ownership registry"`.

### Task 2: Shell-output compaction

**Files:**
- Create: `src/main/toolfilter.js`
- Test: `test/toolfilter.test.js`

**Interfaces:**
- Produces: `compactBashOutput({ output, command, maxChars }) -> { text, original, compacted }`, `collapseRepeats(text) -> string`, `toolResultText(content) -> string`, `DEFAULT_MAX_CHARS = 8000`.

- [ ] **Step 1: Write the failing test** — short output is untouched; a long output keeps head + tail with an elision marker stating the dropped size; a run of identical lines collapses to one line plus a count; the text stays inside the budget; text is read out of a string, a block array and a `{stdout, stderr}` object.
- [ ] **Step 2: Run it to verify it fails.**
- [ ] **Step 3: Implement `src/main/toolfilter.js`.**
- [ ] **Step 4: Run it to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat: compact shell output for the model"`.

### Task 3: Multi-window in the main process

**Files:**
- Modify: `src/main/main.js`
- Modify: `test/stubs/electron.js` (give `webContents` an `id`)
- Test: `test/multiwindow.test.js`

**Interfaces:**
- Consumes: `WindowRegistry`, `route` from Task 1.
- Produces: IPC channel `window:new` → `{ id, count }`; `handle()` now calls `fn(payload, event)`; `senderWindowId(event) -> number|null`.

- [ ] **Step 1: Write the failing test** — `window:new` creates a second window; a session created by window A is listed for A and not for B; `pty:data` reaches only the owner; `chat:event` reaches only the owner; a foreign `chat:close` is refused.
- [ ] **Step 2: Run it to verify it fails.**
- [ ] **Step 3: Implement** — `createWindow()` returns the window and registers it; every `win.` inside it becomes the local `w`; `chats.on('event')` and `sessions.on('data'|'exit')` route through `route()`; a closed window kills its sessions and chats; `second-instance` opens a new window.
- [ ] **Step 4: Run it to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat: multi-window — each window owns its chats and terminals"`.

### Task 4: Live shell output and the filtering hook

**Files:**
- Modify: `src/main/chats.js`
- Test: `test/chats-tooloutput.test.js`

**Interfaces:**
- Consumes: `compactBashOutput` from Task 2.
- Produces: new event kinds `tool-output` (`{ kind, toolUseId, text, done }`) and `tool-original` (`{ kind, toolUseId, text }`); `options.hooks.PostToolUse` installed when the filter is on.

- [ ] **Step 1: Write the failing test** — the `PostToolUse` hook is installed when `outputFilter` is on and absent when off; the hook returns `updatedToolOutput` with the compacted text and emits `tool-original` with the original; a `task_started` frame with a `tool_use_id` starts polling `q.getTaskOutput` and emits `tool-output`; a refused `get_task_output` fails soft.
- [ ] **Step 2: Run it to verify it fails.**
- [ ] **Step 3: Implement** — the hook in `create()`, `_followTask(id, chat, task_id, toolUseId)` with a 700 ms poll, stopped by `task_notification` / `task_updated` / chat close.
- [ ] **Step 4: Run it to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat: live shell output in tool cards, compacted for the model"`.

### Task 5: Renderer, preload and settings

**Files:**
- Modify: `src/renderer/chat.js`, `src/renderer/app.js`, `src/renderer/index.html`, `src/preload/preload.js`, `src/main/store.js`
- Test: `test/renderer-tool-output.test.js`, `test/renderer-newwindow.test.js`

**Interfaces:**
- Consumes: the `tool-output` and `tool-original` event kinds from Task 4, the `window:new` channel from Task 3.
- Produces: renderer handles `tool-output` (writes the live tail, expands the card) and `tool-original` (the card shows the original text); a `⧉ window` tabbar button plus `Ctrl+Shift+N`; a Settings row for the output filter.

- [ ] **Step 1: Write the failing renderer tests.**
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement** the renderer, the preload allowlist entry and the store defaults.
- [ ] **Step 4: Run the whole suite** — `npm test` → all green.
- [ ] **Step 5: Commit** — `git commit -m "feat: renderer for multi-window, live output and the filter"`.

### Task 6: Docs and release

**Files:**
- Modify: `README.md` (roadmap tick boxes, a "Windows" line in the keyboard/feature sections)

- [ ] **Step 1: Tick the three roadmap items** and describe the new shortcut.
- [ ] **Step 2: Run `npm test`** → green.
- [ ] **Step 3: Commit, push, open the PR, watch CI, merge, pull `main`.**
