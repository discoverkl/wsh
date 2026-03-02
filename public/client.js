const term = new Terminal({
    disableStdin: true,
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: '"JetBrains Mono", monospace',
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
fitAddon.fit();
term.focus();
const windowTitle = document.getElementById('window-title');
term.onTitleChange((title) => {
    const t = title || 'bash';
    windowTitle.textContent = t;
    document.title = t;
});
// Show app version as a tooltip on the window title.
fetch('/').then(r => {
    const v = r.headers.get('X-App-Version');
    if (v)
        windowTitle.title = `wsh v${v}`;
});
// Writer share links embed the token in the hash: /#id?wt=...
// Viewer share links are just /#id — the session ID alone is the viewer secret.
function getSessionParams() {
    const hash = location.hash.slice(1);
    const q = hash.indexOf('?');
    let id = q >= 0 ? hash.slice(0, q) : hash;
    const params = q >= 0 ? new URLSearchParams(hash.slice(q + 1)) : null;
    if (!id) {
        id = (crypto.getRandomValues(new Uint32Array(1))[0] % 2176782336).toString(36).padStart(6, '0');
        location.hash = id;
    }
    return { sessionId: id, wtoken: params?.get('wt') ?? null };
}
const { sessionId, wtoken } = getSessionParams();
// sessionStorage keys (tab-specific, survive refresh):
// PREFER_VIEWER: this tab was demoted or self-switched to viewer — don't claim writer on reconnect.
// IS_OWNER:      this tab is the owner — can always reclaim writer by clearing PREFER_VIEWER.
const PREFER_VIEWER = `wsh_prefer_viewer_${sessionId}`;
const IS_OWNER = `wsh_is_owner_${sessionId}`;
document.getElementById('new-session').addEventListener('click', () => {
    window.open(location.origin, '_blank');
});
document.querySelector('.dot.close').addEventListener('click', () => {
    sendAction({ type: 'close' });
});
document.querySelector('.dot.maximize').addEventListener('click', () => {
    if (document.fullscreenElement) {
        document.exitFullscreen();
    }
    else {
        document.documentElement.requestFullscreen();
    }
});
document.addEventListener('fullscreenchange', () => {
    requestAnimationFrame(() => fitAddon.fit());
});
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
function buildWsQuery() {
    const preferViewer = sessionStorage.getItem(PREFER_VIEWER) === 'true';
    const query = new URLSearchParams({ session: sessionId });
    if (wtoken && !preferViewer) {
        query.set('wtoken', wtoken);
    }
    // yield=1 tells the server not to claim the writer seat even if credentials allow it.
    // Needed for owners (whose credential comes from IP, not a token that can simply be omitted).
    if (preferViewer) {
        query.set('yield', '1');
    }
    return query;
}
let ws;
let intentionalReconnect = false;
let currentRole = '';
function connect() {
    ws = new WebSocket(`${proto}://${location.host}/terminal?${buildWsQuery()}`);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
        setConnStatus('connected');
        requestAnimationFrame(() => {
            fitAddon.fit();
            sendResize(term.cols, term.rows);
        });
    });
    ws.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
            term.write(new Uint8Array(event.data));
        }
        else if (typeof event.data === 'string') {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'role' && msg.role)
                    applyRole(msg.role);
            }
            catch { /* ignore */ }
        }
    });
    ws.addEventListener('close', (event) => {
        if (intentionalReconnect) {
            intentionalReconnect = false;
            return;
        }
        setConnStatus('disconnected');
        if (event.code === 1000 && event.reason === 'PTY process exited') {
            location.hash = '';
            term.write('\r\n[Process exited. Refresh to start a new session.]\r\n');
        }
        else {
            term.write('\r\n[Disconnected. Refresh to reconnect.]\r\n');
        }
    });
}
connect();
function sendAction(msg) {
    if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify(msg));
}
function sendResize(cols, rows) {
    sendAction({ type: 'resize', cols, rows });
}
const connStatus = document.getElementById('conn-status');
function setConnStatus(state) {
    connStatus.className = state;
    connStatus.title = state === 'connected' ? 'Connected' : 'Disconnected';
}
const roleBadge = document.getElementById('role-badge');
function applyRole(role) {
    currentRole = role;
    if (role === 'owner') {
        // Remember we are the owner of this session for the lifetime of this tab.
        sessionStorage.setItem(IS_OWNER, 'true');
        roleBadge.setAttribute('hidden', '');
        term.options.disableStdin = false;
        return;
    }
    if (role === 'viewer') {
        // Persist demotion so refresh reconnects as viewer rather than reclaiming writer.
        sessionStorage.setItem(PREFER_VIEWER, 'true');
    }
    // Viewer can switch to writer if they hold a writer token OR are the session owner.
    const canUpgrade = role === 'viewer' && (!!wtoken || sessionStorage.getItem(IS_OWNER) === 'true');
    const switchable = role === 'writer' || canUpgrade;
    roleBadge.textContent = role === 'writer' ? 'Writer' : 'View Only';
    roleBadge.className = role + (switchable ? ' switchable' : '');
    roleBadge.removeAttribute('hidden');
    term.options.disableStdin = role !== 'writer';
}
roleBadge.addEventListener('click', () => {
    if (currentRole === 'viewer' && (wtoken || sessionStorage.getItem(IS_OWNER) === 'true')) {
        sessionStorage.removeItem(PREFER_VIEWER);
        term.reset();
        intentionalReconnect = true;
        ws.close();
        connect();
    }
    else if (currentRole === 'writer') {
        sessionStorage.setItem(PREFER_VIEWER, 'true');
        term.reset();
        intentionalReconnect = true;
        ws.close();
        connect();
    }
});
term.attachCustomKeyEventHandler((e) => {
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.type === 'keydown' && ws.readyState === WebSocket.OPEN)
            ws.send('\x1b[13;2u');
        return false;
    }
    return true;
});
term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN)
        ws.send(data);
});
term.onBinary((data) => {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(Uint8Array.from(data, (c) => c.charCodeAt(0)).buffer);
    }
});
let resizeTimer;
function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => fitAddon.fit(), 150);
}
term.onResize(({ cols, rows }) => sendResize(cols, rows));
window.addEventListener('resize', scheduleResize);
const container = document.getElementById('terminal-container');
if (container)
    new ResizeObserver(scheduleResize).observe(container);
// --- Share popover ---
const shareBtn = document.getElementById('share-btn');
const sharePopover = document.getElementById('share-popover');
const shareError = document.getElementById('share-error');
shareBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (sharePopover.classList.contains('visible')) {
        sharePopover.classList.remove('visible');
        return;
    }
    try {
        const res = await fetch(`/api/share?session=${sessionId}`);
        const data = await res.json();
        if (data.error) {
            shareError.textContent = data.error;
            shareError.removeAttribute('hidden');
            document.getElementById('writer-url').value = '';
            document.getElementById('viewer-url').value = '';
        }
        else {
            shareError.setAttribute('hidden', '');
            document.getElementById('writer-url').value = data.writer ?? '';
            document.getElementById('viewer-url').value = data.viewer ?? '';
        }
    }
    catch {
        shareError.textContent = 'Failed to fetch share URLs';
        shareError.removeAttribute('hidden');
    }
    sharePopover.classList.add('visible');
});
document.addEventListener('click', () => sharePopover.classList.remove('visible'));
sharePopover.addEventListener('click', (e) => e.stopPropagation());
document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.for);
        navigator.clipboard.writeText(input.value).then(() => {
            const orig = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = orig; }, 1500);
        });
    });
});
export {};
