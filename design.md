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

## Authentication & Access Control

### Tokens

All tokens are derived from the TLS private key generated on first run (`~/.wsh/tls/`):

| Token | Derivation | Format | Delivery |
|---|---|---|---|
| **Owner** | `SHA256(TLS key)[0:16]` | 16-char hex | `HttpOnly` cookie `wsh_token` (10-year, `SameSite=Strict`) |
| **Writer** | `SHA256(TLS key + salt + sessionId)[0:16]` | 16-char hex, per-session | URL param `?wt=<token>` in share links |
| **Viewer** | *(none)* | Session ID itself is the secret | URL hash `#<sessionId>` |

The writer salt is 32 random bytes persisted in `~/.wsh/tls/writer-salt.txt`.

On first LAN visit, the owner token is passed as `?token=<tok>` in the URL. The server sets the cookie and redirects to strip the token from the URL. All subsequent requests use the cookie.

### Transport

| Context | Protocol | Auth required |
|---|---|---|
| Localhost (127.0.0.1) | HTTP | No — loopback is always owner |
| LAN | HTTPS (self-signed cert) | Yes — owner token or share link |

The TLS certificate fingerprint is printed at startup for manual verification.

### Roles

Three roles with decreasing privilege: **owner > writer > viewer**.

| Action | Owner | Writer | Viewer |
|---|---|---|---|
| Create session | yes | — | — |
| Input (type) | yes | yes | — |
| Resize / Clear | yes | yes | — |
| Close / Pin | yes | — | — |

### Role Assignment (Server-Side)

Evaluated top-to-bottom; first match wins.

**Standard mode:**

| Condition | Role |
|---|---|
| Loopback (127.0.0.1, ::1) or no TLS configured | owner |
| `wsh_token` cookie matches owner token | owner |
| `?wtoken=` matches `writerToken(sessionId)` | writer |
| `?wtoken=` present but invalid | **rejected** (401) |
| No credentials | viewer |

**`--trust-proxy` mode** (for reverse-proxy deployments, e.g. abox gateway):

| `X-WSH-User` header | `?wtoken=` | Role |
|---|---|---|
| Matches `ABOX_USER` env or `*` | *(ignored)* | owner |
| Other value | valid | writer |
| Other value | missing/invalid | viewer |
| Missing | *(any)* | **rejected** (401) |

In trust-proxy mode, cookie and loopback auth are disabled entirely — the proxy is responsible for authenticating users, setting `X-WSH-User`, and stripping any client-supplied `X-WSH-User` header.

### Web App Access Control

Web apps have an app-level `access` field (`private` by default, or `public`). This is checked on every HTTP request and WebSocket upgrade by the proxy handler, separate from the token middleware.

| `access` | Loopback | LAN + owner token | LAN (no token) | trust-proxy (owner) | trust-proxy (other) |
|---|---|---|---|---|---|
| `private` | allowed | allowed | **401** | allowed | **401** |
| `public` | allowed | allowed | allowed | allowed | allowed |

### Writer Management

- Only one active writer per session at a time.
- A new writer demotes the current writer to viewer.
- `?yield=1` lets an owner/writer rejoin as viewer without displacing the current writer. If no writer exists, they are promoted anyway.
- On writer disconnect, the server promotes the first peer with `owner` credential, then `writer`. If none exist, the cleanup timer starts.

### Client-Side Role State

The client tracks each session's role intent in `sessionStorage`:

| Key | Values | Set when |
|---|---|---|
| `wsh_role_{sessionId}` | `active` | First load without hash (creating new session) |
| | `viewer` | First load with hash (joining existing session) |

`active` connects as owner/writer; `viewer` connects with `?yield=1`. Persists across page refresh.

**Role switching**: Viewers with credentials (owner cookie or writer token) see a clickable "View Only" badge to upgrade. Writers see a clickable "Writer" badge to voluntarily step down. Both toggle the `sessionStorage` key and reconnect.

### Share URLs

Generated via `GET /api/share?session=<id>` (TUI apps only; owner-authenticated):

| Link type | URL format | Recipient role |
|---|---|---|
| Writer | `{base}/{app}#{id}?wt={token}` | writer |
| Viewer | `{base}/{app}#{id}` | viewer |

### Rate Limiting

Non-loopback IPs are limited to 10 invalid session-creation attempts per 60-second window. Exceeding the limit closes the WebSocket with code 4029. In `--trust-proxy` mode, rate limiting uses raw IP detection (unaffected by the flag) to avoid throttling the proxy itself.

## App Catalog

`GET {BASE}` serves `catalog.html` — a visual launcher showing all configured apps as cards with icons, descriptions, session counts, and type/access badges.

The page title and tagline are customizable via CLI flags:
- `--title <name>` — sets the browser tab title and wordmark (default: `wsh`)
- `--tagline <text>` — sets the subtitle below the wordmark (default: `Apps in the browser`)

