const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: '"JetBrains Mono", "Fira Code", monospace',
    fontSize: 14,
    lineHeight: 1.2,
    fontWeightBold: '700',
    scrollback: 10000,
    convertEol: false,
    macOptionIsMeta: true,
    rightClickSelectsWord: true,
    smoothScrollDuration: 100,
    theme: {
        // Catppuccin Mocha
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        selectionBackground: 'rgba(205,214,244,0.15)',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#89dceb',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#cba6f7',
        brightCyan: '#94e2d5',
        brightWhite: '#cdd6f4',
    },
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-container'));
fitAddon.fit(); // size before WebSocket connects so scrollback replays at correct dimensions
term.focus();
// Resolve or create a session ID persisted in the URL hash.
function getSessionId() {
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
function sendResize(cols, rows) {
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
ws.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        term.write(bytes);
    }
});
ws.addEventListener('close', (event) => {
    if (event.code === 1000 && event.reason === 'PTY process exited') {
        // PTY exited cleanly — clear session so next reload starts fresh.
        location.hash = '';
        term.write('\r\n[Process exited. Refresh to start a new session.]\r\n');
    }
    else {
        term.write('\r\n[Disconnected. Refresh to reconnect.]\r\n');
    }
});
term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
    }
});
term.onBinary((data) => {
    if (ws.readyState === WebSocket.OPEN) {
        const buf = Uint8Array.from(data, (c) => c.charCodeAt(0));
        ws.send(buf.buffer);
    }
});
let resizeTimer;
function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        fitAddon.fit();
    }, 150);
}
term.onResize(({ cols, rows }) => {
    sendResize(cols, rows);
});
window.addEventListener('resize', scheduleResize);
const container = document.getElementById('terminal-container');
if (container) {
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(container);
}
export {};
