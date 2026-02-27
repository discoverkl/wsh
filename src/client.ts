import type { Terminal as TerminalType } from '@xterm/xterm';
import type { FitAddon as FitAddonType } from '@xterm/addon-fit';

// These globals are injected by the CDN <script> tags in index.html.
declare const Terminal: typeof TerminalType;
declare const FitAddon: { FitAddon: new () => FitAddonType };

const term = new Terminal({
  cursorBlink: true,
  cursorStyle: 'block',
  fontFamily: '"Monaco", "Cascadia Code", "Fira Code", monospace',
  fontSize: 14,
  lineHeight: 1.2,
  scrollback: 10000,
  convertEol: false,
  theme: {
    background: '#000000',
    foreground: '#d4d4d4',
    black: '#1e1e1e',
    red: '#f44747',
    green: '#6a9955',
    yellow: '#d7ba7d',
    blue: '#569cd6',
    magenta: '#c678dd',
    cyan: '#4ec9b0',
    white: '#d4d4d4',
    brightBlack: '#808080',
    brightRed: '#f44747',
    brightGreen: '#b5cea8',
    brightYellow: '#dcdcaa',
    brightBlue: '#9cdcfe',
    brightMagenta: '#c678dd',
    brightCyan: '#4ec9b0',
    brightWhite: '#ffffff',
  },
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-container') as HTMLElement);
fitAddon.fit(); // size before WebSocket connects so scrollback replays at correct dimensions
term.focus();

// Resolve or create a session ID persisted in the URL hash.
function getSessionId(): string {
  let id = location.hash.slice(1);
  if (!id) {
    // 6 base36 chars = 36^6 ≈ 2.2B combinations, plenty for a single user.
    id = (crypto.getRandomValues(new Uint32Array(1))[0] % 2176782336).toString(36).padStart(6, '0');
    location.hash = id;
  }
  return id;
}

const sessionId = getSessionId();

const ws = new WebSocket(`ws://${location.host}/terminal?session=${sessionId}`);
ws.binaryType = 'arraybuffer';

function sendResize(cols: number, rows: number): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
}

ws.addEventListener('open', () => {
  requestAnimationFrame(() => {
    fitAddon.fit();
    sendResize(term.cols, term.rows);
  });
});

ws.addEventListener('message', (event: MessageEvent) => {
  if (event.data instanceof ArrayBuffer) {
    term.write(new Uint8Array(event.data));
  }
});

ws.addEventListener('close', (event: CloseEvent) => {
  if (event.code === 1000 && event.reason === 'PTY process exited') {
    // PTY exited cleanly — clear session so next reload starts fresh.
    location.hash = '';
    term.write('\r\n[Process exited. Refresh to start a new session.]\r\n');
  } else {
    term.write('\r\n[Disconnected. Refresh to reconnect.]\r\n');
  }
});

term.onData((data: string) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
});

term.onBinary((data: string) => {
  if (ws.readyState === WebSocket.OPEN) {
    const buf = Uint8Array.from(data, (c) => c.charCodeAt(0));
    ws.send(buf.buffer);
  }
});

let resizeTimer: ReturnType<typeof setTimeout>;

function scheduleResize(): void {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    fitAddon.fit();
  }, 150);
}

term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
  sendResize(cols, rows);
});

window.addEventListener('resize', scheduleResize);

const container = document.getElementById('terminal-container');
if (container) {
  const observer = new ResizeObserver(scheduleResize);
  observer.observe(container);
}
