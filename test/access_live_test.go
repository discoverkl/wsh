package wsh_test

// ┌────────────────────────────────────────┬──────────────────────────────────────────────────────┐
// │ Test                                   │ Description                                          │
// ├────────────────────────────────────────┼──────────────────────────────────────────────────────┤
// │ TestLiveAccess                         │ an access change reaches an app that is already up   │
// │  ├ private app refuses a stranger      │ baseline — the app boots private                     │
// │  ├ grant reaches a running app         │ private→public, no restart, /_a/<app> opens          │
// │  ├ grant reaches the session route     │ …and /_p/<id> opens with it                          │
// │  ├ revoke reaches a running app        │ public→private, no restart, /_a/<app> closes         │
// │  ├ revoke reaches the session route    │ …and /_p/<id> closes, which the app route never did  │
// │  ├ owner is unaffected                 │ an allowed caller gets in under either setting       │
// │  └ catalog follows a same-size edit    │ guards the stat stamp: mtime moves, byte count doesn't│
// └────────────────────────────────────────┴──────────────────────────────────────────────────────┘
//
// Every check here needs a caller the server does not treat as loopback: both
// auth paths wave loopback through, so a request from 127.0.0.1 can never
// observe the access decision at all. The test therefore binds the server to
// 0.0.0.0 and calls it on a routable local address, and skips when the machine
// has none.

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

const liveAccessSecret = "live-access-test-proxy-secret"

// routableIP is a local IPv4 the server will not read as loopback.
func routableIP(t *testing.T) string {
	t.Helper()
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		t.Skipf("cannot enumerate interfaces: %v", err)
	}
	for _, a := range addrs {
		n, ok := a.(*net.IPNet)
		if !ok || n.IP.IsLoopback() || n.IP.To4() == nil {
			continue
		}
		return n.IP.String()
	}
	t.Skip("no non-loopback IPv4 address — the access decision is unobservable from loopback")
	return ""
}

type accessBox struct {
	ip   string
	port int
	cfg  string // path to the apps.json under test
}

// writeApp rewrites the catalog with `demo` set to the given access, exactly as
// an operator editing apps.json would. Returns once the bytes are on disk.
func (b *accessBox) writeApp(t *testing.T, access, title string) {
	t.Helper()
	home := filepath.Dir(filepath.Dir(b.cfg))
	cfg := map[string]any{
		"demo": map[string]any{
			"command": "node " + filepath.Join(home, "app.js"),
			"type":    "web",
			"title":   title,
			"access":  access,
		},
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal apps.json: %v", err)
	}
	if err := os.WriteFile(b.cfg, raw, 0o644); err != nil {
		t.Fatalf("write apps.json: %v", err)
	}
}

// get calls the box as the gateway would. owner=true carries the Allowed
// verdict; owner=false is a forwarded stranger, who may reach public apps only.
func (b *accessBox) get(t *testing.T, path string, owner bool) int {
	t.Helper()
	code, err := b.try(path, owner)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	return code
}

