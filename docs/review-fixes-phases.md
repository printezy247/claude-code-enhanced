# Full Code Review — Claude Code Enhanced 0.9.92

Baseline: `npm test` → 128 files / 1679 tests pass. `npm run lint` (deb lintian) clean. App boots and E2E smoke passes.

Legend: `[ ]` todo, `[x]` done, `P?` priority (P0 critical, P1 high, P2 medium, P3 low).

Status: reviewed and closed for 0.9.93. Every ticked item was either changed in this
pass or re-verified against the current tree; the note says which and points at the
test or file that proves it.

---

## Phase 1 — Bugs (fix now)

### 1.1 Stray untracked artifacts (P2)
- [x] `.gitignore`: added `graphify-out/`; `.claude/` and the stale `claude-code-enhanced/` copy were already listed. `docs/harness-toolcalling-provider-phases.md` only exists in the stale 0.9.78 copy, not in this repo, so there is nothing to ignore here.
- [x] `docs/review-fixes-phases.md` is kept as a tracked review doc (decision: it is the record of this pass).
- [x] `git status` clean at the end of the pass; enforced by `test/review-fixes-0993.test.js` (phase 1.1).

### 1.2 Nested clone cleanup (P2)
- [x] Confirmed unwanted, and confirmed **not present** in this checkout. It exists only in the stale copy at `~/Documents/Default Project/claude-code-enhanced` (2.1 GB), which is not the repo of record.
- [x] Nothing to delete here; `claude-code-enhanced/` stays ignored (test asserts it is absent).

### 1.3 Console noise (P3)
- [x] `src/main/main.js` (26 calls), `src/main/proxy.js` (7), `src/main/chats.js` (2) now log through `src/main/debug.js` (`debugLog`, gated by `CCE_DEBUG` or `CCE_SMOKE`).
- [x] `console.error`/`console.warn` untouched: they mark real failures.
- [x] Renderer logs gated behind `window.__CCE_DEBUG || window.__CCE_SMOKE` (`main.js`, `chat/session.js`, `chat/panels.js`); `events.js`/`picker.js` were already gated.
- [x] Covered by `test/review-fixes-0993.test.js` (phase 1.3), including a test that `debugLog` is silent by default.

### 1.4 Fire-and-forget promises (P2)
- [x] `chat/session.js` (steer/send/chat:last), `chat/events.js`, `chat/panels.js` (settings probes + index), `chat/picker.js`, `chat/transcript.js` (both model switches), `chat/qpanel.js`, `chat/status.js` all handle rejection with `.catch(...)`.
- [x] Guarded by a source test (`floatingThenOffenders`) rather than an ESLint plugin, since this repo has no ESLint config.

### 1.5 Gemini CLI not installed (P3)
- [x] Kept in `REGISTRY` (detection is a PATH scan; nothing spawns until asked).
- [x] New-session modal greys out any engine that is not detected and shows its install hint inline (see 5.5). Launch-time errors still surface through `{ ok: false, error }`.

### 1.6 Login-shell env-var fragility (P2)
- [x] `providers.resolveApiKey` falls back to `~/.config/claude-code-enhanced/.env` then `~/.env` when neither the stored key nor the process environment has one. Explicit environment values still win.
- [x] Provider card already prints the env var name ("set OPENCODE_API_KEY …" in `providers/ui.js`).
- [x] Tests: `test/review-fixes-0993.test.js` (phase 1.6) covers both files and the precedence rule.

---

## Phase 2 — Robustness / error handling

### 2.1 IPC input validation (P1)
- [x] Added `ipcguard.checkFields` (kinds: `string`, `id`, `nonempty`, `text`, `object`, `number`, `boolean`, `{ enum }`, `{ type, optional }`).
- [x] Added `src/main/ipcschemas.js` with specs for 25 mutating/file channels; `handle()` validates before the handler runs and returns `{ ok: false, error }`.
- [x] Covers `session:create` (type enum), `auth:setKey` (non-empty key), `providers:delete`/`default` (uid), `session:write`-adjacent session channels, file handlers, connectors and jobs.
- [x] Tests: phase 2.1 in `test/review-fixes-0993.test.js` (junk shapes, empty message allowed, unknown type refused, wiring asserted in source).

