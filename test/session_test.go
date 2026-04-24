package wsh_test

// ┌───────────────────────────────────────┬───────────────────────────────────────────────────┐
// │ Test                                  │ Description                                       │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestSessions                          │ Sessions CRUD                                     │
// │  ├ empty at start                     │ GET /api/sessions returns []                      │
// │  ├ create and list                    │ POST /api/sessions then verify in list            │
// │  ├ delete                             │ DELETE /api/sessions/:id removes session           │
// │  └ delete nonexistent                 │ DELETE unknown id → 404                           │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestScrollback                        │ Scrollback trim, clear, broadcast-close           │
// │  ├ job scrollback capped to 1MB       │ oldest bytes dropped, newest preserved on replay  │
// │  ├ clear empties scrollback           │ sending {type:clear} leaves nothing for replay    │
// │  └ PTY exit closes all peers          │ every connected peer receives WS close 1000        │
// └───────────────────────────────────────┴───────────────────────────────────────────────────┘

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestSessions(t *testing.T) {
	srv := startServer(t)

	t.Run("empty at start", func(t *testing.T) {
		resp := srv.getJSON(t, "/api/sessions")
		sessions := resp["sessions"].([]any)
		assertEqual(t, len(sessions), 0)
	})

	t.Run("create and list", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{"app": "bash"})
		id, ok := resp["id"].(string)
		if !ok || id == "" {
			t.Fatalf("expected session id, got %v", resp)
		}
		assertContains(t, resp["url"].(string), "bash#"+id)

		list := srv.getJSON(t, "/api/sessions")
		sessions := list["sessions"].([]any)
		assertEqual(t, len(sessions), 1)

		s := sessions[0].(map[string]any)
		assertEqual(t, s["id"], id)
		assertEqual(t, s["app"], "bash")
	})

	t.Run("delete", func(t *testing.T) {
		list := srv.getJSON(t, "/api/sessions")
		sessions := list["sessions"].([]any)
		if len(sessions) == 0 {
			t.Skip("no sessions to delete")
		}
		id := sessions[0].(map[string]any)["id"].(string)

		code, resp := srv.deleteJSONRaw(t, fmt.Sprintf("/api/sessions/%s", id))
		assertEqual(t, code, http.StatusOK)
		assertField(t, resp, "ok", true)

		// Wait for process exit
		time.Sleep(500 * time.Millisecond)

		list = srv.getJSON(t, "/api/sessions")
		assertEqual(t, len(list["sessions"].([]any)), 0)
	})

	t.Run("delete nonexistent", func(t *testing.T) {
		code, _ := srv.deleteJSONRaw(t, "/api/sessions/nonexistent")
		assertEqual(t, code, http.StatusNotFound)
	})
}

func TestScrollback(t *testing.T) {
	srv := startServer(t)

	t.Run("job scrollback capped to 1MB with newest preserved", func(t *testing.T) {
		// Emit >1MB between two markers, then sleep so the session stays in
		// the sessions map while we inspect /api/sessions and reconnect.
		// MAX_SCROLLBACK_JOB is 1MB, so the START marker (plus most of the
		// padding) must be trimmed; the END marker must survive.
		cmd := `printf 'START_SCROLLBACK_MARKER\n'; head -c 1200000 /dev/zero | tr '\0' 'x'; printf '\nEND_SCROLLBACK_MARKER\n'; sleep 30`
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": cmd,
		})
		id := resp["id"].(string)
		t.Cleanup(func() { srv.deleteJSONRaw(t, fmt.Sprintf("/api/sessions/%s", id)) })

		// Wait for the job to finish emitting.
		time.Sleep(1 * time.Second)

		// scrollbackSize reported by /api/sessions must be capped.
		list := srv.getJSON(t, "/api/sessions")
		var size float64
		for _, s := range list["sessions"].([]any) {
			sess := s.(map[string]any)
			if sess["id"] == id {
				size, _ = sess["scrollbackSize"].(float64)
				break
			}
		}
		if size == 0 {
			t.Fatalf("scrollbackSize is 0, expected close to 1MB")
		}
		if size > 1024*1024 {
			t.Fatalf("scrollbackSize %v exceeds 1MB cap", size)
		}

		// WS replay must contain END marker but not START marker.
		ws := srv.connectTerminal(t, id)
		ws.readRole(t)

		accum := ""
		ws.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		for {
			_, data, err := ws.conn.ReadMessage()
			if err != nil {
				break
			}
			accum += string(data)
			if strings.Contains(accum, "END_SCROLLBACK_MARKER") {
				break
			}
		}
		if !strings.Contains(accum, "END_SCROLLBACK_MARKER") {
			t.Fatalf("replay missing END marker; newest content was lost (got %d bytes)", len(accum))
		}
		if strings.Contains(accum, "START_SCROLLBACK_MARKER") {
			t.Fatalf("replay contained START marker; oldest content was not trimmed")
		}
	})

	t.Run("clear empties scrollback for subsequent reconnects", func(t *testing.T) {
		// Use a job session — no bash profile/prompt noise to race with the
		// clear, and no writer echo. noBanner suppresses the "$ cd ... && cmd"
		// banner which would otherwise include the marker text (it's part of
		// the command itself) and race with the marker appearing in scrollback.
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":     "job",
			"command":  "printf 'BEFORE_CLEAR_MARKER\\n'; sleep 30",
			"noBanner": true,
		})
		id := resp["id"].(string)
		t.Cleanup(func() { srv.deleteJSONRaw(t, fmt.Sprintf("/api/sessions/%s", id)) })

		ws1 := srv.connectTerminal(t, id)
		ws1.readRole(t)
		if !ws1.readUntilAccum(t, "BEFORE_CLEAR_MARKER", 3*time.Second) {
			t.Fatal("did not see marker before clear")
		}

		ws1.sendJSON(t, map[string]any{"type": "clear"})
		time.Sleep(200 * time.Millisecond)
		ws1.conn.Close()

		// Reconnect — the replay must not contain the pre-clear marker.
		ws2 := srv.connectTerminal(t, id)
		ws2.readRole(t)

		accum := ""
		ws2.conn.SetReadDeadline(time.Now().Add(600 * time.Millisecond))
		for {
			_, data, err := ws2.conn.ReadMessage()
			if err != nil {
				break
			}
			accum += string(data)
		}
		if strings.Contains(accum, "BEFORE_CLEAR_MARKER") {
			t.Fatalf("scrollback not cleared; replay contained marker: %q", accum)
		}
	})

	t.Run("PTY exit broadcasts close to all peers", func(t *testing.T) {
		ws1 := srv.connectTerminal(t, "")
		ws1.readRole(t)
		id := ws1.id

		// ws2 connects as owner, becoming the active writer (ws1 is demoted
		// to viewer). Send `exit` via the current writer so it reaches bash.
		ws2 := srv.connectTerminal(t, id)
		ws2.readRole(t)

		ws2.sendBinary(t, []byte("exit\n"))

		// Both peers must receive a close; PTY exit sends WS_CLOSE.OK (1000).
		check := func(name string, ws *termConn) {
			ws.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			for {
				_, _, err := ws.conn.ReadMessage()
				if err == nil {
					continue
				}
				if websocket.IsCloseError(err, websocket.CloseNormalClosure) {
					return
				}
				// Network-level close (EOF / reset) is also acceptable — the
				// server closed the socket cleanly after sending the frame.
				if strings.Contains(err.Error(), "EOF") || strings.Contains(err.Error(), "reset") {
					return
				}
				t.Fatalf("%s: unexpected error: %v", name, err)
			}
		}
		check("ws1", ws1)
		check("ws2", ws2)
	})
}
