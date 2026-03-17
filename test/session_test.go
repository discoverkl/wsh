package wsh_test

// ┌───────────────────────────────────────┬───────────────────────────────────────────────────┐
// │ Test                                  │ Description                                       │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestSessions                          │ Sessions CRUD                                     │
// │  ├ empty at start                     │ GET /api/sessions returns []                      │
// │  ├ create and list                    │ POST /api/sessions then verify in list            │
// │  ├ delete                             │ DELETE /api/sessions/:id removes session           │
// │  └ delete nonexistent                 │ DELETE unknown id → 404                           │
// └───────────────────────────────────────┴───────────────────────────────────────────────────┘

import (
	"fmt"
	"net/http"
	"testing"
	"time"
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
		// API returns relative path, not full URL
		assertContains(t, resp["path"].(string), "bash#"+id)

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
