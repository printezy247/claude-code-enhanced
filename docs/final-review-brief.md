# Whole-Branch Final Review Brief — Claude Code Enhanced 0.9.38

## Executive Summary
This branch brings complete provider robustness across all 230+ models in the catalog, workflow parity with Claude Code Desktop 2.42304.2 (per REA audit findings), significant UI performance optimizations (transcript virtualization, rail DOM diffing), skill/agent pruning, and robust CI test harnesses.

## Key Changes by Phase

### Phase A — Provider Robustness (All Catalog Providers Supported)
- **Generalize Env-Var Auth (A1)**: Resolves any catalog `envVar` (`OPENCODE_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, etc.) in `refreshSecretCache` and `resolveApiKey`.
- **Per-Provider Key/URL Mismatch Detection (A2)**: Differentiates Anthropic vs OpenAI endpoints, flags missing `/v1` routes, and detects scheme errors with actionable human-readable messages.
- **Reliable Model Listing (A3)**: When a provider lacks `GET /models` (e.g. AWS Bedrock, custom gateways), falls back to the models.dev catalog and tags entries with `catalog: true`.
- **Context Window Normalization & Probing (A4)**: Strips date suffixes, normalizes case and aliases. For uncataloged models, probes `/models` for `context_length` / `max_context_tokens` and caches results.
- **Small/Fast Model Defaults (A5)**: Derived providers automatically select their smallest/cheapest model for background summaries and titles.
- **Fallback Model Routing (A6)**: Providers declare fallback models (instance > catalog > smallFastModel) used automatically upon missing/unsupported model errors.
- **OAuth Refresh (A7)**: Exponential backoff on token refresh failures with clear expired state indicators.
- **Base URL Normalization (A8)**: Cleans trailing slashes, enforces HTTP(S) scheme, and applies protocol-appropriate path rules on save.
- **Provider Connection Probing (A9)**: Probes upstream with a real 1-token query to verify model availability vs auth or network errors.
- **Rate-Limit Handling (A10)**: Honors HTTP 429 `Retry-After` up to 60s with per-host cooldown tracking.

### Phase B — Claude Code Desktop Parity (from REA §1.4)
- **Host-Owned `canUseTool` Pipeline (B1)**: Enforces VM path denial (`/proc`, `/sys`, `\\.\`), read-only session policy, write-tool block rules, allowed directories restriction, and `updatedInput` pinning. Connector tools support `always_ask`, `always_allow`, and `always_deny`.
- **Control Requests IPC Surface (B2, B3)**: Full channel exposure for context usage, file checkpoints/rewind, MCP status/toggle/reconnect, task polling/stopping, and style reloading.
- **IPC Origin Hardening (B3)**: Strict sender frame origin checking (`file://` restricted strictly to app renderer directory; devtools allowed).
- **Context Usage Breakdown (B4)**: Detailed breakdown categories (`kind: used | free`) rendered in session rail cards.
- **File Checkpointing & Rewind (B5)**: Checkpoint uuid tracking on user messages with interactive "rewind here" affordances.
- **Prompt Suggestions & Subagent Progress (B6)**: Suggestion chips under the composer and subagent live step progress inside tool cards.
- **Elicitation Forms (B7)**: URL and form-mode cards for connector authorization with approve/decline/cancel actions.
- **Worker Threads (B10)**: Heavy operations (file indexing, transcript search, shell path discovery) execute on `worker_threads` with synchronous fallbacks.

### Phase C — Performance & UX
- **Transcript Virtualization (C1)**: Sliding DOM window of 100 messages with scroll spacers to maintain 60 FPS performance on large conversations.
- **Rail DOM Diffing (C2)**: In-place replacement of changed cards only, preserving focus, hover states, and scroll positions.
- **Connector Tool Selection & Reconnect (C3, C6)**: Per-connector active tool pickers and exponential reconnect backoff with status peeking.
- **Skill and Agent Pruning UI (C4)**: UI switch controls to enable or disable synced skills and agents persistently in `~/.claude/cce-disabled.json`.
- **Multi-Window Persistence (C7)**: Workspace state and window layout restoration per window.

### Phase D — Quality, Verification & CI
- **Ambient Token Flake Immune (D1)**: Isolated test runner configuration unsetting ambient tokens.
- **Mutation Testing (D2)**: Configured Stryker for providers, adapters, proxy, and toolfilter.
- **E2E Smoke Harness (D3)**: Dependency-free Chrome DevTools Protocol smoke test (`test/e2e/smoke.mjs`).
- **Comprehensive CI (D4)**: Lint, test, build, and E2E verification workflow on GitHub Actions.

## Verification Checklist
- [x] All 72 test suites passing (844/844 unit & integration tests)
- [x] Clean commit history and formatting
- [x] Version bumped to 0.9.38 in `package.json` and documented in `CHANGELOG.md`
- [x] GitHub Pull Request opened and passing CI
