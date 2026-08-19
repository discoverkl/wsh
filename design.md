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
- **Text/JSON**: `role` (with `app`, `appType`, `credential`, `pinned`, `pinnedOther`, `pos`, `replay`), `pin`, `ready` (with `path`, `instance`), `status`, `cookie`, `rpc`

## Session Lifecycle

### TUI Sessions

```
owner connects   --> PTY spawned, added to sessions map
writer disconnects --> promote next owner/writer peer
                      if none: scheduleCleanup()
  pinned=true    --> no timer, lives until PTY exits or manual close
  pinned=false   --> SESSION_TTL (90 min), then SIGTERM -> SIGKILL
any peer reconnects --> cancel cleanup timer
PTY exits        --> all peers closed, session deleted immediately
```

The per-app `timeout` field is **not** honored here — a TUI session holds a live terminal and marks the box busy, so config isn't allowed to keep one open indefinitely. Pinning is the deliberate escape hatch, and it's an owner action rather than a config setting. A non-web app that sets `timeout` draws a config warning at startup and in `GET /api/apps` (see `loadApps`), so the field fails loudly rather than being dropped on the floor.

### Web Sessions

```
owner connects   --> child process spawned, health check polls in background
                     server sends { type: 'ready' } when health check passes
writer disconnects --> same promotion logic as TUI
  pinned=true    --> no timer
  pinned=false   --> timeoutMs (default 1h, configurable via `timeout` field)
child exits      --> all peers closed, session deleted immediately
```

### Reconnect

Both TUI and web pages keep their control WebSocket alive on their own, with
exponential backoff (1s → 30s, ±25% jitter) for as long as the tab lives, plus an
immediate attempt on `online` and on the tab becoming visible. Backoff state
resets on **attach** (the `role` message), never on socket `open` — a rejected
connection completes the handshake first, so `open` fires before the rejecting
`close`, and resetting there degenerates into an endless 1 Hz retry loop.

What counts as retryable follows from whether the thing you were attached to can
still come to exist:

| Close | Web | PTY |
|---|---|---|
| 1006 / 1001 / 4001 (transport) | retry | retry |
| 1000 `Process exited` / `Session replaced` | retry — respawnable | **stop** |
| 4003 `session not found` | retry — respawnable | **stop** |
| 4003 permission, 4029, 4000, user closed | stop | stop |

