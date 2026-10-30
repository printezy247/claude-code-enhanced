# Change Log

All notable changes to Claude Code Enhanced are documented here.











## 0.21.0

- Sessions card in the Overview (replaces the popout-windows idea): lists the open chats with what each is doing (needs you, working, idle). Click a row to switch. Hidden with only one chat; at most 8 rows.
- It redraws only when a chat's state changes (no timer, no extra calls), and only that card is replaced.

## 0.20.0

- Dictation: a mic button next to Attach records up to 60 s and puts the text in the message box. Speech to text runs on this computer only (faster-whisper in a virtualenv, model read from disk, network off); audio is never sent anywhere and the temp file is removed straight away.
- Setup (once): `python3 -m venv ~/.local/share/cce-dictation`, then `~/.local/share/cce-dictation/bin/pip install faster-whisper`, then `~/.local/share/cce-dictation/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('base.en')"` (downloads the model once).
- The window may now use the microphone (audio only, our own window); every other permission is still refused.

## 0.19.1

- Environment card shows one compact line (status, model, branch, changes), also when the card is folded.
- Workflow menu speed limits are now tested with 100 custom workflows (filter, build, export, import).
- Left as is on purpose: Overview cards still compare rendered HTML, which already leaves the page untouched when nothing changed.

## 0.19.0
- Added: **Artifacts**. A Keep button on every reply and code block saves it (the same text is stored once). The new Artifacts tab in the side pane (Alt+7) lists them, shows markdown as sanitized text and code as plain text, deletes them, and exports a PDF through a window that can run no script and make no network request.
- Added: **Side chat**. A "side chat" button on any of your messages opens a small card, branched from that turn in its own read-only session. Ask several follow-ups; nothing from it reaches the main thread. Closing the card or the chat ends the session.
- Added: `/btw <question>` asks one side question while a turn is running; the answer arrives as its own card.
- Added: **Scheduled prompts** on the Board: `every 30m` (5 minutes or more), `hourly` or `daily 09:00`, with Run now, on/off, delete and the last five results. They run while CCE is open, in a read-only side session, so no step can wait for an approval nobody is there to give.
- Added: variants. When you edit and re-ask a message, the new prompt is remembered under the old one (`↳ N variants`) and can be reopened after a restart.
- Changed: side sessions deny any permission or connector question automatically, and any left open when the window closes are closed.
- Checked, no change needed: the host-owned connector broker (with the per-tool permission policy), interrupted-run recovery on the Board, and pasted images kept out of localStorage (now pinned by a test).
- Not built, on purpose: dictation. The browser speech feature sends audio to an outside service, which breaks the rule that audio stays local, so it needs a local speech engine first.

## 0.18.0
- Added: `@https://…` in the message box offers the web address as a mention. It is sent as plain text and the engine fetches it if it needs to. Addresses with a password, other schemes (`javascript:`, `data:`) and spaces are not offered.
- Added: when a message is refused (quota, auth, session gone), the error shows the engine's own reason, keeps your text and images, and has a **Send again** button. Works the same for Claude, Codex and OpenCode chats.
- Checked, no change needed: the provider-switch notice appears once per switch.

## 0.17.0
- Added: per-chat output style (Default, Explanatory, Learning) in the chat's `⋯` menu, sent to the engine and remembered per folder.
- Added: per-chat environment variables (`⋯` menu > Environment variables). They go to the engine for that chat only; only the names are remembered, values stay in memory and are never shown back or logged. Variables that would change how the engine itself starts (PATH, LD_*, NODE_OPTIONS and similar) are refused.
- Changed: `panels.js` and `events.js` are split into smaller modules (memory, palette, skills, MCP, history, plan and find, options; background tasks and hooks). Same behaviour.
- Fixed: Settings no longer throws when its SSH or agent lists answer after the view is gone.
- Tested: a 2400-tool-card transcript keeps the page small, and the renderer's three timers are pinned so a new poll has to be added on purpose.
- Checked, no change needed: per-channel IPC size limits (1 MB default, images allowed more), pasted images kept out of localStorage, and the worktree chip already remembers its target per chat.

