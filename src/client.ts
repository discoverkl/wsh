import type { Terminal as TerminalType } from '@xterm/xterm';
import type { FitAddon as FitAddonType } from '@xterm/addon-fit';
import { bindTouchScroll } from './touch-scroll.js';
import { handleWshRpc, makeResponder } from './wsh-rpc.js';

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

// Auto-compact on small viewports (phones) or restore saved preference
if (localStorage.getItem('wsh_compact') === '1' || window.innerWidth < 768) {
  document.documentElement.classList.add('compact');
}

fitAddon.fit();

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
    history.replaceState(null, '', `#${id}`);
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

let userRequestedClose = false;
document.querySelector('.dot.close')!.addEventListener('click', () => {
  if (sessionDead) {
    window.close();
    return;
  }
  const closeEl = document.querySelector('.dot.close') as HTMLElement;
  if (closeEl?.classList.contains('disabled')) {
    showViewonlyToast(false);
    return;
  }
  userRequestedClose = true;
  // Immediate visual feedback: fade the window out while waiting for server cleanup.
  const win = document.getElementById('window')!;
  win.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
  win.style.opacity = '0';
  win.style.transform = 'scale(0.97)';
  if (appType === 'web') {
    const iframe = document.getElementById('web-frame') as HTMLIFrameElement;
    iframe.src = 'about:blank';
    document.getElementById('web-container')!.setAttribute('hidden', '');
  }
  sendAction({ type: 'close' });
});

const isTouchDevice = document.documentElement.classList.contains('touch');

document.getElementById('clear-btn')!.addEventListener('click', () => {
  if (sessionDead) return;
  term.clear();
  sendAction({ type: 'clear' });
  if (!isTouchDevice) term.focus();
});

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
  query.set('app', appName);
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
    if (!document.getElementById('desktop')!.hasAttribute('hidden') && appType !== 'web') {
      requestAnimationFrame(() => {
        fitAddon.fit();
        sendResize(term.cols, term.rows);
        if (!isTouchDevice) term.focus();
      });
    }
  });

  ws.addEventListener('message', (event: MessageEvent) => {
    if (event.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(event.data));
    } else if (typeof event.data === 'string') {
      if (handleWshRpc(event, document, makeResponder(ws))) return;
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
          const desktop = document.getElementById('desktop')!;
          if (desktop.hasAttribute('hidden')) {
            if (msg.appType === 'web') {
              appType = 'web';
              document.documentElement.classList.add('web', 'compact');
              document.getElementById('web-container')!.removeAttribute('hidden');
              document.getElementById('clear-btn')!.setAttribute('hidden', '');
              document.getElementById('logs-btn')!.removeAttribute('hidden');
              document.getElementById('debug-btn')!.removeAttribute('hidden');
              document.getElementById('share-btn')!.setAttribute('hidden', '');
              document.getElementById('shortcut-bar')!.classList.add('hidden');
              document.getElementById('input-toggle')!.setAttribute('hidden', '');
              term.options.convertEol = true;
            } else {
              document.getElementById('terminal-container')!.removeAttribute('hidden');
            }
            desktop.removeAttribute('hidden');
            if (appType !== 'web') {
              requestAnimationFrame(() => { fitAddon.fit(); sendResize(term.cols, term.rows); if (!isTouchDevice) term.focus(); });
            }
          }
          if (typeof msg.pinned === 'boolean') applyPinState(msg.pinned);
          if (msg.pinnedOther && msg.pinnedOther.length > 0) showPinnedToast(msg.pinnedOther);
        }
        if (msg.type === 'ready' && appType === 'web') {
          const iframe = document.getElementById('web-frame') as HTMLIFrameElement;
          if (!iframe.src || iframe.src === 'about:blank') {
            iframe.src = `./_p/${sessionId}/`;
            iframe.addEventListener('load', () => {
              document.getElementById('web-loading')!.setAttribute('hidden', '');
              iframe.classList.add('loaded');
            });
          }
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
      // Keep close button active so user can close the tab
    }

    if (event.code === 1000 && (event.reason === 'PTY process exited' || event.reason === 'Process exited')) {
      if (userRequestedClose) {
        window.close();
        // window.close() may be blocked if tab wasn't opened via script — fall through
      }
      history.replaceState(null, '', location.pathname);
      if (appType === 'web') {
        document.getElementById('web-container')!.setAttribute('hidden', '');
        document.getElementById('terminal-container')!.removeAttribute('hidden');
        requestAnimationFrame(() => fitAddon.fit());
      }
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

document.getElementById('debug-btn')!.addEventListener('click', () => {
  const base = location.pathname.split('/').slice(0, -1).join('/') || '';
  const input = `debug web app "${appName}" (session ${sessionId})`;
  fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'box', input }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.url) {
        try { const u = new URL(data.url); window.open(u.pathname + u.hash, '_blank'); }
        catch { window.open(data.url, '_blank'); }
      }
    });
});

