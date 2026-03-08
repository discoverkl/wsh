import type { Terminal as TerminalType } from '@xterm/xterm';
import type { FitAddon as FitAddonType } from '@xterm/addon-fit';

// These globals are injected by the CDN <script> tags in index.html.
declare const Terminal: typeof TerminalType;
declare const FitAddon: { FitAddon: new () => FitAddonType };

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
term.open(document.getElementById('terminal-container') as HTMLElement);
fitAddon.fit();
term.focus();

const windowTitle = document.getElementById('window-title')!;

// Show app version as a tooltip on the window title.
fetch('./').then(r => {
  const v = r.headers.get('X-App-Version');
  if (v) windowTitle.title = `wsh v${v}`;
});

// Check if a session ID is already in the URL before parsing (used below).
const hadSession = location.hash.length > 1;

// Writer share links embed the token in the hash: /#id?wt=...
// Viewer share links are just /#id — the session ID alone is the viewer secret.
function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? match[1] : null;
}

function getSessionParams(): { sessionId: string; wtoken: string | null } {
  const hash = location.hash.slice(1);
  const q = hash.indexOf('?');
  let id = q >= 0 ? hash.slice(0, q) : hash;
  const params = q >= 0 ? new URLSearchParams(hash.slice(q + 1)) : null;
  if (!id) {
    // For web apps: check last-session cookie before generating a new ID
    const pathParts = location.pathname.replace(/\/+$/g, '').split('/');
    const app = pathParts[pathParts.length - 1] || '';
    const lastSession = getCookie(`wsh_last_${app}`);
    if (lastSession) {
      id = lastSession;
    } else {
      id = (crypto.getRandomValues(new Uint32Array(1))[0] % 2176782336).toString(36).padStart(6, '0');
    }
    location.hash = id;
  }
  return { sessionId: id, wtoken: params?.get('wt') ?? null };
}

const { sessionId, wtoken } = getSessionParams();

// Extract app name from pathname (e.g., /python3 → "python3").
const pathParts = location.pathname.replace(/\/+$/g, '').split('/');
let appName = pathParts[pathParts.length - 1] || 'bash';
windowTitle.textContent = appName;
document.title = appName;

// --- Role state (per-tab via sessionStorage) ---
// Single key: 'active' = connect as owner/writer, 'viewer' = connect with yield.
// First load without hash → creating session → 'active'.
// First load with hash    → joining existing → 'viewer'.
// Refresh                 → key persists, preserving the user's choice.
const ROLE_KEY = `wsh_role_${sessionId}`;
if (!sessionStorage.getItem(ROLE_KEY)) {
  sessionStorage.setItem(ROLE_KEY, hadSession ? 'viewer' : 'active');
}
let isOwner = false;

document.getElementById('titlebar')!.addEventListener('mousedown', e => e.preventDefault());

document.getElementById('new-session')!.addEventListener('click', () => {
  if (appType === 'web') {
    // Web apps: open another tab to the same session
    window.open(`${appName}#${sessionId}`, '_blank');
  } else {
    window.open(appName, '_blank');
  }
});

document.querySelector('.dot.close')!.addEventListener('click', () => {
  if (sessionDead) return;
  sendAction({ type: 'close' });
});

document.getElementById('clear-btn')!.addEventListener('click', () => {
  if (sessionDead) return;
  term.clear();
  sendAction({ type: 'clear' });
  term.focus();
});

if (localStorage.getItem('wsh_compact') === '1') {
  document.documentElement.classList.add('compact');
}

document.querySelector('.dot.minimize')!.addEventListener('click', () => {
  const isCompact = document.documentElement.classList.toggle('compact');
  localStorage.setItem('wsh_compact', isCompact ? '1' : '0');
  requestAnimationFrame(() => fitAddon.fit());
});

document.querySelector('.dot.maximize')!.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen();
  }
});

document.addEventListener('fullscreenchange', () => {
  requestAnimationFrame(() => fitAddon.fit());
});

const proto = location.protocol === 'https:' ? 'wss' : 'ws';

