import { exec } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { Duplex } from 'stream';
import { parseArgs } from 'util';
import express from 'express';
import selfsigned from 'selfsigned';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { version } from '../package.json';

// --- Subcommands (handled before server startup) ---

if (process.argv[2] === 'token') {
  const keyFile = path.join(os.homedir(), '.wsh', 'tls', 'key.pem');
  try {
    const key = fs.readFileSync(keyFile, 'utf8');
    process.stdout.write(crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) + '\n');
    process.exit(0);
  } catch {
    console.error('No TLS key found. Run wsh once to generate it.');
    process.exit(1);
  }
}

const MAX_SCROLLBACK = 5 * 1024 * 1024; // 5 MB
const SESSION_TTL = 10 * 60 * 1000;     // 10 minutes

type Role = 'owner' | 'writer' | 'viewer';

interface Session {
  pty: IPty;
  scrollback: Buffer;
  writer: WebSocket | null;
  peers: Map<WebSocket, Role>; // every connected WS → its original role
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  pinned: boolean;
  title: string;
}

const sessions = new Map<string, Session>();

// --- Client → server action messages ---

interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

interface CloseMessage {
  type: 'close';
}

interface PinMessage {
  type: 'pin';
  pinned: boolean;
}

type ClientMessage = ResizeMessage | CloseMessage | PinMessage;

function parseClientMessage(text: string): ClientMessage | null {
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const { type } = obj as Record<string, unknown>;
  if (type === 'resize') {
    const { cols, rows } = obj as Record<string, unknown>;
    if (typeof cols === 'number' && typeof rows === 'number') {
      return { type: 'resize', cols, rows };
    }
    return null;
  }
  if (type === 'close') return { type: 'close' };
  if (type === 'pin') {
    const { pinned } = obj as Record<string, unknown>;
    if (typeof pinned === 'boolean') return { type: 'pin', pinned };
    return null;
  }
  return null;
}

type Handlers = { [K in (ResizeMessage | CloseMessage)['type']]: (session: Session, msg: Extract<ClientMessage, { type: K }>) => void };

const handlers: Handlers = {
  resize(session, msg) {
    const cols = Math.max(1, Math.min(msg.cols, 65535));
    const rows = Math.max(1, Math.min(msg.rows, 65535));
    session.pty.resize(cols, rows);
  },
  close(session) {
    session.pty.kill('SIGHUP');
  },
};

function appendScrollback(session: Session, data: Buffer): void {
  session.scrollback = Buffer.concat([session.scrollback, data]);
  if (session.scrollback.length > MAX_SCROLLBACK) {
    session.scrollback = session.scrollback.slice(
      session.scrollback.length - MAX_SCROLLBACK
    );
  }
}

function spawnSession(id: string): Session {
  let ptyProcess: IPty;
  ptyProcess = pty.spawn('/bin/bash', [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME ?? process.cwd(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } as Record<string, string>,
  });

  const session: Session = {
    pty: ptyProcess,
    scrollback: Buffer.alloc(0),
    writer: null,
    peers: new Map(),
    cleanupTimer: null,
    pinned: false,
    title: 'bash',
  };

  sessions.set(id, session);

  const oscTitleRe = /\x1b\](?:0|2);([^\x07]*)\x07/;
  ptyProcess.onData((data: string) => {
    const m = data.match(oscTitleRe);
    if (m) session.title = m[1];
    const buf = Buffer.from(data, 'utf8');
    appendScrollback(session, buf);
    const send = (ws: WebSocket) => { if (ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true }); };
    for (const ws of session.peers.keys()) send(ws);
  });

  ptyProcess.onExit(() => {
    console.log(`[session ${id}] PTY exited`);
    const closeWs = (ws: WebSocket) => { if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'PTY process exited'); };
    for (const ws of session.peers.keys()) closeWs(ws);
    if (session.cleanupTimer !== null) clearTimeout(session.cleanupTimer);
    sessions.delete(id);
  });

  console.log(`[session ${id}] spawned`);
  return session;
}

function scheduleCleanup(id: string, session: Session): void {
  if (session.cleanupTimer !== null) {
    clearTimeout(session.cleanupTimer);
  }
  session.cleanupTimer = null;
  if (session.pinned) return;
  session.cleanupTimer = setTimeout(() => {
    console.log(`[session ${id}] TTL expired, killing PTY`);
    session.pty.kill('SIGHUP');
    sessions.delete(id);
  }, SESSION_TTL);
}

