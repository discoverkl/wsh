package wsh_test

// ┌───────────────────────────────────────┬───────────────────────────────────────────────────┐
// │ Test                                  │ Description                                       │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestJobSessions                       │ Job session lifecycle                             │
// │  ├ create job via API                 │ POST with type=job creates a job session          │
// │  ├ job appears in session list        │ GET /api/sessions includes job with appType=job   │
// │  ├ job output via WebSocket           │ WS client receives stdout from job                │
// │  ├ job exit message                   │ WS client receives job-exit with exit code        │
// │  ├ logs endpoint                      │ GET /api/sessions/:id/logs returns output         │
// │  ├ input ignored                      │ binary input to job session is silently dropped   │
// │  ├ multiple viewers                   │ two WS clients both receive job output            │
// │  ├ nonzero exit code                  │ failing command reports correct exit code          │
// │  └ delete job                         │ DELETE /api/sessions/:id kills and removes job    │
// └───────────────────────────────────────┴───────────────────────────────────────────────────┘

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
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

	t.Run("job output via WebSocket", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "echo job-output-marker",
		})
		id := resp["id"].(string)

		ws := srv.connectTerminal(t, id)
		role := ws.readRole(t)
		assertEqual(t, role.AppType, "job")

		found := ws.readUntil(t, "job-output-marker", 5*time.Second)
		if !found {
			t.Fatal("did not receive job output")
		}
	})

	t.Run("job exit message", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "echo done",
		})
		id := resp["id"].(string)

		ws := srv.connectTerminal(t, id)
		ws.readRole(t)

		// Read messages until we get the job-exit message
		found := ws.readUntil(t, `"job-exit"`, 5*time.Second)
		if !found {
			t.Fatal("did not receive job-exit message")
		}
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

	t.Run("input ignored", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "sleep 2 && echo input-test-done",
		})
		id := resp["id"].(string)

		ws := srv.connectTerminal(t, id)
		ws.readRole(t)

		// Send binary input — should be silently ignored (no crash)
		ws.sendBinary(t, []byte("this should be ignored\n"))

		// Job should still complete normally
		found := ws.readUntil(t, "input-test-done", 5*time.Second)
		if !found {
			t.Fatal("job did not complete after sending input")
		}
	})

	t.Run("multiple viewers", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "for i in 1 2 3; do echo multi-$i; sleep 0.2; done",
		})
		id := resp["id"].(string)

		ws1 := srv.connectTerminal(t, id)
		ws1.readRole(t)

		ws2 := srv.connectTerminal(t, id)
		ws2.readRole(t)

		found1 := ws1.readUntil(t, "multi-3", 5*time.Second)
		found2 := ws2.readUntil(t, "multi-3", 5*time.Second)
		if !found1 {
			t.Fatal("viewer 1 did not receive output")
		}
		if !found2 {
			t.Fatal("viewer 2 did not receive output")
		}
	})

	t.Run("nonzero exit code", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "exit 42",
		})
		id := resp["id"].(string)

		ws := srv.connectTerminal(t, id)
		ws.readRole(t)

		// Read until we get the job-exit JSON
		ws.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		defer ws.conn.SetReadDeadline(time.Time{})
		for {
			_, data, err := ws.conn.ReadMessage()
			if err != nil {
				t.Fatal("did not receive job-exit message")
			}
			var msg map[string]any
			if err := json.Unmarshal(data, &msg); err != nil {
				continue
			}
			if msg["type"] == "job-exit" {
				// JSON numbers decode as float64
				code, ok := msg["code"].(float64)
				if !ok {
					t.Fatalf("exit code not a number: %v", msg["code"])
				}
				assertEqual(t, int(code), 42)
				return
			}
		}
	})

	t.Run("delete job kills process", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "sleep 60",
		})
		id := resp["id"].(string)

		// Connect a WS to observe the exit
		ws := srv.connectTerminal(t, id)
		ws.readRole(t)

		code, body := srv.deleteJSONRaw(t, fmt.Sprintf("/api/sessions/%s", id))
		assertEqual(t, code, http.StatusOK)
		assertField(t, body, "ok", true)

		// Should receive job-exit from the killed process
		found := ws.readUntil(t, `"job-exit"`, 5*time.Second)
		if !found {
			t.Fatal("did not receive job-exit after delete")
		}
	})
}
