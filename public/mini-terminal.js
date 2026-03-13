"use strict";
// MiniTerminal — lightweight inline terminal component for skill cards.
// Lazy-loads xterm.js + fit addon from CDN, streams PTY output read-only.
let xtermPromise = null;
function ensureXterm() {
    if (xtermPromise)
        return xtermPromise;
    xtermPromise = new Promise((resolve, reject) => {
        if (document.getElementById('mt-xterm-css')) {
            resolve();
            return;
        }
        const link = document.createElement('link');
        link.id = 'mt-xterm-css';
        link.rel = 'stylesheet';
        link.href = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css';
        document.head.appendChild(link);
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js';
        script.onload = () => {
            const fitScript = document.createElement('script');
            fitScript.src = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js';
            fitScript.onload = () => resolve();
            fitScript.onerror = () => reject(new Error('Failed to load xterm fit addon'));
            document.head.appendChild(fitScript);
        };
        script.onerror = () => reject(new Error('Failed to load xterm.js'));
        document.head.appendChild(script);
    });
    return xtermPromise;
}
function injectStyles() {
    if (document.getElementById('mt-styles'))
        return;
    const style = document.createElement('style');
    style.id = 'mt-styles';
    style.textContent = `
.mt-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: #181825;
  border: 1px solid #333342;
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 12px;
}
.mt-status {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #9c9cb2;
  flex: 1;
}
.mt-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #22c55e;
  animation: mt-pulse 2s ease-in-out infinite;
}
.mt-dot.exited {
  background: #6b7280;
  animation: none;
}
@keyframes mt-pulse {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}
.mt-btn {
  background: transparent;
  border: 1px solid #333342;
  border-radius: 5px;
  color: #9c9cb2;
  font-size: 11px;
  padding: 3px 10px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s, color 0.15s;
}
.mt-btn:hover {
  background: rgba(255,255,255,0.06);
  color: #cdd6f4;
}
.mt-term {
  height: 200px;
  border: 1px solid #333342;
  border-radius: 0 0 8px 8px;
  overflow: hidden;
}
.mt-term .xterm {
  padding: 4px;
}
`;
    document.head.appendChild(style);
}
const THEME = {
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
};
window.MiniTerminal = {
    create(container, sessionId, sessionUrl) {
        injectStyles();
        // Build DOM
        const bar = document.createElement('div');
        bar.className = 'mt-bar';
        const status = document.createElement('span');
        status.className = 'mt-status';
        const dot = document.createElement('span');
        dot.className = 'mt-dot';
        status.appendChild(dot);
        status.appendChild(document.createTextNode('Running...'));
        const popoutBtn = document.createElement('button');
        popoutBtn.className = 'mt-btn';
        popoutBtn.textContent = 'Open in Tab';
        popoutBtn.setAttribute('data-action', 'popout');
        const closeBtn = document.createElement('button');
        closeBtn.className = 'mt-btn';
        closeBtn.textContent = 'Close';
        closeBtn.setAttribute('data-action', 'close');
        bar.appendChild(status);
        bar.appendChild(popoutBtn);
        bar.appendChild(closeBtn);
        const termDiv = document.createElement('div');
        termDiv.className = 'mt-term';
        container.appendChild(bar);
        container.appendChild(termDiv);
        let ws = null;
        let term = null;
        let fitAddon = null;
        let ro = null;
        let disposed = false;
        function cleanup() {
            if (disposed)
                return;
            disposed = true;
            if (ws) {
                try {
                    ws.close();
                }
                catch { }
                ws = null;
            }
            if (ro) {
                ro.disconnect();
                ro = null;
            }
            if (term) {
                try {
                    term.dispose();
                }
                catch { }
                term = null;
            }
            container.innerHTML = '';
            container.dispatchEvent(new CustomEvent('mt-close', { bubbles: true }));
        }
        popoutBtn.addEventListener('click', () => {
            window.open(sessionUrl, '_blank');
            cleanup();
        });
        closeBtn.addEventListener('click', () => {
            cleanup();
        });
        // Load xterm and connect
        ensureXterm().then(() => {
            if (disposed)
                return;
            term = new Terminal({
                disableStdin: true,
                fontSize: 13,
                scrollback: 5000,
                fontFamily: '"JetBrains Mono", monospace',
                theme: THEME,
                convertEol: false,
            });
            fitAddon = new FitAddon.FitAddon();
            term.loadAddon(fitAddon);
            term.open(termDiv);
            fitAddon.fit();
            // WebSocket connection
            const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = new URL('./terminal', location.href);
            wsUrl.protocol = proto;
            wsUrl.search = new URLSearchParams({ session: sessionId }).toString();
            ws = new WebSocket(wsUrl.href);
            ws.binaryType = 'arraybuffer';
            ws.addEventListener('open', () => {
                if (disposed)
                    return;
                fitAddon.fit();
                const msg = JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows });
                ws.send(msg);
            });
            ws.addEventListener('message', (event) => {
                if (disposed)
                    return;
                if (event.data instanceof ArrayBuffer) {
                    term.write(new Uint8Array(event.data));
                }
                // Ignore JSON control messages (role, etc.)
            });
            ws.addEventListener('close', (event) => {
                if (disposed)
                    return;
                dot.classList.add('exited');
                status.lastChild.textContent = 'Exited';
                if (event.code === 4003) {
                    // Session not found — clean up silently
                    cleanup();
                }
            });
            ws.addEventListener('error', () => {
                if (disposed)
                    return;
                dot.classList.add('exited');
                status.lastChild.textContent = 'Error';
            });
            // ResizeObserver for fit
            ro = new ResizeObserver(() => {
                if (disposed || !fitAddon)
                    return;
                fitAddon.fit();
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                }
            });
            ro.observe(termDiv);
        }).catch(() => {
            status.lastChild.textContent = 'Failed to load terminal';
            dot.classList.add('exited');
        });
        return { dispose: cleanup };
    }
};
