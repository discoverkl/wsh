# wsh Design Notes

## Architecture

```
Browser (xterm.js)  <--WS-->  server.ts  <--bytes-->  node-pty (bash/claude)
```

**Shared-session model**: URLs have the form `{BASE}:appName#sessionId`. The app name selects which program to run; the session ID (6-char base-36) identifies the PTY. Multiple browser tabs can connect to the same session. Each session has exactly one PTY, one active writer, and any number of viewers.

**Message framing**:
- **Client -> Server (binary)**: Raw bytes forwarded to PTY (keyboard input, legacy X10 mouse)
- **Client -> Server (text/JSON)**: Control messages — `resize`, `close`, `clear`, `pin`
- **Server -> Client (binary)**: Raw PTY output
- **Server -> Client (text/JSON)**: Role assignments (`role` with `app`), pin state updates (`pin`)

## Critical Claude Code Requirements

| Requirement | Implementation |
|---|---|
| `TERM=xterm-256color` | node-pty `name` field + explicit `env` override |
| `COLORTERM=truecolor` | explicit `env` override |
| Correct initial size | `fitAddon.fit()` + `sendResize` in `requestAnimationFrame` on WS open |
| Mouse support | Automatic via xterm.js SGR mode; `onBinary` handles legacy X10 (bytes >127) |
| Resize stability | 150ms debounce; use `term.onResize` (not window event) as send trigger |

**`convertEol: false`** — PTY already emits `\r\n`; double-converting causes artifacts.
**`overflow: hidden` on body** — prevents scrollbars that shrink viewport and trigger FitAddon resize loops.

## Session Lifecycle

```
writer connects  --> session spawned (PTY created, added to sessions map)
writer disconnects --> promote next non-viewer peer to writer
                      if no promotable peer: scheduleCleanup()
  pinned=true   --> no timer, session lives until PTY exits or manual close
  pinned=false  --> SESSION_TTL (10 min) timer; expiry kills PTY + deletes session
any peer reconnects --> cancel cleanup timer
PTY exits       --> all peers closed, session deleted immediately (bypasses TTL)
```

- Only owners can create new sessions; non-owners get rejected with code 4003
- On reconnect, the full scrollback buffer (up to 5 MB) is replayed to the new client
- Only one active writer at a time; a new writer demotes the current writer to viewer
- Only owners can close sessions or toggle pin state
- Writers can resize the PTY and clear scrollback
- `clear` resets the scrollback buffer and sends `\f` (form feed) to redraw the prompt
- Pin state is in-memory only; a server restart resets it
- OSC title sequences are parsed from PTY output and stored on the session for display

## Roles and Access Control

Three roles: **owner**, **writer**, **viewer**.

| Role | Create session | Input to PTY | Resize | Clear | Close | Pin |
|---|---|---|---|---|---|---|
| Owner | yes | yes | yes | yes | yes | yes |
| Writer | no | yes | yes | yes | no | no |
| Viewer | no | no | no | no | no | no |

**Role assignment** (server-side):
- Loopback connections or valid owner cookie -> `owner`
- Valid writer token (`?wtoken=`) -> `writer`
- No credentials -> `viewer` (session ID alone is the viewer secret)

**Writer promotion**: When the active writer disconnects, the server promotes the first non-viewer peer. If none exist, the cleanup timer starts.

**Default-to-viewer**: Opening an existing session in a new tab starts in view-only mode (even for owners). The user clicks the "View Only" badge to upgrade. Refreshing preserves the current role. This is tracked via `sessionStorage` (per-tab, survives refresh):

| Key | Set when | Purpose |
|---|---|---|
| `wsh_visited_<id>` | Every page load | Distinguishes new tab (absent) from refresh (present) |
| `wsh_prefer_viewer_<id>` | New tab joins existing session; or user voluntarily demotes | Sends `yield=1` on WS connect |
| `wsh_is_owner_<id>` | Server sends `credential: 'owner'` in role message | Remembers upgrade capability across reconnects |

**Role switching (client-side)**:
- Viewers with credentials (writer token or owner status) see a clickable "View Only" badge to upgrade — clears `PREFER_VIEWER` and reconnects
- Writers see a clickable "Writer" badge to voluntarily demote — sets `PREFER_VIEWER` and reconnects

## Security Model

- **Localhost**: Plain HTTP, no authentication required (loopback = owner)
- **LAN**: HTTPS with self-signed TLS cert (generated on first run, stored in `~/.wsh/tls/`)
  - Certificate fingerprint printed at startup for manual verification
