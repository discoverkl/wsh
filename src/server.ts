import express from 'express';
import http from 'http';
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

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
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

const arg = process.argv[2];

if (arg === '--help' || arg === '-h' || arg === 'help') {
  console.log('Usage: server [port]');
  console.log('');
  console.log('Arguments:');
  console.log('  port  Port to listen on (default: 3000)');
  console.log('');
  console.log('Options:');
  console.log('  -h, --help  Show this help message');
  process.exit(0);
}

const PORT = parseInt(arg ?? '3000', 10);

if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Error: invalid port "${arg}"`);
  console.error('Usage: server [port]');
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`Server running at http://127.0.0.1:${PORT}`);
});
