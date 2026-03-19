# wsh RPC

Client-side JavaScript evaluation via WebSocket, triggered from PTY processes or server code.

## How It Works

All RPC messages are `eval` — they execute JavaScript on connected browser clients. Pages expose capabilities on `window.api` (e.g. `api.toast`, `api.refreshCatalog`). The RPC system simply delivers code to the browser for execution.

## Entry Points

| Source | Method |
|---|---|
| PTY process | `wsh rpc [options] <code>` or pipe via `wsh rpc -` |
| Server code | `broadcastRpc('eval', code)` / `sessionRpc(id, 'eval', code)` |
| Control WebSocket | Connect with `session=_rpc` to receive broadcasts without a terminal |

## CLI Usage

```bash
# Send to own session (default via $WSH_SESSION)
wsh rpc 'api.toast("hello")'

# Target a specific session
wsh rpc --session <id> 'api.toast("done")'

# Target catalog/index pages only
wsh rpc --session index 'api.refreshCatalog()'

# Broadcast to all sessions + index pages
wsh rpc --broadcast 'api.toast("server restarting")'

# Read code from stdin (useful for complex HTML)
wsh rpc --broadcast - <<'JS'
api.toast({
  html: '<div><b>Deployed</b> v2.4.1</div>',
  raw: true
})
JS

# Fire-and-forget (no response wait)
wsh rpc --async 'api.toast("fire and forget")'

# Custom timeout
wsh rpc --timeout 30000 'api.someSlowAction()'
```

## window.api

Pages register capabilities on `window.api`. Built-in:

| Method | Description |
|---|---|
| `api.toast(msg)` | Show a toast notification. `msg` is a string or options object. |

### api.toast(msg)

```js
// Plain text
api.toast("Hello world")

// Plain text with options
api.toast({ text: "Hello", duration: 5000 })

// HTML content
api.toast({ html: "<b>Bold</b> message" })

// Raw mode — no icon, accent bar, or progress bar
api.toast({ html: "<div>fully custom</div>", raw: true })

// Sticky — no auto-dismiss (duration: 0)
api.toast({ text: "Close me manually", duration: 0 })
```

Options: `text`, `html`, `raw` (boolean), `duration` (ms, 0=sticky, default 8000).

### Catalog-specific

| Method | Description |
|---|---|
| `api.refreshCatalog()` | Reload the app/skill list |
| `api.sessionReady(sessionId, appKey, title)` | Show a "ready" toast for a web app session |

## Extending

Any page can add to `window.api`:

```js
import './api.js';
api.myAction = (arg) => { /* ... */ };
```

Then callable via: `wsh rpc 'api.myAction("value")'`

## Protocol

RPC messages arrive as `{ type: 'rpc', action: 'eval', args: [code] }` JSON over WebSocket. The `wsh-rpc` module dispatches them and returns `{ value }` or `{ error }` responses for sync calls.
