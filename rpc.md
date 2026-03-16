# wsh RPC

PTY-to-client and server-to-client RPC via OSC 777 escape sequences.

## Protocol

```
\x1b]777;wsh:<action>[;<arg1>;<arg2>...]\x07
```

Parts are percent-encoded to avoid conflicts with OSC framing (`;`, control characters).

## Entry Points

| Source | Method |
|---|---|
| PTY process | `wsh rpc <action> [args...]` or raw `printf` |
| Server code | `sessionRpc(id, action, ...args)` / `broadcastRpc(action, ...args)` |
| Control WebSocket | Connect with `session=_rpc` to receive broadcasts without a terminal |

## Client Handling

RPC messages arrive as `{ type: 'rpc', action, args }` JSON over WebSocket. The client dispatches them as `wsh-rpc` CustomEvents on the DOM. Pages register handlers via `onRpc(action, handler)`.

## Scenarios

### PTY → Client (`wsh rpc`)

**Catalog / Navigation:**

| Action | Args | Description |
|---|---|---|
| `refresh-catalog` | — | Reload the catalog app list (e.g. after a skill modifies `apps.yaml`) |
| `navigate` | `appKey` | Redirect the user to another app page |
| `close` | — | Tell the catalog to close the inline terminal widget |
| `launch` | `appKey`, `input?` | Start another app/skill from the catalog (skill chaining) |

**Rich content (things terminals can't do):**

| Action | Args | Description |
|---|---|---|
| `notify` | `message`, `level?` | Show a toast notification (`info`, `success`, `warning`, `error`) |
| `image` | `url` | Display an image in a modal/overlay (diagrams, screenshots, charts) |
| `markdown` | `content` | Render markdown in a panel beside the terminal |
| `html` | `content` | Render arbitrary HTML (rich tables, forms, embedded widgets) |
| `qrcode` | `text` | Display a QR code overlay (sharing URLs to mobile devices) |

**Browser capabilities (things terminals don't have access to):**

| Action | Args | Description |
|---|---|---|
| `copy` | `text` | Copy text to clipboard (generated tokens, passwords, snippets) |
| `open` | `url` | Open a URL in a new browser tab |
| `download` | `url` | Trigger a file download in the browser |
| `upload` | `path?` | Prompt user to pick a file; deliver it to the PTY process |
| `sound` | `name?` | Play a notification sound (for long-running tasks completing) |
| `speak` | `text` | Text-to-speech notification |

**Interactive prompts (better UX than terminal stdin):**

| Action | Args | Description |
|---|---|---|
| `prompt` | `message` | Ask for text input via a browser dialog; response written to PTY stdin |
| `confirm` | `message` | Yes/no confirmation dialog; response written to PTY stdin |
| `select` | `option1`, `option2`, ... | Selection picker; chosen value written to PTY stdin |

**Terminal UX:**

| Action | Args | Description |
|---|---|---|
| `progress` | `percent`, `label` | Show/update a progress indicator on the terminal widget |
| `badge` | `count` | Set a notification badge on the browser tab (0 to clear) |
| `fullscreen` | `state?` | Toggle or set fullscreen mode for the terminal |

**State persistence:**

| Action | Args | Description |
|---|---|---|
| `set` | `key`, `value` | Store a key-value pair in browser localStorage |
| `remove` | `key` | Remove a key from browser localStorage |

### Server → All Clients (`broadcastRpc`)

| Action | Args | Description |
|---|---|---|
| `session-update` | — | Notify catalog to refresh its active sessions list |
| `server-shutdown` | — | Warn all clients that the server is about to restart |
| `config-update` | — | Notify all clients after a REST API modifies `apps.yaml` |
| `version-update` | `version` | Prompt clients to reload when a new server version is deployed |

### Server → Session (`sessionRpc`)

| Action | Args | Description |
|---|---|---|
| `reload-iframe` | — | Tell a web app's iframe to reload after a hot deploy |
| `theme` | `name` | Switch terminal theme on the fly from a running process |
| `title` | `text` | Update the catalog card or tab title for the session |
| `pin` | `state` | Toggle pin state from server-side logic |

## Priority

Top 3 candidates for implementation:

1. **`copy`** — Clipboard access is impossible from a terminal. Skills constantly generate tokens, passwords, and URLs that users need to paste elsewhere.
2. **`confirm`** — Turns one-way RPC into two-way interaction. Browser dialog for destructive actions, response flows back through PTY stdin with no new protocol needed.
3. **`image`** — Bridges the biggest gap between terminal and browser. Turns wsh from text-only into a rich output environment for diagrams, charts, and screenshots.

## Response Channel

Most RPCs are fire-and-forget. For interactive RPCs (`prompt`, `confirm`, `select`, `upload`), the browser writes the user's response back to the PTY process via stdin over the existing WebSocket. This keeps the protocol simple — no need for a separate response mechanism.
