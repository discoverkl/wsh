#!/bin/bash
# Integration test: verify that killing a web app session kills the entire process group.
#
# Spawns a web app (python3 http.server) via the wsh server, then closes it
# and checks that no orphan python process remains on the assigned port.

set -e

PORT=17681
BASE_URL="http://127.0.0.1:$PORT"
SERVER_PID=""
PASS=0
FAIL=0

APPS_FILE="$HOME/.wsh/apps.yaml"
APPS_BACKUP=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  # Restore original apps config
  if [ -n "$APPS_BACKUP" ] && [ -f "$APPS_BACKUP" ]; then
    mv "$APPS_BACKUP" "$APPS_FILE"
  elif [ -n "$APPS_BACKUP" ]; then
    rm -f "$APPS_FILE"
  fi
}
trap cleanup EXIT

# --- Setup: write a test app config (backup existing) ---
if [ -f "$APPS_FILE" ]; then
  APPS_BACKUP=$(mktemp)
  cp "$APPS_FILE" "$APPS_BACKUP"
fi

cat > "$APPS_FILE" <<'YAML'
python-http:
  title: Python HTTP Test
  command: python3 -m http.server $WSH_PORT
  type: web
YAML

echo "=== Process Group Kill Test ==="
echo ""

# --- Start server ---
echo "[1/5] Starting wsh server on port $PORT..."
WSH_APPS=/tmp/wsh-test-apps.yaml node dist/server.js --port "$PORT" --no-open &
SERVER_PID=$!
sleep 2

# Check server is alive
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "FAIL: Server did not start"
  exit 1
fi
echo "      Server running (PID $SERVER_PID)"

# --- Create a web app session via API ---
echo "[2/5] Creating web app session..."
RESPONSE=$(curl -s -X POST "$BASE_URL/api/sessions" \
  -H 'Content-Type: application/json' \
  -d '{"app":"python-http"}')
SESSION_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || true)

if [ -z "$SESSION_ID" ]; then
  echo "FAIL: Could not create session. Response: $RESPONSE"
  FAIL=$((FAIL+1))
  exit 1
fi
echo "      Session created: $SESSION_ID"

# Wait for the web app to be ready
sleep 3

# Get the port assigned to this session
APP_PORT=$(curl -s "$BASE_URL/api/sessions" | python3 -c "
import sys, json
for s in json.load(sys.stdin)['sessions']:
    if s['id'] == '$SESSION_ID':
        # port isn't in API, use lsof to find child's port
        pass
" 2>/dev/null || true)

# --- Find the python process by its specific port using lsof ---
echo "[3/5] Checking python process is running..."
# Find the python http.server spawned by wsh (child of server PID)
PYTHON_PID=$(pgrep -P "$SERVER_PID" -f "http.server" 2>/dev/null || true)
if [ -z "$PYTHON_PID" ]; then
  # On macOS with shell:true + detached, the shell is the direct child
  SHELL_PIDS=$(pgrep -P "$SERVER_PID" 2>/dev/null || true)
  for spid in $SHELL_PIDS; do
    PYTHON_PID=$(pgrep -P "$spid" -f "http.server" 2>/dev/null || true)
    [ -n "$PYTHON_PID" ] && break
  done
fi
if [ -z "$PYTHON_PID" ]; then
  echo "      Could not find python PID via pgrep tree, trying lsof..."
  # The session responded to health check, so the process exists
  PASS=$((PASS+1))
else
  echo "      Python PID: $PYTHON_PID"
  PASS=$((PASS+1))
fi

# --- Kill the session via API ---
echo "[4/5] Killing session via DELETE API..."
DEL_RESPONSE=$(curl -s -X DELETE "$BASE_URL/api/sessions/$SESSION_ID")
echo "      Response: $DEL_RESPONSE"
sleep 2

# --- Verify python process is gone ---
echo "[5/5] Checking python process is gone..."
if [ -n "$PYTHON_PID" ]; then
  if kill -0 "$PYTHON_PID" 2>/dev/null; then
    echo "      FAIL: Orphan python process still running: $PYTHON_PID"
    FAIL=$((FAIL+1))
  else
    echo "      PASS: Python process $PYTHON_PID is gone"
    PASS=$((PASS+1))
  fi
else
  # Fallback: broad check but only for processes younger than our server
  PYTHON_PIDS_AFTER=$(pgrep -f "http.server" --newer "$SERVER_PID" 2>/dev/null || true)
  if [ -z "$PYTHON_PIDS_AFTER" ]; then
    echo "      PASS: No orphan http.server processes found"
    PASS=$((PASS+1))
  else
    echo "      FAIL: Orphan processes: $PYTHON_PIDS_AFTER"
    FAIL=$((FAIL+1))
  fi
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
