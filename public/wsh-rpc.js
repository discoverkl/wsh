// wsh RPC — dispatch { type: 'rpc', action, args } WebSocket messages as DOM events.
/**
 * Handle a WebSocket message event: if it's an RPC message, dispatch a
 * 'wsh-rpc' CustomEvent on the target element and return true.
 */
export function handleWshRpc(event, target) {
    if (typeof event.data !== 'string')
        return false;
    try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'rpc' && msg.action) {
            console.log('[wsh-rpc] received:', msg.action, msg.args ?? []);
            target.dispatchEvent(new CustomEvent('wsh-rpc', {
                bubbles: true,
                detail: { action: msg.action, args: (msg.args ?? []) },
            }));
            return true;
        }
    }
    catch { }
    return false;
}
const handlers = new Map();
let listening = false;
function ensureListener() {
    if (listening)
        return;
    listening = true;
    document.addEventListener('wsh-rpc', ((e) => {
        const fn = handlers.get(e.detail.action);
        if (fn)
            fn(...e.detail.args);
    }));
}
/**
 * Register a handler for a wsh RPC action. Automatically installs the
 * document-level event listener on first call.
 */
export function onRpc(action, handler) {
    handlers.set(action, handler);
    ensureListener();
}
/**
 * Open a control-only WebSocket that receives broadcast RPCs from the server.
 * Use this on pages that have no terminal WebSocket (e.g. catalog before any
 * inline session is opened). Messages are dispatched as 'wsh-rpc' events on
 * document, picked up by handlers registered via onRpc().
 */
let controlWs = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
function doConnect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL('./terminal', location.href);
    url.protocol = proto;
    url.search = 'session=_rpc';
    controlWs = new WebSocket(url.href);
    controlWs.addEventListener('message', (event) => handleWshRpc(event, document));
    controlWs.addEventListener('open', () => { reconnectDelay = 1000; });
    controlWs.addEventListener('close', () => {
        controlWs = null;
        setTimeout(doConnect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    });
}
export function connectRpc() {
    if (controlWs)
        return;
    doConnect();
}
// Built-in RPC actions
onRpc('log', (...args) => console.log('[wsh-rpc]', ...args));