## 0.16.0
- Added: click the context ring in the chat footbar for a small popover (usage, a bar per category, Compact now, Toggle Overview). Shift+click still compacts at once.
- Added: a new chat shows four quick pills (Review changes, Run tests, Explain repo, Workflows) instead of a paragraph.
- Added: Edit/Write tool cards get a "diff" button that opens that file in Review; a failed Bash card gets "fix in chat", which puts the command in the message box.
- Added: Skills, MCP, Memory, Rewind and History panels share a tab bar, so one click switches between them.
- Changed: the sidebar navigation is a compact icon dock (hover for the name); explanatory banners on Usage, Board and Connectors hide behind a `?` button.
- Changed: Connectors and Settings draw themselves the first time you open them; collapsed sidebar folders build no rows until opened.
- Checked, no change needed: streaming text is already drawn once per animation frame, and the sidebar already has a filter toggle.

## 0.15.0
- Added: `Ctrl+1`…`Ctrl+9` jump to a tab (9 is the last), `Alt+1`…`Alt+6` open Changes, Files, Terminal, Diff, Review or Preview in the side pane, and `Ctrl+Tab` now cycles in most-recently-used order.
- Added: `Ctrl+K` opens the command palette from every view. Type `>` for commands, `@` to add a file to the message, `#` for conversations, `:` for models.
- Added: the Board's live chat rows have quick buttons: Jump, Compact (from 65% context), Stop while busy, Allow and Deny when a permission waits.
- Added: clicking a file in the Overview's Changes card opens it in the Review pane; Shift+click adds `@file` to the message; Alt+click shows it in the folder.
- Added: the request rail on the chat's right edge is always visible, and its ticks are coloured: red for a failed tool, orange for a waiting permission, green for edited files.
- Changed: the Overview makes no git, context or connector calls while another view is open, the Overview is hidden or the window is in the background; it refreshes when you come back.
- Changed: flatter Overview cards (no heavy shadow), system notes are small pills, long conversation lists skip off-screen rows, shorter message placeholder.

## 0.14.0
- Added: model routing (Settings, off by default): in chats with no model chosen, small tasks go to Haiku, medium to Sonnet, big ones to Opus, for that message only.
- Added: `/loop <times> <prompt>` runs a prompt several times in a row (Stop ends it, an error ends it). `/goal <text>` keeps a goal banner above the chat until `/goal clear`; it is remembered per folder.
- Added: a quarantine triage skill template in `docs/templates/quarantine-triage`: a read-only reader looks first, a person confirms, only then an agent that can write acts.
- Changed: when a provider's model list cannot be asked (key refused, no list), CCE now keeps a plain-words reason instead of failing silently.
- Tested: tool-call streams from OpenAI, Kimi, GLM, Qwen and OpenRouter-Anthropic shapes (no code change needed) and speed budgets for the slash menu and the queue.

## 0.13.6
- Added: the Context card in the Overview tells you when the window is filling up ("compact soon" from 75%, "compact now" from 90%) and shows how many tokens came from the prompt cache.
- Added: a chat is named by the CLI's own session title after its first turn (once). A name you typed yourself is never replaced.
- Checked, no change needed: per-model temperature and top_p defaults, OpenRouter prompt caching and per-message model and effort in the queue were already in place.

