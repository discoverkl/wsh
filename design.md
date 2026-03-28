# wsh Design Notes

## Architecture

wsh has three session types: **TUI apps** (terminal programs), **web apps** (HTTP servers in iframes), and **job sessions** (non-interactive processes that run to completion).

```
TUI:  Browser (xterm.js)  <--WS-->  server.ts  <--bytes-->  node-pty (bash/python/etc.)
Web:  Browser (iframe)     <--HTTP/WS-->  server.ts (reverse proxy)  <--HTTP/WS-->  child process
      Browser (xterm.js)   <--WS-->  server.ts  <--log stream-->  child stdout/stderr
Job:  (no UI required)     <--WS-->  server.ts  <--stdout/stderr-->  child process (runs to completion)
```

Both PTY and web app processes are spawned via `/bin/sh -c` (not `$SHELL`). The wrapper shell is a trampoline that immediately `exec`s the real command — using `/bin/sh` avoids profile scripts that could override `cwd` or env. The app's own command decides whether to be a login shell (e.g. `bash -l`).

**Shared-session model**: URLs have the form `{BASE}{appName}#{sessionId}`. The app name selects which program to run; the session ID (6-char base-36) identifies the process. Multiple browser tabs can connect to the same session — one active writer, any number of viewers.

**Hash passthrough**: The hash supports a compound format `#{sessionId}/{appHash}` — everything after the first `/` is relayed to/from web app iframes (bidirectional sync via direct `location.hash` set for same-origin, `postMessage` with `{ type: 'wsh:hash', hash }` for cross-origin). Existing `#sessionId` URLs (no `/`) are unaffected.

## Message Protocol

**Client -> Server:**
- **Binary**: Raw bytes forwarded to PTY (keyboard input, legacy X10 mouse). No-op for web apps.
- **Text/JSON**: Control messages — `resize`, `close`, `clear`, `pin`

**Server -> Client:**
- **Binary**: Raw PTY output (TUI) or stdout/stderr log stream (web)
- **Text/JSON**: `role` (with `app`, `appType`, `credential`, `pinned`, `pinnedOther`), `pin`, `ready`, `status`, `cookie`, `rpc`

## Session Lifecycle

### TUI Sessions

```
owner connects   --> PTY spawned, added to sessions map
writer disconnects --> promote next owner/writer peer
                      if none: scheduleCleanup()
  pinned=true    --> no timer, lives until PTY exits or manual close
  pinned=false   --> SESSION_TTL (10 min), then SIGTERM -> SIGKILL
any peer reconnects --> cancel cleanup timer
PTY exits        --> all peers closed, session deleted immediately
```

### Web Sessions

```
owner connects   --> child process spawned, health check polls in background
                     server sends { type: 'ready' } when health check passes
writer disconnects --> same promotion logic as TUI
  pinned=true    --> no timer
  pinned=false   --> timeoutMs (default 1h, configurable via `timeout` field)
child exits      --> all peers closed, session deleted immediately
```

### Job Sessions

```
created via API  --> child process spawned, stdout/stderr tee'd to scrollback + disk (~/.wsh/logs/<id>.log)
                     no port, no health check, no keyboard input
WS peers connect --> receive scrollback replay + live output (read-only)
wsh logs <id>    --> reads from disk file (works during and after execution, survives server restarts)
wsh logs -f <id> --> reads disk file for catch-up, then EventEmitter for live chunks
child exits      --> 'job-exit' event emitted, fd closed, session deleted immediately
```

Jobs are non-interactive background tasks (cron runs, chat agent invocations). Output is written to disk incrementally via `fs.writeSync` so it survives server restarts. They are visible in `wsh ls` with `appType: 'job'` and provide box-level activity tracking for idle detection and graceful upgrades.

The cleanup timer starts from the moment of disconnect, not from last activity. Sessions created via API (with no initial viewer) also get a timer at creation via `registerSession()`, ensuring they are cleaned up if no peer ever connects.

### Common Rules

- Only owners can create sessions; non-owners get rejected with WS close code 4003
- On reconnect, the full scrollback buffer is replayed (up to 5 MB for TUI, 512 KB for web, 1 MB for job). Job logs are also persisted to disk for durability.
- Only one active writer at a time; a new writer demotes the current one to viewer
- Only owners can close sessions or toggle pin state; writers can resize and clear
- Pin state is in-memory only; a server restart resets it (processes die anyway)

## Authentication & Access Control

### Tokens

All tokens are derived from the TLS private key generated on first run (`~/.wsh/tls/`):

| Token | Derivation | Format | Delivery |
|---|---|---|---|
| **Owner** | `SHA256(TLS key)[0:16]` | 16-char hex | `HttpOnly` cookie `wsh_token` |
| **Writer** | `SHA256(TLS key + salt + sessionId)[0:16]` | 16-char hex, per-session | URL param `?wt=<token>` |
| **Viewer** | *(none)* | Session ID itself is the secret | URL hash `#<sessionId>` |

