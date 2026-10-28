# Chat upgrade roadmap: preview, queue control, workflows (Freebuff parity)

Status: proposal, nothing built yet. Target versions 0.9.90 to 0.9.94.

## What already exists (do not rebuild)

| Area | Today | File |
|---|---|---|
| Slash menu | `/` at start of the composer, up to 24 items, name + one-line description, starts-with then contains match | `src/renderer/chat/slash.js` |
| `@` mentions | file reference picker, no preview | `src/renderer/chat/composer.js` (`maybeAt`, `applyAt`) |
| Queue | chips above the composer, text only, remove (×) only, text survives a crash, images do not | `composer.js` (`renderQueued`, `persistPending`) |
| Busy mode | Queue vs Steer toggle, Ctrl+Enter flips one message | `session.js`, `status.js` |
| Workflows | 18 hard-coded prompt templates in a picker | `src/renderer/chat/workflows.js` |
| Message rail | right-edge request markers with tooltip | `transcript.js` (`setupRequestRail`) |
| Code blocks | Copy button | `markdown.js` (`addCopyBtn`) |
| Model + effort | model picker and a separate effort select | `picker.js` |
| Sidebar | conversations grouped by folder, pins, collapse, open tabs | `src/renderer/app/conversations.js` |
| Background jobs | job queue in main | `src/main/jobqueue.js` |

## Gaps seen in the Freebuff screenshot

1. The slash menu is a long, scrollable list that mixes skills, commands and workflows. Hover moves the selection. There is room for a preview of the selected item.
2. The composer has an execution target chip (`Local`) next to a combined model and tier chip (`DeepSeek V4.1 Flash Fast · Max`).
3. Workflows have more control. CCE keeps them in its own workflow picker (not in the `/` menu) and adds options there.
4. Code blocks have a header with the language label and Copy.

---

## Phase 1: Command menu with preview (0.9.90)

Goal: `/` and `@` menus that show what an item does before you run it.

1.1 Preview pane
- Split `.chat-slash` into a list (left) and a preview (right). Below 700 px wide, show the preview under the list.
- The preview shows: full name, argument hint, source badge, file path, full description, and the first 30 lines of the command body (SKILL.md or command .md, frontmatter removed).
- New IPC `chat:command-detail { id, name }` in `src/main/main.js`. Resolve the path only from the session's known command list. Read only files under skill, plugin, command and project `.claude` folders. Cap reads at 64 KB.
- Cache details per chat in a `Map`. Debounce preview loads by 80 ms while the user scrolls with the arrow keys.
- Test: detail IPC refuses a path outside the allowed roots; preview renders text with `textContent`, never `innerHTML`.

1.2 Groups and source badges
- Sections in this order: Recent, Built-in (`OWN_SLASH`), Project commands, Skills, Plugins, MCP prompts. Workflows stay out of this menu (see Phase 3).
- Badge per item (`cce`, `skill`, `plugin:<name>`, `project`, `mcp:<server>`).
- Section headers are not selectable. Arrow keys skip them.

1.3 Better matching and no 24-item cap
- Fuzzy match on name and description. Score: prefix > word start > substring > description hit. Highlight matched characters.
- Remove `.slice(0, 24)`. Render only visible rows (simple windowing, row height fixed) so 500+ skills stay fast.
- Test: perf budget, 1,000 commands filter + render under 16 ms in jsdom.

1.4 Recently used ranking
- Store the last 20 commands run per project in `localStorage` key `cce.slashRecent.<cwdHash>`.
- With an empty query, show Recent first. With a query, add a small score boost for recent items.

1.5 Keyboard and mouse
- Tab completes the selected name. Enter completes and, for commands without an argument hint, sends.
- PageUp/PageDown, Home/End, Escape. Mouse hover moves the selection, as in Freebuff.
- Accessibility: `role="listbox"`, `role="option"`, `aria-activedescendant` on the composer.

1.6 Slash anywhere
- Open the menu when `/` follows whitespace or a line start, not only at position 0. Replace only the current token on apply.

1.7 Argument ghost text
- After a command with `argumentHint` is applied, show the hint as grey placeholder text after the cursor until the user types.

1.8 `@` mention preview
- Reuse the same preview pane for `@`. Files: first 40 lines with syntax colours. Folders: first 30 entries. Images: thumbnail.
- Add `@` kinds: open chats (insert a summary link), URLs (fetch on send), and git refs (`@diff`, `@staged`, `@branch`).

---

## Phase 2: Queue control (0.9.91)

Goal: the queue becomes a real, editable work list instead of read-only chips.

2.1 Queue panel
- Replace chips with a collapsible panel above the composer: index, full text (2 lines, expand on click), image count, queued time, per-item mode badge.
- Header: `Queue (3)` with Pause, Clear and Collapse buttons.

