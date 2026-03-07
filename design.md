# wsh Design Notes

## Architecture

```
Browser (xterm.js)  <--WS-->  server.ts  <--bytes-->  node-pty (bash/claude)
```

**Shared-session model**: URLs have the form `/:appName#sessionId`. The app name selects which program to run; the session ID (6-char base-36) identifies the PTY. Multiple browser tabs can connect to the same session. Each session has exactly one PTY, one active writer, and any number of viewers.

**Message framing**:
- **Client -> Server (binary)**: Raw bytes forwarded to PTY (keyboard input, legacy X10 mouse)
- **Client -> Server (text/JSON)**: Control messages — `resize`, `close`, `clear`, `pin`
- **Server -> Client (binary)**: Raw PTY output
- **Server -> Client (text/JSON)**: Role assignments (`role`), pin state updates (`pin`)

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

**Yielding**: An owner/writer can voluntarily reconnect as viewer by setting `?yield=1`. The client tracks this in `sessionStorage` (`PREFER_VIEWER`) so refreshes maintain the choice.

**Writer promotion**: When the active writer disconnects, the server promotes the first non-viewer peer. If none exist, the cleanup timer starts.

**Role switching (client-side)**:
- Viewers with credentials (writer token or owner status) see a clickable "View Only" badge to upgrade
- Writers see a clickable "Writer" badge to voluntarily demote to viewer
- Both trigger a WebSocket reconnect with updated query parameters

## Security Model

- **Localhost**: Plain HTTP, no authentication required (loopback = owner)
- **LAN**: HTTPS with self-signed TLS cert (generated on first run, stored in `~/.wsh/tls/`)
  - Certificate fingerprint printed at startup for manual verification
- **Owner token**: 16-char hex, derived from `SHA256(TLS private key)`, stored as `HttpOnly` cookie after first URL-based auth
- **Writer token**: 16-char hex per-session, derived from `SHA256(TLS key + salt + session ID)`
  - Salt is a random 32-byte value persisted in `~/.wsh/tls/writer-salt.txt`
- **Viewer access**: Session ID only (6-char base-36); treat as semi-private
- API endpoints (`/api/*`) require owner auth from non-loopback clients; static pages load without auth

**Share URLs**:
- Writer link: `<base>/<appName>#<sessionId>?wt=<writerToken>` — grants write access
- Viewer link: `<base>/<appName>#<sessionId>` — read-only access
- Generated via `GET /api/share?session=<id>` (owner-only)

## Pinned Sessions Toast

When an owner connects, the server reports any other pinned sessions. The client shows a dismissable toast with clickable chips linking to those sessions (max 3 shown, overflow indicated). The toast auto-dismisses after 8 seconds and is deduplicated per tab via `sessionStorage`.

## App Catalog

Sessions can run different programs, not just `bash`. The app name is always in the URL: `/:app#:session`.

**URL scheme**: `GET /` redirects to `/bash`. Every session URL has the form `/:appName#sessionId`. Refreshing or opening a new tab preserves the app — the client reads the app name from the pathname and passes it in the WebSocket `app` query parameter.

**Config**: Built-in app `bash` is always present. Additional apps are defined in `~/.wsh/apps.json`:

```json
{
  "apps": {
    "python3": { "title": "Python REPL", "command": "python3" },
    "traecli": { "title": "Trae CLI", "command": "traecli" }
  }
}
```

Each entry: `command` (required), `args` (optional string array), `title` (optional display name). Built-in keys cannot be overridden.

**Session creation**:

| Method | Description |
|---|---|
| `GET /:appName` | Serves `index.html`. Client generates a session ID and connects via WebSocket with `?app=appName`. |
| `POST /api/sessions` | JSON body `{ "app": "appName" }` — spawns a pinned session, returns `{ id, url }`. Defaults to `bash`. |

**CLI**: `wsh apps` lists available apps. `wsh new [appName]` creates a session via the API.

## Distribution: Go Wrapper Binary

Single executable, no prerequisites. On first run:
1. Download and cache Node.js LTS to `~/.wsh/node/v{VERSION}/` (SHA256 verified)
2. Extract embedded app files to `~/.wsh/app/v{APP_VERSION}/`
3. Exec Node.js server

Subsequent runs skip 1 and 2 — near-instant startup.

Node.js (~30 MB) is downloaded, not embedded. The Go binary embeds `dist/`, `public/`, `node_modules/` (~15-18 MB total), including the platform-native `pty.node` addon. Build must run on the target platform for this reason.

## CLI Session Management

### API Endpoints

**`GET /api/sessions`** — Returns all active sessions (owner auth required from non-loopback):
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

**`DELETE /api/sessions/:id`** — Kills a session via `SIGHUP`. Returns `{ ok: true }` or 404.

### CLI Commands

**`wsh ls`** — List active sessions on the local server.
- `-l` — Extended output (IN, OUT, PID, SIZE, PROCESS columns)
- `--json` — Raw JSON output with all fields
- `-p, --port <port>` — Override server port (default: 7681)

**`wsh kill <session-id>`** — Close a session.
- `-p, --port <port>` — Override server port (default: 7681)
