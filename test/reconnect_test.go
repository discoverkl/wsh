package wsh_test

// Reconnect semantics for the `reconnect=1` query param on /terminal.
//
// `reconnect=1` means "attach to my session, don't create a new one" — a
// reconnecting PTY client wants its shell back, not a surprise fresh one. Web
// apps are the exception: they're singletons resolved by app key, and the HTTP
// proxy (/_a/<appKey>) already auto-spawns them, so the browser's control socket
// must be able to find or restart the singleton too. When it couldn't, a client
// whose session ID died with a server restart could only ever get 4003 back, and
// the page retried against that wall forever.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// writeApps installs a user-level apps.yaml in an isolated HOME.
func writeApps(t *testing.T, cfg string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".wsh"), 0o755); err != nil {
		t.Fatalf("mkdir .wsh: %v", err)
	}
	if cfg == "" {
		return
	}
	if err := os.WriteFile(filepath.Join(home, ".wsh", "apps.yaml"), []byte(cfg), 0o644); err != nil {
		t.Fatalf("write apps.yaml: %v", err)
	}
}

// dialWS opens /terminal with a raw query string.
func dialWS(t *testing.T, s *server, query string) *websocket.Conn {
	t.Helper()
	url := fmt.Sprintf("ws://127.0.0.1:%d%sterminal?%s", s.port, s.base, query)
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("ws dial ?%s: %v", query, err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// readMsgType reads until a JSON message of the given type arrives. A close
// frame (or any read failure) is returned as the error, so callers can assert on
// the close code.
func readMsgType(t *testing.T, c *websocket.Conn, want string) (map[string]any, error) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			return nil, err
		}
		var msg map[string]any
		if json.Unmarshal(data, &msg) != nil {
			continue // binary PTY output
		}
		if msg["type"] == want {
			return msg, nil
		}
	}
}

const webApp = "webby:\n  command: sleep 100\n  type: web\n"

// A reconnect that names a dead session must land on the live singleton rather
// than being turned away — otherwise two tabs of the same app disagree about
// which child they're driving.
func TestWebReconnectAdoptsLiveSingleton(t *testing.T) {
	writeApps(t, webApp)
	srv := startServer(t)

	first := dialWS(t, srv, "app=webby")
	role, err := readMsgType(t, first, "role")
	if err != nil {
		t.Fatalf("initial connect: %v", err)
	}
	liveID := str(role["session"])
	if liveID == "" {
		t.Fatalf("no session ID in role message: %v", role)
	}

	second := dialWS(t, srv, "app=webby&session=deadxx&reconnect=1")
	role2, err := readMsgType(t, second, "role")
	if err != nil {
		t.Fatalf("reconnect with a stale session ID was rejected: %v", err)
	}
	if got := str(role2["session"]); got != liveID {
		t.Errorf("reconnect should adopt the live singleton %q, got %q", liveID, got)
	}
}

// The real-world case: the server restarted, so the session the browser is
// holding is gone entirely. The reconnect has to be able to bring the app back,
// exactly as an HTTP hit on /_a/<appKey> would.
func TestWebReconnectRespawnsDeadSingleton(t *testing.T) {
	writeApps(t, webApp)
	srv := startServer(t)

	first := dialWS(t, srv, "app=webby")
	role, err := readMsgType(t, first, "role")
	if err != nil {
		t.Fatalf("initial connect: %v", err)
	}
	deadID := str(role["session"])
	first.Close()

	if code, body := srv.deleteJSONRaw(t, "/api/sessions/"+deadID); code != 200 {
		t.Fatalf("delete session: status %d body=%v", code, body)
	}
	// Deletion is asynchronous — the session goes away when the child exits.
	waitSessions(t, srv, "webby", 0)

	second := dialWS(t, srv, "app=webby&session="+deadID+"&reconnect=1")
	if _, err := readMsgType(t, second, "role"); err != nil {
		t.Fatalf("reconnect after the session died was rejected: %v", err)
	}
	if n := countSessions(t, srv, "webby"); n != 1 {
		t.Errorf("reconnect should have brought the app back, found %d session(s)", n)
	}
}

