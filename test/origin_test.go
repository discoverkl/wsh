package wsh_test

// ┌───────────────────────────────────────┬───────────────────────────────────────────────────┐
// │ Test                                  │ Description                                       │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestOrigin                            │ Client origin / server base exchange              │
// │  ├ role message includes base         │ role msg has base field matching server config     │
// │  ├ client origin used in session URL  │ after sending origin, POST /api/sessions uses it  │
// │  └ WSH_URL takes priority             │ explicit WSH_URL wins over client origin          │
// └───────────────────────────────────────┴───────────────────────────────────────────────────┘

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestOrigin(t *testing.T) {
	srv := startServer(t)

	t.Run("role message includes base", func(t *testing.T) {
		ws := srv.connectTerminal(t, "")
		role := ws.readRole(t)
		assertEqual(t, role.Base, srv.base)
	})

	t.Run("client origin used in session URL", func(t *testing.T) {
		ws := srv.connectTerminal(t, "")
		ws.readRole(t)

		// Send origin message like the browser client does
		ws.sendJSON(t, map[string]any{
			"type":   "origin",
			"origin": "https://myhost.example.com:8080",
		})

		// Give the server a moment to process
		time.Sleep(50 * time.Millisecond)

		// Create a new session via API — URL should use the client origin
		resp := srv.postJSON(t, "/api/sessions", map[string]any{"app": "bash"})
		url := resp["url"].(string)
		assertContains(t, url, "https://myhost.example.com:8080")
		assertContains(t, url, "bash#"+resp["id"].(string))
	})

	t.Run("WSH_URL takes priority over client origin", func(t *testing.T) {
		// Start a separate server with WSH_URL set
		port := freePort(t)
		root := projectRoot(t)
		entry := filepath.Join(root, "dist", "server.js")

		cmd := exec.Command("node", entry, "--no-open", "--no-tls", "--port", fmt.Sprintf("%d", port))
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "WSH_URL=https://configured.example.com")
		cmd.Stdout = os.Stderr
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			t.Fatalf("start server: %v", err)
		}
		t.Cleanup(func() {
			cmd.Process.Kill()
			cmd.Wait()
		})

		srv2 := &server{port: port, cmd: cmd, base: "/"}
		srv2.waitReady(t, 10*time.Second)

		// Connect and send a different origin
		ws := srv2.connectTerminal(t, "")
		ws.readRole(t)
		ws.sendJSON(t, map[string]any{
			"type":   "origin",
			"origin": "https://browser.example.com",
		})
		time.Sleep(50 * time.Millisecond)

		// Create session — should use WSH_URL, not client origin
		resp := srv2.postJSON(t, "/api/sessions", map[string]any{"app": "bash"})
		url := resp["url"].(string)
		assertContains(t, url, "https://configured.example.com")
	})
}