function buildWsQuery(): URLSearchParams {
  const isViewer = sessionStorage.getItem(ROLE_KEY) === 'viewer';
  const query = new URLSearchParams({ session: sessionId });
  if (appName) query.set('app', appName);
  if (wtoken && !isViewer) query.set('wtoken', wtoken);
  if (isViewer) query.set('yield', '1');
  return query;
}

let ws: WebSocket;
let intentionalReconnect = false;
let currentRole = '';
let sessionDead = false;
let appType: 'pty' | 'web' = 'pty';
let showingLogs = false;

function connect(): void {
  const wsBase = new URL('./terminal', location.href);
  wsBase.protocol = proto + ':';
  wsBase.search = buildWsQuery().toString();
  ws = new WebSocket(wsBase.href);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    setConnStatus('connected');
    if (appType !== 'web') {
      requestAnimationFrame(() => {
        fitAddon.fit();
        sendResize(term.cols, term.rows);
      });
    }
  });

  ws.addEventListener('message', (event: MessageEvent) => {
    if (event.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(event.data));
    } else if (typeof event.data === 'string') {
      try {
        const msg = JSON.parse(event.data) as { type: string; role?: string; credential?: string; app?: string; appType?: string; pinned?: boolean; pinnedOther?: { id: string; title: string; app?: string }[]; name?: string; value?: string; status?: string };
        if (msg.type === 'role' && msg.role) {
          if (msg.app && msg.app !== appName) {
            appName = msg.app;
            windowTitle.textContent = appName;
            document.title = appName;
            history.replaceState(null, '', `${appName}#${sessionId}`);
          }
          applyRole(msg.role, msg.credential);
          if (msg.appType === 'web' && appType !== 'web') {
            appType = 'web';
            switchToWebMode();
          }
          if (typeof msg.pinned === 'boolean') applyPinState(msg.pinned);
          if (msg.pinnedOther && msg.pinnedOther.length > 0) showPinnedToast(msg.pinnedOther);
        }
        if (msg.type === 'pin' && typeof msg.pinned === 'boolean') applyPinState(msg.pinned);
        if (msg.type === 'cookie' && msg.name && msg.value) {
          const basePath = location.pathname.split('/').slice(0, -1).join('/') || '/';
          document.cookie = `${msg.name}=${msg.value}; path=${basePath}; max-age=${365 * 24 * 60 * 60}`;
        }
      } catch { /* ignore */ }
    }
  });

  ws.addEventListener('close', (event: CloseEvent) => {
    if (intentionalReconnect) { intentionalReconnect = false; return; }
    setConnStatus('disconnected');
    term.options.disableStdin = true;
    sessionDead = true;
    sharePopover.classList.remove('visible');

    const sessionGone = event.code === 1000 || event.code === 4003 || event.code === 4029;
    if (sessionGone) {
      // Session is permanently gone — hide all session controls.
      pinBtn.setAttribute('hidden', '');
      roleBadge.setAttribute('hidden', '');
      shareBtn.setAttribute('hidden', '');
      document.getElementById('clear-btn')!.setAttribute('hidden', '');
      document.querySelector('.dot.close')!.classList.add('disabled');
    }

    if (event.code === 1000 && (event.reason === 'PTY process exited' || event.reason === 'Process exited')) {
      location.hash = '';
      term.write('\r\n[Process exited. Refresh to start a new session.]\r\n');
    } else if (event.code === 4003) {
      term.write('\r\n[Session not found.]\r\n');
    } else if (event.code === 4029) {
      term.write('\r\n[Too many attempts. Please wait and try again.]\r\n');
    } else {
      term.write('\r\n[Disconnected. Refresh to reconnect.]\r\n');
    }
  });
}

connect();

