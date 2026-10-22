# Deferred heavy items (phases 4-9 remainder)

The following items from the master plan and REA audit remain intentionally deferred
because they are product-surface features of Claude Desktop / Claude.ai or require
substantial external subsystems:

- **Host-owned connector calls** (`getProxiedConnectorCall`/`keepConnectorCall`): requires dedicated host-side MCP client daemon rather than delegating MCP server life-cycles to the CLI agent process.
- **Full crash recovery beyond draft/pending** (E.49): reconstruction of mid-turn assistant streams across hard process SIGKILL.
- **Side chat / artifacts / in-app browser panes** (G.61-63): Claude.ai web application features deliberately excluded from the Code desktop surface.
- **Claude.ai connector directory** (G.64): requires web-authenticated connector catalog sync.
- **connectorUrlWithheld / destructive-tool auto-ask** (G.65-67): connector credential redaction and specialized destructive action classifiers.
- **Remote / SSH parity** (G.68): headless remote host agent protocol.
- **Desktop auxiliary windows** (Buddy, computer-use teach, design canvas): auxiliary GUI product panes.

### Completed in 0.9.38
- Transcript virtualization (C1 / C.20)
- Rail DOM diffing (C2 / C.22)
- Connector active-selection UI (C3 / D.31)
- Skill & agent pruning UI (C4 / D.32)
- MCP reconnect backoff with exponential backoff (C6 / E.52)
- Per-window state restore and multi-window isolation (C7)
- Provider robustness & rate-limit Retry-After backoff (A1-A10)
- Workers for heavy work (file indexing, transcript search, shell-path resolution) (B10)
- Stryker mutation testing configuration & E2E smoke harness (D2, D3, D4)
