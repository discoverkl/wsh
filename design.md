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
- **Text/JSON**: `role` (with `app`, `appType`, `credential`, `pinned`, `pinnedOther`), `pin`, `ready`, `status`, `cookie`

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

The cleanup timer starts from the moment of disconnect, not from last activity. `lastOutput` is updated on proxy HTTP requests but is only used for `wsh ls` display, not for timeout decisions.

### Common Rules

- Only owners can create sessions; non-owners get rejected with WS close code 4003
- On reconnect, the full scrollback buffer is replayed (up to 5 MB for TUI, 512 KB for web)
- Only one active writer at a time; a new writer demotes the current one to viewer
- Only owners can close sessions or toggle pin state; writers can resize and clear
- `clear` resets the scrollback buffer and sends `\f` to redraw the prompt
- Pin state is in-memory only; a server restart resets it
- OSC title sequences (`\e]0;title\a`) are parsed from PTY output and stored on the session

## Roles and Access Control

Three roles: **owner**, **writer**, **viewer**.

| | Create | Input | Resize | Clear | Close | Pin |
|---|---|---|---|---|---|---|
| **Owner** | yes | yes | yes | yes | yes | yes |
| **Writer** | no | yes | yes | yes | no | no |
| **Viewer** | no | no | no | no | no | no |

**Role assignment** (server-side):
- Loopback or valid `wsh_token` cookie -> `owner`
- Valid writer token (`?wtoken=`) -> `writer`
- No credentials -> `viewer` (session ID alone is the viewer secret)

**Writer promotion**: When the active writer disconnects, the server promotes the first peer with `owner` or `writer` credential. If none exist, the cleanup timer starts.

**Default-to-viewer**: Opening an existing session in a new tab starts as viewer. Refreshing preserves the role. Tracked via a single `sessionStorage` key per session:

| Key | Values | Purpose |
|---|---|---|
| `wsh_role_{sessionId}` | `active` / `viewer` | `active` = connect as owner/writer; `viewer` = connect with `?yield=1` |

Set to `viewer` on first load with a hash (joining existing), `active` on first load without (creating new). Persists across refresh.

**Role switching**: Viewers with credentials see a clickable "View Only" badge; clicking it flips the key to `active` and reconnects. Writers see a clickable "Writer" badge to voluntarily demote.

## Security Model

- **Localhost**: Plain HTTP, no auth (loopback = owner)
- **LAN**: HTTPS with self-signed cert (generated on first run, stored in `~/.wsh/tls/`)
  - Fingerprint printed at startup for manual verification
- **Owner token**: 16-char hex from `SHA256(TLS private key)`, stored as `HttpOnly` cookie after first URL-based auth
- **Writer token**: 16-char hex per-session from `SHA256(TLS key + salt + session ID)`
  - Salt: random 32 bytes persisted in `~/.wsh/tls/writer-salt.txt`
- **Viewer access**: Session ID only (6-char base-36); treat as semi-private
- **Rate limiting**: Non-loopback IPs get at most 10 invalid session attempts per minute before WS close 4029

**Share URLs** (TUI apps only; generated via `GET /api/share?session=<id>`):
- Writer: `{base}/{app}#{id}?wt={token}`
- Viewer: `{base}/{app}#{id}`

## App Catalog

`GET {BASE}` serves `catalog.html` — a visual launcher showing all configured apps as cards with icons, descriptions, session counts, and type/access badges.

### Configuration

Apps load from three layers (each overrides the previous):

1. **Default**: `bash` (always available)
2. **System**: `/etc/wsh/apps.yaml`
3. **User**: `~/.wsh/apps.yaml`

Each layer falls back to `.json` if no `.yaml` is found.

```yaml
# String shorthand
python3: python3
htop: htop

# Full form
node:
  command: node
  args: [--inspect]
  title: Node.js REPL
  cwd: ~/projects
  env:
    NODE_ENV: development
```

**Common fields**: `command` (required), `args`, `title`, `icon`, `description`, `env`, `cwd`.

**Web app fields**: `type: web`, `access: public|private` (default `private`), `timeout: '1h'` (supports `ms`, `s`, `m`, `h`, `d`), `stripPrefix: true|false` (default `false`), `healthCheck: '/ready'` (default `/`), `startupTimeout: '60s'` (default `30s`).

### Session Creation

| Method | Description |
|---|---|
| `GET {BASE}{appName}` | Serves `index.html`; client generates ID, connects via WS with `?app=appName` |
| `POST {BASE}api/sessions` | Body `{ "app": "appName" }` — spawns a pinned session, returns `{ id, url }` |

### API

- `GET {BASE}api/apps` — list all apps: `{ apps: [{ key, title, command, icon, description, type, access }] }`
- `GET {BASE}api/sessions` — list active sessions (includes `id`, `title`, `app`, `appType`, `pinned`, `peers`, `hasWriter`, `createdAt`, `lastInput`, `lastOutput`, `pid`, `scrollbackSize`, `process`, `port`, `ready`)
- `DELETE {BASE}api/sessions/:id` — kill a session
- `GET {BASE}api/share?session=<id>` — get writer token for sharing

