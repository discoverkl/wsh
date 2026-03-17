package wsh_test

// ┌─────────────────────────────┬────────────────────────────────────────────────────────┐
// │ Helper                      │ Description                                            │
// ├─────────────────────────────┼────────────────────────────────────────────────────────┤
// │ server                      │ Server lifecycle                                       │
// │  ├ startServer              │ launch node server on free port, wait for ready         │
// │  ├ waitReady                │ poll GET /api/sessions until 200                        │
// │  ├ url                      │ build http://127.0.0.1:port/path                       │
// │  ├ getJSON                  │ GET path, decode JSON response                          │
// │  ├ postJSON                 │ POST path with JSON body, fail on 5xx                   │
// │  ├ postJSONRaw              │ POST path, return (status, body)                        │
// │  ├ deleteJSONRaw            │ DELETE path, return (status, body)                      │
// │  ├ connectTerminal          │ create session + WS, return termConn                    │
// │  └ connectRPCClient         │ WS to session=_rpc, return rpcClient                   │
// ├─────────────────────────────┼────────────────────────────────────────────────────────┤
// │ termConn                    │ WebSocket terminal client                              │
// │  ├ readRole                 │ read initial role message from server                   │
// │  ├ sendJSON                 │ write JSON text frame                                   │
// │  ├ sendBinary               │ write binary frame (PTY input)                          │
// │  ├ readUntil                │ read until substring found or timeout                   │
// │  └ handleRPC                │ goroutine: read RPCs, call handler, send results        │
// ├─────────────────────────────┼────────────────────────────────────────────────────────┤
// │ rpcClient                   │ RPC-only control client (wraps termConn)               │
// │  └ handleRPC                │ delegate to termConn.handleRPC                          │
// ├─────────────────────────────┼────────────────────────────────────────────────────────┤
// │ CLI                         │ Subprocess helpers                                     │
// │  ├ runCLI                   │ run wsh subcommand, fail on error                       │
// │  ├ runCLIWithEnv            │ run wsh with extra env vars, fail on error              │
// │  └ runCLIErr                │ run wsh, return (stdout, error)                         │
// ├─────────────────────────────┼────────────────────────────────────────────────────────┤
// │ Mock                        │ Test doubles                                           │
// │  └ evalJS                   │ simulate browser eval for known expressions             │
// ├─────────────────────────────┼────────────────────────────────────────────────────────┤
// │ Assertions                  │ Test assertions                                        │
// │  ├ assertField              │ assert JSON field equals expected value                 │
// │  ├ assertEqual              │ assert two values are equal                             │
// │  └ assertContains           │ assert string contains substring                        │
// ├─────────────────────────────┼────────────────────────────────────────────────────────┤
// │ Misc                        │ Utility functions                                      │
// │  ├ freePort                 │ find an available TCP port                              │
// │  ├ projectRoot              │ resolve absolute path to repo root                     │
// │  ├ mustProjectRoot          │ projectRoot without testing.T                           │
// │  ├ str                      │ nil-safe fmt.Sprintf("%v", v)                           │
// │  └ strPtr                   │ return pointer to string                                │
// └─────────────────────────────┴────────────────────────────────────────────────────────┘

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

type server struct {
	port int
	cmd  *exec.Cmd
}

// startServer launches `node dist/server.js` on a free port, waits for it to
// be ready, and registers cleanup to kill it when the test finishes.
func startServer(t *testing.T) *server {
	t.Helper()

	port := freePort(t)
	root := projectRoot(t)
	entry := filepath.Join(root, "dist", "server.js")

	if _, err := os.Stat(entry); err != nil {
		t.Fatalf("dist/server.js not found — run `npm run build` first")
	}

	cmd := exec.Command("node", entry, "--no-open", "--no-tls", "--port", fmt.Sprintf("%d", port))
	cmd.Dir = root
	cmd.Stdout = os.Stderr // forward server logs for debugging
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}

	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})

	srv := &server{port: port, cmd: cmd}
	srv.waitReady(t, 10*time.Second)
	return srv
}

