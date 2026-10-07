# Claude Code Enhanced (CCE)

A Linux desktop app that gives the **claude CLI** a real desktop-app interface — plus the
terminal when you want it:

- **Desktop-style chat (v0.2+)** — built on the official
  [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript), rendering the
  same message stream the Claude Code desktop app is built on:
  - streaming responses with live **thinking** blocks and Markdown
  - **tool-call cards**: Bash output, Read/Edit/Write with inline **diffs**, Grep/Glob,
    Web fetch/search, subagent (Task) cards, MCP tools — collapse/expand each one
  - **permission prompts** in the flow: *Allow once / Allow for session / Deny* (and
    **plan approval** cards in plan mode)
  - **model selector** that switches mid-conversation (`query.setModel`) — provider default,
    Opus/Sonnet/Haiku aliases, or any custom model id
  - **mode selector** (normal / accept edits / plan / yolo) — also switchable mid-session
  - **skills panel** (from the live session + `~/.claude/skills` and project skills) and a
    **slash-command palette** (`/` in the composer, built from the session's command list)
  - todo drawer, cost/turn/usage status line, interrupt with `Esc`
  - session **resume** per folder ("resume previous conversation")
- **FCC-style terminal tabs** — real PTYs running the genuine `claude` TUI for `/login`,
  `/mcp` OAuth flows, and raw control. *(Inspired by
  [free-claude-code](https://github.com/Alishahryar1/free-claude-code).)*
- **OpenCode-style provider manager** — switch model providers per session via
  `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`
  environment injection. Presets for Anthropic (subscription OAuth or API key), Z.AI GLM,
  DeepSeek, Moonshot Kimi, OpenRouter, and any custom Anthropic-compatible endpoint.
  *(Inspired by [OpenCode](https://github.com/sst/opencode) and FCC's multi-provider catalog.)*
- **Claude-Desktop-style OAuth connectors** — one-click add of remote MCP servers; OAuth is
  completed inside any session with the `/mcp` command. Presets:
  | Connector | Endpoint | Auth |
  |---|---|---|
  | GitHub | `https://api.githubcopilot.com/mcp/` | OAuth (or PAT header) |
  | Supabase | `https://mcp.supabase.com/mcp` | OAuth |
  | Lovable | `https://mcp.lovable.dev` | OAuth |
  | Linear | `https://mcp.linear.app/mcp` | OAuth |
  | Notion | `https://mcp.notion.com/mcp` | OAuth |
  | Playwright (local) | `npx @playwright/mcp@latest` | none |
  | Context7 (local) | `npx -y @upstash/context7-mcp` | none |

## Install

```bash
# from the repo root
sudo apt install ./dist/claude-code-enhanced-0.1.0-amd64.deb
# or: sudo dpkg -i dist/claude-code-enhanced-0.1.0-amd64.deb
```

Launch **Claude Code Enhanced** from your application menu, or run `claude-code-enhanced`.

Requirements: the [claude CLI](https://github.com/anthropics/claude-code)
(`curl -fsSL https://claude.ai/install.sh | bash`) — the app auto-detects it at
`~/.local/bin/claude`, `/usr/local/bin/claude`, etc.; you can override the path in Settings.

## Build from source

```bash
npm install        # also compiles node-pty for Electron
npm start          # run unpackaged
npm run dist       # build dist/claude-code-enhanced-<version>-amd64.deb
```

## Using providers

1. **Providers** panel → **Add provider** (or edit the default *Anthropic · Claude subscription*).
2. Pick a preset, paste the API token, optionally set `ANTHROPIC_MODEL`.
3. Star a provider to make it the default for new sessions.
4. Anthropic subscription users don't need a key: tick **Send /login after launch** (or type
   `/login` in any session) and complete the OAuth flow in the browser.

Secrets are stored in `~/.config/Claude Code Enhanced/config.json` with `0600` permissions.

## Using connectors

1. **Connectors** panel → pick a scope (`user` = all projects, `project` = `.mcp.json`).
2. Click **Add connector** — it runs `claude mcp add --transport http <name> <url> --scope …`.
3. In any terminal session, run `/mcp` and choose **Authenticate** for the OAuth popup.

## Architecture

```
┌────────────────────────── Electron ──────────────────────────┐
│ renderer                     ↔        main process           │
│  • chat tabs (Agent SDK UI)        • chats.js → @anthropic-   │
│    messages, tool cards,             claude-agent-sdk query() │
│    permissions, model/mode           streaming-input sessions │
│  • terminal tabs (xterm.js)        • sessions.js → node-pty   │
│  • providers / connectors /          spawns `claude` / shell  │
│    settings panels                 • providers env injection  │
└───────────────────────────────────────────────────────────────┘
        ↕ child_process (claude mcp add/list/remove)
   claude CLI config (~/.claude.json, .mcp.json, ~/.claude/skills)
```

Chat tabs never patch the CLI — the Agent SDK drives the real `claude` engine
(streaming input, permission callbacks, session resume), so skills, hooks, MCP
servers and settings from `~/.claude` all apply exactly as in the terminal.

### IPC surface (main ↔ renderer)

`session:create/write/resize/kill` · `pty:data` / `pty:exit` events ·
`providers:all/save/delete/default` · `connectors:presets/list/add/remove` ·
`settings:get/set` · `dialog:pickDir`

### Keyboard

`Ctrl+Shift+T` new session · `Ctrl+Shift+W` close tab · `Ctrl+Tab` next tab ·
`Ctrl+Shift+C/V` copy/paste

## References

- [anthropics/claude-code](https://github.com/anthropics/claude-code) — the wrapped CLI
- [Alishahryar1/free-claude-code](https://github.com/Alishahryar1/free-claude-code) — FCC:
  multi-provider routing + the terminal-first UX this app reproduces
- [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) — CLI
  internals research
- [ChinaSiro/claude-code-sourcemap](https://github.com/ChinaSiro/claude-code-sourcemap) —
  CLI source maps
- [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) —
  enhancement ecosystem (commands, hooks, MCP)
- [Donchitos/Claude-Code-Game-Studios](https://github.com/Donchitos/Claude-Code-Game-Studios) —
  workflow/prompt collections
- Connector endpoints: [Supabase remote MCP](https://supabase.com/blog/announcing-supabase-remote-mcp-server),
  [lovablelabs/mcp](https://github.com/lovablelabs/mcp), [GitHub MCP docs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-pre-written-building-blocks/scanning-for-secrets-with-the-github-mcp-server)

## Roadmap ideas

- FCC-style provider **failover chains** (retry a turn across providers)
- RTK-style output filtering to cut token usage
- Session resume picker (`claude --resume`) per project
- Light theme, split panes, multi-window

## Troubleshooting

- **`node-pty failed to load`** → `npm run rebuild`
- **Blank window on exotic kernels** → do *not* run with `--no-sandbox`; the default
  Chromium sandbox is required for renderer shared memory on this machine's kernel.
- **claude not found** → Settings → Claude CLI → *Auto-detect*, or install via install.sh.
