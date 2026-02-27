import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

function isResizeMessage(obj: unknown): obj is ResizeMessage {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as ResizeMessage).type === 'resize' &&
    typeof (obj as ResizeMessage).cols === 'number' &&
    typeof (obj as ResizeMessage).rows === 'number'
  );
}

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/terminal') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws: WebSocket) => {
  let ptyProcess: IPty;
  try {
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
  } catch (err) {
    console.error('Failed to spawn PTY:', err);
    ws.close(1011, 'Failed to spawn PTY');
    return;
  }

  ptyProcess.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(Buffer.from(data, 'utf8'), { binary: true });
    }
  });

  ptyProcess.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'PTY process exited');
    }
  });

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      ptyProcess.write(buf.toString('binary'));
      return;
    }

    const text = data.toString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      ptyProcess.write(text);
      return;
    }

    if (isResizeMessage(parsed)) {
      const cols = Math.max(1, Math.min(parsed.cols, 65535));
      const rows = Math.max(1, Math.min(parsed.rows, 65535));
      ptyProcess.resize(cols, rows);
    } else {
      ptyProcess.write(text);
    }
  });

  ws.on('close', () => {
    ptyProcess.kill('SIGHUP');
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
