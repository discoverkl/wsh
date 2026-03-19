// window.api — public interface callable via `wsh rpc 'api.toast("hi")'`
// Other modules can extend: import './api.js'; window.api.myFunc = () => { ... }

const api: Record<string, any> = (window as any).api ?? {};
(window as any).api = api;

// --- api.toast ---

let toastStyleInjected = false;
const TOAST_CSS = `
.wsh-toast-container {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 99999;
  display: flex;
  flex-direction: column;
  gap: 12px;
  pointer-events: none;
  width: min(380px, calc(100vw - 32px));
}

.wsh-toast {
  pointer-events: auto;
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 14px;
  color: rgba(255,255,255,.92);
  font: 500 13px/1.55 -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
  letter-spacing: -0.01em;
  word-wrap: break-word;
  overflow-wrap: break-word;
  background: linear-gradient(165deg, rgba(50,50,68,.95) 0%, rgba(32,32,46,.97) 100%);
  backdrop-filter: blur(24px) saturate(1.6);
  -webkit-backdrop-filter: blur(24px) saturate(1.6);
  border: 1px solid rgba(255,255,255,.12);
  box-shadow:
    0 20px 50px -12px rgba(0,0,0,.45),
    0 8px 20px -4px rgba(0,0,0,.25),
    0 2px 6px rgba(0,0,0,.15),
    inset 0 1px 0 rgba(255,255,255,.1);
  animation: wsh-toast-in .4s cubic-bezier(.16,1,.3,1);
  transition: opacity .35s ease, transform .35s ease;
  overflow: hidden;
  cursor: default;
}

/* Accent edge */
.wsh-toast::before {
  content: '';
  position: absolute;
  left: 0; top: 8px; bottom: 8px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: linear-gradient(180deg, #818cf8, #6366f1);
  opacity: .8;
}

/* Icon */
.wsh-toast-icon {
  flex-shrink: 0;
  width: 28px; height: 28px;
  border-radius: 8px;
  background: rgba(99,102,241,.12);
  display: flex;
  align-items: center;
  justify-content: center;
}
.wsh-toast-icon svg {
  width: 15px; height: 15px;
  stroke: #818cf8;
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Body */
.wsh-toast-body {
  flex: 1;
  min-width: 0;
  padding-top: 4px;
}
.wsh-toast-body::-webkit-scrollbar {
  width: 5px;
}
.wsh-toast-body::-webkit-scrollbar-track {
  background: transparent;
}
.wsh-toast-body::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,.15);
  border-radius: 3px;
}
.wsh-toast-body::-webkit-scrollbar-thumb:hover {
  background: rgba(255,255,255,.25);
}
.wsh-toast-body {
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,.15) transparent;
}
.wsh-toast-body b,
.wsh-toast-body strong {
  font-weight: 650;
  color: #fff;
}
.wsh-toast-body a {
  color: #a5b4fc;
  text-decoration: none;
}
.wsh-toast-body a:hover {
  text-decoration: underline;
}

/* Close */
.wsh-toast-close {
  position: absolute;
  top: 10px; right: 10px;
  width: 20px; height: 20px;
  border: none;
  background: none;
  color: rgba(255,255,255,.2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: color .2s, background .2s;
  padding: 0;
  -webkit-tap-highlight-color: transparent;
}
.wsh-toast-close svg {
  width: 12px; height: 12px;
  stroke: currentColor;
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
}
.wsh-toast-close:hover {
  color: rgba(255,255,255,.6);
  background: rgba(255,255,255,.06);
}

/* Touch: swipe hint */
.wsh-toast.swiping {
  transition: none;
}
.wsh-toast.swipe-dismiss {
  transition: opacity .25s ease, transform .25s ease;
  pointer-events: none;
}

/* Progress */
.wsh-toast-progress {
  position: absolute;
  bottom: 0; left: 12px; right: 12px;
  height: 2px;
  border-radius: 1px;
  background: rgba(129,140,248,.35);
  transform-origin: left;
  animation: wsh-toast-progress linear forwards;
}

/* Raw variant */
.wsh-toast.wsh-toast-raw {
  padding: 14px 16px;
}
.wsh-toast.wsh-toast-raw::before { display: none; }

/* States */
.wsh-toast.removing {
  opacity: 0;
  transform: translateY(-8px) scale(.96);
  pointer-events: none;
}

/* Animations */
@keyframes wsh-toast-in {
  0%   { opacity: 0; transform: translateY(-12px) scale(.94); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes wsh-toast-progress {
  from { transform: scaleX(1); }
  to   { transform: scaleX(0); }
}

/* Touch devices */
@media (pointer: coarse) {
  .wsh-toast-close {
    width: 32px; height: 32px;
    top: 6px; right: 6px;
    border-radius: 8px;
  }
  .wsh-toast-close svg { width: 14px; height: 14px; }
  .wsh-toast-body a { padding: 2px 0; }
}

/* Narrow screens */
@media (max-width: 480px) {
  .wsh-toast-container {
    top: 8px; right: 8px; left: 8px;
    top: max(8px, env(safe-area-inset-top, 0px));
    right: max(8px, env(safe-area-inset-right, 0px));
    left: max(8px, env(safe-area-inset-left, 0px));
    width: auto;
  }
  .wsh-toast {
    padding: 12px 40px 12px 14px;
    border-radius: 12px;
    gap: 10px;
  }
  .wsh-toast::before { top: 6px; bottom: 6px; }
  .wsh-toast-icon { width: 24px; height: 24px; border-radius: 6px; }
  .wsh-toast-icon svg { width: 13px; height: 13px; }
  .wsh-toast-body { padding-top: 2px; }
  .wsh-toast-close { top: 6px; right: 6px; }
  .wsh-toast-progress { left: 8px; right: 8px; }
}`;

