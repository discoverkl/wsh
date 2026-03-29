package wsh_test

// ┌───────────────────────────────────────┬───────────────────────────────────────────────────┐
// │ Test                                  │ Description                                       │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestCLI                               │ CLI subcommands                                   │
// │  ├ version                            │ wsh version prints version                        │
// │  ├ rpc missing session                │ wsh rpc without target session → error            │
// │  ├ rpc async via CLI                  │ wsh rpc --async succeeds                          │
// │  ├ rpc sync eval via CLI              │ wsh rpc eval 42 → "42"                            │
// │  ├ ls                                 │ wsh ls runs without error                         │
// │  ├ ls --json                          │ wsh ls --json returns valid JSON with sessions    │
// │  ├ ls shows created session           │ wsh ls output includes a known session            │
// │  ├ new                                │ wsh new bash returns session URL                  │
// │  ├ new --id-only                      │ wsh new --id-only prints only session ID          │
// │  ├ new --type job --command           │ wsh new --type job --command creates a job        │
// │  ├ new --title                        │ wsh new --title sets session title                │
// │  ├ kill                               │ wsh kill removes an active session                │
// │  ├ kill nonexistent                   │ wsh kill unknown session → error                  │
// │  ├ logs                               │ wsh logs prints job output                        │
// │  └ apps                               │ wsh apps lists available apps                     │
// └───────────────────────────────────────┴───────────────────────────────────────────────────┘

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestCLI(t *testing.T) {
	srv := startServer(t)
	port := fmt.Sprintf("%d", srv.port)

	t.Run("version", func(t *testing.T) {
		out := runCLI(t, "version")
		assertContains(t, out, "v")
	})

	t.Run("rpc missing session", func(t *testing.T) {
		_, err := runCLIErr(nil, "rpc", "1")
		if err == nil {
			t.Fatal("expected error")
		}
		assertContains(t, err.Error(), "no target session")
	})

	t.Run("rpc async via CLI", func(t *testing.T) {
		out := runCLI(t, "rpc", "-p", port, "--async", "--broadcast", "console.log('hello')")
		_ = out
	})

	t.Run("rpc sync eval via CLI", func(t *testing.T) {
		browser := srv.connectRPCClient(t)
		browser.handleRPC(func(msg rpcMessage) *rpcResult {
			return evalJS(msg.Args[0])
		})

		out := runCLI(t, "rpc", "-p", port, "--timeout", "5000", "--broadcast", "42")
		assertEqual(t, out, "42\n")
	})

	t.Run("ls", func(t *testing.T) {
		out := runCLI(t, "ls", "-p", port)
		_ = out
	})

	t.Run("ls --json", func(t *testing.T) {
		out := runCLI(t, "ls", "-p", port, "--json")
		var data map[string]any
		if err := json.Unmarshal([]byte(out), &data); err != nil {
			t.Fatalf("ls --json did not return valid JSON: %v", err)
		}
		if _, ok := data["sessions"]; !ok {
			t.Fatal("ls --json missing 'sessions' key")
		}
	})

	t.Run("ls shows created session", func(t *testing.T) {
		// Create a session, then verify ls --json includes it.
		idOut := runCLI(t, "new", "-p", port, "--id-only", "bash")
		id := strings.TrimSpace(idOut)

		out := runCLI(t, "ls", "-p", port, "--json")
		var data struct {
			Sessions []struct {
				ID  string `json:"id"`
				App string `json:"app"`
			} `json:"sessions"`
		}
		if err := json.Unmarshal([]byte(out), &data); err != nil {
			t.Fatalf("ls --json parse: %v", err)
		}
		found := false
		for _, s := range data.Sessions {
			if s.ID == id {
				found = true
				assertEqual(t, s.App, "bash")
				break
			}
		}
		if !found {
			t.Fatalf("session %s not found in ls --json output", id)
		}
	})

	t.Run("new", func(t *testing.T) {
		out := runCLI(t, "new", "-p", port, "bash")
		assertContains(t, out, "bash#")
	})

	t.Run("new --id-only", func(t *testing.T) {
		out := runCLI(t, "new", "-p", port, "--id-only", "bash")
		id := strings.TrimSpace(out)
		if len(id) != 6 {
			t.Fatalf("expected 6-char session ID, got %q", id)
		}
	})

	t.Run("new --type job --command", func(t *testing.T) {
		out := runCLI(t, "new", "-p", port, "--id-only", "--type", "job", "--command", "echo cli-job-test")
		id := strings.TrimSpace(out)
		if len(id) != 6 {
			t.Fatalf("expected 6-char session ID, got %q", id)
		}

		// Verify it shows up as a job in the session list.
		lsOut := runCLI(t, "ls", "-p", port, "--json")
		var data struct {
			Sessions []struct {
				ID      string `json:"id"`
				AppType string `json:"appType"`
			} `json:"sessions"`
		}
		if err := json.Unmarshal([]byte(lsOut), &data); err != nil {
			t.Fatalf("ls --json parse: %v", err)
		}
		for _, s := range data.Sessions {
			if s.ID == id {
				assertEqual(t, s.AppType, "job")
				return
			}
		}
		// Job may have already completed and been removed; that's OK.
	})

	t.Run("new --title", func(t *testing.T) {
		// --title applies to job sessions (for PTY sessions, title comes from app config).
		out := runCLI(t, "new", "-p", port, "--id-only", "--title", "my-test-title", "--type", "job", "--command", "sleep 5")
		id := strings.TrimSpace(out)

		lsOut := runCLI(t, "ls", "-p", port, "--json")
		var data struct {
			Sessions []struct {
				ID    string `json:"id"`
				Title string `json:"title"`
			} `json:"sessions"`
		}
		if err := json.Unmarshal([]byte(lsOut), &data); err != nil {
			t.Fatalf("ls --json parse: %v", err)
		}
		for _, s := range data.Sessions {
			if s.ID == id {
				assertEqual(t, s.Title, "my-test-title")
				// cleanup
				runCLI(t, "kill", "-p", port, id)
				return
			}
		}
		t.Fatalf("session %s not found in ls output", id)
	})

	t.Run("kill", func(t *testing.T) {
		// Create a session, then kill it.
		idOut := runCLI(t, "new", "-p", port, "--id-only", "bash")
		id := strings.TrimSpace(idOut)

		out := runCLI(t, "kill", "-p", port, id)
		assertContains(t, out, "killed")
	})

	t.Run("kill nonexistent", func(t *testing.T) {
		_, err := runCLIErr(nil, "kill", "-p", port, "zzzzzz")
		if err == nil {
			t.Fatal("expected error for nonexistent session")
		}
		assertContains(t, err.Error(), "not found")
	})

	t.Run("logs", func(t *testing.T) {
		// Create a job, wait for it to finish, then read logs via CLI.
		resp := srv.postJSON(t, "/api/sessions", map[string]any{
			"type":    "job",
			"command": "echo cli-logs-marker",
		})
		id := resp["id"].(string)

		// Wait for job to produce output on disk.
		time.Sleep(1 * time.Second)

		out := runCLI(t, "logs", "-p", port, id)
		assertContains(t, out, "cli-logs-marker")
	})

	t.Run("apps", func(t *testing.T) {
		out := runCLI(t, "apps")
		// Should list at least the default "bash" app.
		assertContains(t, out, "bash")
	})
}
