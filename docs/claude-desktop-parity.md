# Claude Desktop 2.42304.2 — REA review and CCE upgrade plan

Source: `/var/cache/apt/archives/claude-desktop_2.42304.2_amd64.deb`
(`/usr/lib/claude-desktop/resources/app.asar`, `@ant/desktop` 2.42304.2,
`@anthropic-ai/claude-agent-sdk` 0.3.299).

Analysis performed with REA (`morluto/rea` 6.7.0):
`rea analyze-javascript-application resources/app.asar` →
447 inventoried files, 432 parsed, 7.8M AST nodes, 8,243 findings, 14,857 function
nodes, 70,882 relations, 100,000 retained semantic nodes (per-node cap).
The `app.asar` was also extracted and read directly for the strings REA can only
partially resolve (IPC channel names, connector function names, i18n labels).

## 1. What the desktop build actually contains

### 1.1 Main-process modules (`.vite/build`)

| module | role |
|---|---|
| `index.pre.js` | main entry: windows, IPC registration, `to` channel enum, origin validation for every renderer call |
| `mainView.js` | main window view wiring |
| `index.chunk-*.js` (17 files) | the bulk: chat engine wiring, connectors, sandbox, plugins, telemetry |
| `mcp-runtime/`, `pty-host/` | MCP and PTY runtimes as separate processes |
| `file-index-worker/`, `heavy-work-worker/`, `transcript-search-worker/`, `stall-sampler-worker/`, `shell-path-worker/` | workers |
| `aboutWindow.js`, `buddy.js`, `computerUseTeach.js`, `coworkArtifact.js`, `designWindow.js`, `claudePagePreview.js`, `findInPage.js` | auxiliary windows |

Named-function counts per module (REA `semantic_graph`, functions only):

```
file-index-worker/fileIndexWorker.js      3,532 total / 2,592 unique
heavy-work-worker/heavyWorkWorker.js      2,518 total / 1,758 unique
heavy-work-worker/dist-CI9lzb1v.js         920 total /   350 unique
aboutWindow.js                             523 total /   475 unique
findInPage.js                              519 total /   471 unique
computerUseTeach.js                         51 total /    39 unique
buddy.js                                    26 total /    24 unique
coworkArtifact.js                            9 total /     9 unique
claudePagePreview.js                         5 total /     3 unique
designWindow.js                              4 total /     3 unique
```

(The bulk of the 14,857 function nodes are minified. The named subset above is
the whole named-function surface REA could resolve in those modules; the
capability-bearing names live in the chunk files, listed in §1.3–1.5.)

### 1.2 IPC and Electron boundary (REA `graph`)

- 92 `ipc-channel` nodes, 27 `ipc-handler` nodes, 18 `context-bridge-api` nodes.
- 1,487 IPC operations, 1,478 of them with a dynamic channel expression
  (minified indirection) — REA's `ipc-channel` nodes are therefore mostly
  unresolved; the resolved surface comes from the main-process channel enum:

```
list-mcp-servers            connect-to-mcp-server        mcp-server-connected
request-open-mcp-settings   mcp-server-auto-reconnect    cowork-session-folders-updated
cowork-session-directories-staged
```

- 50 context-bridge APIs, 37 exposed members, 56 sender-validation observations.
  The renderer never calls `ipcRenderer` directly: every bridge call is
  origin-validated (`hSe`/`gSe`/`_Se`/`vSe`/`ySe` error factories in
  `index.chunk-DOx99pQU.js`).
- 4 browser windows, 1 utility process, 2 native addons
  (`@ant/claude-native`, `node-pty`).

### 1.3 Connector surface (the tool-calling surface)

Connector functions recovered from the chunk files:

```
list_connectors                suggest_connectors            registry__list_connectors
registry__suggest_connectors    connectorTools                connectorToolsFor
connectorToolsBySession        connectorPoolFor              connectorPoolInputs
getSessionConnectorStatus      setSessionConnectorEnabled    respondSessionConnectorToggle
requestSessionConnectorReconnect  retrySessionConnector       reconnect_session_connector
session_connectors_status      session_connector_toggle_request  session_connector_reconnected
getProxiedConnectorCall        proxiedConnectorCalls         keepConnectorCall
endConnectorRun                isDestructiveConnectorTool    isConnectorUrlWithheld
connectorRegistryVerified      connectorResync               connectorSwitchConsents
resolveConnectorSwitch         recordConnectorSwitchConsent  retireConnectorSwitchConsent
```

