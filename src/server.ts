import { exec, execSync, spawn, ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import readline from 'readline';
import zlib from 'zlib';
import { Duplex, Writable } from 'stream';
import { EventEmitter } from 'events';
import { parseArgs } from 'util';
import express from 'express';
import selfsigned from 'selfsigned';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import YAML from 'yaml';
import { extract as tarExtract, pack as tarPack } from 'tar-stream';
import type { Headers as TarHeaders } from 'tar-stream';
import { version } from '../package.json';
import { emit as emitEvent, on as onEvent, readSince, getCursor, setCursor, rotate as rotateEvents, trim as trimEvents, isValidEventType, LOG_FILE as EVENT_LOG_FILE, CURSOR_DIR as EVENT_CURSOR_DIR, WshEvent } from './events';
import * as metrics from './metrics';
import { agentOf, captureTokens, dropSession } from './agentTokens';
import { commandBinary } from './commandBinary';
import { loadPushIgnoreDir, compilePushIgnore, pushIgnored, PushIgnoreRule, PUSH_IGNORE_DIR as PUSH_IGNORE_DEFAULT_DIR } from './pushIgnore';
import { SyncHash, syncClassify, syncFind, syncValidReplica, syncWrite } from './syncState';
import { PUSH_TRASH_DIR, pushTrashDisplace, pushTrashRecordSize, pushTrashStamp, pushTrashSweep } from './pushTrash';
import { runPushPostfix, PUSH_POSTFIX_HOOK as PUSH_POSTFIX_DEFAULT_HOOK } from './pushPostfix';

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

/** Port file path — the server writes its port here on startup; CLI reads it for discovery. */
const PORT_FILE = path.join(os.homedir(), '.wsh', 'port');

/** Directory for persisted job scrollback logs. */
const JOB_LOG_DIR = path.join(os.homedir(), '.wsh', 'logs');
const JOB_LOG_MAX = 200; // keep at most 200 log files

/** Directory for pasted image uploads (Ctrl+V in the browser terminal). */
const PASTE_DIR = path.join(os.homedir(), '.wsh', 'paste');
const PASTE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** Remove paste-image files older than PASTE_MAX_AGE_MS. Fire-and-forget; swallows errors. */
let isSweepingPaste = false;
async function sweepPaste(): Promise<void> {
  if (isSweepingPaste) return;
  isSweepingPaste = true;
  try {
    let entries: string[];
    try { entries = await fs.promises.readdir(PASTE_DIR); }
    catch { return; }
    const cutoff = Date.now() - PASTE_MAX_AGE_MS;
    await Promise.all(entries.map(async name => {
      const full = path.join(PASTE_DIR, name);
      try {
        const st = await fs.promises.stat(full);
        if (st.isFile() && st.mtimeMs < cutoff) await fs.promises.unlink(full);
      } catch {}
    }));
  } finally {
    isSweepingPaste = false;
  }
}
fs.promises.mkdir(PASTE_DIR, { recursive: true }).catch(() => {});
sweepPaste().catch(() => {});

/** Resolve the wsh server port for CLI subcommands. Priority: --port flag > port file > 7681 default. */
function resolveServerPort(): number {
  try {
    const content = fs.readFileSync(PORT_FILE, 'utf8').trim();
    const p = parseInt(content, 10);
    if (p > 0) return p;
  } catch {}
  return 7681;
}

// --- Subcommands (handled before server startup) ---

const wantsHelp = process.argv.slice(3).includes('-h') || process.argv.slice(3).includes('--help');

function subHelp(usage: string, lines: string[] = []): never {
  console.log(usage);
  for (const l of lines) console.log(l);
  process.exit(0);
}

/** Parse a duration string (5m, 1h, 2d, today) into an absolute ms timestamp, or return raw as-is. */
function parseDuration(raw: string): string {
  const relMatch = raw.match(/^(\d+)([smhd])$/);
  if (raw === 'today') {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return String(d.getTime());
  } else if (relMatch) {
    const n = parseInt(relMatch[1], 10);
    const unit: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return String(Date.now() - n * unit[relMatch[2]]);
  }
  return raw;
}

const eventPalette = [
  117, 156, 114, 179, 174, 139, 110, 218,
  81,  150, 215, 176, 183, 109, 223, 146,
  75,  168, 209, 120, 213, 105, 167, 222,
];

function formatEvent(json: string): string {
  const event = JSON.parse(json);
  const d = new Date(event.ts);
  const time = `\x1b[37m${d.toLocaleTimeString('en-GB', { hour12: false })}\x1b[0m`;
  const type = event.type;
  const pad = Math.max(20, type.length);
  const paddedType = type + ' '.repeat(pad - type.length);
  const clean = (s: string) => s.replace(/[\n\r\t]/g, ' ');
  const trunc = (s: string, max = 80) => s.length > max ? s.slice(0, max) + '\x1b[2m…\x1b[0m' : s;
  const fields = event.data && Object.keys(event.data).length > 0
    ? Object.entries(event.data).map(([k, v]) => {
        const val = typeof v === 'number' ? `\x1b[96m${v}\x1b[0m`
          : typeof v === 'boolean' ? `\x1b[96m${v}\x1b[0m`
          : v === null ? `\x1b[2mnull\x1b[0m`
          : typeof v === 'object' ? `\x1b[2m${trunc(clean(JSON.stringify(v)))}\x1b[0m`
          : String(v) === '' ? `\x1b[2m(empty)\x1b[0m`
          : `\x1b[97m${trunc(clean(String(v)))}\x1b[0m`;
        return { raw: `\x1b[2m${k}=\x1b[0m${val}`, len: k.length + 1 + (typeof v === 'object' ? JSON.stringify(v).length : String(v).length) };
      })
    : [];
  const cols = process.stdout.columns || 120;
  const prefix = 8 + 2 + pad + 2;
  const indent = ' '.repeat(prefix);
  let sep = '';
  if (fields.length > 0) {
    let line = '';
    let lineLen = prefix;
    const lines: string[] = [];
    for (const f of fields) {
      const fieldWidth = f.len + 2;
      if (line && lineLen + fieldWidth > cols) {
        lines.push(line);
        line = f.raw;
        lineLen = prefix + f.len;
      } else {
        line = line ? line + '  ' + f.raw : f.raw;
        lineLen += (line === f.raw ? 0 : 2) + f.len;
      }
    }
    if (line) lines.push(line);
    sep = '  ' + lines.join('\n' + indent);
  }
  const lastDot = type.lastIndexOf('.');
  const ns = lastDot > 0 ? type.slice(0, lastDot) : type;
  let hash = 0;
  for (let i = 0; i < ns.length; i++) hash = ((hash << 5) - hash + ns.charCodeAt(i)) | 0;
  const color = eventPalette[Math.abs(hash) % eventPalette.length];
  return `${time}  \x1b[1;38;5;${color}m${paddedType}\x1b[0m${sep}`;
}

if (process.argv[2] === 'version') {
  if (wantsHelp) subHelp('Usage: wsh version', [
    '', 'Print the current wsh version.',
    '', 'Examples:',
    '  wsh version              # e.g. v1.19.0',
  ]);
  console.log(`v${version}`);
  process.exit(0);
} else if (process.argv[2] === 'update') {
  if (wantsHelp) subHelp('Usage: wsh update', [
    '', 'Update wsh to the latest published release.',
    '', 'Compares the current version against the latest GitHub release',
    'and installs it if newer. No-op if already up to date.',
    '', 'Examples:',
    '  wsh update               # Updating v1.18.0 → v1.19.0 ...',
  ]);
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
  if (wantsHelp) subHelp('Usage: wsh token', [
    '', 'Print the auth token derived from the TLS key.',
    'Used for authenticating browser connections to the wsh server.',
    '', 'Examples:',
    '  wsh token                # e.g. a1b2c3d4e5f67890',
    '  curl -b "wsh_token=$(wsh token)" https://localhost:7681/',
  ]);
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
    '', 'Evaluate JavaScript on connected browser clients.',
    '', 'Pages expose capabilities on window.api (e.g. api.toast,',
    'api.refreshCatalog). The code runs in the browser context and',
    'the return value is printed as JSON.',
    '', 'Options:',
    '  -p, --port <port>    Server port (default: auto from ~/.wsh/port)',
    '  --session <id>       Target a specific session (default: $WSH_SESSION)',
    '  --broadcast          Send to all connected sessions',
    '  --async              Fire-and-forget (do not wait for response)',
    '  --timeout <ms>       Response timeout in milliseconds (default: 10000)',
    '  -                    Read code from stdin instead of argument',
    '', 'Environment:',
    '  WSH_SESSION          Session ID for the RPC call (overridden by --session)',
    '', 'Examples:',
    '  wsh rpc \'api.toast("hello")\'                 # show a toast notification',
    '  wsh rpc \'api.toast({html:"<b>hi</b>"})\'      # toast with HTML content',
    '  wsh rpc --broadcast \'api.refreshCatalog()\'    # refresh all clients',
    '  wsh rpc --session index \'api.refreshCatalog()\' # refresh the catalog page',
    '  echo \'document.title\' | wsh rpc -              # read code from stdin',
  ]);
  const rpcArgs: string[] = [];
  let isAsync = false;
  let rpcTimeout: number | undefined;
  let rpcSession: string | undefined;
  let rpcBroadcast = false;
  let rpcPortOverride: number | undefined;
  for (let i = 3; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--async') isAsync = true;
    else if (a === '--timeout' && process.argv[i + 1]) rpcTimeout = parseInt(process.argv[++i], 10);
    else if (a === '--session' && process.argv[i + 1]) rpcSession = process.argv[++i];
    else if ((a === '--port' || a === '-p') && process.argv[i + 1]) rpcPortOverride = parseInt(process.argv[++i], 10);
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
  const rpcPort = rpcPortOverride ?? resolveServerPort();
  // HTTP mode: POST to the wsh server directly (bypasses stdout capture by agent tools)
  const session = rpcBroadcast ? undefined : (rpcSession ?? process.env.WSH_SESSION);
  if (!session && !rpcBroadcast) {
    console.error('wsh rpc: no target session — use --session <id>, --broadcast, or set $WSH_SESSION');
    process.exit(1);
  }
  const body = JSON.stringify({ action, args, session, ...(isAsync ? { async: true } : {}), ...(rpcTimeout ? { timeout: rpcTimeout } : {}) });
  const basePath = process.env.WSH_BASE_PATH || '/';
  try {
    const proxySecret = process.env.WSH_PROXY_SECRET;
    const aboxUser = process.env.WSH_ORIGIN_USER || '';
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
    '', 'Apps are defined in ~/.wsh/apps.yaml (or /etc/wsh/apps.yaml).',
    'Each app has a type (pty, web, or skill), a command, and optional settings.',
    '', 'Subcommands:',
    '  init    Create ~/.wsh/apps.yaml with example app definitions',
    '', 'Examples:',
    '  wsh apps                 # list all registered apps',
    '  wsh apps init            # create a starter apps.yaml',
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
#   command: jupyter lab --port=$WSH_PORT --ServerApp.base_url=$WSH_BASE_URL --no-browser
#   title: Jupyter Lab
#   icon: python
#   healthCheck: /api
#   path: /lab          # iframe opens here instead of the app's "/" root
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
    const yamlPath = path.join(dir, 'apps.yaml');
    const jsonPath = path.join(dir, 'apps.json');
    if (fs.existsSync(yamlPath)) {
      try { parsed = YAML.parse(fs.readFileSync(yamlPath, 'utf8')); } catch (err: any) {
        cliWarnings.push(`Failed to parse ${yamlPath}: ${err.message}`); return;
      }
    } else if (fs.existsSync(jsonPath)) {
      try { parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (err: any) {
        cliWarnings.push(`Failed to parse ${jsonPath}: ${err.message}`); return;
      }
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
    const title = app.title ?? path.basename(app.command.split(/\s/)[0]);
    const command = app.command;
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
  if (wantsHelp) subHelp('Usage: wsh new [options] [app-key] [input...]', [
    '', 'Create a new session and print its URL.',
    '', 'There are two ways to start a session:',
    '  1. Open a registered app by name (see "wsh apps" for available apps)',
    '  2. Run an ad-hoc command with --type and -c',
    '', 'Options:',
    '  -p, --port <port>       Server port (default: auto from ~/.wsh/port)',
    '  -s, --session <id>      Reuse a specific session ID',
    '  -c, --command <cmd>     Shell command for ad-hoc sessions (or pipe via stdin)',
    '  --type <type>           Ad-hoc session type: pty, web, or job',
    '  --title <title>         Session title shown in the catalog',
    '  --cwd <dir>             Working directory for the session',
    '  --env KEY=VALUE         Set environment variable (repeatable)',
    '  --skill <name>          Run a skill instead of an app',
    '  --notify                Show a toast on the catalog page when ready',
    '  --id-only               Print only the session ID (no URL). Implicit for --type job.',
    '  --banner                Prepend "$ cd <cwd> && <cmd>" line to job output (off by default)',
    '', 'Examples:',
    '  wsh new                              # open default shell (bash)',
    '  wsh new htop                         # open a registered app by name',
    '  wsh new --type pty -c "python3"      # run an ad-hoc pty command',
    '  wsh new --type web -c "python3 -m http.server 8080"  # ad-hoc web app',
    '  wsh new --type job -c "sleep 10"     # run a background job (prints session ID)',
    '  echo "ls -la" | wsh new --type pty    # pipe command via stdin',
    '  wsh new --env FOO=bar my-app         # pass env vars to an app',
  ]);
  const subArgs = process.argv.slice(3);

  let port = resolveServerPort();
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

  let typeFlag = '';
  const typeIdx = subArgs.findIndex(a => a === '--type');
  if (typeIdx !== -1 && subArgs[typeIdx + 1]) {
    typeFlag = subArgs[typeIdx + 1];
    subArgs.splice(typeIdx, 2);
  }

  let commandFlag = '';
  const commandIdx = subArgs.findIndex(a => a === '--command' || a === '-c');
  if (commandIdx !== -1 && subArgs[commandIdx + 1]) {
    commandFlag = subArgs[commandIdx + 1];
    subArgs.splice(commandIdx, 2);
  }

  let titleFlag = '';
  const titleIdx = subArgs.findIndex(a => a === '--title');
  if (titleIdx !== -1 && subArgs[titleIdx + 1]) {
    titleFlag = subArgs[titleIdx + 1];
    subArgs.splice(titleIdx, 2);
  }

  const idOnly = subArgs.includes('--id-only');
  if (idOnly) subArgs.splice(subArgs.indexOf('--id-only'), 1);

  const banner = subArgs.includes('--banner');
  if (banner) subArgs.splice(subArgs.indexOf('--banner'), 1);
  // --no-banner accepted for backwards compatibility (now the default — silently consumed).
  while (subArgs.includes('--no-banner')) subArgs.splice(subArgs.indexOf('--no-banner'), 1);

  const notifyIdx = subArgs.indexOf('--notify');
  const notify = notifyIdx !== -1;
  if (notifyIdx !== -1) subArgs.splice(notifyIdx, 1);
  const positionalArgs = subArgs.filter(a => !a.startsWith('-'));

  // Ad-hoc mode: --type or --command present → first positional is the command (shell expression)
  const adHocMode = !!(typeFlag || commandFlag);
  let appKey: string;
  let input: string;
  if (adHocMode) {
    if (positionalArgs.length) {
      console.error(`Error: Unexpected positional arguments in ad-hoc mode: ${positionalArgs.join(' ')}. Use -c/--command or stdin.`);
      process.exit(1);
    }
    if (!commandFlag && !process.stdin.isTTY) {
      try { commandFlag = fs.readFileSync(0, 'utf8').trim(); } catch {}
    }
    if (!commandFlag) {
      console.error('Error: No command provided. Use -c/--command or pipe via stdin.');
      process.exit(1);
    }
    appKey = '';
    input = '';
  } else {
    appKey = positionalArgs[0] || (skillFlag ? '' : 'bash');
    if (!skillFlag && positionalArgs.length > 1) {
      console.error(`Error: Unexpected arguments: ${positionalArgs.slice(1).join(' ')}. Quote the command if it contains spaces.`);
      process.exit(1);
    }
    input = skillFlag ? positionalArgs.join(' ') : '';
  }
  let basePath = process.env.WSH_BASE_PATH || '/';
  if (!basePath.startsWith('/')) basePath = '/' + basePath;
  if (!basePath.endsWith('/')) basePath += '/';
  const aboxUser = process.env.WSH_ORIGIN_USER || '';
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
  if (typeFlag) payload.type = typeFlag;
  if (commandFlag) payload.command = commandFlag;
  if (titleFlag) payload.title = titleFlag;
  if (banner) payload.banner = true;
  const jsonData = JSON.stringify(payload);
  let lastErr: any;
  for (const scheme of ['http', 'https'] as const) {
    const url = `${scheme}://127.0.0.1:${port}${basePath}api/sessions`;
    const flags = scheme === 'https' ? '-sSk' : '-sS';
    try {
      const body = execSync(
        `curl ${flags} ${userHeader} -X POST -H 'Content-Type: application/json' -d @- -w '\\n%{http_code}' '${url}'`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input: jsonData },
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
      // Jobs default to id-only output: their URL points to a terminal page that
      // can't attach (jobs reject WebSocket). Use `wsh logs -f <id>` to follow.
      if (idOnly || typeFlag === 'job') {
        console.log(parsed.id);
      } else if (process.env.WSH_URL) {
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
  if (wantsHelp) subHelp('Usage: wsh logs [-f] [--type job|web] <session-id | app-name>', [
    '', 'Print session output (stdout/stderr).',
    '', 'Defaults to job mode: target is treated as a verbatim session ID and',
    'the log is read from disk (works during and after the job, survives',
    'wsh-server restarts). Use --type web for live web-app sessions; the',
    'target may then be an app name and the in-memory scrollback is returned.',
    '', 'Options:',
    '  -p, --port <port>  Server port (default: auto from ~/.wsh/port)',
    '  -f, --follow       Stream new output in real time (like tail -f)',
    '  --type <type>      Session type: job (default) or web',
    '', 'Examples:',
    '  wsh logs abc123                    # job log (one-shot)',
    '  wsh logs -f abc123                 # follow job log',
    '  wsh logs --type web my-app         # web app scrollback by name',
    '  wsh logs -f --type web my-app      # follow live web app output',
  ]);
  const subArgs = process.argv.slice(3);

  let port = resolveServerPort();
  const portIdx = subArgs.findIndex(a => a === '--port' || a === '-p');
  if (portIdx !== -1 && subArgs[portIdx + 1]) {
    port = parseInt(subArgs[portIdx + 1], 10);
    subArgs.splice(portIdx, 2);
  }

  const followIdx = subArgs.findIndex(a => a === '--follow' || a === '-f');
  const follow = followIdx !== -1;
  if (followIdx !== -1) subArgs.splice(followIdx, 1);

  let typeFlag: 'job' | 'web' = 'job';
  const typeIdx = subArgs.findIndex(a => a === '--type');
  if (typeIdx !== -1 && subArgs[typeIdx + 1]) {
    const v = subArgs[typeIdx + 1];
    if (v !== 'job' && v !== 'web') { console.error(`Error: --type must be "job" or "web", got "${v}".`); process.exit(1); }
    typeFlag = v;
    subArgs.splice(typeIdx, 2);
  }

  const target = subArgs.find(a => !a.startsWith('-'));
  if (!target) { console.error('Usage: wsh logs [-f] [--type job|web] <session-id | app-name>'); process.exit(1); }

  let basePath = process.env.WSH_BASE_PATH || '/';
  if (!basePath.startsWith('/')) basePath = '/' + basePath;
  if (!basePath.endsWith('/')) basePath += '/';

  const aboxUser = process.env.WSH_ORIGIN_USER || '';
  const proxySecret = process.env.WSH_PROXY_SECRET;
  let userHeader = '';
  if (proxySecret) userHeader += ` -H 'X-WSH-Proxy-Secret: ${proxySecret}'`;
  if (aboxUser) userHeader += ` -H 'X-WSH-User: ${aboxUser}'`;

  // Resolve target to a session ID. Job mode: skip the /api/sessions roundtrip
  // — the disk log is the canonical source and the target is taken verbatim.
  // Web mode: query /api/sessions and match by id, app name, or partial match.
  function resolveSession(): string {
    if (typeFlag === 'job') return target!;
    for (const scheme of ['http', 'https'] as const) {
      const url = `${scheme}://127.0.0.1:${port}${basePath}api/sessions`;
      const flags = scheme === 'https' ? '-sSk' : '-sS';
      try {
        const body = execSync(`curl ${flags} ${userHeader} '${url}'`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        const data = JSON.parse(body) as { sessions: { id: string; app: string; appType?: 'pty' | 'web' | 'job' }[] };
        if (isSessionId(target!)) {
          const byId = data.sessions.find(s => s.id === target);
          if (byId) return byId.id;
          console.error(`No session found for "${target}".`);
          process.exit(1);
        }
        const byApp = data.sessions.filter(s => s.app === target);
        if (byApp.length > 0) return byApp[byApp.length - 1].id;
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
  const sessionId = resolveSession();

  if (!follow) {
    // One-shot: GET /api/sessions/:id/logs. Job: reads disk file. Web: returns
    // in-memory scrollback (bounded by MAX_SCROLLBACK).
    let lastErr: any;
    for (const scheme of ['http', 'https'] as const) {
      const url = `${scheme}://127.0.0.1:${port}${basePath}api/sessions/${sessionId}/logs`;
      const flags = scheme === 'https' ? '-sSk' : '-sS';
      try {
        const result = execSync(`curl ${flags} ${userHeader} -w '\\n%{http_code}' '${url}'`, { stdio: ['pipe', 'pipe', 'pipe'] });
        const raw = result.toString('utf8');
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
    // Follow: SSE from /api/sessions/:id/stream. Server dispatches by live
    // appType — job sessions tail the disk log, pty/web sessions get a
    // fake-peer feed of scrollback + live output (control messages stripped).
    function tryConnectSse(scheme: 'http' | 'https'): void {
      const lib = scheme === 'https' ? https : http;
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (proxySecret) headers['X-WSH-Proxy-Secret'] = proxySecret;
      if (aboxUser) headers['X-WSH-User'] = aboxUser;
      const reqOpts = { host: '127.0.0.1', port, path: `${basePath}api/sessions/${sessionId}/stream`, headers, rejectUnauthorized: false } as any;
      const sseReq = lib.get(reqOpts, (res) => {
        if (res.statusCode === 404) { console.error(`Session "${sessionId}" not found.`); process.exit(1); }
        if ((res.statusCode ?? 0) >= 400) { console.error(`Error: server returned ${res.statusCode}`); process.exit(1); }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
            if (!dataLine) continue;
            if (dataLine === '[DONE]') { process.exit(0); }
            try {
              const parsed = JSON.parse(dataLine);
              if (typeof parsed.text === 'string') process.stdout.write(parsed.text);
              // exit field is informational; [DONE] follows and triggers process.exit
            } catch {}
          }
        });
        res.on('end', () => process.exit(0));
        res.on('error', () => process.exit(0));
      });
      sseReq.on('error', (err: NodeJS.ErrnoException) => {
        if (scheme === 'http') { tryConnectSse('https'); return; }
        if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
          console.error(`No wsh server running on localhost:${port}`);
        } else {
          console.error('Error:', err.message);
        }
        process.exit(1);
      });
      process.on('SIGINT', () => { sseReq.destroy(); process.exit(0); });
      process.on('SIGTERM', () => { sseReq.destroy(); process.exit(0); });
    }
    tryConnectSse('http');
    (globalThis as any).__wshFollowMode = true;
  }
} else if (process.argv[2] === 'exitcode') {
  const sid = process.argv[3];
  if (!sid || wantsHelp) subHelp('Usage: wsh exitcode <session-id>', [
    '', 'Print the exit code of a finished job session.',
    '', 'Returns the exit code of the process that ran in the session.',
    'Exits with code 1 if the session is not found or still running.',
    '', 'Examples:',
    '  wsh exitcode abc123         # e.g. 0',
    '  wsh exitcode abc123 && echo "success"',
  ]);
  const port = resolveServerPort();
  let basePath = process.env.WSH_BASE_PATH || '/';
  if (!basePath.startsWith('/')) basePath = '/' + basePath;
  if (!basePath.endsWith('/')) basePath += '/';
  const aboxUser = process.env.WSH_ORIGIN_USER || '';
  const proxySecret = process.env.WSH_PROXY_SECRET;
  let userHeader = '';
  if (proxySecret) userHeader += ` -H 'X-WSH-Proxy-Secret: ${proxySecret}'`;
  if (aboxUser) userHeader += ` -H 'X-WSH-User: ${aboxUser}'`;
  let lastErr: any;
  for (const scheme of ['http', 'https'] as const) {
    const url = `${scheme}://127.0.0.1:${port}${basePath}api/sessions/${sid}/exit`;
    const flags = scheme === 'https' ? '-sSk' : '-sS';
    try {
      const result = execSync(`curl ${flags} ${userHeader} -w '\\n%{http_code}' '${url}'`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const lines = result.trimEnd().split('\n');
      const httpCode = parseInt(lines.pop()!, 10);
      const body = lines.join('\n');
      if (httpCode === 404) process.exit(1);
      if (httpCode >= 400) { console.error(`Error: server returned ${httpCode}`); process.exit(1); }
      const parsed = JSON.parse(body);
      console.log(parsed.code);
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
} else if (process.argv[2] === 'ls' || process.argv[2] === 'kill' || process.argv[2] === 'port') {
  const subcommand = process.argv[2];
  if (wantsHelp) {
    if (subcommand === 'ls') subHelp('Usage: wsh ls [--all] [-p <port>]', [
      '', 'List active sessions with their ID, type, app, and status.',
      'Idle daemon web apps are hidden by default — use --all to include them.',
      '', 'Options:',
      '  --all              Include idle daemon sessions (normally hidden)',
      '  -p, --port <port>  Server port (default: auto from ~/.wsh/port)',
      '', 'Examples:',
      '  wsh ls                     # list active sessions',
      '  wsh ls --all               # include idle daemons',
      '  wsh ls | grep web          # filter web app sessions',
    ]);
    else if (subcommand === 'port') subHelp('Usage: wsh port <app>', [
      '', 'Print the local port of a running web app.',
      '', 'Useful for connecting to a web app from other processes.',
      '', 'Options:',
      '  -p, --port <port>  Server port (default: auto from ~/.wsh/port)',
      '', 'Examples:',
      '  wsh port jupyter           # e.g. 38421',
      '  curl http://localhost:$(wsh port my-app)/api/health',
    ]);
    else subHelp('Usage: wsh kill <session-id>', [
      '', 'Close a session by ID.',
      '', 'Sends SIGHUP to the session process and removes it from the catalog.',
      '', 'Options:',
      '  -p, --port <port>  Server port (default: auto from ~/.wsh/port)',
      '', 'Examples:',
      '  wsh kill abc123            # close a specific session',
      '  wsh ls                     # find the session ID first',
    ]);
  }
  const subArgs = process.argv.slice(3);

  // Parse --port / -p, fallback to ~/.wsh/port file, then default 7681
  let port = resolveServerPort();
  const portIdx = subArgs.findIndex(a => a === '--port' || a === '-p');
  if (portIdx !== -1 && subArgs[portIdx + 1]) {
    port = parseInt(subArgs[portIdx + 1], 10);
    subArgs.splice(portIdx, 2);
  }

  let basePath = process.env.WSH_BASE_PATH || '/';
  if (!basePath.startsWith('/')) basePath = '/' + basePath;
  if (!basePath.endsWith('/')) basePath += '/';

  const aboxUser = process.env.WSH_ORIGIN_USER || '';
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
    const all = subArgs.includes('--all');
    const { body } = curlRequest('GET', basePath + 'api/sessions' + (all ? '?all=1' : ''));
    const data = JSON.parse(body) as { sessions: any[] };
    if (json) { console.log(JSON.stringify(data, null, 2)); process.exit(0); }
    if (data.sessions.length === 0) { console.log('No active sessions.'); process.exit(0); }

    const now = Date.now();
    const base = (s: any) => [
      s.id, s.app ?? '', s.appType ?? 'pty', s.title, s.createdBy || '-', s.pinned ? 'yes' : 'no', String(s.peers), s.hasWriter ? 'yes' : 'no',
      formatDuration(now - s.createdAt),
    ];
    const headers = extended
      ? ['ID', 'APP', 'TYPE', 'TITLE', 'USER', 'PINNED', 'PEERS', 'WRITER', 'UPTIME', 'IN', 'OUT', 'PID', 'SIZE', 'PROCESS']
      : ['ID', 'APP', 'TYPE', 'TITLE', 'USER', 'PINNED', 'PEERS', 'WRITER', 'UPTIME', 'IDLE'];
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
    // ?all=1 so a targeted port lookup also finds idle daemons (hidden by default).
    const { body } = curlRequest('GET', basePath + 'api/sessions?all=1');
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

// --- wsh emit ---
} else if (process.argv[2] === 'emit') {
  if (wantsHelp) subHelp('Usage: wsh emit [options] <type> [key=value... | -]', [
    '', 'Emit an event to the event bus.',
    '', 'Events have a type (namespace.action, e.g. "deploy.done") and optional',
    'data fields. System events use "sys.*" with three levels (e.g.',
    '"sys.session.opened"); user events use two. Data can be passed as',
    'key=value args or JSON via stdin with "-".',
    'Values are auto-parsed: numbers, booleans, and JSON are converted;',
    'everything else is stored as a string.',
    '', 'Options:',
    '  -p, --port <port>  Server port (default: auto from ~/.wsh/port)',
    '  -q, --quiet        Suppress output (exit code only)',
    '  --json             Output raw JSON instead of pretty format',
    '  -                  Read data as JSON from stdin',
    '', 'Examples:',
    '  wsh emit deploy.done                           # pretty confirmation',
    '  wsh emit deploy.done env=prod duration=12      # key=value data',
    '  wsh emit job.fail exitCode=1 name=test         # numbers auto-parsed',
    '  wsh emit app.flag active=true                  # booleans auto-parsed',
    '  wsh emit test.done \'results=[1,2,3]\'             # JSON values auto-parsed',
    '  wsh emit deploy.done env=prod --json           # raw JSON output',
    '  wsh emit deploy.done -q                        # silent (for scripts)',
    '', '  # Read data from stdin with "-":',
    '  echo \'{"results":[1,2,3]}\' | wsh emit job.completed -',
    '  curl -s api/status | wsh emit health.check -',
  ]);
  const subArgs = process.argv.slice(3);

  let port = resolveServerPort();
  const portIdx = subArgs.findIndex(a => a === '--port' || a === '-p');
  if (portIdx !== -1 && subArgs[portIdx + 1]) {
    port = parseInt(subArgs[portIdx + 1], 10);
    subArgs.splice(portIdx, 2);
  }

  const jsonIdx = subArgs.indexOf('--json');
  const printJson = jsonIdx !== -1;
  if (jsonIdx !== -1) subArgs.splice(jsonIdx, 1);

  const quietIdx = subArgs.findIndex(a => a === '--quiet' || a === '-q');
  const quiet = quietIdx !== -1;
  if (quietIdx !== -1) subArgs.splice(quietIdx, 1);

  const eventType = subArgs.find(a => !a.startsWith('-'));
  if (!eventType) { console.error('Usage: wsh emit <type> [key=value...]'); process.exit(1); }
  subArgs.splice(subArgs.indexOf(eventType), 1);
  if (!isValidEventType(eventType)) {
    console.error(`wsh emit: invalid type "${eventType}" — must be lowercase, 2-4 dot-separated segments (e.g. "deploy.done")`);
    process.exit(1);
  }

  // Build data from key=value args, or read JSON from stdin with "-"
  let data: Record<string, any> | undefined;
  const stdinIdx = subArgs.indexOf('-');
  if (stdinIdx !== -1) {
    subArgs.splice(stdinIdx, 1);
    try {
      const input = fs.readFileSync(0, 'utf8').trim();
      if (input) data = JSON.parse(input);
    } catch (err: any) {
      console.error('wsh emit: invalid JSON on stdin —', err.message);
      process.exit(1);
    }
  } else if (subArgs.length > 0) {
    // key=value mode
    data = {};
    for (const arg of subArgs) {
      const eq = arg.indexOf('=');
      if (eq === -1) { console.error(`wsh emit: invalid argument "${arg}" — data must be key=value (e.g. msg=${arg})`); process.exit(1); }
      const key = arg.slice(0, eq);
      const raw = arg.slice(eq + 1);
      // Try to parse as number/boolean/JSON, fall back to string
      try { data[key] = JSON.parse(raw); } catch { data[key] = raw; }
    }
  }

  let basePath = process.env.WSH_BASE_PATH || '/';
  if (!basePath.startsWith('/')) basePath = '/' + basePath;
  if (!basePath.endsWith('/')) basePath += '/';

  const proxySecret = process.env.WSH_PROXY_SECRET;
  const aboxUser = process.env.WSH_ORIGIN_USER || '';
  let headers = "-H 'Content-Type: application/json'";
  if (proxySecret) headers += ` -H 'X-WSH-Proxy-Secret: ${proxySecret}'`;
  if (aboxUser) headers += ` -H 'X-WSH-User: ${aboxUser}'`;

  const body = JSON.stringify({ type: eventType, ...(data !== undefined && { data }) });
  const escapedBody = body.replace(/'/g, "'\\''");
  try {
    let response: string;
    try {
      response = execSync(`curl -sS -X POST ${headers} -d '${escapedBody}' 'http://127.0.0.1:${port}${basePath}api/events'`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      response = execSync(`curl -sSk -X POST ${headers} -d '${escapedBody}' 'https://127.0.0.1:${port}${basePath}api/events'`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    }
    const result = response.trim();
    if (printJson) console.log(result);
    else if (!quiet) try { console.log(formatEvent(result)); } catch { console.log(result); }
  } catch (err: any) {
    console.error('wsh emit: failed —', err.stderr?.toString().trim() || err.message);
    process.exit(1);
  }
  process.exit(0);

// --- wsh events ---
} else if (process.argv[2] === 'events') {
  if (wantsHelp) subHelp('Usage: wsh events [--filter <prefix>] [--since <when>] [--exec <cmd>] [--json]', [
    '', 'Subscribe to events from the event bus.',
    '', 'By default, shows only new events in a pretty format. Event types',
    'follow a namespace.action convention (e.g. "deploy.done"); system',
    'events use "sys.*" with three levels (e.g. "sys.session.opened").',
    'Use --since to replay past events, --exec to run a handler, or',
    '--json for raw output.',
    '', 'Options:',
    '  -p, --port <port>    Server port (default: auto from ~/.wsh/port)',
    '  --filter <pattern>   Filter by type prefix, comma-separated, "!" to exclude',
    '                         e.g. "deploy.*", "deploy.*,job.*", "!sys.*"',
    '  --since <when>       Replay past events:',
    '                         5m, 30m, 1h, 2d  — relative (minutes, hours, days)',
    '                         today             — since midnight',
    '                         0                 — all events',
    '  --name <cursor>      Named consumer with tracked cursor; resumes from',
    '                       where it left off. One consumer per name (--force to take over)',
    '  --force              Take over a named consumer from another process',
    '  --exec <cmd>         Run a shell command for each event',
    '  --json               Output raw JSON lines (for piping to jq, etc.)',
    '  --types              List unique event types from the log (with last example)',
    '  --consumers          List named consumers with status and last event time',
    '', 'Exec mode — environment variables available in --exec commands:',
    '  $EVENT               Full event JSON string',
    '  $EVENT_TYPE          Event type (e.g. "deploy.done")',
    '  $EVENT_TS            Event timestamp in milliseconds',
    '  $<key>               Each top-level data field (e.g. $status, $exitCode)',
    '', 'Examples:',
    '  wsh events                              # pretty live monitor',
    '  wsh events --since 1h                   # replay last hour + live',
    '  wsh events --since 0                    # replay everything + live',
    '  wsh events --filter \'deploy.*\'           # only deploy events',
    '  wsh events --filter \'!sys.*\'            # user events only (exclude system)',
    '  wsh events --filter \'deploy.*,job.*\'    # multiple prefixes',
    '  wsh events --json | jq .type            # pipe JSON to jq',
    '', '  # Run a handler for each event:',
    '  wsh events --exec \'echo "$EVENT_TYPE: status=$status"\'',
    '', '  # Conditional handler:',
    '  wsh events --filter \'job.*\' --exec \'if [ "$exitCode" != "0" ]; then echo "FAIL: $name"; fi\'',
    '', '  # Resumable consumer (picks up where it left off):',
    '  wsh events --name my-bot --exec \'python3 handle.py\'',
    '', '  # Forward events to a webhook:',
    '  wsh events --exec \'curl -s -d "$EVENT" http://example.com/webhook\'',
  ]);
  const subArgs = process.argv.slice(3);

  let port = resolveServerPort();
  const portIdx = subArgs.findIndex(a => a === '--port' || a === '-p');
  if (portIdx !== -1 && subArgs[portIdx + 1]) {
    port = parseInt(subArgs[portIdx + 1], 10);
    subArgs.splice(portIdx, 2);
  }

  let filter = '';
  const filterIdx = subArgs.indexOf('--filter');
  if (filterIdx !== -1 && subArgs[filterIdx + 1]) {
    filter = subArgs[filterIdx + 1];
    subArgs.splice(filterIdx, 2);
  }

  let name = '';
  const nameIdx = subArgs.indexOf('--name');
  if (nameIdx !== -1 && subArgs[nameIdx + 1]) {
    name = subArgs[nameIdx + 1];
    subArgs.splice(nameIdx, 2);
  }

  let since = '';
  const sinceIdx = subArgs.indexOf('--since');
  if (sinceIdx !== -1 && subArgs[sinceIdx + 1]) {
    since = parseDuration(subArgs[sinceIdx + 1]);
    subArgs.splice(sinceIdx, 2);
  }

  let execCmd = '';
  const execIdx = subArgs.indexOf('--exec');
  if (execIdx !== -1 && subArgs[execIdx + 1]) {
    execCmd = subArgs[execIdx + 1];
    subArgs.splice(execIdx, 2);
  }

  const typesIdx = subArgs.indexOf('--types');
  if (typesIdx !== -1) {
    // Show unique event types from the log (most recent of each)
    if (!fs.existsSync(EVENT_LOG_FILE)) { process.exit(0); }
    const lines = fs.readFileSync(EVENT_LOG_FILE, 'utf8').split('\n').filter(Boolean);
    const latest = new Map<string, string>(); // type → json line
    for (const line of lines) {
      try { const e = JSON.parse(line); latest.set(e.type, line); } catch {}
    }
    const sorted = [...latest.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [, json] of sorted) {
      try { console.log(formatEvent(json)); } catch { console.log(json); }
    }
    process.exit(0);
  }

  const consumersIdx = subArgs.indexOf('--consumers');
  if (consumersIdx !== -1) {
    if (!fs.existsSync(EVENT_CURSOR_DIR)) { process.exit(0); }
    const files = fs.readdirSync(EVENT_CURSOR_DIR).filter(f => !f.endsWith('.pid'));
    if (files.length === 0) { process.exit(0); }
    // Header
    const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
    const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
    const green = (s: string) => `\x1b[92m${s}\x1b[0m`;
    const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
    const cyan = (s: string) => `\x1b[96m${s}\x1b[0m`;
    const maxName = Math.max(20, ...files.map(f => f.length));
    console.log(`${bold('NAME'.padEnd(maxName))}  ${bold('STATUS')}    ${bold('LAST EVENT')}`);
    for (const name of files.sort()) {
      const cursorTs = parseInt(fs.readFileSync(path.join(EVENT_CURSOR_DIR, name), 'utf8').trim(), 10) || 0;
      const pidPath = path.join(EVENT_CURSOR_DIR, name + '.pid');
      let active = false;
      try {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
        process.kill(pid, 0); // check alive
        active = true;
      } catch {}
      const status = active ? green('active ') : dim('stopped');
      const time = cursorTs ? cyan(new Date(cursorTs).toLocaleTimeString('en-GB', { hour12: false })) : dim('never');
      console.log(`${yellow(name.padEnd(maxName))}  ${status}   ${time}`);
    }
    process.exit(0);
  }

  const forceIdx = subArgs.indexOf('--force');
  const force = forceIdx !== -1;
  if (forceIdx !== -1) subArgs.splice(forceIdx, 1);

  const jsonIdx = subArgs.indexOf('--json');
  const forceJson = jsonIdx !== -1;
  if (forceJson) subArgs.splice(jsonIdx, 1);
  const pretty = !forceJson && !execCmd;

  // Named consumer: enforce single consumer per name
  const pidFile = name ? path.join(EVENT_CURSOR_DIR, name + '.pid') : '';
  if (name) {
    fs.mkdirSync(EVENT_CURSOR_DIR, { recursive: true });
    try {
      const oldPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try { process.kill(oldPid, 0); // check if alive
          if (force) {
            process.kill(oldPid, 'SIGTERM');
            console.error(`[wsh events] killed previous consumer "${name}" (pid ${oldPid})`);
          } else {
            console.error(`wsh events: consumer "${name}" is already active (pid ${oldPid}). Use --force to take over.`);
            process.exit(1);
          }
        } catch {} // pid not running, stale file — fine
      }
    } catch {} // no pid file — fine
    fs.writeFileSync(pidFile, String(process.pid));
    const cleanup = () => { try { fs.unlinkSync(pidFile); } catch {} };
    process.on('exit', cleanup);
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
  }

  let basePath = process.env.WSH_BASE_PATH || '/';
  if (!basePath.startsWith('/')) basePath = '/' + basePath;
  if (!basePath.endsWith('/')) basePath += '/';

  const proxySecret = process.env.WSH_PROXY_SECRET;
  const aboxUser = process.env.WSH_ORIGIN_USER || '';

  // Build SSE URL
  const clientAck = !!(name && execCmd);
  const params = new URLSearchParams();
  if (filter) params.set('filter', filter);
  if (name) params.set('name', name);
  if (since) params.set('since', since);
  if (clientAck) params.set('ack', 'client');
  const qs = params.toString() ? '?' + params.toString() : '';

  // Stream SSE via curl
  const curlHeaders: string[] = [];
  if (proxySecret) curlHeaders.push('-H', `X-WSH-Proxy-Secret: ${proxySecret}`);
  if (aboxUser) curlHeaders.push('-H', `X-WSH-User: ${aboxUser}`);

  function tryConnect(scheme: 'http' | 'https'): void {
    const url = `${scheme}://127.0.0.1:${port}${basePath}api/events${qs}`;
    const flags = scheme === 'https' ? ['-sSk', '-N'] : ['-sS', '-N'];
    let opened = false;
    const curl = spawn('curl', [...flags, ...curlHeaders, url], { stdio: ['pipe', 'pipe', 'pipe'] });

    let buf = '';
    curl.stdout.on('data', (chunk: Buffer) => {
      opened = true;
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop()!; // keep incomplete line
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6);
        if (execCmd) {
          // Exec mode: spawn handler with env vars
          try {
            const event = JSON.parse(json);
            const env: Record<string, string> = {
              ...process.env,
              EVENT: json,
              EVENT_TYPE: event.type,
              EVENT_TS: String(event.ts),
            };
            // Flatten data fields
            if (event.data && typeof event.data === 'object') {
              for (const [k, v] of Object.entries(event.data)) {
                if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                  env[k] = String(v);
                }
              }
            }
            // Replace {} placeholder with event JSON
            const cmd = execCmd.includes('{}') ? execCmd.replace(/\{\}/g, json.replace(/'/g, "'\\''")) : execCmd;
            try {
              execSync(cmd, { env, stdio: 'inherit', shell: '/bin/sh' });
              // Client-side ack: write cursor after successful exec
              if (clientAck) {
                setCursor(name, event.ts);
              }
            } catch (err: any) {
              console.error(`[wsh events] exec failed (exit ${err.status}): ${cmd}`);
            }
          } catch {}
        } else if (pretty) {
          try { console.log(formatEvent(json)); } catch { console.log(json); }
        } else {
          // Stream mode: print JSON line
          console.log(json);
        }
      }
    });

    curl.on('close', (code) => {
      if (!opened && scheme === 'http') { tryConnect('https'); return; }
      if (!opened) { console.error(`No wsh server running on localhost:${port}`); process.exit(1); }
      process.exit(code ?? 0);
    });
    curl.on('error', () => {
      if (!opened && scheme === 'http') { tryConnect('https'); return; }
      if (!opened) { console.error(`No wsh server running on localhost:${port}`); process.exit(1); }
      process.exit(1);
    });

    process.on('SIGINT', () => { curl.kill(); process.exit(0); });
    process.on('SIGTERM', () => { curl.kill(); process.exit(0); });
  }
  tryConnect('http');
  (globalThis as any).__wshFollowMode = true;

// --- wsh gc ---
} else if (process.argv[2] === 'gc') {
  if (wantsHelp) subHelp('Usage: wsh gc <target> [options]', [
    '', 'Clean up old data.',
    '', 'Targets:',
    '  events    Trim event log (default: keep last 10,000)',
    '', 'Options (events):',
    '  --keep <N|duration>  Keep last N events or events within duration',
    '                       Duration: 5m, 1h, 2d, today',
    '', 'Examples:',
    '  wsh gc events              # trim to default 10k',
    '  wsh gc events --keep 500   # keep last 500',
    '  wsh gc events --keep 1h    # keep last hour',
  ]);
  const subArgs = process.argv.slice(3);
  const target = subArgs.find(a => !a.startsWith('-'));
  if (!target || target !== 'events') {
    console.error(target ? `wsh gc: unknown target "${target}"` : 'wsh gc: target required (e.g. "wsh gc events")');
    process.exit(1);
  }
  subArgs.splice(subArgs.indexOf(target), 1);

  let keep: { count?: number; sinceTs?: number } | undefined;
  const keepIdx = subArgs.indexOf('--keep');
  if (keepIdx !== -1 && subArgs[keepIdx + 1]) {
    const raw = subArgs[keepIdx + 1];
    if (/^\d+$/.test(raw)) {
      keep = { count: parseInt(raw, 10) };
    } else {
      const ts = parseInt(parseDuration(raw), 10);
      if (isNaN(ts)) { console.error(`wsh gc: invalid --keep value "${raw}"`); process.exit(1); }
      keep = { sinceTs: ts };
    }
  }

  const removed = trimEvents(keep);
  if (removed === 0) {
    console.log('events: nothing to remove');
  } else {
    console.log(`events: removed ${removed.toLocaleString()} entries`);
  }
  process.exit(0);
} else if (process.argv[2] === 'goto') {
  if (wantsHelp) subHelp('Usage: wsh goto <host:port> -p <listen-port>', [
    '', 'Transparently forward all TCP traffic from a local port to another address.',
    'Raw byte forwarding — HTTP and WebSocket pass through unchanged.',
    '', 'Intended for static-port web apps: front a server that is already listening',
    'on a fixed local port with the port wsh assigns ($WSH_PORT), e.g. in apps.yaml:',
    '  command: wsh goto localhost:8080 -p $WSH_PORT',
    '', 'Options:',
    '  -p, --port <port>  Local port to listen on (required)',
    '', 'Examples:',
    '  wsh goto localhost:8080 -p 12345   # forward 127.0.0.1:12345 -> localhost:8080',
    '  wsh goto 3000 -p 12345             # bare port -> 127.0.0.1:3000',
  ]);
  const subArgs = process.argv.slice(3);

  // Listen port from -p/--port (required).
  let listenPort = NaN;
  const pIdx = subArgs.findIndex(a => a === '-p' || a === '--port');
  if (pIdx !== -1 && subArgs[pIdx + 1]) {
    listenPort = parseInt(subArgs[pIdx + 1], 10);
    subArgs.splice(pIdx, 2);
  }
  // Target host:port — first remaining positional. Split on the last ':' so
  // IPv6-less host:port works; a bare number means 127.0.0.1.
  const target = subArgs.find(a => !a.startsWith('-')) || '';
  if (!target || isNaN(listenPort) || listenPort <= 0) {
    console.error('Usage: wsh goto <host:port> -p <listen-port>');
    process.exit(1);
  }
  const colon = target.lastIndexOf(':');
  const targetHost = colon > 0 ? target.slice(0, colon) : '127.0.0.1';
  const targetPort = parseInt(colon > 0 ? target.slice(colon + 1) : target, 10);
  if (isNaN(targetPort) || targetPort <= 0) {
    console.error(`wsh goto: invalid target "${target}"`);
    process.exit(1);
  }

  const proxy = net.createServer((client) => {
    const upstream = net.connect(targetPort, targetHost);
    // Tear down the peer on any error or close so neither socket lingers.
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  proxy.on('error', (err: any) => {
    console.error(`wsh goto: ${err?.message ?? err}`);
    process.exit(1);
  });
  proxy.listen(listenPort, '127.0.0.1', () => {
    console.log(`wsh goto: forwarding 127.0.0.1:${listenPort} -> ${targetHost}:${targetPort}`);
  });
  // Stay alive as a pure forwarder — skip server startup (see guard below).
  (globalThis as any).__wshNoServer = true;
}

// Reject unknown subcommands before server startup.
const knownCommands = new Set(['version', 'update', 'token', 'rpc', 'apps', 'new', 'logs', 'exitcode', 'ls', 'kill', 'port', 'emit', 'events', 'gc', 'goto']);
const firstArg = process.argv[2];
if (firstArg && !firstArg.startsWith('-') && !knownCommands.has(firstArg)) {
  console.error(`Unknown command: ${firstArg}`);
  console.error(`Run 'wsh --help' for usage.`);
  process.exit(1);
}

// Long-running subcommands keep the process alive without the HTTP server:
// `wsh logs -f` (SSE follow) and `wsh goto` (TCP forwarder). Skip server startup.
if ((globalThis as any).__wshFollowMode || (globalThis as any).__wshNoServer) { /* event loop stays alive */ } else {

rotateEvents();

const MAX_SCROLLBACK     = 5 * 1024 * 1024; // 5 MB
const MAX_SCROLLBACK_WEB = 512 * 1024;      // 512 KB (web app logs)
// Idle TTL after the last peer disconnects. TUI sessions used to reap at 10
// minutes, which predates agent CLIs: a `claude`/`codex`/`traecli` tab that is
// mid-task keeps working with nobody attached, and closing the browser killed
// it well before it finished. 90 minutes clears a long unattended agent run
// with room to spare — deliberately more than the hour web apps get, since a
// web app is a server you can restart at no cost and an interrupted agent run
// is lost work. Note the per-app `timeout` field only reaches web sessions
// (see spawnWebSession) — a TUI session that must outlive this has to be pinned.
const SESSION_TTL     = 90 * 60 * 1000;     // 90 minutes
const WEB_SESSION_TTL = 60 * 60 * 1000;     // 1 hour
const PING_INTERVAL = 30_000;           // 30 seconds
const PONG_TIMEOUT  = 10_000;           // 10 seconds
const RATE_WINDOW   = 60_000;           // 1 minute
const RATE_MAX_MISS = 10;               // max invalid session attempts per IP per window
const MISS_SWEEP_INTERVAL = 5 * 60_000; // prune missAttempts every 5 minutes
const PUBLIC_PTY_MAX_PER_IP = 8;        // max concurrent public-pty sessions per source IP

// View-only sharing for TUI sessions is disabled: a pure viewer, whose only
// secret is the 6-char session ID, is too weak a capability for a live terminal
// (full-scrollback disclosure, no rotation/revocation). Flip to true to restore.
// Owners/writers (incl. yielding) and public-pty visitors are unaffected; web
// apps keep view-only sharing.
const ALLOW_PTY_VIEWERS = false;

const WS_CLOSE = {
  OK:               1000,
  INTERNAL_ERROR:   1011,
  SESSION_REQUIRED: 4000,
  PONG_TIMEOUT:     4001,
  FORBIDDEN:        4003,
  RATE_LIMIT:       4029,
} as const;

type Role = 'owner' | 'writer' | 'viewer';

interface SessionFields {
  pty: IPty | null;
  scrollbackChunks: Buffer[];
  scrollbackBytes: number;
  /** Bytes ever written to this session's output stream. Monotonic — the resume
   *  coordinate clients pass back as `since`. */
  scrollbackTotal: number;
  /** Cached result of stripEphemeralSequences(scrollback). Null until first read or after mutation. */
  strippedScrollback: Buffer | null;
  writer: WebSocket | null;
  peers: Map<WebSocket, Role>; // every connected WS → its original role
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  pinned: boolean;
  title: string;
  app: string;
  /** Program name spawned for the session: basename of the resolved command's first token. */
  binary: string;
  cwd: string;
  createdAt: number;
  lastInput: number;
  lastOutput: number;
  appType: 'pty' | 'web' | 'job';
  child: ChildProcess | null;
  /** type:job — writable to the child's stdin. Null until the job is spawned;
   *  remains null for pty/web sessions. Closed/ended when the child exits or
   *  when a client stdin POST finishes. */
  stdin: Writable | null;
  port?: number;
  ready?: boolean;
  timeoutMs?: number;
  access?: 'public' | 'private';
  stripPrefix?: boolean;
  /** type:web — configured initial inner path for the iframe (AppConfig.path). */
  webPath?: string;
  /** type:web — autostart-on-boot daemon: persistent (no idle reap) and
   *  hidden from /api/sessions while it has no viewers (so it doesn't mark the box busy). */
  daemon?: boolean;
  icon?: string;
  exitCode?: number | null;
  /** When set, PTY spawn is deferred until the first resize message. */
  pendingConfig?: AppConfig;
  /** X-WSH-User header value at session creation, or '' if no upstream identity was carried. */
  createdBy: string;
  /** Normalized source IP of the connection that spawned this session.
   *  Used to cap concurrent public-PTY spawns per IP. */
  creatorIp?: string;
  /** Cumulative bytes client→PTY / client→proxy / client→job-stdin since creation. */
  bytesIn: number;
  /** Cumulative bytes PTY→client / proxy→client / stdout→job-log since creation. */
  bytesOut: number;
  /** Last (bytesIn+bytesOut) total emitted by the metrics tick; lets the tick skip idle sessions. */
  metricsLastTickBytes?: number;
  /** ms-epoch of the last tick this session emitted; drives the idle heartbeat so
   *  `active_seconds` is bucketed at ≤METRICS_HEARTBEAT_INTERVAL granularity. */
  metricsLastTickTs?: number;
}

type Session = SessionFields & EventEmitter;

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


function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid != null) {
    try { process.kill(-child.pid, signal); } catch { /* already dead */ }
  } else {
    child.kill(signal);
  }
}

function broadcast(session: Session, data: string | Buffer, opts?: { binary?: boolean }): void {
  const binary = opts?.binary === true;
  for (const ws of session.peers.keys()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (binary) ws.send(data, { binary: true });
    else ws.send(data);
  }
}

function broadcastClose(session: Session, code: number, reason: string): void {
  for (const ws of session.peers.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
  }
}


// Strip ephemeral terminal queries/responses from scrollback data.
// These should not be replayed — replaying stale queries causes xterm.js to
// generate responses that flow back to PTY stdin as garbage (the originating
// program is long gone, so bash echoes the responses as visible text).
//
// Every query xterm.js responds to is listed here, plus responses that were
// already echoed as garbage and baked into the scrollback.
//
// Queries:
//   CSI c  / CSI > c / CSI = c    — DA1/DA2/DA3 (device attributes)
//   CSI 5 n / CSI 6 n / CSI ? 6 n — DSR (device status / cursor position)
//   CSI ? Ps $ p / CSI Ps $ p     — DECRQM (request mode)
//   CSI 14 t / 16 t / 18 t        — window/cell size queries
//   DCS $ q ... ST                — DECRQSS (request status string)
//   OSC 4;N;? / 10;? / 11;? / 12;? — color queries
// Responses:
//   CSI row ; col R / CSI ? row ; col R — CPR
//   CSI ? ... c                         — DA response
//   CSI Ps ; Ps $ y / CSI ? Ps ; Ps $ y — DECRPM (mode report)
//   CSI 8 ; rows ; cols t               — text area size response
//   DCS 0/1 $ r ... ST                  — DECRQSS response
const ephemeralRe = new RegExp([
  '\\x1b\\[\\??[>= ]?[\\d;]*c',           // DA query + response
  '\\x1b\\[\\??\\d*n',                     // DSR query (5n, 6n, ?6n)
  '\\x1b\\[\\??\\d+;\\d+R',               // CPR response (row;colR, ?row;colR)
  '\\x1b\\[\\??\\d+\\$p',                 // DECRQM query (?Ps$p, Ps$p)
  '\\x1b\\[\\??\\d+;\\d+\\$y',            // DECRPM response (?Ps;Ps$y, Ps;Ps$y)
  '\\x1b\\[(?:14|16|18)t',                // window/cell size queries
  '\\x1b\\[8;\\d+;\\d+t',                 // text area size response
  '\\x1bP\\$q[^\\x1b]*\\x1b\\\\',         // DECRQSS query (DCS$q...ST)
  '\\x1bP[01]\\$r[^\\x1b]*\\x1b\\\\',     // DECRQSS response (DCS 0/1 $r...ST)
  '\\x1b\\](?:1[012]|4;\\d+);\\?(?:\\x07|\\x1b\\\\)', // OSC color queries
].join('|'), 'g');
function stripEphemeralSequences(buf: Buffer): Buffer {
  // Byte-level pre-check: skip the UTF-8 decode entirely when there are no
  // escape characters. indexOf is C++-implemented; toString allocates a string
  // the size of the buffer, which dominates for large logs without escapes.
  if (buf.indexOf(0x1b) === -1) return buf;
  const str = buf.toString('utf8');
  const stripped = str.replace(ephemeralRe, '');
  return stripped.length === str.length ? buf : Buffer.from(stripped, 'utf8');
}

// Returns the index of the first byte of any trailing incomplete UTF-8
// codepoint, or buf.length if the buffer ends on a complete codepoint.
// Used to defer split codepoints to the next chunk so toString('utf8')
// doesn't emit U+FFFD across read boundaries.
function utf8SafeEnd(buf: Buffer): number {
  // A 4-byte codepoint can have at most 3 trailing continuation bytes pending.
  for (let back = 1; back <= 3 && buf.length - back >= 0; back++) {
    const b = buf[buf.length - back];
    if ((b & 0xc0) === 0x80) continue;        // continuation byte; keep walking
    if ((b & 0x80) === 0x00) return buf.length; // ASCII; whole buffer is safe
    const need =
      (b & 0xe0) === 0xc0 ? 2 :
      (b & 0xf0) === 0xe0 ? 3 :
      (b & 0xf8) === 0xf0 ? 4 : 0;
    if (need === 0) return buf.length;        // invalid lead; let toString replace
    return back === need ? buf.length : buf.length - back;
  }
  return buf.length;
}

/** Keep only the most recent JOB_LOG_MAX files. */
function rotateJobLogs(): void {
  fs.readdir(JOB_LOG_DIR, (err, files) => {
    if (err || files.length <= JOB_LOG_MAX) return;
    const logFiles = files.filter(f => f.endsWith('.log')).map(f => ({
      name: f,
      path: path.join(JOB_LOG_DIR, f),
    }));
    let pending = logFiles.length;
    const withMtime: { path: string; mtime: number }[] = [];
    for (const lf of logFiles) {
      fs.stat(lf.path, (err, stat) => {
        if (!err) withMtime.push({ path: lf.path, mtime: stat.mtimeMs });
        if (--pending === 0 && withMtime.length > JOB_LOG_MAX) {
          withMtime.sort((a, b) => b.mtime - a.mtime);
          for (const old of withMtime.slice(JOB_LOG_MAX)) {
            fs.unlink(old.path, () => {});
            fs.unlink(old.path.replace(/\.log$/, '.exit'), () => {});
          }
        }
      });
    }
  });
}

function scrollbackLimit(session: Session): number {
  return session.appType === 'web' ? MAX_SCROLLBACK_WEB : MAX_SCROLLBACK;
}

// Chunk-list scrollback: O(1) amortized append, O(n) only on replay (and the
// stripped result is cached). Buffer.concat-then-slice was quadratic.
function appendScrollback(session: Session, data: Buffer): void {
  if (data.length === 0) return;
  session.scrollbackChunks.push(data);
  session.scrollbackBytes += data.length;
  // Monotonic position in the output stream, never trimmed and never reset (not
  // even by `clear`) — it's the coordinate a reattaching client resumes from.
  // The retained buffer covers [scrollbackTotal - scrollbackBytes, scrollbackTotal).
  session.scrollbackTotal += data.length;
  session.strippedScrollback = null;
  const limit = scrollbackLimit(session);
  while (session.scrollbackBytes > limit && session.scrollbackChunks.length > 0) {
    const first = session.scrollbackChunks[0];
    const excess = session.scrollbackBytes - limit;
    if (excess >= first.length) {
      session.scrollbackChunks.shift();
      session.scrollbackBytes -= first.length;
    } else {
      session.scrollbackChunks[0] = first.slice(excess);
      session.scrollbackBytes -= excess;
    }
  }
}

function scrollbackReplay(session: Session): Buffer | null {
  if (session.scrollbackBytes === 0) return null;
  if (session.strippedScrollback) return session.strippedScrollback;
  const full = session.scrollbackChunks.length === 1
    ? session.scrollbackChunks[0]
    : Buffer.concat(session.scrollbackChunks, session.scrollbackBytes);
  session.strippedScrollback = stripEphemeralSequences(full);
  return session.strippedScrollback;
}

type ReplayMode = 'none' | 'tail' | 'full';

/** What a client attaching at stream position `since` needs.
 *
 *  `tail` is the common reconnect: the gap is still in the buffer, so the client
 *  gets exactly the bytes it missed and keeps its screen. `full` means the gap
 *  fell out of the ring (or the client claims a position we can't honor) — it
 *  resets first, or the session would render twice. A client that has seen
 *  everything gets `none`.
 *
 *  `since` always lands on a chunk boundary: it's a value this counter held at
 *  some earlier moment, and chunks are appended atomically. So a tail can never
 *  begin mid-escape-sequence. */
function replayFrom(session: Session, since: number): { mode: ReplayMode; buf: Buffer | null } {
  const total = session.scrollbackTotal;
  if (since > 0 && since === total) return { mode: 'none', buf: null };
  if (since > 0 && since < total && since >= total - session.scrollbackBytes) {
    return { mode: 'tail', buf: scrollbackTail(session, total - since) };
  }
  // Falls through for since=0, a gap older than the ring, and a client claiming
  // to be ahead of the stream (out of sync with this session — a `clear`, or a
  // different session behind the same ID): start it over from scratch.
  return { mode: 'full', buf: scrollbackReplay(session) };
}

/** The last `n` bytes of scrollback, stripped like a full replay — stale query
 *  sequences are just as poisonous in a tail as in a full replay. */
function scrollbackTail(session: Session, n: number): Buffer | null {
  if (n <= 0 || session.scrollbackBytes === 0) return null;
  if (n >= session.scrollbackBytes) return scrollbackReplay(session);
  const picked: Buffer[] = [];
  let have = 0;
  for (let i = session.scrollbackChunks.length - 1; i >= 0 && have < n; i--) {
    const chunk = session.scrollbackChunks[i];
    picked.unshift(chunk);
    have += chunk.length;
  }
  const joined = picked.length === 1 ? picked[0] : Buffer.concat(picked, have);
  return stripEphemeralSequences(have > n ? joined.subarray(have - n) : joined);
}

function clearScrollback(session: Session): void {
  session.scrollbackChunks = [];
  session.scrollbackBytes = 0;
  session.strippedScrollback = null;
}

function deriveTitleFromCommand(cmd: string): string {
  const collapsed = cmd.replace(/\s+/g, ' ').trim();
  const MAX = 24;
  return collapsed.length > MAX ? collapsed.slice(0, MAX - 1) + '…' : collapsed;
}

function baseSession(appKey: string, appConfig: AppConfig, createdBy = ''): Session {
  const now = Date.now();
  const binary = commandBinary(appConfig.command);
  return Object.assign(new EventEmitter(), {
    pty: null,
    scrollbackChunks: [] as Buffer[],
    scrollbackBytes: 0,
    scrollbackTotal: 0,
    strippedScrollback: null,
    writer: null,
    peers: new Map(),
    cleanupTimer: null,
    pinned: false,
    title: appConfig.title ?? binary,
    icon: appConfig.icon,
    app: appKey,
    binary,
    cwd: resolveCwd(appConfig),
    createdAt: now,
    lastInput: now,
    lastOutput: now,
    appType: 'pty' as const,
    access: appConfig.access,
    child: null,
    stdin: null,
    createdBy,
    bytesIn: 0,
    bytesOut: 0,
  }) as Session;
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

/** Base environment for child processes, without WSH_PORT (reserved for web apps). */
function baseEnv(): Record<string, string> {
  const env = { ...process.env, PATH: appPath() } as Record<string, string>;
  delete env.WSH_PORT;
  return env;
}

// Trusted cwd path: comes from apps.yaml or system defaults. Auto-creates so
// declarative app definitions are self-bootstrapping on first run.
function resolveCwd(appConfig: AppConfig): string {
  const dir = appConfig.cwd ? expandHome(appConfig.cwd) : (process.env.HOME ?? process.cwd());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Untrusted cwd path: comes from a POST /api/sessions body. Must already exist
// — auto-creating would silently turn typos like "/tpm/work" into junk dirs.
// Returns an error string on failure; null on success.
function validateRequestCwd(cwd: string): string | null {
  const expanded = expandHome(cwd);
  let st: fs.Stats;
  try {
    st = fs.statSync(expanded);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return `cwd does not exist: ${cwd}`;
    return `cwd: ${e?.message ?? String(e)}`;
  }
  if (!st.isDirectory()) return `cwd is not a directory: ${cwd}`;
  return null;
}

/** Spawn a PTY and wire it into an existing session. */
function spawnPty(id: string, session: Session, appConfig: AppConfig, cols: number, rows: number): void {
  const ptyProcess = pty.spawn('/bin/sh', ['-c', appConfig.command], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: resolveCwd(appConfig),
    env: {
      ...baseEnv(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      WSH_SESSION: id,
      WSH_ORIGIN_USER: session.createdBy || '',
      ...(appConfig.env ?? {}),
    } as Record<string, string>,
  });

  session.pty = ptyProcess;

  const oscTitleRe = /\x1b\](?:0|2);([^\x07]*)\x07/;
  ptyProcess.onData((data: string) => {
    const m = data.match(oscTitleRe);
    if (m) session.title = m[1];
    session.lastOutput = Date.now();
    const buf = Buffer.from(data, 'utf8');
    session.bytesOut += buf.length;
    appendScrollback(session, buf);
    broadcast(session, buf, { binary: true });
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`[session ${id}] PTY exited (code=${exitCode} signal=${signal})`);
    void recordClosedWithTokens(id, session);
    session.pty = null;
    broadcastClose(session, WS_CLOSE.OK, 'PTY process exited');
    if (session.cleanupTimer !== null) clearTimeout(session.cleanupTimer);
    unregisterSession(id, session, 'process-exit');
    removeSkillSnapshot(id);
  });

  console.log(`[session ${id}] spawned (${cols}x${rows}) cmd: ${appConfig.command}`);
}

function spawnSession(id: string, appKey: string, appConfig: AppConfig, createdBy = '', cols = 80, rows = 24): Session {
  const session = baseSession(appKey, appConfig, createdBy);
  registerSession(id, session);
  spawnPty(id, session, appConfig, cols, rows);
  return session;
}

/** Create a pending session that defers PTY spawn until the first resize. */
function createPendingSession(id: string, appKey: string, appConfig: AppConfig, createdBy = ''): Session {
  const session = baseSession(appKey, appConfig, createdBy);
  session.pendingConfig = appConfig;
  registerSession(id, session);
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

/** The `ready` message. `instance` identifies the child process now behind the
 *  app proxy, so a reconnecting client can tell "my app was restarted" (reload
 *  the iframe — its upstream is gone) from "my socket dropped and came back"
 *  (leave the iframe alone). The session ID can't carry that: a reconnect that
 *  respawns a dead singleton reuses the ID the client asked for, and the server's
 *  own PID is included so the same is true across a server restart. */
function readyMessage(session: Session): string {
  return JSON.stringify({
    type: 'ready',
    path: session.webPath,
    instance: `${process.pid}:${session.child?.pid ?? 0}`,
  });
}

async function spawnWebSession(id: string, appKey: string, appConfig: AppConfig, createdBy = '', options?: { notify?: boolean }): Promise<Session> {
  const port = await findFreePort();
  const configuredTimeout = appConfig.timeout ? parseTimeout(appConfig.timeout) : undefined;
  const timeoutMs = (configuredTimeout != null && !isNaN(configuredTimeout)) ? configuredTimeout : WEB_SESSION_TTL;
  const session = Object.assign(baseSession(appKey, appConfig, createdBy), {
    appType: 'web' as const,
    port,
    ready: false,
    timeoutMs,
    access: appConfig.access,
    stripPrefix: appConfig.stripPrefix,
    webPath: appConfig.path,
    daemon: appConfig.daemon,
  });

  registerSession(id, session);

  const env = {
    ...baseEnv(),
    ...(appConfig.env ?? {}),
    WSH_PORT: String(port),
    WSH_SESSION: id,
    WSH_BASE_URL: BASE + '_a/' + appKey + '/',
    WSH_ORIGIN_USER: session.createdBy || '',
  };

  const child = spawn('/bin/sh', ['-c', appConfig.command], {
    detached: true,
    env: env as Record<string, string>,
    cwd: resolveCwd(appConfig),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  session.child = child;

  // Log the launch command to the log terminal
  const resolvedCmd = appConfig.command
    .replace(/\$WSH_PORT\b/g, String(port))
    .replace(/\$WSH_SESSION\b/g, id)
    .replace(/\$WSH_BASE_URL\b/g, BASE + '_a/' + appKey + '/');
  const cwd = resolveCwd(appConfig);
  const banner = `\x1b[90m$ cd ${cwd} && ${resolvedCmd}\x1b[0m\r\n`;
  const bannerBuf = Buffer.from(banner);
  appendScrollback(session, bannerBuf);
  broadcast(session, bannerBuf, { binary: true });

  const appendOutput = (data: Buffer) => {
    session.lastOutput = Date.now();
    appendScrollback(session, data);
    broadcast(session, data, { binary: true });
  };

  child.stdout!.on('data', appendOutput);
  child.stderr!.on('data', appendOutput);

  child.on('exit', (code) => {
    console.log(`[session ${id}] web process exited (code ${code})`);
    void recordClosedWithTokens(id, session);
    broadcastClose(session, WS_CLOSE.OK, 'Process exited');
    if (session.cleanupTimer !== null) clearTimeout(session.cleanupTimer);
    unregisterSession(id, session, 'process-exit');
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
    broadcast(session, readyMessage(session));
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

function spawnJobSession(id: string, appKey: string, appConfig: AppConfig, createdBy = ''): Session {
  const session = baseSession(appKey, appConfig, createdBy);
  session.appType = 'job';

  // Jobs have no idle TTL — the child's 'close' handler is the only path to deletion.
  sessions.set(id, session);

  // Open log file for incremental writes
  fs.mkdirSync(JOB_LOG_DIR, { recursive: true });
  const logFd = fs.openSync(path.join(JOB_LOG_DIR, `${id}.log`), 'w');

  const env = {
    ...baseEnv(),
    ...(appConfig.env ?? {}),
    WSH_SESSION: id,
    WSH_ORIGIN_USER: session.createdBy || '',
  };

  const child = spawn('/bin/sh', ['-c', appConfig.command], {
    detached: true,
    env: env as Record<string, string>,
    cwd: resolveCwd(appConfig),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  session.child = child;
  session.stdin = child.stdin;
  // Don't crash the server if a write races a child exit. The stdin route handler
  // also reports per-write errors back to its client; this catches the case where
  // no client is actively writing.
  child.stdin?.on('error', () => {});

  if (appConfig.banner) {
    const cwd = resolveCwd(appConfig);
    const banner = `\x1b[90m$ cd ${cwd} && ${appConfig.command}\x1b[0m\r\n`;
    fs.writeSync(logFd, Buffer.from(banner));
  }

  const appendOutput = (data: Buffer) => {
    session.lastOutput = Date.now();
    session.bytesOut += data.length;
    fs.writeSync(logFd, data);
    session.emit('output', data);
  };

  child.stdout!.on('data', appendOutput);
  child.stderr!.on('data', appendOutput);

  child.on('close', (code, signal) => {
    console.log(`[session ${id}] job exited (code ${code}, signal ${signal})`);
    void recordClosedWithTokens(id, session);
    // POSIX convention: signal-killed processes exit with 128 + signal number.
    // Node passes code=null in that case; without this, callers see -1 (which
    // bash wraps to 255) and lose all signal info.
    const exitVal = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : -1);
    session.exitCode = exitVal;
    session.child = null;
    try { fs.closeSync(logFd); } catch {}
    try { fs.writeFileSync(path.join(JOB_LOG_DIR, `${id}.exit`), String(exitVal)); } catch {}
    rotateJobLogs();
    if (session.cleanupTimer !== null) clearTimeout(session.cleanupTimer);
    unregisterSession(id, session, 'process-exit');
  });

  console.log(`[session ${id}] job spawned: ${appConfig.command}`);
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

/** Idle TTL a session would be reaped after — the per-app `timeout` if one was
 *  configured, else the per-type default. Also what the ws-close logs quote, so
 *  the countdown they print is the one scheduleCleanup actually arms. */
function effectiveTTL(session: Session): number {
  return session.timeoutMs ?? (session.appType === 'web' ? WEB_SESSION_TTL : SESSION_TTL);
}

function scheduleCleanup(id: string, session: Session): void {
  if (session.cleanupTimer !== null) {
    clearTimeout(session.cleanupTimer);
  }
  session.cleanupTimer = null;
  // Pinned sessions and daemons live until the process exits or a manual close.
  if (session.pinned || session.daemon) return;
  const ttl = effectiveTTL(session);
  session.cleanupTimer = setTimeout(() => {
    console.log(`[session ${id}] TTL expired`);
    // No process to kill (e.g. pending session that never received a resize)
    if (!session.child && !session.pty) {
      unregisterSession(id, session, 'idle-timeout');
      return;
    }
    if (session.child) killProcessGroup(session.child);
    else if (session.pty) session.pty.kill('SIGHUP');
    // Session cleanup happens in the process exit handler.
    // For PTY sessions the exit handler fires synchronously after kill.
    // Guard against processes that ignore SIGTERM (e.g. stuck):
    if (sessions.has(id)) {
      setTimeout(() => {
        if (sessions.has(id)) {
          console.log(`[session ${id}] process did not exit after SIGTERM, force killing`);
          if (session.child) killProcessGroup(session.child, 'SIGKILL');
          else if (session.pty) session.pty.kill('SIGKILL');
        }
      }, 5000);
    }
  }, ttl);
}

/** Session lifecycle, for anything watching the box from outside it.
 *
 * Jobs are deliberately excluded. Every `wsh run` spawns one, so emitting for
 * jobs would put high-frequency churn into `~/.wsh/events.log` — a user-facing
 * log — to announce sessions nobody holds a window open on. Readers that display
 * jobs re-read `/api/sessions` on any event anyway, so a job still lands: on the
 * next event, or on the reader's own heartbeat.
 *
 * The appType gate lives here rather than at the call sites. `unregisterSession`
 * is reached from the session-replaced path, which fires for every type, and a
 * rule copied into five callers is a rule the sixth caller will not have.
 *
 * It must never break session teardown. `emit` appends to disk, and a `~/.wsh`
 * that cannot be written must not turn a PTY exit into an unhandled throw —
 * losing an event costs a reader one heartbeat of staleness, which is the whole
 * reason readers keep one.
 */
function emitSessionEvent(kind: 'start' | 'exit', id: string, session: Session, reason?: string): void {
  if (session.appType === 'job') return;
  try {
    emitEvent(`session.${kind}`, {
      id,
      app: session.app,
      appType: session.appType,
      ...(session.daemon ? { daemon: true } : {}),
      ...(reason ? { reason } : {}),
    });
  } catch {}
}

/** Add session to the map and enforce idle-timeout invariant. */
function registerSession(id: string, session: Session): void {
  sessions.set(id, session);
  if (session.peers.size === 0) {
    scheduleCleanup(id, session);
  }
  // After the map, never before: a reader woken by this event asks
  // /api/sessions what is open, and must not be told to look before it is there.
  emitSessionEvent('start', id, session);
}

/** Remove a session from the map, if it is still the one being removed.
 *
 * The identity check is the whole point. A session replaced by `-s` reuse leaves
 * the old one's exit handler still holding its id, and an unconditional delete
 * there evicts the *new* session. Four call sites carried a hand-written copy of
 * that check; collecting it here also gives the exit event one place to be
 * emitted from, so no caller has to remember to.
 *
 * Returns whether this call is the one that removed it.
 */
function unregisterSession(id: string, session: Session, reason?: string): boolean {
  if (sessions.get(id) !== session) return false;
  sessions.delete(id);
  emitSessionEvent('exit', id, session, reason);
  return true;
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
  console.log('  rpc <code>         Evaluate JavaScript on connected clients');
  console.log('  exitcode <id>      Get exit code of a session');
  console.log('  port <app>         Print the port of a running web app');
  console.log('  emit <type>        Emit an event to the event bus');
  console.log('  events             Subscribe to events from the event bus');
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
  env?: Record<string, string>;
  cwd?: string;
  title?: string;
  icon?: string;
  description?: string;
  hidden?: boolean;
  top?: number;
  skill?: string;
  slashPrefix?: boolean;
  type?: 'pty' | 'web' | 'job';
  /** type:web only — idle TTL after the last viewer leaves (e.g. "30m", "2h").
   *  Deliberately not honored for pty: a TUI session holds a live terminal and
   *  marks the box busy, so config shouldn't be able to keep one alive for days
   *  — it always uses SESSION_TTL and has to be pinned to outlive that. Jobs
   *  never idle-reap at all. loadApps() warns when a non-web app sets it. */
  timeout?: string;
  access?: 'public' | 'private';
  stripPrefix?: boolean;
  healthCheck?: string;
  /** type:web only — initial inner path the iframe opens at (e.g. "/files/"). Must start with "/". */
  path?: string;
  /** Mark this app as the box's default: the catalog root ("/") auto-redirects to it.
   *  Visit "/?catalog" to see the catalog instead. If several apps set it, the first
   *  in catalog order wins. See defaultAppKey() / router.get('/'). */
  default?: boolean;
  /** type:web only — autostart on server boot and keep running (never idle-reaped).
   *  An idle daemon (0 viewers) is hidden from /api/sessions so it doesn't mark the
   *  box busy; it reappears while actively viewed. See spawnWebSession / scheduleCleanup. */
  daemon?: boolean;
  startupTimeout?: string;
  banner?: boolean;
  prefixCommand?: string;
  tips?: string[];
}

const DEFAULT_APPS: Record<string, AppConfig> = {
  bash: {
    command: values['no-login'] ? '/bin/bash' : '/bin/bash -l',
    title: 'bash',
  },
};

const SYSTEM_CONFIG_DIR = '/etc/wsh';

function loadConfigFile(dir: string, warnings?: string[]): Record<string, unknown> | null {
  // Prefer apps.yaml, fall back to apps.json
  const yamlPath = path.join(dir, 'apps.yaml');
  const jsonPath = path.join(dir, 'apps.json');
  if (fs.existsSync(yamlPath)) {
    try { return YAML.parse(fs.readFileSync(yamlPath, 'utf8')); } catch (err: any) {
      warnings?.push(`Failed to parse ${yamlPath}: ${err.message}`);
      return null;
    }
  }
  if (fs.existsSync(jsonPath)) {
    try { return JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (err: any) {
      warnings?.push(`Failed to parse ${jsonPath}: ${err.message}`);
      return null;
    }
  }
  return null;
}

function normalizeAppEntry(value: unknown): AppConfig | null {
  if (value && typeof value === 'object' && (typeof (value as any).command === 'string' || typeof (value as any).skill === 'string'))
    return value as AppConfig;
  return null;
}

const METADATA_ONLY_KEYS = new Set(['hidden', 'top', 'icon', 'title', 'description']);

function isMetadataOnly(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value as Record<string, unknown>).every(k => METADATA_ONLY_KEYS.has(k));
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
      // New app — requires command or skill
      const config = normalizeAppEntry(value);
      if (config) apps[key] = config;
      else if (!isMetadataOnly(value)) warnings?.push(`App "${key}" ignored — missing "command" or "skill" field`);
      // Silently skip metadata-only entries (e.g. orphaned hidden/top overrides for removed apps)
    }
  }
}

/** Reserved URL paths that cannot be used as app names. */
const RESERVED_PATHS = new Set(['skill']);

const SNAPSHOT_DIR = path.join(os.homedir(), '.wsh', 'snapshots');

/** Write a skill snapshot file and return the path. */
function writeSkillSnapshot(agentSessionId: string, snapshot: string, targetApp: string, targetSession: string): string {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const filePath = path.join(SNAPSHOT_DIR, `${agentSessionId}.md`);
  const lines = [
    targetApp ? `app: ${targetApp}` : null,
    targetSession ? `session: ${targetSession}` : null,
    '',
    snapshot,
  ].filter(l => l !== null).join('\n');
  fs.writeFileSync(filePath, lines);
  return filePath;
}

/** Remove a skill snapshot file (best-effort). */
function removeSkillSnapshot(agentSessionId: string): void {
  try { fs.unlinkSync(path.join(SNAPSHOT_DIR, `${agentSessionId}.md`)); } catch {}
}

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
    if (typeof tool.prefix === 'string') defaults.prefixCommand = tool.prefix;
  }
  return defaults;
}

function loadApps(warnings?: string[]): Record<string, AppConfig> {
  const apps = { ...DEFAULT_APPS };
  const system = loadConfigFile(SYSTEM_CONFIG_DIR, warnings);
  const user = loadConfigFile(path.join(os.homedir(), '.wsh'), warnings);
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
  // Warn about public PTY apps — anyone the gateway forwards can run their
  // command with full keyboard input. Checked on the merged result (access and
  // command may arrive from different layers), so it can't be done in mergeApps.
  // Same for `timeout` on a non-web app: `type` and `timeout` can land from
  // different layers, so the resolved config is the only place to judge it.
  if (warnings) {
    for (const [key, app] of Object.entries(apps)) {
      if (isPublicPtyConfig(app)) {
        warnings.push(`App "${key}" is public + PTY — anyone the gateway forwards can run its command with full keyboard input. Make sure it's sandboxed; never expose a shell.`);
      }
      const type = app.type ?? 'pty';
      if (app.timeout && type !== 'web') {
        warnings.push(type === 'job'
          ? `App "${key}" sets "timeout: ${app.timeout}", which applies to type: web only — it is ignored here. A job runs until its command exits and is never idle-reaped.`
          : `App "${key}" sets "timeout: ${app.timeout}", which applies to type: web only — it is ignored here. A TUI session always idle-reaps ${SESSION_TTL / 60000} minutes after the last viewer leaves; pin the session to keep it alive longer.`);
      }
    }
  }
  // Sort: topped (by value asc), normal, hidden
  const sorted = Object.entries(apps).sort(([, a], [, b]) => {
    const tierOf = (app: AppConfig) => {
      if (app.hidden) return 2;
      if (typeof app.top === 'number' && app.top > 0) return 0;
      return 1;
    };
    const ta = tierOf(a), tb = tierOf(b);
    if (ta !== tb) return ta - tb;
    if (ta === 0) return (a.top as number) - (b.top as number);
    return 0;
  });
  return Object.fromEntries(sorted);
}

/** Build an AppConfig for running a skill by name. Uses _skills defaults from apps.yaml. */
function buildSkillConfig(skillName: string, input: string, mode: string, cwd?: string, envOverride?: Record<string, string>): AppConfig {
  const system = loadConfigFile(SYSTEM_CONFIG_DIR);
  const user = loadConfigFile(path.join(os.homedir(), '.wsh'));
  const defaults = extractSkillDefaults(system, user);
  const useInline = mode === 'inline' && defaults.inlineCommand;
  const usePrefix = !input && !useInline && defaults.prefixCommand;
  const config: AppConfig = {
    command: usePrefix ? defaults.prefixCommand! : useInline ? defaults.inlineCommand! : (defaults.command || SKILL_DEFAULTS.command!),
    ...(usePrefix ? {} : { skill: skillName }),
    ...(defaults.cwd ? { cwd: defaults.cwd } : {}),
    env: {
      ...(defaults.env ?? {}),
      ...(usePrefix ? {} : { SKILL: skillName, INPUT: input }),
      ...(mode ? { WSH_MODE: mode } : {}),
      ...(envOverride ?? {}),
    },
  };
  if (cwd) config.cwd = cwd;
  return usePrefix ? config : applySlashPrefix(config);
}

/** Strip /$SKILL from command when slashPrefix is false. */
function applySlashPrefix(config: AppConfig): AppConfig {
  if (config.skill && config.slashPrefix === false) {
    return { ...config, command: config.command.replace(/\/\$SKILL\s?/, '') };
  }
  return config;
}

/** Find an existing web session for a given app key (singleton semantics). */
function findWebSession(appKey: string): { id: string; session: Session } | null {
  for (const [id, s] of sessions) {
    if (s.app === appKey && s.appType === 'web') return { id, session: s };
  }
  return null;
}

// Web apps are singletons, but `spawnWebSession` awaits `findFreePort()` before
// it registers the session — so two concurrent first-hits for the same app both
// pass `findWebSession()` (null) and each spawn a child, leaking one. This map
// holds the in-flight spawn per appKey so the second caller joins the first's
// promise instead of starting a rival child. Cleared once the spawn settles.
const webSpawnsInFlight = new Map<string, Promise<{ id: string; session: Session }>>();

/**
 * Resolve the singleton web session for `appKey`, spawning it atomically if
 * absent. `newId` is only used if this call is the one that actually spawns;
 * callers must use the returned `id` (a concurrent winner's id may differ).
 */
function getOrSpawnWebSession(
  newId: string,
  appKey: string,
  appConfig: AppConfig,
  createdBy = '',
  options?: { notify?: boolean },
): Promise<{ id: string; session: Session }> {
  const existing = findWebSession(appKey);
  if (existing) return Promise.resolve(existing);
  const inFlight = webSpawnsInFlight.get(appKey);
  if (inFlight) return inFlight;
  const pending = spawnWebSession(newId, appKey, appConfig, createdBy, options)
    .then(session => ({ id: newId, session }));
  webSpawnsInFlight.set(appKey, pending);
  const clear = () => { if (webSpawnsInFlight.get(appKey) === pending) webSpawnsInFlight.delete(appKey); };
  pending.then(clear, clear);
  return pending;
}

/**
 * Autostart all `type:web, daemon:true` apps on server boot. Each becomes a
 * persistent, hidden-when-idle web session (see scheduleCleanup / /api/sessions).
 * Fire-and-forget — the health check runs in the background and a failure to
 * start one daemon never blocks the others or server startup.
 */
function startDaemonApps(): void {
  let apps: Record<string, AppConfig>;
  try { apps = loadApps(); } catch (err) { console.error(`[daemon] loadApps failed: ${errorMessage(err)}`); return; }
  for (const [appKey, cfg] of Object.entries(apps)) {
    if (cfg.type !== 'web' || !cfg.daemon) continue;
    if (findWebSession(appKey)) continue; // already running (e.g. manual restart)
    const id = crypto.randomInt(0, 2176782336).toString(36).padStart(6, '0');
    getOrSpawnWebSession(id, appKey, cfg)
      .then(({ id: sid }) => console.log(`[daemon ${sid}] autostarted web app "${appKey}"`))
      .catch((err) => console.error(`[daemon] failed to autostart "${appKey}": ${errorMessage(err)}`));
  }
}

// --- Network helpers ---

function isLoopback(ip: string | undefined): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Collapse IPv4-mapped-IPv6 (::ffff:1.2.3.4) to plain IPv4 so the same client
// isn't tracked under two keys in rate-limit and missAttempts maps.
function normalizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

// Prune expired rate-limit entries; bounded memory even under IP churn.
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW;
  for (const [ip, timestamps] of missAttempts) {
    const kept = timestamps.filter(t => t > cutoff);
    if (kept.length === 0) missAttempts.delete(ip);
    else if (kept.length !== timestamps.length) missAttempts.set(ip, kept);
  }
}, MISS_SWEEP_INTERVAL).unref();

// Metrics: one shared checkpoint timer for all sessions. Short-lived sessions
// never reach it — they emit a `closed` event instead. A session emits a tick
// when either (a) bytes grew since its last tick or (b) it has been idle for
// METRICS_HEARTBEAT_INTERVAL. The heartbeat clause bounds the bucket-attribution
// error for `active_seconds` on purely idle sessions; at hourly storage, K=30 min
// caps the worst-case hour-boundary mis-credit at 30 min while costing only
// ~150 B per session per K.
const METRICS_TICK_INTERVAL = 60_000;
const METRICS_HEARTBEAT_INTERVAL = 30 * 60_000;
setInterval(() => { void tickAllSessions(); }, METRICS_TICK_INTERVAL).unref();

// Prewarm agent-token discovery for sessions still in their first 30 s:
// the regular 60 s tick is too slow to catch `claude --resume` cases where
// the user types a new prompt within seconds of opening the session. Each
// call is cheap (a /proc walk plus a directory listing) and short-circuits
// the moment a transcript is adopted (state.files non-empty → adapter
// honours its 5 s throttle thereafter).
const AGENT_PREWARM_INTERVAL = 1_000;
const AGENT_PREWARM_WINDOW = 30_000;
setInterval(() => { void prewarmAgentTokens(); }, AGENT_PREWARM_INTERVAL).unref();

async function prewarmAgentTokens(): Promise<void> {
  const now = Date.now();
  const tasks: Promise<unknown>[] = [];
  for (const [id, s] of sessions) {
    if (!agentOf(s.binary)) continue;
    const age = now - s.createdAt;
    if (age < 200 || age > AGENT_PREWARM_WINDOW) continue;
    tasks.push(maybeAgentTokens(id, s).catch(() => undefined));
  }
  if (tasks.length) await Promise.all(tasks);
}

async function tickAllSessions(): Promise<void> {
  const now = Date.now();
  const tasks: Promise<void>[] = [];
  for (const [id, s] of sessions) {
    if (now - s.createdAt < METRICS_TICK_INTERVAL) continue;
    const total = (s.bytesIn ?? 0) + (s.bytesOut ?? 0);
    const bytesGrew = total > (s.metricsLastTickBytes ?? 0);
    const lastEmit = s.metricsLastTickTs ?? s.createdAt;
    const idleEnough = now - lastEmit >= METRICS_HEARTBEAT_INTERVAL;
    if (!bytesGrew && !idleEnough) continue;
    s.metricsLastTickBytes = total;
    s.metricsLastTickTs = now;
    tasks.push(tickOne(id, s));
  }
  if (tasks.length) await Promise.all(tasks);
}

async function tickOne(id: string, session: Session): Promise<void> {
  metrics.recordTick(id, session, await maybeAgentTokens(id, session));
}

async function recordClosedWithTokens(id: string, session: Session): Promise<void> {
  metrics.recordClosed(id, session, await maybeAgentTokens(id, session));
  dropSession(id);
}

// maybeAgentTokens returns the per-model cumulative token snapshot for an
// agent session, or undefined when the session's binary isn't a registered
// agent. Non-agent sessions skip the file IO entirely.
async function maybeAgentTokens(id: string, s: Session): Promise<Record<string, { in: number; out: number }> | undefined> {
  if (!agentOf(s.binary)) return undefined;
  return await captureTokens({
    sid: id,
    binary: s.binary,
    createdAt: s.createdAt,
    pid: s.pty?.pid ?? s.child?.pid ?? null,
  });
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
  const header = req.headers['x-wsh-proxy-secret'];
  if (typeof header !== 'string' || header.length !== PROXY_SECRET.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(PROXY_SECRET));
}

/** True iff the gateway approved this caller for box-level access.
 *
 * Loopback callers presenting a valid X-WSH-Proxy-Secret are also treated as
 * approved: PROXY_SECRET is generated per-container and only known inside it,
 * so secret + loopback = trusted in-box tooling (e.g. `wsh new` from mybox).
 * This avoids forcing every in-box CLI to forge X-Abox-Allowed itself. */
function gatewayAllowed(req: http.IncomingMessage): boolean {
  if (req.headers['x-abox-allowed'] === '1') return true;
  return isLoopback(req.socket.remoteAddress) && verifyProxySecret(req);
}

/** A public app a forwarded stranger may open without box auth — a web or pty
 *  app marked `access: public` (not a job or skill). Public web apps are joined
 *  as viewers; public pty apps spawn a per-visitor session driven as writer. */
function isPublicJoinable(app: AppConfig | undefined): boolean {
  return !!app && app.access === 'public' && app.type !== 'job' && !app.skill;
}

/** A public pty app config — the dangerous, per-visitor writable variant. */
function isPublicPtyConfig(app: AppConfig | undefined): boolean {
  return isPublicJoinable(app) && app?.type !== 'web';
}

/** A live public pty session (per-visitor, writer-joinable). */
function isPublicPtySession(s: Session): boolean {
  return s.appType === 'pty' && s.access === 'public';
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

    // Trust-proxy mode: gateway makes the access decision via X-Abox-Allowed.
    // Proxy/iframe paths (/_a /_p) and the /terminal WS upgrade gate themselves
    // (they consult appConfig.access / session.access). Other /api/* endpoints
    // are owner-side and require Allowed=1, except GET /api/apps which serves a
    // filtered catalog to non-allowed viewers.
    if (TRUST_PROXY) {
      if (!verifyProxySecret(req)) { res.status(401).send('Unauthorized'); return; }
      const inProxyPrefix = url.pathname.startsWith(BASE + '_a/') || url.pathname.startsWith(BASE + '_p/');
      if (inProxyPrefix) return next();
      const inApi = url.pathname.startsWith(BASE + 'api/');
      const isCatalog = (req.method === 'GET' || req.method === 'HEAD') && url.pathname === BASE + 'api/apps';
      if (inApi && !isCatalog && !gatewayAllowed(req)) {
        res.status(401).send('Unauthorized');
        return;
      }
      return proceed();
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
app.set('json spaces', 2);
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

// Resolve the box's default app for a given requester: the first app (in catalog
// order) flagged `default: true` that this requester may actually reach. Returns
// null when none is configured or the configured one isn't visible to them.
function defaultAppKey(req: http.IncomingMessage): string | null {
  const allowed = TRUST_PROXY ? gatewayAllowed(req) : true;
  for (const [key, app] of Object.entries(loadApps())) {
    if (!app.default) continue;
    if (!allowed && !isPublicJoinable(app)) continue;
    return key;
  }
  return null;
}

// Serve the catalog page at /.
// When BASE != '/', also redirect /base -> /base/ to fix relative URL resolution.
router.get('/', (req: express.Request, res: express.Response) => {
  const reqUrl = new URL(req.originalUrl, `http://${req.headers.host}`);
  // Normalize /base -> /base/ (fixes relative URL resolution). Check the
  // pathname, not the whole URL — a query string like ?catalog must not be
  // mistaken for a missing trailing slash. Preserve the query across the hop.
  if (BASE !== '/' && !reqUrl.pathname.endsWith('/')) {
    res.redirect(301, BASE + reqUrl.search);
    return;
  }
  // Auto-open the default app unless the caller explicitly asked for the catalog
  // (?catalog). The back-to-catalog link in the app shell carries this param.
  const query = reqUrl.searchParams;
  if (!query.has('catalog')) {
    const def = defaultAppKey(req);
    if (def) { res.redirect(302, BASE + def); return; }
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

router.get('/api/apps', (req: express.Request, res: express.Response) => {
  const warnings: string[] = [];
  const apps = loadApps(warnings);
  // Non-allowed viewers (e.g. someone who can only reach this box's public
  // web apps) see only those public web apps. Skills and private apps are
  // hidden — the catalog client already collapses empty sections.
  const allowed = TRUST_PROXY ? gatewayAllowed(req) : true;
  const entries = Object.entries(apps).filter(([_, app]) => {
    if (allowed) return true;
    return isPublicJoinable(app);
  });
  const list = entries.map(([key, app]) => ({
    key,
    title: app.title ?? path.basename(app.command.split(/\s/)[0]),
    command: app.command,
    icon: app.icon ?? null,
    description: app.description ?? null,
    skill: app.skill ?? null,
    slashPrefix: app.slashPrefix ?? true,
    type: app.type ?? 'pty',
    access: app.access ?? null,
    hidden: app.hidden ? true : undefined,
    top: typeof app.top === 'number' && app.top > 0 ? app.top : undefined,
    default: app.default ? true : undefined,
    tips: Array.isArray(app.tips) && app.tips.length ? app.tips : undefined,
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

router.post('/api/apps/:key/top', (req: express.Request, res: express.Response) => {
  const appKey = req.params.key;
  const apps = loadApps();
  if (!apps[appKey]) { res.status(404).json({ error: 'App not found' }); return; }
  if (typeof apps[appKey].top === 'number' && apps[appKey].top! > 0) { res.json({ ok: true }); return; }

  // Find next available top value within the same section (skills vs apps)
  const isSkill = !!apps[appKey].skill;
  const maxTop = Math.max(0, ...Object.values(apps)
    .filter(a => !!a.skill === isSkill && typeof a.top === 'number' && a.top > 0)
    .map(a => a.top as number));

  const userDir = path.join(os.homedir(), '.wsh');
  const userFile = path.join(userDir, 'apps.yaml');
  let userConfig: Record<string, unknown> = {};
  try { userConfig = YAML.parse(fs.readFileSync(userFile, 'utf8')) ?? {}; } catch {}
  if (!userConfig[appKey] || typeof userConfig[appKey] !== 'object') {
    userConfig[appKey] = { top: maxTop + 1 };
  } else {
    (userConfig[appKey] as any).top = maxTop + 1;
  }
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(userFile, YAML.stringify(userConfig), 'utf8');
  res.json({ ok: true });
});

router.post('/api/apps/:key/untop', (req: express.Request, res: express.Response) => {
  const appKey = req.params.key;
  const apps = loadApps();
  if (!apps[appKey]) { res.status(404).json({ error: 'App not found' }); return; }
  if (!(typeof apps[appKey].top === 'number' && apps[appKey].top! > 0)) { res.json({ ok: true }); return; }

  // Check if system config has a top for this key
  const systemConfig = loadConfigFile(SYSTEM_CONFIG_DIR);
  const systemHasTop = systemConfig && typeof systemConfig === 'object' &&
    systemConfig[appKey] && typeof systemConfig[appKey] === 'object' &&
    typeof (systemConfig[appKey] as any).top === 'number' && (systemConfig[appKey] as any).top > 0;

  const userDir = path.join(os.homedir(), '.wsh');
  const userFile = path.join(userDir, 'apps.yaml');
  let userConfig: Record<string, unknown> = {};
  try { userConfig = YAML.parse(fs.readFileSync(userFile, 'utf8')) ?? {}; } catch {}
  if (!userConfig[appKey] || typeof userConfig[appKey] !== 'object') {
    userConfig[appKey] = { top: systemHasTop ? 0 : undefined };
  } else {
    if (systemHasTop) {
      (userConfig[appKey] as any).top = 0;
    } else {
      delete (userConfig[appKey] as any).top;
    }
  }
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(userFile, YAML.stringify(userConfig), 'utf8');
  res.json({ ok: true });
});

// Set an app as the box's default (catalog auto-opens it). Clears the flag from
// any app that currently resolves to default — a box has at most one — so this
// doubles as "reset the previous default". A default flagged in the read-only
// system config is overridden with `default: false` in the user layer.
router.post('/api/apps/:key/default', (req: express.Request, res: express.Response) => {
  const appKey = req.params.key;
  const apps = loadApps();
  if (!apps[appKey]) { res.status(404).json({ error: 'App not found' }); return; }
  if (apps[appKey].skill || (apps[appKey].type ?? 'pty') === 'job') {
    res.status(400).json({ error: 'Only pty or web apps can be the default app' }); return;
  }

  const systemConfig = (loadConfigFile(SYSTEM_CONFIG_DIR) ?? {}) as Record<string, any>;
  const userDir = path.join(os.homedir(), '.wsh');
  const userFile = path.join(userDir, 'apps.yaml');
  let userConfig: Record<string, any> = {};
  try { userConfig = YAML.parse(fs.readFileSync(userFile, 'utf8')) ?? {}; } catch {}

  const ensure = (k: string) => {
    if (!userConfig[k] || typeof userConfig[k] !== 'object') userConfig[k] = {};
    return userConfig[k] as Record<string, any>;
  };
  const clearDefault = (k: string) => {
    const sysDefault = systemConfig[k] && typeof systemConfig[k] === 'object' && systemConfig[k].default === true;
    if (sysDefault) ensure(k).default = false;                       // override the system default off
    else if (userConfig[k] && typeof userConfig[k] === 'object') delete userConfig[k].default;
  };

  // Reset any previous default, then flag the chosen app.
  for (const [k, app] of Object.entries(apps)) {
    if (k !== appKey && app.default) clearDefault(k);
  }
  ensure(appKey).default = true;

  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(userFile, YAML.stringify(userConfig), 'utf8');
  res.json({ ok: true });
});

router.post('/api/apps/:key/undefault', (req: express.Request, res: express.Response) => {
  const appKey = req.params.key;
  const apps = loadApps();
  if (!apps[appKey]) { res.status(404).json({ error: 'App not found' }); return; }
  if (!apps[appKey].default) { res.json({ ok: true }); return; }

  const systemConfig = (loadConfigFile(SYSTEM_CONFIG_DIR) ?? {}) as Record<string, any>;
  const userDir = path.join(os.homedir(), '.wsh');
  const userFile = path.join(userDir, 'apps.yaml');
  let userConfig: Record<string, any> = {};
  try { userConfig = YAML.parse(fs.readFileSync(userFile, 'utf8')) ?? {}; } catch {}

  const sysDefault = systemConfig[appKey] && typeof systemConfig[appKey] === 'object' && systemConfig[appKey].default === true;
  if (sysDefault) {
    if (!userConfig[appKey] || typeof userConfig[appKey] !== 'object') userConfig[appKey] = {};
    (userConfig[appKey] as any).default = false;
  } else if (userConfig[appKey] && typeof userConfig[appKey] === 'object') {
    delete (userConfig[appKey] as any).default;
  }

  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(userFile, YAML.stringify(userConfig), 'utf8');
  res.json({ ok: true });
});

/**
 * Merge one app entry into the user layer — the write half of `abox-cli push app`.
 *
 * The six toggles above set a single field on an app that already exists. This
 * one carries a whole definition from another box, so it differs in three ways
 * that are each load-bearing:
 *
 * 1. It writes through `parseDocument`, not `parse`/`stringify`. The toggles
 *    round-trip the file through plain JS objects, which silently drops every
 *    comment and reorders nothing back. That is tolerable for a button the user
 *    pressed on this box; it is not tolerable for a push, whose whole promise is
 *    to touch the one entry it names and leave the rest of the file as it found
 *    it. `~/.wsh/apps.yaml` ships from skel as a commented starter, so the
 *    comments being lost are usually the ones explaining the syntax.
 * 2. The entry is *replaced*, not field-merged. The pushing box's definition is
 *    the truth for that key — a field-merge would leave the target holding a
 *    hybrid of two boxes' configs that neither one has, and which no later push
 *    could clean up.
 * 3. It refuses keys the caller has no business defining: `_`-prefixed reserved
 *    keys, and any key the *system* layer defines. `abox-cli` refuses to send
 *    those too, and deliberately so — the two checks are independent, so neither
 *    side has to trust the other.
 */
router.post('/api/apps/:key', express.json({ limit: '256kb' }), (req: express.Request, res: express.Response) => {
  const appKey = req.params.key;

  // The key becomes a URL path segment (`${BASE}${appKey}`) and a YAML mapping
  // key, so it is constrained to what is safe as both.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(appKey)) {
    res.status(400).json({ error: 'Invalid app key' });
    return;
  }
  // `_skills` and friends are shared defaults for every skill app, not an app.
  // Replacing one from another box would silently repoint this box's agent.
  if (appKey.startsWith('_')) {
    res.status(400).json({ error: `${appKey} is a reserved key, not an app` });
    return;
  }
  const entry = req.body;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    res.status(400).json({ error: 'Body must be an app entry object' });
    return;
  }

  // A system app arrives with the image on both ends, so a copy could only
  // disagree with it — and the disagreement would win, since the user layer is
  // merged last.
  const systemConfig = (loadConfigFile(SYSTEM_CONFIG_DIR) ?? {}) as Record<string, any>;
  if (systemConfig[appKey]) {
    res.status(409).json({ error: `${appKey} is defined by this box's system config and ships with the image` });
    return;
  }

  const userDir = path.join(os.homedir(), '.wsh');
  const userFile = path.join(userDir, 'apps.yaml');
  // A missing file and an empty one are the same starting point. A file that
  // parsed to something other than a mapping is not: overwriting it would throw
  // away whatever the user actually had there.
  let doc: YAML.Document;
  try { doc = YAML.parseDocument(fs.readFileSync(userFile, 'utf8')); } catch { doc = new YAML.Document({}); }
  if (doc.contents === null) doc = new YAML.Document({});
  if (doc.errors?.length) {
    res.status(422).json({ error: `~/.wsh/apps.yaml does not parse: ${doc.errors[0].message}` });
    return;
  }
  if (!YAML.isMap(doc.contents)) {
    res.status(422).json({ error: '~/.wsh/apps.yaml root is not a mapping' });
    return;
  }

  const created = doc.get(appKey) === undefined;
  // Keep whatever this replaces. A card is the commit point of an entity push,
  // and it is the one thing either direction overwrites without asking — the
  // files beside it are classified and gated, the card is not. Until it goes
  // through the same guard, the least this can do is be recoverable.
  //
  // One card per file under the batch, rather than a copy of apps.yaml: what
  // someone wants back is the entry, and the surrounding document is already
  // whatever the merge left.
  if (!created) {
    const prev = doc.get(appKey);
    try {
      const stamp = pushTrashStamp();
      const dir = path.join(PUSH_TRASH_DIR, stamp, '.wsh', 'apps');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, `${appKey}.yaml`),
        new YAML.Document({ [appKey]: prev }).toString(), 'utf8');
    } catch (err) {
      // Best-effort, in one direction only: a card that cannot be set aside is
      // still merged. Refusing would make a box that cannot write its own trash
      // a box that cannot receive an app.
      console.error(`[apps] could not set aside ${appKey}: ${errorMessage(err)}`);
    }
  }
  doc.set(appKey, entry);
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(userFile, doc.toString(), 'utf8');
  // loadApps() reads this file on every request, so the card is live from here
  // — there is nothing to reload and nothing to restart.
  res.json({ ok: true, key: appKey, created });
});

router.get('/api/workspace', (req: express.Request, res: express.Response) => {
  const allowed = TRUST_PROXY ? gatewayAllowed(req) : true;
  if (!allowed) { res.status(403).json({ error: 'Forbidden' }); return; }
  const root = path.join(os.homedir(), 'workspace');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    res.json({ dirs: [], defaultAgent: null });
    return;
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      const full = path.join(root, e.name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      return { name: e.name, path: full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  // Resolve the default agent from _skills.agent (user yaml takes precedence over system)
  let defaultAgent: string | null = null;
  for (const config of [loadConfigFile(path.join(os.homedir(), '.wsh')), loadConfigFile(SYSTEM_CONFIG_DIR)]) {
    const raw = (config as any)?._skills;
    if (raw && typeof raw === 'object' && typeof raw.agent === 'string' && raw.agent) {
      defaultAgent = raw.agent;
      break;
    }
  }
  if (!defaultAgent) defaultAgent = 'claude-code';

  res.json({ dirs, defaultAgent });
});

function safeWorkspaceName(name: unknown): string | null {
  if (typeof name !== 'string' || !name) return null;
  if (name.length > 255) return null;
  if (name === '.' || name === '..') return null;
  if (name.startsWith('.') || name.startsWith('-')) return null;
  if (/[\/\\\x00-\x1f]/.test(name)) return null;
  return name;
}

router.post('/api/workspace/create', express.json(), (req: express.Request, res: express.Response) => {
  const allowed = TRUST_PROXY ? gatewayAllowed(req) : true;
  if (!allowed) { res.status(403).json({ error: 'Forbidden' }); return; }
  const name = safeWorkspaceName(req.body?.name);
  if (!name) { res.status(400).json({ error: 'Invalid name' }); return; }
  const root = path.join(os.homedir(), 'workspace');
  const target = path.join(root, name);
  if (fs.existsSync(target)) { res.status(409).json({ error: 'A directory with that name already exists' }); return; }
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(target);
    res.json({ ok: true, name, path: target });
  } catch (e) {
    res.status(500).json({ error: 'Create failed: ' + errorMessage(e) });
  }
});

router.post('/api/workspace/rename', express.json(), (req: express.Request, res: express.Response) => {
  const allowed = TRUST_PROXY ? gatewayAllowed(req) : true;
  if (!allowed) { res.status(403).json({ error: 'Forbidden' }); return; }
  const fromName = safeWorkspaceName(req.body?.from);
  const toName = safeWorkspaceName(req.body?.to);
  if (!fromName || !toName) { res.status(400).json({ error: 'Invalid name' }); return; }
  if (fromName === toName) { res.json({ ok: true }); return; }
  const root = path.join(os.homedir(), 'workspace');
  const fromPath = path.join(root, fromName);
  const toPath = path.join(root, toName);
  try {
    const stat = fs.statSync(fromPath);
    if (!stat.isDirectory()) { res.status(400).json({ error: 'Not a directory' }); return; }
  } catch {
    res.status(404).json({ error: 'Directory not found' }); return;
  }
  if (fs.existsSync(toPath)) { res.status(409).json({ error: 'A directory with that name already exists' }); return; }
  try {
    fs.renameSync(fromPath, toPath);
    res.json({ ok: true, name: toName, path: toPath });
  } catch (e) {
    res.status(500).json({ error: 'Rename failed: ' + errorMessage(e) });
  }
});

router.post('/api/workspace/delete', express.json(), (req: express.Request, res: express.Response) => {
  const allowed = TRUST_PROXY ? gatewayAllowed(req) : true;
  if (!allowed) { res.status(403).json({ error: 'Forbidden' }); return; }
  const name = safeWorkspaceName(req.body?.name);
  if (!name) { res.status(400).json({ error: 'Invalid name' }); return; }
  const root = path.join(os.homedir(), 'workspace');
  const fromPath = path.join(root, name);
  try {
    const stat = fs.statSync(fromPath);
    if (!stat.isDirectory()) { res.status(400).json({ error: 'Not a directory' }); return; }
  } catch {
    res.status(404).json({ error: 'Directory not found' }); return;
  }
  // Move to a trash dir instead of deleting outright — recoverable
  const trashRoot = path.join(os.homedir(), '.workspace-trash');
  try { fs.mkdirSync(trashRoot, { recursive: true }); } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashPath = path.join(trashRoot, `${stamp}-${name}`);
  try {
    fs.renameSync(fromPath, trashPath);
    res.json({ ok: true, trashPath });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed: ' + errorMessage(e) });
  }
});

router.get('/api/sessions', (req: express.Request, res: express.Response) => {
  // An idle daemon (no viewers) is hidden so it doesn't mark the box busy —
  // every busy/idle consumer reads this list. It reappears while actively
  // viewed (peers > 0), or with ?all=1 (the management view, e.g. `wsh ls --all`).
  const includeAll = req.query.all === '1';
  const list = [...sessions.entries()]
    .filter(([, s]) => includeAll || !s.daemon || s.peers.size > 0)
    .map(([id, s]) => ({
    id,
    title: s.title,
    app: s.app,
    appType: s.appType,
    daemon: s.daemon ?? false,
    pinned: s.pinned,
    peers: s.peers.size,
    hasWriter: s.writer !== null,
    createdAt: s.createdAt,
    lastInput: s.lastInput,
    lastOutput: s.lastOutput,
    pid: s.pty?.pid ?? s.child?.pid ?? null,
    scrollbackSize: s.scrollbackBytes,
    process: s.pty?.process ?? null,
    port: s.port ?? null,
    ready: s.ready ?? null,
    exitCode: s.exitCode ?? null,
    cwd: s.cwd ?? null,
    createdBy: s.createdBy ?? '',
    bytesIn: s.bytesIn ?? 0,
    bytesOut: s.bytesOut ?? 0,
  }));
  res.json({ sessions: list });
});

// Metrics: live-session snapshot. Drives the dashboard's "active right now"
// gauges. Cumulative byte totals; the rollup pipeline uses /api/metrics/events.
router.get('/api/metrics/sessions', (_req: express.Request, res: express.Response) => {
  const list = [...sessions.entries()].map(([id, s]) => ({
    id,
    app: s.app,
    binary: s.binary,
    appType: s.appType,
    user: s.createdBy || '',
    openedAt: Math.floor(s.createdAt / 1000),
    bytesIn: s.bytesIn ?? 0,
    bytesOut: s.bytesOut ?? 0,
  }));
  res.json({ ts: Math.floor(Date.now() / 1000), sessions: list });
});

// Metrics: cursor-paged read of the event log for the host collector. Each
// event carries its own resume cursor so the caller can stop on any line.
// `since` is opaque; "" starts from the oldest retained segment.
router.get('/api/metrics/events', (req: express.Request, res: express.Response) => {
  const since = typeof req.query.since === 'string' ? req.query.since : '';
  const { events, nextCursor } = metrics.readEvents(since);
  res.json({ events, nextCursor });
});

router.get('/api/sessions/:id/logs', (req: express.Request, res: express.Response) => {
  // Job log on disk: stream via held-open fd so rotation can't yank the file
  // mid-read (POSIX keeps the inode alive while the fd is open). Avoids the
  // O(file-size) memory peak and event-loop block of readFileSync.
  const logPath = path.join(JOB_LOG_DIR, `${req.params.id}.log`);
  let fd: number | null = null;
  try { fd = fs.openSync(logPath, 'r'); } catch {}
  if (fd !== null) {
    res.setHeader('Content-Type', 'application/octet-stream');
    const stream = fs.createReadStream('', { fd, autoClose: true });
    stream.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
    stream.pipe(res);
    return;
  }
  // Fall back to scrollback buffer (non-job sessions). In-memory and bounded
  // by MAX_SCROLLBACK, so synchronous send is fine.
  const session = sessions.get(req.params.id);
  if (session) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(scrollbackReplay(session) ?? Buffer.alloc(0));
    return;
  }
  res.status(404).json({ error: 'session not found' });
});

router.get('/api/sessions/:id/stream', (req: express.Request, res: express.Response) => {
  const id = req.params.id;
  const session = sessions.get(id);

  // Pty/web (in-memory, non-job) sessions: existing fake-peer path. Dispatching
  // by live appType ensures stale on-disk .log/.exit from a previous job with a
  // colliding ID can never reroute a live session into the job branch.
  if (session && session.appType !== 'job') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const replay = scrollbackReplay(session);
    if (replay) {
      res.write(`data: ${JSON.stringify({ text: replay.toString('utf8') })}\n\n`);
    }

    const fakeWs = {
      readyState: WebSocket.OPEN,
      send(data: Buffer | string, _opts?: any) {
        if (res.destroyed) return;
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : typeof data === 'string' ? data : '';
        if (text.startsWith('{')) {
          try {
            const parsed = JSON.parse(text);
            if (parsed.type) return; // Skip control messages
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
    return;
  }

  // Job branch: live or finished. For finished jobs the session is gone from
  // memory but .log / .exit persist; either is enough proof this id was a job.
  const logPath = path.join(JOB_LOG_DIR, `${id}.log`);
  const exitPath = path.join(JOB_LOG_DIR, `${id}.exit`);
  if (!session && !fs.existsSync(logPath) && !fs.existsSync(exitPath)) {
    res.status(404).json({ error: 'session not found' });
    return;
  }

  // Lazy reap: session-not-in-map + log-on-disk + no-.exit can only mean a
  // prior wsh-server crash mid-job — child.on('close') always writes .exit
  // before evicting from `sessions`. Synthesize a sentinel so tryFinish can
  // unblock waiting clients instead of polling forever.
  if (!session && fs.existsSync(logPath) && !fs.existsSync(exitPath)) {
    try { fs.writeFileSync(exitPath, '-1'); } catch {}
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Tail the disk log; finish when the .exit file appears. Disk is the source
  // of truth — every byte hits the log fd before any in-memory event would
  // fire — so polling the file works identically for live and finished jobs
  // and avoids subscribe/cleanup races. The fd is held open across ticks so
  // continued reads still work even after the job's writer fd is closed and
  // the file is potentially unlinked by rotateJobLogs.
  let logFd: number;
  try { logFd = fs.openSync(logPath, 'r'); }
  catch {
    // No log yet (brand-new job in the millisecond before first write). Close
    // cleanly with an empty body — the client can retry.
    if (!res.destroyed) { res.write('data: [DONE]\n\n'); res.end(); }
    return;
  }

  const MAX_READ_PER_TICK = 1 << 20; // 1 MiB cap protects against a job dumping gigabytes between ticks
  let offset = 0;
  let timer: NodeJS.Timeout | null = null;
  // Carries any incomplete trailing UTF-8 codepoint from one tick to the next
  // so toString('utf8') doesn't replace split bytes with U+FFFD.
  let utf8Pending: Buffer = Buffer.alloc(0);
  const cleanup = () => { if (timer) { clearTimeout(timer); timer = null; } try { fs.closeSync(logFd); } catch {} };

  // Returns true iff new bytes were emitted; drives the tryFinish gate below.
  const flush = (): boolean => {
    let stat;
    try { stat = fs.fstatSync(logFd); }
    catch (err) { console.error(`[session ${id}] stream stat failed:`, err); return false; }
    if (stat.size <= offset) return false;
    const want = Math.min(stat.size - offset, MAX_READ_PER_TICK);
    // allocUnsafe: readSync overwrites all `want` bytes (clamped to file size,
    // regular file → no short reads), so the zero-fill from alloc is wasted.
    const buf = Buffer.allocUnsafe(want);
    try { fs.readSync(logFd, buf, 0, want, offset); }
    catch (err) { console.error(`[session ${id}] stream read failed:`, err); return false; }
    offset += want;
    if (res.destroyed) return true;
    const raw = utf8Pending.length ? Buffer.concat([utf8Pending, buf]) : buf;
    const safeEnd = utf8SafeEnd(raw);
    utf8Pending = raw.subarray(safeEnd);
    const decodable = raw.subarray(0, safeEnd);
    if (decodable.length === 0) return true;  // nothing emittable; keep tail for next tick
    const text = stripEphemeralSequences(decodable).toString('utf8');
    if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
    return true;
  };

  const tryFinish = (): boolean => {
    // Fast path: session still alive and not exited yet. exitCode is set by
    // child.on('close') *before* .exit is written and *before* the session
    // is removed from the map, so undefined here is a reliable "still running".
    if (session && session.exitCode === undefined) return false;
    let exitContents;
    try { exitContents = fs.readFileSync(exitPath, 'utf8'); }
    catch { return false; }
    flush(); // drain any bytes appended after the .exit file was written
    if (!res.destroyed) {
      // Job ended; any bytes still in utf8Pending are genuinely truncated
      // (mid-codepoint at EOF). Emit them so toString can substitute U+FFFD —
      // that's the right answer for a malformed log.
      if (utf8Pending.length) {
        const tail = stripEphemeralSequences(utf8Pending).toString('utf8');
        if (tail) res.write(`data: ${JSON.stringify({ text: tail })}\n\n`);
        utf8Pending = Buffer.alloc(0);
      }
      res.write(`data: ${JSON.stringify({ exit: parseInt(exitContents.trim(), 10) })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    cleanup();
    return true;
  };

  // Recursive setTimeout (not setInterval) so a slow flush can't queue up
  // overlapping ticks. If the 1 MiB cap clipped this tick, reschedule
  // immediately to drain the backlog; otherwise back off to 100 ms.
  // Backpressure: park on 'drain' when the consumer is slow, so we don't
  // pump 1 MiB/tick into Node's HTTP send buffer for a stalled client.
  const tick = () => {
    if (res.destroyed) return;
    if (res.writableNeedDrain) {
      res.once('drain', tick);
      return;
    }
    const grew = flush();
    if (!grew && tryFinish()) return;
    let backlog = false;
    if (grew) {
      try { backlog = offset < fs.fstatSync(logFd).size; } catch {}
    }
    timer = setTimeout(tick, backlog ? 0 : 100);
  };

  if (flush() || !tryFinish()) {
    tick();
  }
  req.on('close', cleanup);
});

router.get('/api/sessions/:id/exit', (req: express.Request, res: express.Response) => {
  // Job exit code from disk. Durable: works any time after the job ends, and
  // survives wsh-server restarts. 404 distinguishes "still running" or "never
  // existed" from "ended with code N".
  const id = req.params.id;
  const exitPath = path.join(JOB_LOG_DIR, `${id}.exit`);
  let raw;
  try { raw = fs.readFileSync(exitPath, 'utf8'); }
  catch {
    // No .exit yet. child.on('close') always writes .exit before evicting from
    // sessions, so the only way (.exit missing && session not in map) can hold
    // is a wsh-server crash mid-job. Synthesize -1 in that case so callers
    // (re-attached followers, exitcode probes) terminate cleanly instead of
    // hanging or polling forever. Mirrors the lazy reap in /stream.
    if (sessions.get(id)) { res.status(404).json({ error: 'session still running' }); return; }
    const logPath = path.join(JOB_LOG_DIR, `${id}.log`);
    if (fs.existsSync(logPath)) {
      try { fs.writeFileSync(exitPath, '-1'); } catch {}
      res.json({ code: -1 });
      return;
    }
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const code = parseInt(raw.trim(), 10);
  if (Number.isNaN(code)) { res.status(500).json({ error: 'corrupt exit file' }); return; }
  res.json({ code });
});

// --- Events ---

router.post('/api/events', express.json(), (req: express.Request, res: express.Response) => {
  const { type, data } = req.body ?? {};
  if (!type || typeof type !== 'string') { res.status(400).json({ error: 'missing type' }); return; }
  if (!isValidEventType(type)) { res.status(400).json({ error: 'invalid type — must be lowercase namespace.action (2-4 dot-separated segments, e.g. "deploy.done")' }); return; }
  res.json(emitEvent(type, data));
});

router.get('/api/events', (req: express.Request, res: express.Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const filter = (req.query.filter as string) || '';
  const name = (req.query.name as string) || '';
  const since = req.query.since !== undefined ? Number(req.query.since) : (name ? getCursor(name) : Date.now());
  // Parse filters: comma-separated, "!" prefix for exclude, "*" suffix stripped
  const includes: string[] = [];
  const excludes: string[] = [];
  if (filter) {
    for (const f of filter.split(',')) {
      const trimmed = f.trim().replace(/\*$/, '');
      if (!trimmed) continue;
      if (trimmed.startsWith('!')) excludes.push(trimmed.slice(1));
      else includes.push(trimmed);
    }
  }
  const match = (e: WshEvent) => {
    if (excludes.some(p => e.type.startsWith(p))) return false;
    if (includes.length > 0) return includes.some(p => e.type.startsWith(p));
    return true;
  };

  // Client-side ack: when set, server skips cursor writes (client manages cursor locally)
  const clientAck = req.query.ack === 'client';

  // Replay from disk
  let lastReplayTs = since;
  for (const e of readSince(since)) {
    if (match(e)) res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (e.ts > lastReplayTs) lastReplayTs = e.ts;
  }
  if (name && !clientAck && lastReplayTs > since) setCursor(name, lastReplayTs);

  // Live subscription
  const unsub = onEvent((e) => {
    if (res.destroyed) return;
    if (match(e)) res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (name && !clientAck) setCursor(name, e.ts);
  });

  // Heartbeat
  const hb = setInterval(() => {
    if (!res.destroyed) res.write(': ping\n\n');
  }, 30_000);

  req.on('close', () => { unsub(); clearInterval(hb); });
});

router.delete('/api/sessions/:id', (req: express.Request, res: express.Response) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'session not found' }); return; }
  if (session.child) killProcessGroup(session.child);
  else if (session.pty) session.pty.kill('SIGHUP');
  res.json({ ok: true });
});

// Stream the request body into the job child's stdin. Pipes chunked bytes through
// without buffering, mirroring /api/push/apply's req.pipe pattern. Closing the
// request body cleanly closes the child's stdin (the child sees EOF). 410 if the
// session isn't a job or stdin is already closed (child exited / earlier POST
// already ended the pipe — stdin is one-shot per job).
router.post('/api/sessions/:id/stdin', (req: express.Request, res: express.Response) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'session not found' }); return; }
  if (session.appType !== 'job') {
    res.status(410).json({ error: 'stdin not supported for this session type' }); return;
  }
  const stdin = session.stdin;
  if (!stdin || stdin.writableEnded || stdin.destroyed) {
    res.status(410).json({ error: 'stdin closed' }); return;
  }

  let bytes = 0;
  let done = false;
  const finish = (status: number, body: Record<string, unknown>): void => {
    if (done) return;
    done = true;
    req.unpipe(stdin);
    if (!res.headersSent) res.status(status).json(body);
    else { try { res.end(); } catch {} }
  };

  req.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    session.bytesIn += chunk.length;
    session.lastInput = Date.now();
  });

  // { end: true } so the child sees EOF when the client finishes writing.
  req.pipe(stdin, { end: true });

  stdin.once('error', () => finish(410, { error: 'stdin closed', bytes }));
  req.on('error', (err) => finish(400, { error: errorMessage(err), bytes }));
  req.on('end',   ()    => finish(200, { bytes }));
});

// HTTP reverse proxy for web apps — must be before express.json() to preserve request body
function proxyHandler(req: express.Request, res: express.Response): void {
  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);
  if (!session || session.appType !== 'web' || !session.port) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  // Non-public web apps require owner-level access. In trust-proxy mode the
  // gateway has already evaluated identity + ACL — we just honor its verdict.
  if (session.access !== 'public') {
    if (TRUST_PROXY) {
      if (!verifyProxySecret(req) || !gatewayAllowed(req)) {
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
    proxyRes.on('data', (chunk: Buffer) => { session.bytesOut += chunk.length; });
    res.writeHead(proxyRes.statusCode!, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) res.status(502).send('Bad Gateway');
  });

  req.on('data', (chunk: Buffer) => { session.bytesIn += chunk.length; });
  req.pipe(proxyReq);
}

router.all('/_p/:sessionId', proxyHandler as any);
router.all('/_p/:sessionId/*', proxyHandler as any);

// Stable app-level proxy: /_a/<appKey>/... resolves to the singleton web session.
// Auto-starts the app if no session is running. Public apps are reachable by
// anyone the gateway forwarded; private apps require Allowed=1 even before
// auto-spawn (so a stranger can't trigger child processes).
function appProxyHandler(req: express.Request, res: express.Response): void {
  const appKey = req.params.appKey;
  const apps = loadApps();
  const appConfig = apps[appKey];
  if (!appConfig || appConfig.type !== 'web') {
    res.status(404).json({ error: 'web app not found' });
    return;
  }

  if (appConfig.access !== 'public') {
    if (TRUST_PROXY) {
      if (!verifyProxySecret(req) || !gatewayAllowed(req)) {
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

  // Resolve the singleton session, auto-starting it if absent. The guard
  // collapses concurrent first-hits onto one child (e.g. iframe + favicon).
  const id = crypto.randomInt(0, 2176782336).toString(36).padStart(6, '0');
  getOrSpawnWebSession(id, appKey, appConfig).then(({ id: sid }) => {
    req.params.sessionId = sid;
    proxyHandler(req, res);
  }).catch(() => {
    res.status(500).json({ error: 'Failed to start app' });
  });
}
router.all('/_a/:appKey', appProxyHandler as any);
router.all('/_a/:appKey/*', appProxyHandler as any);

// =================== PUSH (folder sync from abox-cli) ===================
// Three endpoints for `abox-cli push`:
//   POST /api/push/plan    v1. JSON in, JSON out — diff client manifest vs target tree
//   POST /api/push/plan2   v2. gzipped NDJSON in, JSON out — same diff, streamed
//   POST /api/push/apply   tar stream in — apply the diff, per file
// All gated by makeTokenMiddleware → gatewayAllowed (trust-proxy /api/* rule).
// Registered before express.json() so apply and plan2 can stream the body via
// req.pipe() and v1 plan can specify its own (larger) body-size limit.
//
// v1 buffers the whole manifest as one JSON body, which express caps at 50mb —
// about 400k entries, or a mid-sized box. Past that a push fails outright with
// a 413, which is why v2 exists: the manifest arrives as one gzipped NDJSON
// line per entry and is consumed against an already-built map of the target, so
// no array of client entries is ever materialized. v1 stays for older clients;
// a v2 client falls back to it on 404.

const PUSH_HOME = os.homedir();
const PUSH_PLAN_TTL_MS = 5 * 60 * 1000;
const PUSH_MTIME_TOL_NS = 1_000_000_000; // 1s — generous for cross-fs quirks
const PUSH_SENTINEL_ENTRY = '.abox-push-sentinel';
const PUSH_PRESERVED_SAMPLE = 50; // cap on the preserved-path list in a plan response
const PUSH_DELETE_SAMPLE = 200;  // cap on the leftover-path list in a v2 plan response
const PUSH_ROLLUP_GROUPS = 10;   // cap on the per-directory rollup of it
const PUSH_MAX_SKIP_PATTERNS = 1000; // cap on the client-supplied skip list
const PUSH_MAX_FILE_NAME = 255;      // one name component, the usual filesystem bound
// Ceiling on a v2 manifest, in entries. Not a memory bound — v2 holds no client
// array — but a runaway client shouldn't be able to spin the box forever.
const PUSH_MAX_MANIFEST_ENTRIES = 20_000_000;
// A file bigger than this is the one a client may cut into ranges, and so the
// only one worth stat-ing for a leftover partial when planning. It does not
// have to match the client's chunk size; a smaller value here only means
// offering resume information nobody asked for.
const PUSH_RANGE_MIN_BYTES = 256 * 1024 * 1024;
// PAX keys carrying a slice's place in its file. Extended headers rather than a
// mangled entry name, so the name stays the destination path and every existing
// check on it keeps applying unchanged.
const PUSH_RANGE_OFF_KEY = 'ABOX.range.off';
const PUSH_RANGE_TOTAL_KEY = 'ABOX.range.total';
// Suffix of the file a ranged upload accumulates into before it is renamed over
// the destination. The total rides in the name so a source that changed size
// between runs cannot resume onto a prefix of the old one: a different total is
// simply a different accumulator, and the stale one is swept when planning.
const PUSH_PARTIAL_SUFFIX = '.abox-partial-';

/** Name of the accumulator a ranged upload of `total` bytes appends into. */
function pushPartialName(base: string, total: number): string {
  return `${base}${PUSH_PARTIAL_SUFFIX}${total}`;
}

/** True for those accumulators, which belong to no tree but this one. */
function pushIsPartial(name: string): boolean {
  const i = name.lastIndexOf(PUSH_PARTIAL_SUFFIX);
  return i > 0 && /^\d+$/.test(name.slice(i + PUSH_PARTIAL_SUFFIX.length));
}

/**
 * The range a tar entry declares, or null for the ordinary whole-file entry
 * that every push carried before ranges existed.
 *
 * Both keys or neither: a half-declared range is a client bug, and guessing the
 * missing half would write bytes at an offset nobody chose.
 */
function pushEntryRange(header: TarHeaders): { off: number; total: number } | null {
  const pax = (header as { pax?: Record<string, string> }).pax;
  if (!pax) return null;
  const rawOff = pax[PUSH_RANGE_OFF_KEY];
  const rawTotal = pax[PUSH_RANGE_TOTAL_KEY];
  if (rawOff == null && rawTotal == null) return null;
  const off = Number(rawOff);
  const total = Number(rawTotal);
  if (!Number.isSafeInteger(off) || !Number.isSafeInteger(total) || off < 0 || total < 0 || off > total) {
    throw new Error(`bad range header on ${header.name}: off=${rawOff} total=${rawTotal}`);
  }
  return { off, total };
}
// zstd landed in Node 22.15 / 23.8, and @types/node here predates it. Probed
// rather than assumed for a better reason than the types, though: a released
// wsh bundles its own Node runtime, so what this file was compiled against says
// nothing about what will actually be there.
const zstdCapable = zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream };

// Compressions this box will accept on an apply body, best first. Advertised in
// the plan reply rather than negotiated by trial, because the alternative is
// discovering a box cannot decompress only after streaming gigabytes at it —
// and only ever advertising what this runtime can really do.
const PUSH_ACCEPT_ENCODING = [
  ...(typeof zstdCapable.createZstdDecompress === 'function' ? ['zstd'] : []),
  'gzip',
];

/** Wrap a request body in the decompressor its Content-Encoding calls for. */
function pushDecodeBody(req: express.Request): NodeJS.ReadableStream {
  const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase();
  if (!encoding || encoding === 'identity') return req;
  let decoder: NodeJS.ReadWriteStream | null = null;
  if (encoding === 'gzip') decoder = zlib.createGunzip();
  else if (encoding === 'zstd' && zstdCapable.createZstdDecompress) decoder = zstdCapable.createZstdDecompress();
  if (!decoder) throw new Error(`unsupported Content-Encoding: ${encoding}`);
  req.pipe(decoder);
  return decoder;
}
// A plan outlives its own diff by long enough to upload everything it named.
// The 5-minute floor covers a small push; past that the allowance scales with
// the payload, because a chunked apply keeps coming back to the same plan and
// chunk 40 must not find it swept. Deliberately generous: the cost of a stale
// plan is a map entry, the cost of an expired one is re-sending gigabytes.
const PUSH_PLAN_TTL_BYTES_PER_MS = 1024; // ≈1 MB/s floor on assumed throughput
const PUSH_PLAN_TTL_MAX_MS = 12 * 60 * 60 * 1000;
// `rel` for a whole-box push, where the pushed directory *is* $HOME.
const PUSH_HOME_REL = '.';
// Where the box's deny rules live. Overridable only from the environment wsh
// was launched with — i.e. by the image or the box owner, the same trust level
// as the rule files themselves. Deliberately not reachable from a request: the
// point of the rules is that a pushing client cannot opt out of them.
const PUSH_IGNORE_DIR = process.env.ABOX_PUSH_IGNORE_DIR || PUSH_IGNORE_DEFAULT_DIR;
// Image-owned repair script, run once a push has finished writing. Same
// environment-only override as the rule directory, and for the same reason:
// the box owner may relocate it, a pushing client may not.
const PUSH_POSTFIX_HOOK = process.env.ABOX_PUSH_POSTFIX_HOOK || PUSH_POSTFIX_DEFAULT_HOOK;

type PushType = 'file' | 'dir' | 'symlink';

interface PushEntry {
  path: string;        // forward-slash, relative to target
  type: PushType;
  size?: number;
  mtime_ns?: number;   // unix ns
  mode?: number;       // permission bits
  target?: string;     // symlinks
  sha256?: string;     // when --checksum
}

/**
 * What a plan should record once it has fully landed, from the client that
 * asked for it. Absent when the client keeps no records or the box was told
 * nothing — an older client, or one that could not determine its own replica.
 *
 * The box supplies the other half itself, from a re-walk taken after the repair
 * hook has run. A hash derived from the plan would report "box moved" forever
 * on exactly the files the hook exists to rewrite.
 */
interface PushRecordIntent {
  replica: string;
  skipFp: string;
  localHash: string;
  /** The client's skip list, needed again to filter the re-walk. */
  skip: string[];
}

interface PushPlan {
  target: string;
  // Target's path relative to $HOME. Deny rules are written against $HOME, so
  // apply needs this to reconstruct the same path form plan matched on.
  rel: string;
  // Single-file push: the one name under `target` this plan may write, or ''
  // for an ordinary tree push. See pushFileName for what the mode changes.
  file: string;
  // Counts, not paths. apply never reads the add/update path lists — only their
  // lengths, for its response — so keeping the arrays would hold hundreds of
  // megabytes of strings alive for the plan's whole lifetime to report two
  // integers. The client addresses what it sends by manifest position instead.
  addCount: number;
  updateCount: number;
  delete: string[];
  expiresAt: number;
  // The deny rules this plan was computed with. Captured at plan time rather
  // than re-read at apply time so the two phases can't disagree if the image's
  // rule files change underneath a push in flight.
  deny: PushIgnoreRule[];
  // Whether this plan acts on the leftovers. Recorded alongside the hashes, so
  // a later `push --delete` can tell "both sides are where we left them" from
  // "both sides are where we left them, as an overlay we now want collapsed".
  deletes: boolean;
  /** Null when nothing should be recorded. See PushRecordIntent. */
  record: PushRecordIntent | null;
  /**
   * The record's running fold, carried across a chunked apply. Mutated in
   * place as each chunk promotes, finalized on the last one.
   */
  recordHash: { acc: string; count: number } | null;
  // Keep what this push overwrites or removes. On unless the client opted out;
  // the batch name is fixed at plan time so every chunk of one push displaces
  // into the same place.
  trash: string | null;
}

/**
 * Growable bitmap over manifest positions, base64 on the wire.
 *
 * The plan answers "which of the entries you just sent should you upload?", and
 * the client still holds that manifest in order, so positions say it in a byte
 * per eight entries instead of a JSON array of paths — ~375 KB rather than
 * ~200 MB on a 3M-file first push. Sparse pushes stay small too: a bitmap of
 * mostly zeroes is what transport gzip is best at.
 */
class PushBitmap {
  private buf = Buffer.alloc(4096);
  private max = -1;
  set(i: number): void {
    const byte = i >> 3;
    if (byte >= this.buf.length) {
      const grown = Buffer.alloc(Math.max(this.buf.length * 2, byte + 1));
      this.buf.copy(grown);
      this.buf = grown;
    }
    this.buf[byte] |= 1 << (i & 7);
    if (i > this.max) this.max = i;
  }
  /** Trailing zero bytes are dropped; a bitmap with nothing set is ''. */
  toBase64(): string {
    return this.buf.subarray(0, (this.max >> 3) + 1).toString('base64');
  }
}

/**
 * Whether an operator has quiesced this box (`abox edge lock`).
 *
 * Read per plan rather than cached: a lock is applied precisely in order to
 * change what the next command may do, and a stale "no" here is a refusal an
 * operator cannot clear without restarting wsh.
 */
function pushBoxLocked(): boolean {
  try {
    fs.statSync(path.join(PUSH_HOME, '.abox', 'locked'));
    return true;
  } catch {
    return false;
  }
}

const pushPlans = new Map<string, PushPlan>();
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pushPlans) if (p.expiresAt < now) pushPlans.delete(id);
  // A push that died between chunks holds its tree until something says
  // otherwise, and its plan's TTL scales with the payload — hours, for the
  // large pushes that chunk in the first place.
  for (const [id, r] of pushActiveApplies) {
    if (r.inFlight === 0 && now - r.lastAt > PUSH_APPLY_IDLE_MS) pushActiveApplies.delete(id);
  }
}, 60_000).unref();

// Trees being written to right now, by plan.
//
// A conflict is only declared while a request is actually in flight, and that
// is a deliberate limit rather than an oversight. The tighter rule — hold from
// a plan's first apply to its last, covering the gaps between chunks — was
// tried and is worse: an interrupted push leaves a plan mid-sequence, and the
// next thing the user does is re-run to continue, which is how resume works
// here. Any reservation that outlives a request answers that re-run with 409,
// and no timeout separates the two cases, because a re-run and the next chunk
// arrive equally fast.
//
// What the gap actually exposes is narrower than it looks: a plan's delete list
// is computed at plan time, so a file another push creates in a gap is not in
// it and cannot be deleted by it. What remains is last-writer-wins on a file
// both pushes carry, which is inherent to any concurrent sync.
//
// The map is keyed by plan so a push's own later chunks never conflict with it,
// and `lastAt` lets the sweeper drop the record for a client that died.
interface PushReservation { target: string; inFlight: number; lastAt: number }
const pushActiveApplies = new Map<string, PushReservation>();
const PUSH_APPLY_IDLE_MS = 2 * 60 * 1000;

/**
 * Report an in-flight apply whose tree overlaps `target`, if any.
 *
 * Scoped to applies in flight, deliberately, and not to live plans. Holding a
 * tree from plan time would look more careful and would be worse: a push that
 * dies mid-upload leaves its plan behind, and the very next thing the user does
 * is re-run the command to continue — which is how resume works here, since the
 * files that landed already match and simply are not listed again. A plan-time
 * lock would answer that re-run with 409 and make the headline recovery path
 * the one thing you cannot do.
 *
 * What is left unguarded is a stale delete list: A plans, B writes a file A
 * never saw, A's final apply removes it. That needs two people pushing
 * overlapping trees at once, and the dangerous half of it — a whole-box push
 * deleting — is already off by default. Worth accepting to keep re-runs free.
 *
 * Overlap means one tree contains the other; disjoint subdirectories may run
 * together. $HOME contains everything, so a whole-box push conflicts with all.
 *
 * This is also what makes the staging sweep safe. Between chunks there are no
 * staging directories — each apply cleans up its own — so anything found while
 * no overlapping apply is running was orphaned by a handler that died.
 */
function pushOverlapping(target: string, selfPlanId?: string): string | null {
  for (const [planId, r] of pushActiveApplies) {
    if (planId === selfPlanId) continue; // our own chunks are not a conflict
    if (r.inFlight === 0) continue;     // between chunks — see the note above
    if (r.target === target ||
        target.startsWith(r.target + path.sep) ||
        r.target.startsWith(target + path.sep)) {
      return r.target;
    }
  }
  return null;
}

/** Recursive size of a directory, for reporting what a sweep reclaimed. */
async function pushDirBytes(dir: string): Promise<number> {
  let total = 0;
  let ents: fs.Dirent[];
  try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch { return 0; }
  for (const ent of ents) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) { total += await pushDirBytes(abs); continue; }
    try { total += (await fs.promises.lstat(abs)).size; } catch {}
  }
  return total;
}

/**
 * Delete orphaned staging directories, returning the bytes reclaimed.
 *
 * `cleanup()` in apply only runs if the handler survives to run it. A wsh crash
 * or a container restart mid-push leaves .abox-push-staging-<uuid>/ behind
 * holding up to a chunk's worth of data — and because both walks skip that name
 * prefix, push itself can never see it, never diffs it, and never deletes it.
 * Nothing else would ever reclaim it, and the space it holds is exactly the
 * headroom the next push needs.
 */
async function pushSweepStaging(dirs: string[]): Promise<number> {
  let reclaimed = 0;
  for (const dir of dirs) {
    reclaimed += await pushDirBytes(dir);
    try { await fs.promises.rm(dir, { recursive: true, force: true }); }
    catch (err) { console.error(`[push] sweep failed dir=${dir}: ${errorMessage(err)}`); }
  }
  return reclaimed;
}

/** Validate client-supplied target. Must canonicalize strictly under $HOME, equal
 *  $HOME/<rel>, and rel must be relative with no `..` components. */
function pushSafeTarget(target: string, rel: string, home: boolean): string | null {
  if (!target || !target.startsWith('/')) return null;
  if (home) {
    // Whole-box push. Reachable only when the client asks for it by name, so a
    // client that miscomputes `rel` still cannot slide into syncing over $HOME
    // by accident — which is what the blanket rejection below existed to stop.
    return rel === PUSH_HOME_REL && path.resolve(target) === PUSH_HOME ? PUSH_HOME : null;
  }
  if (!rel || rel.startsWith('/') || rel.split('/').some(s => s === '..' || s === '')) return null;
  const cleaned = path.resolve(target);
  if (cleaned === PUSH_HOME) return null;
  if (!cleaned.startsWith(PUSH_HOME + path.sep)) return null;
  if (path.resolve(path.join(PUSH_HOME, rel)) !== cleaned) return null;
  return cleaned;
}

/**
 * Validate the header's `file`: a single-file push, where `target` is still the
 * containing directory and this is the one name in it the push may touch.
 *
 * The mode exists because `abox-cli push ~/.zshrc` is otherwise indistinguishable
 * from replicating a home directory. Its target is `$HOME`, so it needs
 * `home: true` to pass pushSafeTarget, and `rel` is then `.` — which is exactly
 * what the postfix hook keys on. Copying one file would run the box's repair
 * script and rewrite config the push never mentioned. So the client says which
 * kind of push it is, and the box acts on it: no hook, no deletes, and no walk
 * of the containing directory (one lstat is the whole diff — a file in a
 * 200k-file tree costs what a file should).
 *
 * A single segment, so the name cannot climb out of the directory the target
 * check already validated. That bound is what makes relaxing anything else
 * safe: with apply pinned to this one entry (see the extract loop), a file-mode
 * push into `$HOME` can write `$HOME/<file>` and nothing else at all.
 *
 * Returns the name, '' when absent, or null when malformed.
 */
function pushFileName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') return null;
  if (value.includes('/') || value === '.' || value === '..') return null;
  if (value.length > PUSH_MAX_FILE_NAME) return null;
  return value;
}

// --- Path frames ---
//
// A push carries paths in two frames and they are easy to confuse. Manifest
// entries, add/update/delete and tar entry names are relative to the *pushed
// directory*; deny rules, `preserved` and the post-push hook are relative to
// *$HOME*, because a rule like `/.trae/traecli.yaml` names a location in a box
// rather than a location in whatever the user happened to push.
//
// Getting that wrong fails OPEN — the rule simply doesn't fire and nothing
// errors — which it did twice: once matching deny against the push-root form
// (so `cd ~/.trae && push` walked straight past every rule) and once joining
// `${rel}/${p}` on a whole-box push (yielding './x', matching no anchored rule,
// disarming deny on the one shape it exists for).
//
// So no call site chooses a frame. Every rule set — the box's and the client's
// alike — is written against $HOME and matched through pushRuleHit below;
// callers hand over the path exactly as the manifest or the tar names it, and
// the whole-box special case lives in one expression.

/**
 * Prefix turning a push-root-relative path into its $HOME-relative form. Empty
 * for a whole-box push, where the two frames coincide. Computed once per push.
 */
function pushHomePrefix(rel: string): string {
  return rel === PUSH_HOME_REL ? '' : rel + '/';
}

/**
 * The one place a path is converted for matching. Both rule sets — the box's
 * deny rules and the client's skip list — are written against $HOME, so both
 * come through here and no call site ever picks a frame. Returns the matched
 * path together with the rule that matched it, or null.
 */
function pushRuleHit(
  rules: PushIgnoreRule[],
  homePrefix: string,
  local: string,
  isDir: boolean,
): { home: string; rule: PushIgnoreRule } | null {
  const home = homePrefix + local;
  const rule = pushIgnored(rules, home, isDir);
  return rule ? { home, rule } : null;
}

// How many lstats the target walk keeps in flight. The walk is one `await` per
// entry otherwise, which on a box-sized tree spends most of its wall clock
// waiting on libuv's threadpool one syscall at a time.
const PUSH_WALK_CONCURRENCY = 32;

/** Run `fn` over `items` with at most `limit` in flight. Rejects on first error. */
async function pushMapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/**
 * Walk `dir` recursively. Treat missing as empty. Returns the manifest plus the
 * absolute paths of any `.abox-push-staging-*` directories found on the way.
 *
 * `hide` is the ignore filter, applied *during* traversal rather than to the
 * finished list: a hidden directory is neither emitted nor descended. That is
 * only sound because the grammar has no negation to re-include something
 * underneath it, and it is the difference between reading an excluded
 * node_modules and stepping over it.
 *
 * Directories are never lstat'd — the dirent already says it is one, and
 * pushCompare ignores directory mode, so the stat would buy nothing.
 */
async function pushWalk(
  dir: string,
  hide: (rel: string, isDir: boolean) => boolean,
): Promise<{ entries: PushEntry[]; staging: string[] }> {
  const out: PushEntry[] = [];
  const staging: string[] = [];

  async function visit(abs: string, rel: string): Promise<void> {
    let ents: fs.Dirent[];
    try { ents = await fs.promises.readdir(abs, { withFileTypes: true }); }
    catch { return; }

    // Results land in fixed slots so the manifest stays in readdir order
    // regardless of which lstat finishes first.
    const slots: (PushEntry | null)[] = new Array(ents.length).fill(null);
    const jobs: [number, string][] = [];
    const subdirs: [string, string][] = [];

    for (let i = 0; i < ents.length; i++) {
      const ent = ents[i];
      if (ent.name.startsWith('.abox-push-staging-')) { staging.push(path.join(abs, ent.name)); continue; }
      // A ranged upload's accumulator. Hidden from the manifest for the same
      // reason staging is: it is this protocol's scratch, not the user's tree.
      // Reporting it would make the next plan want to delete it — and a
      // resumable upload that the resume deletes is worse than none.
      if (ent.isFile() && pushIsPartial(ent.name)) continue;
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        if (hide(childRel, true)) continue;
        slots[i] = { path: childRel, type: 'dir' };
        subdirs.push([path.join(abs, ent.name), childRel]);
        continue;
      }
      // Files, symlinks, and DT_UNKNOWN alike: resolved in the concurrent pass.
      // The path is carried along rather than rebuilt there — one wasted concat
      // per file is a million wasted strings on a box-sized tree.
      jobs.push([i, childRel]);
    }

    await pushMapLimit(jobs, PUSH_WALK_CONCURRENCY, async ([i, childRel]) => {
      const ent = ents[i];
      const childAbs = path.join(abs, ent.name);
      let st: fs.Stats;
      try { st = await fs.promises.lstat(childAbs); } catch { return; }

      if (st.isSymbolicLink()) {
        // A dir-only rule (`build/`) has to fire on a symlink that leads to a
        // directory, because the pushing client's walk resolves it the same way
        // — and a path one walk hides while the other reports is precisely the
        // disagreement the diff resolves by deleting it.
        let pointsAtDir = false;
        try { pointsAtDir = (await fs.promises.stat(childAbs)).isDirectory(); } catch {}
        if (hide(childRel, pointsAtDir)) return;
        let linkTarget = '';
        try { linkTarget = await fs.promises.readlink(childAbs); } catch {}
        slots[i] = { path: childRel, type: 'symlink', target: linkTarget };
        return;
      }
      if (st.isDirectory()) { // DT_UNKNOWN that turned out to be a directory
        if (hide(childRel, true)) return;
        slots[i] = { path: childRel, type: 'dir' };
        subdirs.push([childAbs, childRel]);
        return;
      }
      if (!st.isFile()) return; // sockets / devices / FIFOs
      if (hide(childRel, false)) return;
      slots[i] = {
        path:     childRel,
        type:     'file',
        size:     st.size,
        mtime_ns: Math.round(st.mtimeMs * 1e6),
        mode:     st.mode & 0o777,
      };
    });

    for (const s of slots) if (s) out.push(s);
    for (const [a, r] of subdirs) await visit(a, r);
  }

  await visit(dir, '');
  return { entries: out, staging };
}

/**
 * The box's copy of one named entry, for a single-file push — pushWalk's
 * per-entry shape without the directory it walks.
 *
 * Nothing hides a path here. The tree walk applies deny and skip so the diff
 * doesn't read a hidden file as "deleted upstream", but a one-file push deletes
 * nothing, and the client's entry is filtered by deny in pushBuildPlan either
 * way — so the only thing hiding this one could change is whether the push
 * needlessly re-uploads a file the box already has.
 */
async function pushStatOne(dir: string, name: string): Promise<PushEntry | undefined> {
  const abs = path.join(dir, name);
  let st: fs.Stats;
  try { st = await fs.promises.lstat(abs); } catch { return undefined; }
  if (st.isSymbolicLink()) {
    let linkTarget = '';
    try { linkTarget = await fs.promises.readlink(abs); } catch {}
    return { path: name, type: 'symlink', target: linkTarget };
  }
  if (st.isDirectory()) return { path: name, type: 'dir' };
  if (!st.isFile()) return undefined; // sockets / devices / FIFOs
  return {
    path:     name,
    type:     'file',
    size:     st.size,
    mtime_ns: Math.round(st.mtimeMs * 1e6),
    mode:     st.mode & 0o777,
  };
}

/**
 * One client entry against the target's copy.
 *
 * null means "already identical". 'verify' means metadata says identical and
 * the client asked us not to take metadata's word for it — the caller resolves
 * that by hashing the box's copy (see pushVerifyChecksum).
 *
 * That extra verdict exists because the box has no content hash to compare
 * against here: pushWalk reports size, mtime and mode, never sha256. The
 * original `checksum && c.sha256 && s.sha256 && ...` test therefore could never
 * fire — `s.sha256` is never assigned anywhere on this side — so `--checksum`
 * silently did nothing at all while costing the client a full read of every
 * file it pushed. Deciding here and hashing in the caller keeps the comparison
 * itself synchronous and total.
 */
function pushCompare(c: PushEntry, s: PushEntry | undefined, checksum: boolean): 'add' | 'update' | 'verify' | null {
  if (!s) return 'add';
  if (c.type !== s.type) return 'update';
  if (c.type === 'file') {
    // Treat a missing size as 0 on both sides — the client omits size for
    // 0-byte files (json:"size,omitempty"), so mismatched sentinels would
    // flag every empty file as a perpetual update.
    const sizeDiff = (c.size ?? 0) !== (s.size ?? 0);
    const mtDiff   = Math.abs((c.mtime_ns ?? 0) - (s.mtime_ns ?? 0)) > PUSH_MTIME_TOL_NS;
    if (sizeDiff || mtDiff) return 'update';
    // Only a file the metadata calls identical is worth hashing: anything else
    // is already an update, and hashing it could not change that.
    return checksum && !!c.sha256 ? 'verify' : null;
  }
  if (c.type === 'symlink') return (c.target ?? '') !== (s.target ?? '') ? 'update' : null;
  return null; // dirs: mode-only changes ignored
}

/**
 * Hash the box's copy of one file and say whether it differs from the client's.
 *
 * A read of the file is what `--checksum` is buying, so it is only spent on the
 * entries where it can change the answer. An unreadable file counts as
 * different: re-sending a file we cannot verify is the safe direction, and the
 * alternative is a push that silently skips exactly the files it could not read.
 */
async function pushVerifyChecksum(abs: string, want: string): Promise<boolean> {
  try {
    const h = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const r = fs.createReadStream(abs);
      r.on('data', (chunk) => h.update(chunk));
      r.on('error', reject);
      r.on('end', () => resolve());
    });
    return h.digest('hex') !== want;
  } catch {
    return true;
  }
}

/**
 * Validate one decoded NDJSON manifest value as a PushEntry, or throw.
 *
 * Takes the already-parsed value rather than the line: pushReadNdjson has
 * parsed it once, and on the 3M-entry push this endpoint exists for, a
 * re-stringify and re-parse per entry is the dominant cost of the loop.
 *
 * Paths are checked for `..` and absolute forms here even though nothing in the
 * plan phase dereferences them — a path like that can only be a broken client
 * or a probe, and letting it through would mean apply is the only thing
 * standing between it and the filesystem.
 */
function pushParseEntry(value: unknown): PushEntry {
  const e = value as PushEntry;
  if (!e || typeof e !== 'object' || typeof e.path !== 'string' || !e.path) {
    throw new Error('manifest entry needs a non-empty string path');
  }
  if (e.type !== 'file' && e.type !== 'dir' && e.type !== 'symlink') {
    throw new Error(`manifest entry ${e.path} has unknown type ${String(e.type)}`);
  }
  if (e.path.startsWith('/') || e.path.split('/').some(s => s === '..' || s === '')) {
    throw new Error(`unsafe manifest path: ${e.path}`);
  }
  return e;
}

/**
 * Read a request body as NDJSON, one parsed value per line, honouring
 * Content-Encoding: gzip. Errors on the decompression stream surface as a throw
 * from the iteration rather than an unhandled 'error' event.
 */
async function* pushReadNdjson(req: express.Request): AsyncGenerator<unknown> {
  const src = pushDecodeBody(req);
  let streamErr: Error | null = null;
  const rl = readline.createInterface({ input: src, crlfDelay: Infinity });
  src.on('error', (e: Error) => { streamErr = e; rl.close(); });
  for await (const line of rl) {
    if (streamErr) break;
    if (line) yield JSON.parse(line);
  }
  if (streamErr) throw streamErr;
}

interface PushPlanBuild {
  planId: string;
  manifestCount: number;
  addBits: string;
  updateBits: string;
  addCount: number;
  updateCount: number;
  addPaths: string[];
  updatePaths: string[];
  // Everything the target holds that the client did not send. One set: whether
  // it gets deleted or merely reported is the caller's policy, not a second
  // kind of thing. Splitting it produced two names for one list and left the
  // whole-box push — the case with tens of thousands of paths and the default
  // most in need of explaining — with no rollup at all.
  leftover: string[];
  bytesToSend: number;
  expiresAt: number;
  preserved: string[];
  reclaimedBytes: number;
  // Verified prefixes this target already holds for files the plan wants, by
  // rel path. Only files big enough to be ranged are looked for, so the common
  // push pays one map allocation and no stats at all.
  partials: Record<string, number>;
  // The box's own entries for everything a pull would carry, and their total
  // size. Empty unless the caller asked — a push never looks at the box's
  // version of a file it is about to replace.
  pullFetch: PushEntry[];
  pullBytes: number;
  /** Hash of the box's whole tree from this walk. '' unless hashTree. */
  treeHash: string;
  /** How many entries that walk saw — "is the destination empty". */
  treeCount: number;
  /**
   * The running fold for the record: this walk, minus everything the push is
   * about to replace or remove. Apply folds in what it writes. Null when no
   * record is wanted.
   */
  recordHash: { acc: string; count: number } | null;
}

/**
 * The diff, shared by both plan endpoints.
 *
 * The target tree is walked into a map first and the client's manifest is then
 * consumed *against* it, so no array of client entries is ever built: v2 reads
 * them straight off the socket. What survives the loop is two bitmaps, two
 * counts, and whatever of the target the client never mentioned — the deletes.
 *
 * The deny list is applied to both sides. Filtering only the client's would
 * still leave the target's copy absent from the manifest, and the leftover pass
 * would put it in `delete` — wiping the very file the rule protects. Rules are
 * written against $HOME (`/.trae/traecli.yaml` means ~/.trae/…) while manifest
 * paths are relative to the pushed directory, so both are converted before
 * matching; otherwise `cd ~/.trae && abox-cli push` sends a manifest whose only
 * entry is `traecli.yaml`, which no anchored rule can match.
 */
async function pushBuildPlan(opts: {
  target: string;
  rel: string;
  checksum: boolean;
  skipPatterns: string[];
  // Either shape: v2 streams off the socket, v1 hands over the array
  // express already parsed. `for await` accepts both.
  entries: AsyncIterable<PushEntry> | Iterable<PushEntry>;
  collectPaths: boolean; // v1 answers in paths and has to keep them
  deletes: boolean;      // false → report the leftovers instead of removing them
  sweep: boolean;        // false for a dry run, which must change nothing
  trash: boolean;        // this push will displace rather than destroy
  // Collect the BOX's copy of everything the client would need to become a
  // mirror of it — the other half of the same comparison. Off for a push, which
  // never looks at the box's version of a file it is about to replace.
  //
  // Sharing the walk rather than writing a second one is the point: the deny
  // filter, the skip filter and the held-ancestor rule are subtle and they must
  // mean the same thing in both directions, or a path one direction protects
  // the other one moves.
  pull: boolean;
  // Hash the box's tree from this walk. Wanted by a pull (the client records
  // it) and by any push carrying a record intent (it is the box's half of who
  // moved). A whole-box push asks for neither and skips it.
  hashTree: boolean;
  deny: PushIgnoreRule[];
  file: string;          // single-file push: the one name under target, else ''
}): Promise<PushPlanBuild> {
  const homePrefix = pushHomePrefix(opts.rel);
  const preserved = new Set<string>();  // $HOME-relative, deny only, reported back
  const heldLocal = new Set<string>();  // push-root-relative, deny ∪ skip, guards deletes

  const denied = (p: string, isDir: boolean): boolean => {
    const hit = pushRuleHit(opts.deny, homePrefix, p, isDir);
    if (!hit) return false;
    preserved.add(hit.home);
    heldLocal.add(p);
    return true;
  };
  // The client's own skip list (~/.aboxignore, --exclude), shipped with the
  // manifest. It only ever filters the TARGET's walk — the client already left
  // those paths out. Without this the diff sees them present on the box and
  // missing upstream and schedules them for deletion, so "ignore node_modules"
  // would mean "delete node_modules on the box".
  const skip = compilePushIgnore(opts.skipPatterns.join('\n'), 'client skip list');
  const skipped = (p: string, isDir: boolean): boolean => {
    if (!pushRuleHit(skip, homePrefix, p, isDir)) return false;
    heldLocal.add(p);
    return true;
  };

  // A single-file push diffs one path, so it neither walks the containing
  // directory nor sweeps the staging directories such a walk would have found.
  // Both are the tree push's business: the sweep is a side effect of having
  // read every entry anyway, and paying for a 200k-entry readdir to answer a
  // question about one file is the cost this mode exists to avoid.
  let serverEntries: PushEntry[];
  let reclaimedBytes = 0;
  if (opts.file) {
    const one = await pushStatOne(opts.target, opts.file);
    // Promote renames the staged file over the target, which fails on a
    // directory — and a mode that never deletes has nothing that could clear
    // the way. Refused here so it reads as a fact about the box rather than as
    // an ENOTEMPTY from the far end of an upload.
    if (one?.type === 'dir') {
      throw new Error(`${opts.file} is a directory on the box — a single-file push cannot replace it`);
    }
    serverEntries = one ? [one] : [];
  } else {
    const walked = await pushWalk(
      opts.target,
      (p, isDir) => denied(p, isDir) || skipped(p, isDir),
    );
    serverEntries = walked.entries;
    reclaimedBytes = opts.sweep ? await pushSweepStaging(walked.staging) : 0;
  }
  // Swept before the apply rather than after it, so a second mirror does not
  // stack on the first one's trash — which is precisely the sequence that would
  // otherwise run a box out of disk, since the second mirror is also the one
  // with the most to displace. Not gated on `deletes`: an overwrite fills the
  // trash just as surely as a removal does.
  //
  // Never for a single-file push, though. The sweep sizes every batch it is
  // considering, which on a large trash is tens of thousands of stats — and it
  // runs before the manifest is even read, so the client's upload stalls behind
  // it. File mode exists precisely so that copying one file costs what one file
  // costs; paying a directory walk here would hand that back, for a push that
  // can displace at most one file.
  if (opts.sweep && opts.trash && !opts.file) {
    reclaimedBytes += await pushTrashSweep();
  }
  const sMap = new Map<string, PushEntry>();
  for (const e of serverEntries) sMap.set(e.path, e);

  // The box's hash of its own tree, taken from the walk this plan already did.
  //
  // Free, and it answers both directions. For a pull it is what the client
  // records once it promotes, since a pull leaves the box untouched. For a push
  // it is the box's half of "who moved" — which is why push needs no
  // /api/sync/check round trip of its own any more: the walk that computes the
  // diff can answer the question at the same time.
  let treeHash = '';
  const recordHash = opts.hashTree ? new SyncHash() : null;
  if (opts.hashTree) {
    const h = new SyncHash();
    for (const e of serverEntries) { h.add(e); recordHash!.add(e); }
    treeHash = h.digest();
  }
  // The same fold, minus the entries this push is about to replace or remove.
  // Apply adds back what it actually wrote, and the result is the hash of the
  // finished tree — computed without walking it again. XOR is its own inverse,
  // so this is exact rather than an approximation.
  //
  // Only the accumulator survives, never the paths: the plan drops its add and
  // update lists on purpose (they are hundreds of megabytes of strings on a big
  // push) and this must not quietly put them back.


  const addBits = new PushBitmap();
  const updateBits = new PushBitmap();
  const addPaths: string[] = [];
  const updatePaths: string[] = [];
  let addCount = 0;
  let updateCount = 0;
  let bytesToSend = 0;
  let manifestCount = 0;
  const rangeCandidates: [string, number][] = [];
  // The box's own entries for everything a pull would carry: the files it holds
  // that differ, plus the ones the client has never seen.
  const pullFetch: PushEntry[] = [];

  for await (const c of opts.entries) {
    // Position in the manifest as *received*, counted before the deny filter.
    // The client addresses what it sends by this index against the slice it
    // streamed from, and it has no idea which entries the box refused — so
    // renumbering here would shift every bit after the first denied path and
    // silently upload the wrong files.
    const i = manifestCount++;
    if (manifestCount > PUSH_MAX_MANIFEST_ENTRIES) {
      throw new Error(`manifest exceeds ${PUSH_MAX_MANIFEST_ENTRIES} entries`);
    }
    // File mode's whole safety argument is that the plan can name exactly one
    // path, so the manifest has to say so too — a header claiming one file and
    // a manifest carrying a tree is a client to disbelieve, not to reconcile.
    if (opts.file && (i > 0 || c.path !== opts.file)) {
      throw new Error(`single-file push must carry exactly one entry named ${opts.file}`);
    }
    if (denied(c.path, c.type === 'dir')) continue;
    const s = sMap.get(c.path);
    if (s) sMap.delete(c.path);
    let verdict = pushCompare(c, s, opts.checksum);
    if (verdict === 'verify') {
      // Metadata says identical; --checksum says prove it. This is the whole
      // cost of the flag, and it is spent only on the files where the answer
      // is still open.
      verdict = (await pushVerifyChecksum(path.join(opts.target, c.path), c.sha256!)) ? 'update' : null;
    }
    if (verdict === null) continue;
    if (verdict === 'add') {
      addBits.set(i);
      addCount += 1;
      if (opts.collectPaths) addPaths.push(c.path);
    } else {
      updateBits.set(i);
      updateCount += 1;
      if (opts.collectPaths) updatePaths.push(c.path);
      // Same file, different content: a push would send ours, a pull wants
      // theirs. `s` is non-null here — pushCompare only says 'add' when it is
      // missing — so this is the box's own copy, sizes and all.
      if (opts.pull && s) pullFetch.push(s);
      // And for a push it is the version about to stop existing.
      if (recordHash && s) recordHash.remove(s);
    }
    if (c.type === 'file') bytesToSend += c.size ?? 0;
    // Only a file the client could choose to range is worth asking about, and
    // the answer is only useful while its size still matches the accumulator
    // the last run left — which is exactly what the name encodes.
    if (c.type === 'file' && (c.size ?? 0) > PUSH_RANGE_MIN_BYTES) {
      rangeCandidates.push([c.path, c.size ?? 0]);
    }
  }
  // The in-loop check above can only fire on an entry that arrived; a manifest
  // with none at all would otherwise plan a file push carrying no file.
  //
  // A pull is exempt, and the exemption is the whole point of the mode there:
  // `pull ~/.zshrc` onto a machine that has no ~/.zshrc sends an empty manifest
  // because there is genuinely nothing to describe. Demanding one entry made
  // the headline case the one case that could not work.
  if (opts.file && !opts.pull && manifestCount !== 1) {
    throw new Error(`single-file push must carry exactly one entry named ${opts.file}`);
  }

  // Deleting a directory is recursive (`fs.rm({recursive:true})` in apply), so
  // a directory still holding a held-back path has to stay even though the
  // client doesn't have it. Without this the rules hold for overwrites and fail
  // silently for deletes: a target with only ~/.trae/traecli.yaml left in it
  // would lose the file along with its parent. Covers skip as well as deny — an
  // excluded node_modules is no use if its project directory is removed.
  const heldAncestors = new Set<string>();
  for (const p of heldLocal) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) heldAncestors.add(segs.slice(0, i).join('/'));
  }
  // "What the box holds that this push did not send" is every sibling of the
  // one file, which is not a thing anyone asked about — and is the list a
  // delete would work from. Empty in file mode, so the answer cannot depend on
  // the caller having remembered to turn deletes off.
  // For a push, "what the box holds that we did not send" in file mode is every
  // sibling of the one file — not a thing anyone asked about, and the list a
  // delete would work from. Empty, so the answer cannot depend on the caller
  // having remembered to turn deletes off.
  //
  // For a pull it is the opposite: the walk saw exactly one path, and if the
  // client did not send it then that single entry IS what the pull carries.
  const leftover = opts.file && !opts.pull
    ? []
    : Array.from(sMap.keys()).filter(p => !heldAncestors.has(p));
  // Everything the box holds and the client never mentioned. To a push these
  // are leftovers to remove or report; to a pull they are the files that would
  // arrive. Same set, opposite meaning — which is why one walk answers both.
  if (opts.pull) {
    for (const p of leftover) {
      const s = sMap.get(p);
      if (s) pullFetch.push(s);
    }
  }
  // Directories first and then by path, so a client extracting in order always
  // has the parent of whatever it is about to write. Sorting here rather than
  // relying on walk order makes that a property of the plan rather than of how
  // the box happened to traverse.
  pullFetch.sort((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  const pullBytes = pullFetch.reduce((n, e) => n + (e.type === 'file' ? e.size ?? 0 : 0), 0);
  // Leftovers leave the tree only when this push is actually deleting them.
  if (recordHash && opts.deletes) {
    for (const rel of leftover) {
      const s = sMap.get(rel);
      if (s) recordHash.remove(s);
    }
  }

  // A plan has to outlive the upload it describes, and a chunked apply keeps
  // coming back to it, so the allowance follows the payload rather than a flat
  // five minutes.
  const ttl = Math.min(
    PUSH_PLAN_TTL_MAX_MS,
    Math.max(PUSH_PLAN_TTL_MS, Math.ceil(bytesToSend / PUSH_PLAN_TTL_BYTES_PER_MS)),
  );

  const partials: Record<string, number> = {};
  for (const [rel, size] of rangeCandidates) {
    const p = pushPartialName(path.join(opts.target, rel), size);
    const have = await fs.promises.stat(p).then(s => s.size, () => 0);
    if (have > 0) partials[rel] = have;
  }

  return {
    planId:        crypto.randomUUID(),
    manifestCount,
    addBits:       addBits.toBase64(),
    updateBits:    updateBits.toBase64(),
    addCount,
    updateCount,
    addPaths,
    updatePaths,
    leftover,
    bytesToSend,
    expiresAt:     Date.now() + ttl,
    preserved:     Array.from(preserved).sort(),
    reclaimedBytes,
    partials,
    pullFetch,
    pullBytes,
    treeHash,
    treeCount: serverEntries.length,
    recordHash: recordHash ? recordHash.snapshot() : null,
  };
}

/**
 * Group deleted paths by their containing directory, biggest group first.
 *
 * Tens of thousands of individual delete lines is not a confirmation prompt —
 * nobody reads it, and "yes" stops meaning anything. What a person actually
 * needs to know before agreeing is *where* the removals land, which is one line
 * per directory.
 */
function pushDeleteRollup(paths: string[], limit: number): { dir: string; count: number }[] {
  const byDir = new Map<string, number>();
  for (const p of paths) {
    const cut = p.lastIndexOf('/');
    const dir = cut < 0 ? '.' : p.slice(0, cut);
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  return Array.from(byDir, ([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
    .slice(0, limit);
}

/** Record a freshly-built plan so apply can find it. */
function pushRegisterPlan(built: PushPlanBuild, target: string, rel: string, deletes: boolean, deny: PushIgnoreRule[], file: string, record: PushRecordIntent | null, trash: string | null): void {
  pushPlans.set(built.planId, {
    target,
    rel,
    file,
    addCount:    built.addCount,
    updateCount: built.updateCount,
    // Only a push that asked to delete carries the list into apply; otherwise
    // the leftovers are reported and forgotten.
    delete:      deletes ? built.leftover : [],
    expiresAt:   built.expiresAt,
    deny,
    deletes,
    record,
    recordHash: built.recordHash,
    trash,
  });
}

/**
 * Read the client's intent to have this push recorded, or null.
 *
 * All three fields or none: a record keyed by a replica with no hash to
 * remember, or a hash with nobody to attribute it to, is a line the next check
 * can only ever read as a mismatch. Silently ignored rather than rejected —
 * these fields are additive, and a client that half-sends them is one this box
 * simply keeps no records for.
 */
function pushRecordIntent(raw: { replica?: unknown; skip_fp?: unknown; local_hash?: unknown }, skip: string[]): PushRecordIntent | null {
  if (!syncValidReplica(raw.replica)) return null;
  if (typeof raw.skip_fp !== 'string' || !raw.skip_fp) return null;
  if (typeof raw.local_hash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.local_hash)) return null;
  return { replica: raw.replica, skipFp: raw.skip_fp, localHash: raw.local_hash, skip };
}

/**
 * The $HOME-relative name a record is keyed by. A single file is a sync root
 * like any other — one whose walk is one lstat — so it is recorded under its
 * own path rather than under the directory that happens to contain it.
 */
function pushRecordRel(rel: string, file: string): string {
  return file ? pushHomePrefix(rel) + file : rel;
}

/**
 * Hash what this box currently holds under `target`, through the same filter
 * the diff uses. Also reports the entry count, since "the destination is
 * empty" is what lets a first push land without a prompt.
 */
async function pushHashTarget(
  target: string,
  rel: string,
  skipPatterns: string[],
  deny: PushIgnoreRule[],
  file: string,
): Promise<{ hash: string; entries: number }> {
  const h = new SyncHash();
  if (file) {
    const one = await pushStatOne(target, file);
    if (one) h.add(one);
    return { hash: h.digest(), entries: h.entries };
  }
  const homePrefix = pushHomePrefix(rel);
  const skip = compilePushIgnore(skipPatterns.join('\n'), 'client skip list');
  const walked = await pushWalk(
    target,
    (p, isDir) => !!pushRuleHit(deny, homePrefix, p, isDir) || !!pushRuleHit(skip, homePrefix, p, isDir),
  );
  for (const e of walked.entries) h.add(e);
  return { hash: h.digest(), entries: walked.entries.length };
}

/**
 * Write the agreement this push just established, from a fresh walk of the
 * finished tree.
 *
 * A re-walk, not the plan: the repair hook rewrites files after they land, so a
 * hash derived from what was sent would report "box moved" forever on exactly
 * the files the image exists to rewrite. Skip-filtered, because the box's tree
 * holds paths the client never sends. Called only on a full success — a push
 * that dies mid-chunk leaves the record alone, so the next run sees more
 * difference than there is, which is the safe direction.
 */
function pushWriteRecord(plan: PushPlan): void {
  const rec = plan.record;
  if (!rec || !plan.recordHash) return;
  try {
    syncWrite(rec.replica, {
      rel: pushRecordRel(plan.rel, plan.file),
      fp:  rec.skipFp,
      lh:  rec.localHash,
      bh:  SyncHash.restore(plan.recordHash).digest(),
      del: plan.deletes,
      at:  Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    // The files have landed and there is nothing to roll back. A missing record
    // costs the next push a confirmation prompt, which is what having no record
    // has always meant.
    console.error(`[sync] could not record ${plan.rel}: ${errorMessage(err)}`);
  }
}

/**
 * Fold one just-written entry into the record's running hash.
 *
 * Built from what apply itself wrote rather than from an lstat: apply sets the
 * mode and the mtime from the tar header, so it already knows the tuple the
 * next walk would produce. That keeps the record free — no second walk, and not
 * even a stat per file.
 *
 * The repair hook would break this, since it rewrites files after they land.
 * It cannot arise: the hook runs on whole-box pushes alone, and those carry no
 * record intent.
 */
function pushRecordWrote(plan: PushPlan, e: PushEntry): void {
  if (!plan.recordHash) return;
  const h = SyncHash.restore(plan.recordHash);
  h.add(e);
  plan.recordHash = h.snapshot();
}

/**
 * Resolve the target and check nothing else is writing there.
 * Returns the validated target, or the status and message to answer with.
 */
function pushResolveTarget(
  hdr: { rel: string; target: string; home: boolean },
  reserved: boolean,
): { target: string } | { code: number; error: string } {
  const target = pushSafeTarget(hdr.target, hdr.rel, hdr.home);
  if (!target) return { code: 400, error: 'target must be inside $HOME and match rel' };
  const busy = reserved ? pushOverlapping(target) : null;
  if (busy) return { code: 409, error: `another push is writing to ${busy} — wait for it to finish` };
  return { target };
}

/** Shared validation of the small header both plan versions carry. */
function pushCheckHeader(
  hdr: { rel?: unknown; target?: unknown; skip?: unknown; home?: unknown; file?: unknown },
): { error: string } | { rel: string; target: string; skip: string[]; home: boolean; file: string } {
  if (!hdr || typeof hdr.rel !== 'string' || typeof hdr.target !== 'string') {
    return { error: 'rel and target are required' };
  }
  const file = pushFileName(hdr.file);
  if (file === null) return { error: 'file must be a single path segment' };
  const skip = hdr.skip ?? [];
  if (!Array.isArray(skip) || skip.some(s => typeof s !== 'string')) {
    return { error: 'skip must be an array of strings' };
  }
  // Each pattern becomes a regex, and a long list of `**`-heavy ones is a way
  // to make the box do pointless work. The client is authenticated and it is
  // the box owner's own foot, but a bound costs nothing.
  if (skip.length > PUSH_MAX_SKIP_PATTERNS) {
    return { error: `too many skip patterns (${skip.length} > ${PUSH_MAX_SKIP_PATTERNS})` };
  }
  return { rel: hdr.rel, target: hdr.target, skip: skip as string[], home: hdr.home === true, file };
}

// v1: the whole manifest as one JSON body. Kept for clients older than the
// streaming endpoint; express caps the body at 50mb, which is where a big push
// falls over and why v2 exists.
router.post('/api/push/plan', express.json({ limit: '50mb' }), async (req: express.Request, res: express.Response) => {
  const body = req.body as { rel?: string; target?: string; checksum?: boolean; entries?: PushEntry[]; skip?: string[]; home?: boolean };
  if (!body || !Array.isArray(body.entries)) {
    res.status(400).json({ error: 'rel, target, and entries are required' });
    return;
  }
  const hdr = pushCheckHeader(body);
  if ('error' in hdr) { res.status(400).json(hdr); return; }
  // v1 deletes unconditionally — the `deletes` header is v2's, and this handler
  // has no way to express "keep what you have". A single-file push is a
  // manifest of one entry, so honouring it here would take a request to copy
  // one file and remove every sibling on the box.
  if (hdr.file) {
    res.status(400).json({ error: 'single-file push requires /api/push/plan2' });
    return;
  }
  const resolved = pushResolveTarget(hdr, true);
  if ('error' in resolved) { res.status(resolved.code).json({ error: resolved.error }); return; }
  const target = resolved.target;
  const deny = loadPushIgnoreDir(PUSH_IGNORE_DIR);
  let built: PushPlanBuild;
  try {
    built = await pushBuildPlan({
      target,
      rel:          hdr.rel,
      checksum:     !!body.checksum,
      skipPatterns: hdr.skip,
      entries:      body.entries,
      collectPaths: true,
      deletes:      true,
      sweep:        true,
      trash:        false,
      pull:         false,
      hashTree:     false,
      deny,
      file:         '',
    });
  } catch (err) { res.status(500).json({ error: `plan failed: ${errorMessage(err)}` }); return; }

  // v1 predates the sync record entirely, so there is nothing to record and no
  // client that would read it back.
  // v1 predates both the record and the trash. Displacing for a client that has
  // no way to be told about it would be a surprise the user cannot see.
  pushRegisterPlan(built, target, hdr.rel, true, deny, '', null, null);
  res.json({
    plan_id:       built.planId,
    target,
    add:           built.addPaths,
    update:        built.updatePaths,
    delete:        built.leftover,
    bytes_to_send: built.bytesToSend,
    expires_at:    Math.floor(built.expiresAt / 1000),
    // What the target refused to let this push touch, in either direction.
    // Reported rather than predicted client-side: the client may be older than
    // the rule files, and this way the preview shows what actually happened.
    preserved:       built.preserved.slice(0, PUSH_PRESERVED_SAMPLE),
    preserved_count: built.preserved.length,
    reclaimed_bytes: built.reclaimedBytes,
  });
});

// v2: gzipped NDJSON in — one header line, then one entry per line. Answers in
// manifest positions rather than paths, so the response stays small even when
// every file is new.
router.post('/api/push/plan2', async (req: express.Request, res: express.Response) => {
  let sent = false;
  const fail = (code: number, error: string): void => {
    if (!sent) { sent = true; res.status(code).json({ error }); }
  };
  try {
    const lines = pushReadNdjson(req);
    const first = await lines.next();
    if (first.done) { fail(400, 'empty body: expected a header line'); return; }
    const raw = first.value as { rel?: unknown; target?: unknown; checksum?: unknown; skip?: unknown; home?: unknown; deletes?: unknown; dry_run?: unknown; file?: unknown; replica?: unknown; skip_fp?: unknown; local_hash?: unknown; no_trash?: unknown };
    const hdr = pushCheckHeader(raw);
    if ('error' in hdr) { fail(400, hdr.error); return; }
    // A dry run neither writes nor deletes, so it has nothing to conflict with.
    const dryRun = raw.dry_run === true;
    const resolved = pushResolveTarget(hdr, !dryRun);
    if ('error' in resolved) { fail(resolved.code, resolved.error); return; }
    const target = resolved.target;

    const deny = loadPushIgnoreDir(PUSH_IGNORE_DIR);
    const entries = (async function* () {
      for await (const v of lines) yield pushParseEntry(v);
    })();
    // A single-file push never deletes, whatever the header says. The mode's
    // safety rests on the box writing one named path and touching nothing else,
    // and that must not be one `deletes: true` away from removing every sibling
    // of the file — least of all in `$HOME`, the one directory this mode is
    // allowed into that a subdirectory push is not.
    const deletes = raw.deletes !== false && !hdr.file;
    // Fixed at plan time, not per chunk: a large push arrives as several
    // applies against one plan, and each of them displacing into a batch of its
    // own would scatter one push's undo across a dozen directories.
    const trash = raw.no_trash === true ? null : pushTrashStamp();
    // Who moved, answered from the plan's own walk rather than from a separate
    // /api/sync/check. A push that carries no record intent — a whole-box push,
    // or an older client — asks for no hash and gets none.
    const intent = pushRecordIntent(raw, hdr.skip);
    const built = await pushBuildPlan({
      target,
      rel:          hdr.rel,
      checksum:     raw.checksum === true,
      skipPatterns: hdr.skip,
      entries,
      collectPaths: false,
      deletes,
      // A dry run reports what a push would do and touches nothing, which has
      // to include not quietly reclaiming disk on the way past.
      sweep:        !dryRun,
      trash:        trash !== null,
      pull:         false,
      hashTree:     intent !== null,
      deny,
      file:         hdr.file,
    });

    // A dry run reserves nothing. Registering it would hold the tree against
    // other pushes for the idle timeout, so `push -n ~` followed by `push ~` —
    // the most natural sequence there is — would answer 409.
    // A dry run records nothing, for the same reason it registers no plan: it
    // changes neither side, so there is no new agreement to remember.
    if (!dryRun) pushRegisterPlan(built, target, hdr.rel, deletes, deny, hdr.file, intent, trash);
    sent = true;
    res.json({
      plan_id:       dryRun ? '' : built.planId,
      target,
      // Echoed so the client can prove the bitmaps line up with the manifest it
      // streamed. A mismatch means the two sides disagree about what entry 0
      // was, which would upload the wrong files silently.
      manifest_count: built.manifestCount,
      add_bits:       built.addBits,
      update_bits:    built.updateBits,
      add_count:      built.addCount,
      update_count:   built.updateCount,
      // What the box holds and this push did not send. Reported the same way
      // whether or not it will be acted on, so the no-delete default shows up
      // as a fact about this box rather than a line in --help nobody read;
      // `deletes` says which it is.
      deletes,
      // Echoed so the client can tell a box that understood the mode from one
      // that ignored an unknown header field. The difference matters: an older
      // box would have taken `push ~/.zshrc` for a whole-box push and run the
      // repair hook, so the client refuses rather than guessing.
      ...(hdr.file ? { file: hdr.file } : {}),
      leftover:         built.leftover.slice(0, PUSH_DELETE_SAMPLE),
      leftover_count:   built.leftover.length,
      // Computed from the full list, not the sample, so the summary is a fact
      // about the push rather than about the first 200 paths of it.
      leftover_rollup:  pushDeleteRollup(built.leftover, PUSH_ROLLUP_GROUPS),
      bytes_to_send:  built.bytesToSend,
      expires_at:     Math.floor(built.expiresAt / 1000),
      preserved:       built.preserved.slice(0, PUSH_PRESERVED_SAMPLE),
      preserved_count: built.preserved.length,
      // Orphaned staging directories this plan cleaned up on its way past.
      // Invisible to every walk, so nothing else would ever have reclaimed
      // them; worth saying out loud when it is gigabytes.
      reclaimed_bytes: built.reclaimedBytes,
      // Who moved, from the walk above. Absent when no record intent came with
      // the request, which is how a client tells "this box keeps no record of
      // us" from "we did not ask".
      ...(intent ? (() => {
        const rec = syncFind(intent.replica, pushRecordRel(hdr.rel, hdr.file), intent.skipFp);
        return {
          sync_state:     syncClassify(rec, intent.localHash, built.treeHash),
          sync_empty:     built.treeCount === 0,
          deletes_agreed: rec?.del ?? false,
        };
      })() : {}),
      // Whether an operator has quiesced this box. A whole-box push is the one
      // command --yes cannot approve on its own, and a lock is the only
      // standing statement that nobody is working in here — see abox edge lock,
      // which permits push precisely so a box can be quiesced and replaced.
      locked: pushBoxLocked(),
      accept_encoding: PUSH_ACCEPT_ENCODING,
      // This box folds ranged slices back into whole files. A client that sees
      // no such field must send each file in one request, because that is what
      // every box did before this and what an old one would do with a slice:
      // write it as the entire file.
      accept_ranges: true,
      // This box can merge an app entry into ~/.wsh/apps.yaml (POST
      // /api/apps/<key>), so `abox-cli push app` can land a card as well as the
      // files behind it. A client seeing no such field must refuse the entity
      // push outright rather than uploading the files and skipping the card:
      // half an app is a card-less directory the user could have pushed by path
      // anyway, or worse, a directory whose card never arrives to point at it.
      accept_entities: true,
      // Verified prefixes left by a run that died partway, so the next one
      // resumes instead of re-sending gigabytes it already sent.
      ...(Object.keys(built.partials).length ? { partials: built.partials } : {}),
    });
  } catch (err) {
    fail(400, `plan failed: ${errorMessage(err)}`);
  }
});

// Hand a plan back unused. The client calls this when it knows it will not
// apply — a declined confirmation, a refusal, an aborted run — so the tree is
// free again immediately rather than after the idle timeout. Best-effort by
// design: losing the call costs a wait, never correctness.
router.delete('/api/push/plan/:id', (req: express.Request, res: express.Response) => {
  const existed = pushPlans.delete(req.params.id);
  pushActiveApplies.delete(req.params.id);
  res.json({ released: existed });
});

router.post('/api/push/apply', async (req: express.Request, res: express.Response) => {
  const planId = (req.query.plan_id as string) || '';
  const plan = pushPlans.get(planId);
  if (!plan || plan.expiresAt < Date.now()) {
    if (plan) pushPlans.delete(planId);
    res.status(404).json({ error: 'plan not found or expired' });
    return;
  }
  const sentinelExpected = (req.headers['x-abox-push-sentinel'] as string) || '';
  if (!sentinelExpected) { res.status(400).json({ error: 'X-Abox-Push-Sentinel header required' }); return; }
  // final=0 marks a chunk with more to come. Defaults to final, so a client
  // that knows nothing about chunking — every client before this — sends one
  // apply and gets the deletes and the hook exactly as it always did.
  const isFinal = req.query.final !== '0';

  const target = plan.target;
  // Serialize applies over overlapping trees: two of them promoting into one
  // directory, one of them deleting, is the window where a concurrent push can
  // actually destroy work. Released when the response ends, however it ends —
  // no timeout to tune and nothing stale to clean up.
  const busy = pushOverlapping(target, planId);
  if (busy) {
    res.status(409).json({ error: `another push is writing to ${busy} — wait for it to finish` });
    return;
  }
  const reservation = pushActiveApplies.get(planId) ?? { target, inFlight: 0, lastAt: Date.now() };
  reservation.inFlight += 1;
  pushActiveApplies.set(planId, reservation);
  // Both 'finish' and 'close' fire on a normal response, so this has to be
  // idempotent — double-decrementing drives inFlight negative and the tree
  // then reads as permanently busy.
  let ended = false;
  const endRequest = (): void => {
    if (ended) return;
    ended = true;
    reservation.inFlight -= 1;
    reservation.lastAt = Date.now();
  };
  res.on('finish', endRequest);
  res.on('close', endRequest);

  // Same frame conversion the plan used, recomputed from the plan's own `rel`
  // so the two phases cannot disagree about what a rule applies to.
  const homePrefix = pushHomePrefix(plan.rel);
  const staging = path.join(target, `.abox-push-staging-${crypto.randomUUID()}`);
  try { await fs.promises.mkdir(staging, { recursive: true }); }
  catch (err) { res.status(500).json({ error: `mkdir staging: ${errorMessage(err)}` }); return; }

  const cleanup = (): Promise<void> => fs.promises.rm(staging, { recursive: true, force: true }).then(() => {}, () => {});

  const extract = tarExtract();
  let sawSentinel = false;
  let bytesWritten = 0;
  let filesWritten = 0;
  // What this chunk moved aside rather than destroyed, reported so the summary
  // can say where it went instead of leaving the user to find out later.
  let displacedFiles = 0;
  let displacedBytes = 0;
  const t0 = Date.now();
  // Slices staged by this apply, in arrival order. They are pulled out of
  // staging and appended to their accumulator *after* the sentinel proves the
  // stream was whole — so a truncated upload leaves the accumulator exactly as
  // it found it, and the byte count the next plan reports stays honest.
  const ranged: { rel: string; off: number; total: number; mode: number; mtime: Date | null }[] = [];

  extract.on('entry', (header: TarHeaders, stream: NodeJS.ReadableStream, next: (err?: Error | null) => void) => {
    // Always attach an error sink to the per-entry stream — when next(err) is
    // called and the extract is torn down, the per-entry stream can still emit
    // 'error', and without a listener Node escalates that to uncaughtException.
    stream.on('error', () => {});
    const name = String(header.name ?? '');
    if (name === PUSH_SENTINEL_ENTRY) {
      let buf = '';
      stream.on('data', (chunk: Buffer) => { buf += chunk.toString('utf8'); });
      stream.on('end', () => { if (buf.trim() === sentinelExpected) sawSentinel = true; next(); });
      return;
    }
    const cleanName = path.posix.normalize(name);
    if (cleanName.startsWith('/') || cleanName.startsWith('..') || cleanName.split('/').some(seg => seg === '..')) {
      stream.resume();
      next(new Error(`unsafe tar entry name: ${name}`));
      return;
    }
    const entryAbs = path.resolve(staging, cleanName);
    if (entryAbs !== staging && !entryAbs.startsWith(staging + path.sep)) {
      stream.resume();
      next(new Error(`tar entry escapes staging: ${name}`));
      return;
    }
    // apply does not otherwise check entry names against plan.add ∪ plan.update,
    // so the plan-time deny filter alone would not stop a client that tars a
    // denied path anyway. A correct client never can — the plan it was handed
    // cannot name one — which makes this fail-closed rather than merely
    // defensive: reaching it means a bug or a deliberate bypass.
    const denied = pushRuleHit(plan.deny, homePrefix, cleanName, header.type === 'directory');
    if (denied) {
      stream.resume();
      next(new Error(`tar entry is denied by ${denied.rule.source} (${denied.rule.pattern}): ${name}`));
      return;
    }
    // The one place apply *does* check a name against its plan. A file-mode
    // plan may be targeted at $HOME, where the ordinary guard is that a client
    // has to ask for a whole-box push by name — so what makes that safe is this
    // pin: the body can carry the declared file and nothing else.
    if (plan.file && cleanName !== plan.file) {
      stream.resume();
      next(new Error(`single-file push may only carry ${plan.file}, got: ${name}`));
      return;
    }

    if (header.type === 'directory') {
      fs.promises.mkdir(entryAbs, { recursive: true, mode: (header.mode ?? 0o755) & 0o777 })
        .then(() => { filesWritten += 1; pushRecordWrote(plan, { path: cleanName, type: 'dir' }); stream.resume(); stream.on('end', () => next()); stream.on('error', (e) => next(e as Error)); })
        .catch((err) => next(err as Error));
      return;
    }
    if (header.type === 'symlink') {
      const linkname = header.linkname ?? '';
      fs.promises.mkdir(path.dirname(entryAbs), { recursive: true })
        .then(() => fs.promises.symlink(linkname, entryAbs))
        .then(() => { filesWritten += 1; pushRecordWrote(plan, { path: cleanName, type: 'symlink', target: linkname }); stream.resume(); stream.on('end', () => next()); stream.on('error', (e) => next(e as Error)); })
        .catch((err) => next(err as Error));
      return;
    }
    if (header.type !== 'file') {
      // Skip unsupported types (block/char/fifo/socket) cleanly.
      stream.resume();
      stream.on('end', () => next());
      stream.on('error', (e) => next(e as Error));
      return;
    }

    // A slice of a file too big to ride in one request. It stages exactly like
    // any other file — same name, same checks — and is folded into its
    // accumulator after the sentinel. What makes that safe is that the client
    // never puts two slices of one path in a single apply, so the staged name
    // is unambiguous.
    let range: { off: number; total: number } | null;
    try { range = pushEntryRange(header); }
    catch (err) { stream.resume(); next(err as Error); return; }
    if (range) {
      const declared = header.size ?? 0;
      if (range.off + declared > range.total) {
        stream.resume();
        next(new Error(`range past end of ${name}: ${range.off}+${declared} > ${range.total}`));
        return;
      }
      ranged.push({
        rel: cleanName,
        off: range.off,
        total: range.total,
        mode: (header.mode ?? 0o644) & 0o777,
        mtime: header.mtime instanceof Date ? header.mtime : null,
      });
    }

    // Regular file → tmp + rename for per-file atomicity within staging.
    (async () => {
      await fs.promises.mkdir(path.dirname(entryAbs), { recursive: true });
      const tmp = entryAbs + '.tmp-' + crypto.randomBytes(4).toString('hex');
      let entryBytes = 0;
      await new Promise<void>((resolve, reject) => {
        const w = fs.createWriteStream(tmp);
        stream.on('data', (c: Buffer) => { entryBytes += c.length; });
        stream.on('error', reject);
        w.on('error', reject);
        w.on('finish', () => resolve());
        stream.pipe(w);
      });
      try {
        if (header.mode != null) await fs.promises.chmod(tmp, header.mode & 0o777);
        if (header.mtime instanceof Date) await fs.promises.utimes(tmp, header.mtime, header.mtime);
        await fs.promises.rename(tmp, entryAbs);
        bytesWritten += entryBytes;
        // A slice is not a file. Counting one per slice would report more files
        // written than the tree gained; the slice that completes it counts.
        if (!range || range.off + entryBytes >= range.total) {
          filesWritten += 1;
          // The tuple the next walk would see, from what we just wrote: mode
          // and mtime came off this header and were applied above, so there is
          // nothing to go and look up.
          pushRecordWrote(plan, {
            path:     cleanName,
            type:     'file',
            size:     range ? range.total : entryBytes,
            mtime_ns: header.mtime instanceof Date ? header.mtime.getTime() * 1e6 : 0,
          });
        }
      } catch (err) {
        await fs.promises.unlink(tmp).catch(() => {});
        throw err;
      }
    })().then(() => next()).catch((err) => next(err as Error));
  });

  let extractError: Error | null = null;
  let source: NodeJS.ReadableStream;
  try { source = pushDecodeBody(req); }
  catch (err) { await cleanup(); res.status(400).json({ error: errorMessage(err) }); return; }
  await new Promise<void>((resolve) => {
    extract.on('finish', () => resolve());
    extract.on('error', (err: Error) => { extractError = err; resolve(); });
    // Both ends: a truncated upload surfaces on the request, a corrupt one on
    // the decompressor, and either way there is no sentinel so nothing lands.
    req.on('error', (err: Error) => { extractError = err; resolve(); });
    if (source !== req) source.on('error', (err: Error) => { extractError = err; resolve(); });
    source.pipe(extract);
  });

  if (extractError) {
    await cleanup();
    res.status(400).json({ error: `tar extract failed: ${errorMessage(extractError)}` });
    return;
  }
  if (!sawSentinel) {
    await cleanup();
    res.status(400).json({ error: 'incomplete stream (sentinel missing)' });
    return;
  }

  // Fold each staged slice into its accumulator, then take it out of staging so
  // the promote below never sees it — a slice renamed over the destination is a
  // truncated file, which is the one outcome this whole path exists to avoid.
  //
  // Ordered after the sentinel so only verified bytes are ever appended: the
  // accumulator's length is what the next plan reports as landed, and a resume
  // that trusts unverified bytes splices garbage into the middle of a file.
  try {
    for (const r of ranged) {
      const stagePath = path.join(staging, r.rel);
      const dstPath = path.join(target, r.rel);
      const partPath = pushPartialName(dstPath, r.total);
      await fs.promises.mkdir(path.dirname(dstPath), { recursive: true });
      const have = await fs.promises.stat(partPath).then(s => s.size, () => 0);
      if (r.off > have) {
        throw new Error(`range for ${r.rel} starts at ${r.off} but only ${have} bytes have landed`);
      }
      const slice = await fs.promises.open(stagePath, 'r');
      let part: fs.promises.FileHandle | null = await fs.promises.open(partPath, have === 0 ? 'w' : 'r+');
      let complete = false;
      try {
        // Positional writes: a re-sent slice overwrites its own bytes rather
        // than appending a second copy, so a retry after a half-believed
        // failure converges instead of corrupting.
        let pos = r.off;
        const buf = Buffer.allocUnsafe(1 << 20);
        for (;;) {
          const { bytesRead } = await slice.read(buf, 0, buf.length, null);
          if (bytesRead === 0) break;
          await part.write(buf, 0, bytesRead, pos);
          pos += bytesRead;
        }
        complete = pos >= r.total;
      } finally {
        await slice.close().catch(() => {});
        const p = part;
        part = null;
        await p?.close().catch(() => {});
      }
      if (complete) {
        // Last slice: the accumulator is the file. chmod/utimes before the
        // rename so the destination is never briefly present with the wrong
        // metadata, which is what the next plan would diff against.
        await fs.promises.chmod(partPath, r.mode);
        if (r.mtime) await fs.promises.utimes(partPath, r.mtime, r.mtime);
        await fs.promises.rename(partPath, dstPath);
      }
      await fs.promises.unlink(stagePath).catch(() => {});
    }
  } catch (err) {
    await cleanup();
    res.status(500).json({ error: `range apply failed: ${errorMessage(err)}` });
    return;
  }

  // Promote: walk staging, rename each entry over target. mkdir parents as needed.
  // Per-file POSIX rename is atomic, so failures leave individual files either
  // fully old or fully new — never half-written.
  try {
    const promote = async (rel: string): Promise<void> => {
      const stageAbs = path.join(staging, rel);
      const ents = await fs.promises.readdir(stageAbs, { withFileTypes: true });
      for (const ent of ents) {
        const childRel = rel ? rel + '/' + ent.name : ent.name;
        const stagePath = path.join(staging, childRel);
        const dstPath = path.join(target, childRel);
        if (ent.isDirectory() && !ent.isSymbolicLink()) {
          await fs.promises.mkdir(dstPath, { recursive: true });
          await promote(childRel);
        } else {
          await fs.promises.mkdir(path.dirname(dstPath), { recursive: true });
          // Keep whatever we are about to write over. One rename, on the same
          // filesystem, and only when something is actually there — which on a
          // first push is nothing at all. See pushTrash.ts.
          if (plan.trash) {
            const t = await pushTrashDisplace(plan.trash, homePrefix + childRel, dstPath);
            if (t.moved) { displacedFiles += 1; displacedBytes += t.bytes; }
          }
          await fs.promises.rename(stagePath, dstPath);
        }
      }
    };
    await promote('');
  } catch (err) {
    await cleanup();
    res.status(500).json({ error: `promote failed: ${errorMessage(err)}` });
    return;
  }

  // Deletes, the repair hook and the plan itself belong to the LAST chunk.
  //
  // A large push arrives as several applies against one plan, each promoting
  // what it carried. Deleting on any but the last would run the removals
  // against a tree that is still half old — and if the client then died, the
  // box would be left missing files that no longer exist anywhere. Same for the
  // hook: it repairs a finished tree, not a partial one. So a non-final chunk
  // promotes and reports, and nothing else.
  let deleted = 0;
  let postfix: Awaited<ReturnType<typeof runPushPostfix>> = null;
  if (isFinal) {
    // Deepest paths first so files go before their containing dirs.
    // Pre-compute depth once per entry rather than splitting twice per
    // pairwise compare in the sort.
    const deletes = plan.delete
      .map(rel => ({ rel, segs: rel.split('/') }))
      .sort((a, b) => b.segs.length - a.segs.length);
    for (const { rel, segs } of deletes) {
      if (rel.startsWith('/') || segs.some(seg => seg === '..')) continue;
      const abs = path.join(target, rel);
      if (!abs.startsWith(target + path.sep) && abs !== target) continue;
      // A removal is the one thing a push does that nothing else can undo, so
      // it is the case the trash exists for most. A directory moves whole, in
      // one rename, rather than being walked and re-created.
      if (plan.trash) {
        const t = await pushTrashDisplace(plan.trash, homePrefix + rel, abs);
        if (t.moved) { deleted += 1; displacedFiles += 1; displacedBytes += t.bytes; continue; }
      }
      try { await fs.promises.rm(abs, { recursive: true, force: true }); deleted += 1; }
      catch (err) { console.error(`[push] delete failed rel=${rel}: ${errorMessage(err)}`); }
    }
  }

  await cleanup();

  // Hand the finished tree to the image's repair script — whole-box pushes
  // only. Replicating a box is what lands one box's env-bound config on
  // another; a push of ~/workspace/foo does not, and shouldn't pay for a
  // network probe on every sync.
  //
  // Runs after the deletes so the hook sees the final state, and its failure is
  // reported rather than propagated: the files have landed and there is nothing
  // to roll back.
  //
  // Not for a single file, even though `push ~/.zshrc` reaches here with the
  // same rel and target a whole-box push has. The hook repairs env-bound config
  // across a box replication; copying one file is not that, and rewriting
  // ~/.trae/traecli.yaml because someone sent a dotfile is a side effect on
  // something they never mentioned.
  if (isFinal && plan.rel === PUSH_HOME_REL && !plan.file) {
    postfix = await runPushPostfix({
      hook:    PUSH_POSTFIX_HOOK,
      rel:     plan.rel,
      target,
      added:   plan.addCount,
      updated: plan.updateCount,
      deleted,
    });
  }
  if (postfix && postfix.code !== 0) {
    console.error(`[push] postfix hook exited ${postfix.code}: ${postfix.output}`);
  }

  // What the two sides now agree on. Last of all, and only on the final chunk:
  // after the deletes so the walk sees the tree the push actually leaves, and
  // after the hook so it sees the files as repaired rather than as sent — a
  // hash taken before the hook would report "box moved" forever on exactly the
  // files the image exists to rewrite.
  //
  // The tree is still reserved here. The plan used to be dropped before the
  // hook ran, which left the hook — the one thing that writes files after the
  // promote — outside the guard that keeps two pushes off one tree. Releasing
  // below instead closes that window as well as this one.
  if (isFinal) pushWriteRecord(plan);
  // Tell the batch how much it holds, so the next sweep can apply its size cap
  // without measuring anything. This apply already counted it.
  if (plan.trash && displacedBytes > 0) await pushTrashRecordSize(plan.trash, displacedBytes);

  // The push is over: drop the plan and the tree it was holding.
  if (isFinal) { pushPlans.delete(planId); pushActiveApplies.delete(planId); }

  res.json({
    added:         plan.addCount,
    updated:       plan.updateCount,
    deleted,
    bytes_written: bytesWritten,
    files_written: filesWritten,
    took_ms:       Date.now() - t0,
    // Where what this push replaced can be found, when it replaced anything.
    ...(displacedFiles ? { trashed: displacedFiles, trashed_bytes: displacedBytes, trash_dir: `~/.wsh/trash/${plan.trash}` } : {}),
    // Present only when a hook ran. `output` is one line per repair by
    // convention; abox-cli echoes it so the hook owns its own reporting and
    // wsh never has to know what a repair means.
    ...(postfix ? { postfix } : {}),
  });
});

// =================== PULL (box → client) ===================
//
//   POST /api/pull/plan2   same manifest up, the box's side of the diff down
//   GET  /api/pull/fetch   tar of what the client is missing + a sentinel
//
// The diff is push's diff read the other way round, from the same walk: what
// push calls an `update` is a file a pull wants the box's copy of, and what
// push calls a `leftover` is a file the client has never seen. Sharing the walk
// is not a saving, it is the correctness argument — the deny filter, the skip
// filter and the held-ancestor rule have to mean the same thing in both
// directions, or a path one direction protects the other one moves.
//
// What is NOT shared is trust. Push writes client-controlled bytes into a box;
// pull writes box-controlled bytes into someone's home directory, where
// ~/.ssh/authorized_keys and the shell rc files live. Everything the box names
// is therefore checked again on the client — see the escape guard in pull.go.
// The box does its half here: entries are already deny-filtered, and paths are
// re-validated on the way out.

interface PullPlan {
  target: string;
  rel: string;
  // Exactly what this plan may hand over, in the order it will be sent.
  // Enumerated at plan time so `fetch` reads a list rather than re-walking a
  // tree that may have changed underneath it.
  fetch: PushEntry[];
  bytes: number;
  expiresAt: number;
  // Proves a download completed. Echoed in a response header and written as the
  // final tar entry; the client refuses to promote anything unless the two
  // match, which is what makes a truncated stream land nothing at all.
  sentinel: string;
}

const pullPlans = new Map<string, PullPlan>();
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pullPlans) if (p.expiresAt < now) pullPlans.delete(id);
}, 60_000).unref();

const PULL_SENTINEL_ENTRY = '.abox-pull-sentinel';

router.post('/api/pull/plan2', async (req: express.Request, res: express.Response) => {
  let sent = false;
  const fail = (code: number, error: string): void => {
    if (!sent) { sent = true; res.status(code).json({ error }); }
  };
  try {
    const lines = pushReadNdjson(req);
    const first = await lines.next();
    if (first.done) { fail(400, 'empty body: expected a header line'); return; }
    const raw = first.value as { rel?: unknown; target?: unknown; checksum?: unknown; skip?: unknown; home?: unknown; file?: unknown };
    const hdr = pushCheckHeader(raw);
    if ('error' in hdr) { fail(400, hdr.error); return; }
    // A pull reads; it never writes to the box. So there is nothing to reserve
    // and nothing to conflict with, and a pull running beside a push is fine —
    // the worst case is a plan naming a file that changed, which the fetch
    // notices and reports rather than silently splicing.
    const resolved = pushResolveTarget(hdr, false);
    if ('error' in resolved) { fail(resolved.code, resolved.error); return; }
    const target = resolved.target;

    const deny = loadPushIgnoreDir(PUSH_IGNORE_DIR);
    const entries = (async function* () {
      for await (const v of lines) yield pushParseEntry(v);
    })();
    const built = await pushBuildPlan({
      target,
      rel:          hdr.rel,
      checksum:     raw.checksum === true,
      skipPatterns: hdr.skip,
      entries,
      collectPaths: false,
      // Both off: a pull changes nothing on the box, so it must not remove the
      // box's leftovers, must not sweep its staging, and must not touch its
      // trash. `deletes: false` also keeps the leftover list intact, which for
      // a pull is the payload rather than a warning.
      deletes:      false,
      sweep:        false,
      trash:        false,
      pull:         true,
      hashTree:     true,
      deny,
      file:         hdr.file,
    });

    const planId = crypto.randomUUID();
    const sentinel = crypto.randomBytes(16).toString('hex');
    pullPlans.set(planId, {
      target,
      rel:       hdr.rel,
      fetch:     built.pullFetch,
      bytes:     built.pullBytes,
      expiresAt: built.expiresAt,
      sentinel,
    });
    sent = true;
    res.json({
      plan_id:        planId,
      target,
      manifest_count: built.manifestCount,
      // What would arrive here, as entries rather than positions: these are
      // paths the client has never seen, so there is no manifest slot to point
      // at. This list IS the delta, not the tree — a client that already
      // matches the box gets an empty one however large the box is.
      fetch:          built.pullFetch,
      fetch_count:    built.pullFetch.length,
      bytes_to_fetch: built.pullBytes,
      // What the client should record as the box's half once it has promoted.
      // The box is unchanged by a pull, so this walk's answer is still true
      // afterwards — no second walk, and no window for it to go stale.
      box_hash:       built.treeHash,
      // Manifest positions the box does not have at all. A pull never removes
      // them; they are reported so the summary can say what it is leaving.
      local_only_bits:  built.addBits,
      local_only_count: built.addCount,
      preserved:       built.preserved.slice(0, PUSH_PRESERVED_SAMPLE),
      preserved_count: built.preserved.length,
      expires_at:      Math.floor(built.expiresAt / 1000),
      accept_encoding: PUSH_ACCEPT_ENCODING,
    });
  } catch (err) {
    fail(400, `pull plan failed: ${errorMessage(err)}`);
  }
});

router.get('/api/pull/fetch', async (req: express.Request, res: express.Response) => {
  const planId = (req.query.plan_id as string) || '';
  const plan = pullPlans.get(planId);
  if (!plan || plan.expiresAt < Date.now()) {
    if (plan) pullPlans.delete(planId);
    res.status(404).json({ error: 'plan not found or expired' });
    return;
  }
  // Resume at an entry boundary. A partial file is never resumed mid-way: the
  // client promotes by rename after the sentinel, so anything incomplete was
  // discarded rather than left half-written, and re-sending one file is cheap
  // next to the bookkeeping that not re-sending it would need.
  const from = Math.max(0, Number(req.query.from ?? 0) || 0);
  if (from > plan.fetch.length) {
    res.status(400).json({ error: `from=${from} is past the end of this plan (${plan.fetch.length} entries)` });
    return;
  }

  res.setHeader('Content-Type', 'application/x-tar');
  res.setHeader('X-Abox-Pull-Sentinel', plan.sentinel);
  res.setHeader('X-Abox-Pull-Total', String(plan.fetch.length));

  const pack = tarPack();
  pack.pipe(res);
  try {
    for (let i = from; i < plan.fetch.length; i++) {
      const e = plan.fetch[i];
      const abs = path.join(plan.target, e.path);
      if (e.type === 'dir') {
        pack.entry({ name: e.path + '/', type: 'directory', mode: 0o755 });
        continue;
      }
      if (e.type === 'symlink') {
        pack.entry({ name: e.path, type: 'symlink', linkname: e.target ?? '' });
        continue;
      }
      // Restat rather than trusting the plan: the tar header declares a size,
      // and a body that does not match it corrupts the stream for every entry
      // after it. A file that changed since planning is skipped and the next
      // pull picks it up, which is better than a truncated archive.
      let st: fs.Stats;
      try { st = await fs.promises.stat(abs); } catch { continue; }
      if (!st.isFile()) continue;
      await new Promise<void>((resolve, reject) => {
        const entry = pack.entry({ name: e.path, size: st.size, mode: st.mode & 0o777, mtime: st.mtime },
          (err?: Error | null) => err ? reject(err) : resolve());
        fs.createReadStream(abs).on('error', reject).pipe(entry);
      });
    }
    // Last, and only on a clean walk: its absence is how a client tells a
    // truncated download from a short one.
    pack.entry({ name: PULL_SENTINEL_ENTRY, size: plan.sentinel.length }, plan.sentinel);
    pack.finalize();
  } catch (err) {
    // The headers are long gone, so there is no status to change. Destroying
    // the response truncates the stream, the sentinel never arrives, and the
    // client discards its staging directory — which is exactly the outcome.
    console.error(`[pull] fetch failed plan=${planId}: ${errorMessage(err)}`);
    res.destroy();
  }
});

// =================== SYNC (the agreed-state record) ===================
//
// One round trip, about a hundred bytes each way, answering the only question
// push cannot answer for itself: has anyone changed the box since we last
// agreed? The client combines the answer with the shape of its plan to decide
// how much it may do without asking — see abox's sync.md.
//
// Read-only and cheap enough to run before the manifest is offered, which is
// what lets a tree neither side has touched stop here entirely: no manifest
// uploaded, no diff computed, nothing promoted.
//
// A box that predates this answers 404, and the client reads that as "keeps no
// records" rather than as a failure. That is the whole capability negotiation —
// there is no bit to advertise, because the endpoint's absence says it.
/**
 * What an entity means ON THIS BOX — the resolution half of `abox-cli pull app`.
 *
 * Resolution belongs to the side that owns the entity: the client for a push,
 * the box for a pull. A pulling client cannot read the box's apps.yaml, and it
 * must not guess, so the box answers with the card(s) and the one project each
 * command's `command` names.
 *
 * Everything here is untrusted input by the time it reaches the client — a
 * shared or borrowed box choosing the paths a pull writes to is the whole
 * threat model — so the client re-validates every `root` as a relative path
 * under $HOME. This end does its half: system-layer keys are never offered,
 * because a system card copied into the user layer would shadow the image's own
 * and survive an upgrade that was meant to replace it.
 */
/**
 * The ways a card's `command` can name this box's home.
 *
 * All four, because a card is a shell line somebody wrote by hand and every one
 * of these is ordinary there. The expanded form comes from os.homedir() rather
 * than a literal `/root`: that is what an abox container's $HOME happens to be,
 * so hardcoding it worked and would have gone on working right up until it
 * didn't. The client builds its list the same way — see pushWorkspaceSpellings
 * — and the two are held together by
 * abox/cmd/abox-cli/testdata/command-projects.json, which both test suites run.
 */
function syncCommandProjectRe(): RegExp {
  const esc = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const homes = [esc(PUSH_HOME), '~', '\\$HOME', '/root'].join('|');
  return new RegExp(`(?:^|[\\s"'=:])(?:${homes})/workspace/([A-Za-z0-9._-]+)`, 'g');
}

router.get('/api/sync/entity', (req: express.Request, res: express.Response) => {
  const wantAll = req.query.all === '1';
  const name = typeof req.query.name === 'string' ? req.query.name : '';
  if (!wantAll && !name) { res.status(400).json({ error: 'name or all=1 is required' }); return; }

  const userCfg = loadConfigFile(path.join(os.homedir(), '.wsh')) as Record<string, unknown> | null;
  const user = (userCfg ?? {}) as Record<string, unknown>;

  const pickable = (key: string, entry: unknown): entry is Record<string, unknown> => {
    if (key.startsWith('_')) return false;                       // shared defaults, not an app
    if (!entry || typeof entry !== 'object') return false;
    // A skill card names no project and its body is not in apps.yaml, so a
    // sweep would land the card and not the skill. Named explicitly it still
    // goes; swept up it is half an app. Mirrors `push app --all`.
    if (wantAll && 'skill' in (entry as Record<string, unknown>)) return false;
    return true;
  };

  const cards: { key: string; entry: unknown }[] = [];
  if (wantAll) {
    for (const [k, v] of Object.entries(user)) if (pickable(k, v)) cards.push({ key: k, entry: v });
    cards.sort((a, b) => a.key.localeCompare(b.key));
  } else {
    const entry = user[name];
    if (!pickable(name, entry)) {
      // Deliberately the same answer for "not yours" and "not there": the user
      // layer is the only thing pullable either way, and distinguishing them
      // would only teach a caller what the image ships.
      res.status(404).json({ error: `no user-layer app ${name} on this box` });
      return;
    }
    cards.push({ key: name, entry });
  }

  // One project per card, from its `command` alone. Not `cwd`: a cwd is where a
  // command runs — routinely ~/bin or $HOME — so treating it as a root means
  // naming one app syncs an unrelated tree.
  const roots = new Set<string>();
  for (const c of cards) {
    const cmd = (c.entry as { command?: unknown }).command;
    if (typeof cmd !== 'string') continue;
    const found = new Set<string>();
    for (const m of cmd.matchAll(syncCommandProjectRe())) {
      found.add(m[1]);
    }
    if (found.size > 1) {
      res.status(409).json({
        error: `app ${c.key} names more than one project (${[...found].join(', ')}) — taking the first would land half an app`,
      });
      return;
    }
    for (const p of found) roots.add(`workspace/${p}`);
  }

  res.json({ cards, roots: [...roots].sort() });
});

/**
 * Record an agreement the client established — the pull side of the record.
 *
 * Writing the record is an operation, not a phase of push. Push happens to do
 * it inside its own apply because that is where the post-hook tree exists; a
 * pull has no apply on this box at all, since the transfer lands on the client.
 * Making it an endpoint is what lets both directions establish an agreement
 * rather than only the one that happens to run code here.
 *
 * The client supplies both halves, and neither is taken on trust in any way
 * that matters: `local_hash` describes the client's own tree, which only it can
 * see, and `box_hash` is the value this box handed it in the pull plan. A
 * client that lies writes a record its own next check reads as a mismatch — the
 * cost lands entirely on the machine that lied, which is the same bargain
 * ~/.abox/replica already makes.
 */
router.post('/api/sync/record', express.json({ limit: '1mb' }), (req: express.Request, res: express.Response) => {
  const body = req.body as { replica?: unknown; root?: Record<string, unknown> };
  const root = (body?.root ?? {}) as { rel?: unknown; file?: unknown; skip_fp?: unknown; local_hash?: unknown; box_hash?: unknown; deletes?: unknown };
  if (!syncValidReplica(body?.replica)) { res.status(400).json({ error: 'replica must be 32 hex digits' }); return; }
  if (typeof root.rel !== 'string' || typeof root.skip_fp !== 'string' || !root.skip_fp) {
    res.status(400).json({ error: 'root.rel and root.skip_fp are required' });
    return;
  }
  const file = pushFileName(root.file);
  if (file === null) { res.status(400).json({ error: 'root.file must be a single path segment' }); return; }
  for (const k of ['local_hash', 'box_hash'] as const) {
    if (typeof root[k] !== 'string' || !/^[0-9a-f]{64}$/.test(root[k] as string)) {
      res.status(400).json({ error: `root.${k} must be a sha256 hex digest` });
      return;
    }
  }
  // Validated even though nothing here dereferences it: the rel becomes the key
  // of a stored record, and a key no real sync could ever produce is one
  // nothing will ever match — a slow leak rather than a loud error.
  const home = root.rel === PUSH_HOME_REL;
  if (!pushSafeTarget(home ? PUSH_HOME : path.join(PUSH_HOME, root.rel), root.rel, home)) {
    res.status(400).json({ error: 'rel must name a path inside $HOME' });
    return;
  }
  syncWrite(body.replica, {
    rel: pushRecordRel(root.rel, file),
    fp:  root.skip_fp,
    lh:  root.local_hash as string,
    bh:  root.box_hash as string,
    // A pull never deletes, so what it records is an overlay: the client may
    // hold files the box does not. Saying so is what stops a later
    // `push --delete` reading "in sync" and leaving them behind.
    del: root.deletes === true,
    at:  Math.floor(Date.now() / 1000),
  });
  res.json({ ok: true });
});

router.post('/api/sync/check', express.json({ limit: '1mb' }), async (req: express.Request, res: express.Response) => {
  const body = req.body as { replica?: unknown; root?: Record<string, unknown> };
  const root = (body?.root ?? {}) as { rel?: unknown; home?: unknown; file?: unknown; skip?: unknown; skip_fp?: unknown; local_hash?: unknown };
  if (!syncValidReplica(body?.replica)) { res.status(400).json({ error: 'replica must be 32 hex digits' }); return; }
  if (typeof root.rel !== 'string' || typeof root.skip_fp !== 'string' || !root.skip_fp) {
    res.status(400).json({ error: 'root.rel and root.skip_fp are required' });
    return;
  }
  if (typeof root.local_hash !== 'string' || !/^[0-9a-f]{64}$/.test(root.local_hash)) {
    res.status(400).json({ error: 'root.local_hash must be a sha256 hex digest' });
    return;
  }
  const file = pushFileName(root.file);
  if (file === null) { res.status(400).json({ error: 'root.file must be a single path segment' }); return; }
  const skip = root.skip ?? [];
  if (!Array.isArray(skip) || skip.some(s => typeof s !== 'string') || skip.length > PUSH_MAX_SKIP_PATTERNS) {
    res.status(400).json({ error: 'root.skip must be an array of at most ' + PUSH_MAX_SKIP_PATTERNS + ' strings' });
    return;
  }
  const home = root.home === true;
  // The destination is derived here rather than taken from the request: the
  // check has no upload to pin down, so there is nothing for a caller-supplied
  // target to add beyond another string to validate.
  const target = pushSafeTarget(home ? PUSH_HOME : path.join(PUSH_HOME, root.rel), root.rel, home);
  if (!target) { res.status(400).json({ error: 'rel must name a path inside $HOME' }); return; }

  try {
    const deny = loadPushIgnoreDir(PUSH_IGNORE_DIR);
    const { hash, entries } = await pushHashTarget(target, root.rel, skip as string[], deny, file);
    const rec = syncFind(body.replica, pushRecordRel(root.rel, file), root.skip_fp);
    // What the box actually holds here. A client pulling something it does not
    // have yet cannot tell a file from a directory locally — there is nothing
    // there to look at — and this walk has already been to the path, so saying
    // so costs one lstat and saves a second round trip.
    let targetType = 'missing';
    try {
      const st = await fs.promises.lstat(file ? path.join(target, file) : target);
      targetType = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file';
    } catch { /* missing, which is a fact rather than a failure */ }
    res.json({
      root: {
        state: syncClassify(rec, root.local_hash, hash),
        target_type: targetType,
        // An empty destination has nothing that could have been deleted, which
        // is what lets a first push land in silence with no record to prove it.
        empty:          entries === 0,
        box_hash:       hash,
        at:             rec?.at ?? 0,
        deletes_agreed: rec?.del ?? false,
      },
    });
  } catch (err) {
    res.status(500).json({ error: `sync check failed: ${errorMessage(err)}` });
  }
});

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

const PASTE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

router.post('/api/paste-image',
  express.raw({ type: 'image/*', limit: '5mb' }),
  async (req: express.Request, res: express.Response) => {
    const sid = (req.query.session as string) || '';
    if (!isSessionId(sid) || !sessions.get(sid)) {
      res.status(404).json({ error: 'session not found' }); return;
    }
    const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = PASTE_MIME_EXT[mime];
    if (!ext) { res.status(415).json({ error: 'unsupported image type' }); return; }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'empty body' }); return;
    }
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const mmdd = pad(d.getMonth() + 1) + pad(d.getDate());
    const hms  = pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    const rrr  = Math.random().toString(36).slice(2, 5).padEnd(3, '0');
    const filename = `${mmdd}-${hms}-${rrr}.${ext}`;
    const full = path.join(PASTE_DIR, filename);
    try {
      await fs.promises.writeFile(full, req.body);
    } catch (err) {
      console.error(`[paste] write failed: ${errorMessage(err)}`);
      res.status(500).json({ error: 'write failed' }); return;
    }
    res.json({ path: full });
    if (Math.random() < 0.05) sweepPaste().catch(() => {});
  });

router.post('/api/sessions', async (req: express.Request, res: express.Response) => {
  console.log(`[api] POST /api/sessions body=${JSON.stringify(req.body)}`);
  const createdBy = (req.headers['x-wsh-user'] as string) || '';
  const skillName = (req.body?.skill as string) || '';
  const appKey = (req.body?.app as string) || (skillName ? '' : 'bash');
  const input = (req.body?.input as string) || '';
  const mode = (req.body?.mode as string) || '';
  const notify = !!req.body?.notify;
  const requestedSession = (req.body?.session as string) || '';
  const cwdOverride = (req.body?.cwd as string) || '';
  if (cwdOverride) {
    const err = validateRequestCwd(cwdOverride);
    if (err) { res.status(400).json({ error: err }); return; }
  }
  const envOverride: Record<string, string> = (req.body?.env as Record<string, string>) ?? {};
  const adHocCommand = (req.body?.command as string) || '';
  const adHocType = (req.body?.type as string) || '';
  const adHocTitle = (req.body?.title as string) || '';
  // Banner defaults off for jobs. `banner: true` opts back in.
  // Legacy `noBanner` is silently consumed (it was the default-on inverter; now redundant).
  const adHocBanner = !!req.body?.banner;
  const snapshot = (req.body?.snapshot as string) || '';
  const targetApp = (req.body?.targetApp as string) || '';
  const targetSession = (req.body?.targetSession as string) || '';

  let effectiveConfig: AppConfig;
  let sessionLabel: string;  // used for the URL and session metadata

  if (adHocCommand) {
    // --- Ad-hoc session: raw shell command, no app config lookup ---
    effectiveConfig = {
      command: adHocCommand,
      type: (adHocType || 'pty') as 'pty' | 'web' | 'job',
      title: adHocTitle || deriveTitleFromCommand(adHocCommand),
      ...(cwdOverride ? { cwd: cwdOverride } : {}),
      ...(Object.keys(envOverride).length ? { env: envOverride } : {}),
      ...(adHocBanner ? { banner: true } : {}),
    };
    sessionLabel = appKey || adHocType || 'pty';
  } else if (skillName) {
    // --- Skill path: build config from _skills defaults, agent tool resolves the skill ---
    effectiveConfig = buildSkillConfig(skillName, input, mode, cwdOverride || undefined, Object.keys(envOverride).length ? envOverride : undefined);
    if (!effectiveConfig.title) effectiveConfig.title = skillName + ' skill';
    sessionLabel = 'skill';
  } else {
    // --- App path: lookup from apps.yaml ---
    const apps = loadApps();
    const appConfig = apps[appKey];
    if (!appConfig) { res.status(400).json({ error: `Unknown app: "${appKey}"` }); return; }

    effectiveConfig = appConfig;
    if (appConfig.skill) {
      const skillDefaults = extractSkillDefaults(loadConfigFile(SYSTEM_CONFIG_DIR), loadConfigFile(path.join(os.homedir(), '.wsh')));
      const mergedCommand = appConfig.command || skillDefaults.command || SKILL_DEFAULTS.command!;
      const mergedInline = appConfig.inlineCommand || skillDefaults.inlineCommand;
      const mergedPrefix = appConfig.prefixCommand || skillDefaults.prefixCommand;
      const useInline = mode === 'inline' && mergedInline;
      const usePrefix = !input && !useInline && mergedPrefix;
      console.log(`[api] skill app path: input=${JSON.stringify(input)} mode=${JSON.stringify(mode)} useInline=${!!useInline} usePrefix=${!!usePrefix} mergedPrefix=${JSON.stringify(mergedPrefix)} mergedCommand=${JSON.stringify(mergedCommand)}`);
      if (usePrefix) {
        effectiveConfig = {
          ...appConfig,
          command: mergedPrefix!,
          env: { ...(appConfig.env ?? {}), ...(mode ? { WSH_MODE: mode } : {}) },
        };
      } else {
        effectiveConfig = applySlashPrefix({
          ...appConfig,
          command: useInline ? mergedInline! : mergedCommand,
          env: { ...(appConfig.env ?? {}), SKILL: appConfig.skill, INPUT: input, ...(mode ? { WSH_MODE: mode } : {}) },
        });
      }
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
    unregisterSession(requestedSession, existing, 'replaced');
    if (existing.cleanupTimer !== null) clearTimeout(existing.cleanupTimer);
    broadcastClose(existing, WS_CLOSE.OK, 'Session replaced');
    if (existing.child) killProcessGroup(existing.child);
    else if (existing.pty) existing.pty.kill('SIGHUP');
  }
  if (requestedSession && !isSessionId(requestedSession)) {
    res.status(400).json({ error: 'Session ID must be exactly 6 lowercase alphanumeric characters' }); return;
  }
  let id = requestedSession || crypto.randomInt(0, 2176782336).toString(36).padStart(6, '0');

  // Write snapshot to file so the skill agent can read it directly (faster than env var round-trip).
  // The file path is appended to INPUT so it appears in the command — no env vars for the LLM to read.
  if (skillName && snapshot) {
    writeSkillSnapshot(id, snapshot, targetApp, targetSession);
    const snapshotPath = path.join(SNAPSHOT_DIR, `${id}.md`);
    effectiveConfig = {
      ...effectiveConfig,
      env: { ...effectiveConfig.env, INPUT: `${input} ${snapshotPath}` },
    };
  }

  if (effectiveConfig.type === 'job') {
    try {
      spawnJobSession(id, sessionLabel, effectiveConfig, createdBy);
    } catch (err) {
      console.error('Failed to spawn job:', errorMessage(err));
      res.status(500).json({ error: 'Failed to spawn session' }); return;
    }
  } else if (effectiveConfig.type === 'web') {
    try {
      if (requestedSession) {
        // -s forces a specific id (replacing any prior session above) — bypass the singleton.
        await spawnWebSession(id, sessionLabel, effectiveConfig, createdBy, { notify });
      } else {
        ({ id } = await getOrSpawnWebSession(id, sessionLabel, effectiveConfig, createdBy, { notify }));
      }
    } catch (err) {
      console.error('Failed to spawn web app:', errorMessage(err));
      res.status(500).json({ error: 'Failed to spawn session' }); return;
    }
  } else if (mode === 'inline' && !skillName) {
    // Defer PTY spawn until the first resize message so the PTY starts with
    // the correct terminal dimensions (avoids expensive SIGWINCH re-render).
    // Skill sessions skip deferral — start immediately so the agent boots
    // while the new tab is still loading (saves ~200-500ms to first output).
    createPendingSession(id, sessionLabel, effectiveConfig, createdBy);
  } else {
    try {
      spawnSession(id, sessionLabel, effectiveConfig, createdBy);
    } catch (err) {
      console.error('Failed to spawn PTY:', errorMessage(err));
      res.status(500).json({ error: 'Failed to spawn session' }); return;
    }
  }

  const base = CUSTOM_URL ?? clientOrigin ?? networkBase ?? `http://localhost:${PORT}`;
  const urlPath = skillName ? 'skill' : sessionLabel;
  res.json({ id, url: `${base}${BASE}${urlPath}#${id}` });
});

// Serve the per-app shell HTML. The same handler covers the bare app URL
// (/:appName) and any subpath under it (/:appName/*). When a subpath is
// present, it's the iframe's initial inner path — the parent URL mirrors
// what's inside the iframe so refreshes / bookmarks / shares preserve the
// user's position. {{base}} → BASE inside index.html so all relative URLs
// in the document resolve against ${BASE} via <base href>, regardless of
// how deep the document URL is.
const serveAppHtml = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const apps = loadApps();
  if (!apps[req.params.appName] && !RESERVED_PATHS.has(req.params.appName)) { next(); return; }
  // Singleton/session resolution happens client-side via the WebSocket handshake —
  // the server can't see the hash fragment, so a server-side 302 would loop.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  res.type('html').send(html.replace(/\{\{base\}\}/g, escAttr(BASE)));
};
router.get('/:appName',     serveAppHtml);
router.get('/:appName/*',   serveAppHtml);

router.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, lastModified: true, maxAge: 0 }));

app.use(BASE, router);

const localServer   = http.createServer(app);
const networkServer = (tls && !NO_TLS) ? https.createServer({ key: tls.key, cert: tls.cert }, app) : null;

const wss = new WebSocketServer({ noServer: true });

function getRoleForSession(req: http.IncomingMessage, sessionId: string): Role | null {
  const readWriterToken = (): string | null => new URL(req.url ?? '/', 'http://localhost').searchParams.get('wtoken');
  // Trust-proxy mode: any caller the gateway authorized is an owner of this
  // box. X-WSH-User is informational (used for display) and carries no
  // authority — the source of truth is X-Abox-Allowed.
  if (TRUST_PROXY) {
    if (gatewayAllowed(req)) return 'owner';
    const wt = readWriterToken();
    if (wt !== null && tls) return wt === writerToken(sessionId) ? 'writer' : null;
    return 'viewer';
  }
  if (isLoopback(req.socket.remoteAddress) || !token) return 'owner';
  const cookies = parseCookies(req.headers.cookie ?? '');
  if (cookies['wsh_token'] === token) return 'owner';
  if (tls) {
    const wt = readWriterToken();
    if (wt !== null) return wt === writerToken(sessionId) ? 'writer' : null; // reject bad token
  }
  return 'viewer'; // no writer token → viewer (session ID alone is the viewer secret)
}

function sendRoleMessage(ws: WebSocket, sessionId: string, session: Session, role: Role, credential: Role, replay: ReplayMode = 'full'): void {
  const pinnedOther = role === 'owner'
    ? [...sessions.entries()].filter(([sid, s]) => sid !== sessionId && s.pinned).map(([sid, s]) => ({ id: sid, title: s.title, app: s.app ?? 'bash' }))
    : undefined;
  // `pos` is the stream position the client will be caught up to once the replay
  // that follows this message lands. It has to come from us: replays are stripped,
  // so their byte count is smaller than the stream they stand for and a client
  // counting what it receives would drift.
  ws.send(JSON.stringify({ type: 'role', role, credential, session: sessionId, app: session.app, appType: session.appType, cwd: session.cwd, base: BASE, icon: session.icon, title: session.title, pos: session.scrollbackTotal, replay, ...(role === 'owner' ? { pinned: session.pinned, pinnedOther } : {}) }));
}

/** Admit a peer: role, then `ready` (web), then whatever scrollback it's missing.
 *  Single path so the `replay` mode announced in the role message can't drift
 *  from the bytes actually sent after it. */
function sendAttach(ws: WebSocket, sessionId: string, session: Session, role: Role, credential: Role, since: number): void {
  const { mode, buf } = replayFrom(session, since);
  sendRoleMessage(ws, sessionId, session, role, credential, buf ? mode : 'none');
  if (session.appType === 'web' && session.ready) ws.send(readyMessage(session));
  if (buf) ws.send(buf, { binary: true });
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
    // Non-public web apps require owner-level access. Trust the gateway's
    // verdict in trust-proxy mode; cookie check otherwise.
    if (wsSession.access !== 'public') {
      if (TRUST_PROXY) {
        if (!verifyProxySecret(req) || !gatewayAllowed(req)) {
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
    if (!verifyProxySecret(req) || getRoleForSession(req, sessionId) === null) {
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
  const createdBy = ((req.headers['x-wsh-user'] as string) || '').toString();
  let id  = url.searchParams.get('session');

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

  // Public apps (web or pty) may be joined or auto-spawned by anyone the gateway
  // forwarded — that's the whole point of marking them public. Track this so
  // both the new-session and missing-session branches below can permit it.
  const requestedAppForPublic = url.searchParams.get('app') ?? '';
  const apps = loadApps();
  const publicApp = isPublicJoinable(apps[requestedAppForPublic]);

  if (!id) {
    const cred = getRoleForSession(req, '') ?? 'viewer';
    if (cred !== 'owner' && !publicApp) { ws.close(WS_CLOSE.SESSION_REQUIRED, 'session ID required'); return; }
    id = crypto.randomInt(0, 2176782336).toString(36).padStart(6, '0');
  }

  console.log(`[ws] connect session=${id} url=${req.url}`);

  let session = sessions.get(id);
  let credential = getRoleForSession(req, id) ?? 'viewer';
  // Stream position this client already has, so a reattach can be handed just
  // the tail it missed. Absent/garbage means "I have nothing" → full replay.
  const sinceRaw = Number(url.searchParams.get('since'));
  const since = Number.isSafeInteger(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;

  // Public PTY apps: a forwarded stranger drives their OWN per-visitor session,
  // so grant 'writer' (type/resize/clear) — never 'owner', which would disclose
  // other sessions via pinnedOther and allow pin/keep-alive. For an existing
  // session, derive public-pty from the session itself (not the requested
  // ?app=) so ?app=<public-pty>&session=<private-id> can't elevate a stranger
  // on someone else's private session. Public WEB apps stay viewers (they drive
  // the app through the iframe, not the role-gated WS channel).
  if (credential === 'viewer') {
    const publicPty = session ? isPublicPtySession(session) : isPublicPtyConfig(apps[requestedAppForPublic]);
    if (publicPty) credential = 'writer';
  }
  // View-only sharing is disabled for TUI sessions: reject a pure viewer joining
  // an existing pty session. Public-pty visitors were upgraded to 'writer' just
  // above, and yielding owners/writers keep their owner/writer credential, so
  // only session-ID-secret viewers are blocked here. Web apps are unaffected.
  if (!ALLOW_PTY_VIEWERS && credential === 'viewer' && session?.appType === 'pty') {
    ws.close(WS_CLOSE.FORBIDDEN, 'view-only sharing is disabled for terminal sessions');
    return;
  }
  // ?yield=1 lets a writer/owner rejoin as viewer without displacing the current writer.
  const yields = (credential === 'owner' || credential === 'writer') && url.searchParams.get('yield') === '1';
  const isWriter = !yields && (credential === 'owner' || credential === 'writer');

  // Job sessions are non-interactive — they have no WS surface. Use SSE
  // (`/api/sessions/:id/stream`) or HTTP (`/api/sessions/:id/logs`) instead.
  if (session?.appType === 'job') {
    ws.close(WS_CLOSE.FORBIDDEN, 'jobs are not viewable via WebSocket');
    return;
  }

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
    sendAttach(ws, id, session, sentRole, credential, since);
  } else {
    // reconnect=1 means "attach to an existing session, don't create a new one" —
    // a reconnecting PTY client wants its shell back, not a surprise fresh one.
    //
    // Web apps are the exception. They're singletons resolved by app key, and the
    // HTTP proxy (`/_a/<appKey>`) already auto-spawns them, so the iframe can
    // revive an app that the control WebSocket refuses to. A client whose session
    // ID died with a server restart (or a `wsh new -s` replacement) must be able
    // to find — or restart — the singleton here; otherwise every retry it makes
    // can only ever come back 4003 and it retries forever against a wall.
    if (url.searchParams.get('reconnect') === '1' && apps[requestedAppForPublic]?.type !== 'web') {
      ws.close(WS_CLOSE.FORBIDDEN, 'session not found');
      return;
    }
    const remoteIp = normalizeIp(req.socket.remoteAddress);
    if (credential !== 'owner' && !publicApp) {
      // Rate-limit invalid session attempts per IP to prevent brute-force scanning.
      if (remoteIp && !isLoopback(remoteIp)) {
        const now = Date.now();
        const attempts = missAttempts.get(remoteIp)?.filter(t => t > now - RATE_WINDOW) ?? [];
        attempts.push(now);
        missAttempts.set(remoteIp, attempts);
        if (attempts.length > RATE_MAX_MISS) {
          ws.close(WS_CLOSE.RATE_LIMIT, 'too many attempts');
          return;
        }
      }
      ws.close(WS_CLOSE.FORBIDDEN, 'only owners can create sessions');
      return;
    }
    const wsSkillName = url.searchParams.get('skill') || '';
    const requestedApp = url.searchParams.get('app') || (wsSkillName ? '' : 'bash');

    // Reserved paths (e.g. "skill") are not real apps — if the session is gone,
    // don't silently fall back to bash.  Close with 4003 so the client shows
    // "Session not found" instead of spawning an unexpected shell.
    if (!wsSkillName && RESERVED_PATHS.has(requestedApp) && !apps[requestedApp]) {
      ws.close(WS_CLOSE.FORBIDDEN, 'session not found');
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

      // Web apps are singletons: join existing session if one is running
      if (appConfig.type === 'web') {
        const existing = findWebSession(appKey);
        if (existing) {
          id = existing.id;
          session = existing.session;
        }
      }

      effectiveConfig = appConfig;
      if (appConfig.skill) {
        const wsInput = url.searchParams.get('input') || '';
        const wsMode = url.searchParams.get('mode') || '';
        const useInline = wsMode === 'inline' && appConfig.inlineCommand;
        effectiveConfig = applySlashPrefix({
          ...appConfig,
          ...(useInline ? { command: appConfig.inlineCommand! } : {}),
          env: { ...(appConfig.env ?? {}), SKILL: appConfig.skill, INPUT: wsInput, ...(wsMode ? { WSH_MODE: wsMode } : {}) },
        });
      }
      sessionLabel = appKey;
    }

    if (session) {
      // Joining existing web singleton — same logic as the existing-session path above.
      if (session.cleanupTimer !== null) { clearTimeout(session.cleanupTimer); session.cleanupTimer = null; }
      const effectiveWriter = isWriter || (yields && session.writer === null);
      if (effectiveWriter) {
        if (session.writer && session.writer.readyState === WebSocket.OPEN) {
          session.writer.send(JSON.stringify({ type: 'role', role: 'viewer' }));
        }
        session.writer = ws;
      }
      const sentRole = (yields && !effectiveWriter) ? 'viewer' : credential;
      session.peers.set(ws, sentRole);
      sendAttach(ws, id, session, sentRole, credential, since);
    } else if (effectiveConfig.type === 'job') {
      // Jobs cannot be spawned via WebSocket — use POST /api/sessions instead.
      ws.close(WS_CLOSE.FORBIDDEN, 'jobs must be created via POST /api/sessions');
      return;
    } else if (effectiveConfig.type === 'web') {
      try {
        ws.send(JSON.stringify({ type: 'status', status: 'starting' }));
        // Guard collapses a concurrent first-hit onto the same child; a rival
        // connection may have won, so adopt the returned id/session.
        ({ id, session } = await getOrSpawnWebSession(id, sessionLabel, effectiveConfig, createdBy));
      } catch (err) {
        console.error('Failed to spawn web app:', errorMessage(err));
        ws.close(WS_CLOSE.INTERNAL_ERROR, 'Failed to spawn web app');
        return;
      }
    } else {
      // Public PTY apps spawn a fresh per-visitor process (no multiplexing), so
      // bound concurrent spawns per source IP — otherwise a stranger could
      // fork-bomb the box. Count live public-pty sessions straight from the map
      // (self-correcting: a session that exits drops out, no counter to drift).
      // Owners and loopback are exempt; this branch is pty-only (job/web above).
      if (credential !== 'owner' && effectiveConfig.access === 'public' && remoteIp && !isLoopback(remoteIp)) {
        let live = 0;
        for (const s of sessions.values()) if (s.creatorIp === remoteIp && isPublicPtySession(s)) live++;
        if (live >= PUBLIC_PTY_MAX_PER_IP) {
          ws.close(WS_CLOSE.RATE_LIMIT, 'too many sessions');
          return;
        }
      }
      try {
        session = spawnSession(id, sessionLabel, effectiveConfig, createdBy);
        session.creatorIp = remoteIp ?? undefined;
      } catch (err) {
        console.error('Failed to spawn PTY:', errorMessage(err));
        ws.close(WS_CLOSE.INTERNAL_ERROR, 'Failed to spawn PTY');
        return;
      }
    }
    if (!session) { ws.close(WS_CLOSE.INTERNAL_ERROR, 'Failed to create session'); return; }
    // For newly spawned sessions (not singleton joins), attach writer and send role.
    if (!session.peers.has(ws)) {
      session.writer = ws;
      session.peers.set(ws, credential);
      if (session.cleanupTimer !== null) {
        clearTimeout(session.cleanupTimer);
        session.cleanupTimer = null;
      }
      // A guard-resolved web singleton may already be ready (its ready broadcast
      // fired before this peer attached) — sendAttach replays it so the iframe loads.
      sendAttach(ws, id, session, credential, credential, since);
    }
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
      if (currentSession.appType === 'web') return; // no PTY input for web sessions (jobs are rejected at connect)
      currentSession.lastInput = Date.now();
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      currentSession.bytesIn += buf.length;
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
              ws.close(WS_CLOSE.INTERNAL_ERROR, 'Failed to spawn PTY');
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
          clearScrollback(currentSession);
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
      // Plain PTY input (keystrokes, paste, shortcut bar) arrives as a text
      // frame — term.onData on the client sends a string. This, not the
      // binary branch above, is the real client→PTY path: count it.
      if (currentSession.pty) {
        currentSession.lastInput = Date.now();
        currentSession.bytesIn += Buffer.byteLength(text);
        currentSession.pty.write(text);
      }
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
        console.log(`[session ${id}] writer detached, ${currentSession.pinned ? 'session pinned (no timeout)' : `cleanup in ${effectiveTTL(currentSession) / 1000}s`}`);
      }
    } else if (currentSession.peers.size === 0 && currentSession.writer === null) {
      // Last viewer left and no writer — ensure cleanup is scheduled.
      scheduleCleanup(id, currentSession);
      console.log(`[session ${id}] last peer left, ${currentSession.pinned ? 'session pinned (no timeout)' : `cleanup in ${effectiveTTL(currentSession) / 1000}s`}`);
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
    if (!pongReceived) { ws.close(WS_CLOSE.PONG_TIMEOUT, 'pong timeout'); return; }
    pongReceived = false;
    ws.ping();
    pongTimer = setTimeout(() => {
      if (!pongReceived) ws.close(WS_CLOSE.PONG_TIMEOUT, 'pong timeout');
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

  // Write port file so CLI subcommands can discover the server
  try { fs.writeFileSync(PORT_FILE, String(PORT)); } catch {}

  console.log('');
  console.log(`  Local:       ${localURL}`);
  if (networkURL) console.log(`  Network:     ${networkURL}`);
  if (tls && !NO_TLS) console.log(`  Fingerprint: ${new crypto.X509Certificate(tls.cert).fingerprint256}`);
  console.log(`  Version:     v${version}`);
  console.log('');

  // Surface config warnings (e.g. dangerous public-PTY apps) to the box owner
  // in the server log — they may never open the catalog where the toast shows.
  const startupWarnings: string[] = [];
  loadApps(startupWarnings);
  for (const w of startupWarnings) console.warn(`  ⚠ ${w}`);
  if (startupWarnings.length) console.log('');

  // Launch daemon web apps now that the proxy and health checks are live.
  startDaemonApps();

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
} // end no-server guard (__wshFollowMode / __wshNoServer)
