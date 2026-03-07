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

if (process.argv[2] === 'version') {
  console.log(`v${version}`);
  process.exit(0);
} else if (process.argv[2] === 'update') {
  const { execSync } = require('child_process') as typeof import('child_process');
  try {
    const body = execSync('curl -fsSL https://api.github.com/repos/discoverkl/wsh/releases/latest', { encoding: 'utf8' });
    const latest = (JSON.parse(body) as { tag_name: string }).tag_name.replace(/^v/, '');
    if (latest === version) {
      console.log(`Already up to date (v${version}).`);
      process.exit(0);
    }
    console.log(`Updating v${version} → v${latest} ...`);
    execSync('curl -fsSL https://github.com/discoverkl/wsh/releases/latest/download/install.sh | sh', { stdio: 'inherit' });
  } catch (err: any) {
    console.error('Update failed:', err.message);
    process.exit(1);
  }
  process.exit(0);
} else if (process.argv[2] === 'token') {
  const keyFile = path.join(os.homedir(), '.wsh', 'tls', 'key.pem');
  try {
    const key = fs.readFileSync(keyFile, 'utf8');
    process.stdout.write(crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) + '\n');
    process.exit(0);
  } catch {
    console.error('No TLS key found. Run wsh once to generate it.');
    process.exit(1);
  }
} else if (process.argv[2] === 'apps') {
  const appsPath = path.join(os.homedir(), '.wsh', 'apps.json');
  const apps: Record<string, { command: string; args?: string[]; title?: string }> = {
    bash: { command: '/bin/bash', title: 'bash' },
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(appsPath, 'utf8'));
    if (parsed.apps && typeof parsed.apps === 'object') {
      for (const [key, app] of Object.entries(parsed.apps)) {
        if (key in apps) continue;
        if (typeof (app as any).command === 'string') apps[key] = app as any;
      }
    }
  } catch {}
  console.log('Available apps:');
  for (const [key, app] of Object.entries(apps)) {
    const title = app.title ?? path.basename(app.command);
    const args = app.args?.length ? ' ' + app.args.join(' ') : '';
    console.log(`  ${key}  ${title}  (${app.command}${args})`);
  }
  process.exit(0);
} else if (process.argv[2] === 'new') {
  const { execSync } = require('child_process') as typeof import('child_process');
  const subArgs = process.argv.slice(3);

  let port = parseInt(process.env.WSH_PORT || '', 10) || 7681;
  const portIdx = subArgs.findIndex(a => a === '--port' || a === '-p');
  if (portIdx !== -1 && subArgs[portIdx + 1]) {
    port = parseInt(subArgs[portIdx + 1], 10);
    subArgs.splice(portIdx, 2);
  }

  const appKey = subArgs.find(a => !a.startsWith('-')) || 'bash';
  let basePath = process.env.WSH_BASE_PATH || '/';
  if (!basePath.startsWith('/')) basePath = '/' + basePath;
  if (!basePath.endsWith('/')) basePath += '/';
  const url = `http://127.0.0.1:${port}${basePath}api/sessions`;
  try {
    const body = execSync(
      `curl -sS -X POST -H 'Content-Type: application/json' -d '${JSON.stringify({ app: appKey })}' -w '\\n%{http_code}' '${url}'`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const lines = body.trimEnd().split('\n');
    const httpCode = parseInt(lines.pop()!, 10);
    const responseBody = lines.join('\n');
    if (httpCode >= 400) {
      const parsed = JSON.parse(responseBody);
      console.error(`Error: ${parsed.error}`);
      process.exit(1);
    }
    const parsed = JSON.parse(responseBody);
    console.log(parsed.url);
  } catch (err: any) {
    if (err.stderr?.includes('onnect') || err.stderr?.includes('refused')) {
      console.error(`No wsh server running on localhost:${port}`);
    } else {
      console.error('Error:', err.stderr?.trim() || err.message);
    }
    process.exit(1);
  }
  process.exit(0);
} else if (process.argv[2] === 'ls' || process.argv[2] === 'kill') {
  const { execSync } = require('child_process') as typeof import('child_process');
  const subcommand = process.argv[2];
  const subArgs = process.argv.slice(3);

  // Parse --port / -p, fallback to WSH_PORT env var, then default 7681
  let port = parseInt(process.env.WSH_PORT || '', 10) || 7681;
  const portIdx = subArgs.findIndex(a => a === '--port' || a === '-p');
  if (portIdx !== -1 && subArgs[portIdx + 1]) {
    port = parseInt(subArgs[portIdx + 1], 10);
    subArgs.splice(portIdx, 2);
  }

  let basePath = process.env.WSH_BASE_PATH || '/';
  if (!basePath.startsWith('/')) basePath = '/' + basePath;
  if (!basePath.endsWith('/')) basePath += '/';

  function curlRequest(method: string, urlPath: string): { status: number; body: string } {
    const url = `http://127.0.0.1:${port}${urlPath}`;
    try {
      const body = execSync(`curl -sS -X ${method} -w '\\n%{http_code}' '${url}'`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const lines = body.trimEnd().split('\n');
      const httpCode = parseInt(lines.pop()!, 10);
      return { status: httpCode, body: lines.join('\n') };
    } catch (err: any) {
      if (err.stderr?.includes('onnect') || err.stderr?.includes('refused')) {
        console.error(`No wsh server running on localhost:${port}`);
      } else {
        console.error('Error:', err.stderr?.trim() || err.message);
      }
      process.exit(1);
    }
    return { status: 0, body: '' }; // unreachable
  }

  function formatDuration(ms: number): string {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    const rm = min % 60;
    return rm ? `${hr}h ${rm}m` : `${hr}h`;
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function padRight(s: string, len: number): string { return s + ' '.repeat(Math.max(0, len - s.length)); }

  if (subcommand === 'ls') {
    const extended = subArgs.includes('-l');
    const json = subArgs.includes('--json');
    const { body } = curlRequest('GET', basePath + 'api/sessions');
    const data = JSON.parse(body) as { sessions: any[] };
    if (json) { console.log(JSON.stringify(data, null, 2)); process.exit(0); }
    if (data.sessions.length === 0) { console.log('No active sessions.'); process.exit(0); }

    const now = Date.now();
    if (extended) {
      const headers = ['ID', 'APP', 'TITLE', 'PINNED', 'PEERS', 'WRITER', 'UPTIME', 'IN', 'OUT', 'PID', 'SIZE', 'PROCESS'];
      const rows = data.sessions.map((s: any) => [
        s.id, s.app ?? '', s.title, s.pinned ? 'yes' : 'no', String(s.peers), s.hasWriter ? 'yes' : 'no',
        formatDuration(now - s.createdAt), formatDuration(now - s.lastInput), formatDuration(now - s.lastOutput),
        String(s.pid), formatSize(s.scrollbackSize), s.process ?? '',
      ]);
      const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
      console.log(headers.map((h, i) => padRight(h, widths[i])).join('  '));
      for (const row of rows) console.log(row.map((c, i) => padRight(c, widths[i])).join('  '));
    } else {
      const headers = ['ID', 'APP', 'TITLE', 'PINNED', 'PEERS', 'WRITER', 'UPTIME', 'IDLE'];
      const rows = data.sessions.map((s: any) => [
        s.id, s.app ?? '', s.title, s.pinned ? 'yes' : 'no', String(s.peers), s.hasWriter ? 'yes' : 'no',
        formatDuration(now - s.createdAt), formatDuration(now - Math.max(s.lastInput, s.lastOutput)),
      ]);
      const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
      console.log(headers.map((h, i) => padRight(h, widths[i])).join('  '));
      for (const row of rows) console.log(row.map((c, i) => padRight(c, widths[i])).join('  '));
    }
  } else {
    // kill
    const sessionId = subArgs.find(a => !a.startsWith('-'));
    if (!sessionId) { console.error('Usage: wsh kill <session-id>'); process.exit(1); }
    const { status } = curlRequest('DELETE', basePath + `api/sessions/${sessionId}`);
    if (status === 404) { console.error(`Session "${sessionId}" not found.`); process.exit(1); }
    if (status !== 200) { console.error(`Error: server returned ${status}`); process.exit(1); }
    console.log(`Session "${sessionId}" killed.`);
  }
  process.exit(0);
}

const MAX_SCROLLBACK = 5 * 1024 * 1024; // 5 MB
const SESSION_TTL = 10 * 60 * 1000;     // 10 minutes
const PING_INTERVAL = 30_000;           // 30 seconds
const PONG_TIMEOUT  = 10_000;           // 10 seconds
const RATE_WINDOW   = 60_000;           // 1 minute
const RATE_MAX_MISS = 10;               // max invalid session attempts per IP per window

type Role = 'owner' | 'writer' | 'viewer';

interface Session {
  pty: IPty;
  scrollback: Buffer;
  writer: WebSocket | null;
  peers: Map<WebSocket, Role>; // every connected WS → its original role
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  pinned: boolean;
  title: string;
  app: string;
  createdAt: number;
  lastInput: number;
  lastOutput: number;
}

const sessions = new Map<string, Session>();
const missAttempts = new Map<string, number[]>(); // IP -> timestamps of invalid session hits

// --- Client → server action messages ---

interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

interface CloseMessage {
  type: 'close';
}

interface ClearMessage {
  type: 'clear';
}

interface PinMessage {
  type: 'pin';
  pinned: boolean;
}

type ClientMessage = ResizeMessage | CloseMessage | ClearMessage | PinMessage;

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
  if (type === 'clear') return { type: 'clear' };
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

function spawnSession(id: string, appKey: string, appConfig: AppConfig): Session {
  const ptyProcess = pty.spawn(appConfig.command, appConfig.args ?? [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: appConfig.cwd ?? process.env.HOME ?? process.cwd(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...(appConfig.env ?? {}),
    } as Record<string, string>,
  });

  const now = Date.now();
  const session: Session = {
    pty: ptyProcess,
    scrollback: Buffer.alloc(0),
    writer: null,
    peers: new Map(),
    cleanupTimer: null,
    pinned: false,
    title: appConfig.title ?? path.basename(appConfig.command),
    app: appKey,
    createdAt: now,
    lastInput: now,
    lastOutput: now,
  };

  sessions.set(id, session);

  const oscTitleRe = /\x1b\](?:0|2);([^\x07]*)\x07/;
  ptyProcess.onData((data: string) => {
    const m = data.match(oscTitleRe);
    if (m) session.title = m[1];
    session.lastOutput = Date.now();
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
  allowPositionals: true,
  options: {
    port:      { type: 'string',  short: 'p', default: '7681' },
    url:       { type: 'string',              default: '' },
    bind:      { type: 'string',              default: '' },
    'no-open':  { type: 'boolean',             default: false },
    'no-login': { type: 'boolean',             default: false },
    help:       { type: 'boolean', short: 'h', default: false },
    version:    { type: 'boolean', short: 'v', default: false },
    base:       { type: 'string', default: '/' },
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
  console.log('  ls                 List active sessions');
  console.log('  kill <session-id>  Close a session');
  console.log('  new [app-key]      Create a new session (default: bash)');
  console.log('  apps               List available apps');
  console.log('  update             Update to the latest version');
  console.log('  version            Print version and exit');
  console.log('  token              Print the auth token and exit');
  console.log('');
  console.log('Options:');
  console.log('  -p, --port <port>  Port to listen on (default: 7681)');
  console.log('      --url <url>    Override advertised network URL (for NAT/proxy)');
  console.log('      --bind <addr>  Bind network server to this address (default: auto-detect LAN IP)');
  console.log('                     Use 0.0.0.0 to listen on all interfaces (e.g. inside Docker --network host)');
  console.log('      --base <path>  Base path prefix (default: /)');
  console.log('      --no-open      Do not open browser on start');
  console.log('      --no-login     Spawn non-login shells (default: login shell)');
  console.log('  -v, --version      Print version and exit');
  console.log('  -h, --help         Show this help message');
  console.log('');
  console.log('Environment:');
  console.log('  WSH_PORT           Default port for ls/kill commands (default: 7681)');
  console.log('  WSH_BASE_PATH    Base path for ls/kill/new commands (default: /)');
  process.exit(0);
}

function normalizeBase(raw: string): string {
  let b = raw;
  if (!b.startsWith('/')) b = '/' + b;
  if (!b.endsWith('/')) b += '/';
  return b;
}

const BASE = normalizeBase(values.base!);

const PORT = parseInt(values.port!, 10);
const CUSTOM_URL = values.url || null;
const BIND_ADDR  = values.bind || null;

if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Error: invalid port "${values.port}"`);
  process.exit(1);
}

// --- App config ---

interface AppConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  title?: string;
}

const BUILTIN_APPS: Record<string, AppConfig> = {
  bash: {
    command: '/bin/bash',
    args: values['no-login'] ? [] : ['-l'],
    title: 'bash',
  },
};

function loadApps(): Record<string, AppConfig> {
  const apps = { ...BUILTIN_APPS };
  const appsPath = path.join(os.homedir(), '.wsh', 'apps.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(appsPath, 'utf8'));
    if (parsed.apps && typeof parsed.apps === 'object') {
      for (const [key, app] of Object.entries(parsed.apps)) {
        if (key in BUILTIN_APPS) continue;
        if (typeof (app as any).command === 'string') apps[key] = app as AppConfig;
      }
    }
  } catch {}
  return apps;
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

const primaryLanIP = getLanIPs()[0] ?? null;

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
    const sessionParam = url.pathname === BASE ? (url.searchParams.get('session') ?? '') : '';
    const proceed = (): void => {
      if (sessionParam) { res.redirect(302, `bash#${sessionParam}`); return; }
      next();
    };

    if (isLoopback(req.socket.remoteAddress)) return proceed();

    const cookies = parseCookies(req.headers.cookie ?? '');

    // Owner cookie
    if (cookies['wsh_token'] === tok) return proceed();

    // Owner token in URL
    if (url.searchParams.get('token') === tok) {
      res.setHeader('Set-Cookie', `wsh_token=${tok}; HttpOnly; SameSite=Strict; Path=${BASE}; Max-Age=315360000`);
      url.searchParams.delete('token');
      if (sessionParam) { res.redirect(302, `bash#${sessionParam}`); return; }
      return res.redirect(302, url.pathname + url.search);
    }

    if (url.pathname.startsWith(BASE + 'api/')) {
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

const router = express.Router();

// Redirect bare / to /bash so the app name is always in the URL.
// When BASE != '/', also redirect /base -> /base/ to fix relative URL resolution.
router.get('/', (req: express.Request, res: express.Response) => {
  if (BASE !== '/' && !req.originalUrl.endsWith('/')) {
    res.redirect(301, BASE);
    return;
  }
  res.redirect(302, 'bash');
});

router.get('/api/share', (req: express.Request, res: express.Response) => {
  const sessionId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('session');
  if (!sessionId) { res.status(400).json({ error: 'session ID required' }); return; }
  if (!tls) { res.status(503).json({ error: 'Network sharing not available' }); return; }
  res.json({ wtoken: writerToken(sessionId) });
});

router.get('/api/sessions', (_req: express.Request, res: express.Response) => {
  const list = [...sessions.entries()].map(([id, s]) => ({
    id,
    title: s.title,
    app: s.app,
    pinned: s.pinned,
    peers: s.peers.size,
    hasWriter: s.writer !== null,
    createdAt: s.createdAt,
    lastInput: s.lastInput,
    lastOutput: s.lastOutput,
    pid: s.pty.pid,
    scrollbackSize: s.scrollback.length,
    process: s.pty.process,
  }));
  res.json({ sessions: list });
});

router.delete('/api/sessions/:id', (req: express.Request, res: express.Response) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'session not found' }); return; }
  session.pty.kill('SIGHUP');
  res.json({ ok: true });
});

router.use(express.json());

router.post('/api/sessions', (req: express.Request, res: express.Response) => {
  const appKey = (req.body?.app as string) || 'bash';
  const apps = loadApps();
  const appConfig = apps[appKey];
  if (!appConfig) { res.status(400).json({ error: `Unknown app: "${appKey}"` }); return; }

  const id = crypto.randomInt(0, 2176782336).toString(36).padStart(6, '0');

  try {
    const session = spawnSession(id, appKey, appConfig);
    session.pinned = true;
  } catch (err) {
    console.error('Failed to spawn PTY:', err);
    res.status(500).json({ error: 'Failed to spawn session' }); return;
  }

  const base = networkBase ?? `http://localhost:${PORT}`;
  res.json({ id, url: `${base}${BASE}${appKey}#${id}` });
});

router.get('/:appName', (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const apps = loadApps();
  if (!apps[req.params.appName]) { next(); return; }
  // Serve index.html — the client reads the app name from the pathname
  // and passes it in the WebSocket query so the correct app is spawned.
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

router.use(express.static(path.join(__dirname, '..', 'public')));

app.use(BASE, router);

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

function sendRoleMessage(ws: WebSocket, sessionId: string, session: Session, role: Role, credential: Role): void {
  const pinnedOther = role === 'owner'
    ? [...sessions.entries()].filter(([sid, s]) => sid !== sessionId && s.pinned).map(([sid, s]) => ({ id: sid, title: s.title, app: s.app ?? 'bash' }))
    : undefined;
  ws.send(JSON.stringify({ type: 'role', role, credential, app: session.app, ...(role === 'owner' ? { pinned: session.pinned, pinnedOther } : {}) }));
}

function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname !== BASE + 'terminal') { socket.destroy(); return; }

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
    sendRoleMessage(ws, id, session, sentRole, credential);
    if (session.scrollback.length > 0) ws.send(session.scrollback, { binary: true });
  } else {
    // New session — only owners may create one.
    if (credential !== 'owner') {
      // Rate-limit invalid session attempts per IP to prevent brute-force scanning.
      const ip = req.socket.remoteAddress ?? '';
      if (!isLoopback(ip)) {
        const now = Date.now();
        const attempts = missAttempts.get(ip)?.filter(t => t > now - RATE_WINDOW) ?? [];
        attempts.push(now);
        missAttempts.set(ip, attempts);
        if (attempts.length > RATE_MAX_MISS) {
          ws.close(4029, 'too many attempts');
          return;
        }
      }
      ws.close(4003, 'only owners can create sessions');
      return;
    }
    const apps = loadApps();
    const requestedApp = url.searchParams.get('app') || 'bash';
    const appKey = apps[requestedApp] ? requestedApp : 'bash';
    const appConfig = apps[appKey];
    try {
      session = spawnSession(id, appKey, appConfig);
    } catch (err) {
      console.error('Failed to spawn PTY:', err);
      ws.close(1011, 'Failed to spawn PTY');
      return;
    }
    session.writer = ws;
    session.peers.set(ws, credential);
    sendRoleMessage(ws, id, session, credential, credential);
  }

  const currentSession = session;

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (currentSession.writer !== ws) return; // only the active writer may send input
    if (isBinary) {
      currentSession.lastInput = Date.now();
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      currentSession.pty.write(buf.toString('binary'));
      return;
    }
    const text = (data as Buffer).toString();
    const msg  = parseClientMessage(text);
    if (msg) {
      // Only owner can close or pin; writers can resize and clear.
      if ((msg.type === 'close' || msg.type === 'pin') && credential !== 'owner') return;
      if (msg.type === 'clear') {
        currentSession.scrollback = Buffer.alloc(0);
        // Ask the shell to redraw its prompt so new scrollback isn't empty.
        currentSession.pty.write('\f');
        console.log(`[session ${id}] scrollback cleared`);
        return;
      }
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
    clearInterval(pingTimer);
    currentSession.peers.delete(ws);
    if (currentSession.writer === ws) {
      currentSession.writer = null;
      const next = [...currentSession.peers].find(([, r]) => r === 'owner')?.[0]
                ?? [...currentSession.peers].find(([, r]) => r === 'writer')?.[0];
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

  // Heartbeat: detect dead connections within PING_INTERVAL + PONG_TIMEOUT.
  let pongReceived = true;
  ws.on('pong', () => { pongReceived = true; });
  const pingTimer = setInterval(() => {
    if (!pongReceived) { ws.terminate(); return; }
    pongReceived = false;
    ws.ping();
  }, PING_INTERVAL);
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

const localURL   = httpsOnly ? `https://localhost:${PORT}${BASE}bash` : `http://localhost:${PORT}${BASE}bash`;
const networkURL = networkBase && token ? `${networkBase}${BASE}?token=${token}` : null;

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
