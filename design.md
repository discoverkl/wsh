# Web Terminal for Claude Code TUI

## Context

The goal is to build a minimal web-based terminal application to test whether Claude Code's TUI can be hosted in a browser. We'll use:

- **xterm.js** — terminal emulator in the browser (renders escape sequences, handles input)
- **node-pty** — spawns a real OS PTY (pseudo-terminal) on the server
- **ws** — WebSocket library bridging the two
- **express** — serves static frontend files

---

## Project Structure

```
xterm/
├── package.json              # deps: express, ws, node-pty; devDeps: typescript, tsx, @types/*
├── tsconfig.json             # Server TypeScript config (src/server.ts → dist/server.js)
├── tsconfig.client.json      # Client TypeScript config (src/client.ts → public/client.js)
├── src/
│   ├── server.ts             # Express + WebSocket + node-pty backend
│   └── client.ts             # xterm.js init, WebSocket connection, resize handling
└── public/
    ├── index.html            # Loads xterm.js + FitAddon from CDN, mounts #terminal-container
    └── client.js             # Compiled output from src/client.ts (gitignored)
```

---

## Architecture

```
Browser (xterm.js)  ←──WS binary──→  src/server.ts  ←──bytes──→  node-pty (bash/claude)
      │                                   │
      │  text: user keystrokes            │  ioctl TIOCSWINSZ on resize
      │  binary: mouse reports            │  SIGHUP on disconnect
      │  JSON: {"type":"resize",...}      │
```

**Per-connection model**: one PTY spawned per WebSocket connection. Two tabs = two independent bash sessions.

---

## File Details

### `package.json`

```json
{
  "name": "xterm-web-terminal",
  "version": "1.0.0",
  "main": "dist/server.js",
  "scripts": {
    "build": "tsc -p tsconfig.json && tsc -p tsconfig.client.json",
    "start": "node dist/server.js",
    "dev": "tsx watch src/server.ts"
  },
  "dependencies": {
    "express": "^4.18.3",
    "ws": "^8.17.1",
    "node-pty": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "tsx": "^4.0.0",
    "@types/express": "^4.17.21",
    "@types/ws": "^8.5.10",
    "@types/node": "^20.0.0"
  }
}
```

### `tsconfig.json` (server)

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "lib": ["ES2020"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/server.ts"]
}
```

### `tsconfig.client.json` (browser)

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "lib": ["ES2020", "DOM"],
    "outDir": "public",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/client.ts"]
}
```

The client tsconfig uses `lib: ["DOM"]` for browser globals (`window`, `WebSocket`, `ResizeObserver`) and outputs `public/client.js` directly alongside `index.html`.

### `src/server.ts`

Key responsibilities:
1. `express.static('public')` serves the frontend
2. `http.Server` + `WebSocketServer({ noServer: true })` share port 3000
3. On WebSocket upgrade to `/terminal`, spawn a node-pty bash PTY with:
   - `name: 'xterm-256color'` (sets `$TERM`)
   - `env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }`
   - `cwd: process.env.HOME`
   - Initial cols/rows: 80×24 (client sends real dimensions immediately on connect)
4. PTY output → `ws.send(Buffer.from(data, 'utf8'), { binary: true })`
5. WS messages dispatched:
   - **Binary frame** (`isBinary === true`): raw bytes → `ptyProcess.write(data.toString('binary'))`
   - **Text frame**, JSON parses as `{type:"resize", cols, rows}`: call `ptyProcess.resize(cols, rows)` (clamped to valid range)
   - **Text frame**, not JSON: `ptyProcess.write(text)` (keyboard input)
6. On PTY exit: `ws.close(1000, 'PTY process exited')`
7. On WS close: `ptyProcess.kill('SIGHUP')` to prevent orphan processes

Type annotations to use:
- `import type { IPty } from 'node-pty'` for the PTY handle
- `import type { WebSocket } from 'ws'` for the WS connection
- `import type { Request, Response } from 'express'` for route handlers
- Resize message typed as `interface ResizeMessage { type: 'resize'; cols: number; rows: number }`

### `public/index.html`

- Loads from CDN:
  - `@xterm/xterm@5.5.0` CSS + JS
  - `@xterm/addon-fit@0.10.0` JS
- CSS: `html, body { width:100%; height:100%; overflow:hidden; background:#1e1e1e; }`, `#terminal-container { width:100vw; height:100vh; }`
- `overflow: hidden` on body is critical — prevents scrollbars that would shrink the viewport and cause FitAddon resize loops
- Loads `/client.js` (compiled from `src/client.ts`) at end of body