## 0.13.5
- Changed: auto mode's shell check is now pinned by tests for every hidden-command trick (`;`, `&&`, `||`, `|`, `$(...)`, backticks, redirects, subshells, newlines, unclosed quotes). It already refused them; chains of plainly read-only commands are still approved.
- Fixed: the 0.9.95 entry was in this file twice.
## 0.13.4
- Fixed: the OpenCode model picker and effort picker stayed empty. A just-started `opencode serve` lists no models for a few seconds while it reads the logins, and CCE asked once and kept the empty answer. It now asks again for up to 15 s and never keeps an empty list.
- New: the OpenCode model picker lists the models of every provider your OpenCode login connects, one section per provider, with OpenCode Go and OpenCode (Zen) first. Disabled and deprecated models are left out. "CLI default" names the model it stands for, and the caption (context, images, tools, reasoning) comes from OpenCode instead of "no catalog entry". Effort lists the chosen model's own levels.
## 0.13.3
- New: **OpenCode chats get the full footbar.** Mode picks OpenCode's agent (build, plan, or build with YOLO) and can change mid-chat. Effort lists the current model's variants and sets one on the session. The context ring shows the last step's tokens against the model's window, and Compact (or `/compact`) summarizes the session in place. The model picker lists every enabled model as `provider/model` with its name.
- Fixed: an OpenCode chat on a chosen model failed every message, because the model was sent in the v2 prompt body, which the server refuses. The model (and variant) now goes on the session.
- Changed: YOLO in OpenCode answers approvals in CCE instead of in the server config, so switching to or from YOLO takes effect on the next request.
## 0.13.2
- New: **OpenCode v2 CLI Chat integration.** Full compatibility with `opencode serve` v2.0+ and SDK contract (`/api/session`, `/api/event`, `/api/session/:id/prompt`, `/api/session/:id/interrupt`, `/api/session/:id/permission/:id/reply`, `/api/model`, `/api/session/:id/model`), streaming event normalization (`session.text.*`, `session.reasoning.*`, `session.tool.*`, `permission.asked`), permission rules (`permissions` v2 and `permission` v1), and seamless fallback to v1 serve routes.
- New: **Engine footbar controls** for OpenCode, Codex, and Antigravity. Model selection and switching via runner APIs, capabilities-driven footbar visibility, and effort/mode controls.
- Fixed: `.desktop` validation in lint suite when `desktop-file-validate` is present.
## 0.13.1
- Changed: engine chats are driven by the engine registry. Each engine in `engines.js` now says which runner it uses and whether it takes images, asks before acting, and can run on a CCE provider; the chat view, the New session dialog (CLI list and model hints) and `createEngine` read that instead of checking engine names, so a new engine is one registry entry. The Codex, OpenCode and Antigravity runners share one process-stop helper (SIGTERM to the group, then SIGKILL), one stderr tail, one text flattener and one stand-in query object (`src/main/procutil.js`), and OpenCode tool names reuse the shared alias table.
- Changed: a tool result shown in an engine chat is cut to its first and last 20,000 characters with a note of what was left out, so one `cat` of a big file or build log cannot flood the chat.
- Changed: the "finished" notification names the chat's CLI from the chat itself, and the Antigravity translator is flatter. No other behavior changes.
## 0.13.0
- New: **chats on another machine over SSH.** The target chip in a chat lists your saved SSH hosts next to Local and New worktree; pick one, give the folder on that machine, and Claude Code runs there (`ssh -T host 'cd <folder> && exec claude …'`) while the conversation, approvals, interrupts and the connector broker work as usual. The remote runs with its own login, settings and connectors. This computer's providers, API keys, proxy, sandbox, plugins and local connectors are not sent or used, the folder name and every flag are shell-quoted so they cannot add a command, and ssh never asks for a password (key or agent login only). The Changes and Overview panels and local transcripts only cover this computer's folders. Needs `claude` installed and logged in on the remote.
- Fixed: the worktree and sandbox chips in a chat header disappeared as soon as the project's git info loaded, because the redraw cleared the row. They stay now.
- New: `npm run lint` skips lintian when the .deb's payload is identical to the last clean run (a fingerprint of every file except the `.desktop` entry; control metadata is not part of it), and still validates the `.desktop` entry every time. `LINT_FORCE=1` runs it anyway. lintian's own exit status is now reported (it was never checked); `LINT_STRICT=1` makes it fail the script. CI remembers the last clean run between builds.
- New: a memory benchmark for long chats: the live DOM stays flat from 100 to 1,000 turns, and heap growth per card is bounded and linear (about 40 KB per card under the test's jsdom; evicted cards are kept as detached nodes, so memory grows with history).
## 0.12.0
- New: the **Board** has a Queues section: every open chat with messages waiting, why it is held, its first three items, Pause / Resume per chat, Pause all / Resume all, and a jump to the chat. It updates live while the Board is open.
- New: dropped MCP connections reconnect with **exponential backoff** (250 ms, 500 ms, 1 s … up to 4 s, with jitter, three retries). A tool call is never repeated after it may have run: only a connection that never came up, or a 429, is retried for one. Handshakes and tool lists also retry on a 502/503/504.
- New: a chat in an isolated **git worktree** now says which dependency folders the project has but the worktree lacks (`node_modules`, `.venv`, `venv`), so you reinstall there. Tests with real git confirm lockfiles, installs and build output stay separate per worktree and the main checkout's `git status` stays clean.
- New: the Markdown editor preview draws **mermaid flowcharts** (`graph` / `flowchart`, TD/LR/BT/RL, box, round, diamond, circle and pill nodes, labelled and dotted arrows, cycles) with no new dependency. Other mermaid types show their source with a note instead of a wrong picture.
- New: **callouts** in the preview: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`, and `> [!NOTE]- Title` / `+` for collapsible ones.
- New: the queue panel, the Board's queue view, the target chip, code-block actions and the queue settings follow the interface language (English, Spanish, German); the dictionaries are checked to stay in sync, with the same placeholders.
## 0.11.0
- New: **Send to terminal** on shell code blocks (bash, sh, zsh, console). It pastes the block into your terminal tab without running it (bracketed paste, so a multi-line block waits for Enter) and drops the `$ ` prompts a console example carries. With no terminal open it opens a shell in the chat's folder.
- New: queued messages get **Model and effort…** in their row menu, so each queued message can run on its own model and reasoning effort (shown as chips on the row).
- New: the queue also holds when a **test run failed** in the last turn (npm/yarn/pnpm test, vitest, jest, pytest, cargo/go/dotnet test, make test…). Run anyway resumes it; Settings has a toggle next to the other hold rules.
- New: `@` also lists your other open conversations. Picking one adds `@chat:"Title"`; the model gets that conversation's latest exchange with your message, and in your message the mention is a link that jumps to its tab.
- New: hovering an image in the `@` menu shows a thumbnail (images of the open project, up to 3 MB).
- New: the jump-rail hover shows what each request cost: how long it took, tokens in and out, and the price when the provider bills.
## 0.10.0
- Security: `skills:read` read any file path it was given. It now reads only skill folders under `~/.claude` or an open project's `.claude`.
- Security: `memory:save` and `file:saveText` judged a not-yet-existing file by its unresolved path, so a symlinked folder inside the home directory or a project could send the write somewhere else. Both now resolve through the nearest existing parent. `shell:reveal` got the same check.
- Security: the engine chat channel (`chat:create`, which starts Claude, Codex, OpenCode and Antigravity chats) now has an input schema: unknown engines, permission modes and non-boolean flags are refused with a message instead of reaching the handler.
- Fixed: terminal colour codes in Codex / OpenCode / Antigravity replies, thinking and tool output no longer show as `[0m` junk.
- New: interrupted-run recovery works for Codex, OpenCode and Antigravity chats. If the app stops mid-turn, the Board offers Resume, which reopens the same CLI on the same session, provider and model. The session id is kept up to date as the CLI reports it.
## 0.9.99
- New: OpenCode chats run over `opencode serve` instead of one `opencode run` per message. OpenCode asks before running a command, editing a file or fetching a URL, and each request shows as CCE's usual Allow / Deny card ("Allow for this session" lets OpenCode remember it). Stop aborts the turn. The server listens on 127.0.0.1 behind a random per-chat password.
- New: OpenCode chats take images (attach button and paste).
- New: "Resume this folder's previous conversation" works for OpenCode (reopens the session and redraws the earlier turns) and for Antigravity (continues the conversation; its earlier turns aren't redrawn).
- Fixed: OpenCode models on a CCE provider now declare image input, so OpenCode forwards attached images instead of dropping them.
- Verified against the real OpenCode 1.19.5 CLI: allow runs the command, deny doesn't, allow-for-session stops the repeat prompt, an image reaches the provider, Stop ends a hung turn in under 50 ms, and a resumed session keeps its history. CI runs the same steps against a stand-in server.
## 0.9.98
- New: Codex chats run over `codex app-server` instead of one `codex exec` per message. Codex now asks before running a command that isn't a known-safe read, and the request shows as CCE's usual Allow / Deny card. "Allow for this session" approves that exact command for the rest of the chat. Stop interrupts a turn, including one waiting on a card.
- New: Codex chats take images (attach button and paste).
- New: "Resume this folder's previous conversation" works for Codex: CCE remembers the last Codex thread per folder, reopens it and redraws the earlier turns.
- Verified against the real Codex 0.165 CLI: allow runs the command, deny doesn't, an image reaches the provider, and a resumed thread keeps its history. CI runs the same steps against a stand-in server.
## 0.9.97
- Fixed: Codex chats on a CCE provider. Codex removed its chat-completions mode in Feb 2026 and now speaks only the Responses API, so 0.9.96's setup failed on most providers. CCE's local proxy now serves the Responses API and translates it to whatever the provider speaks; Codex points at the proxy.
- Changed: OpenCode chats on a CCE provider go through the same proxy with OpenCode's built-in Anthropic support, so no provider package is downloaded.
- Changed: Codex and OpenCode chats can use any CCE provider with a base URL (OpenAI-format, Anthropic, Gemini, OAuth ones), not only OpenAI-format/Anthropic.
- Verified against the real Codex 0.165 and OpenCode 1.19.5 CLIs: a tool call runs, its output reaches the model, and the answer comes back.
## 0.9.96
- Changed: the New session dialog has one **Chat** and one **Terminal** type. A **CLI** picker chooses what runs it (Claude Code by default, Codex, OpenCode, Antigravity; Terminal also offers a shell). Each CLI runs its own binary; CLIs that aren't installed are greyed out.
- Changed: a new chat uses the CLI's own login and default model ("CLI default"). The **Model** picker offers your CCE providers instead: any provider for Claude Code, OpenAI-format providers for Codex, OpenAI-format or Anthropic providers for OpenCode. Antigravity uses its own login only. "New chat here" and "New chat in this folder" use CLI default too.
- New: Codex and OpenCode chats can run on a CCE provider. Codex gets it through `-c model_providers` config, OpenCode through an inline config; the API key goes in the environment, never on the command line.
- New: Codex, OpenCode and Antigravity chats can start in an isolated git worktree.
- The dialog shows only the options the chosen type and CLI support.
## 0.9.95
- Fixed: chats failed to start in the installed app with "Cannot find module 'zod'". The Agent SDK's peer dependencies (`zod`, `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`) are now direct dependencies, so the package includes them.
## 0.9.94
- Added: Codex, Antigravity and OpenCode can run as chats, not only as terminal tabs. Pick "Chat — Codex / Antigravity / OpenCode" in the new-session modal, or "Open chat" on the Board. Each message is one headless CLI run (`codex exec --json`, `agy -p --output-format stream-json`, `opencode run --format json`), the next message resumes the same CLI session, and the output shows as normal chat text, thinking and tool cards. Stop ends the run and the commands it started. The YOLO box maps to each CLI's own skip-permissions flag. Without it, Codex keeps to its workspace sandbox, and actions that need approval are blocked in Antigravity and OpenCode (the chat says so). Engine chats take text only and hide the Claude-only model, mode and context controls.
- Changed: Gemini CLI is replaced by Antigravity CLI (`agy`) in the Board engine tabs, the new-session modal and Settings.

## 0.9.93
- Added: the new-session modal checks which CLIs are installed. Codex, Gemini or OpenCode options whose CLI is missing are greyed out, marked "— not installed", and the install hint is shown under the Type picker.
- Fixed: IPC calls that change state or touch files are checked against a schema first, so a malformed call gets `{ ok: false, error }` instead of reaching the handler.
- Fixed: API keys are found in `~/.config/claude-code-enhanced/.env` or `~/.env` when the app is started from a launcher that does not load your shell environment.
- Fixed: API keys are masked in logs, and file paths go through one shared containment check that refuses `..` and symlink escapes.
- Changed: routine main-process and renderer logging is off unless `CCE_DEBUG` is set; real errors and warnings still print.
- Changed: background promises in the chat UI now handle their errors instead of failing silently.
- Tests: the E2E smoke run now starts and stops every installed engine CLI.

## 0.9.92
- Fixed: waiting on something is no longer treated as a loop. Shell commands that start with `sleep`, and connector tools that report status (CI check runs, job status, progress), are never counted, and the same check repeated after a wait is a poll, not a repeat. Before, checking CI three times got the third check blocked.
- Fixed: ordinary words ("error", "message", "thread", "doc", "page", "workflow") no longer switch on Sentry, Slack, Notion or GitHub when connectors are picked per message.
- Fixed: a connector picked for one message stays available for the next two, so "plan it" followed by "go ahead" keeps the tools the plan was about.
- Added: workflow option "Finish with" in the `⋯` options panel: run the tests and show the result, or give a short summary of what changed.

## 0.9.91
- Fixed: tool calls from local models and proxies that number their calls per reply (`call_0`, `call_1`, or no id at all) now get a unique id each turn. The repeated ids could make the loop guard deny a fresh call based on an old verdict, and made cards and results collide.
- Fixed: a message typed while the agent is working no longer clears the loop guard, so a looping agent is still caught after you steer it.
- Fixed: an engine error whose text says "aborted" (a fetch or stream timeout) is now shown instead of the tab ending silently. Only your own Stop stays quiet.
- Fixed: one connector that fails to switch on or off no longer stops the others from switching, and a connector that drops late in a long session is retried again on your next message (the old retry gave up after the first ~8 minutes).

## 0.9.90
- Added: command menu preview — typing `/` shows a list on the left and a preview on the right (description, argument hint, where the command comes from, first 30 lines of its file). Sections: Recent, Built-in, Project & user, Plugins, MCP. Search matches loosely and highlights the matched letters, the 24-item cap is gone (the list is windowed), recently used commands rise to the top, and `/` also opens mid-message. Tab or Enter completes, PageUp/PageDown/Ctrl+Home/Ctrl+End jump, hovering moves the selection.
- Added: `@` menu preview — files show their first 40 lines, folders list their entries, and `@diff`, `@staged` and `@branch` paste your git state into the message.
- Added: queue panel — queued messages are an editable list: click to edit, drag or Alt+↑/↓ to reorder, per-item menu (send now as steer, run next, duplicate, move back to the box, ask before running, run at a time, remove), Pause/Resume, Clear with Undo, Up arrow takes the newest back. The queue holds itself after a failed turn, a waiting permission prompt or the spend ceiling (Settings → toggles), and notifies you when it holds or finishes. Queued images now survive a restart (saved as 0600 files, never in localStorage).
- Added: workflow options — every workflow has a `⋯` options panel: when it runs (put in the box / send now / queue), permission mode, model and effort for that run, scope (whole project, current changes, staged, chosen files), read-only, your own command, a prompt preview you can edit per project, and a "then run" chain of up to 4 more workflows (auto or ask first). Save per project or everywhere.
- Added: your command with a workflow — a box at the top of the workflow menu is sent together with whichever workflow you pick. Shift+click puts a workflow in the message box instead of sending it.
- Added: workflow menu — filter box, Pinned and Recent groups, number keys 1–9, hide workflows (Settings), your own custom workflows (new, duplicate, edit, delete, export/import as JSON), two ready-made chains (Feature, Bug), and four new workflows: Upgrade plan, De-risk, Verify live, Release. Run history shows runs, last run and how it ended.
- Fixed: a workflow no longer overwrites a half-typed message (it asks, or uses your text as the task), no longer leaves the chat stuck in plan mode, and queues itself when the chat is busy.
- Added: target chip (Local / Worktree) in the message footer, one model chip that shows `model · effort`, code blocks with a language label plus Wrap and Save, and a jump-marker preview with three lines and the reply state.
- Added: Lanox provider preset (OpenAI-compatible gateway, bearer key).
- Fixed: command previews refuse `..` and symlinks that lead out of the commands/skills/plugins folders; a diff pasted with `@diff` can no longer break its code fence; the command list refreshes after a minute.

## 0.9.89
- Added: markdown editor — the Files tab gets an **edit** button on every .md/.txt row: source on the left, live preview on the right, task checkboxes you can tick, and ```flow``` arrow chains drawn as SVG. Saving goes through the same guarded path as file reads (open projects only, never a secret file).
- Added: review pane — a Review tab in the tool panel shows the working-tree diff with stats (+/− per file), one click to open a file's patch, and a button to ask Claude about the changes.
- Added: cce:// links — CCE registers itself as the `cce://` handler: `cce://view/usage`, `cce://open/<path>`, `cce://chat/<session-id>` jump straight into the app (or queue for the next launch). Traversal and junk URLs are rejected.
- Fixed: update check is honest and numeric — it talks to the GitHub releases API, compares versions segment-by-segment (0.9.10 is newer than 0.9.9, unlike a string compare), and when the fetch fails it says so instead of "up to date".
- Added: translations — Settings → Language switches the UI between English, Español and Deutsch; strings live in one i18n dictionary and new locales fail the test suite until complete.
- Locked in (already shipped, now regression-tested): the preview pane stays a sandboxed iframe that only follows localhost dev servers, with "open externally" for anything else.

## 0.9.88
- Added: codebase index — Settings → Codebase index builds a per-project symbol index (plain JSON on this machine, junk dirs skipped) and offers chats a `search_codebase` tool so the model finds definitions without reading files.
- Added: usage by model — the Usage view now breaks tokens and engine-reported cost down per model, next to the daily bars.
- Added: spend ceiling — Settings → Spend ceiling is a hard USD cap per chat that CCE enforces itself: when reported cost crosses it, the chat is interrupted once with a clear note.
- Added: skills sync — the skills manager diffs disk against the last sync snapshot and drops enable/disable toggles for skills that no longer exist.
- Added: auto-learn skills — opt-in probe (same approve-each-one flow as auto memory) that proposes a SKILL.md draft after a repeated workflow; nothing is written until you accept it.
- Added: marketplace — Connectors → Marketplace lists a curated catalog: MCP entries install through the same connector path as the cards above (nothing downloaded), plugin entries just open their HTTPS page.

## 0.9.87
- Added: engine tabs — Codex, Gemini CLI and OpenCode open as real terminal tabs (Board → Engine tabs, or Settings → Engine tabs to see what is installed). Detection is a PATH scan of the login shell; nothing is spawned until you open a tab.
- Added: per-agent models — Settings → Agent models picks which model each subagent in `~/.claude/agents` runs; blank keeps the agent file's own default.
- Added: mobile/web remote with QR pairing — Settings → Mobile access starts a loopback-only web page (token in the URL, shown as a QR code) to watch chats, answer permission prompts and send messages. The token is compared in constant time and is regenerated on every start.
- Added: SSH hosts — Settings → SSH hosts remembers machines (keys/agent only, never passwords) and opens a real `ssh` terminal tab. Host/user/port fields are validated and the argv is built as an array, so a saved host can never smuggle ssh options or shell syntax.

## 0.9.86
- Fixed: the auth store no longer calls Electron's `basic_text` fallback "encryption". When the desktop keyring is unavailable, Electron falls back to a fixed-XOR "encryption" that any process can undo; `isEncryptionAvailable()` still says yes there. The store now checks the selected backend and reports honestly, so a key saved without real protection is never presented as protected.
- Added: the packaged binary ships with the RunAsNode, NODE_OPTIONS and `--inspect` escape hatches fused off (an afterPack hook flips them on the packed copy only; the dev electron is untouched).
- Added: waking the machine re-checks what sleep broke: connector health is invalidated, the claude CLI is re-probed, and every window is told (`app:resumed`).
- Added: native crashes (node-pty, the GPU process) leave a local, compressed dump instead of nothing. Upload stays off.
- Added: the Board view (sidebar → Board) lists every live chat with what it is doing (working / needs you / idle), the background job queue, and any run that was cut short when the app last stopped — with a Resume button per interrupted run.
- Added: background jobs with a queue: `pipeline:start` and `jobs:add` run long work one job at a time; the board can cancel them, and a finished or failed job raises a notification.
- Added: task → PR pipeline: one prompt in a folder makes an isolated worktree, runs the chat, commits, pushes the branch and opens the PR (or hands back a compare URL when `gh` is not installed).
- Added: permission notifications carry Allow / Deny buttons where the OS supports them (Windows/macOS); clicking the answer in the notification answers the pending request. On Linux the notification stays click-to-focus.
- Added: a chat that is busy when the app stops is remembered on disk; the next start's board offers to resume it by session id.

## 0.9.85
- Added: reasoning summaries now reach the chat from every provider protocol. GPT-5 / o-series through the OpenAI Responses API: the request asks for `reasoning.summary` and the streamed, part-only and item-only summary shapes are all captured (each summary once). Gemini: `includeThoughts` is requested and thought parts are shown as thinking instead of leaking into the answer. Engines that hand the summary back in a `summary` field on a thinking block are read too, instead of saying "reasoning not shared by the provider" over text that was right there.
- Added: Settings > Session caps & model > "Show thinking" now also hides the reasoning summaries in the chat itself (live thoughts, finished thoughts and replayed transcripts alike) and brings them back when ticked again. It still controls whether Claude models are asked for their summaries.
- Changed: the perf-budget test now renders a 2100-card session through the real chat view and checks that the DOM stays at the virtual window, that later cards cost about what earlier ones did, and that the newest card is shown. It used to split a string and never touch the renderer.
- Checked, no change: E2E smoke already runs in CI under Xvfb; E1–E3 have tests (0.9.79). Mutation testing stays opt-in: the CI job runs Stryker only when it is installed, and this batch adds no dependencies.

## 0.9.84
- Fixed: auto mode judged shell commands on their raw text, so quoting could hide what the shell runs. `sed '-i' …` passed the "no -i" rule, and `cat ".e""nv"`, `cat \.env` or `cat $'\x2eenv'` passed the secret-file check. Commands are now read the way the shell reads them (quotes and escapes removed, split on `;`, `|`, `&&`, `||` outside quotes). Variables, `$'…'`, subshells, redirects and open quotes make auto mode ask. A glob may not reach a hidden file, the home folder, an absolute path or the parent folder (`ls src/*.js` is still approved).
- Changed: images pasted into a message you have not sent yet are kept across a crash in files only you can read (0600), named by a hash of the folder. They used to be lost; they are never written to localStorage.
- Changed: IPC size limits are set per channel. Chat sends and draft images get 24 MB; every other channel, including new ones, keeps 1 MB.
- Changed: IPC from a DevTools page is refused in the installed app (it is only allowed in a development build).
- Added: tests that only http(s) links leave the app, and that the translator proxy listens on 127.0.0.1 only and refuses calls without its token.

## 0.9.83
- Added: the home page offers "Reopen N chats from last time": the chats open when the app last stopped (quit or crash), resumed by session id.
- Changed: a failed send says the cause and what to do (sign-in failed, out of credit or quota, rate limit, provider overloaded, model not available, request too large), with the engine's code and the provider's words after it. It used to show only the code.
- Added: regression tests that the loop guard does not stop an ordinary edit-and-test cycle (it still stops the same run repeated with nothing changed), and that closing or switching a chat's provider aborts its engine process.

## 0.9.82
- Changed: Monaco (the 4.6 MB diff editor and code-colour bundle) is no longer parsed on every start. It loads the first time a diff or code block needs it; a diff shows "loading diff…" for that moment, and falls back to the text diff when the bundle is missing.
- Changed: the Overview's connector status is cached for 30 s (was 10 s). Refresh and a reconnect still clear it at once.
- Checked, no change: the Overview's 6 s poll is already gone (a 60 s safety net is left, skipped while the window is hidden).

## 0.9.81
- Added: the conversations list shows a folder illustration, a short hint and an Open folder… button when there are no conversations yet, instead of a bare "No conversations yet".
- Added: a test that fails if any icon-only button lacks an aria-label or a tooltip. The audit found none missing today.

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
