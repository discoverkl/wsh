import { exec, execSync, spawn, ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import { Duplex } from 'stream';
import { parseArgs } from 'util';
import express from 'express';
import selfsigned from 'selfsigned';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import YAML from 'yaml';
import { version } from '../package.json';

// --- Error handling ---

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

process.on('uncaughtException', (err) => {
  console.error(`Error: ${errorMessage(err)}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`Error: ${errorMessage(reason)}`);
  process.exit(1);
});

// --- Common utilities ---

/** Session IDs are 6 lowercase alphanumeric characters. */
function isSessionId(s: string): boolean { return /^[a-z0-9]{6}$/.test(s); }

// --- Subcommands (handled before server startup) ---

const wantsHelp = process.argv.slice(3).includes('-h') || process.argv.slice(3).includes('--help');

function subHelp(usage: string, lines: string[] = []): never {
  console.log(usage);
  for (const l of lines) console.log(l);
  process.exit(0);
}

if (process.argv[2] === 'version') {
  if (wantsHelp) subHelp('Usage: wsh version', ['', 'Print the current version and exit.']);
  console.log(`v${version}`);
  process.exit(0);
} else if (process.argv[2] === 'update') {
  if (wantsHelp) subHelp('Usage: wsh update', ['', 'Update wsh to the latest version.']);
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
  if (wantsHelp) subHelp('Usage: wsh token', ['', 'Print the auth token derived from the TLS key.']);
  const keyFile = path.join(os.homedir(), '.wsh', 'tls', 'key.pem');
  try {
    const key = fs.readFileSync(keyFile, 'utf8');
    process.stdout.write(crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) + '\n');
    process.exit(0);
  } catch {
    console.error('No TLS key found. Run wsh once to generate it.');
    process.exit(1);
  }
} else if (process.argv[2] === 'rpc') {
  if (wantsHelp) subHelp('Usage: wsh rpc [options] <code> [args...]', [
    '', 'Evaluate JavaScript on connected clients via the wsh RPC mechanism.',
    '', 'Pages expose capabilities on window.api (e.g. api.toast, api.refreshCatalog).',
    '', 'Options:',
    '  --async          Fire-and-forget (do not wait for response)',
    '  --timeout <ms>   Response timeout in milliseconds',
    '  --session <id>   Target a specific session (default: $WSH_SESSION, "index" for catalog)',
    '  --broadcast      Send to all sessions (ignore $WSH_SESSION)',
    '  -                Read argument from stdin',
    '', 'Environment:',
    '  WSH_RPC_PORT     Port of the wsh server (required)',
    '  WSH_SESSION      Session ID for the RPC call (overridden by --session)',
    '', 'Examples:',
    '  wsh rpc \'api.toast("hello")\'',
    '  wsh rpc --broadcast \'api.refreshCatalog()\'',
    '  echo \'api.toast({html:"<b>hi</b>"})\' | wsh rpc --broadcast -',
  ]);
  const rpcArgs: string[] = [];
  let isAsync = false;
  let rpcTimeout: number | undefined;
  let rpcSession: string | undefined;
  let rpcBroadcast = false;
  for (let i = 3; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--async') isAsync = true;
    else if (a === '--timeout' && process.argv[i + 1]) rpcTimeout = parseInt(process.argv[++i], 10);
    else if (a === '--session' && process.argv[i + 1]) rpcSession = process.argv[++i];
    else if (a === '--broadcast') rpcBroadcast = true;
    else rpcArgs.push(a);
  }
  // Replace `-` args with stdin content
  if (rpcArgs.includes('-')) {
    const stdin = fs.readFileSync(0, 'utf8').trimEnd();
    for (let i = 0; i < rpcArgs.length; i++) {
      if (rpcArgs[i] === '-') rpcArgs[i] = stdin;
    }
  }
  if (rpcArgs.length === 0) {
    console.error('Usage: wsh rpc [options] <code>');
    process.exit(1);
  }
  if (rpcArgs.length > 1) {
    console.error('wsh rpc: expected a single code argument (use quotes or stdin)');
    process.exit(1);
  }
  const action = 'eval';
  const args = rpcArgs;
  const rpcPort = process.env.WSH_RPC_PORT;
  if (!rpcPort) {
    console.error('wsh rpc: WSH_RPC_PORT environment variable is required');
    process.exit(1);
  }
  // HTTP mode: POST to the wsh server directly (bypasses stdout capture by agent tools)
  const session = rpcBroadcast ? undefined : (rpcSession ?? process.env.WSH_SESSION);
  if (!session && !rpcBroadcast) {
    console.error('wsh rpc: no target session — use --session <id>, --broadcast, or set $WSH_SESSION');
    process.exit(1);
  }
  const body = JSON.stringify({ action, args, session, ...(isAsync ? { async: true } : {}), ...(rpcTimeout ? { timeout: rpcTimeout } : {}) });
  const basePath = process.env.WSH_RPC_BASE || '/';
  try {
    const proxySecret = process.env.WSH_PROXY_SECRET;
    const aboxUser = process.env.ABOX_USER;
    let headers = "-H 'Content-Type: application/json'";
    if (proxySecret) headers += ` -H 'X-WSH-Proxy-Secret: ${proxySecret}'`;
    if (aboxUser) headers += ` -H 'X-WSH-User: ${aboxUser}'`;
    const escapedBody = body.replace(/'/g, "'\\''");
    let response: string;
    // Try HTTP first, fall back to HTTPS (for httpsOnly mode)
    try {
      response = execSync(`curl -sS -X POST ${headers} -d '${escapedBody}' 'http://127.0.0.1:${rpcPort}${basePath}api/rpc'`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      response = execSync(`curl -sSk -X POST ${headers} -d '${escapedBody}' 'https://127.0.0.1:${rpcPort}${basePath}api/rpc'`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    }
    const result = JSON.parse(response);
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    if (result.value != null) console.log(result.value);
    process.exit(0);
  } catch (err: any) {
    console.error('wsh rpc: failed —', err.stderr?.toString().trim() || err.message);
    process.exit(1);
  }
} else if (process.argv[2] === 'apps') {
  if (wantsHelp) subHelp('Usage: wsh apps [init]', [
    '', 'List available apps, or initialize a starter config.',
    '', 'Subcommands:',
    '  init  Create ~/.wsh/apps.yaml with example app definitions',
  ]);
  const YAML = require('yaml') as typeof import('yaml');
  const subCmd = process.argv[3];
  const appsPath = path.join(os.homedir(), '.wsh', 'apps.yaml');

  if (subCmd === 'init') {
    if (fs.existsSync(appsPath)) {
      console.error(`Already exists: ${appsPath}`);
      process.exit(1);
    }
    // Also check for legacy apps.json
    const jsonPath = path.join(os.homedir(), '.wsh', 'apps.json');
    if (fs.existsSync(jsonPath)) {
      console.error(`Found existing ${jsonPath} — rename or remove it first.`);
      process.exit(1);
    }
    const template = `# wsh apps — each key becomes a launchable app.
# Changes take effect on the next session (no restart needed).
#
# Layers (merged field-by-field for existing apps):
#   1. bash (built-in)  2. /etc/wsh/apps.yaml  3. this file

# ── TUI app ──────────────────────────────────────────────

python3:
  command: python3

# ── Web app (type: web) ──────────────────────────────────
# wsh assigns $WSH_PORT, $WSH_SESSION, $WSH_BASE_URL and
# reverse-proxies traffic to your app.

# jupyter:
#   type: web
#   command: jupyter
#   args: [lab, --port=$WSH_PORT, --ServerApp.base_url=$WSH_BASE_URL, --no-browser]
#   title: Jupyter Lab
#   icon: python
#   healthCheck: /api
#   startupTimeout: 60s

# ── Visibility ───────────────────────────────────────────
# hidden: true keeps an app launchable by URL/CLI but hides
# it from the catalog page. Useful as a partial override:
#
# claude:
#   hidden: false   # unhide a system app without redefining it
`;
    fs.mkdirSync(path.dirname(appsPath), { recursive: true });
    fs.writeFileSync(appsPath, template);
    console.log(`Created ${appsPath}`);
    process.exit(0);
  }

  const apps: Record<string, any> = {
    bash: { command: '/bin/bash', title: 'bash' },
  };
  const systemDir = '/etc/wsh';
  const userDir = path.join(os.homedir(), '.wsh');
  const configs: any[] = [];
  const cliWarnings: string[] = [];
  function loadAndMerge(dir: string) {
    let parsed: any = null;
    try { parsed = YAML.parse(fs.readFileSync(path.join(dir, 'apps.yaml'), 'utf8')); } catch {
      try { parsed = JSON.parse(fs.readFileSync(path.join(dir, 'apps.json'), 'utf8')); } catch {}
    }
    if (parsed && typeof parsed === 'object') {
      configs.push(parsed);
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (key.startsWith('_')) continue;
        if (key === 'skill') { cliWarnings.push(`"${key}" is a reserved name and cannot be used as an app name`); continue; }
        if (value && typeof value === 'object' && (typeof (value as any).command === 'string' || typeof (value as any).skill === 'string'))
          apps[key] = apps[key] ? { ...apps[key], ...value as any } : value as any;
      }
    }
  }
  loadAndMerge(systemDir);
  loadAndMerge(userDir);
  // Apply _skills defaults to skill apps (same logic as server)
  let skillDefaults: any = { command: 'claude "/$SKILL $INPUT"' };
  let cliAgent: string | undefined;
  let cliTools: any = undefined;
  for (const config of configs) {
    const raw = config?._skills;
    if (raw && typeof raw === 'object') {
      const { tools: t, agent: a, ...rest } = raw as any;
      skillDefaults = { ...skillDefaults, ...rest };
      if (typeof a === 'string') cliAgent = a;
      if (t && typeof t === 'object') cliTools = { ...(cliTools ?? {}), ...t };
    }
  }
  if (cliAgent && cliTools && cliTools[cliAgent]) {
    const tool = cliTools[cliAgent];
    if (typeof tool.command === 'string') skillDefaults.command = tool.command;
    if (typeof tool.inline === 'string') skillDefaults.inlineCommand = tool.inline;
  }
  for (const app of Object.values(apps)) {
    if (app.skill) {
      for (const [k, v] of Object.entries(skillDefaults)) {
        if (app[k] === undefined) app[k] = v;
      }
    }
  }
  // Build table rows
  const rows = (Object.entries(apps) as [string, any][]).map(([key, app]) => {
    const title = app.title ?? path.basename(app.command);
    const command = app.command + (app.args?.length ? ' ' + app.args.join(' ') : '');
    const tags: string[] = [];
    if (app.type === 'web') tags.push('web');
    if (app.access === 'public') tags.push('public');
    if (app.skill) tags.push('skill');
    if (app.hidden) tags.push('hidden');
    return { key, title, command, tags: tags.join(', ') };
  });
  const col = (field: 'key' | 'title' | 'command' | 'tags', header: string) => {
    const w = Math.max(header.length, ...rows.map(r => r[field].length));
    return { header, field, w } as const;
  };
  const cols = [col('key', 'APP'), col('title', 'TITLE'), col('command', 'COMMAND'), col('tags', 'TAGS')];
  const headerLine = cols.map(c => c.header.padEnd(c.w)).join('  ');
  const separator = cols.map(c => '─'.repeat(c.w)).join('──');
  console.log(headerLine);
  console.log(separator);
  for (const row of rows) {
    console.log(cols.map(c => row[c.field].padEnd(c.w)).join('  '));
  }
  if (cliWarnings.length) {
    console.log('');
    for (const w of cliWarnings) console.log(`Warning: ${w}`);
  }
  console.log(`\nSystem config: ${path.join(systemDir, 'apps.yaml')}`);
  console.log(`User config:   ${appsPath}`);
  console.log('Run "wsh apps init" to create a starter user config.');
  process.exit(0);
} else if (process.argv[2] === 'new') {
  if (wantsHelp) subHelp('Usage: wsh new [-p <port>] [-s <session-id>] [--notify] [--cwd <dir>] [--env KEY=VALUE] [--skill <name>] [app-key] [input...]', [
    '', 'Create a new session and print its URL.',
    '', 'Options:',
    '  -p, --port <port>       Server port (default: $WSH_PORT or 7681)',
    '  -s, --session <id>      Reuse a specific session ID',
    '  --notify                Show a toast on the catalog page when the app is ready',
    '  --cwd <dir>             Override working directory for the session',
    '  --env KEY=VALUE         Set environment variable (repeatable)',
    '  --skill <name>          Run a skill instead of an app',
  ]);
  const subArgs = process.argv.slice(3);

  let port = parseInt(process.env.WSH_PORT || '', 10) || 7681;
  const portIdx = subArgs.findIndex(a => a === '--port' || a === '-p');
  if (portIdx !== -1 && subArgs[portIdx + 1]) {
    port = parseInt(subArgs[portIdx + 1], 10);
    subArgs.splice(portIdx, 2);
  }

  let sessionId = '';
  const sidIdx = subArgs.findIndex(a => a === '--session' || a === '-s');
  if (sidIdx !== -1 && subArgs[sidIdx + 1]) {
    sessionId = subArgs[sidIdx + 1];
    subArgs.splice(sidIdx, 2);
  }

  let cwdFlag = '';
  const cwdIdx = subArgs.findIndex(a => a === '--cwd');
  if (cwdIdx !== -1 && subArgs[cwdIdx + 1]) {
    cwdFlag = subArgs[cwdIdx + 1];
    subArgs.splice(cwdIdx, 2);
  }

  const envFlags: Record<string, string> = {};
  for (;;) {
    const envIdx = subArgs.findIndex(a => a === '--env');
    if (envIdx === -1 || !subArgs[envIdx + 1]) break;
    const val = subArgs[envIdx + 1];
    const eqPos = val.indexOf('=');
    if (eqPos > 0) envFlags[val.slice(0, eqPos)] = val.slice(eqPos + 1);
    subArgs.splice(envIdx, 2);
  }

  let skillFlag = '';
  const skillIdx = subArgs.findIndex(a => a === '--skill');
  if (skillIdx !== -1 && subArgs[skillIdx + 1]) {
    skillFlag = subArgs[skillIdx + 1];
    subArgs.splice(skillIdx, 2);
  }

  const notifyIdx = subArgs.indexOf('--notify');
  const notify = notifyIdx !== -1;
  if (notifyIdx !== -1) subArgs.splice(notifyIdx, 1);
  const positionalArgs = subArgs.filter(a => !a.startsWith('-'));
  const appKey = positionalArgs[0] || (skillFlag ? '' : 'bash');
  const input = skillFlag ? positionalArgs.join(' ') : positionalArgs.slice(1).join(' ');
  let basePath = process.env.WSH_BASE_PATH || '/';
  if (!basePath.startsWith('/')) basePath = '/' + basePath;
  if (!basePath.endsWith('/')) basePath += '/';
  const aboxUser = process.env.ABOX_USER;
  const proxySecret = process.env.WSH_PROXY_SECRET;
  let userHeader = '';
  if (proxySecret) userHeader += ` -H 'X-WSH-Proxy-Secret: ${proxySecret}'`;
  if (aboxUser) userHeader += ` -H 'X-WSH-User: ${aboxUser}'`;
  const payload: Record<string, unknown> = skillFlag ? { skill: skillFlag } : { app: appKey };
  if (input) payload.input = input;
  if (sessionId) payload.session = sessionId;
  if (notify) payload.notify = true;
  if (cwdFlag) payload.cwd = cwdFlag;
  if (Object.keys(envFlags).length) payload.env = envFlags;
  const jsonData = JSON.stringify(payload);
  let lastErr: any;
  for (const scheme of ['http', 'https'] as const) {
    const url = `${scheme}://127.0.0.1:${port}${basePath}api/sessions`;
    const flags = scheme === 'https' ? '-sSk' : '-sS';
    try {
      const body = execSync(
        `curl ${flags} ${userHeader} -X POST -H 'Content-Type: application/json' -d '${jsonData}' -w '\\n%{http_code}' '${url}'`,
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
      if (process.env.WSH_URL) {
        // Behind a proxy: construct URL from external origin + relative path
        try { const u = new URL(parsed.url); console.log(`${process.env.WSH_URL}${u.pathname}${u.hash}`); }
        catch { console.log(parsed.url); }
      } else {
        console.log(parsed.url);
      }
      process.exit(0);
    } catch (err: any) {
      lastErr = err;
      if (scheme === 'http') continue;
    }
  }
  if (lastErr?.stderr?.includes('onnect') || lastErr?.stderr?.includes('refused')) {
    console.error(`No wsh server running on localhost:${port}`);
  } else {
    console.error('Error:', lastErr?.stderr?.trim() || lastErr?.message);
  }
  process.exit(1);
} else if (process.argv[2] === 'logs') {
  if (wantsHelp) subHelp('Usage: wsh logs [-p <port>] [-f] <session-id>', [
    '', 'Print session scrollback (stdout/stderr output).',
    '', 'Options:',
    '  -p, --port <port>  Server port (default: $WSH_PORT or 7681)',
    '  -f, --follow       Stream new output after printing scrollback',
  ]);
  const subArgs = process.argv.slice(3);

  let port = parseInt(process.env.WSH_PORT || '', 10) || 7681;
  const portIdx = subArgs.findIndex(a => a === '--port' || a === '-p');
  if (portIdx !== -1 && subArgs[portIdx + 1]) {
    port = parseInt(subArgs[portIdx + 1], 10);
    subArgs.splice(portIdx, 2);
  }

  const followIdx = subArgs.findIndex(a => a === '--follow' || a === '-f');
  const follow = followIdx !== -1;
  if (followIdx !== -1) subArgs.splice(followIdx, 1);

  const target = subArgs.find(a => !a.startsWith('-'));
  if (!target) { console.error('Usage: wsh logs <session-id | app-name>'); process.exit(1); }

  let basePath = process.env.WSH_BASE_PATH || '/';
  if (!basePath.startsWith('/')) basePath = '/' + basePath;
  if (!basePath.endsWith('/')) basePath += '/';

  const aboxUser = process.env.ABOX_USER;
  const proxySecret = process.env.WSH_PROXY_SECRET;
  let userHeader = '';
  if (proxySecret) userHeader += ` -H 'X-WSH-Proxy-Secret: ${proxySecret}'`;
  if (aboxUser) userHeader += ` -H 'X-WSH-User: ${aboxUser}'`;

  // Resolve target: if it matches a session ID, use it; otherwise look up by app name.
  function resolveSessionId(): string {
    for (const scheme of ['http', 'https'] as const) {
      const url = `${scheme}://127.0.0.1:${port}${basePath}api/sessions`;
      const flags = scheme === 'https' ? '-sSk' : '-sS';
      try {
        const body = execSync(`curl ${flags} ${userHeader} '${url}'`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        const data = JSON.parse(body) as { sessions: { id: string; app: string }[] };
        // Exact session ID match (only if target looks like a 6-char session ID)
        if (isSessionId(target!)) {
          const byId = data.sessions.find(s => s.id === target);
          if (byId) return byId.id;
        }
        // App name match (most recently created)
        const byApp = data.sessions.filter(s => s.app === target);
        if (byApp.length > 0) return byApp[byApp.length - 1].id;
        // Partial app name match
        const byPartial = data.sessions.filter(s => s.app.includes(target!));
        if (byPartial.length === 1) return byPartial[0].id;
        if (byPartial.length > 1) {
          console.error(`Multiple sessions match "${target}": ${byPartial.map(s => `${s.id} (${s.app})`).join(', ')}`);
          process.exit(1);
        }
        console.error(`No session found for "${target}".`);
        process.exit(1);
      } catch (err: any) {
        if (scheme === 'http') continue;
        if (err.stderr?.includes('onnect') || err.stderr?.includes('refused')) {
          console.error(`No wsh server running on localhost:${port}`);
        } else {
          console.error('Error:', err.stderr?.trim() || err.message);
        }
        process.exit(1);
      }
    }
    return ''; // unreachable
  }
  const sessionId = resolveSessionId();

  if (!follow) {
    // One-shot: fetch scrollback via HTTP and print
    let lastErr: any;
    for (const scheme of ['http', 'https'] as const) {
      const url = `${scheme}://127.0.0.1:${port}${basePath}api/sessions/${sessionId}/logs`;
      const flags = scheme === 'https' ? '-sSk' : '-sS';
      try {
        const result = execSync(`curl ${flags} ${userHeader} -w '\\n%{http_code}' '${url}'`, { stdio: ['pipe', 'pipe', 'pipe'] });
        const raw = result.toString('utf8');
        // Last line is HTTP status code
        const lastNl = raw.lastIndexOf('\n');
        const httpCode = parseInt(raw.slice(lastNl + 1), 10);
        const body = raw.slice(0, lastNl);
        if (httpCode === 404) { console.error(`Session "${sessionId}" not found.`); process.exit(1); }
        if (httpCode >= 400) { console.error(`Error: server returned ${httpCode}`); process.exit(1); }
        process.stdout.write(body);
        process.exit(0);
      } catch (err: any) {
        lastErr = err;
        if (scheme === 'http') continue;
      }
    }
    if (lastErr?.stderr?.toString().includes('onnect') || lastErr?.stderr?.toString().includes('refused')) {
      console.error(`No wsh server running on localhost:${port}`);
    } else {
      console.error('Error:', lastErr?.stderr?.toString().trim() || lastErr?.message);
    }
    process.exit(1);
  } else {
    // Follow mode: connect via WebSocket, print scrollback then stream live output
    function tryConnect(scheme: 'ws' | 'wss'): void {
      const wsUrl = `${scheme}://127.0.0.1:${port}${basePath}terminal?session=${sessionId}&yield=1&reconnect=1`;
      const headers: Record<string, string> = {};
      if (proxySecret) headers['X-WSH-Proxy-Secret'] = proxySecret;
      if (aboxUser) headers['X-WSH-User'] = aboxUser;
      let opened = false;
      let abandoned = false;
      const ws = new WebSocket(wsUrl, { headers, rejectUnauthorized: false });
      ws.on('open', () => { opened = true; });
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) process.stdout.write(data);
      });
      ws.on('close', (code: number) => {
        if (abandoned) return;
        if (code === 4003) { console.error(`Session "${sessionId}" not found.`); process.exit(1); }
        if (!opened) { console.error(`No wsh server running on localhost:${port}`); process.exit(1); }
        process.exit(0);
      });
      ws.on('error', () => {
        if (!opened && scheme === 'ws') { abandoned = true; ws.terminate(); tryConnect('wss'); return; }
        if (!opened) { console.error(`No wsh server running on localhost:${port}`); process.exit(1); }
        process.exit(1);
      });
      process.on('SIGINT', () => { ws.close(); process.exit(0); });
      process.on('SIGTERM', () => { ws.close(); process.exit(0); });
    }
    tryConnect('ws');
    (globalThis as any).__wshFollowMode = true;
  }
} else if (process.argv[2] === 'ls' || process.argv[2] === 'kill' || process.argv[2] === 'port') {
  const subcommand = process.argv[2];
  if (wantsHelp) {
    if (subcommand === 'ls') subHelp('Usage: wsh ls [-p <port>]', ['', 'List active sessions.', '', 'Options:', '  -p, --port <port>  Server port (default: $WSH_PORT or 7681)']);
    else if (subcommand === 'port') subHelp('Usage: wsh port [-p <port>] <app>', ['', 'Print the port of a running web app.', '', 'Options:', '  -p, --port <port>  Server port (default: $WSH_PORT or 7681)']);
    else subHelp('Usage: wsh kill [-p <port>] <session-id>', ['', 'Close a session by ID.', '', 'Options:', '  -p, --port <port>  Server port (default: $WSH_PORT or 7681)']);
  }
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

  const aboxUser = process.env.ABOX_USER;
  const proxySecret = process.env.WSH_PROXY_SECRET;
  let userHeader = '';
  if (proxySecret) userHeader += ` -H 'X-WSH-Proxy-Secret: ${proxySecret}'`;
  if (aboxUser) userHeader += ` -H 'X-WSH-User: ${aboxUser}'`;

  function curlRequest(method: string, urlPath: string): { status: number; body: string } {
    // Try HTTP first; if it fails (e.g. httpsOnly mode), retry with HTTPS.
    for (const scheme of ['http', 'https'] as const) {
      const url = `${scheme}://127.0.0.1:${port}${urlPath}`;
      const flags = scheme === 'https' ? '-sSk' : '-sS';
      try {
        const body = execSync(`curl ${flags} ${userHeader} -X ${method} -w '\\n%{http_code}' '${url}'`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        const lines = body.trimEnd().split('\n');
        const httpCode = parseInt(lines.pop()!, 10);
        return { status: httpCode, body: lines.join('\n') };
      } catch (err: any) {
        if (scheme === 'http') continue;
        if (err.stderr?.includes('onnect') || err.stderr?.includes('refused')) {
          console.error(`No wsh server running on localhost:${port}`);
        } else {
          console.error('Error:', err.stderr?.trim() || err.message);
        }
        process.exit(1);
      }
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
    const base = (s: any) => [
      s.id, s.app ?? '', s.appType ?? 'pty', s.title, s.pinned ? 'yes' : 'no', String(s.peers), s.hasWriter ? 'yes' : 'no',
      formatDuration(now - s.createdAt),
    ];
    const headers = extended
      ? ['ID', 'APP', 'TYPE', 'TITLE', 'PINNED', 'PEERS', 'WRITER', 'UPTIME', 'IN', 'OUT', 'PID', 'SIZE', 'PROCESS']
      : ['ID', 'APP', 'TYPE', 'TITLE', 'PINNED', 'PEERS', 'WRITER', 'UPTIME', 'IDLE'];
    const rows = data.sessions.map((s: any) => extended
      ? [...base(s), formatDuration(now - s.lastInput), formatDuration(now - s.lastOutput), String(s.pid), formatSize(s.scrollbackSize), s.process ?? '']
      : [...base(s), formatDuration(now - Math.max(s.lastInput, s.lastOutput))],
    );
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
    console.log(headers.map((h, i) => padRight(h, widths[i])).join('  '));
    for (const row of rows) console.log(row.map((c, i) => padRight(c, widths[i])).join('  '));
  } else if (subcommand === 'port') {
    const appName = subArgs.find(a => !a.startsWith('-'));
    if (!appName) { console.error('Usage: wsh port <app>'); process.exit(1); }
    const { body } = curlRequest('GET', basePath + 'api/sessions');
    const data = JSON.parse(body) as { sessions: any[] };
    const session = data.sessions.find((s: any) => s.app === appName && s.appType === 'web' && s.port);
    if (!session) { console.error(`No running web app "${appName}" found.`); process.exit(1); }
    console.log(session.port);
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

// `wsh logs -f` keeps the process alive via WebSocket — skip server startup.
if ((globalThis as any).__wshFollowMode) { /* event loop stays alive */ } else {

const MAX_SCROLLBACK     = 5 * 1024 * 1024; // 5 MB
const MAX_SCROLLBACK_WEB = 512 * 1024;      // 512 KB (web app logs)
const MAX_SCROLLBACK_JOB = 1 * 1024 * 1024; // 1 MB (job output)
const SESSION_TTL     = 10 * 60 * 1000;     // 10 minutes
const WEB_SESSION_TTL = 60 * 60 * 1000;     // 1 hour
const JOB_LINGER_TTL  = 5 * 60 * 1000;      // 5 minutes — keep finished job session for log retrieval
const PING_INTERVAL = 30_000;           // 30 seconds
const PONG_TIMEOUT  = 10_000;           // 10 seconds
const RATE_WINDOW   = 60_000;           // 1 minute
const RATE_MAX_MISS = 10;               // max invalid session attempts per IP per window

type Role = 'owner' | 'writer' | 'viewer';

interface Session {
  pty: IPty | null;
  scrollback: Buffer;
  writer: WebSocket | null;
  peers: Map<WebSocket, Role>; // every connected WS → its original role
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  pinned: boolean;
  title: string;
  app: string;
  cwd: string;
  createdAt: number;
  lastInput: number;
  lastOutput: number;
  appType: 'pty' | 'web' | 'job';
  child: ChildProcess | null;
  port?: number;
  ready?: boolean;
  timeoutMs?: number;
  access?: 'public' | 'private';
  stripPrefix?: boolean;
  exitCode?: number | null;
  /** When set, PTY spawn is deferred until the first resize message. */
  pendingConfig?: AppConfig;
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


/** Kill a child process and its entire process group. */
function killProcessGroup(child: ChildProcess): void {
  if (child.pid != null) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already dead */ }
  } else {
    child.kill('SIGTERM');
  }
}


// Strip ephemeral terminal queries/responses from scrollback data.
// These should not be replayed — replaying them causes xterm.js to generate
// fresh responses that appear as garbage in TUI input fields on reconnect.
//
// Stripped sequences:
//   - OSC color queries:  \e]10;?\a  \e]11;?\e\\  etc.
//   - DSR cursor reports: \e[row;colR  (response to \e[6n)
const oscQueryStripRe = /\x1b\]\d+;\?(?:\x07|\x1b\\)/g;
const dsrResponseRe = /\x1b\[\d+;\d+R/g;
function stripEphemeralSequences(buf: Buffer): Buffer {
  const str = buf.toString('utf8');
  if (!str.includes('\x1b')) return buf;
  const stripped = str.replace(oscQueryStripRe, '').replace(dsrResponseRe, '');
  return stripped.length === str.length ? buf : Buffer.from(stripped, 'utf8');
}

function appendScrollback(session: Session, data: Buffer): void {
  const limit = session.appType === 'web' ? MAX_SCROLLBACK_WEB : session.appType === 'job' ? MAX_SCROLLBACK_JOB : MAX_SCROLLBACK;
  session.scrollback = Buffer.concat([session.scrollback, data]);
  if (session.scrollback.length > limit) {
    session.scrollback = session.scrollback.slice(
      session.scrollback.length - limit
    );
  }
}

function baseSession(appKey: string, appConfig: AppConfig): Session {
  const now = Date.now();
  return {
    pty: null,
    scrollback: Buffer.alloc(0),
    writer: null,
    peers: new Map(),
    cleanupTimer: null,
    pinned: false,
    title: appConfig.title ?? path.basename(appConfig.command),
    app: appKey,
    cwd: resolveCwd(appConfig),
    createdAt: now,
    lastInput: now,
    lastOutput: now,
    appType: 'pty',
    child: null,
  };
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Prepend ~/.local/bin to PATH so user-installed tools are available in spawned apps. */
function appPath(): string {
  const localBin = path.join(os.homedir(), '.local', 'bin');
  const current = process.env.PATH || '';
  return current.includes(localBin) ? current : `${localBin}:${current}`;
}

function resolveCwd(appConfig: AppConfig): string {
  const dir = appConfig.cwd ? expandHome(appConfig.cwd) : (process.env.HOME ?? process.cwd());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build the shell command line for PTY spawn. */
function buildPtyCommand(appConfig: AppConfig): string {
  // For skill apps the command is a shell expression (e.g. `claude "/$SKILL $INPUT"`)
  // that must run via `sh -c`.  We fold it into the stty wrapper so there is only
  // ONE intermediate shell.  For non-skill apps `exec` replaces the wrapper shell
  // so there is no extra process and signals are delivered correctly.
  let cmdLine: string;
  if (appConfig.skill) {
    cmdLine = [appConfig.command, ...(appConfig.args ?? [])].join(' ');
  } else {
    cmdLine = [appConfig.command, ...(appConfig.args ?? [])]
      .map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  }

  return appConfig.skill
    ? cmdLine
    : `exec ${cmdLine}`;
}

/** Spawn a PTY and wire it into an existing session. */
function spawnPty(id: string, session: Session, appConfig: AppConfig, cols: number, rows: number): void {
  const wrapped = buildPtyCommand(appConfig);
  const ptyProcess = pty.spawn('/bin/sh', ['-c', wrapped], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: resolveCwd(appConfig),
    env: {
      ...process.env,
      PATH: appPath(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      WSH_RPC_PORT: String(PORT),
      WSH_RPC_BASE: BASE,
      WSH_SESSION: id,
      ...(appConfig.env ?? {}),
    } as Record<string, string>,
  });

  session.pty = ptyProcess;

  const oscTitleRe = /\x1b\](?:0|2);([^\x07]*)\x07/;
  const spawnTime = Date.now();
  let ptyMsgCount = 0;
  ptyProcess.onData((data: string) => {
    ptyMsgCount++;
    if (ptyMsgCount <= 10) console.log(`[session ${id}] PTY data #${ptyMsgCount}: ${Buffer.byteLength(data)}B +${Date.now() - spawnTime}ms peers=${session.peers.size}`);

    const m = data.match(oscTitleRe);
    if (m) session.title = m[1];
    session.lastOutput = Date.now();
    const buf = Buffer.from(data, 'utf8');
    appendScrollback(session, buf);
    for (const ws of session.peers.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true });
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`[session ${id}] PTY exited (code=${exitCode} signal=${signal})`);
    session.pty = null;
    const closeWs = (ws: WebSocket) => { if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'PTY process exited'); };
    for (const ws of session.peers.keys()) closeWs(ws);
    if (session.cleanupTimer !== null) clearTimeout(session.cleanupTimer);
    if (sessions.get(id) === session) sessions.delete(id);
  });

  console.log(`[session ${id}] spawned (${cols}x${rows}) cmd: ${wrapped}`);
}

function spawnSession(id: string, appKey: string, appConfig: AppConfig, cols = 80, rows = 24): Session {
  const session: Session = { ...baseSession(appKey, appConfig) };
  sessions.set(id, session);
  spawnPty(id, session, appConfig, cols, rows);
  return session;
}

/** Create a pending session that defers PTY spawn until the first resize. */
function createPendingSession(id: string, appKey: string, appConfig: AppConfig): Session {
  const session: Session = { ...baseSession(appKey, appConfig) };
  session.pendingConfig = appConfig;
  sessions.set(id, session);
  console.log(`[session ${id}] created (pending — waiting for resize to spawn PTY)`);
  return session;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function pollUntilReady(port: number, healthPath = '/', timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (Date.now() > deadline) { reject(new Error('Health check timeout')); return; }
      const req = http.request({ hostname: '127.0.0.1', port, path: healthPath, method: 'GET', timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => setTimeout(check, 500));
      req.on('timeout', () => { req.destroy(); setTimeout(check, 500); });
      req.end();
    };
    check();
  });
}

async function spawnWebSession(id: string, appKey: string, appConfig: AppConfig, options?: { notify?: boolean }): Promise<Session> {
  const port = await findFreePort();
  const configuredTimeout = appConfig.timeout ? parseTimeout(appConfig.timeout) : undefined;
  const timeoutMs = (configuredTimeout != null && !isNaN(configuredTimeout)) ? configuredTimeout : WEB_SESSION_TTL;
  const session: Session = {
    ...baseSession(appKey, appConfig),
    appType: 'web',
    port,
    ready: false,
    timeoutMs,
    access: appConfig.access,
    stripPrefix: appConfig.stripPrefix,
  };

  sessions.set(id, session);

  const env = {
    ...process.env,
    PATH: appPath(),
    ...(appConfig.env ?? {}),
    WSH_PORT: String(port),
    WSH_SESSION: id,
    WSH_BASE_URL: BASE + '_a/' + appKey + '/',
  };

  const child = spawn(appConfig.command, appConfig.args ?? [], {
    shell: '/bin/sh',
    detached: true,
    env: env as Record<string, string>,
    cwd: resolveCwd(appConfig),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  session.child = child;

  // Log the launch command to the log terminal
  const cmdLine = appConfig.args?.length
    ? `${appConfig.command} ${appConfig.args.join(' ')}`
    : appConfig.command;
  const resolvedCmd = cmdLine
    .replace(/\$WSH_PORT\b/g, String(port))
    .replace(/\$WSH_SESSION\b/g, id)
    .replace(/\$WSH_BASE_URL\b/g, BASE + '_a/' + appKey + '/');
  const cwd = resolveCwd(appConfig);
  const banner = `\x1b[90m$ cd ${cwd} && ${resolvedCmd}\x1b[0m\r\n`;
  const bannerBuf = Buffer.from(banner);
  appendScrollback(session, bannerBuf);
  for (const ws of session.peers.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(bannerBuf, { binary: true });
  }

  const appendOutput = (data: Buffer) => {
    session.lastOutput = Date.now();
    appendScrollback(session, data);
    for (const ws of session.peers.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
    }
  };

  child.stdout!.on('data', appendOutput);
  child.stderr!.on('data', appendOutput);

  child.on('exit', (code) => {
    console.log(`[session ${id}] web process exited (code ${code})`);
    for (const ws of session.peers.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Process exited');
    }
    if (session.cleanupTimer !== null) clearTimeout(session.cleanupTimer);
    // Only delete if this session is still the current one (not replaced by -s reuse)
    if (sessions.get(id) === session) sessions.delete(id);
  });

  console.log(`[session ${id}] web app spawned on port ${port}`);

  // Poll for readiness in the background — don't block session creation.
  // The client shows its own loading spinner until the iframe loads.
  const healthBase = session.stripPrefix ? '' : BASE + '_a/' + appKey;
  const healthPath = healthBase + (appConfig.healthCheck || '/');
  const startupTimeoutMs = appConfig.startupTimeout ? parseTimeout(appConfig.startupTimeout) : 30000;
  const effectiveStartupTimeout = (!isNaN(startupTimeoutMs) && startupTimeoutMs > 0) ? startupTimeoutMs : 30000;
  pollUntilReady(port, healthPath, effectiveStartupTimeout).then(() => {
    session.ready = true;
    console.log(`[session ${id}] web app ready`);
    const readyMsg = JSON.stringify({ type: 'ready' });
    for (const ws of session.peers.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(readyMsg);
    }
    // Notify catalog pages so they can show a clickable "open" toast
    if (options?.notify) {
      const escJs = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      broadcastRpc('eval', `api.sessionReady&&api.sessionReady('${escJs(id)}','${escJs(appKey)}','${escJs(session.title || appKey)}')`);
    }
  }).catch(() => {
    if (sessions.has(id)) {
      console.log(`[session ${id}] health check failed, but process still running`);
    }
  });

  return session;
}

function spawnJobSession(id: string, appKey: string, appConfig: AppConfig): Session {
  const session: Session = {
    ...baseSession(appKey, appConfig),
    appType: 'job',
  };

  sessions.set(id, session);

  const env = {
    ...process.env,
    PATH: appPath(),
    ...(appConfig.env ?? {}),
    WSH_SESSION: id,
    WSH_RPC_PORT: String(PORT),
    WSH_RPC_BASE: BASE,
  };

  const child = spawn(appConfig.command, appConfig.args ?? [], {
    shell: '/bin/sh',
    detached: true,
    env: env as Record<string, string>,
    cwd: resolveCwd(appConfig),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  session.child = child;

  // Banner showing the command being run
  const cmdLine = appConfig.args?.length
    ? `${appConfig.command} ${appConfig.args.join(' ')}`
    : appConfig.command;
  const cwd = resolveCwd(appConfig);
  const banner = `\x1b[90m$ cd ${cwd} && ${cmdLine}\x1b[0m\r\n`;
  const bannerBuf = Buffer.from(banner);
  appendScrollback(session, bannerBuf);
  for (const ws of session.peers.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(bannerBuf, { binary: true });
  }

  const appendOutput = (data: Buffer) => {
    session.lastOutput = Date.now();
    appendScrollback(session, data);
    for (const ws of session.peers.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
    }
  };

  child.stdout!.on('data', appendOutput);
  child.stderr!.on('data', appendOutput);

  child.on('exit', (code, signal) => {
    console.log(`[session ${id}] job exited (code ${code}, signal ${signal})`);
    session.exitCode = code;
    session.child = null;

    // Notify connected peers that the job finished
    const exitMsg = JSON.stringify({ type: 'job-exit', code, signal });
    for (const ws of session.peers.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(exitMsg);
    }

    // Linger briefly so clients can retrieve scrollback, then auto-delete
    if (session.cleanupTimer !== null) clearTimeout(session.cleanupTimer);
    session.cleanupTimer = setTimeout(() => {
      if (sessions.get(id) === session) {
        sessions.delete(id);
        console.log(`[session ${id}] job session cleaned up`);
      }
    }, JOB_LINGER_TTL);
  });

  console.log(`[session ${id}] job spawned: ${cmdLine}`);
  return session;
}

function parseTimeout(str: string): number {
  const m = str.match(/^(\d+)\s*(ms|s|m|h|d)$/);
  if (!m) return NaN;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
    default: return NaN;
  }
}

function scheduleCleanup(id: string, session: Session): void {
  if (session.cleanupTimer !== null) {
    clearTimeout(session.cleanupTimer);
  }
  session.cleanupTimer = null;
  if (session.pinned) return;
  if (session.appType === 'job') return; // jobs manage their own cleanup via exit handler
  const ttl = session.timeoutMs ?? (session.appType === 'web' ? WEB_SESSION_TTL : SESSION_TTL);
  session.cleanupTimer = setTimeout(() => {
    console.log(`[session ${id}] TTL expired, killing process`);
    if (session.child) killProcessGroup(session.child);
    else if (session.pty) session.pty.kill('SIGHUP');
    // Session cleanup happens in the process exit handler.
    // For PTY sessions the exit handler fires synchronously after kill.
    // Guard against processes that ignore SIGTERM (e.g. stuck):
    if (sessions.has(id)) {
      setTimeout(() => {
        if (sessions.has(id)) {
          console.log(`[session ${id}] process did not exit after SIGTERM, force killing`);
          if (session.child) { try { process.kill(-session.child.pid!, 'SIGKILL'); } catch {} }
          else if (session.pty) session.pty.kill('SIGKILL');
        }
      }, 5000);
    }
  }, ttl);
}

// --- Args ---

const { values } = parseArgs({
  allowPositionals: true,
  options: {
    port:      { type: 'string',  short: 'p', default: process.env.WSH_PORT || '7681' },
    bind:      { type: 'string',              default: '' },
    'no-open':  { type: 'boolean',             default: false },
    'no-login': { type: 'boolean',             default: false },
    'trust-proxy': { type: 'boolean',          default: false },
    'no-tls':   { type: 'boolean',             default: false },
    help:       { type: 'boolean', short: 'h', default: false },
    version:    { type: 'boolean', short: 'v', default: false },
    base:       { type: 'string', default: process.env.WSH_BASE_PATH || '/' },
    title:      { type: 'string', default: 'wsh' },
    tagline:    { type: 'string', default: 'Apps in the browser' },
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
  console.log('  logs <session-id>  Print session scrollback (stdout/stderr)');
  console.log('  kill <session-id>  Close a session');
  console.log('  new [app-key]      Create a new session (default: bash)');
  console.log('  apps               List available apps');
  console.log('  update             Update to the latest version');
  console.log('  version            Print version and exit');
  console.log('  token              Print the auth token and exit');
  console.log('');
  console.log('Options:');
  console.log('  -p, --port <port>  Port to listen on (default: 7681)');
  console.log('      --bind <addr>  Bind network server to this address (default: auto-detect LAN IP)');
  console.log('                     Use 0.0.0.0 to listen on all interfaces (e.g. inside Docker --network host)');
  console.log('      --base <path>  Base path prefix (default: /)');
  console.log('      --title <name> Custom title for the index page (default: wsh)');
  console.log('      --tagline <text>  Custom tagline below the title (default: Apps in the browser)');
  console.log('      --no-open      Do not open browser on start');
  console.log('      --no-login     Spawn non-login shells (default: login shell)');
  console.log('      --no-tls       Serve plain HTTP instead of HTTPS (for use behind a TLS-terminating proxy)');
  console.log('      --trust-proxy  Disable loopback auth bypass (use behind a reverse proxy)');
  console.log('  -v, --version      Print version and exit');
  console.log('  -h, --help         Show this help message');
  console.log('');
  console.log('Environment:');
  console.log('  WSH_PORT           Port (default: 7681, overridden by --port)');
  console.log('  WSH_BASE_PATH      Base path prefix (default: /, overridden by --base)');
  console.log('  WSH_URL            External origin for session URLs (e.g. https://mybox.example.com)');
  console.log('  WSH_PROXY_SECRET   Shared secret for --trust-proxy mode');
  process.exit(0);
}

function normalizeBase(raw: string): string {
  let b = raw;
  if (!b.startsWith('/')) b = '/' + b;
  if (!b.endsWith('/')) b += '/';
  return b;
}

const BASE = normalizeBase(values.base!);
const SITE_TITLE = values.title!;
const SITE_TAGLINE = values.tagline!;

const PORT = parseInt(values.port!, 10);
const CUSTOM_URL = process.env.WSH_URL?.replace(/\/+$/, '') || null;
const BIND_ADDR  = values.bind || null;
const TRUST_PROXY = values['trust-proxy']!;
const NO_TLS = values['no-tls']!;
const PROXY_SECRET = process.env.WSH_PROXY_SECRET || '';

if (TRUST_PROXY && !PROXY_SECRET) {
  console.error('Error: --trust-proxy requires WSH_PROXY_SECRET environment variable');
  process.exit(1);
}

if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Error: invalid port "${values.port}"`);
  process.exit(1);
}

// --- App config ---

interface AppConfig {
  command: string;
  inlineCommand?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  title?: string;
  icon?: string;
  description?: string;
  hidden?: boolean;
  skill?: string;
  type?: 'pty' | 'web' | 'job';
  timeout?: string;
  access?: 'public' | 'private';
  stripPrefix?: boolean;
  healthCheck?: string;
  startupTimeout?: string;
}

const DEFAULT_APPS: Record<string, AppConfig> = {
  bash: {
    command: '/bin/bash',
    args: values['no-login'] ? [] : ['-l'],
    title: 'bash',
  },
};

const SYSTEM_CONFIG_DIR = '/etc/wsh';

function loadConfigFile(dir: string): Record<string, unknown> | null {
  // Prefer apps.yaml, fall back to apps.json
  try { return YAML.parse(fs.readFileSync(path.join(dir, 'apps.yaml'), 'utf8')); } catch {}
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'apps.json'), 'utf8')); } catch {}
  return null;
}

function normalizeAppEntry(value: unknown): AppConfig | null {
  if (value && typeof value === 'object' && (typeof (value as any).command === 'string' || typeof (value as any).skill === 'string'))
    return value as AppConfig;
  return null;
}

function mergeApps(apps: Record<string, AppConfig>, parsed: Record<string, unknown>, warnings?: string[]): void {
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.startsWith('_') || !value || typeof value !== 'object') continue;
    if (RESERVED_PATHS.has(key)) {
      warnings?.push(`"${key}" is a reserved name and cannot be used as an app name — this entry was ignored`);
      continue;
    }
    if (apps[key]) {
      // Field-level merge into existing app (enables partial overrides like hidden: true)
      apps[key] = { ...apps[key], ...(value as Partial<AppConfig>) };
    } else {
      // New app — requires command
      const config = normalizeAppEntry(value);
      if (config) apps[key] = config;
    }
  }
}

/** Reserved URL paths that cannot be used as app names. */
const RESERVED_PATHS = new Set(['skill']);

const SKILL_DEFAULTS: Partial<AppConfig> = {
  command: 'claude "/$SKILL $INPUT"',
};

function extractSkillDefaults(...configs: (Record<string, unknown> | null)[]): Partial<AppConfig> {
  let defaults: Partial<AppConfig> = { ...SKILL_DEFAULTS };
  let agent: string | undefined;
  let tools: Record<string, any> | undefined;
  for (const config of configs) {
    const raw = config?._skills as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') continue;
    // Pick up top-level scalar defaults (cwd, env, etc.) but skip structured keys
    const { tools: t, agent: a, ...rest } = raw;
    defaults = { ...defaults, ...(rest as Partial<AppConfig>) };
    if (typeof a === 'string') agent = a;
    if (t && typeof t === 'object') tools = { ...(tools ?? {}), ...(t as Record<string, any>) };
  }
  // Resolve agent-specific command and inlineCommand from tools
  if (agent && tools && tools[agent]) {
    const tool = tools[agent];
    if (typeof tool.command === 'string') defaults.command = tool.command;
    if (typeof tool.inline === 'string') defaults.inlineCommand = tool.inline;
  }
  return defaults;
}

function loadApps(warnings?: string[]): Record<string, AppConfig> {
  const apps = { ...DEFAULT_APPS };
  const system = loadConfigFile(SYSTEM_CONFIG_DIR);
  const user = loadConfigFile(path.join(os.homedir(), '.wsh'));
  // Merge app entries (keys starting with _ are reserved and skipped)
  if (system && typeof system === 'object') mergeApps(apps, system, warnings);
  if (user && typeof user === 'object') mergeApps(apps, user, warnings);
  // Apply _skills defaults to skill apps
  const skillDefaults = extractSkillDefaults(system, user);
  for (const app of Object.values(apps)) {
    if (app.skill) {
      for (const [k, v] of Object.entries(skillDefaults)) {
        if ((app as any)[k] === undefined) (app as any)[k] = v;
      }
    }
  }
  return apps;
}

/** Build an AppConfig for running a skill by name. Uses _skills defaults from apps.yaml. */
function buildSkillConfig(skillName: string, input: string, mode: string, cwd?: string, envOverride?: Record<string, string>): AppConfig {
  const system = loadConfigFile(SYSTEM_CONFIG_DIR);
  const user = loadConfigFile(path.join(os.homedir(), '.wsh'));
  const defaults = extractSkillDefaults(system, user);
  const useInline = mode === 'inline' && defaults.inlineCommand;
  const config: AppConfig = {
    command: useInline ? defaults.inlineCommand! : (defaults.command || SKILL_DEFAULTS.command!),
    skill: skillName,
    ...(defaults.cwd ? { cwd: defaults.cwd } : {}),
    env: {
      ...(defaults.env ?? {}),
      SKILL: skillName,
      INPUT: input,
      ...(mode ? { WSH_MODE: mode } : {}),
      ...(envOverride ?? {}),
    },
  };
  if (cwd) config.cwd = cwd;
  return config;
}

/** Find an existing web session for a given app key (singleton semantics). */
function findWebSession(appKey: string): { id: string; session: Session } | null {
  for (const [id, s] of sessions) {
    if (s.app === appKey && s.appType === 'web') return { id, session: s };
  }
  return null;
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

function verifyProxySecret(req: http.IncomingMessage): boolean {
  return req.headers['x-wsh-proxy-secret'] === PROXY_SECRET;
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

    // Trust-proxy mode: gateway sets X-WSH-User header
    if (TRUST_PROXY) {
      if (!verifyProxySecret(req)) { res.status(401).send('Unauthorized'); return; }
      if (req.headers['x-wsh-user']) return proceed();
      if (url.pathname.startsWith(BASE + 'api/')) {
        res.status(401).send('Unauthorized');
      } else {
        next();
      }
      return;
    }

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
const networkBase  = CUSTOM_URL ?? (advertiseIP ? `${NO_TLS ? 'http' : 'https'}://${advertiseIP}:${PORT}` : null);
let clientOrigin: string | null = null;

// --- Express app + server ---

const app = express();
app.use((_req, res, next) => { res.setHeader('X-App-Version', version); next(); });
if (token) app.use(makeTokenMiddleware(token));

const router = express.Router();

/** Control-only WebSocket clients that receive broadcast RPCs but have no session. */
const rpcClients = new Set<WebSocket>();

/** Send an RPC message to all peers of a specific session. */
function sessionRpc(sessionId: string, action: string, ...args: string[]): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  const msg = JSON.stringify({ type: 'rpc', action, args });
  for (const ws of session.peers.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

/** Send an RPC message to all connected WebSocket peers (sessions + control clients). */
function broadcastRpc(action: string, ...args: string[]): void {
  const msg = JSON.stringify({ type: 'rpc', action, args });
  for (const session of sessions.values()) {
    for (const ws of session.peers.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
  for (const ws of rpcClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// Serve the catalog page at /.
// When BASE != '/', also redirect /base -> /base/ to fix relative URL resolution.
router.get('/', (req: express.Request, res: express.Response) => {
  if (BASE !== '/' && !req.originalUrl.endsWith('/')) {
    res.redirect(301, BASE);
    return;
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'catalog.html'), 'utf8');
  const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  res.type('html').send(html.replace(/\{\{title\}\}/g, escHtml(SITE_TITLE)).replace(/\{\{tagline\}\}/g, escHtml(SITE_TAGLINE)));
});

router.get('/api/share', (req: express.Request, res: express.Response) => {
  const sessionId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('session');
  if (!sessionId) { res.status(400).json({ error: 'session ID required' }); return; }
  if (!tls) { res.status(503).json({ error: 'Network sharing not available' }); return; }
  res.json({ wtoken: writerToken(sessionId) });
});

router.get('/api/apps', (_req: express.Request, res: express.Response) => {
  const warnings: string[] = [];
  const apps = loadApps(warnings);
  const list = Object.entries(apps)
    .map(([key, app]) => ({
      key,
      title: app.title ?? path.basename(app.command),
      command: app.command,
      icon: app.icon ?? null,
      description: app.description ?? null,
      skill: app.skill ?? null,
      type: app.type ?? 'pty',
      access: app.access ?? null,
      hidden: app.hidden ? true : undefined,
      _raw: app,
    }));
  res.json({ apps: list, ...(warnings.length ? { warnings } : {}) });
});

router.post('/api/apps/:key/unhide', (req: express.Request, res: express.Response) => {
  const appKey = req.params.key;
  const apps = loadApps();
  if (!apps[appKey]) { res.status(404).json({ error: 'App not found' }); return; }
  if (!apps[appKey].hidden) { res.json({ ok: true }); return; }

  const userDir = path.join(os.homedir(), '.wsh');
  const userFile = path.join(userDir, 'apps.yaml');
  let userConfig: Record<string, unknown> = {};
  try { userConfig = YAML.parse(fs.readFileSync(userFile, 'utf8')) ?? {}; } catch {}
  if (!userConfig[appKey] || typeof userConfig[appKey] !== 'object') {
    userConfig[appKey] = { hidden: false };
  } else {
    (userConfig[appKey] as any).hidden = false;
  }
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(userFile, YAML.stringify(userConfig), 'utf8');
  res.json({ ok: true });
});

router.post('/api/apps/:key/hide', (req: express.Request, res: express.Response) => {
  const appKey = req.params.key;
  const apps = loadApps();
  if (!apps[appKey]) { res.status(404).json({ error: 'App not found' }); return; }
  if (apps[appKey].hidden) { res.json({ ok: true }); return; }

  const userDir = path.join(os.homedir(), '.wsh');
  const userFile = path.join(userDir, 'apps.yaml');
  let userConfig: Record<string, unknown> = {};
  try { userConfig = YAML.parse(fs.readFileSync(userFile, 'utf8')) ?? {}; } catch {}
  if (!userConfig[appKey] || typeof userConfig[appKey] !== 'object') {
    userConfig[appKey] = { hidden: true };
  } else {
    (userConfig[appKey] as any).hidden = true;
  }
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(userFile, YAML.stringify(userConfig), 'utf8');
  res.json({ ok: true });
});

router.get('/api/sessions', (_req: express.Request, res: express.Response) => {
  const list = [...sessions.entries()].map(([id, s]) => ({
    id,
    title: s.title,
    app: s.app,
    appType: s.appType,
    pinned: s.pinned,
    peers: s.peers.size,
    hasWriter: s.writer !== null,
    createdAt: s.createdAt,
    lastInput: s.lastInput,
    lastOutput: s.lastOutput,
    pid: s.pty?.pid ?? s.child?.pid ?? null,
    scrollbackSize: s.scrollback.length,
    process: s.pty?.process ?? null,
    port: s.port ?? null,
    ready: s.ready ?? null,
    exitCode: s.exitCode ?? null,
    cwd: s.cwd ?? null,
  }));
  res.json({ sessions: list });
});

router.get('/api/sessions/:id/logs', (req: express.Request, res: express.Response) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'session not found' }); return; }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(stripEphemeralSequences(session.scrollback));
});

router.get('/api/sessions/:id/stream', (req: express.Request, res: express.Response) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'session not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send existing scrollback
  if (session.scrollback.length > 0) {
    const text = stripEphemeralSequences(session.scrollback).toString('utf8');
    res.write(`data: ${JSON.stringify({ text })}\n\n`);
  }

  // If the process already exited, send done and close
  if (session.appType === 'job' && session.child === null) {
    res.write(`data: ${JSON.stringify({ exit: session.exitCode ?? null })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // Create a fake WebSocket-like peer to receive live output
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send(data: Buffer | string, _opts?: any) {
      if (res.destroyed) return;
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : typeof data === 'string' ? data : '';
      // Skip JSON control messages (role, ready, job-exit, etc.)
      if (text.startsWith('{')) {
        try {
          const parsed = JSON.parse(text);
          if (parsed.type === 'job-exit') {
            res.write(`data: ${JSON.stringify({ exit: parsed.code ?? null })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          // Skip other control messages
          if (parsed.type) return;
        } catch {}
      }
      if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
    },
    close() {
      if (!res.destroyed) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    },
  } as unknown as WebSocket;

  session.peers.set(fakeWs, 'viewer');

  req.on('close', () => {
    session.peers.delete(fakeWs);
  });
});

router.delete('/api/sessions/:id', (req: express.Request, res: express.Response) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'session not found' }); return; }
  if (session.child) killProcessGroup(session.child);
  else if (session.pty) session.pty.kill('SIGHUP');
  res.json({ ok: true });
});

// HTTP reverse proxy for web apps — must be before express.json() to preserve request body
function proxyHandler(req: express.Request, res: express.Response): void {
  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);
  if (!session || session.appType !== 'web' || !session.port) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  // Access control: non-public web apps require owner auth
  if (session.access !== 'public') {
    if (TRUST_PROXY) {
      if (!verifyProxySecret(req)) { res.status(401).send('Unauthorized'); return; }
      const xUser = req.headers['x-wsh-user'] as string | undefined;
      if (xUser !== process.env.ABOX_USER && xUser !== '*') {
        res.status(401).send('Unauthorized');
        return;
      }
    } else if (token && !isLoopback(req.socket.remoteAddress)) {
      const cookies = parseCookies(req.headers.cookie as string ?? '');
      if (cookies['wsh_token'] !== token) {
        res.status(401).send('Unauthorized');
        return;
      }
    }
  }
  if (!session.ready) {
    res.status(503).send('<!DOCTYPE html><html><body style="background:#1e1e2e;color:#cdd6f4;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div>Starting up\u2026</div></body></html>');
    return;
  }
  // Track proxy activity for idle detection
  session.lastOutput = Date.now();
  // stripPrefix: send just the relative path (e.g. '/'); otherwise forward the full prefixed path
  // req.url may start with /_p/<sessionId> or /_a/<appKey> — strip the matching prefix
  const appKey = req.params.appKey;
  const prefixToStrip = appKey ? '/_a/' + appKey : '/_p/' + sessionId;
  const rawSuffix = req.url.slice(prefixToStrip.length);
  const suffix = rawSuffix || '/';
  const stableBase = BASE + '_a/' + (session.app || sessionId);
  const targetPath = session.stripPrefix ? suffix : stableBase + rawSuffix;

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: session.port,
    path: targetPath,
    method: req.method,
    headers: req.headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode!, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) res.status(502).send('Bad Gateway');
  });

  req.pipe(proxyReq);
}

