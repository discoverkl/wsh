# wsh

A browser-based terminal you can share. Run it on your machine, open the URL, and get a full shell in your browser — then hand out writer or viewer links to let others in.

## Install

```sh
curl -fsSL https://github.com/discoverkl/wsh/releases/latest/download/install.sh | sh
```

Installs the `wsh` binary to `~/.local/bin`. Supported platforms: macOS (Apple Silicon), Linux (x64, arm64).

## Usage

```sh
wsh                      # start and open browser
wsh -p 4000              # custom port
wsh --no-open            # don't open browser automatically
wsh --bind 0.0.0.0       # bind to all interfaces (e.g. Docker)
wsh --url https://...    # override advertised network URL (NAT/proxy)
wsh --version            # print version and exit
```

On startup, wsh prints a local URL and, when a network interface is available, a LAN URL with a one-time access token:

```
  Local:       http://localhost:3000
  Network:     https://192.168.1.5:3000/?token=abc123...
  Fingerprint: AA:BB:CC:...
  Version:     v0.3.1
```

Open the local URL to start your session. Share the Network URL with others on your LAN.

## Sharing

Click the share icon in the titlebar to get per-session links:

- **Writer link** — recipient can type in the terminal
- **Viewer link** — recipient gets a read-only view

Only one writer is active at a time. A new writer displaces the current one, who is demoted to viewer. The role badge in the titlebar shows your current role and can be clicked to switch between writer and viewer without reloading the page. Demotion persists across refreshes.

## Session lifetime

Sessions are cleaned up 10 minutes after the last writer disconnects. Click the **pin button** (owner only) to keep a session alive indefinitely — useful for long-running processes you want to check back on. Unpinning restarts the 10-minute timer. Pinned state is in-memory only and does not survive a server restart.

## Security

- HTTPS is used automatically on the LAN interface (self-signed cert, fingerprint printed on startup)
- The owner token grants full access and is only shared via the Network URL
- Writer links are authenticated with a per-session token
- Viewer links require only the session ID — treat them as semi-private (the ID is a random 6-char base-36 token)

## Build from source

```sh
git clone https://github.com/discoverkl/wsh
cd wsh
npm ci && npm run build
go build -o wsh .
./wsh
```

Requires Node.js 20+ and Go 1.22+.
