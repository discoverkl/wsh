// MiniTerminal — lightweight inline terminal component for skill cards.
// Lazy-loads xterm.js + fit addon from CDN, streams PTY output read-only.
import { bindTouchScroll } from './touch-scroll.js';
import { handleWshRpc, makeResponder } from './wsh-rpc.js';
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
        link.href = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css';
        document.head.appendChild(link);
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.js';
        script.onload = () => {
            const fitScript = document.createElement('script');
            fitScript.src = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.js';
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
.mt-bar.collapsed {
  border-bottom: 1px solid #333342;
  border-radius: 8px;
}
.mt-status {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #9c9cb2;
  flex: 1;
  cursor: pointer;
  user-select: none;
}
.mt-chevron {
  width: 14px;
  height: 14px;
  color: #6c7086;
  transition: transform 0.2s ease;
  flex-shrink: 0;
}
.mt-bar.collapsed .mt-chevron {
  transform: rotate(-90deg);
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
  position: relative;
  height: 360px;
  border: 1px solid #333342;
  border-radius: 0 0 8px 8px;
  overflow: hidden;
}
.mt-term.collapsed {
  height: 0;
  border-width: 0;
  visibility: hidden;
}
.mt-term .xterm {
  padding: 4px;
}
.mt-term .xterm { background: #1e1e2e; }
.mt-term .xterm-cursor-layer { display: none !important; }
.mt-term .xterm * { cursor: default !important; }
.mt-term .xterm-helper-textarea { pointer-events: none !important; }
.mt-term .xterm-viewport {
  overflow-y: auto !important;
  background-color: #1e1e2e !important;
  opacity: 1 !important;
  scrollbar-width: thin;
  scrollbar-color: #45475a transparent;
}
.mt-term .xterm-viewport::-webkit-scrollbar { width: 6px; height: 6px; }
.mt-term .xterm-viewport::-webkit-scrollbar-track { background: transparent; }
.mt-term .xterm-viewport::-webkit-scrollbar-thumb { background: #45475a; border-radius: 3px; }
.mt-term .xterm-viewport::-webkit-scrollbar-thumb:hover { background: #585b70; }
html.touch .mt-term .xterm-scrollable-element { pointer-events: none; }
.mt-loading {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: #1e1e2e;
  transition: opacity 0.3s ease;
}
.mt-loading.fade-out {
  opacity: 0;
  pointer-events: none;
}
.mt-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid #333342;
  border-top-color: #89b4fa;
  border-radius: 50%;
  animation: mt-spin 0.8s linear infinite;
}
@keyframes mt-spin {
  to { transform: rotate(360deg); }
}
.mt-loading-text {
  color: #6c7086;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 12px;
  letter-spacing: 0.3px;
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
    create(container, sessionId, sessionUrl, reconnect) {
        injectStyles();
        // Build DOM
        const bar = document.createElement('div');
        bar.className = 'mt-bar';
        const status = document.createElement('span');
        status.className = 'mt-status';
        const dot = document.createElement('span');
        dot.className = 'mt-dot';
        const chevron = document.createElement('span');
        chevron.className = 'mt-chevron';
        chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
        status.appendChild(chevron);
        status.appendChild(dot);
        status.appendChild(document.createTextNode('Running...'));
        const popoutBtn = document.createElement('button');
        popoutBtn.className = 'mt-btn';
        popoutBtn.textContent = 'Open in Tab';
        popoutBtn.setAttribute('data-action', 'popout');
        popoutBtn.tabIndex = -1;
        const closeBtn = document.createElement('button');
        closeBtn.className = 'mt-btn';
        closeBtn.textContent = 'Close';
        closeBtn.setAttribute('data-action', 'close');
        closeBtn.tabIndex = -1;
        const escBtn = document.createElement('button');
        escBtn.className = 'mt-btn';
        escBtn.textContent = 'Esc';
        escBtn.setAttribute('data-action', 'esc');
        escBtn.tabIndex = -1;
        const bottomBtn = document.createElement('button');
        bottomBtn.className = 'mt-btn';
        bottomBtn.textContent = '\u2193 Bottom';
        bottomBtn.setAttribute('data-action', 'bottom');
        bottomBtn.tabIndex = -1;
        bar.appendChild(status);
        bar.appendChild(escBtn);
        bar.appendChild(bottomBtn);
        bar.appendChild(popoutBtn);
        bar.appendChild(closeBtn);
        const termDiv = document.createElement('div');
        termDiv.className = 'mt-term';
        // Loading overlay — shown until first PTY data arrives
        const loading = document.createElement('div');
        loading.className = 'mt-loading';
        const spinner = document.createElement('div');
        spinner.className = 'mt-spinner';
        const loadingText = document.createElement('div');
        loadingText.className = 'mt-loading-text';
        loadingText.textContent = 'Starting...';
        loading.appendChild(spinner);
        loading.appendChild(loadingText);
        termDiv.appendChild(loading);
        container.appendChild(bar);
        container.appendChild(termDiv);
        // Toggle collapse on status bar click
        status.addEventListener('click', () => {
            const collapsed = bar.classList.toggle('collapsed');
            termDiv.classList.toggle('collapsed', collapsed);
        });
        let ws = null;
        let term = null;
        let fitAddon = null;
        let ro = null;
        let disposed = false;
        /** Disconnect the WebSocket and tear down the DOM without killing the PTY. */
        function disconnect() {
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
        /** Kill the PTY session, then disconnect. */
        function cleanup() {
            if (disposed)
                return;
            if (ws) {
                try {
                    if (ws.readyState === WebSocket.OPEN)
                        ws.send(JSON.stringify({ type: 'close' }));
                }
                catch { }
            }
            disconnect();
        }
        escBtn.addEventListener('click', () => {
            if (ws && ws.readyState === WebSocket.OPEN)
                ws.send('\x1b');
        });
        bottomBtn.addEventListener('click', () => {
            if (term)
                term.scrollToBottom();
        });
        popoutBtn.addEventListener('click', () => {
            try {
                const u = new URL(sessionUrl);
                window.open(u.pathname + u.hash, '_blank');
            }
            catch {
                window.open(sessionUrl, '_blank');
            }
            disconnect(); // hand off session to the new tab, don't kill the PTY
        });
        closeBtn.addEventListener('click', () => {
            // Immediate visual feedback: fade out, then cleanup after transition.
            bar.style.transition = termDiv.style.transition = 'opacity 0.2s ease';
            bar.style.opacity = termDiv.style.opacity = '0';
            bar.style.pointerEvents = termDiv.style.pointerEvents = 'none';
            setTimeout(() => cleanup(), 200);
        });
        // Load xterm and connect
        ensureXterm().then(() => {
            if (disposed)
                return;
            term = new Terminal({
                disableStdin: false,
                cursorStyle: 'bar',
                cursorWidth: 1,
                cursorBlink: false,
                cursorInactiveStyle: 'none',
                fontSize: 13,
                scrollback: 5000,
                fontFamily: '"JetBrains Mono", monospace',
                theme: THEME,
                convertEol: false,
            });
            fitAddon = new FitAddon.FitAddon();
            term.loadAddon(fitAddon);
            term.open(termDiv);
            // Make xterm non-focusable so focus stays on the skill input box.
            const xtermTextarea = termDiv.querySelector('.xterm-helper-textarea');
            if (xtermTextarea)
                xtermTextarea.tabIndex = -1;
            term.textarea?.blur();
            // Block keyboard input while allowing xterm.js to respond to OSC queries.
            // (disableStdin suppresses OSC responses, causing TUI apps to stall.)
            term.attachCustomKeyEventHandler(() => false);
            let clearingSelection = false;
            term.onSelectionChange(() => {
                if (clearingSelection)
                    return;
                clearingSelection = true;
                term.clearSelection();
                clearingSelection = false;
            });
            // Touch scrolling with inertia (same xterm.js v6 workaround as full terminal)
            bindTouchScroll({
                el: termDiv,
                lineHeight: Math.ceil((term.options.fontSize || 13) * (term.options.lineHeight || 1.2)),
                scrollLines: (n) => term.scrollLines(n),
                isAtTop: () => term.buffer.active.viewportY === 0,
                isAtBottom: () => term.buffer.active.viewportY >= term.buffer.active.baseY,
            });
            fitAddon.fit();
            // WebSocket connection
            const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = new URL('./terminal', location.href);
            wsUrl.protocol = proto;
            const wsParams = { session: sessionId };
            if (reconnect)
                wsParams.reconnect = '1';
            wsUrl.search = new URLSearchParams(wsParams).toString();
            ws = new WebSocket(wsUrl.href);
            ws.binaryType = 'arraybuffer';
            // Forward xterm.js programmatic responses (e.g. OSC color query replies)
            // back to the PTY as text (matching full terminal's term.onData handler).
            // Without this, TUI apps that query terminal colors stall waiting for
            // responses that never arrive.
            term.onData((data) => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(data);
                }
            });
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
                    // Hide loading overlay on first PTY data
                    if (loading.parentNode) {
                        loading.classList.add('fade-out');
                        setTimeout(() => loading.remove(), 300);
                    }
                    term.write(new Uint8Array(event.data));
                }
                else {
                    handleWshRpc(event, container, makeResponder(ws));
                }
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
            // ResizeObserver for fit — skip when collapsed
            let lastCols = term.cols, lastRows = term.rows;
            ro = new ResizeObserver(() => {
                if (disposed || !fitAddon || termDiv.classList.contains('collapsed'))
                    return;
                fitAddon.fit();
                if (term.cols !== lastCols || term.rows !== lastRows) {
                    lastCols = term.cols;
                    lastRows = term.rows;
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                    }
                }
            });
            ro.observe(termDiv);
        }).catch(() => {
            status.lastChild.textContent = 'Failed to load terminal';
            dot.classList.add('exited');
        });
        return {
            dispose: cleanup,
            send(data) {
                if (ws && ws.readyState === WebSocket.OPEN)
                    ws.send(data);
            },
            isAlive() {
                return !disposed && !!ws && ws.readyState === WebSocket.OPEN;
            },
        };
    }
};