function switchToWebMode(): void {
  document.getElementById('terminal-container')!.setAttribute('hidden', '');
  const webContainer = document.getElementById('web-container')!;
  webContainer.removeAttribute('hidden');
  const iframe = document.getElementById('web-frame') as HTMLIFrameElement;
  iframe.src = `./_p/${sessionId}/`;
  iframe.addEventListener('load', () => {
    document.getElementById('web-loading')!.setAttribute('hidden', '');
  });
  document.getElementById('clear-btn')!.setAttribute('hidden', '');
  document.getElementById('logs-btn')!.removeAttribute('hidden');
}

document.getElementById('logs-btn')!.addEventListener('click', () => {
  if (sessionDead) return;
  showingLogs = !showingLogs;
  const termContainer = document.getElementById('terminal-container')!;
  const webContainer = document.getElementById('web-container')!;
  if (showingLogs) {
    webContainer.setAttribute('hidden', '');
    termContainer.removeAttribute('hidden');
    term.options.disableStdin = true;
    requestAnimationFrame(() => fitAddon.fit());
  } else {
    termContainer.setAttribute('hidden', '');
    webContainer.removeAttribute('hidden');
  }
});

function sendAction(msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendResize(cols: number, rows: number): void {
  sendAction({ type: 'resize', cols, rows });
}

const connStatus = document.getElementById('conn-status')!;
function setConnStatus(state: 'connected' | 'disconnected'): void {
  connStatus.className = state;
  connStatus.title = state === 'connected' ? 'Connected' : 'Disconnected';
}

const roleBadge = document.getElementById('role-badge')!;
const pinBtn = document.getElementById('pin-btn') as HTMLButtonElement;
let pinned = false;

function applyPinState(state: boolean): void {
  pinned = state;
  pinBtn.classList.toggle('pinned', pinned);
  pinBtn.title = pinned ? 'Unpin (allow timeout after disconnect)' : 'Pin (keep alive after disconnect)';
}

function applyRole(role: string, credential?: string): void {
  currentRole = role;
  if (credential === 'owner') isOwner = true;

  if (role === 'owner') {
    roleBadge.setAttribute('hidden', '');
    term.options.disableStdin = false;
    pinBtn.removeAttribute('hidden');
    return;
  }

  pinBtn.setAttribute('hidden', '');

  const canUpgrade = role === 'viewer' && (isOwner || !!wtoken);
  const switchable = role === 'writer' || canUpgrade;

  roleBadge.textContent = role === 'writer' ? 'Writer' : 'View Only';
  roleBadge.className = role + (switchable ? ' switchable' : '');
  roleBadge.removeAttribute('hidden');
  term.options.disableStdin = role !== 'writer';
}

roleBadge.addEventListener('click', () => {
  if (sessionDead) return;
  const canSwitch = (currentRole === 'viewer' && (isOwner || wtoken)) || currentRole === 'writer';
  if (!canSwitch) return;
  sessionStorage.setItem(ROLE_KEY, currentRole === 'viewer' ? 'active' : 'viewer');
  term.reset();
  intentionalReconnect = true;
  ws.close();
  connect();
});

term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    if (e.type === 'keydown' && ws.readyState === WebSocket.OPEN) ws.send('\x1b[13;2u');
    return false;
  }
  return true;
});

term.onData((data: string) => {
  if (appType === 'web') return;
  if (ws.readyState === WebSocket.OPEN) ws.send(data);
});

term.onBinary((data: string) => {
  if (appType === 'web') return;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(Uint8Array.from(data, (c) => c.charCodeAt(0)).buffer);
  }
});

let resizeTimer: ReturnType<typeof setTimeout>;
function scheduleResize(): void {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => fitAddon.fit(), 150);
}

term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
  if (appType === 'web') return;
  sendResize(cols, rows);
});
window.addEventListener('resize', scheduleResize);

const container = document.getElementById('terminal-container');
if (container) new ResizeObserver(scheduleResize).observe(container);

pinBtn.addEventListener('click', () => {
  if (sessionDead) return;
  applyPinState(!pinned);
  sendAction({ type: 'pin', pinned });
});

// --- Pinned sessions toast ---