router.all('/_p/:sessionId', proxyHandler as any);
router.all('/_p/:sessionId/*', proxyHandler as any);

// Stable app-level proxy: /_a/<appKey>/... resolves to the singleton web session.
// Auto-starts the app if no session is running.
function appProxyHandler(req: express.Request, res: express.Response): void {
  const appKey = req.params.appKey;
  const apps = loadApps();
  const appConfig = apps[appKey];
  if (!appConfig || appConfig.type !== 'web') {
    res.status(404).json({ error: 'web app not found' });
    return;
  }

  const existing = findWebSession(appKey);
  if (existing) {
    // Reuse proxyHandler by injecting the resolved session ID
    req.params.sessionId = existing.id;
    proxyHandler(req, res);
    return;
  }

  // Auto-start the app
  const id = crypto.randomInt(0, 2176782336).toString(36).padStart(6, '0');
  spawnWebSession(id, appKey, appConfig).then(() => {
    req.params.sessionId = id;
    proxyHandler(req, res);
  }).catch(() => {
    res.status(500).json({ error: 'Failed to start app' });
  });
}
router.all('/_a/:appKey', appProxyHandler as any);
router.all('/_a/:appKey/*', appProxyHandler as any);

router.use(express.json());

// Pending sync RPC responses: id → resolve callback
const rpcPending = new Map<string, (result: { value?: string; error?: string }) => void>();