### 2.2 Origin hardening audit (P1)
- [x] Verified: `handle()` rejects a foreign sender (`isValidSender`), `owned()`/`refuseForeign` guard cross-window items, devtools origin is accepted only in a development build.
- [x] Covered by `test/security.test.js` (foreign `file://` origins) and `test/multiwindow.test.js` (another window cannot close/see a chat or session).

### 2.3 Proxy body limit (P1)
- [x] Verified: the cap is applied by the request `data` collector, so it covers streaming (SSE) requests as well as JSON; over the cap → `413 request_too_large`.
- [x] Configurable through `CCE_PROXY_BODY_LIMIT` (`proxy.maxBodyFromEnv`), covered in phase 2.3 of the new suite; the 413 path is covered by `test/phase1-harness-0980.test.js`.

### 2.4 Connector status cache (P2)
- [x] `connectors.createStatusCache` (30 s TTL, failures never cached, `invalidate()`) is wired into `connectors:status`.
- [x] `connectors:add`, `connectors:addCustom`, `connectors:remove` invalidate the cache; new `connectors:refresh` forces a re-scan and the panel's Refresh button calls it.
- [x] Tests: phase 2.4 covers TTL, invalidation, failure non-caching and the main-process wiring.

### 2.5 OAuth token refresh (P2)
- [x] Verified: exponential backoff with a bounded retry count (`oauth.js`), and a failed refresh marks the provider `authExpired`.
- [x] Provider card shows "(expired — reconnect)" before a chat is attempted (`providers/ui.js`).
- [x] Covered by `test/oauth.test.js` (marks expired / clears on success).

### 2.6 Session rail DOM diffing (P3)
- [x] Verified in-place card updates preserve the DOM (no full re-render), so focus, hover and scroll survive.
- [x] Covered by `test/session-rail.test.js` (cards appear/update/disappear without a rebuild).

---

## Phase 3 — Performance

### 3.1 Monaco lazy-load (P3)
- [x] Verified: `loadMonaco()` resolves once and caches the promise; no work happens until a code block asks for it.
- [x] Covered by `test/phase3-perf-0982.test.js` and `test/renderer-codeblock.test.js`.

### 3.2 Transcript virtualization (P2)
- [x] Verified: windowed transcript with spacers, jump-to-latest and stable anchors.
- [x] Covered by `test/perf-budget.test.js` and `test/stability-speed.test.js` (large transcripts stay within budget).

### 3.3 Worker threads (P3)
- [x] Verified: file index, transcript search and shell-path discovery run in worker threads with a synchronous fallback and a timeout that reports an error instead of freezing.
- [x] Covered by `test/workers.test.js`.

### 3.4 Connector list pagination (P3)
- [x] Mitigated rather than paginated: the list is only scanned when the connectors view opens (not at startup), and the scan is now cached for 30 s with an explicit Refresh. 111 rows render fine; the expensive part was the health check.
- [x] Startup cost measured indirectly by the perf suites; no regression.

---

## Phase 4 — Security

### 4.1 Path traversal (P1)
- [x] `file:read` / `file:saveText` already resolve through `realpath` and require the file to sit under an open project root, with a sensitive-file denylist.
- [x] Added `src/main/pathsafe.js` (`resolveSafe`) as the shared containment helper, with a trailing-`..` and symlink escape test.
- [x] Tests: phase 4.1 in the new suite; the handler allowlist is covered by `test/security.test.js`.

