import type { Terminal as TerminalType } from '@xterm/xterm';
import type { FitAddon as FitAddonType } from '@xterm/addon-fit';

// These globals are injected by the CDN <script> tags in index.html.
declare const Terminal: typeof TerminalType;
declare const FitAddon: { FitAddon: new () => FitAddonType };

const term = new Terminal({
  cursorBlink: true,
  cursorStyle: 'block',
  fontFamily: '"Cascadia Code", "Fira Code", monospace',
  fontSize: 14,
  scrollback: 10000,
  convertEol: false,
  theme: {
    background: '#1e1e1e',
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

const ws = new WebSocket(`ws://${location.host}/terminal`);
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

ws.addEventListener('close', () => {
  term.write('\r\n[Session ended. Refresh to reconnect.]\r\n');
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
