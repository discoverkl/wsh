# Event System Test Guide

## Setup

Rebuild and deploy wsh with the latest code. Verify the commands exist:

```bash
wsh emit --help
wsh events --help
```

## 1. Basic Emit + Consume

Open two terminals.

**Terminal 1 — consumer:**
```bash
wsh events
```

**Terminal 2 — emit:**
```bash
wsh emit test.hello msg=world
wsh emit deploy.started env=staging branch=main
```

Expected: Terminal 1 prints two JSON lines as they arrive:
```
{"type":"test.hello","ts":...,"data":{"msg":"world"}}
{"type":"deploy.started","ts":...,"data":{"env":"staging","branch":"main"}}
```

## 2. Emit with --json

```bash
wsh emit test.ping --json
```

Expected: prints the created event JSON. Without `--json`, silent (exit 0).

## 3. Emit via stdin

```bash
echo '{"results":[1,2,3],"nested":{"key":"val"}}' | wsh emit test.complex
```

Verify in consumer terminal.

## 4. Filter

**Terminal 1:**
```bash
wsh events --filter 'deploy.*'
```

**Terminal 2:**
```bash
wsh emit deploy.started env=prod
wsh emit test.unrelated foo=bar
wsh emit deploy.finished status=ok
```

Expected: Terminal 1 only shows `deploy.started` and `deploy.finished`, not `test.unrelated`.

## 5. Exec Mode

```bash
wsh events --filter 'test.*' --exec 'echo "got $EVENT_TYPE with data: $EVENT"'
```

Then in another terminal:
```bash
wsh emit test.hello msg=world
```

Expected: prints `got test.hello with data: {"type":"test.hello","ts":...,"data":{"msg":"world"}}`

## 6. Exec Mode — Flat Data Env Vars

```bash
wsh events --filter 'deploy.*' --exec 'echo "Deploying $branch to $env"'
```

Then:
```bash
wsh emit deploy.started env=staging branch=main
```

Expected: prints `Deploying main to staging`

## 7. Exec Mode — {} Placeholder

```bash
wsh events --filter 'test.*' --exec 'echo received: {}'
```

Then:
```bash
wsh emit test.ping
```

Expected: `received: {"type":"test.ping","ts":...}`

## 8. Exec Mode — Handler Failure

```bash
wsh events --exec 'false'
```

Then emit any event. Expected: logs an error like `[wsh events] exec failed (exit 1): false` but keeps running. Emit again — still receives events.

## 9. Persistence (Survives Restart)

```bash
wsh emit before.restart msg=hello
```

Restart wsh (or the box). Then:

```bash
wsh events --since 0
```

Expected: the `before.restart` event appears in the replay.

## 10. Named Consumer + Cursor Resume

**Step 1 — consume some events:**
```bash
wsh events --name test-bot --filter 'job.*' &
BOT_PID=$!
wsh emit job.started id=1
wsh emit job.completed id=1
sleep 1
kill $BOT_PID
```

**Step 2 — emit while consumer is down:**
```bash
wsh emit job.started id=2
wsh emit job.completed id=2
```

**Step 3 — reconnect:**
```bash
wsh events --name test-bot --filter 'job.*'
```

Expected: replays `job.started id=2` and `job.completed id=2` (the events missed while down), then streams live.

## 11. HTTP API

**Emit:**
```bash
curl -X POST http://localhost:$(cat ~/.wsh/port)/api/events \
  -H 'Content-Type: application/json' \
  -d '{"type":"http.test","data":{"source":"curl"}}'
```

**Consume (SSE):**
```bash
curl -N http://localhost:$(cat ~/.wsh/port)/api/events?filter=http.*
```

Expected: SSE stream with `data: {...}` lines. Should see `: ping` comments every 30s.

## 12. Log Rotation

Check events are being written:
```bash
wc -l ~/.wsh/events.log
cat ~/.wsh/events.log | tail -3
```

Cursor files for named consumers:
```bash
ls ~/.wsh/events/cursors/
cat ~/.wsh/events/cursors/test-bot
```