- **Owner token**: 16-char hex, derived from `SHA256(TLS private key)`, stored as `HttpOnly` cookie after first URL-based auth
- **Writer token**: 16-char hex per-session, derived from `SHA256(TLS key + salt + session ID)`
  - Salt is a random 32-byte value persisted in `~/.wsh/tls/writer-salt.txt`
- **Viewer access**: Session ID only (6-char base-36); treat as semi-private
- API endpoints (`{BASE}api/*`) require owner auth from non-loopback clients; static pages load without auth

**Share URLs**:
- Writer link: `<base>/<appName>#<sessionId>?wt=<writerToken>` — grants write access
- Viewer link: `<base>/<appName>#<sessionId>` — read-only access
- Generated via `GET /api/share?session=<id>` (owner-only)

## Window Modes

Three display modes form a progressive escalation — **pretty → practical → focused**:

| Mode | Titlebar | Padding | Fullscreen | Trigger |
|---|---|---|---|---|
| **Window** (default) | yes | yes | no | — |
| **Compact** (yellow dot) | yes | no | no | Toggles `.compact` on `<html>` |
| **Fullscreen** (green dot) | no | no | yes | Browser Fullscreen API |

- **Window**: Decorative "macOS desktop" look with border-radius, shadow, and background texture. Good for demos and screenshots.
- **Compact**: Terminal fills the browser tab; titlebar remains for controls. For daily work.
- **Fullscreen**: Pure terminal, maximum space. Titlebar hidden via `:fullscreen` CSS.

The red dot closes the session (owner-only). All three mode transitions trigger `fitAddon.fit()` to resize the terminal.

## Pinned Sessions Toast

When an owner connects, the server reports any other pinned sessions. The client shows a dismissable toast with clickable chips linking to those sessions (max 3 shown, overflow indicated). The toast auto-dismisses after 8 seconds and is deduplicated per tab via `sessionStorage`.

## App Catalog

Sessions can run different programs, not just `bash`. The app name is always in the URL: `{BASE}:app#:session`.

**URL scheme**: `GET {BASE}` serves the catalog page (`catalog.html`) — a visual app launcher showing all configured apps as cards. Every session URL has the form `{BASE}:appName#sessionId`. Refreshing or opening a new tab preserves the app — the client extracts the app name from the last segment of the pathname and passes it in the WebSocket `app` query parameter. On connect, the server sends the session's actual `app` in the `role` message; if it differs from the URL, the client corrects the pathname via `history.replaceState`.

**Config**: Apps are loaded from three layers, each overriding the previous:

1. **Default**: `bash` is always available as a fallback
2. **System**: `/etc/wsh/apps.yaml` — admin-managed, shared across users
3. **User**: `~/.wsh/apps.yaml` — personal additions/overrides

Each layer falls back to `.json` if no `.yaml` is found. The file format is identical for both system and user configs. System config is useful for multi-user deployments (e.g., behind a reverse proxy) where an admin wants to define a shared set of apps for all users. To set up system apps, create `/etc/wsh/apps.yaml` manually (there is no CLI helper — `wsh apps init` only creates the user config). Users can override any system-level entry in their own `~/.wsh/apps.yaml`.

```yaml
# String shorthand — value is the command
python3: python3
htop: htop

# Full form with options
traecli:
  title: Trae CLI
  command: traecli
  args: [--flag]
  env:
    MY_VAR: hello
```

Each entry: `command` (required), `args` (optional string array), `title` (optional display name), `icon` (optional built-in icon ID), `description` (optional short description for catalog card), `env` (optional), `cwd` (optional). A bare string value is shorthand for `{ command: "..." }`. Both wrapped (`{ apps: { ... } }`) and bare top-level formats are accepted. Any layer can override entries from previous layers, including the default `bash`.

**Session creation**:

| Method | Description |
|---|---|
| `GET {BASE}:appName` | Serves `index.html`. Client generates a session ID and connects via WebSocket with `?app=appName`. |
| `POST {BASE}api/sessions` | JSON body `{ "app": "appName" }` — spawns a pinned session, returns `{ id, url }`. Defaults to `bash`. |

**API**: `GET {BASE}api/apps` returns `{ apps: [{ key, title, command, icon, description }] }` — lists all available apps (owner auth required from non-loopback). `icon` and `description` are `null` when not set in config.