2.2 Edit in place
- Click text to edit inline. Enter saves, Escape cancels. Up-arrow in an empty composer opens the last queued item for editing.

2.3 Reorder
- Drag and drop with a handle. Keyboard: Alt+Up / Alt+Down on the focused item.
- Test: order in `chat.pendingMsgs` matches the DOM after each move and after a reload.

2.4 Per-item actions (menu on each row)
- Send now as steer, Run next (move to top), Duplicate, Move back to composer, Remove.

2.5 Queue-wide control
- Pause: the turn ends and the queue holds. A banner shows `Queue paused · Resume`.
- Clear all with an Undo toast (5 s).
- Auto-pause rules, each a toggle in Settings: pause when a turn ends with an error, when a permission prompt is waiting, when the spend guard (`spendguard.js`) warns, or when the last tool call was a failed test run.

2.6 Keep images with queued items
- Today `persistPending` saves text only. Save queued images through the same 0600 draft-image files used for unsent drafts. Restore them on reload. Delete files when the item runs or is removed.

2.7 Per-item options
- Optional overrides per item: permission mode, model, effort. Shown as small chips on the row.
- "Ask before running" flag: the queue stops on this item and shows Run / Skip.
- "Run at" time: hold the item until a set time (uses the existing job queue timer in main).

2.8 Signals
- Queue count badge on the chat tab and the sidebar row.
- Desktop notification when the queue drains or pauses itself (respect the existing notification setting).

2.9 Cross-chat queue view
- A `Queues` section in the Board view lists every chat with queued items, with Pause / Resume / Open for each.

---

## Phase 3: More options on the existing workflow picker (0.9.92)

Goal: keep the current workflow button and menu (`src/renderer/chat/workflows.js`: 18 workflows, 5 coloured groups). Do not add workflows to the `/` menu. Add options so each run can be controlled.

How it works today (the base for every task below):
- Click an item and `runWorkflow()` replaces the composer text with the prompt.
- `fill: true` items wait for your words. The others send at once.
- The mode changes only to enter or leave `plan`, and it stays changed after the run.
- No per-run settings. Nothing is remembered.

Option storage (used by 3.2 to 3.8):
- One object per workflow: `{ run, mode, model, effort, scope, extra, readOnly, restoreMode, then }`.
- Merge order: built-in default, then global saved options, then project saved options, then this run only.
- Saved with the existing `lsGet` / `lsSet` helpers. Keys: `cce.wfOpts` (global) and `cce.wfOpts.<cwdHash>` (project).
- Put the pure parts (merge options, build the final prompt) in a new `src/renderer/chat/wfoptions.js` with no DOM, so tests are simple.

3.1 Keep the draft (fix first)
- Today a workflow overwrites any text in the composer, so a half-typed message is lost.
- New rule: if the composer has text, a `fill` workflow uses that text as its task (prompt + draft). A run-now workflow asks: Replace / Use as extra notes / Cancel.
- Test: draft text is never silently dropped.

3.2 Options popover per workflow
- Open it from a `⋯` button on each row, a right-click, or the Right arrow key on the focused row.
- Fields:
  - Run: Wait for my words / Run now / Add to queue.
  - Permission mode: Keep current / Plan / Accept edits / Auto.
  - Model and effort: Keep current, or pick one for this run only (for example a stronger model for Code review).
  - Scope: Whole repo / Current diff / Staged changes / Chosen files or folder. Adds one scope line to the prompt.
  - Extra instructions: free text added to the end of the prompt (for example "use vitest" or "explain for a beginner").
  - Read-only: forces Plan mode and adds "Do not change files". Default on for Security review and Explain repo.
  - Restore mode after run: on by default, so a plan workflow no longer leaves the chat stuck in Plan mode.
- Buttons: Run once with these / Save as default for this project / Save as default everywhere / Reset.
- Rows with saved options show a small dot. The hover text lists what is changed.

3.3 Prompt preview and edit
- The popover shows the final prompt after scope, extra instructions and draft are applied (read-only text, `textContent` only).
- "Edit prompt" opens the text for editing and saves an override per project. "Reset to default" removes it.
- Edited workflows show an "edited" mark in the menu.

3.4 Busy-aware run
- If the chat is busy, Run now puts the workflow in the queue (`chat.pendingMsgs`) instead of changing the composer. A toast says "Queued: Code review".
- With Phase 2, queued workflows show their name and option chips in the queue panel.

3.5 Follow-up chain ("Then run")
- In the popover, choose up to 4 workflows to run after this one, for example Build feature, then Test & fix, then Code review, then Commit & PR draft.
- Each follow-up goes in the queue when the previous turn ends.
- Gate per follow-up: Auto (only if the turn ended without error) or Ask first (stops with Run / Skip).
- Ready-made chains at the top of the menu: "Feature: map, plan, build, test, review" and "Bug: bugfix, test & fix, commit".
- Stopping the chat or clearing the queue cancels the rest of the chain.
- Needs the Phase 2 queue for pause and ask-first. Without Phase 2, Auto still works with the current queue.