// waitSessions polls until the app has exactly want live sessions.
func waitSessions(t *testing.T, s *server, app string, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		n := countSessions(t, s, app)
		if n == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("want %d %q session(s), have %d", want, app, n)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// countSessions reports how many live sessions are running the given app.
func countSessions(t *testing.T, s *server, app string) int {
	t.Helper()
	resp := s.getJSON(t, "/api/sessions?all=1")
	list, _ := resp["sessions"].([]any)
	n := 0
	for _, item := range list {
		if m, ok := item.(map[string]any); ok && str(m["app"]) == app {
			n++
		}
	}
	return n
}

// PTY sessions keep the strict behavior: a dead session ID is a dead end, not a
// licence to spawn an unexpected shell.
func TestPtyReconnectRefusesToSpawn(t *testing.T) {
	writeApps(t, "")
	srv := startServer(t)

	conn := dialWS(t, srv, "app=bash&session=deadxx&reconnect=1")
	msg, err := readMsgType(t, conn, "role")
	if err == nil {
		t.Fatalf("expected the connection to be refused, got a role message: %v", msg)
	}
	ce, ok := err.(*websocket.CloseError)
	if !ok {
		t.Fatalf("expected a WebSocket close, got %v", err)
	}
	if ce.Code != 4003 {
		t.Errorf("want close code 4003, got %d (%s)", ce.Code, ce.Text)
	}
}

// Without reconnect=1 a PTY client is still allowed to create a session — the
// refusal above must come from the reconnect flag, not from the stale ID.
func TestPtyWithoutReconnectFlagStillSpawns(t *testing.T) {
	writeApps(t, "")
	srv := startServer(t)

	conn := dialWS(t, srv, "app=bash&session=deadxx")
	if _, err := readMsgType(t, conn, "role"); err != nil {
		t.Fatalf("plain connect should spawn a session: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Resume from offset
// ---------------------------------------------------------------------------

// A client reattaching at a known stream position gets only the output it
// missed. Replaying the whole buffer instead would force the client to clear
// and redraw the session on every blip — correct, but a visible jolt, and on a
// long agent session an expensive one.

const streamApps = "ticker:\n  command: sh -c 'i=0; while true; do i=$((i+1)); echo LINE$i; sleep 0.2; done'\n" +
	"greeter:\n  command: sh -c 'echo HELLO; sleep 30'\n"

type attachment struct {
	conn     *websocket.Conn
	session  string
	replay   string // mode the server announced: none | tail | full
	pos      int    // stream position we're caught up to
	replayed string // bytes of the replay frame, if any
	live     string // live output read since
}

// attachStream connects, reads the role message, and consumes the one replay
// frame it announces — mirroring how the browser client tracks its position.
func attachStream(t *testing.T, s *server, query string) *attachment {
	t.Helper()
	conn := dialWS(t, s, query)
	role, err := readMsgType(t, conn, "role")
	if err != nil {
		t.Fatalf("attach ?%s: %v", query, err)
	}
	a := &attachment{conn: conn, session: str(role["session"]), replay: str(role["replay"])}
	if p, ok := role["pos"].(float64); ok {
		a.pos = int(p)
	}
	if a.replay != "none" {
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		typ, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read replay frame: %v", err)
		}
		if typ != websocket.BinaryMessage {
			t.Fatalf("expected a binary replay frame after replay=%q, got type %d: %s", a.replay, typ, data)
		}
		a.replayed = string(data)
	}
	return a
}

// pump reads live output until `want` shows up, advancing the stream position
// by the live bytes exactly as the client does.
func (a *attachment) pump(t *testing.T, want string, timeout time.Duration) {
	t.Helper()
	a.conn.SetReadDeadline(time.Now().Add(timeout))
	defer a.conn.SetReadDeadline(time.Time{})
	for !strings.Contains(a.live, want) {
		typ, data, err := a.conn.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for %q: %v (have %q)", want, err, a.live)
		}
		if typ != websocket.BinaryMessage {
			continue // control message — carries no stream bytes
		}
		a.pos += len(data)
		a.live += string(data)
	}
}

func TestReattachReplaysOnlyTheGap(t *testing.T) {
	writeApps(t, streamApps)
	srv := startServer(t)

	first := attachStream(t, srv, "app=ticker")
	first.pump(t, "LINE3", 10*time.Second)
	pos, sid := first.pos, first.session
	first.conn.Close()

	// Miss a few lines.
	time.Sleep(1 * time.Second)

	second := attachStream(t, srv, fmt.Sprintf("app=ticker&session=%s&reconnect=1&since=%d", sid, pos))
	if second.replay != "tail" {
		t.Fatalf("want a tail replay, got %q (replayed %q)", second.replay, second.replayed)
	}
	if strings.Contains(second.replayed, "LINE1\r\n") {
		t.Errorf("tail re-sent output we already had: %q", second.replayed)
	}
	if !strings.Contains(second.replayed, "LINE4") {
		t.Errorf("tail missing the output produced during the gap: %q", second.replayed)
	}
}

// Caught up completely: nothing to replay, so the client keeps its screen and
// the terminal is never cleared.
func TestReattachCaughtUpReplaysNothing(t *testing.T) {
	writeApps(t, streamApps)
	srv := startServer(t)

	first := attachStream(t, srv, "app=greeter")
	first.pump(t, "HELLO", 10*time.Second)
	pos, sid := first.pos, first.session
	first.conn.Close()

	second := attachStream(t, srv, fmt.Sprintf("app=greeter&session=%s&reconnect=1&since=%d", sid, pos))
	if second.replay != "none" {
		t.Errorf("want replay=none for a caught-up client, got %q (replayed %q)", second.replay, second.replayed)
	}
}

// When the requested offset has fallen out of the ring the server must send a
// full replay and say so, because the client has to clear before writing it or
// the session renders twice. Overflowing a web session's 512 KB buffer is the
// cheap way to reach that branch.
func TestReattachFallsBackToFullReplayWhenGapTooOld(t *testing.T) {
	writeApps(t, "flood:\n  type: web\n  command: sh -c 'yes ABCDEFGHIJ | head -n 60000; echo TAILMARK; sleep 30'\n")
	srv := startServer(t)

	first := attachStream(t, srv, "app=flood")
	first.pump(t, "TAILMARK", 20*time.Second)
	sid := first.session
	first.conn.Close()

	// Position 1 is long gone: 660 KB was written through a 512 KB buffer.
	second := attachStream(t, srv, fmt.Sprintf("app=flood&session=%s&reconnect=1&since=1", sid))
	if second.replay != "full" {
		t.Errorf("want a full replay for an offset that fell out of the buffer, got %q", second.replay)
	}
}

// `clear` empties the buffer while the stream position keeps counting (and the
// PTY echoes the ^L it triggers, so the buffer isn't idle afterwards). The
// reattach must not resurrect the cleared output.
func TestReattachAfterClearDoesNotResurrectOutput(t *testing.T) {
	writeApps(t, streamApps)
	srv := startServer(t)

	first := attachStream(t, srv, "app=greeter")
	first.pump(t, "HELLO", 10*time.Second)
	pos, sid := first.pos, first.session
	if err := first.conn.WriteJSON(map[string]any{"type": "clear"}); err != nil {
		t.Fatalf("send clear: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	first.conn.Close()

	second := attachStream(t, srv, fmt.Sprintf("app=greeter&session=%s&reconnect=1&since=%d", sid, pos))
	if strings.Contains(second.replayed, "HELLO") {
		t.Errorf("cleared output came back on reattach (replay=%q): %q", second.replay, second.replayed)
	}
}

// A fresh client (no `since`) still gets the whole buffer.
func TestFirstAttachReplaysEverything(t *testing.T) {
	writeApps(t, streamApps)
	srv := startServer(t)

	first := attachStream(t, srv, "app=greeter")
	first.pump(t, "HELLO", 10*time.Second)
	sid := first.session
	first.conn.Close()

	second := attachStream(t, srv, "app=greeter&session="+sid)
	if second.replay != "full" {
		t.Fatalf("want a full replay for a client with no position, got %q", second.replay)
	}
	if !strings.Contains(second.replayed, "HELLO") {
		t.Errorf("full replay missing earlier output: %q", second.replayed)
	}
}