**Catalog page**: `GET {BASE}` serves `public/catalog.html` — a self-contained page (inline CSS/JS, no build step) that fetches `/api/apps` and renders app cards in a responsive grid. Features:
- "Slate Night" dark theme with Inter font
- Cards with 48x48 icons, title, description, and app key footer
- Built-in SVG icons for ~12 categories (terminal, python, node, ai, database, etc.)
- Auto-generated descriptions for well-known apps (bash -> "Bourne Again Shell", etc.)
- Icon resolution: explicit `icon` field -> app key alias -> command basename alias -> default
- Skeleton loading animation, error states, staggered card entrance animation
- Relative links (`./appKey`) that work correctly under any `--base` prefix

**CLI**: `wsh apps` lists available apps. `wsh apps init` creates a starter `~/.wsh/apps.yaml`. `wsh new [appName]` creates a session via the API.

## Base Path Routing

wsh supports running under a URL prefix via `--base <path>` (default: `/`). All routes, static files, WebSocket endpoints, and API paths are mounted under this base path. The base is normalized to always start and end with `/`.

**Use case**: A reverse proxy (e.g., the abox gateway) routes `/{user}/...` to each user's wsh instance. Instead of the proxy rewriting paths and injecting `<base>` tags, wsh natively serves under `/{user}/` via `--base /{user}/`. The proxy passes the full URL unchanged.

**How it works**:
- All Express routes are registered on an `express.Router()` mounted at `BASE` via `app.use(BASE, router)`
- WebSocket upgrade checks `BASE + 'terminal'` instead of `/terminal`
- Token middleware checks `BASE + 'api/'` for auth-required paths
- Cookie `Path` is set to `BASE` so cookies scope correctly under the prefix
- The client extracts the app name from the last path segment (works under any prefix)
- CLI subcommands (`ls`, `kill`, `new`) read `WSH_BASE_PATH` env var to construct API URLs

**Example**: `wsh --base /alice/` serves at `/alice/bash#session`, WebSocket at `/alice/terminal`, API at `/alice/api/sessions`.

## Distribution: Go Wrapper Binary

Single executable, no prerequisites. On first run:
1. Download and cache Node.js LTS to `~/.wsh/node/v{VERSION}/` (SHA256 verified)
2. Extract embedded app files to `~/.wsh/app/v{APP_VERSION}/`
3. Exec Node.js server

Subsequent runs skip 1 and 2 — near-instant startup.

Node.js (~30 MB) is downloaded, not embedded. The Go binary embeds `dist/`, `public/`, `node_modules/` (~15-18 MB total), including the platform-native `pty.node` addon. Build must run on the target platform for this reason.

## CLI Session Management

### API Endpoints

**`GET {BASE}api/sessions`** — Returns all active sessions (owner auth required from non-loopback):
```json
{
  "sessions": [
    {
      "id": "abc123", "title": "bash", "pinned": true,
      "peers": 3, "hasWriter": true,
      "createdAt": 1709800000000, "lastInput": 1709800500000, "lastOutput": 1709800502000,
      "pid": 12345, "scrollbackSize": 1258000, "process": "node"
    }
  ]
}
```

**`DELETE {BASE}api/sessions/:id`** — Kills a session via `SIGHUP`. Returns `{ ok: true }` or 404.

### CLI Commands

**`wsh ls`** — List active sessions on the local server.
- `-l` — Extended output (IN, OUT, PID, SIZE, PROCESS columns)
- `--json` — Raw JSON output with all fields
- `-p, --port <port>` — Override server port (default: 7681)

**`wsh kill <session-id>`** — Close a session.
- `-p, --port <port>` — Override server port (default: 7681)

## Web App Support

wsh can host web-based apps (Jupyter, VS Code Server, Streamlit, etc.) that render in an iframe instead of a terminal.

### TUI vs Web Apps

| Aspect | TUI apps | Web apps |
|---|---|---|
| **Session creation** | PTY spawned on first WS connect | Child process spawned on first WS connect |
| **Process model** | One PTY per session | One HTTP server per session (child process) |
| **Client rendering** | xterm.js terminal | iframe pointing at reverse proxy |
| **Lifecycle** | 10 min TTL after last disconnect (or pinned) | 1h default timeout from last proxy activity (configurable via `timeout`) |
| **Access control** | Per-session roles: owner / writer / viewer | App-level: `access: public` (anyone) or `private` (owner only, default) |
| **Sharing** | Share links with writer/viewer tokens | No share links — use `access: public` for open access |
| **Config** | `type: pty` (default) | `type: web`, must listen on `$WSH_PORT` |

