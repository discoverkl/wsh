package wsh_test

// ┌───────────────────────────────────────┬───────────────────────────────────────────────────┐
// │ Test                                  │ Description                                       │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestApps                              │ Apps API                                          │
// │  └ list includes bash                 │ GET /api/apps contains bash entry                 │
// │ TestAppsTimeoutWarning                │ `timeout` is web-only and says so out loud        │
// │  └ warns on a pty app                 │ non-web app naming timeout gets a config warning  │
// │  └ silent on a web app                │ the one type that honors it draws no warning      │
// └───────────────────────────────────────┴───────────────────────────────────────────────────┘

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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

// `timeout` is honored for type:web only — a TUI session always uses SESSION_TTL
// so config can't pin a live terminal open for days. That's a deliberate limit,
// which makes it worth proving the server says so rather than dropping the field
// on the floor: silently ignoring it is what sent people to the manual to find
// out their `timeout: 8h` never did anything.
func TestAppsTimeoutWarning(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".wsh"), 0o755); err != nil {
		t.Fatalf("mkdir .wsh: %v", err)
	}
	cfg := "" +
		"slowtui:\n" +
		"  command: sleep 100\n" +
		"  timeout: 8h\n" +
		"slowweb:\n" +
		"  command: sleep 100\n" +
		"  type: web\n" +
		"  timeout: 8h\n"
	if err := os.WriteFile(filepath.Join(home, ".wsh", "apps.yaml"), []byte(cfg), 0o644); err != nil {
		t.Fatalf("write apps.yaml: %v", err)
	}

	srv := startServer(t)
	resp := srv.getJSON(t, "/api/apps")

	var warnings []string
	for _, w := range resp["warnings"].([]any) {
		warnings = append(warnings, w.(string))
	}

	t.Run("warns on a pty app", func(t *testing.T) {
		var hit string
		for _, w := range warnings {
			if strings.Contains(w, `"slowtui"`) {
				hit = w
			}
		}
		if hit == "" {
			t.Fatalf("no warning for slowtui; got %v", warnings)
		}
		// The value is echoed back so the warning points at the offending line.
		if !strings.Contains(hit, "8h") {
			t.Errorf("warning should quote the configured value, got %q", hit)
		}
		if !strings.Contains(hit, "pin") {
			t.Errorf("warning should name pinning as the way out, got %q", hit)
		}
	})

	t.Run("silent on a web app", func(t *testing.T) {
		for _, w := range warnings {
			if strings.Contains(w, `"slowweb"`) {
				t.Errorf("web apps honor timeout — should not be warned about: %q", w)
			}
		}
	})
}