Stateless derivation — the server can recompute any session's writer token without storing it.

### Transport

| Context | Protocol | Auth required |
|---|---|---|
| Localhost | HTTP | No — loopback is always owner |
| LAN | HTTPS (self-signed) | Yes — owner token or share link |

### Roles

Three roles: **owner > writer > viewer**.

| Action | Owner | Writer | Viewer |
|---|---|---|---|
| Create session | yes | — | — |
| Input (type) | yes | yes | — |
| Resize / Clear | yes | yes | — |
| Close / Pin | yes | — | — |

### Role Assignment

Evaluated top-to-bottom; first match wins.

**Standard mode:**

| Condition | Role |
|---|---|
| Loopback or no TLS configured | owner |
| `wsh_token` cookie matches | owner |
| `?wtoken=` matches writer token | writer |
| `?wtoken=` present but invalid | **rejected** |
| No credentials | viewer |

**`--trust-proxy` mode** (for reverse-proxy deployments):

Requires `WSH_PROXY_SECRET` env var. Every request must include a matching `X-WSH-Proxy-Secret` header. The proxy sets `X-WSH-User` to identify the caller.

| `X-WSH-User` | Role |
|---|---|
| Matches `ABOX_USER` env or `*` | owner |
| Other + valid `?wtoken=` | writer |
| Other | viewer |
| Missing | **rejected** |

### Writer Management

- Only one active writer per session at a time; a new writer demotes the current one.
- `?yield=1` lets an owner/writer rejoin as viewer without displacing the current writer.
- On writer disconnect, the server promotes the first peer with owner credential, then writer credential. If none, cleanup timer starts.

## App Configuration

Apps load from three layers (field-level merge):

1. **Default**: `bash`
2. **System**: `/etc/wsh/apps.yaml`
3. **User**: `~/.wsh/apps.yaml`

Keys starting with `_` are reserved (e.g. `_skills`).

## Web App Proxy

Apps must be proxy-aware and configure their own base URL using `$WSH_BASE_URL`. The proxy does not rewrite `Location` headers or `Set-Cookie` paths.

`stripPrefix: true` is available for simple apps that use relative paths (SPAs, static file servers).

Environment injected into web app processes: `WSH_PORT` (the port the app should listen on), `WSH_SESSION`, `WSH_BASE_URL`.

## Port Discovery

The server writes its port to `~/.wsh/port` on startup. CLI subcommands (`ls`, `new`, `logs`, `kill`, `port`, `rpc`) read this file to find the server — no environment variables needed. The `--port` flag overrides if provided.

`WSH_PORT` is reserved for web apps: it tells the app which port to listen on. It is **not** the server port.

## RPC (PTY-to-Client / Server-to-Client)

All RPC is `eval` — the server delivers JavaScript to connected browser clients for execution. Pages expose capabilities on `window.api` (defined in `src/api.ts`). PTY processes, server code, or external tools can call any `api.*` function.

**Entry points:**
- **CLI**: `wsh rpc '<code>'` (defaults to own session via `$WSH_SESSION`; `--session <id>`, `--session index`, `--broadcast`; `-` reads stdin)
- **Server code**: `broadcastRpc('eval', code)` / `sessionRpc(id, 'eval', code)`
- **Control WebSocket**: Pages without a terminal connect with `session=_rpc` to receive broadcasts

**Built-in `api` functions** (`src/api.ts`): `api.toast(msg)` — toast notifications (text/html, raw mode, configurable duration, swipe-to-dismiss). Catalog adds `api.refreshCatalog()`, `api.sessionReady()`. Web app pages add `api.getSnapshot()` — returns a full app snapshot (DOM, console, network, storage) for skill agents.

**Transport**: OSC 777 escape sequences (`\x1b]777;wsh:eval;<code>\x07`) or HTTP POST to `/api/rpc`.

## Skills

Skills are apps with a `skill` field whose command template references `$SKILL` and `$INPUT` env vars. The `_skills` reserved key provides shared defaults (command, cwd) for all skill apps.

When a skill session is spawned with a `snapshot` in the POST body, the server writes it to `~/.wsh/snapshots/<agentSessionId>.md` before spawning the PTY. The skill reads the file via the predictable path `~/.wsh/snapshots/$WSH_SESSION.md` — faster than reading a large env var through bash. Snapshot files are cleaned up on PTY exit.

## Distribution

Single Go binary. Downloads and caches Node.js LTS to `~/.wsh/node/`. Embeds `dist/`, `public/`, `node_modules/` (~15-18 MB). Build must run on the target platform.
