package wsh_test

// ┌───────────────────────────────────────┬───────────────────────────────────────────────────┐
// │ Test                                  │ Description                                       │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestJobSessions                       │ Job session lifecycle (HTTP/SSE only — no WS)     │
// │  ├ create job via API                 │ POST with type=job creates a job session          │
// │  ├ job appears in session list        │ GET /api/sessions includes job with appType=job   │
// │  ├ job output via SSE                 │ SSE stream emits stdout from job                  │
// │  ├ job exit via SSE                   │ SSE emits exit code event                         │
// │  ├ logs endpoint                      │ GET /api/sessions/:id/logs returns output         │
// │  ├ WebSocket rejected                 │ /terminal close 4003 for job sessions             │
// │  ├ multiple SSE viewers               │ two SSE clients both receive job output           │
// │  ├ nonzero exit code                  │ failing command reports correct exit code         │
// │  └ delete job                         │ DELETE /api/sessions/:id kills and removes job    │
// └───────────────────────────────────────┴───────────────────────────────────────────────────┘

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestJobSessions(t *testing.T) {
	srv := startServer(t)

	t.Run("create job via API", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "echo hello-job",
		})
		id, ok := resp["id"].(string)
		if !ok || id == "" {
			t.Fatalf("expected session id, got %v", resp)
		}
		url, _ := resp["url"].(string)
		if url == "" {
			t.Fatalf("expected url in response, got %v", resp)
		}
	})

	t.Run("job appears in session list", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "sleep 5",
			"title":   "test-list-job",
		})
		id := resp["id"].(string)

		list := srv.getJSON(t, "/api/sessions")
		sessions := list["sessions"].([]any)
		found := false
		for _, s := range sessions {
			sess := s.(map[string]any)
			if sess["id"] == id {
				assertEqual(t, sess["appType"], "job")
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("job session %s not found in session list", id)
		}

		// cleanup
		srv.deleteJSONRaw(t, fmt.Sprintf("/api/sessions/%s", id))
	})

	t.Run("job output via SSE", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "echo job-output-marker",
		})
		id := resp["id"].(string)

		sc := srv.streamSession(t, id)
		if !sc.readUntil(t, "job-output-marker", 5*time.Second) {
			t.Fatalf("did not receive job output; accum=%q", sc.accum)
		}
	})

	t.Run("job exit via SSE", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "echo done",
		})
		id := resp["id"].(string)

		sc := srv.streamSession(t, id)
		code, ok := sc.waitExit(t, 5*time.Second)
		if !ok {
			t.Fatal("did not receive job exit event")
		}
		assertEqual(t, code, 0)
	})

	t.Run("logs endpoint", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "echo logs-endpoint-test",
		})
		id := resp["id"].(string)

		// Wait for command to finish
		time.Sleep(1 * time.Second)

		httpResp, err := http.Get(srv.url(fmt.Sprintf("/api/sessions/%s/logs", id)))
		if err != nil {
			t.Fatalf("GET logs: %v", err)
		}
		defer httpResp.Body.Close()
		assertEqual(t, httpResp.StatusCode, 200)

		body, _ := io.ReadAll(httpResp.Body)
		if !strings.Contains(string(body), "logs-endpoint-test") {
			t.Fatalf("logs did not contain expected output, got: %q", string(body))
		}
	})

	t.Run("WebSocket rejected", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "sleep 5",
		})
		id := resp["id"].(string)
		defer srv.deleteJSONRaw(t, fmt.Sprintf("/api/sessions/%s", id))

		url := fmt.Sprintf("ws://127.0.0.1:%d%sterminal?session=%s", srv.port, srv.base, id)
		conn, _, err := websocket.DefaultDialer.Dial(url, nil)
		if err != nil {
			// Some WS dialers fail on a 4003 close before handshake. Either is fine.
			return
		}
		defer conn.Close()
		conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, _, readErr := conn.ReadMessage()
		if readErr == nil {
			t.Fatal("expected WS connection to be rejected for job session")
		}
		ce, ok := readErr.(*websocket.CloseError)
		if !ok {
			// Connection drop without a clean close is also acceptable.
			return
		}
		if ce.Code != 4003 {
			t.Fatalf("expected close code 4003, got %d (%s)", ce.Code, ce.Text)
		}
	})

	t.Run("multiple SSE viewers", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "for i in 1 2 3; do echo multi-$i; sleep 0.2; done",
		})
		id := resp["id"].(string)

		sc1 := srv.streamSession(t, id)
		sc2 := srv.streamSession(t, id)

		if !sc1.readUntil(t, "multi-3", 5*time.Second) {
			t.Fatalf("viewer 1 did not receive output; accum=%q", sc1.accum)
		}
		if !sc2.readUntil(t, "multi-3", 5*time.Second) {
			t.Fatalf("viewer 2 did not receive output; accum=%q", sc2.accum)
		}
	})

	t.Run("nonzero exit code", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "exit 42",
		})
		id := resp["id"].(string)

		sc := srv.streamSession(t, id)
		code, ok := sc.waitExit(t, 5*time.Second)
		if !ok {
			t.Fatal("did not receive job exit event")
		}
		assertEqual(t, code, 42)
	})

	t.Run("delete job kills process", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "sleep 60",
		})
		id := resp["id"].(string)

		sc := srv.streamSession(t, id)

		code, body := srv.deleteJSONRaw(t, fmt.Sprintf("/api/sessions/%s", id))
		assertEqual(t, code, http.StatusOK)
		assertField(t, body, "ok", true)

		if _, ok := sc.waitExit(t, 5*time.Second); !ok {
			t.Fatal("did not receive exit event after delete")
		}
	})
}
