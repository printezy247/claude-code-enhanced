# CCE Upgrade Plan — provider robustness + Claude Code desktop parity

**Goal:** Make CCE work reliably for every provider in the 230+ catalog and follow the Claude Code desktop workflow, using the REA findings in `docs/claude-desktop-parity.md` (Claude Desktop 2.42304.2) and the deferred items in `docs/deferred-heavy-items.md`.

**Source of truth:** `docs/claude-desktop-parity.md` §1.4 (SDK surface), §1.5 (rail panes), §4 (still-open items); `docs/deferred-heavy-items.md`; this repo's provider code (`src/main/providers.js`, `adapters.js`, `proxy.js`, `catalog.js`).

**Baseline:** `npm test` 701 passing, 1 failure only when `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is set in the environment (ambient flake, not a code bug).

**Out of scope (deliberately):** Claude.ai connector directory, artifacts/side-chat panes, Remote/SSH parity, in-app browser — product features of the Claude.ai app, not the Code surface (per parity doc §4).

---

## Phase A — Provider robustness (every provider works)

### A1. Generalize env-var auth beyond OpenCode Go
- **Files:** `src/main/providers.js` (`resolveApiKey`), `src/main/main.js` (`refreshSecretCache`)
- **Now:** only OpenCode Go's `OPENCODE_API_KEY` is read from env; other env-auth providers (Vertex, `google-vertex`, env-auth catalog entries) get no credential.
- **Fix:** in `refreshSecretCache` and `resolveApiKey`, resolve any catalog `envVar` for any provider, reading from `process.env` and the login shell (GUI apps inherit neither). Vertex needs ADC handling separately.
- **Test:** `test/provider-envvar.test.js` extended for a second env-auth provider.

### A2. Per-provider key/URL mismatch detection
- **Files:** `src/main/providers.js` (`keyUrlMismatch`)
- **Now:** only Xiaomi MiMo mismatches are detected.
- **Fix:** extend to Anthropic-vs-OpenAI route mismatches (e.g. a Claude key on an OpenAI base URL), missing `/v1`, trailing slash, Google `query` vs header, Azure resource name. Return a human message per case.
- **Test:** unit tests for each mismatch class.

### A3. Reliable model listing
- **Files:** `src/main/adapters.js` (`listModels`), `src/main/catalog.js`
- **Now:** providers without `GET /models` (Bedrock, some gateways) fail the picker.
- **Fix:** fall back to the models.dev catalog for that provider id; mark "catalog-only" in the UI; never leave the picker empty.
- **Test:** `test/providers.test.js` with a no-models endpoint.

### A4. Context window for every model
- **Files:** `src/main/modelcontext.js`, `src/main/modelsdev.js`
- **Now:** dated variants fall back; many models return 0 → engine assumes 200k (wrong for 1M and 32k models).
- **Fix:** add a normalization table in `modelsdev` (strip date suffixes, lowercase, alias map); when unknown, probe `GET /models` for `context_length`/`max_context_tokens`; cache result.
- **Test:** `test/modelcontext.test.js` extended.

### A5. Small/fast model defaults
- **Files:** `src/main/catalog.js` (`derive`), `src/main/providers.js` (`makeInstance`)
- **Now:** derived providers get `defaultSmall: ''`, so background calls (titles/summaries) reuse the main model or fall back to a Claude name the provider does not serve.
- **Fix:** in `derive`, pick the cheapest/smallest model from the provider's list as `defaultSmall`; in `makeInstance`, default `smallFastModel` to it.
- **Test:** derived provider has non-empty `defaultSmall`.

### A6. Fallback model selection per provider
- **Files:** `src/main/proxy.js` (`fallbackModel`)
- **Now:** one global fallback; some providers need a specific model.
- **Fix:** provider-declared `fallbackModel` (catalog + instance); proxy uses it first, then the global.
- **Test:** proxy test with provider fallback.

### A7. OAuth token refresh robustness
- **Files:** `src/main/oauth.js`, `src/main/providers.js` (`ensureFreshAuth`)
- **Now:** refresh only within 120s; failures are silent.
- **Fix:** retry with backoff; surface expired state in `publicInstance` (`authExpired` already there); add a "re-sign-in" affordance in the renderer.
- **Test:** `test/oauth.test.js` (new) for refresh failure.

### A8. Base URL normalization
- **Files:** `src/main/providers.js` (`makeInstance`, `migrateUrls`)
- **Now:** trailing slashes, missing `/v1`, wrong scheme cause silent failures.
- **Fix:** normalize on save (strip trailing slash, ensure scheme, apply catalog `openaiBase`-style rules); migrate existing instances.
- **Test:** normalization unit tests.

### A9. Provider health check / test connection
- **Files:** `src/main/main.js` (chat:test or new `provider:test`), renderer `providers.js`
- **Now:** test connection classifies errors but doesn't probe model availability.
- **Fix:** a "Test" button that runs a 1-token probe through the real path (proxy for translated) and reports model-not-found vs auth vs network.
- **Test:** renderer test for the button.

### A10. Rate-limit handling
- **Files:** `src/main/adapters.js` (`fetchUpstream`)
- **Now:** 3 retries capped at 15s; some free tiers need longer.
- **Fix:** honor `Retry-After` up to 60s for 429 only; add a per-provider cooldown flag surfaced to the UI.
- **Test:** adapter retry test.

---

## Phase B — Claude Code desktop workflow parity (from REA §1.4)

### B1. `canUseTool` pipeline parity
- **Files:** `src/main/chats.js` (`canUseTool`), `src/main/tools.js`
- **Now:** basic permission; missing path policy, VM-path denial, write-tool block rules, `updatedInput` pinning, `always_ask`/`always_deny` per-tool policy for connector tools.
- **Fix:** implement path policy (read-only session, path outside allowed dirs, VM-path denial), write-tool block rules, `updatedInput` pinning ("allow pinned to the judged input"), per-tool always_ask/always_deny for connector tools.
- **Test:** `test/chats.test.js` permission cases.

### B2. Control requests
- **Files:** `src/main/chats.js`, `src/main/main.js`
- **Now:** missing `mcp_status`, `mcp_set_servers`, `mcp_reconnect`, `mcp_toggle`, `mcp_read_resource`, `mcp_call`, `mcp_message`, `get_context_usage`, `rewind_files`, `apply_flag_settings`, `reload_skills`, `reload_plugins`, `reload_output_styles`, `stop_task`, `background_tasks`, `get_task_output`, `list_permission_rules`, `request_user_dialog`, `elicitation`, `hook_callback`, `file_suggestions`.
- **Fix:** expose each as an IPC channel + handler, routing to the SDK's control request API; renderer affordances where desktop has them.
- **Test:** `test/security.test.js` IPC drift check + per-channel tests.

### B3. Origin validation for every renderer call
- **Files:** `src/main/main.js`
- **Now:** partial; desktop validates origin on every IPC.
- **Fix:** wrap `handle()` so every handler receives and checks `event.senderFrame.url` origin; reject foreign origins.
- **Test:** `test/security.test.js`.

### B4. Context usage readout
- **Files:** `src/main/modelcontext.js`, renderer rail
- **Now:** single number; desktop shows per-category breakdown (`categories[]` with `kind: used | free | buffer | deferred`).
- **Fix:** engine's `get_context_usage` control request → categories; render in the Context card (already partially there).
- **Test:** `test/session-rail.test.js`.

### B5. File checkpointing / rewind
- **Files:** `src/main/chats.js` (already `enableFileCheckpointing: true`, `replay-user-messages`), renderer
- **Now:** backend enabled; no UI to rewind.
- **Fix:** `rewind_files` control request + a "rewind to here" affordance on user messages; confirm dialog.
- **Test:** renderer test.

### B6. Prompt suggestions + agent progress summaries
- **Files:** `src/main/chats.js` (already enabled), renderer chat
- **Now:** enabled but not rendered.
- **Fix:** render suggestion chips under the composer; render subagent progress summary in tool cards.
- **Test:** renderer test.

### B7. Elicitation cards
- **Files:** `src/main/chats.js` (`answerElicitation`), renderer
- **Now:** backend present; renderer card missing.
- **Fix:** render an elicitation form card with accept/decline/cancel.
- **Test:** `test/renderer-elicitation.test.js`.

### B8. Find in page
- **Files:** new `src/main/findinpage.js`, renderer
- **Now:** missing.
- **Fix:** `webContents.findInPage` wrapper + Ctrl+F UI.
- **Test:** basic.

### B9. About window + buddy + computer-use teach + design window + claude page preview
- **Files:** new modules under `src/main/`
- **Now:** missing (auxiliary windows from desktop).
- **Fix:** lightweight versions: About (version/credits), Find in Page, Claude page preview (open URL in embedded view). Buddy/computer-use/design window are product features — defer.
- **Test:** smoke.

### B10. Workers for heavy work
- **Files:** new `src/main/workers/`
- **Now:** file indexing, transcript search, shell-path resolution run on main thread.
- **Fix:** move `file-index`, `transcript-search`, `shell-path` to worker threads; keep `heavy-work` optional.
- **Test:** perf budget.

---

## Phase C — Performance & UX (deferred heavy items)

### C1. Transcript virtualization
- **Files:** `src/renderer/chat.js`
- **Fix:** virtualize the message list; keep last N rendered, window on scroll.
- **Test:** perf budget.

### C2. Rail DOM diffing
- **Files:** `src/renderer/app.js`
- **Fix:** diff the rail instead of re-rendering.
- **Test:** session-rail.

### C3. Connector active-selection UI + host-owned calls
- **Files:** `src/main/connectors.js`, renderer
- **Fix:** per-connector tool picker; host-owned `getProxiedConnectorCall`/`keepConnectorCall` (deferred per parity §4 — needs host-side MCP client).
- **Test:** connector tests.

### C4. Skill/agent pruning UI
- **Files:** renderer
- **Fix:** list synced skills/agents with enable/disable.
- **Test:** renderer.

### C5. Full crash recovery beyond draft/pending
- **Files:** `src/main/chats.js`, sessions
- **Fix:** persist in-flight turn state; recover on restart.
- **Test:** reliability tests.

### C6. MCP reconnect backoff
- **Files:** `src/main/connectors.js`
- **Fix:** exponential backoff on reconnect; surface status.
- **Test:** connector tests.

### C7. Multi-window polish
- **Files:** `src/main/windows.js`, renderer
- **Fix:** `Ctrl+Shift+N` already; add window menu, per-window state restore, close-to-tray interplay.
- **Test:** multiwindow.

---

## Phase D — Quality, testing, CI

### D1. Fix ambient token-var flake
- **Files:** `test/chat-efficiency.test.js` or vitest config
- **Fix:** make the test unset `CLAUDE_CODE_MAX_CONTEXT_TOKENS` or run with env cleared in `package.json` test script.
- **Test:** none.

### D2. Mutation testing wiring
- **Files:** `stryker.config.*` (check existing), `.github/workflows/ci.yml`
- **Fix:** wire stryker to CI on the critical modules (providers, adapters, proxy, toolfilter).
- **Test:** CI green.

### D3. E2E suite
- **Files:** `test/e2e/`
- **Fix:** Playwright smoke: boot, create chat, send message, switch provider, open terminal.
- **Test:** CI.

### D4. CI workflows
- **Files:** `.github/workflows/`
- **Fix:** lint + test + build on PR; cache node_modules.
- **Test:** green.

### D5. Security scan
- **Files:** `src/main/` (already has security.test)
- **Fix:** run `ecc:security-scan`; fix findings.
- **Test:** scan clean.

---

## Phase E — Tracking

### E1. Update deferred-heavy-items.md
- Move items as they ship; keep the list honest.

### E2. Version bump + release notes
- `npm run bump` only at release.

---

## Recommended execution order

1. Phase A (A1, A2, A3, A4, A5 first) — highest user-visible impact for "all providers".
2. Phase B (B1, B2, B3, B4) — desktop workflow parity core.
3. Phase D (D1, D4) — hygiene.
4. Phase C — heavy, one at a time.
5. Phase E — ongoing.

## Verification

After each task: `npm test` green; for UI changes, `npm run smoke`.

## Rulings

- The ECC harness audit (`/ecc:harness-audit`) scores this repo as an ECC *consumer* (14/39) because it looks for `.claude/hooks`, `AGENTS.md`, etc. CCE is an Electron app, not an ECC consumer — that score is not meaningful here and is not a target. The real targets are the phases above.
- Heavy items (transcript virtualization, rail diffing, crash recovery, MCP backoff) stay deferred until a dedicated branch; they are listed for tracking only.
- Claude.ai connector directory, artifacts/side-chat panes, in-app browser, Remote/SSH parity remain out of scope (product features of the Claude.ai app).
- No new dependencies anywhere in this plan.