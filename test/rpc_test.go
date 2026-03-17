package wsh_test

// ┌───────────────────────────────────────┬───────────────────────────────────────────────────┐
// │ Test                                  │ Description                                       │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestRPC                               │ RPC via HTTP                                      │
// │  ├ async broadcast                    │ fire-and-forget broadcast returns ok               │
// │  ├ sync timeout when no responder     │ sync RPC times out without a browser client        │
// │  └ missing action                     │ 400 when action field is omitted                   │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestRPCRoundTrip                      │ RPC round-trip: server ↔ mock browser             │
// │  ├ arithmetic                         │ eval "2+3" → "5"                                  │
// │  ├ string                             │ eval "hello" → "hello"                            │
// │  ├ null result                        │ eval "null" → no value                            │
// │  ├ undefined result                   │ eval "undefined" → no value                       │
// │  ├ syntax error                       │ eval "}{" → SyntaxError                           │
// │  └ throw                              │ eval throw → Error                                │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestRPCTimeout                        │ Timeout behavior                                  │
// │  ├ short timeout expires              │ 500ms timeout with 3s handler → timeout            │
// │  └ long timeout succeeds              │ 5s timeout with 2s handler → "late"               │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestRPCTargetSession                  │ Session-targeted RPC                              │
// │  ├ targeted session                   │ RPC routed to specific session                    │
// │  └ wrong session times out            │ RPC to nonexistent session times out              │
// └───────────────────────────────────────┴───────────────────────────────────────────────────┘

import (
	"net/http"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// RPC via HTTP
// ---------------------------------------------------------------------------

func TestRPC(t *testing.T) {
	srv := startServer(t)

	t.Run("async broadcast", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/rpc", map[string]any{
			"action": "log",
			"args":   []string{"hello"},
			"async":  true,
		})
		assertField(t, resp, "ok", true)
	})

	t.Run("sync timeout when no responder", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/rpc", map[string]any{
			"action":  "eval",
			"args":    []string{"1+1"},
			"timeout": 1000,
		})
		assertField(t, resp, "error", "timeout")
	})

	t.Run("missing action", func(t *testing.T) {
		code, _ := srv.postJSONRaw(t, "/api/rpc", map[string]any{})
		assertEqual(t, code, http.StatusBadRequest)
	})
}

// ---------------------------------------------------------------------------
// RPC round-trip: server ↔ mock browser
// ---------------------------------------------------------------------------

func TestRPCRoundTrip(t *testing.T) {
	srv := startServer(t)

	browser := srv.connectRPCClient(t)
	browser.handleRPC(func(msg rpcMessage) *rpcResult {
		if msg.Action == "eval" && len(msg.Args) > 0 {
			return evalJS(msg.Args[0])
		}
		return nil
	})

	tests := []struct {
		name    string
		code    string
		want    string
		wantErr string
	}{
		{name: "arithmetic", code: "2+3", want: "5"},
		{name: "string", code: `"hello"`, want: "hello"},
		{name: "null result", code: "null", want: ""},
		{name: "undefined result", code: "undefined", want: ""},
		{name: "syntax error", code: "}{", wantErr: "SyntaxError"},
		{name: "throw", code: `throw new Error("boom")`, wantErr: "boom"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resp := srv.postJSON(t, "/api/rpc", map[string]any{
				"action":  "eval",
				"args":    []string{tc.code},
				"timeout": 5000,
			})
			if tc.wantErr != "" {
				errStr, _ := resp["error"].(string)
				assertContains(t, errStr, tc.wantErr)
			} else if tc.want == "" {
				if v, ok := resp["value"]; ok && v != nil {
					t.Fatalf("expected no value, got %v", v)
				}
			} else {
				assertField(t, resp, "value", tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// RPC timeout behavior
// ---------------------------------------------------------------------------

func TestRPCTimeout(t *testing.T) {
	t.Run("short timeout expires", func(t *testing.T) {
		srv := startServer(t)
		browser := srv.connectRPCClient(t)
		browser.handleRPC(func(msg rpcMessage) *rpcResult {
			time.Sleep(3 * time.Second)
			return &rpcResult{Value: strPtr("late")}
		})

		resp := srv.postJSON(t, "/api/rpc", map[string]any{
			"action":  "eval",
			"args":    []string{"1"},
			"timeout": 500,
		})
		assertField(t, resp, "error", "timeout")
	})

	t.Run("long timeout succeeds", func(t *testing.T) {
		srv := startServer(t)
		browser := srv.connectRPCClient(t)
		browser.handleRPC(func(msg rpcMessage) *rpcResult {
			time.Sleep(2 * time.Second)
			return &rpcResult{Value: strPtr("late")}
		})

		resp := srv.postJSON(t, "/api/rpc", map[string]any{
			"action":  "eval",
			"args":    []string{"1"},
			"timeout": 5000,
		})
		assertField(t, resp, "value", "late")
	})
}

// ---------------------------------------------------------------------------
// Session-targeted RPC
// ---------------------------------------------------------------------------

func TestRPCTargetSession(t *testing.T) {
	srv := startServer(t)

	ws := srv.connectTerminal(t, "")
	role := ws.readRole(t)
	sessionID := role.sessionID

	ws.handleRPC(func(msg rpcMessage) *rpcResult {
		if msg.Action == "ping" {
			return &rpcResult{Value: strPtr("pong")}
		}
		return nil
	})

	t.Run("targeted session", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/rpc", map[string]any{
			"action":  "ping",
			"session": sessionID,
			"timeout": 3000,
		})
		assertField(t, resp, "value", "pong")
	})

	t.Run("wrong session times out", func(t *testing.T) {
		resp := srv.postJSON(t, "/api/rpc", map[string]any{
			"action":  "ping",
			"session": "nonexistent",
			"timeout": 1000,
		})
		assertField(t, resp, "error", "timeout")
	})
}