const pinnedToast      = document.getElementById('pinned-toast')!;
const pinnedToastMsg   = document.getElementById('pinned-toast-msg')!;
const pinnedToastChips = document.getElementById('pinned-toast-chips')!;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const PINNED_TOAST_SEEN = 'wsh_pinned_toast_seen';
const MAX_CHIPS = 3;

function dismissToast(): void {
  pinnedToast.classList.remove('visible');
  if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null; }
}

function scheduleToastDismiss(): void {
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissToast, 8000);
}

function showPinnedToast(sessions: { id: string; title: string; app?: string }[]): void {
  // Deduplicate: skip if the same set of IDs was already shown in this tab.
  const key = sessions.map(s => s.id).sort().join(',');
  if (sessionStorage.getItem(PINNED_TOAST_SEEN) === key) return;
  sessionStorage.setItem(PINNED_TOAST_SEEN, key);

  pinnedToastMsg.textContent = `${sessions.length} other pinned session${sessions.length === 1 ? '' : 's'}`;
  pinnedToastChips.innerHTML = '';
  const visible = sessions.slice(0, MAX_CHIPS);
  const overflow = sessions.length - visible.length;
  for (const s of visible) {
    const a = document.createElement('a');
    a.className = 'toast-chip';
    a.href = `${s.app ?? 'bash'}#${s.id}`;
    a.target = '_blank';
    a.rel = 'noopener';
    if (s.title && s.title !== 'bash') {
      const title = document.createElement('span');
      title.className = 'chip-title';
      title.textContent = s.title;
      a.appendChild(title);
      const id = document.createElement('span');
      id.className = 'chip-id';
      id.textContent = s.id;
      a.appendChild(id);
    } else {
      a.textContent = s.id;
    }
    pinnedToastChips.appendChild(a);
  }
  if (overflow > 0) {
    const more = document.createElement('span');
    more.className = 'toast-overflow';
    more.textContent = `+${overflow} more`;
    pinnedToastChips.appendChild(more);
  }
  pinnedToast.classList.add('visible');
  scheduleToastDismiss();
}

document.getElementById('toast-dismiss')!.addEventListener('click', dismissToast);
pinnedToast.addEventListener('mouseenter', () => { if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null; } });
pinnedToast.addEventListener('mouseleave', scheduleToastDismiss);

// --- Share popover ---

const shareBtn     = document.getElementById('share-btn')!;
const sharePopover = document.getElementById('share-popover')!;
const shareError   = document.getElementById('share-error')!;

shareBtn.addEventListener('click', async (e: MouseEvent) => {
  e.stopPropagation();
  if (sessionDead) return;
  if (sharePopover.classList.contains('visible')) {
    sharePopover.classList.remove('visible');
    return;
  }
  try {
    const res  = await fetch(`./api/share?session=${sessionId}`);
    const data = await res.json() as { wtoken?: string; error?: string };
    if (data.error) {
      shareError.textContent = data.error;
      shareError.removeAttribute('hidden');
      (document.getElementById('writer-url') as HTMLInputElement).value = '';
      (document.getElementById('viewer-url') as HTMLInputElement).value = '';
    } else {
      shareError.setAttribute('hidden', '');
      const base = `${location.origin}${location.pathname}`;
      (document.getElementById('writer-url') as HTMLInputElement).value = `${base}#${sessionId}?wt=${data.wtoken}`;
      (document.getElementById('viewer-url') as HTMLInputElement).value = `${base}#${sessionId}`;
    }
  } catch {
    shareError.textContent = 'Failed to fetch share URLs';
    shareError.removeAttribute('hidden');
  }
  sharePopover.classList.add('visible');
});

document.addEventListener('click', () => sharePopover.classList.remove('visible'));
sharePopover.addEventListener('click', (e: MouseEvent) => e.stopPropagation());

document.querySelectorAll<HTMLButtonElement>('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.for!)! as HTMLInputElement;
    const text = input.value;
    const done = () => {
      const orig = btn.textContent!;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done);
    } else {
      input.select();
      document.execCommand('copy');
      done();
    }
  });
});