Behaviour implied by the desktop build:

1. **Connectors are first-class session members.** A connector has an owner, a
   session home (`connectorHomeForSession`), a tool list
   (`connectorToolsBySession`) and a per-session enable switch
   (`setSessionConnectorEnabled` / `session_connector_toggle_request`).
2. **Connector calls are proxied**, not inlined: `getProxiedConnectorCall`,
   `proxiedConnectorCalls`, `keepConnectorCall` — the host owns the call, can
   keep it alive across turns, and ends it explicitly (`endConnectorRun`).
3. **Approvals are answered in the app** (`connectorApprovalsAnsweredHere`),
   and destructive connector tools are detected explicitly
   (`isDestructiveConnectorTool`).
4. **A connector can be retried / reconnected** live
   (`retrySessionConnector`, `reconnect_session_connector`,
   `requestSessionConnectorReconnect`).
5. **Connector URLs can be withheld** from the model (`isConnectorUrlWithheld`),
   and tool use is vouched for the registry
   (`connectorRegistryVouchedToolUses`).
6. The Claude.ai connector directory is a separate store
   (`ccd_connectors`, `ccd_directory`, `list_connectors`).

### 1.4 Tool-calling / SDK surface

The desktop build drives the same Agent SDK as CCE, with these options in use
(recovered from the chunk files): `canUseTool`, `onElicitation`,
`settingSources`, `includePartialMessages`, `includeHookEvents`,
`enableFileCheckpointing`, `forwardSubagentText`, `promptSuggestions`,
`agentProgressSummaries`, `askUserQuestionTimeout`, `agents`, `allowedTools`,
`disallowedTools`, `hooks`, `plugins`, `outputStyle`, `outputStyles`,
`systemPrompt`, `strictMcpConfig`, `mcpServers`, `sandbox`, `betas`, `effort`,
`thinking`, `maxTurns`, `maxBudgetUsd`, `fallbackModel`, `resume`,
`resumeSessionAt`, `forkSession`, `pathToClaudeCodeExecutable`, `extraArgs`,
`stderr`, `env`, `cwd`, `model`, `permissionMode`, `abortController`.

Control requests used: `mcp_status`, `mcp_set_servers`, `mcp_reconnect`,
`mcp_toggle`, `mcp_read_resource`, `mcp_call`, `mcp_message`,
`get_context_usage`, `rewind_files`, `apply_flag_settings`, `reload_skills`,
`reload_plugins`, `reload_output_styles`, `stop_task`, `background_tasks`,
`get_task_output`, `list_permission_rules`, `request_user_dialog`,
`elicitation`, `hook_callback`, `file_suggestions`.

Host-side permission handling found in the build (the `canUseTool` pipeline):
path policy (`is read-only in this session`, `Path is outside allowed working
directories`), VM-path denial, write-tool block rules, `updatedInput` pinning
(`allow pinned to the judged input`), and the `always_ask` / `always_deny`
per-tool policy for connector tools.

### 1.5 Right-hand rail (desktop layout)

From the shipped renderer bundles (`ion-dist/assets/v1/*.js`, the Claude Code
tab) the right rail is a stack of panes, not one panel:

```
Terminal · Changes (diff) · Preview / Browser · Files · Artifacts
Side chat · Background tasks · Plan · Runs
```

and the session column lists:

```
Environment · Goal · Settings · Connectors · Context · Usage · Progress
Outputs · Changes · Servers
```

The context card is a live usage readout: `Context window` vs `Usage`, a
percentage ring, `Plan usage` / `Usage limits`, and a per-category breakdown
(`categories[]` with `kind: used | free | buffer | deferred`).

## 2. Gaps in CCE 0.9.32 (what was actually broken)