function sendAction(msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendResize(cols: number, rows: number): void {
  sendAction({ type: 'resize', cols, rows });
}

const connStatus = document.getElementById('conn-status')!;
const connBanner = document.getElementById('conn-banner');
function setConnStatus(state: 'connected' | 'disconnected'): void {
  connStatus.className = state;
  connStatus.title = state === 'connected' ? 'Connected' : 'Disconnected';
  if (connBanner) connBanner.classList.toggle('visible', state === 'disconnected');
}

const roleBadge = document.getElementById('role-badge')!;
const pinBtn = document.getElementById('pin-btn') as HTMLButtonElement;
let pinned = false;

function applyPinState(state: boolean): void {
  pinned = state;
  pinBtn.classList.toggle('pinned', pinned);
  pinBtn.title = pinned ? 'Unpin (allow timeout after disconnect)' : 'Pin (keep alive after disconnect)';
}

// --- View-only toast ---

const viewonlyToast = document.getElementById('viewonly-toast')!;
const viewonlyUpgrade = document.getElementById('viewonly-upgrade')!;
let viewonlyToastTimer: ReturnType<typeof setTimeout> | null = null;

function showViewonlyToast(canUpgrade: boolean): void {
  if (canUpgrade) {
    viewonlyUpgrade.removeAttribute('hidden');
  } else {
    viewonlyUpgrade.setAttribute('hidden', '');
  }
  viewonlyToast.classList.add('visible');
  if (viewonlyToastTimer !== null) clearTimeout(viewonlyToastTimer);
  viewonlyToastTimer = setTimeout(() => {
    viewonlyToast.classList.remove('visible');
    viewonlyToastTimer = null;
  }, 5000);
}

function hideViewonlyToast(): void {
  viewonlyToast.classList.remove('visible');
  if (viewonlyToastTimer !== null) { clearTimeout(viewonlyToastTimer); viewonlyToastTimer = null; }
}

viewonlyUpgrade.addEventListener('click', () => {
  if (sessionDead) return;
  sessionStorage.setItem(ROLE_KEY, 'active');
  term.reset();
  intentionalReconnect = true;
  ws.close();
  connect();
});

function applyRole(role: string, credential?: string): void {
  currentRole = role;
  if (credential === 'owner') isOwner = true;

  if (role === 'owner') {
    roleBadge.setAttribute('hidden', '');
    term.options.disableStdin = false;
    term.options.cursorStyle = 'block';
    term.options.cursorBlink = true;
    pinBtn.removeAttribute('hidden');
    hideViewonlyToast();
    return;
  }

  pinBtn.setAttribute('hidden', '');

  const canUpgrade = role === 'viewer' && (isOwner || !!wtoken);
  const switchable = role === 'writer' || canUpgrade;

  roleBadge.textContent = role === 'writer' ? 'Writer' : 'View Only';
  roleBadge.className = role + (switchable ? ' switchable' : '');
  roleBadge.removeAttribute('hidden');
  term.options.disableStdin = role !== 'writer';

  // Update shortcut bar for role
  const bar = document.getElementById('shortcut-bar');
  if (bar) {
    bar.classList.toggle('viewonly', role === 'viewer');
  }

  // Disable close button for non-owner viewers
  const closeBtn = document.querySelector('.dot.close') as HTMLElement;
  if (closeBtn) {
    closeBtn.classList.toggle('disabled', role === 'viewer' && !isOwner);
  }

  if (role === 'viewer') {
    term.options.cursorStyle = 'underline';
    term.options.cursorBlink = false;
    showViewonlyToast(canUpgrade);
  } else {
    term.options.cursorStyle = 'block';
    term.options.cursorBlink = true;
    hideViewonlyToast();
  }
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

let flashTimer: ReturnType<typeof setTimeout> | null = null;

term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    if (e.type === 'keydown' && ws.readyState === WebSocket.OPEN) ws.send('\x1b[13;2u');
    return false;
  }
  // Flash toast when viewer tries to type
  if (e.type === 'keydown' && currentRole === 'viewer' && !e.metaKey && !e.ctrlKey && e.key.length === 1) {
    viewonlyToast.classList.add('visible', 'flash');
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      viewonlyToast.classList.remove('flash');
      // Hide after a bit if it wasn't already showing
      flashTimer = setTimeout(() => { viewonlyToast.classList.remove('visible'); flashTimer = null; }, 2000);
    }, 300);
  }
  return true;
});

