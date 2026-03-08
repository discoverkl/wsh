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

## Pinned Sessions Toast

When an owner connects, the server reports any other pinned sessions. The client shows a dismissable toast with clickable chips linking to those sessions (max 3 shown, overflow indicated). The toast auto-dismisses after 8 seconds and is deduplicated per tab via `sessionStorage`.

## App Catalog

Sessions can run different programs, not just `bash`. The app name is always in the URL: `{BASE}:app#:session`.

**URL scheme**: `GET {BASE}` serves the catalog page (`catalog.html`) — a visual app launcher showing all configured apps as cards. Every session URL has the form `{BASE}:appName#sessionId`. Refreshing or opening a new tab preserves the app — the client extracts the app name from the last segment of the pathname and passes it in the WebSocket `app` query parameter. On connect, the server sends the session's actual `app` in the `role` message; if it differs from the URL, the client corrects the pathname via `history.replaceState`.

**Config**: Apps are loaded from three layers, each overriding the previous:

1. **Default**: `bash` is always available as a fallback
2. **System**: `/etc/wsh/apps.yaml` — admin-managed, shared across users
3. **User**: `~/.wsh/apps.yaml` — personal additions/overrides

Each layer falls back to `.json` if no `.yaml` is found.

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