// --- Args ---

const { values } = parseArgs({
  options: {
    port:      { type: 'string',  short: 'p', default: '7681' },
    url:       { type: 'string',              default: '' },
    bind:      { type: 'string',              default: '' },
    'no-open': { type: 'boolean',             default: false },
    help:      { type: 'boolean', short: 'h', default: false },
    version:   { type: 'boolean', short: 'v', default: false },
  },
});

if (values.version) {
  console.log(`v${version}`);
  process.exit(0);
}

if (values.help) {
  console.log('Usage: wsh [options]');
  console.log('       wsh token');
  console.log('');
  console.log('Commands:');
  console.log('  token              Print the auth token and exit');
  console.log('');
  console.log('Options:');
  console.log('  -p, --port <port>  Port to listen on (default: 7681)');
  console.log('      --url <url>    Override advertised network URL (for NAT/proxy)');
  console.log('      --bind <addr>  Bind network server to this address (default: auto-detect LAN IP)');
  console.log('                     Use 0.0.0.0 to listen on all interfaces (e.g. inside Docker --network host)');
  console.log('      --no-open      Do not open browser on start');
  console.log('  -v, --version      Print version and exit');
  console.log('  -h, --help         Show this help message');
  process.exit(0);
}

const PORT = parseInt(values.port!, 10);
const CUSTOM_URL = values.url || null;
const BIND_ADDR  = values.bind || null;

if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Error: invalid port "${values.port}"`);
  process.exit(1);
}

// --- Network helpers ---

function isLoopback(ip: string | undefined): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function getLanIPs(): string[] {
  const ips: string[] = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (!addr.internal && addr.family === 'IPv4') ips.push(addr.address);
    }
  }
  return ips;
}

// --- LAN IP (needed before TLS) ---

const primaryLanIP = CUSTOM_URL ? (getLanIPs()[0] ?? null) : (getLanIPs()[0] ?? null);

// --- TLS (only when a network interface is available) ---

function loadOrGenerateCert(): { key: string; cert: string; writerSalt: Buffer } {
  const dir = path.join(os.homedir(), '.wsh', 'tls');
  fs.mkdirSync(dir, { recursive: true });

  const keyFile  = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  let key: string, cert: string;
  try {
    key  = fs.readFileSync(keyFile,  'utf8');
    cert = fs.readFileSync(certFile, 'utf8');
  } catch {
    const pems = selfsigned.generate([{ name: 'commonName', value: 'wsh' }], {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
    });
    fs.writeFileSync(keyFile,  pems.private, { mode: 0o600 });
    fs.writeFileSync(certFile, pems.cert,    { mode: 0o644 });
    key  = pems.private;
    cert = pems.cert;
  }

  const saltFile = path.join(dir, 'writer-salt.txt');
  let writerSalt: Buffer;
  try {
    writerSalt = Buffer.from(fs.readFileSync(saltFile, 'utf8').trim(), 'hex');
  } catch {
    writerSalt = crypto.randomBytes(32);
    fs.writeFileSync(saltFile, writerSalt.toString('hex'), { mode: 0o600 });
  }

  return { key, cert, writerSalt };
}

const tls = (primaryLanIP || BIND_ADDR) ? loadOrGenerateCert() : null;

// --- Token auth ---

const token = tls ? crypto.createHash('sha256').update(tls.key).digest('hex').slice(0, 16) : null;

function writerToken(sessionId: string): string {
  return crypto.createHash('sha256')
    .update(tls!.key).update(tls!.writerSalt).update(sessionId)
    .digest('hex').slice(0, 16);
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function makeTokenMiddleware(tok: string): express.RequestHandler {
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', `https://${req.headers.host}`);
    // If a ?session= param is on the root page, redirect to the hash form so
    // getSessionId() on the client picks up the correct ID.  This must happen
    // for every authenticated request, not only the first-time token exchange.
    const sessionParam = url.pathname === '/' ? (url.searchParams.get('session') ?? '') : '';
    const proceed = (): void => {
      if (sessionParam) { res.redirect(302, `/#${sessionParam}`); return; }
      next();
    };

    if (isLoopback(req.socket.remoteAddress)) return proceed();

    const cookies = parseCookies(req.headers.cookie ?? '');

    // Owner cookie
    if (cookies['wsh_token'] === tok) return proceed();

    // Owner token in URL
    if (url.searchParams.get('token') === tok) {
      res.setHeader('Set-Cookie', `wsh_token=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=315360000`);
      url.searchParams.delete('token');
      if (sessionParam) { res.redirect(302, `/#${sessionParam}`); return; }
      return res.redirect(302, url.pathname + url.search);
    }

    if (url.pathname.startsWith('/api/')) {
      res.status(401).send('Unauthorized');
    } else {
      next(); // static pages load without auth; WebSocket handles its own auth
    }
  };
}