const CLOSE_ICON = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const INFO_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';

function ensureToastContainer(): HTMLElement {
  let container = document.getElementById('wsh-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'wsh-toast-container';
    container.className = 'wsh-toast-container';
    document.body.appendChild(container);
  }
  if (!toastStyleInjected) {
    const style = document.createElement('style');
    style.textContent = TOAST_CSS;
    document.head.appendChild(style);
    toastStyleInjected = true;
  }
  return container;
}

function dismissToast(el: HTMLElement): void {
  el.classList.add('removing');
  setTimeout(() => el.remove(), 350);
}

interface ToastOptions {
  text?: string;
  html?: string;
  raw?: boolean;
  duration?: number;
}

api.toast = (msgOrOpts: string | ToastOptions = '') => {
  const opts: ToastOptions = typeof msgOrOpts === 'string' ? { text: msgOrOpts } : msgOrOpts;
  const isHtml = !!opts.html;
  const content = opts.html ?? opts.text ?? '';
  const raw = !!opts.raw;
  const duration = opts.duration ?? 8000;

  const container = ensureToastContainer();
  const el = document.createElement('div');
  el.className = raw ? 'wsh-toast wsh-toast-raw' : 'wsh-toast';

  if (!raw) {
    const icon = document.createElement('div');
    icon.className = 'wsh-toast-icon';
    icon.innerHTML = INFO_ICON;
    el.appendChild(icon);
  }

  // Body
  const body = document.createElement('div');
  body.className = 'wsh-toast-body';
  if (isHtml) {
    body.innerHTML = content;
  } else {
    body.style.whiteSpace = 'pre-line';
    body.textContent = content;
  }
  el.appendChild(body);

  // Close
  const close = document.createElement('button');
  close.className = 'wsh-toast-close';
  close.innerHTML = CLOSE_ICON;
  close.addEventListener('click', (e) => { e.stopPropagation(); dismissToast(el); });
  el.appendChild(close);

  // Progress
  if (!raw && duration > 0) {
    const progress = document.createElement('div');
    progress.className = 'wsh-toast-progress';
    progress.style.animationDuration = duration + 'ms';
    el.appendChild(progress);
  }

  // Swipe to dismiss (touch)
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking = false;
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    dx = 0;
    tracking = true;
    el.classList.add('swiping');
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const t = e.touches[0];
    const dy = Math.abs(t.clientY - startY);
    dx = t.clientX - startX;
    // Cancel if vertical scroll
    if (dy > 20 && Math.abs(dx) < dy) { tracking = false; el.classList.remove('swiping'); el.style.transform = ''; el.style.opacity = ''; return; }
    // Only allow swiping right
    if (dx < 0) dx = 0;
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0, 1 - dx / 200));
  }, { passive: true });
  el.addEventListener('touchend', () => {
    if (!tracking) return;
    tracking = false;
    el.classList.remove('swiping');
    if (dx > 80) {
      el.classList.add('swipe-dismiss');
      el.style.transform = 'translateX(120%)';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    } else {
      el.style.transform = '';
      el.style.opacity = '';
    }
  }, { passive: true });

  container.appendChild(el);

  // Cap visible toasts
  const MAX_TOASTS = 5;
  while (container.children.length > MAX_TOASTS) {
    dismissToast(container.children[0] as HTMLElement);
  }

  if (duration > 0) {
    setTimeout(() => {
      if (el.parentNode) dismissToast(el);
    }, duration);
  }
};

export default api;
