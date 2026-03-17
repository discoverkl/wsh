// wsh RPC — dispatch { type: 'rpc', action, args } WebSocket messages as DOM events.
/**
 * Handle a WebSocket message event: if it's an RPC message, dispatch a
 * 'wsh-rpc' CustomEvent on the target element and return true.
 * If the message has an `id` and a `respond` callback is provided,
 * the handler's return value is sent back automatically.
 */
export function handleWshRpc(event, target, respond) {
    if (typeof event.data !== 'string')
        return false;
    try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'rpc' && msg.action) {
            target.dispatchEvent(new CustomEvent('wsh-rpc', {
                bubbles: true,
                detail: {
                    action: msg.action,
                    args: (msg.args ?? []),
                    id: msg.id,
                    respond,
                },
            }));
            return true;
        }
    }
    catch { }
    return false;
}
const handlers = new Map();
let listening = false;
function sendResult(id, respond, result) {
    const value = result?.value != null ? String(result.value) : undefined;
    const error = result?.error;
    respond(id, value, error);
}
function ensureListener() {
    if (listening)
        return;
    listening = true;
    document.addEventListener('wsh-rpc', ((e) => {
        const { action, args, id, respond } = e.detail;
        const fn = handlers.get(action);
        if (!fn) {
            console.debug('[wsh-rpc] unknown action:', action);
            if (id && respond)
                respond(id);
            return;
        }
        const result = fn(...args);
        if (id && respond) {
            if (result && typeof result.then === 'function') {
                result.then((r) => sendResult(id, respond, r), (err) => respond(id, undefined, String(err)));
            }
            else {
                sendResult(id, respond, result);
            }
        }
    }));
}
/**
 * Register a handler for a wsh RPC action. Automatically installs the
 * document-level event listener on first call.
 * Handlers may return a value (or Promise) — it is sent back to the caller
 * when the RPC was invoked with an id (sync mode).
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
function makeResponder(ws) {
    return (id, value, error) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'rpc-result', id, value, error }));
        }
    };
}
function doConnect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL('./terminal', location.href);
    url.protocol = proto;
    url.search = 'session=_rpc';
    controlWs = new WebSocket(url.href);
    controlWs.addEventListener('message', (event) => handleWshRpc(event, document, makeResponder(controlWs)));
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
export { makeResponder };
// Built-in RPC actions
onRpc('log', (...args) => { console.log('[wsh-rpc]', ...args); });
onRpc('eval', (code) => {
    try {
        return { value: eval(code) };
    }
    catch (e) {
        return { error: String(e) };
    }
});