| # | gap | evidence | fix |
|---|---|---|---|
| 1 | Connectors were CLI-only. The panel added servers to the CLI config, but a **running chat could not use them** and their tool list was never shown. | desktop: `setSessionConnectorEnabled`, `connectorToolsBySession`, `getProxiedConnectorCall` | `connectors.js` now parses `claude mcp get` into an SDK `McpServerConfig`; `chats.mcpConnect` registers it with `setMcpServers` so the tools are live in the open session; the panel shows the tool count and a per-connector **ask every time** policy (`always_ask`). |
| 2 | The right rail only ever rendered the **Context** card. Environment, Changes and Connectors were dropped. | `git:info` returned no `ok` field; `renderTasks` bailed on `!r.ok` | `git:info` now answers `{ ok: true, … }`; the rail renders Environment, Context (with the category breakdown), Connectors and Tasks. |
| 3 | The right-rail **Terminal** was an empty xterm with no PTY behind it — nothing rendered, nothing could be typed. | `renderSplit` created a `Terminal` and never attached a session | the rail now spawns a real `session:create` shell and routes `pty:data` / `session:write` for it. |
| 4 | The rail had no **Files** view and no way to see the folder. | desktop: `Files` pane | added a Files pane (project file list) and a Files entry in the pane selector. |
| 5 | The context card showed one number. The desktop shows a per-category breakdown. | desktop: `categories[]` with `kind` | the card now lists the categories with their colour and token count. |
| 6 | Every chat started with no voice and no method. caveman / rtk / superpowers were never mentioned. | — | `src/main/bootstrap.js` detects the toolkits **on disk** and appends them to the engine's system prompt (caveman lite, rtk, superpowers/brainstorming, connector tool access). Nothing is announced that is not installed. |
| 7 | The UI had 3D/elevated styling: nine large drop-shadows and a metallic gradient on filled controls. | — | flat pass: shadows removed, the metal gradient replaced with a flat token. |

## 3. What was built (this pass)

### 3.1 Tool calling with connectors

- `src/main/connectors.js`
  - `parseMcpDefinition(output)` → `{type:'http'|'sse'|'stdio', url|command, args, headers}`
  - `definition(claudePath, name)` / `definitions(claudePath)`
- `src/main/chats.js`
  - `mcpConnect(id, name, config, alwaysAsk)` — registers the connector with the
    live session via `setMcpServers`; `alwaysAsk` attaches the SDK's
    per-tool `permission_policy: 'always_ask'`.
  - `mcpDisconnect(id, name)`
- `src/main/main.js` — `chat:mcp` gains `op: 'connect' | 'disconnect'`.
- Renderer — the Connectors list gets **connect to chat**; the chat MCP panel
  shows the tool count and an **ask every time** button; the rail has a
  **Connectors** card with a per-server enable switch.

### 3.2 Right rail

- `Environment` (folder + branch + repo + dirty count), `Context` (window usage
  + category breakdown), `Connectors` (per-server tool count + toggle),
  `Tasks` (agent todos), `Changes` (working-tree files).
- New panes: `Files`, and a `Terminal` pane with a real PTY.
- Pane selector renamed `Tasks` → `Overview`; `Files` added.

### 3.3 Minimalist UI

- All nine large drop-shadows removed; surfaces are separated by 1px borders.
- `--metal` is a flat colour instead of a brushed gradient.
- Nothing else moved: contrast tokens, focus rings and the reduced-motion
  block are untouched (the a11y and motion suites still pass).

### 3.4 Chat bootstrap

- `src/main/bootstrap.js` — `detect()`, `capabilities()`, `promptAppend()`.
  Detection is disk-based (`~/.claude/skills`, `~/.claude/plugins/**`), trashed
  copies are ignored, and the prompt only mentions what exists.
- `src/main/chats.js` — the append is added to the engine's system prompt as
  `{ type: 'preset', preset: 'claude_code', append, snapshot: true }`, so the
  Claude Code prompt is preserved and the bootstrap rides on top.

On this machine it resolves to: caveman `~/.claude/skills/synced/…/caveman`,
superpowers `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1`
(brainstorming present), rtk **not installed** — so rtk is not announced.

## 4. Still open (deliberately not built)

| item | why not now |
|---|---|
| `getProxiedConnectorCall` / `keepConnectorCall` (host-owned connector calls) | needs a host-side MCP client per connector; the SDK's own proxy covers the common case. |
| `connectorUrlWithheld` (hiding connector URLs from the model) | needs per-tool input rewriting in the host. |
| `isDestructiveConnectorTool` → auto-ask | the SDK's `always_ask` policy covers the same ground from the host side. |
| Claude.ai connector directory (`ccd_connectors`) | needs the Anthropic account API; out of scope for a local harness. |
| Desktop simulator / artifacts / side chat panes | product features of the Claude.ai app, not the Code surface. |

## 5. Verification

- `npm test` — 500 tests / 40 files, all green.
  New suites: `test/bootstrap.test.js` (detection + prompt),
  `test/connector-definitions.test.js` (`claude mcp get` parsing),
  `test/session-rail.test.js` (rail cards, context breakdown, connector card,
  live terminal PTY).
- `test/renderer-connectors.test.js` extended for the connect-to-chat action.