term.onData((data: string) => {
  if (appType === 'web') return;
  if (ws.readyState === WebSocket.OPEN) ws.send(data);
});

// Modifier toggles (Ctrl / Shift) + soft keyboard for touch shortcut bar
let ctrlActive = false;
let shiftActive = false;
const ctrlKeyboard = document.getElementById('ctrl-keyboard');

const ctrlKeyboardLabel = ctrlKeyboard?.querySelector('.ctrl-keyboard-label');

function updateKeyboard(): void {
  const show = ctrlActive || shiftActive;
  ctrlKeyboard?.classList.toggle('visible', show);
  if (ctrlKeyboardLabel) {
    ctrlKeyboardLabel.textContent = ctrlActive ? 'Ctrl +' : 'Shift +';
  }
}

function setCtrl(on: boolean): void {
  ctrlActive = on;
  document.querySelectorAll('.ctrl-toggle').forEach((b) => b.classList.toggle('active', on));
  if (on && shiftActive) { shiftActive = false; document.querySelectorAll('.shift-toggle').forEach((b) => b.classList.remove('active')); }
  updateKeyboard();
}

function setShift(on: boolean): void {
  shiftActive = on;
  document.querySelectorAll('.shift-toggle').forEach((b) => b.classList.toggle('active', on));
  if (on && ctrlActive) { ctrlActive = false; document.querySelectorAll('.ctrl-toggle').forEach((b) => b.classList.remove('active')); }
  updateKeyboard();
}

function clearModifiers(): void {
  if (ctrlActive) setCtrl(false);
  if (shiftActive) setShift(false);
}

// Map data-send values to their Shift equivalents (terminal escape sequences)
function shiftKey(data: string): string | null {
  switch (data) {
    case '\x1b[A': return '\x1b[1;2A'; // Shift+Up
    case '\x1b[B': return '\x1b[1;2B'; // Shift+Down
    case '\x09': return '\x1b[Z';      // Shift+Tab (backtab)
    case '\r': return '\x1b[13;2u';    // Shift+Enter
    default: return null;
  }
}

// Convert a character to its Ctrl equivalent (Ctrl+A = \x01, ..., Ctrl+Z = \x1a)
function ctrlChar(ch: string): string {
  const code = ch.toUpperCase().charCodeAt(0);
  if (code >= 65 && code <= 90) return String.fromCharCode(code - 64); // A-Z
  if (ch === '/') return String.fromCharCode(31);  // Ctrl+/
  if (ch === '[') return String.fromCharCode(27);  // Ctrl+[ = Esc
  if (ch === '\\') return String.fromCharCode(28); // Ctrl+backslash
  if (ch === ']') return String.fromCharCode(29);  // Ctrl+]
  return ch;
}

// Soft keyboard key taps (shared by Ctrl and Shift)
ctrlKeyboard?.addEventListener('pointerdown', (e: PointerEvent) => {
  const key = (e.target as HTMLElement).closest('.ctrl-key') as HTMLElement | null;
  if (!key) return;
  e.preventDefault();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const ch = key.dataset.ch;
  if (!ch || ws.readyState !== WebSocket.OPEN) return;
  if (ctrlActive) {
    ws.send(ctrlChar(ch));
  } else if (shiftActive) {
    ws.send(ch.toUpperCase());
  }
  clearModifiers();
});


// Mobile shortcut bar — use pointerdown to both prevent focus steal and handle action
document.getElementById('shortcut-bar')?.addEventListener('pointerdown', (e: PointerEvent) => {
  const isSendBtn = !!(e.target as HTMLElement).closest('.shortcut-send-btn');
  const isTextarea = !!(e.target as HTMLElement).closest('.shortcut-text-input');
  if (isSendBtn || isTextarea) return; // let Send button and textarea handle normally

  e.preventDefault();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

  const btn = (e.target as HTMLElement).closest('.shortcut-btn') as HTMLElement | null;
  if (!btn) return;

  // Handle modifier toggle buttons
  if (btn.classList.contains('ctrl-toggle')) {
    setCtrl(!ctrlActive);
    return;
  }
  if (btn.classList.contains('shift-toggle')) {
    setShift(!shiftActive);
    return;
  }

  const data = btn.dataset.send;
  if (!data) return;

  // When Shift is active, try to send shifted version
  if (shiftActive) {
    const shifted = shiftKey(data);
    if (shifted) {
      if (ws.readyState === WebSocket.OPEN) ws.send(shifted);
      clearModifiers();
      return;
    }
    // For printable chars (e.g. "y\r"), uppercase the char
    const bare = data.endsWith('\r') && data.length > 1 ? data.slice(0, -1) : data;
    if (bare.length === 1 && bare !== bare.toUpperCase()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(bare.toUpperCase() + (data.endsWith('\r') ? '\r' : ''));
      clearModifiers();
      return;
    }
  }

  // Always send to terminal
  if (ws.readyState === WebSocket.OPEN) ws.send(data);
  clearModifiers();
});