function handleRpcResult(msg: { id: string; value?: string; error?: string }): void {
  const resolve = rpcPending.get(msg.id);
  if (resolve) { rpcPending.delete(msg.id); resolve(msg); }
}

router.post('/api/rpc', (req: express.Request, res: express.Response) => {
  const { action, args, session: sid, async: isAsync, timeout: reqTimeout } = req.body as { action?: string; args?: string[]; session?: string; async?: boolean; timeout?: number };
  if (!action) { res.status(400).json({ error: 'action required' }); return; }

  /** Send an RPC message string to the appropriate targets based on session ID. */
  const sendToTargets = (msg: string): void => {
    if (sid === 'index') {
      // Target only control-only (index page) clients
      for (const ws of rpcClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    } else if (sid) {
      const session = sessions.get(sid);
      if (session) {
        for (const ws of session.peers.keys()) {
          if (ws.readyState === WebSocket.OPEN) ws.send(msg);
        }
      }
    } else {
      // Broadcast to all sessions + control clients
      for (const session of sessions.values()) {
        for (const ws of session.peers.keys()) {
          if (ws.readyState === WebSocket.OPEN) ws.send(msg);
        }
      }
      for (const ws of rpcClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    }
  };

  if (isAsync) {
    // Fire-and-forget
    sendToTargets(JSON.stringify({ type: 'rpc', action, args: args ?? [] }));
    res.json({ ok: true });
    return;
  }

  // Sync: send with id, wait for response
  const id = crypto.randomUUID();
  const rpcMsg = JSON.stringify({ type: 'rpc', id, action, args: args ?? [] });

  const timeoutMs = (typeof reqTimeout === 'number' && reqTimeout > 0) ? Math.min(reqTimeout, 300000) : 10000;
  const timeout = setTimeout(() => {
    rpcPending.delete(id);
    res.json({ error: 'timeout' });
  }, timeoutMs);

  rpcPending.set(id, (result) => {
    clearTimeout(timeout);
    res.json(result);
  });

  sendToTargets(rpcMsg);
});

router.post('/api/sessions', async (req: express.Request, res: express.Response) => {
  console.log(`[api] POST /api/sessions body=${JSON.stringify(req.body)}`);
  const skillName = (req.body?.skill as string) || '';
  const appKey = (req.body?.app as string) || (skillName ? '' : 'bash');
  const input = (req.body?.input as string) || '';
  const mode = (req.body?.mode as string) || '';
  const notify = !!req.body?.notify;
  const requestedSession = (req.body?.session as string) || '';
  const cwdOverride = (req.body?.cwd as string) || '';
  const envOverride: Record<string, string> = (req.body?.env as Record<string, string>) ?? {};
  const adHocCommand = (req.body?.command as string) || '';
  const adHocType = (req.body?.type as string) || '';
  const adHocTitle = (req.body?.title as string) || '';

  let effectiveConfig: AppConfig;
  let sessionLabel: string;  // used for the URL and session metadata

  if (adHocType === 'job' && adHocCommand) {
    // --- Ad-hoc job: raw command, no app config lookup ---
    effectiveConfig = {
      command: adHocCommand,
      type: 'job',
      title: adHocTitle || adHocCommand.slice(0, 40),
      ...(cwdOverride ? { cwd: cwdOverride } : {}),
      ...(Object.keys(envOverride).length ? { env: envOverride } : {}),
    };
    sessionLabel = appKey || 'job';
  } else if (skillName) {
    // --- Skill path: build config from _skills defaults, agent tool resolves the skill ---
    effectiveConfig = buildSkillConfig(skillName, input, mode, cwdOverride || undefined, Object.keys(envOverride).length ? envOverride : undefined);
    sessionLabel = 'skill';
  } else {
    // --- App path: lookup from apps.yaml ---
    const apps = loadApps();
    const appConfig = apps[appKey];
    if (!appConfig) { res.status(400).json({ error: `Unknown app: "${appKey}"` }); return; }

    effectiveConfig = appConfig;
    if (appConfig.skill) {
      const useInline = mode === 'inline' && appConfig.inlineCommand;
      effectiveConfig = {
        ...appConfig,
        ...(useInline ? { command: appConfig.inlineCommand! } : {}),
        env: { ...(appConfig.env ?? {}), SKILL: appConfig.skill, INPUT: input, ...(mode ? { WSH_MODE: mode } : {}) },
      };
    }

    // Apply runtime cwd/env overrides
    if (cwdOverride) effectiveConfig = { ...effectiveConfig, cwd: cwdOverride };
    if (Object.keys(envOverride).length) effectiveConfig = { ...effectiveConfig, env: { ...(effectiveConfig.env ?? {}), ...envOverride } };

    // Web apps are singletons: return existing session if one is running (unless -s forces a specific ID)
    if (appConfig.type === 'web' && !requestedSession) {
      const existing = findWebSession(appKey);
      if (existing) {
        const base = CUSTOM_URL ?? clientOrigin ?? networkBase ?? `http://localhost:${PORT}`;
        res.json({ id: existing.id, url: `${base}${BASE}${appKey}#${existing.id}` });
        return;
      }
    }
    sessionLabel = appKey;
  }

  // Use requested session ID or generate a random one
  if (requestedSession && sessions.has(requestedSession)) {
    // Kill existing session with same ID so it can be reused
    const existing = sessions.get(requestedSession)!;
    // Remove from map first so the old exit handler won't delete the new session
    sessions.delete(requestedSession);
    if (existing.cleanupTimer !== null) clearTimeout(existing.cleanupTimer);
    for (const ws of existing.peers.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Session replaced');
    }
    if (existing.child) killProcessGroup(existing.child);
    else if (existing.pty) existing.pty.kill('SIGHUP');
  }
  if (requestedSession && !isSessionId(requestedSession)) {
    res.status(400).json({ error: 'Session ID must be exactly 6 lowercase alphanumeric characters' }); return;
  }
  const id = requestedSession || crypto.randomInt(0, 2176782336).toString(36).padStart(6, '0');

  if (effectiveConfig.type === 'job') {
    try {
      spawnJobSession(id, sessionLabel, effectiveConfig);
    } catch (err) {
      console.error('Failed to spawn job:', errorMessage(err));
      res.status(500).json({ error: 'Failed to spawn session' }); return;
    }
  } else if (effectiveConfig.type === 'web') {
    try {
      await spawnWebSession(id, sessionLabel, effectiveConfig, { notify });
    } catch (err) {
      console.error('Failed to spawn web app:', errorMessage(err));
      res.status(500).json({ error: 'Failed to spawn session' }); return;
    }
  } else if (mode === 'inline' && !skillName) {
    // Defer PTY spawn until the first resize message so the PTY starts with
    // the correct terminal dimensions (avoids expensive SIGWINCH re-render).
    // Skill sessions skip deferral — start immediately so the agent boots
    // while the new tab is still loading (saves ~200-500ms to first output).
    createPendingSession(id, sessionLabel, effectiveConfig);
  } else {
    try {
      spawnSession(id, sessionLabel, effectiveConfig);
    } catch (err) {
      console.error('Failed to spawn PTY:', errorMessage(err));
      res.status(500).json({ error: 'Failed to spawn session' }); return;
    }
  }

  const base = CUSTOM_URL ?? clientOrigin ?? networkBase ?? `http://localhost:${PORT}`;
  const urlPath = skillName ? 'skill' : sessionLabel;
  res.json({ id, url: `${base}${BASE}${urlPath}#${id}` });
});

router.get('/:appName', (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const apps = loadApps();
  if (!apps[req.params.appName] && !RESERVED_PATHS.has(req.params.appName)) { next(); return; }
  // Web app singleton redirect is handled client-side via WebSocket { type: 'redirect' } message,
  // because the server cannot see the hash fragment — a server-side 302 would loop.
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

router.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, lastModified: true, maxAge: 0 }));

app.use(BASE, router);

const localServer   = http.createServer(app);
const networkServer = (tls && !NO_TLS) ? https.createServer({ key: tls.key, cert: tls.cert }, app) : null;

const wss = new WebSocketServer({ noServer: true });

function getRoleForSession(req: http.IncomingMessage, sessionId: string): Role | null {
  // Trust-proxy mode: role determined by X-WSH-User header from gateway
  if (TRUST_PROXY) {
    const xUser = req.headers['x-wsh-user'] as string | undefined;
    if (xUser === process.env.ABOX_USER || xUser === '*') return 'owner';
    // Check for shared writer token
    const url = new URL(req.url ?? '/', 'http://localhost');
    const wt = url.searchParams.get('wtoken');
    if (wt !== null && tls) return wt === writerToken(sessionId) ? 'writer' : null;
    return 'viewer';
  }
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
  ws.send(JSON.stringify({ type: 'role', role, credential, app: session.app, appType: session.appType, cwd: session.cwd, base: BASE, ...(role === 'owner' ? { pinned: session.pinned, pinnedOther } : {}) }));
}

function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  // WebSocket proxy for web apps — supports both /_p/<sessionId> and /_a/<appKey>
  let wsSessionId: string | undefined;
  let wsAppKey: string | undefined;
  let wsRest: string;
  if (url.pathname.startsWith(BASE + '_p/')) {
    wsRest = url.pathname.slice((BASE + '_p/').length);
    const slashIdx = wsRest.indexOf('/');
    wsSessionId = slashIdx >= 0 ? wsRest.slice(0, slashIdx) : wsRest;
    wsRest = slashIdx >= 0 ? wsRest.slice(slashIdx) : '';
  } else if (url.pathname.startsWith(BASE + '_a/')) {
    wsRest = url.pathname.slice((BASE + '_a/').length);
    const slashIdx = wsRest.indexOf('/');
    wsAppKey = slashIdx >= 0 ? wsRest.slice(0, slashIdx) : wsRest;
    wsRest = slashIdx >= 0 ? wsRest.slice(slashIdx) : '';
    const found = findWebSession(wsAppKey);
    if (found) wsSessionId = found.id;
  }
  if (wsSessionId || wsAppKey) {
    const wsSession = wsSessionId ? sessions.get(wsSessionId) : undefined;
    if (!wsSession || wsSession.appType !== 'web' || !wsSession.port) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    // Access control: non-public web apps require owner auth
    if (wsSession.access !== 'public') {
      if (TRUST_PROXY) {
        if (!verifyProxySecret(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
        const xUser = req.headers['x-wsh-user'] as string | undefined;
        if (xUser !== process.env.ABOX_USER && xUser !== '*') {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      } else if (token && !isLoopback(req.socket.remoteAddress)) {
        const cookies = parseCookies(req.headers.cookie ?? '');
        if (cookies['wsh_token'] !== token) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }
    }
    const target = net.connect(wsSession.port, '127.0.0.1', () => {
      const wsSuffix = (wsRest || '/') + (url.search || '');
      const stableBase = BASE + '_a/' + (wsSession.app || wsSessionId);
      const targetPath = wsSession.stripPrefix ? wsSuffix : stableBase + wsSuffix;
      let upgradeReq = `${req.method} ${targetPath} HTTP/1.1\r\n`;
      for (const [key, val] of Object.entries(req.headers)) {
        if (val) {
          upgradeReq += `${key}: ${Array.isArray(val) ? val.join(', ') : val}\r\n`;
        }
      }
      upgradeReq += '\r\n';
      target.write(upgradeReq);
      target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
    socket.on('close', () => target.destroy());
    target.on('close', () => socket.destroy());
    return;
  }

  if (url.pathname !== BASE + 'terminal') { socket.destroy(); return; }

  const sessionId = url.searchParams.get('session') ?? '';
  if (TRUST_PROXY) {
    if (!verifyProxySecret(req) || !req.headers['x-wsh-user'] || getRoleForSession(req, sessionId) === null) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  } else if (token && !isLoopback(req.socket.remoteAddress) && getRoleForSession(req, sessionId) === null) {
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

wss.on('connection', async (ws: WebSocket, req: http.IncomingMessage) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const id  = url.searchParams.get('session');

  if (!id) { console.log('[ws] rejected: no session ID'); ws.close(4000, 'session ID required'); return; }

  // Control-only connection: receives broadcast RPCs, no session needed.
  if (id === '_rpc') {
    console.log('[ws] rpc control client connected');
    rpcClients.add(ws);
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'rpc-result' && msg.id) handleRpcResult(msg);
      } catch {}
    });
    ws.on('close', () => rpcClients.delete(ws));
    return;
  }

  console.log(`[ws] connect session=${id} url=${req.url}`);

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
    // If the session has no active writer, promote even yielding owners/writers.
    const effectiveWriter = isWriter || (yields && session.writer === null);
    if (effectiveWriter) {
      if (session.writer && session.writer.readyState === WebSocket.OPEN) {
        session.writer.send(JSON.stringify({ type: 'role', role: 'viewer' }));
      }
      session.writer = ws;
      console.log(`[session ${id}] writer attached (credential: ${credential})`);
    } else {
      console.log(`[session ${id}] ${yields ? 'yielding owner' : 'viewer'} attached`);
    }
    // Store 'viewer' for yielding connections so auto-promotion on writer-disconnect skips them.
    const sentRole = (yields && !effectiveWriter) ? 'viewer' : credential;
    session.peers.set(ws, sentRole);
    sendRoleMessage(ws, id, session, sentRole, credential);
    if (session.appType === 'web' && session.ready) {
      ws.send(JSON.stringify({ type: 'ready' }));
    }
    if (session.appType === 'job' && session.child === null && session.exitCode !== undefined) {
      ws.send(JSON.stringify({ type: 'job-exit', code: session.exitCode }));
    }
    if (session.scrollback.length > 0) ws.send(stripEphemeralSequences(session.scrollback), { binary: true });
  } else {
    // reconnect=1 means "only attach to existing session, don't create a new one"
    if (url.searchParams.get('reconnect') === '1') {
      ws.close(4003, 'session not found');
      return;
    }
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
    const wsSkillName = url.searchParams.get('skill') || '';
    const apps = loadApps();
    const requestedApp = url.searchParams.get('app') || (wsSkillName ? '' : 'bash');

    // Reserved paths (e.g. "skill") are not real apps — if the session is gone,
    // don't silently fall back to bash.  Close with 4003 so the client shows
    // "Session not found" instead of spawning an unexpected shell.
    if (!wsSkillName && RESERVED_PATHS.has(requestedApp) && !apps[requestedApp]) {
      ws.close(4003, 'session not found');
      return;
    }

    let effectiveConfig: AppConfig;
    let sessionLabel: string;

    if (wsSkillName) {
      // --- Skill path: build config from _skills defaults ---
      const wsInput = url.searchParams.get('input') || '';
      const wsMode = url.searchParams.get('mode') || '';
      effectiveConfig = buildSkillConfig(wsSkillName, wsInput, wsMode);
      sessionLabel = 'skill';
    } else {
      // --- App path ---
      const appKey = apps[requestedApp] ? requestedApp : 'bash';
      const appConfig = apps[appKey];

      // Web apps are singletons: redirect to existing session if one is running
      if (appConfig.type === 'web') {
        const existing = findWebSession(appKey);
        if (existing) {
          ws.send(JSON.stringify({ type: 'redirect', session: existing.id }));
          ws.close(4100, 'redirecting to existing session');
          return;
        }
      }

      effectiveConfig = appConfig;
      if (appConfig.skill) {
        const wsInput = url.searchParams.get('input') || '';
        const wsMode = url.searchParams.get('mode') || '';
        const useInline = wsMode === 'inline' && appConfig.inlineCommand;
        effectiveConfig = {
          ...appConfig,
          ...(useInline ? { command: appConfig.inlineCommand! } : {}),
          env: { ...(appConfig.env ?? {}), SKILL: appConfig.skill, INPUT: wsInput, ...(wsMode ? { WSH_MODE: wsMode } : {}) },
        };
      }
      sessionLabel = appKey;
    }

    if (effectiveConfig.type === 'job') {
      try {
        session = spawnJobSession(id, sessionLabel, effectiveConfig);
      } catch (err) {
        console.error('Failed to spawn job:', errorMessage(err));
        ws.close(1011, 'Failed to spawn job');
        return;
      }
    } else if (effectiveConfig.type === 'web') {
      try {
        ws.send(JSON.stringify({ type: 'status', status: 'starting' }));
        session = await spawnWebSession(id, sessionLabel, effectiveConfig);
      } catch (err) {
        console.error('Failed to spawn web app:', errorMessage(err));
        ws.close(1011, 'Failed to spawn web app');
        return;
      }
    } else {
      try {
        session = spawnSession(id, sessionLabel, effectiveConfig);
      } catch (err) {
        console.error('Failed to spawn PTY:', errorMessage(err));
        ws.close(1011, 'Failed to spawn PTY');
        return;
      }
    }
    session.writer = ws;
    session.peers.set(ws, credential);
    sendRoleMessage(ws, id, session, credential, credential);
    if (session.scrollback.length > 0) ws.send(stripEphemeralSequences(session.scrollback), { binary: true });
  }

  const currentSession = session;

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (!isBinary) {
      try {
        const parsed = JSON.parse((data as Buffer).toString());
        if (parsed.type === 'origin' && typeof parsed.origin === 'string') {
          if (!clientOrigin) clientOrigin = parsed.origin.replace(/\/+$/, '');
          return;
        }
      } catch {}
    }
    if (currentSession.writer !== ws) return; // only the active writer may send input
    if (isBinary) {
      if (currentSession.appType === 'web' || currentSession.appType === 'job') return; // no PTY input for web/job sessions
      currentSession.lastInput = Date.now();
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      currentSession.pty!.write(buf.toString('binary'));
      return;
    }
    const text = (data as Buffer).toString();
    // Handle RPC result messages from browser
    try {
      const parsed = JSON.parse(text);
      if (parsed.type === 'rpc-result' && parsed.id) { handleRpcResult(parsed); return; }
    } catch {}
    const msg  = parseClientMessage(text);
    if (msg) {
      console.log(`[session ${id}] msg: ${msg.type}`, msg.type === 'resize' ? `${msg.cols}x${msg.rows}` : '');
      // Only owner can close or pin; writers can resize and clear.
      if ((msg.type === 'close' || msg.type === 'pin') && credential !== 'owner') return;
      switch (msg.type) {
        case 'resize': {
          const cols = Math.max(1, Math.min(msg.cols, 65535));
          const rows = Math.max(1, Math.min(msg.rows, 65535));
          if (currentSession.pendingConfig) {
            // Deferred spawn: first resize triggers PTY creation with correct size.
            const cfg = currentSession.pendingConfig;
            delete currentSession.pendingConfig;
            try {
              spawnPty(id, currentSession, cfg, cols, rows);
            } catch (err) {
              console.error(`[session ${id}] deferred spawn failed:`, errorMessage(err));
              ws.close(1011, 'Failed to spawn PTY');
            }
          } else if (currentSession.pty) {
            currentSession.pty.resize(cols, rows);
          }
          break;
        }
        case 'close':
          if (currentSession.child) killProcessGroup(currentSession.child);
          else if (currentSession.pty) currentSession.pty.kill('SIGHUP');
          break;
        case 'clear':
          currentSession.scrollback = Buffer.alloc(0);
          if (currentSession.pty) currentSession.pty.write('\f');
          console.log(`[session ${id}] scrollback cleared`);
          break;
        case 'pin':
          currentSession.pinned = msg.pinned;
          if (!msg.pinned && currentSession.writer === null) scheduleCleanup(id, currentSession);
          console.log(`[session ${id}] ${msg.pinned ? 'pinned (no timeout)' : 'unpinned'}`);
          for (const [peer, peerRole] of currentSession.peers) {
            if (peerRole === 'owner' && peer.readyState === WebSocket.OPEN) {
              peer.send(JSON.stringify({ type: 'pin', pinned: currentSession.pinned }));
            }
          }
          break;
      }
    } else {
      if (currentSession.pty) currentSession.pty.write(text);
    }
  });

  ws.on('close', (code: number, reason: Buffer) => {
    console.log(`[session ${id}] ws closed (code=${code} reason=${reason?.toString() || ''})`);
    clearInterval(pingTimer);
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
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
    } else if (currentSession.peers.size === 0 && currentSession.writer === null) {
      // Last viewer left and no writer — ensure cleanup is scheduled.
      scheduleCleanup(id, currentSession);
      console.log(`[session ${id}] last peer left, ${currentSession.pinned ? 'session pinned (no timeout)' : `cleanup in ${SESSION_TTL / 1000}s`}`);
    }
  });

  // Heartbeat: detect dead connections.
  // Send a ping every PING_INTERVAL. If no pong arrives within PONG_TIMEOUT
  // after a ping, terminate the connection. This tolerates slow networks
  // better than the single-interval check.
  let pongReceived = true;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  ws.on('pong', () => {
    pongReceived = true;
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  });
  const pingTimer = setInterval(() => {
    if (!pongReceived) { ws.close(4001, 'pong timeout'); return; }
    pongReceived = false;
    ws.ping();
    pongTimer = setTimeout(() => {
      if (!pongReceived) ws.close(4001, 'pong timeout');
    }, PONG_TIMEOUT);
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
// With --no-tls, always use plain HTTP (no networkServer), binding to 0.0.0.0 if requested.
const httpsOnly   = !NO_TLS && BIND_ADDR === '0.0.0.0' && !!networkServer;
const httpOnly    = NO_TLS && BIND_ADDR === '0.0.0.0';
const networkBind = httpsOnly ? '0.0.0.0' : (BIND_ADDR ?? primaryLanIP);

const localURL   = (httpsOnly ? `https` : `http`) + `://localhost:${PORT}${BASE}`;
const networkURL = NO_TLS
  ? (networkBase ? `${networkBase}${BASE}` : null)
  : (networkBase && token ? `${networkBase}${BASE}?token=${token}` : null);

let serversStarted = 0;
const totalServers = (httpsOnly || httpOnly) ? 1 : (networkServer && networkBind ? 2 : 1);

function onListening(): void {
  if (++serversStarted < totalServers) return;

  console.log('');
  console.log(`  Local:       ${localURL}`);
  if (networkURL) console.log(`  Network:     ${networkURL}`);
  if (tls && !NO_TLS) console.log(`  Fingerprint: ${new crypto.X509Certificate(tls.cert).fingerprint256}`);
  console.log(`  Version:     v${version}`);
  console.log('');

  if (!values['no-open']) openBrowser(localURL);
}

function onServerError(err: NodeJS.ErrnoException): void {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nError: Port ${PORT} is already in use.`);
    console.error(`  Kill the existing process:  lsof -ti :${PORT} | xargs kill`);
    console.error(`  Or use a different port:    wsh -p <port>\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\nError: Permission denied for port ${PORT}.`);
    console.error(`  Ports below 1024 require elevated privileges.`);
    console.error(`  Try a higher port:  wsh -p <port>\n`);
  } else if (err.code === 'EADDRNOTAVAIL') {
    console.error(`\nError: Address not available — cannot bind to the requested interface.`);
    console.error(`  Check --bind value or use 0.0.0.0 for all interfaces.\n`);
  } else {
    console.error(`\nError: Failed to start server — ${err.message}\n`);
  }
  process.exit(1);
}

localServer.on('error', onServerError);
if (networkServer) networkServer.on('error', onServerError);

console.log('Starting server...');

if (httpsOnly) {
  networkServer!.listen(PORT, '0.0.0.0', onListening);
} else if (httpOnly) {
  localServer.listen(PORT, '0.0.0.0', onListening);
} else {
  localServer.listen(PORT, '127.0.0.1', onListening);
  if (networkServer && networkBind) networkServer.listen(PORT, networkBind, onListening);
}
} // end __wshFollowMode guard
