# wsh Design Notes

## Architecture

```
Browser (xterm.js)  ←──WS──→  server.ts  ←──bytes──→  node-pty (bash/claude)
```

**Per-connection model**: one PTY spawned per WebSocket connection. Two tabs = two independent sessions.

**Message framing**:
- Binary frame → raw bytes to PTY (keyboard input, legacy X10 mouse)
- Text frame, JSON `{type:"resize", cols, rows}` → `ptyProcess.resize()`
- PTY output → binary frame to client

## Critical Claude Code Requirements

| Requirement | Implementation |
|---|---|
| `TERM=xterm-256color` | node-pty `name` field + explicit `env` override |
| `COLORTERM=truecolor` | explicit `env` override |
| Correct initial size | `fitAddon.fit()` + `sendResize` in `requestAnimationFrame` on WS open |
| Mouse support | Automatic via xterm.js SGR mode; `onBinary` handles legacy X10 (bytes >127) |
| No PTY orphans | `ptyProcess.kill('SIGHUP')` on WS close |
| Resize stability | 150ms debounce; use `term.onResize` (not window event) as send trigger |

**`convertEol: false`** — PTY already emits `\r\n`; double-converting causes artifacts.
**`overflow: hidden` on body** — prevents scrollbars that shrink viewport and trigger FitAddon resize loops.

## Distribution: Go Wrapper Binary

Single executable, no prerequisites. On first run:
1. Download and cache Node.js LTS to `~/.wsh/node/v{VERSION}/` (SHA256 verified)
2. Extract embedded app files to `~/.wsh/app/v{APP_VERSION}/`
3. Exec Node.js server

Subsequent runs skip 1 and 2 — near-instant startup.

Node.js (~30 MB) is downloaded, not embedded. The Go binary embeds `dist/`, `public/`, `node_modules/` (~15–18 MB total), including the platform-native `pty.node` addon. Build must run on the target platform for this reason.

## Security Model

- HTTP on localhost, HTTPS (self-signed, fingerprint printed) on LAN interface
- Owner token: stable, derived from TLS key; stored as `HttpOnly` cookie after first use
- Writer token: per-session, 16-char hex, derived from TLS key + salt + session ID
- Viewer access: session ID only (6-char base-36, treat as semi-private)
- Only one writer active at a time; new writer demotes previous writer to viewer