func (s *server) waitReady(t *testing.T, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	url := fmt.Sprintf("http://127.0.0.1:%d/api/sessions", s.port)
	for time.Now().Before(deadline) {
		resp, err := http.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("server not ready after %v", timeout)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

func (s *server) url(path string) string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", s.port, path)
}

func (s *server) getJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	resp, err := http.Get(s.url(path))
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

func (s *server) postJSON(t *testing.T, path string, body map[string]any) map[string]any {
	t.Helper()
	code, resp := s.postJSONRaw(t, path, body)
	if code >= 500 {
		t.Fatalf("POST %s: status %d body=%v", path, code, resp)
	}
	return resp
}

func (s *server) postJSONRaw(t *testing.T, path string, body map[string]any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(s.url(path), "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (s *server) deleteJSONRaw(t *testing.T, path string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodDelete, s.url(path), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("DELETE %s: %v", path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// ---------------------------------------------------------------------------
// WebSocket: terminal connection
// ---------------------------------------------------------------------------

type termConn struct {
	conn *websocket.Conn
	mu   sync.Mutex
	id   string // session ID, resolved after connect
}

type roleMessage struct {
	sessionID  string
	Role       string
	Credential string
	App        string
	AppType    string
}

// connectTerminal creates a session (if sessionID is empty) and connects a
// WebSocket to it. The session ID is available via tc.id after this call.
func (s *server) connectTerminal(t *testing.T, sessionID string) *termConn {
	t.Helper()

	if sessionID == "" {
		resp := s.postJSON(t, "/api/sessions", map[string]any{"app": "bash"})
		id, ok := resp["id"].(string)
		if !ok || id == "" {
			t.Fatalf("failed to create session: %v", resp)
		}
		sessionID = id
	}

	url := fmt.Sprintf("ws://127.0.0.1:%d/terminal?session=%s", s.port, sessionID)
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("ws connect: %v", err)
	}
	tc := &termConn{conn: conn, id: sessionID}
	t.Cleanup(func() { conn.Close() })
	return tc
}

// readRole reads the initial role message from the server.
func (tc *termConn) readRole(t *testing.T) roleMessage {
	t.Helper()
	tc.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, data, err := tc.conn.ReadMessage()
		if err != nil {
			t.Fatalf("read role: %v", err)
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			continue // binary PTY data
		}
		if msg["type"] == "role" {
			tc.conn.SetReadDeadline(time.Time{})
			return roleMessage{
				sessionID:  tc.id,
				Role:       str(msg["role"]),
				Credential: str(msg["credential"]),
				App:        str(msg["app"]),
				AppType:    str(msg["appType"]),
			}
		}
	}
}

func (tc *termConn) sendJSON(t *testing.T, v any) {
	t.Helper()
	tc.mu.Lock()
	defer tc.mu.Unlock()
	if err := tc.conn.WriteJSON(v); err != nil {
		t.Fatalf("ws send json: %v", err)
	}
}

func (tc *termConn) sendBinary(t *testing.T, data []byte) {
	t.Helper()
	tc.mu.Lock()
	defer tc.mu.Unlock()
	if err := tc.conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
		t.Fatalf("ws send binary: %v", err)
	}
}

// readUntil reads messages until the given substring appears in text data.
func (tc *termConn) readUntil(t *testing.T, substr string, timeout time.Duration) bool {
	t.Helper()
	tc.conn.SetReadDeadline(time.Now().Add(timeout))
	defer tc.conn.SetReadDeadline(time.Time{})
	for {
		_, data, err := tc.conn.ReadMessage()
		if err != nil {
			return false
		}
		if strings.Contains(string(data), substr) {
			return true
		}
	}
}

// handleRPC starts a goroutine that reads messages and responds to RPC requests.
func (tc *termConn) handleRPC(handler func(rpcMessage) *rpcResult) {
	go func() {
		for {
			_, data, err := tc.conn.ReadMessage()
			if err != nil {
				return
			}
			var msg rpcMessage
			if err := json.Unmarshal(data, &msg); err != nil {
				continue
			}
			if msg.Type != "rpc" || msg.ID == "" {
				continue
			}
			result := handler(msg)
			if result == nil {
				result = &rpcResult{}
			}
			resp := map[string]any{
				"type": "rpc-result",
				"id":   msg.ID,
			}
			if result.Value != nil {
				resp["value"] = *result.Value
			}
			if result.Error != nil {
				resp["error"] = *result.Error
			}
			tc.mu.Lock()
			tc.conn.WriteJSON(resp)
			tc.mu.Unlock()
		}
	}()
}