### `src/client.ts`

1. **Terminal init**:
   ```ts
   const term = new Terminal({
     cursorBlink: true, cursorStyle: 'block',
     fontFamily: '"Cascadia Code", "Fira Code", monospace', fontSize: 14,
     scrollback: 10000, convertEol: false,
     theme: { background: '#1e1e1e', foreground: '#d4d4d4', /* 16 ANSI colors */ }
   });
   ```
   - `convertEol: false`: PTY already emits `\r\n`; double-converting causes artifacts
   - `scrollback: 10000`: Claude Code outputs long text
   - `Terminal` and `ITerminalOptions` types come from `@xterm/xterm` (bundled — no separate `@types` needed)

2. **FitAddon**: `loadAddon` before `open()`, then `fitAddon.fit()` on ws open

3. **WebSocket**:
   ```ts
   const ws = new WebSocket(`ws://${location.host}/terminal`);
   ws.binaryType = 'arraybuffer';
   ```
   - On `open`: `requestAnimationFrame(() => { fitAddon.fit(); sendResize(term.cols, term.rows); })`
   - On `message`: if `event.data instanceof ArrayBuffer` → `term.write(new Uint8Array(event.data))`
   - On `close`: display `[Session ended. Refresh to reconnect.]` in terminal

4. **Input**:
   - `term.onData((data: string) => ws.send(data))` (text frame; server writes to PTY)
   - `term.onBinary((data: string) => { const buf = Uint8Array.from(data, c => c.charCodeAt(0)); ws.send(buf.buffer); })` (binary frame; for legacy X10 mouse mode byte values >127)

5. **Resize** (debounced, 150ms):
   ```
   window 'resize' / ResizeObserver
     → clearTimeout; setTimeout 150ms
       → fitAddon.fit()
         → term.onResize({cols, rows}) fires
           → ws.send(JSON.stringify({type:'resize', cols, rows}))
             → server: ptyProcess.resize(cols, rows)
               → OS: SIGWINCH sent to Claude Code
                 → Claude Code redraws at new dimensions
   ```
   - Listen to both `window 'resize'` and `ResizeObserver` on the container (for devtools opening)
   - Use `term.onResize` (not the window event) as the send trigger — ensures we send the exact cols/rows FitAddon landed on
   - `sendResize` typed as `(cols: number, rows: number) => void`
   - Debounce timer typed as `let resizeTimer: ReturnType<typeof setTimeout>`

---

## Mouse Event Passthrough

No special client config needed. When Claude Code sends `\x1b[?1006h` (SGR mouse enable), xterm.js automatically:
- Captures DOM mouse events on the canvas
- Encodes them as ANSI SGR mouse reports (`\x1b[<Mb;x;yM`)
- Fires them through `term.onData` (valid UTF-8, sent as text frame)

Legacy X10 mode (bytes >127) handled by `term.onBinary` → binary frame → `ptyProcess.write(data.toString('binary'))`.

---

## Critical Details for Claude Code TUI

| Requirement | Implementation |
|---|---|
| `TERM=xterm-256color` | node-pty `name` field + explicit `env` override |
| `COLORTERM=truecolor` | explicit `env` override |
| Correct initial terminal size | `fitAddon.fit()` + `sendResize` inside `requestAnimationFrame` on WS open |
| Mouse support | Automatic via xterm.js + `onBinary` handler |
| No PTY orphans | `ptyProcess.kill('SIGHUP')` on WS close |
| Resize stability | 150ms debounce, FitAddon as source of truth |

---

## How to Run

```bash
# 1. Install (compiles node-pty native bindings)
cd xterm && npm install
# If this fails: xcode-select --install

# 2. Build TypeScript (server → dist/server.js, client → public/client.js)
npm run build

# 3. Start server
npm start

# OR: development mode (auto-restarts server on changes; rebuild client separately)
npm run dev
```

## Verification Steps

1. **Shell works**: bash prompt appears, can type commands
2. **`echo $TERM`** → `xterm-256color`
3. **`echo $COLORTERM`** → `truecolor`
4. **`tput cols && tput lines`** → matches browser window character dimensions
5. **Resize**: drag window, wait 150ms → dimensions update (`tput cols` changes)
6. **TUI test**: run `vim` or `htop` — cursor movement, colors, full-screen rendering should work
7. **Claude Code**: run `claude` → TUI loads, mouse clicks work, colors are correct

## Known Risk: node-pty Native Build

`node-pty` requires `node-gyp` and Xcode CLI tools on macOS. If `npm install` fails with gyp errors, run `xcode-select --install` first. This is the most likely setup hurdle.