// try is get without the failure — for the startup loops, which expect to be
// refused until the port is listening.
func (b *accessBox) try(path string, owner bool) (int, error) {
	req, err := http.NewRequest("GET", fmt.Sprintf("http://%s:%d%s", b.ip, b.port, path), nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("X-WSH-Proxy-Secret", liveAccessSecret)
	if owner {
		req.Header.Set("X-Abox-Allowed", "1")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

func (b *accessBox) getJSONAs(t *testing.T, path string) map[string]any {
	t.Helper()
	req, _ := http.NewRequest("GET", fmt.Sprintf("http://%s:%d%s", b.ip, b.port, path), nil)
	req.Header.Set("X-WSH-Proxy-Secret", liveAccessSecret)
	req.Header.Set("X-Abox-Allowed", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return out
}

// startAccessBox brings up a server in trust-proxy mode over a throwaway HOME,
// holding one web app that starts out private.
func startAccessBox(t *testing.T) *accessBox {
	t.Helper()
	ip := routableIP(t)
	port := freePort(t)
	root := projectRoot(t)
	entry := filepath.Join(root, "dist", "server.js")
	if _, err := os.Stat(entry); err != nil {
		t.Fatalf("dist/server.js not found — run `npm run build` first")
	}

	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".wsh"), 0o755); err != nil {
		t.Fatalf("mkdir .wsh: %v", err)
	}
	// A web app with no dependencies beyond the node already running the server.
	app := "require('http').createServer((_q, s) => s.end('ok')).listen(process.env.WSH_PORT, '127.0.0.1');\n"
	if err := os.WriteFile(filepath.Join(home, "app.js"), []byte(app), 0o644); err != nil {
		t.Fatalf("write app.js: %v", err)
	}

	box := &accessBox{ip: ip, port: port, cfg: filepath.Join(home, ".wsh", "apps.json")}
	box.writeApp(t, "private", "Demo")

	cmd := exec.Command("node", entry, "--no-open", "--no-tls", "--trust-proxy",
		"--port", fmt.Sprintf("%d", port), "--bind", "0.0.0.0")
	cmd.Dir = root
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	// ABOX_NAME would move the base path; this test addresses the root base.
	cmd.Env = append(os.Environ(),
		"HOME="+home,
		"WSH_PROXY_SECRET="+liveAccessSecret,
		"ABOX_NAME=",
		"ABOX_USER=",
	)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if code, err := box.try("/api/sessions", true); err == nil && code == 200 {
			return box
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("server not ready")
	return nil
}

// bootApp opens the app as the owner and waits out the "Starting up…" 503, so
// the session under test is a fully running one.
func (b *accessBox) bootApp(t *testing.T) string {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if code, err := b.try("/_a/demo/", true); err == nil && code == 200 {
			sessions, _ := b.getJSONAs(t, "/api/sessions")["sessions"].([]any)
			for _, s := range sessions {
				row, _ := s.(map[string]any)
				if row["app"] == "demo" {
					return row["id"].(string)
				}
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("app never came up")
	return ""
}

// kill ends a session, so the next boot takes its snapshot from whatever the
// catalog says at that moment.
func (b *accessBox) kill(t *testing.T, sid string) {
	t.Helper()
	req, _ := http.NewRequest("DELETE", fmt.Sprintf("http://%s:%d/api/sessions/%s", b.ip, b.port, sid), nil)
	req.Header.Set("X-WSH-Proxy-Secret", liveAccessSecret)
	req.Header.Set("X-Abox-Allowed", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("DELETE session %s: %v", sid, err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	// The session is gone from the map before the child dies; give the port a
	// moment so the next boot doesn't adopt the corpse.
	time.Sleep(300 * time.Millisecond)
}

func TestLiveAccess(t *testing.T) {
	box := startAccessBox(t)
	// Boots private, and stays up for every subtest below — the whole point is
	// that nothing here restarts it.
	sid := box.bootApp(t)

	t.Run("private app refuses a stranger", func(t *testing.T) {
		if got := box.get(t, "/_a/demo/", false); got != 401 {
			t.Errorf("/_a/demo/ as stranger = %d, want 401", got)
		}
	})

	t.Run("grant reaches a running app", func(t *testing.T) {
		box.writeApp(t, "public", "Demo")
		if got := box.get(t, "/_a/demo/", false); got != 200 {
			t.Errorf("/_a/demo/ as stranger after grant = %d, want 200 "+
				"(401 means the session is still serving the access it booted with)", got)
		}
	})

	t.Run("grant reaches the session route", func(t *testing.T) {
		if got := box.get(t, "/_p/"+sid+"/", false); got != 200 {
			t.Errorf("/_p/%s/ as stranger after grant = %d, want 200", sid, got)
		}
	})

	// Everything above ran against a session that booted private. Revocation has
	// to be asked of one that booted public — otherwise a stale snapshot refuses
	// the stranger for the wrong reason and the test passes on broken code.
	box.kill(t, sid)
	sid = box.bootApp(t)

	t.Run("revoke reaches a running app", func(t *testing.T) {
		box.writeApp(t, "private", "Demo")
		if got := box.get(t, "/_a/demo/", false); got != 401 {
			t.Errorf("/_a/demo/ as stranger after revoke = %d, want 401", got)
		}
	})

	t.Run("revoke reaches the session route", func(t *testing.T) {
		// The route the app-level check never covered: it resolves a session
		// directly, so a snapshot here kept a withdrawn app open to strangers.
		if got := box.get(t, "/_p/"+sid+"/", false); got != 401 {
			t.Errorf("/_p/%s/ as stranger after revoke = %d, want 401", sid, got)
		}
	})

	t.Run("owner is unaffected", func(t *testing.T) {
		if got := box.get(t, "/_a/demo/", true); got != 200 {
			t.Errorf("/_a/demo/ as owner = %d, want 200", got)
		}
		box.writeApp(t, "public", "Demo")
		if got := box.get(t, "/_a/demo/", true); got != 200 {
			t.Errorf("/_a/demo/ as owner (public) = %d, want 200", got)
		}
	})

	t.Run("catalog follows a same-size edit", func(t *testing.T) {
		// The catalog is memoized on a stat stamp. A retitle of equal length
		// moves mtime and nothing else, which is the case a size-only stamp
		// would miss — and missing it is how an access change goes stale.
		box.writeApp(t, "public", "AAAA")
		if got := appTitle(t, box); got != "AAAA" {
			t.Fatalf("title = %q, want AAAA", got)
		}
		box.writeApp(t, "public", "BBBB")
		if got := appTitle(t, box); got != "BBBB" {
			t.Errorf("title after same-size edit = %q, want BBBB", got)
		}
	})
}

func appTitle(t *testing.T, box *accessBox) string {
	t.Helper()
	apps, _ := box.getJSONAs(t, "/api/apps")["apps"].([]any)
	for _, a := range apps {
		row, _ := a.(map[string]any)
		if row["key"] == "demo" {
			return fmt.Sprint(row["title"])
		}
	}
	t.Fatalf("demo missing from catalog")
	return ""
}