3.6 Finding workflows faster
- Filter box at the top of the menu. Type to filter by name and hint.
- Pinned group at the top (pin from the popover).
- Recent group: the last 3 workflows run in this project.
- Number keys 1 to 9 run the first 9 visible items.
- Hide workflows you never use (Settings, "Workflows" list with checkboxes).

3.7 Custom workflows inside the same menu
- "+ New workflow" at the bottom of the menu, or "Duplicate" in any popover.
- Fields: name, group (one of the 5 existing groups), icon, hint, prompt, and the options from 3.2.
- Saved per project or for all projects. Shown in their group with a "custom" mark. Edit and delete from the popover.
- Export and import custom workflows as one JSON file (Settings).

3.8 New built-in workflows in the existing groups
- Plan: `upgrade-plan`, audit an area and write a phased task list (like this document).
- Verify: `derisk`, risk of merging and deploying the current diff, with mitigations. Read-only.
- Verify: `verify-live`, confirm a change works in the running app and report evidence. Read-only.
- Ship: `release`, bump version, update CHANGELOG, build the `.deb`, report install commands.

3.9 Run history
- Per workflow: run count, last run, and the end state (finished / stopped / error).
- Shown as the last line of the popover. Kept locally, last 50 runs.

Tests for Phase 3 (written first):
- Option merge order and Reset.
- Final prompt with scope, extra instructions and draft text.
- A draft is never lost. Busy chat queues instead of overwriting.
- Read-only forces Plan. The mode comes back after the run.
- A chain stops on error with Auto and waits with Ask first. Stop cancels the chain.
- Custom workflow save, edit, delete, export, import (bad JSON shows an error and does not crash).
- Filter, pins, recent, number keys.

---

## Phase 4: Composer and transcript polish (0.9.93)

4.1 Execution target chip
- Chip next to the model chip: `Local`, a saved SSH host (`src/main/sshhosts.js`), or a new git worktree.
- Changing it on a busy chat asks first. The target is saved per chat.

4.2 Combined model chip
- Merge model and effort into one chip with one popover (two columns), shown as `<model> · <effort>`. Keep the current effort select logic in `picker.js`.

4.3 Code block header
- Language label left, Copy right (move the existing button into the header).
- Extra actions: wrap toggle, save as file, and for `bash`/`sh` blocks "Send to terminal" (pastes, does not run).

4.4 Rail preview
- On hover over a rail marker, show the first 3 lines of that request and the reply status (done, error, still running).

---

## Phase 5: Quality and release (each phase, then 0.9.94 wrap-up)

5.1 Tests first for every task (vitest, `env -u CLAUDE_CODE_MAX_CONTEXT_TOKENS vitest run`). One test file per phase, like `test/phase1-upgrades-0986.test.js`.
5.2 Performance budgets: slash menu with 1,000 items, queue with 50 items, workflow menu with 100 custom workflows.
5.3 Security: the command-detail loader reads only allowed roots; previews never use `innerHTML` with file content; imported custom workflows are data only and never run code.
5.4 i18n: every new string goes through `src/renderer/i18n.js`.
5.5 Docs: README section per feature, CHANGELOG entry per version.
5.6 Release per phase: version bump, `.deb` build, PR, CI green, merge.

## Suggested order

Phase 1 and Phase 2 do not depend on each other. Phase 3 does not need Phase 1. Most of Phase 3 can ship alone. Only Pause and Ask first in the 3.5 chains need the Phase 2 queue. Phase 4 is independent.

---

## Status: built in 0.9.90

Built as planned, with these differences (decided while building):

- Phase 1: sections are Recent, Built-in, Project & user, Plugins, MCP (the engine does not say whether a command is a skill or a command). Enter completes the name and never sends. `@` previews cover files and folders; image thumbnails and the `@` kinds for open chats and URLs are not built. `@diff`, `@staged`, `@branch` are.
- Phase 2: model, effort and permission mode per queue item are in the data and applied when the item runs, but the row menu has no editor for model and effort yet (workflows set them). The cross-chat queue view on the Board (2.9) is not built.
- Phase 3: no presets, no workflow files, no `/` entries (as asked). Added instead: "Your command" box in the menu, Shift+click to fill the box, custom workflows with JSON export/import (clipboard and paste).
- Phase 4: the target chip offers Local and Worktree. SSH hosts open terminals only; chats cannot run over SSH, so they are not offered. The effort select stays; the model chip also shows the effort. Code blocks have Wrap and Save (no "send to terminal").
- Extra: Lanox provider preset.
- Strings are English only; they are not in the translation dictionary yet.
