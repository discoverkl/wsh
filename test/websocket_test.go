package wsh_test

// ┌───────────────────────────────────────┬───────────────────────────────────────────────────┐
// │ Test                                  │ Description                                       │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestWebSocket                         │ WebSocket terminal connection                     │
// │  ├ connect creates session            │ WS connect yields owner role                      │
// │  ├ reconnect to existing              │ second WS to same session works                   │
// │  ├ reconnect=1 rejects missing        │ reconnect=1 with bad id → 4003                   │
// │  ├ resize                             │ resize message accepted                           │
// │  └ receives PTY output                │ echo command output arrives via WS                │
// └───────────────────────────────────────┴───────────────────────────────────────────────────┘

import (
	"fmt"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestWebSocket(t *testing.T) {
	srv := startServer(t)

	t.Run("connect creates session", func(t *testing.T) {
		ws := srv.connectTerminal(t, "")
		role := ws.readRole(t)

		assertEqual(t, role.Role, "owner")
		assertEqual(t, role.Credential, "owner")
		assertEqual(t, role.App, "bash")

		list := srv.getJSON(t, "/api/sessions")
		sessions := list["sessions"].([]any)
		assertEqual(t, len(sessions), 1)
	})

	t.Run("reconnect to existing", func(t *testing.T) {
		ws1 := srv.connectTerminal(t, "")
		role := ws1.readRole(t)

		ws2 := srv.connectTerminal(t, role.sessionID)
		role2 := ws2.readRole(t)
		assertEqual(t, role2.Role, "owner")
	})

	t.Run("reconnect=1 rejects missing session", func(t *testing.T) {
		conn, resp, err := websocket.DefaultDialer.Dial(
			fmt.Sprintf("ws://127.0.0.1:%d/terminal?session=nosuchid&reconnect=1", srv.port), nil,
		)
		if err == nil {
			_, _, readErr := conn.ReadMessage()
			if closeErr, ok := readErr.(*websocket.CloseError); ok {
				assertEqual(t, closeErr.Code, 4003)
			} else {
				t.Fatalf("expected close error, got %v", readErr)
			}
			conn.Close()
		} else if resp != nil && resp.StatusCode == 101 {
			t.Fatal("expected rejection, got upgrade")
		}
	})

	t.Run("resize", func(t *testing.T) {
		ws := srv.connectTerminal(t, "")
		ws.readRole(t)

		ws.sendJSON(t, map[string]any{
			"type": "resize",
			"cols": 120,
			"rows": 40,
		})
	})

	t.Run("receives PTY output", func(t *testing.T) {
		ws := srv.connectTerminal(t, "")
		ws.readRole(t)

		ws.sendBinary(t, []byte("echo wsh-test-marker\n"))

		found := ws.readUntil(t, "wsh-test-marker", 5*time.Second)
		if !found {
			t.Fatal("did not receive PTY output containing 'wsh-test-marker'")
		}
	})
}
