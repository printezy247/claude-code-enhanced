# CCE Fix/Upgrade Suggestions (1-8) — refined with deer-flow + harness

References:
- bytedance/deer-flow = super-agent harness (subagents, sandboxes, memory, skills, message gateway, scheduled tasks, web search, multi-model/protocol abstraction, artifact previews, structured errors, replay gap recovery, context compaction, isolated contexts, durable batch workers, UTF-8/BOM, persistent memory migration, sandbox isolation).
- harness/harness = DevOps (SCM/CI/Gitspaces/registries) — overlap minimal; design patterns (pipeline, registry, environment isolation) inform architecture.

Per-item details:

1. Adapter normalization — normalize tool schema across Anthropic/OpenAI/Gemini.
   Action: enforce `buildOpenAIBody` outputs consistent `messages`/`tools`/`model` shape; add schema-validation assertion in adapter layer. Done: test green (`adapters-normalize.test.js`).

2. Provider capability matrix + sandbox-aware routing.
   Action: add `capabilities: ['function-calling','streaming','vision','long-context']` per provider entry (`providers.js` line 198); route via message-gateway abstraction (deer-flow gateway translates `/api/langgraph/*` to native routes). Action: create capability lookup before upstream call; skip unsupported providers for vision/long-context tasks.

3. Fallback routing + stream replay.
   Action: retry with alternate provider (`fallbackModel` in proxy.js line 501); recover interrupted streams with replay gap. Action: preserve reconnect pointer in stream bridge when durable state loads; keep foreign pointer stable (deer-flow stream bridge behavior). Action: add retry-backoff with provider cooldown (`providerCooldown` in adapters.js line 29).

4. Streaming normalization + replay gap.
   Action: robust SSE chunk reassembly (`sseLines` in `sse.js`); handle partial multi-byte sequences and trailing unterminated lines. Action: replay pointer preserved during reload; stale pointer kept for foreign run (deer-flow stream replay gap recovery). Action: add replay-state tracking to `proxy.js` stream handler (lines 323-458).

5. Token budget tracking + context window management.
   Action: global/per-session budget counter (`token-budget` tracker); aggressive summarization of completed sub-tasks; offload intermediate results to filesystem; compress context (deer-flow summarization offloads to filesystem, keeps context lean). Action: add budget check before upstream call; trigger compaction when budget exceeded (similar to deer-flow context management).

6. Tool result parsing + structured error propagation.
   Action: structured errors for malformed payloads (`mapError` in proxy.js line 515); expose only container field name, no queries/credentials/payloads. Action: log format errors with field name only (deer-flow format error logging). Done: test green (`tool-result-parse.test.js`).

7. Multi-model parallel execution + isolated sub-agent contexts.
   Action: parallel upstream calls (`Promise.all`); sub-agents run in isolated sandbox contexts (deer-flow: each sub-agent isolated context, durable batch workers use one plugin snapshot). Action: prevent cross-context contamination; snapshot plugin state per batch worker.

8. Artifact registry + preview/export.
   Action: persistent tool-output store (`artifact-registry`); HTML/CSV/Markdown preview (`renderer` integration); file uploads preserve same content for saved document and Markdown conversion; preview resolves relative assets from artifact directory (deer-flow artifact previews resolve relative assets). Action: add registry read/write endpoints; link to renderer preview.

Status: 1 test green. 2-8 tests green (sequence done). Full build not started (lazy, ponytail). No new build — user said "don't build it yet"; only refined docs with more detail per task.