### CLI

- `wsh apps` — list available apps
- `wsh apps init` — create starter `~/.wsh/apps.yaml`
- `wsh new [app]` — create a session via API
- `wsh ls [-l] [--json]` — list active sessions
- `wsh kill <id>` — close a session

All CLI commands accept `-p, --port` and read `WSH_PORT` / `WSH_BASE_PATH` env vars.

## Web App Support

### How It Works

1. On first connect, the server spawns the app's command as a child process with `$WSH_PORT` set to a dynamically assigned free port
2. `pollUntilReady()` polls `http://127.0.0.1:{port}{healthCheck}` every 500ms (up to `startupTimeout`, default 30s) in the background
3. When the health check passes, the server sends `{ type: 'ready' }` to all connected peers
4. The client sets `iframe.src` to `./_p/{sessionId}/` to load the app

### Reverse Proxy

All requests to `{BASE}_p/{sessionId}/...` are proxied to `localhost:{port}`.

**Path forwarding** — two modes:
- **Default**: The full prefixed path is forwarded unchanged. Apps must configure `--base-url=$WSH_BASE_URL` (e.g., Jupyter's `--ServerApp.base_url=$WSH_BASE_URL`).
- **`stripPrefix: true`**: The `/_p/{sessionId}` prefix is stripped; the app receives plain paths starting at `/`. For simple servers like `python3 -m http.server` that can't configure a base URL.

No `Location` header or `Set-Cookie` path rewriting is performed.

The proxy also:
- Proxies WebSocket upgrades via raw TCP socket piping
- Returns 503 "Starting up..." while the health check is pending
- Returns 502 on proxy errors

**Environment variables** injected into web app processes:
- `WSH_PORT` — port the app must listen on
- `WSH_SESSION` — session ID
- `WSH_BASE_URL` — reverse proxy prefix path (e.g., `/_p/abc123/`)

### Access Control

Web apps use **app-level** access instead of per-session share links:

| `access` | Loopback | LAN with token | LAN without token |
|---|---|---|---|
| `private` (default) | allowed | allowed | **401** |
| `public` | allowed | allowed | allowed |

Checked on every HTTP request and WebSocket upgrade by the proxy handler itself (not the token middleware).

### Client Behavior

When the server sends `appType: 'web'` in the role message:
1. Shows `#web-container` with iframe instead of `#terminal-container`
2. Replaces "Clear" button with "Logs" toggle (switches between iframe and log terminal)
3. Hides the share button
4. Sets `convertEol: true` on the log terminal
5. Guards PTY-specific handlers (input, resize, binary) to no-op

### Last-Session Cookie

On web session creation, the server sends a `cookie` message. The client sets `wsh_last_{appKey}` so revisiting the same app URL reconnects to the existing session instead of creating a new one.

## Window Modes

Three modes — **pretty -> practical -> focused**:

| Mode | Trigger | Titlebar | Padding | Fullscreen |
|---|---|---|---|---|
| **Window** (default) | — | yes | yes | no |
| **Compact** (yellow dot) | `.compact` on `<html>` | yes | no | no |
| **Fullscreen** (green dot) | Fullscreen API | no | no | yes |

The red dot closes the session (owner-only). All transitions trigger `fitAddon.fit()`.

## Pinned Sessions Toast

When an owner connects, the server reports other pinned sessions. The client shows a dismissable toast with clickable chips (max 3, overflow count). Auto-dismisses after 8s. Deduplicated per tab via `sessionStorage`.

## Base Path Routing

`--base <path>` (default `/`) mounts everything under a URL prefix, normalized to start and end with `/`.

- Express router mounted at `BASE` via `app.use(BASE, router)`
- WebSocket upgrade checks `BASE + 'terminal'`
- Cookie `Path` set to `BASE`
- CLI reads `WSH_BASE_PATH` env var

**Example**: `wsh --base /alice/` -> `/alice/bash#session`, `/alice/terminal`, `/alice/api/sessions`.

## Terminal Compatibility

| Requirement | Implementation |
|---|---|
| `TERM=xterm-256color` | node-pty `name` field + explicit `env` |
| `COLORTERM=truecolor` | explicit `env` |
| Correct initial size | `fitAddon.fit()` + `sendResize` in `requestAnimationFrame` on WS open |
| Mouse support | xterm.js SGR mode; `onBinary` handles legacy X10 |
| Resize stability | 150ms debounce; `term.onResize` triggers the send |

- `convertEol: false` for TUI — PTY already emits `\r\n`
- `overflow: hidden` on body — prevents scrollbars that trigger FitAddon resize loops

## Distribution

Single Go binary, no prerequisites:

1. Downloads and caches Node.js LTS to `~/.wsh/node/` (SHA256 verified)
2. Extracts embedded app files to `~/.wsh/app/v{VERSION}/`
3. Execs `node dist/server.js`

Node.js (~30 MB) is downloaded, not embedded. The Go binary embeds `dist/`, `public/`, `node_modules/` (~15-18 MB), including the platform-native `pty.node` addon. Build must run on the target platform.