### Configuration

Add `type: web` to an app entry. The app's command must listen on the port provided via `$WSH_PORT`.

```yaml
jupyter:
  title: Jupyter Notebook
  command: jupyter notebook --no-browser --port=$WSH_PORT --NotebookApp.token=''
  type: web

python-http:
  title: Python HTTP Server
  command: python3 -m http.server $WSH_PORT
  type: web
  access: public    # accessible without owner token
```

**Fields specific to web apps**:
- `type: web` — (required) marks the app as a web app
- `access: public | private` — (optional, default `private`) controls who can access the proxy
- `timeout: '24h'` — (optional, default `1h`) idle timeout; supports `ms`, `s`, `m`, `h`, `d` units

**Environment variables** injected into web app processes:
- `WSH_PORT` — The port the app must listen on (dynamically assigned)
- `WSH_SESSION` — The session ID
- `WSH_BASE_URL` — The reverse proxy prefix path (e.g., `/_p/abc123/`); useful for apps that need a `--base-url` option

### Architecture

```
Browser (iframe)  <--HTTP/WS-->  server.ts (reverse proxy)  <--HTTP/WS-->  web app (localhost:port)
Browser (xterm.js) <--WS-->  server.ts  <--log stream-->  web app stdout/stderr
```

**Reverse proxy**: All requests to `{BASE}_p/{sessionId}/...` are proxied to the web app's local port. The proxy:
- Rewrites `Location` headers on redirects (prepends proxy prefix)
- Rewrites `Set-Cookie` `Path` attributes (scopes to proxy prefix)
- Proxies WebSocket upgrades via raw TCP socket piping
- Returns 503 with "Starting up..." splash while the app's health check is pending
- Returns 502 on proxy errors

**Port assignment**: `findFreePort()` binds to port 0 on localhost to get an OS-assigned ephemeral port.

**Health check**: `pollUntilReady()` polls `http://127.0.0.1:{port}/` every 500ms until a response is received (up to 30s timeout).

### Lifecycle

Web app sessions differ from TUI sessions:
- **Default timeout**: 1 hour of proxy inactivity (not 10 min like TUI). Configurable via `timeout` field.
- **Activity tracking**: Every proxied HTTP request updates `lastOutput`, resetting the idle timer.
- **Log buffer**: stdout/stderr is captured into a 512 KB scrollback buffer, broadcast to WS clients as binary frames.
- **Not pinned by default**: Web sessions start unpinned and time out after the configured idle period.

### Access Control

Web apps use **app-level** access control instead of per-session share links:

| `access` | Loopback | LAN with `wsh_token` cookie | LAN without token |
|---|---|---|---|
| `private` (default) | allowed | allowed | **401 Unauthorized** |
| `public` | allowed | allowed | allowed |

- The proxy handler checks `session.access` on every HTTP request and WebSocket upgrade
- The token middleware no longer gates `_p/` paths — the proxy does its own auth based on access level
- The share button is hidden for web apps (no per-session writer/viewer distinction)

### Client Behavior

When the server sends `appType: 'web'` in the role message, the client:
1. Hides `#terminal-container`, shows `#web-container` with an iframe
2. Sets `iframe.src` to `./_p/{sessionId}/`
3. Shows a "Logs" button (replaces the "Clear Scrollback" button)
4. Hides the share button (web apps use app-level access, not share links)
5. Guards all PTY-specific handlers (input, resize) to no-op for web apps

**Log viewer**: stdout/stderr from the web app process is captured and broadcast to connected WebSocket clients as binary frames (same as PTY output). The xterm.js terminal accumulates this data in the background. Clicking "Logs" toggles between the iframe and the terminal log view.

### Last-Session Cookie

When a web session is created, the server sends a `cookie` message to the client, which sets `wsh_last_{appKey}` as a client-side cookie. On subsequent visits to `GET {BASE}{appName}`, the client checks this cookie and navigates to the existing session if present. This is handled entirely client-side (no server redirect).

### Web Apps and `--base-url`

Some web apps serve assets with absolute paths (e.g., `/static/app.js`). Since wsh proxies under `{BASE}_p/{sessionId}/`, these absolute paths break. If a web app supports a `--base-url` or similar option, configure it to use the proxy prefix path. For apps that don't support this, wsh's proxy transparently handles most cases via header rewriting.