// Scroll-to-bottom shortcut buttons (one in landscape row, one in portrait rows)
let touchScroller: { stop: () => void } | null = null;
document.querySelectorAll('.scroll-bottom-btn').forEach((btn) => {
  btn.addEventListener('pointerdown', (e: Event) => {
    e.preventDefault();
    if (touchScroller) touchScroller.stop();
    term.scrollToBottom();
  });
});

// Text input for typing/dictation
const shortcutInput = document.getElementById('shortcut-input') as HTMLTextAreaElement | null;
const inputHistory: string[] = [];
let historyIndex = -1;
function autoResizeInput(): void {
  if (!shortcutInput) return;
  const maxH = window.innerHeight * 0.5;
  shortcutInput.style.overflow = shortcutInput.scrollHeight > maxH ? 'auto' : 'hidden';
}
function resetInputSize(): void {
  if (!shortcutInput) return;
  shortcutInput.style.overflow = 'hidden';
}
function sendShortcutInput(): void {
  if (!shortcutInput) return;
  if (ws.readyState === WebSocket.OPEN) {
    if (!shortcutInput.value) { ws.send('\r'); return; }
    const val = shortcutInput.value;
    ws.send(val + '\r');
    if (!inputHistory.length || inputHistory[inputHistory.length - 1] !== val) {
      inputHistory.push(val);
    }
    historyIndex = -1;
    shortcutInput.value = '';
    resetInputSize();
  }
}
shortcutInput?.addEventListener('input', () => {
  if (ctrlActive && shortcutInput.value) {
    const ch = shortcutInput.value.slice(-1);
    shortcutInput.value = shortcutInput.value.slice(0, -1);
    if (ws.readyState === WebSocket.OPEN) ws.send(ctrlChar(ch));
    clearModifiers();
    return;
  }
  if (shiftActive && shortcutInput.value) {
    const ch = shortcutInput.value.slice(-1);
    shortcutInput.value = shortcutInput.value.slice(0, -1) + ch.toUpperCase();
    clearModifiers();
  }
  autoResizeInput();
});
shortcutInput?.addEventListener('keydown', (e: KeyboardEvent) => {
  // Desktop: Enter submits, Shift+Enter newline. Touch: Enter is newline (use Send button to submit).
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouchDevice) {
    e.preventDefault();
    sendShortcutInput();
  }
  // Arrow keys: let browser handle cursor movement natively in textarea
});
document.getElementById('shortcut-send')?.addEventListener('click', sendShortcutInput);

// Toggle input bar visibility (desktop)
const inputToggle = document.getElementById('input-toggle');
const shortcutBar = document.getElementById('shortcut-bar');
if (inputToggle && shortcutBar) {
  const PREF_KEY = 'wsh-input-bar';
  const isTouchDevice = document.documentElement.classList.contains('touch');
  const saved = localStorage.getItem(PREF_KEY);
  const defaultVisible = isTouchDevice;
  const shouldShow = saved ? saved === 'visible' : defaultVisible;
  if (!shouldShow) {
    shortcutBar.classList.add('hidden');
  } else {
    inputToggle.classList.add('active');
  }
  inputToggle.addEventListener('click', () => {
    const isHidden = shortcutBar.classList.toggle('hidden');
    inputToggle.classList.toggle('active', !isHidden);
    localStorage.setItem(PREF_KEY, isHidden ? 'hidden' : 'visible');
    scheduleResize();
  });
}


// Touch scrolling with inertia for mobile (xterm.js v6 custom scrollbar doesn't support touch)
{
  const container = document.getElementById('terminal-container');
  if (container) {
    touchScroller = bindTouchScroll({
      el: container,
      lineHeight: Math.ceil((term.options.fontSize || 14) * (term.options.lineHeight || 1.2)),
      scrollLines: (n) => term.scrollLines(n),
      isAtTop: () => term.buffer.active.viewportY === 0,
      isAtBottom: () => term.buffer.active.viewportY >= term.buffer.active.baseY,
      bounceEl: container.querySelector('.xterm') as HTMLElement | null,
    });
  }
}

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