// --- Share URL base (used by API and startup output) ---

const advertiseIP  = (BIND_ADDR && BIND_ADDR !== '0.0.0.0') ? BIND_ADDR : primaryLanIP;
const networkBase  = CUSTOM_URL ?? (advertiseIP ? `https://${advertiseIP}:${PORT}` : null);

// --- Express app + server ---

const app = express();
app.use((_req, res, next) => { res.setHeader('X-App-Version', version); next(); });
if (token) app.use(makeTokenMiddleware(token));

app.get('/api/share', (req: express.Request, res: express.Response) => {
  const sessionId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('session');
  if (!sessionId) { res.status(400).json({ error: 'session ID required' }); return; }
  if (!tls || !networkBase) { res.status(503).json({ error: 'Network sharing not available (no LAN interface)' }); return; }
  res.json({
    writer: `${networkBase}/#${sessionId}?wt=${writerToken(sessionId)}`,
    viewer: `${networkBase}/#${sessionId}`,
  });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const localServer   = http.createServer(app);
const networkServer = tls ? https.createServer({ key: tls.key, cert: tls.cert }, app) : null;

const wss = new WebSocketServer({ noServer: true });

function getRoleForSession(req: http.IncomingMessage, sessionId: string): Role | null {
  if (isLoopback(req.socket.remoteAddress) || !token) return 'owner';
  const cookies = parseCookies(req.headers.cookie ?? '');
  if (cookies['wsh_token'] === token) return 'owner';
  if (tls) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const wt = url.searchParams.get('wtoken');
    if (wt !== null) return wt === writerToken(sessionId) ? 'writer' : null; // reject bad token
  }
  return 'viewer'; // no writer token → viewer (session ID alone is the viewer secret)
}

function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname !== '/terminal') { socket.destroy(); return; }

  const sessionId = url.searchParams.get('session') ?? '';
  if (token && !isLoopback(req.socket.remoteAddress) && getRoleForSession(req, sessionId) === null) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
}