A web app is a replaceable singleton; a PTY is an irreplaceable process, and
handing someone a fresh shell wearing the dead one's URL is worse than an honest
failure. Retries carry `reconnect=1` ("attach to my session, don't create a new
one"); for **web** the server may still resolve or respawn the singleton by app
key — they're singletons, `/_a/<appKey>` auto-spawns them over HTTP anyway, and a
session ID that died with a server restart would otherwise make every retry
unanswerable. For **pty** it stays strict.

The `ready` message carries `instance` (`<server pid>:<child pid>`), identifying
the process behind the app proxy. The iframe is reloaded only when `instance`
changes — a restarted app leaves the frame pointing at a dead child, while a
socket that merely dropped and came back does not (the app is served over a
separate HTTP path and is still live, so reloading would throw away its state for
nothing). The session ID can't carry this signal: a reconnect that respawns a dead
singleton reuses the ID the client asked for.

Disconnection is reported by an overlay banner that appears only after 1.5s of
continuous disconnection and offers a manual **Retry** after three failed
attempts. It is absolutely positioned on purpose: as an in-flow element it took
its own height out of the iframe, so every disconnect/reconnect cycle re-laid-out
the embedded app.

**Resume from offset.** A reattach carries `since=<streamPos>` and the `role`
reply carries `pos` (the stream position the client is caught up to once the
replay lands) plus `replay: 'none' | 'tail' | 'full'`. When the requested offset
is still inside the retained buffer the server sends only the missing tail, so a
short gap costs nothing and the terminal is never cleared; otherwise it sends a
full replay and the client resets first (without a reset the whole session would
render twice). The client can't count received bytes itself — replays are
stripped, so they're shorter than the stream they stand for — which is why `pos`
is authoritative and the one replay frame following a `role` isn't counted.

### Job Sessions

```
created via API   --> child process spawned, stdout/stderr written incrementally to disk (~/.wsh/logs/<id>.log)
                      no port, no health check, no keyboard input, no WebSocket
wsh logs <id>     --> GET /api/sessions/:id/logs — reads disk file (works during and after execution, survives server restarts)
wsh logs -f <id>  --> GET /api/sessions/:id/stream (SSE) — tails ~/.wsh/logs/<id>.log on a 100ms poll; finishes when ~/.wsh/logs/<id>.exit appears
wsh exitcode <id> --> GET /api/sessions/:id/exit — returns {"code":N} from ~/.wsh/logs/<id>.exit, or 404 while still running
child exits       --> exit code stamped to ~/.wsh/logs/<id>.exit, fd closed, session deleted immediately
```

`wsh logs` defaults to **job mode** (`--type job`): the target is taken verbatim as a session ID and the disk log is canonical — no `/api/sessions` lookup. Pass `--type web` to view a live web-app session's in-memory scrollback (target may be an app name; resolved via `/api/sessions`). Both modes share the same one-shot endpoint (`/logs`) and follow transport (`/stream` SSE) — the server dispatches by live `appType` (job → tail disk; pty/web → fake-peer feed of scrollback + live output, control messages stripped).

Jobs are non-interactive background tasks (cron runs, chat agent invocations). They have **no WebSocket surface** — `/terminal` rejects job sessions with close code 4003, and jobs cannot be created via WS. Output goes straight to disk via `fs.writeSync` (no in-memory scrollback) and is exposed only over HTTP (`/api/sessions/:id/logs`) and SSE (`/api/sessions/:id/stream`). They are visible in `wsh ls` with `appType: 'job'` and provide box-level activity tracking for idle detection and graceful upgrades.

`scheduleCleanup()` short-circuits for jobs (`appType === 'job'` → no timer): the only path to deletion is the child's `'close'` event. Sessions created via API with no peer never accumulate state beyond what's needed for `wsh ls` and the SSE/HTTP endpoints.

The SSE handler always tails the on-disk `.log` rather than subscribing to in-memory output events. Disk is the source of truth — every byte hits the log fd before any `'output'` event would fire — so polling avoids subscribe/cleanup races and works identically whether the job is still running or already cleaned out of the `sessions` map. Non-job (pty/web) sessions are dispatched by their in-memory `appType` first, so a stale `.log` / `.exit` left from a previous job with a colliding ID can never reroute a live session into the job branch.

### Caveats (job sessions as `bash -c` substitute)

When using `wsh new --type job -c "<cmd>"` + `wsh logs -f <id>` + `wsh exitcode <id>` as a drop-in for `bash -c`:

- **Stdin is opt-in over HTTP.** Jobs are spawned with a stdin pipe, but no bytes are written until a caller `POST`s to `/api/sessions/<sid>/stdin` (chunked body → child's stdin; close → EOF). `wsh new --type job` itself doesn't read its caller's stdin; clients that want to forward stdin (e.g. `abox-cli exec`) drive the stdin endpoint separately. One-shot: once the body ends or the child exits, the pipe is closed and further POSTs get 410.
- **No tty.** Job output is captured to a file and replayed; there is no allocated pseudo-terminal. Programs that probe `isatty(1)` (color, paging, progress bars, full-screen apps like `htop`/`vim`) will see a non-tty and either disable interactive features or fail to render. Use `--type pty` for those.
- **~100ms tail latency.** `wsh logs -f` polls the log file every 100 ms, so a long stream of fast prints arrives in chunks rather than byte-by-byte. The total bytes are correct; only the cadence is coarsened.
- **Ctrl-C only kills the follower.** SIGINT to `wsh logs -f` exits the follower but leaves the job running in the background — the caller must `wsh kill <id>` to actually cancel. Wrappers that want bash-c-like cancel semantics should `trap INT TERM` and forward to `wsh kill`.

### Detaching from a job

A job is a child of the **wsh server process** (not of `wsh logs -f` or whatever wrapper started it), so the job survives anything that kills only the follower:

| Event | Job survives? | How |
|---|---|---|
| Terminal closes (SIGHUP) | yes | follower dies, job's stdout fd points at the disk log, server keeps the child |
| SSH session drops | yes | same as above |
| Ctrl-\ (SIGQUIT) on the follower | yes | follower dies, server unaffected |
| Ctrl-C (SIGINT) on the follower | depends on wrapper | bare `wsh logs -f` exits and the job survives; a wrapper with a `trap INT → wsh kill` forwards the kill |
| `kill -9` of the follower | yes | server keeps the child |
| wsh server crashes | no | child orphaned to PID 1; real exit code lost. `/stream` and `/exit` both lazily synthesize `-1` in `.exit` on the next attach (when `.log` exists, `.exit` doesn't, and the session is gone from memory) so followers terminate cleanly instead of hanging on a frozen log |

Re-attach from any new shell with `wsh logs -f <sid>` (replays the full log from offset 0, then waits for `[DONE]`) and read the final status with `wsh exitcode <sid>` (works any time after the job ends — the `.exit` file is durable). Find the sid via `wsh ls` (titles set with `--title` show what each job is) or by inspecting `~/.wsh/logs/`.

### Common Rules

- Only owners can create sessions; non-owners get rejected with WS close code 4003
- On WebSocket reconnect, the scrollback buffer is replayed — only the tail past the client's `since` offset when it's still retained, otherwise in full (bounded at 5 MB for TUI, 512 KB for web). Jobs do not use WebSocket and have no scrollback — their output lives only on disk. Terminal query sequences (DSR, DA, DECRQM, DECRQSS, window-size ops, OSC color queries) and their responses are stripped from replayed scrollback — stale queries would otherwise trigger xterm.js to generate responses that flow back to PTY stdin as garbage text, since the originating program is no longer listening.
- Only one active writer at a time; a new writer demotes the current one to viewer
- Only owners can close sessions or toggle pin state; writers can resize and clear
- Pin state is in-memory only; a server restart resets it (processes die anyway)

## Authentication & Access Control

### Tokens

All tokens are derived from the TLS private key generated on first run (`~/.wsh/tls/`):

| Token | Derivation | Format | Delivery |
|---|---|---|---|
| **Owner** | `SHA256(TLS key)[0:16]` | 16-char hex | `HttpOnly; SameSite=Strict; Path=${BASE}` cookie `wsh_token` |
| **Writer** | `SHA256(TLS key + salt + sessionId)[0:16]` | 16-char hex, per-session | URL param `?wtoken=` (stripped from bar via `replaceState`) |
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

Requires `WSH_PROXY_SECRET` env var. Every request must include a matching `X-WSH-Proxy-Secret` header — HTTP requests and WebSocket upgrades alike, public apps included. The proxy supplies two trusted claims:

- `X-WSH-User`: display-only username (used in banners, share-link labels, and `session.createdBy`). Carries no authority.
- `X-Abox-Allowed: 0|1`: the proxy's verdict on whether this caller may access this box.

**`X-WSH-*` stops at wsh.** Both are consumed here and stripped before a request reaches a web app (`appHeaders`). The secret is the key to the box — an app that logs its request headers would write it to disk, and a *public* app that echoes them would hand it to a stranger, who could then forge any identity back at wsh. The display name has no reason to travel either; an app that wants to know who spawned its session reads `WSH_ORIGIN_USER` from its environment. What apps do see is the gateway's own contract: `X-Auth-User` and the `X-Abox-*` verdict headers. The strip is a prefix match, so the next `X-WSH-*` header is private by default rather than by remembering.

| Condition | Role |
|---|---|
| `X-Abox-Allowed: 1` | owner |
| Else, valid `?wtoken=` | writer |
| Else | viewer |
| Bad `?wtoken=` | **rejected** |
| Bad/missing `X-WSH-Proxy-Secret` | **rejected** |

The proxy decides who's allowed; wsh just honors the decision. From wsh's view, "owner" means "the proxy authorized this human for this box" — not "this human happens to share a name with the box."

**Public-app exception.** Apps marked `access: public` in `apps.yaml` (e.g. web `tetris`) are reachable by anyone the proxy forwarded, regardless of `X-Abox-Allowed`. Both web and pty apps may be public:
- `/_a/<key>` HTTP and WebSocket (web only): forwarded; auto-spawn allowed.
- Parent chrome `/<box>/<appName>`: the `/terminal` WebSocket admits non-allowed callers. For a public **web** app they join as viewers and the role message tells the client to load the iframe. For a public **pty** app there is no iframe — each visitor spawns their **own** per-visitor PTY and is granted **writer** (type/resize/clear) over it, so the app is actually usable. Never owner: that would disclose other sessions via `pinnedOther` and allow pin/keep-alive. `close`/`pin` stay owner-only.
- `/api/apps`: non-allowed callers see only public apps — web *and* pty (Skills and private apps hidden).
- All other `/api/*` endpoints (rpc, share, sessions, paste-image, events): require `Allowed=1`. The pty writer role is per-session WS state only; it grants no HTTP-API authority.

A public pty app has a single surface — the `/terminal` WebSocket (no `/_a` proxy, since a PTY has no port). Because each visitor spawns a fresh process, concurrent public-pty spawns are capped per source IP (`PUBLIC_PTY_MAX_PER_IP`, counted from the live session map so it self-corrects as sessions exit).

> ⚠ **A public pty app runs a real process fed stranger keystrokes.** Marking `bash` (or anything with shell access) `access: public` is remote code execution for anyone the gateway forwards. The command must be sandboxed. wsh logs a warning at startup and toasts one in the catalog for every public-pty app; the catalog card carries an amber ⚠ PUBLIC badge.

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

**Ordering**: `top: N` (positive integer) promotes an app to the top of its section (skills/apps independently), sorted by value ascending. `hidden: true` pushes to the bottom. `top: 0` explicitly overrides a system-level `top`. Catalog display order: topped → normal → hidden.

**Default app**: `default: true` on one app makes it the box's landing page — the catalog root (`/`) issues a `302` to `${BASE}${appKey}` instead of rendering the catalog. Works for any **pty or web** app (not skills or jobs — jobs have no UI to land on); the redirect just serves the app shell (`index.html`), which spawns a PTY into xterm.js or a web app into the iframe as usual. Reach the catalog itself with `/?catalog` (any value; presence is all that matters). The app shell carries a grid-icon "Back to Catalog" link (`#catalog-btn`) in its titlebar pointing at `${BASE}?catalog`, so it never bounces straight back to the default app. Resolution (`defaultAppKey()` in `server.ts`) walks apps in catalog order and returns the first `default: true` app the requester can actually reach — under `--trust-proxy`, a non-allowed viewer is only redirected to a public-joinable default, otherwise they get the (filtered) catalog. Exposed as `default` in `/api/apps`; cards flagged default show a green **Default** badge.

**Merging one entry (`POST /api/apps/:key`).** Writes a whole app definition into the user layer — the receiving half of `abox-cli push app`, which carries a card and the files behind it from one box to another. Unlike the toggles below it replaces the entry rather than setting a field, and it writes through `parseDocument` so the rest of the file — including comments — survives; a push promises to touch the one key it names. It refuses `_`-prefixed reserved keys, keys the system layer already defines (those arrive with the image on both boxes, and the user layer merges last, so a copy could only disagree and would win), and keys not usable as both a URL segment and a YAML key. Because `loadApps()` re-reads from disk on every request, a merged card is live on the next catalog load with nothing to reload. The push client is told the box can do this by `accept_entities` in the `/api/push/plan2` reply, and refuses the whole operation when it is absent rather than landing files whose card will never arrive.

Set it from the catalog UI (no hand-editing): each app card's config-gear popover has a **Set Default** / **Unset Default** button. `POST /api/apps/:key/default` flags the app and clears the flag from any current default (a box has at most one, so this doubles as "reset the previous one"); `POST /api/apps/:key/undefault` clears it. Both persist to the user `apps.yaml` and are system-aware — a `default: true` coming from the read-only system config is overridden with `default: false` in the user layer rather than deleted. Skills and jobs don't get the button.

## `wsh new` Positional Args

The positional arg meaning depends on mode:

| Mode | Positional args |
|------|----------------|
| **App** (default) | `[app-key]` — app to run (default `bash`). Extra positionals are an error. |
| **Skill** (`--skill`) | `[words...]` — all joined → `$INPUT` env var |
| **Ad-hoc** (`--type`/`-c`) | None. Command via `-c`/`--command` or stdin. Positionals are an error. |

**Output format**: `wsh new` prints a clickable URL by default. For `--type job` the URL is non-functional (jobs reject WebSocket), so job sessions print just the session ID — `--id-only` is implicit. Use `wsh logs -f <id>` to follow job output.

## Web App Proxy

Apps must be proxy-aware and configure their own base URL using `$WSH_BASE_URL`. The proxy does not rewrite `Location` headers or `Set-Cookie` paths.

`stripPrefix: true` is available for simple apps that use relative paths (SPAs, static file servers).

**Initial inner path.** The `path` config field sets the inner path a web app's iframe opens at (e.g. `path: /files/` for File Browser, whose `/` root doesn't render). It rides the `ready` message to the client; a one-shot `?to=<path>` URL param overrides it.

Environment injected into web app processes: `WSH_PORT` (the port the app should listen on), `WSH_SESSION`, `WSH_BASE_URL`, and `WSH_ORIGIN_USER` (the `X-WSH-User` captured when the session was created, or empty).

Headers a proxied request arrives with are the caller's, minus every `X-WSH-*` (see [Authentication & Access Control](#--trust-proxy-mode-for-reverse-proxy-deployments)). Under a gateway that means an app can read `X-Auth-User` for the SSO username and `X-Abox-Allowed` to tell an authorized user from a forwarded stranger.

**Daemon web apps (`daemon: true`).** A `type:web` app with `daemon: true` is the way to run a persistent web server whose existence does **not** mark the box busy:

```yaml
mydaemon:
  type: web
  daemon: true
  command: my-server --port=$WSH_PORT --base-url=$WSH_BASE_URL
  title: My Daemon
```

Because wsh launches it like any web app, `WSH_PORT`/`WSH_BASE_URL` are injected normally — no `wsh goto`, no manual base-url passing. Three behaviors set it apart:
- **Autostart**: launched once the server is listening (`onListening` → `startDaemonApps`), so it's warm before first access and survives box reboots.
- **Persistent**: `scheduleCleanup` short-circuits for daemons (like pinned sessions), so it's never idle-reaped.
- **Hidden when idle**: a daemon with **0 peers** is omitted from `/api/sessions` — and therefore from `wsh ls`, the gateway busy probe, and every idle check, since they all read that list. The moment it has a viewer (`peers > 0`) it reappears and counts as busy, so the box won't idle-shut-down a daemon you're actively using. `?all=1` / `wsh ls --all` always shows them.

Lifecycle is otherwise a normal web app: closing it (catalog ✕ or `wsh kill <id>`) stops it with no auto-respawn; re-opening (`/_a/<app>`) or the next boot relaunches it as a daemon. Use a daemon for a web server that's fine to be reaped with the box when nobody's viewing it; if a process must keep the box alive doing background work, it should *not* be a daemon (it should count as busy).

**Fronting a pre-bound port (`wsh goto`).** A normal web app's command binds `$WSH_PORT` and is *proxy-aware* — it reads `WSH_BASE_URL` to prefix its own URLs with `/_a/<appKey>/`. To expose a server that is *already* listening on a fixed local port — one that knows nothing about wsh and can't read `WSH_BASE_URL` — front it with the `wsh goto` forwarder **and set `stripPrefix: true`**:

```yaml
myserver:
  type: web
  command: wsh goto localhost:8080 -p $WSH_PORT
  stripPrefix: true
  title: My Server
```

`wsh goto <host:port> -p <listen-port>` listens on `127.0.0.1:<listen-port>` and pipes raw TCP both ways to `<host:port>` — HTTP and WebSocket pass through unchanged.

`stripPrefix: true` is **required** here precisely because the upstream is not proxy-aware: with it, the proxy strips the `/_a/<appKey>` prefix before forwarding, so the upstream only ever sees clean root paths (`/`, `/foo`) and never needs `WSH_BASE_URL`. The usual `stripPrefix` caveat still applies — wsh does not rewrite proxied app **bodies**, so the upstream's HTML must use **relative** asset URLs; a server that emits root-absolute URLs like `/style.css` won't resolve under the iframe's prefix and must instead be run as a real proxy-aware web app (a command that honors `$WSH_BASE_URL`, e.g. a `--base-path` flag).

The web-app lifecycle is otherwise identical: the health check polls `$WSH_PORT` (→ forwarded to `8080`), so if the upstream isn't up yet the probe simply retries and startup ordering self-heals. `wsh` resolves on the child's PATH via `~/.local/bin`, and `wsh goto` is a self-contained subcommand (no HTTP server) usable standalone as a loopback TCP forwarder.

**Initial focus.** After the iframe fires `load`, the host calls `iframe.focus()` and then re-focuses the first `[autofocus]` element inside the iframe (same-origin only). Web apps that want a specific input focused on load should use the `autofocus` attribute — a JS `.focus()` call from inside the iframe alone is unreliable, because the host's subsequent `iframe.focus()` can reset the active element to the iframe itself.

## Image Paste

Ctrl+V (Cmd+V on macOS) in the browser terminal uploads clipboard images to `POST /api/paste-image` (raw body, ≤5 MB, png/jpeg/gif/webp). The server writes them to `~/.wsh/paste/MMDD-HHMMSS-rrr.<ext>`, returns the absolute path, and the client emits it over the WebSocket wrapped in bracketed-paste markers (`\x1b[200~…\x1b[201~`) so TUIs like Claude Code and Codex auto-attach. Files are swept after 7 days at startup and on ~5% of uploads. The macOS Ctrl+V case uses `navigator.clipboard.read()` (HTTPS/localhost only); other paths use the synchronous `paste` event with no permission prompt.

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

**Transport**: HTTP POST to `/api/rpc`.

## Skills

Skills are apps with a `skill` field whose command template references `$SKILL` and `$INPUT` env vars. The `_skills` reserved key provides shared defaults (command, cwd) for all skill apps. Two card types: **skill cards** (launch a named skill via `/$SKILL <input>`, `slashPrefix: true` default) and **project cards** (open an assistant scoped to a project directory, `slashPrefix: false`, input sent as plain text).

**Inline mini-terminal**: Skill cards embed a lightweight inline terminal (MiniTerminal). Text selection is disabled; the "Open in Tab" button is visually emphasized. When the skill input is empty and a mini-terminal is active, certain keys are forwarded directly to the PTY: digits `1`–`9`, `Backspace`, and `Arrow Up/Down`.

When a skill session is spawned with a `snapshot` in the POST body, the server writes it to `~/.wsh/snapshots/<agentSessionId>.md` before spawning the PTY. The skill reads the file via the predictable path `~/.wsh/snapshots/$WSH_SESSION.md` — faster than reading a large env var through bash. Snapshot files are cleaned up on PTY exit.

## Events

Lightweight pub/sub event bus backed by an append-only log file (`~/.wsh/events.log`, NDJSON). Events have a `type` (dotted namespace), monotonic `ts`, and optional `data`.

**Event types:** `namespace.action` convention (e.g. `deploy.done`, `job.failed`). System events use `sys.*` prefix with three levels (e.g. `sys.session.opened`); user events use two levels.

**Emit:** `wsh emit <type> [key=value...]`, `POST /api/events`, or in-process `emit(type, data)`. Key=value args are auto-parsed (numbers, booleans, JSON arrays/objects); plain strings are the fallback. Use stdin (`-`) for full control over types.

**Consume:** `wsh events [--filter X] [--name X] [--exec CMD]`, `GET /api/events` (SSE), or in-process `on(fn)`.

**Persistence:** Events persist to disk; named consumers (`--name`) get tracked cursors (`~/.wsh/events/cursors/<name>`) for resumable subscriptions. Log auto-rotated to last 10k lines (on startup and every 100 emits at runtime). Manual cleanup via `wsh gc events [--keep N|duration]`.

**Named consumers:** One consumer per name enforced via PID file; `--force` to take over. With `--exec`, cursor advances client-side only after successful handler execution (at-least-once delivery). Without `--exec`, cursor is managed server-side. Note: `--since` with `--name` replays from the given point and resets the cursor as events are consumed.

**Exec mode:** `--exec` spawns a command per event with `$EVENT` (full JSON), `$EVENT_TYPE`, `$EVENT_TS`, and flat data fields as env vars. `{}` in the command is replaced with event JSON. Handler failures are logged but don't stop the consumer.

## Distribution

Single Go binary. Downloads and caches Node.js LTS to `~/.wsh/node/`. Embeds `dist/`, `public/`, `node_modules/` (~15-18 MB). Build must run on the target platform.