// ---------------------------------------------------------------------------
// WebSocket: RPC-only control client
// ---------------------------------------------------------------------------

type rpcClient struct {
	tc *termConn
}

type rpcMessage struct {
	Type   string   `json:"type"`
	ID     string   `json:"id"`
	Action string   `json:"action"`
	Args   []string `json:"args"`
}

type rpcResult struct {
	Value *string
	Error *string
}

func (s *server) connectRPCClient(t *testing.T) *rpcClient {
	t.Helper()
	url := fmt.Sprintf("ws://127.0.0.1:%d/terminal?session=_rpc", s.port)
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("ws connect _rpc: %v", err)
	}
	tc := &termConn{conn: conn}
	t.Cleanup(func() { conn.Close() })
	return &rpcClient{tc: tc}
}

func (c *rpcClient) handleRPC(handler func(rpcMessage) *rpcResult) {
	c.tc.handleRPC(handler)
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

func runCLI(t *testing.T, args ...string) string {
	t.Helper()
	out, err := runCLIErr(nil, args...)
	if err != nil {
		t.Fatalf("wsh %s: %v", strings.Join(args, " "), err)
	}
	return out
}

func runCLIWithEnv(t *testing.T, env map[string]string, args ...string) string {
	t.Helper()
	out, err := runCLIErr(env, args...)
	if err != nil {
		t.Fatalf("wsh %s: %v", strings.Join(args, " "), err)
	}
	return out
}

func runCLIErr(env map[string]string, args ...string) (string, error) {
	root := mustProjectRoot()
	entry := filepath.Join(root, "dist", "server.js")
	cmd := exec.Command("node", append([]string{entry}, args...)...)
	cmd.Dir = root
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%v: %s%s", err, stderr.String(), stdout.String())
	}
	return stdout.String(), nil
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

// evalJS simulates browser-side eval for the mock client.
func evalJS(code string) *rpcResult {
	switch code {
	case "2+3":
		return &rpcResult{Value: strPtr("5")}
	case "42":
		return &rpcResult{Value: strPtr("42")}
	case `"hello"`:
		return &rpcResult{Value: strPtr("hello")}
	case "null", "undefined":
		return &rpcResult{}
	case "}{":
		return &rpcResult{Error: strPtr("SyntaxError: Unexpected token }")}
	case `throw new Error("boom")`:
		return &rpcResult{Error: strPtr("Error: boom")}
	case "1":
		return &rpcResult{Value: strPtr("1")}
	default:
		return &rpcResult{Error: strPtr(fmt.Sprintf("unknown test expression: %s", code))}
	}
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

func assertField(t *testing.T, m map[string]any, key string, want any) {
	t.Helper()
	got := m[key]
	switch w := want.(type) {
	case int:
		want = float64(w)
	case bool:
		_ = w
	}
	if fmt.Sprintf("%v", got) != fmt.Sprintf("%v", want) {
		raw, _ := json.Marshal(m)
		t.Fatalf("%s: got %v, want %v (full: %s)", key, got, want, raw)
	}
}

func assertEqual(t *testing.T, got, want any) {
	t.Helper()
	if fmt.Sprintf("%v", got) != fmt.Sprintf("%v", want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func assertContains(t *testing.T, s, substr string) {
	t.Helper()
	if !strings.Contains(s, substr) {
		t.Fatalf("string %q does not contain %q", s, substr)
	}
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("find free port: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

func projectRoot(t *testing.T) string {
	t.Helper()
	r, err := filepath.Abs(filepath.Join(".."))
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func mustProjectRoot() string {
	r, _ := filepath.Abs(filepath.Join(".."))
	return r
}

func str(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprintf("%v", v)
}

func strPtr(s string) *string { return &s }