### 4.2 Shell command construction (P1)
- [x] Verified: `execFile`/`spawn` receive argv arrays (`sessions.create`, `engines.commandFor`, `connectors.js`); no template string reaches a shell. A malicious cwd is a path, never a command.
- [x] Guarded by the phase 4.2 source test (no `execSync`, no string-form `exec`).

### 4.3 Secrets in logs (P1)
- [x] Added `providers.redactKey` and reworded the one log line that printed "secret".
- [x] Phase 4.3 test asserts no log/debugLog line in the main process mentions a key-shaped field and that `redactKey` masks the value.

### 4.4 CSP / sandbox (P2)
- [x] Verified: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, preload is the only bridge, and `index.html` declares a CSP.
- [x] Covered by phase 4.4 tests and `test/security.test.js`.

---

## Phase 5 — UX / upgrades

### 5.1 Gemini install or removal (P3)
- [x] See 1.5: kept, detected, and gated in the new-session modal with an inline install hint.

### 5.2 Multi-window persistence (P2)
- [x] Verified: workspace state is saved and restored per window; a closed window's chats are not re-routed to another window.
- [x] Covered by `test/multiwindow.test.js`.

### 5.3 Prompt suggestions & subagent progress (P3)
- [x] Verified: suggestion chips render under the composer (`events.js` → `prompt_suggestion(s)`), and nested subagent timelines show live activity (`tools.js`).
- [x] Covered by the renderer suites in `npm test`.

### 5.4 Elicitation forms (P3)
- [x] Verified: URL and form-mode cards wire approve/decline/cancel.
- [x] Covered by `test/renderer-elicitation.test.js`.

### 5.5 New-session modal polish (P3)
- [x] The modal asks `engines:list`, disables an option whose CLI is missing, appends "— not installed", and prints every missing engine's install hint inline.
- [x] Tested in phase 5.5 (source-level, since the modal is renderer DOM code).

---

## Phase 6 — Quality / CI

### 6.1 Mutation testing (P3)
- [ ] Deferred by design: Stryker is opt-in, not a dependency, and the CI `mutation` job skips cleanly when it is absent. `stryker.config.json` is present. Not part of the release gate for 0.9.93.

### 6.2 Coverage gaps (P2)
- [x] Added error-path tests for IPC validation (2.1), path traversal (4.1), dotenv fallback (1.6), connector cache (2.4) and proxy body limit (2.3) in `test/review-fixes-0993.test.js`.

### 6.3 E2E smoke expansion (P2)
- [x] `test/e2e/smoke.mjs` now spawns every engine that `engines:list` reports as installed (codex/opencode/gemini) and kills it again; an absent engine is skipped so CI runners still pass.
- [x] Connector toggle is covered at the unit level (2.4) instead of in smoke: the smoke run uses the user's real `~/.claude` config and must not add or remove MCP servers there.

### 6.4 Changelog (P3)
- [x] 0.9.93 entry written by hand in `CHANGELOG.md`. `npm run changelog` was tried first but rewrites the file as a raw commit list and drops the curated entries, so its output was discarded.

### 6.5 Version bump (P3)
- [x] Bumped to 0.9.93, rebuilt the deb, and reinstalled.

---

## Verification checklist

- [x] `npm test` green (129 files / 1717 tests)
- [x] `npm run lint` green
- [x] `npm run dist` produces deb; lintian clean
- [x] E2E smoke passes
- [x] Manual: new-session modal shows codex/gemini/opencode; codex/opencode spawn; a missing CLI is greyed out with its hint
- [x] `git status` clean (no stray artifacts)
- [x] No nested clone

## Notes

- Review is based on static scans + test baseline + git history, not a line-by-line audit of all 115 source files.
- Deeper per-module review recommended for `src/main/main.js` (2k+ lines), `src/main/chats.js`, `src/main/proxy.js`, `src/main/adapters.js`.
- Many items reference existing fixes (0.9.72–0.9.92) that already landed; they were re-verified rather than re-implemented.
