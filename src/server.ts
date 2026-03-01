import { exec } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { parseArgs } from 'util';
import express from 'express';
import selfsigned from 'selfsigned';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

const MAX_SCROLLBACK = 5 * 1024 * 1024; // 5 MB
const SESSION_TTL = 10 * 60 * 1000;     // 10 minutes

interface Session {
  pty: IPty;
  scrollback: Buffer;
  ws: WebSocket | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
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

type ClientMessage = ResizeMessage | CloseMessage;

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
  return null;
}

type Handlers = { [K in ClientMessage['type']]: (session: Session, msg: Extract<ClientMessage, { type: K }>) => void };

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
    ws: null,
    cleanupTimer: null,
  };

  sessions.set(id, session);

  ptyProcess.onData((data: string) => {
    const buf = Buffer.from(data, 'utf8');
    appendScrollback(session, buf);
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(buf, { binary: true });
    }
  });

  ptyProcess.onExit(() => {
    console.log(`[session ${id}] PTY exited`);
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.close(1000, 'PTY process exited');
    }
    if (session.cleanupTimer !== null) {
      clearTimeout(session.cleanupTimer);
    }
    sessions.delete(id);
  });

  console.log(`[session ${id}] spawned`);
  return session;
}

function scheduleCleanup(id: string, session: Session): void {
  if (session.cleanupTimer !== null) {
    clearTimeout(session.cleanupTimer);
  }
  session.cleanupTimer = setTimeout(() => {
    console.log(`[session ${id}] TTL expired, killing PTY`);
    session.pty.kill('SIGHUP');
    sessions.delete(id);
  }, SESSION_TTL);
}

// --- Args ---

const { values } = parseArgs({
  options: {
    host:    { type: 'string',  short: 'H', default: '127.0.0.1' },
    port:    { type: 'string',  short: 'p', default: '3000' },
    'no-open': { type: 'boolean',           default: false },
    help:    { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log('Usage: server [options]');
  console.log('');
  console.log('Options:');
  console.log('  -H, --host <host>  Host to bind to (default: 127.0.0.1)');
  console.log('  -p, --port <port>  Port to listen on (default: 3000)');
  console.log('      --no-open      Do not open browser on start');
  console.log('  -h, --help         Show this help message');
  process.exit(0);
}

const HOST = values.host!;
const PORT = parseInt(values.port!, 10);

if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Error: invalid port "${values.port}"`);
  process.exit(1);
}

const isPublic = HOST !== '127.0.0.1' && HOST !== 'localhost';

if (isPublic) {
  console.warn('\x1b[33mNOTE: Binding to a public interface — HTTPS and a secret token are enabled.');
  console.warn('      Keep the URL private. Anyone with it has full shell access to this machine.\x1b[0m');
}

// --- TLS (public bindings only) ---

function loadOrGenerateCert(): { key: string; cert: string } {
  const dir = path.join(os.homedir(), '.wsh', 'tls');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  try {
    return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8') };
  } catch {
    const pems = selfsigned.generate([{ name: 'commonName', value: 'wsh' }], {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
    });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
    fs.writeFileSync(certFile, pems.cert, { mode: 0o644 });
    return { key: pems.private, cert: pems.cert };
  }
}

const tls = isPublic ? loadOrGenerateCert() : null;

// --- Token auth (public bindings only) ---

const token = isPublic ? crypto.randomBytes(16).toString('hex') : null;

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
    const cookies = parseCookies(req.headers.cookie ?? '');
    if (cookies['wsh_token'] === tok) return next();

    const urlToken = new URL(req.url ?? '/', `http://${req.headers.host}`).searchParams.get('token');
    if (urlToken === tok) {
      res.setHeader('Set-Cookie', `wsh_token=${tok}; HttpOnly; SameSite=Strict; Path=/`);
      const clean = new URL(req.url ?? '/', `http://${req.headers.host}`);
      clean.searchParams.delete('token');
      return res.redirect(302, clean.pathname + clean.search);
    }

    res.status(401).send('Unauthorized');
  };
}

// --- Express app + server ---

const app = express();
if (token) app.use(makeTokenMiddleware(token));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = tls
  ? https.createServer({ key: tls.key, cert: tls.cert }, app)
  : http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (token) {
    const cookies = parseCookies(req.headers.cookie ?? '');
    if (cookies['wsh_token'] !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname === '/terminal') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const id = url.searchParams.get('session');

  if (!id) {
    ws.close(4000, 'session ID required');
    return;
  }

  let session = sessions.get(id);

  if (session) {
    // Existing session — cancel cleanup, replay scrollback, attach.
    if (session.cleanupTimer !== null) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.close(4001, 'replaced by new connection');
    }
    session.ws = ws;
    console.log(`[session ${id}] reattached`);
    if (session.scrollback.length > 0) {
      ws.send(session.scrollback, { binary: true });
    }
  } else {
    // New session — spawn PTY.
    try {
      session = spawnSession(id);
    } catch (err) {
      console.error('Failed to spawn PTY:', err);
      ws.close(1011, 'Failed to spawn PTY');
      return;
    }
    session.ws = ws;
  }

  // Capture session reference for closure.
  const currentSession = session;

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      currentSession.pty.write(buf.toString('binary'));
      return;
    }

    const text = (data as Buffer).toString();
    const msg = parseClientMessage(text);
    if (msg) {
      (handlers[msg.type] as (session: Session, msg: ClientMessage) => void)(currentSession, msg);
    } else {
      currentSession.pty.write(text);
    }
  });

  ws.on('close', () => {
    if (currentSession.ws === ws) {
      currentSession.ws = null;
      scheduleCleanup(id, currentSession);
      console.log(`[session ${id}] detached, cleanup in ${SESSION_TTL / 1000}s`);
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

server.listen(PORT, HOST, () => {
  const proto = tls ? 'https' : 'http';
  const base = `${proto}://${HOST}:${PORT}`;
  const url = token ? `${base}/?token=${token}` : base;

  console.log(`Server running at ${url}`);
  if (tls) {
    const cert = new crypto.X509Certificate(tls.cert);
    console.log(`Fingerprint:       ${cert.fingerprint256}`);
  }

  if (!values['no-open'] && !isPublic) {
    openBrowser(url);
  }
});