The HTML uses `{{title}}` and `{{tagline}}` placeholders, replaced server-side at serve time with HTML-escaped values.

### Configuration

Apps load from three layers (each merges into the previous):

1. **Default**: `bash` (always available)
2. **System**: `/etc/wsh/apps.yaml`
3. **User**: `~/.wsh/apps.yaml`

Each layer falls back to `.json` if no `.yaml` is found.

For existing apps, later layers do **field-level merging** — only the specified fields are overridden, unspecified fields are inherited. New apps require at least a `command` field. Keys starting with `_` are reserved (e.g. `_skills`) and never treated as apps.

```yaml
python3:
  command: python3

node:
  command: node
  args: [--inspect]
  title: Node.js REPL
  cwd: ~/projects
  env:
    NODE_ENV: development
```

**Common fields**: `command` (required for new apps), `args`, `title`, `icon`, `description`, `env`, `cwd`, `hidden`.

**Available icons** (50):

| Icon | Description | Color |
|---|---|---|
| `terminal` | Command prompt with cursor | green |
| `python` | Python logo (intertwined snakes) | yellow |
| `node` | Node.js hexagon | green |
| `vim` | Triangle with exclamation dot | green |
| `monitor` | Desktop screen on stand | blue |
| `docker` | Container whale with boxes | blue |
| `git` | Branch graph with circles | orange |
| `ruby` | Gem polygon facets | red |
| `ai` | Robot face with dot eyes | purple |
| `database` | Cylinder stack (three tiers) | cyan |
| `network` | Globe with meridians | blue |
| `rocket` | Rocket ship launching | orange |
| `cloud` | Puffy cloud outline | sky blue |
| `lock` | Closed padlock | amber |
| `mail` | Envelope with flap | pink |
| `calendar` | Calendar page with date pins | violet |
| `music` | Pair of linked music notes | pink |
| `camera` | Camera body with lens circle | teal |
| `book` | Closed book with spine | purple |
| `pen` | Pencil writing on a line | orange |
| `chart` | Three-bar vertical bar chart | emerald |
| `folder` | Folder with tab | yellow |
| `clock` | Circle clock with hour hand | indigo |
| `heart` | Heart shape outline | red |
| `star` | Five-pointed star | yellow |
| `lightning` | Zigzag lightning bolt | amber |
| `fire` | Flame with inner tongue | red |
| `compass` | Circle with diamond pointer | teal |
| `map` | Folded tri-panel map | emerald |
| `phone` | Telephone handset | green |
| `gamepad` | Game controller with d-pad and buttons | violet |
| `coffee` | Coffee mug with steam lines | brown |
| `sun` | Sun circle with radiating rays | amber |
| `moon` | Crescent moon | indigo |
| `key` | Skeleton key with teeth | orange |
| `shield` | Pointed shield crest | green |
| `bug` | Beetle with antennae and legs | red |
| `wrench` | Angled wrench tool | gray |
| `paint` | Color palette with paint dots | pink |
| `search` | Magnifying glass | blue |
| `download` | Downward arrow into tray | blue |
| `speaker` | Speaker cone with sound waves | violet |
| `printer` | Printer with paper tray | gray |
| `battery` | Battery cell with terminal | green |
| `wifi` | Wireless signal arcs | blue |
| `cpu` | Chip with pin grid | cyan |
| `package` | 3D box with ribbon seam | orange |
| `scissors` | Open scissors blades | red |
| `anchor` | Ship anchor with crossbar | indigo |
| `default` | Document with text lines | gray |

