# wsh Design Notes

## Architecture

wsh has two modes: **TUI apps** (terminal programs) and **web apps** (HTTP servers in iframes).

```
TUI:  Browser (xterm.js)  <--WS-->  server.ts  <--bytes-->  node-pty (bash/python/etc.)
Web:  Browser (iframe)     <--HTTP/WS-->  server.ts (reverse proxy)  <--HTTP/WS-->  child process
      Browser (xterm.js)   <--WS-->  server.ts  <--log stream-->  child stdout/stderr
```

**Shared-session model**: URLs have the form `{BASE}{appName}#{sessionId}`. The app name selects which program to run; the session ID (6-char base-36) identifies the process. Multiple browser tabs can connect to the same session — one active writer, any number of viewers.

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

The cleanup timer starts from the moment of disconnect, not from last activity.

### Common Rules

- Only owners can create sessions; non-owners get rejected with WS close code 4003
- On reconnect, the full scrollback buffer is replayed (up to 5 MB for TUI, 512 KB for web)
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

Environment injected into web app processes: `WSH_PORT`, `WSH_SESSION`, `WSH_BASE_URL`.

## RPC (PTY-to-Client / Server-to-Client)

A running PTY process can trigger client-side actions by writing an OSC 777 escape sequence to stdout. The server intercepts and strips these from the terminal stream, forwarding them as JSON `{ type: 'rpc', action, args }` messages over WebSocket. Server code can also send RPCs directly via `sessionRpc()` or `broadcastRpc()`.

**OSC protocol**: `\x1b]777;wsh:<action>[;<arg1>;<arg2>...]\x07` — parts are percent-encoded (control chars, `%`, `;`).

**Three entry points:**
- **PTY process**: `wsh rpc <action> [args...]` (or raw `printf`)
- **Server code**: `sessionRpc(id, action, ...args)` / `broadcastRpc(action, ...args)`
- **Control WebSocket**: Pages without a terminal can connect with `session=_rpc` to receive broadcasts

**Client handling** (`src/wsh-rpc.ts`): RPC messages are dispatched as `wsh-rpc` CustomEvents on the DOM. Pages register handlers via `onRpc(action, handler)`.

## Skills

Skills are apps with a `skill` field whose command template references `$SKILL` and `$INPUT` env vars. The `_skills` reserved key provides shared defaults (command, cwd) for all skill apps.

## Distribution

Single Go binary. Downloads and caches Node.js LTS to `~/.wsh/node/`. Embeds `dist/`, `public/`, `node_modules/` (~15-18 MB). Build must run on the target platform.