localServer.on('upgrade', handleUpgrade);
if (networkServer) networkServer.on('upgrade', handleUpgrade);

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const id  = url.searchParams.get('session');

  if (!id) { ws.close(4000, 'session ID required'); return; }

  const credential = getRoleForSession(req, id) ?? 'viewer';
  // ?yield=1 lets a writer/owner rejoin as viewer without displacing the current writer.
  const yields = (credential === 'owner' || credential === 'writer') && url.searchParams.get('yield') === '1';
  const isWriter = !yields && (credential === 'owner' || credential === 'writer');

  let session = sessions.get(id);

  if (session) {
    // Cancel cleanup timer when anyone reconnects.
    if (session.cleanupTimer !== null) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    if (isWriter) {
      if (session.writer && session.writer.readyState === WebSocket.OPEN) {
        session.writer.send(JSON.stringify({ type: 'role', role: 'viewer' }));
      }
      session.writer = ws;
      console.log(`[session ${id}] writer attached (credential: ${credential})`);
    } else {
      console.log(`[session ${id}] ${yields ? 'yielding owner' : 'viewer'} attached`);
    }
    // Store 'viewer' for yielding connections so auto-promotion on writer-disconnect skips them.
    const sentRole = yields ? 'viewer' : credential;
    session.peers.set(ws, sentRole);
    const pinnedOther = sentRole === 'owner'
      ? [...sessions.entries()].filter(([sid, s]) => sid !== id && s.pinned).map(([sid, s]) => ({ id: sid, title: s.title }))
      : undefined;
    ws.send(JSON.stringify({ type: 'role', role: sentRole, ...(sentRole === 'owner' ? { pinned: session.pinned, pinnedOther } : {}) }));
    if (session.scrollback.length > 0) ws.send(session.scrollback, { binary: true });
  } else {
    // New session — only writers/owners may create one.
    if (!isWriter) { ws.close(4003, 'viewers cannot create sessions'); return; }
    try {
      session = spawnSession(id);
    } catch (err) {
      console.error('Failed to spawn PTY:', err);
      ws.close(1011, 'Failed to spawn PTY');
      return;
    }
    session.writer = ws;
    session.peers.set(ws, credential);
    const pinnedOther = credential === 'owner'
      ? [...sessions.entries()].filter(([sid, s]) => sid !== id && s.pinned).map(([sid, s]) => ({ id: sid, title: s.title }))
      : undefined;
    ws.send(JSON.stringify({ type: 'role', role: credential, ...(credential === 'owner' ? { pinned: session.pinned, pinnedOther } : {}) }));
  }

  const currentSession = session;

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (currentSession.writer !== ws) return; // only the active writer may send input
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      currentSession.pty.write(buf.toString('binary'));
      return;
    }
    const text = (data as Buffer).toString();
    const msg  = parseClientMessage(text);
    if (msg) {
      // Only owner can close or pin; writers can resize.
      if ((msg.type === 'close' || msg.type === 'pin') && credential !== 'owner') return;
      if (msg.type === 'pin') {
        currentSession.pinned = msg.pinned;
        if (!msg.pinned && currentSession.writer === null) scheduleCleanup(id, currentSession);
        console.log(`[session ${id}] ${msg.pinned ? 'pinned (no timeout)' : 'unpinned'}`);
        for (const [peer, peerRole] of currentSession.peers) {
          if (peerRole === 'owner' && peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify({ type: 'pin', pinned: currentSession.pinned }));
          }
        }
        return;
      }
      (handlers[msg.type] as (session: Session, msg: ClientMessage) => void)(currentSession, msg);
    } else {
      currentSession.pty.write(text);
    }
  });

  ws.on('close', () => {
    currentSession.peers.delete(ws);
    if (currentSession.writer === ws) {
      currentSession.writer = null;
      const next = [...currentSession.peers].find(([, r]) => r !== 'viewer')?.[0];
      if (next) {
        currentSession.writer = next;
        next.send(JSON.stringify({ type: 'role', role: currentSession.peers.get(next) }));
        console.log(`[session ${id}] idle writer promoted to active writer`);
      } else {
        scheduleCleanup(id, currentSession);
        console.log(`[session ${id}] writer detached, ${currentSession.pinned ? 'session pinned (no timeout)' : `cleanup in ${SESSION_TTL / 1000}s`}`);
      }
    }
  });
});

// --- Browser launch ---

function isWSL(): boolean {
  try {
    const version = fs.readFileSync('/proc/version', 'utf8');
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  let cmd: string;
  if (process.platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (process.platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (isWSL()) {
    cmd = `cmd.exe /c start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err) console.error('Failed to open browser:', err.message);
  });
}

// --- Listen ---

// When --bind 0.0.0.0, run HTTPS-only on all interfaces: mixing HTTP and HTTPS on one
// port via protocol sniffing doesn't work because Node.js TLS reads from the native
// libuv handle directly, bypassing any JS-layer unshift(). HTTPS-only is fine for the
// Docker --network host use case where browsers access via the host's LAN IP over HTTPS.
const httpsOnly   = BIND_ADDR === '0.0.0.0' && !!networkServer;
const networkBind = httpsOnly ? '0.0.0.0' : (BIND_ADDR ?? primaryLanIP);

const localURL   = httpsOnly ? `https://localhost:${PORT}` : `http://localhost:${PORT}`;
const networkURL = networkBase && token ? `${networkBase}/?token=${token}` : null;

let serversStarted = 0;
const totalServers = httpsOnly ? 1 : (networkServer && networkBind ? 2 : 1);

function onListening(): void {
  if (++serversStarted < totalServers) return;

  console.log('');
  console.log(`  Local:       ${localURL}`);
  if (networkURL) console.log(`  Network:     ${networkURL}`);
  if (tls) console.log(`  Fingerprint: ${new crypto.X509Certificate(tls.cert).fingerprint256}`);
  console.log(`  Version:     v${version}`);
  console.log('');

  if (!values['no-open']) openBrowser(localURL);
}

if (httpsOnly) {
  networkServer!.listen(PORT, '0.0.0.0', onListening);
} else {
  localServer.listen(PORT, '127.0.0.1', onListening);
  if (networkServer && networkBind) networkServer.listen(PORT, networkBind, onListening);
}