**Skill fields**: `skill: <name>` — marks the app as a skill (an AI agent automation task). See [Skills](#skills) below.

**Web app fields**: `type: web`, `access: public|private` (default `private`), `timeout: '1h'` (supports `ms`, `s`, `m`, `h`, `d`), `stripPrefix: true|false` (default `false`), `healthCheck: '/ready'` (default `/`), `startupTimeout: '60s'` (default `30s`).

**Visibility**: `hidden: true` excludes an app from the catalog page (`GET {BASE}api/apps`) but it remains launchable via direct URL or CLI. Users can override system visibility in `~/.wsh/apps.yaml` with a partial entry:

```yaml
# unhide a system app without redefining its full config
claude:
  hidden: false
```

### Session Creation

| Method | Description |
|---|---|
| `GET {BASE}{appName}` | Serves `index.html`; client generates ID, connects via WS with `?app=appName` |
| `POST {BASE}api/sessions` | Body `{ "app": "appName", "input": "..." }` — spawns a pinned session, returns `{ id, url }`. The `input` field is optional; used by skill apps. |

### API

- `GET {BASE}api/apps` — list visible apps (excludes `hidden: true`): `{ apps: [{ key, title, command, icon, description, skill, type, access }] }`
- `GET {BASE}api/sessions` — list active sessions (includes `id`, `title`, `app`, `appType`, `pinned`, `peers`, `hasWriter`, `createdAt`, `lastInput`, `lastOutput`, `pid`, `scrollbackSize`, `process`, `port`, `ready`)
- `DELETE {BASE}api/sessions/:id` — kill a session
- `GET {BASE}api/share?session=<id>` — get writer token for sharing

### CLI

- `wsh apps` — list available apps
- `wsh apps init` — create starter `~/.wsh/apps.yaml`
- `wsh new [app] [input...]` — create a session via API (remaining args become skill input)
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

### Client Behavior

When the server sends `appType: 'web'` in the role message:
1. Shows `#web-container` with iframe instead of `#terminal-container`
2. Replaces "Clear" button with "Logs" toggle (switches between iframe and log terminal)
3. Hides the share button
4. Sets `convertEol: true` on the log terminal
5. Guards PTY-specific handlers (input, resize, binary) to no-op

### Last-Session Cookie

On web session creation, the server sends a `cookie` message. The client sets `wsh_last_{appKey}` so revisiting the same app URL reconnects to the existing session instead of creating a new one.

## Skills

Skills are AI agent automation tasks — folders with a `SKILL.md` file, executed by agent CLIs like Claude Code or Trae. In wsh, a skill is just an app with a `skill` field and a command template that references `$SKILL` and `$INPUT` env vars.

### Configuration

The `_skills` reserved key provides shared defaults for all skill apps. Per-skill fields override these defaults.

```yaml
_skills:
  command: traecli "/$SKILL $INPUT"   # default: claude "/$SKILL $INPUT"
  cwd: /data/workspace                # default: $HOME

deploy:
  skill: deploy
  title: Deploy App
  icon: rocket
  description: AI-powered deployment
```

**`_skills` fields**:
- `command` — agent CLI command template (default: `claude "/$SKILL $INPUT"`)
- `cwd` — working directory for all skills; the agent CLI discovers skills by walking up from this directory (default: `$HOME`)
- Any other `AppConfig` field — applied as fallback to skill apps

Keys starting with `_` are reserved and never treated as apps.

### How It Works

1. When a skill app is launched, the server injects `SKILL` and `INPUT` as environment variables (from the app's `skill` field and the user-provided input text, respectively)
2. For PTY apps, the command is wrapped in a shell (`$SHELL -c "command args..."`) so env var references in the command template get expanded
3. For web apps, `shell: true` is already used, so env vars expand naturally

### Catalog UI

Skills get their own section at the top of the catalog, above regular apps. Each skill card has:
- Purple/violet accent border (`#a78bfa`) to visually distinguish from regular apps
- Integrated text input field with a "Run" button — no modal needed
- Same session count badges as regular app cards

Section visibility rules:
- No skills → skills section hidden, no "Apps" label shown
- Has skills → both sections shown with labels ("Skills" / "Apps")
- No apps → apps section hidden

### Launching

| Method | Input source |
|---|---|
| Catalog UI | Text field in skill card, submitted via form |
| `POST {BASE}api/sessions` | `{ "app": "deploy", "input": "update staging" }` |
| WebSocket | `?app=deploy&input=update+staging` query params |
| CLI | `wsh new deploy "update staging"` (remaining positional args joined) |

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

## Mobile Touch Workarounds (xterm.js v6)

xterm.js v6 has several gaps in mobile/touch support. The following workarounds are applied and should be re-tested when upgrading xterm.js.

| Issue | Root cause | Workaround | Files |
|---|---|---|---|
| **No touch scrolling** | `Gesture.addTarget()` is never called internally, so the built-in touch gesture system is wired up but inactive | Manual `touchstart`/`touchmove`/`touchend` handlers on `#terminal-container` (full terminal) and `.mt-term` (mini-terminal) that call `term.scrollLines()` with inertia/momentum and rubber-band bounce at edges | `src/client.ts`, `src/mini-terminal.ts` |
| **Scrollbar blocks touch & keyboard** | xterm's custom scrollbar (`xterm-scrollable-element`) intercepts touch events, causing keyboard popup and stuck scrollbar state | CSS `pointer-events: none` on `.xterm-scrollable-element` for `(pointer: coarse)` devices; scrollbar remains visible as position indicator | `public/index.html`, `src/mini-terminal.ts` |
| **Keyboard pops up on shortcut button tap** | `term.focus()` was called after sending shortcut key data | Removed the `term.focus()` call in the shortcut bar click handler | `src/client.ts` |
| **Empty send button sends Enter** | Tapping the send button with no text should send Enter to the terminal | When input is empty, `sendShortcutInput()` sends `\r` instead of no-op | `src/client.ts` |

## Distribution

Single Go binary, no prerequisites:

1. Downloads and caches Node.js LTS to `~/.wsh/node/` (SHA256 verified)
2. Extracts embedded app files to `~/.wsh/app/v{VERSION}/`
3. Execs `node dist/server.js`

Node.js (~30 MB) is downloaded, not embedded. The Go binary embeds `dist/`, `public/`, `node_modules/` (~15-18 MB), including the platform-native `pty.node` addon. Build must run on the target platform.
