# Changelog

All notable changes to Claude Code Enhanced will be documented in this file.

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
