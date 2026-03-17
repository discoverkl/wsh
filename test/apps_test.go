package wsh_test

// ┌───────────────────────────────────────┬───────────────────────────────────────────────────┐
// │ Test                                  │ Description                                       │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestApps                              │ Apps API                                          │
// │  └ list includes bash                 │ GET /api/apps contains bash entry                 │
// └───────────────────────────────────────┴───────────────────────────────────────────────────┘

import "testing"

func TestApps(t *testing.T) {
	srv := startServer(t)

	t.Run("list includes bash", func(t *testing.T) {
		resp := srv.getJSON(t, "/api/apps")
		apps, ok := resp["apps"].([]any)
		if !ok {
			t.Fatalf("expected apps array, got %v", resp)
		}
		found := false
		for _, a := range apps {
			app := a.(map[string]any)
			if app["key"] == "bash" {
				found = true
				assertEqual(t, app["type"], "pty")
			}
		}
		if !found {
			t.Fatal("bash app not found")
		}
	})
}
