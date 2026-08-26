package wsh_test

// ┌────────────────────────────────────────┬──────────────────────────────────────────────────────┐
// │ Test                                   │ Description                                          │
// ├────────────────────────────────────────┼──────────────────────────────────────────────────────┤
// │ TestWebScrollbackIsOwnerOnly           │ a web app's server log is not part of `access: public`│
// │  ├ owner still gets the scrollback     │ replay: "full", and the launch banner arrives        │
// │  └ a forwarded stranger gets none      │ replay: "none", and not one byte follows             │
// └────────────────────────────────────────┴──────────────────────────────────────────────────────┘
//
// Reuses the trust-proxy box from access_live_test.go: the server binds 0.0.0.0
// and is called on a routable address, because loopback is always owner and the
// difference under test would be invisible from there.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// attach opens a session's control WebSocket the way the gateway would — with
// the proxy secret always, and the Allowed verdict only for an owner.
func (b *accessBox) attach(t *testing.T, sid string, owner bool) *websocket.Conn {
	t.Helper()
	hdr := http.Header{}
	hdr.Set("X-WSH-Proxy-Secret", liveAccessSecret)
	if owner {
		hdr.Set("X-Abox-Allowed", "1")
	}
	url := fmt.Sprintf("ws://%s:%d/terminal?session=%s&app=demo", b.ip, b.port, sid)
	conn, _, err := websocket.DefaultDialer.Dial(url, hdr)
	if err != nil {
		t.Fatalf("ws connect (owner=%v): %v", owner, err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// readAttach returns the replay mode the role message announced and every byte
// of process output that actually followed it. Reading ends on the deadline:
// "nothing more is coming" is the assertion, so it has to be waited out.
func readAttach(t *testing.T, c *websocket.Conn) (replay string, output string) {
	t.Helper()
	var out strings.Builder
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		typ, data, err := c.ReadMessage()
		if err != nil {
			return replay, out.String()
		}
		if typ == websocket.BinaryMessage {
			out.Write(data)
			continue
		}
		var msg map[string]any
		if json.Unmarshal(data, &msg) == nil && msg["type"] == "role" {
			replay = str(msg["replay"])
			// Whatever follows a role message follows it immediately.
			c.SetReadDeadline(time.Now().Add(1500 * time.Millisecond))
		}
	}
}

func TestWebScrollbackIsOwnerOnly(t *testing.T) {
	box := startAccessBox(t)
	// Public: anyone the gateway forwards may open the app. The question is
	// whether that also handed them the process behind it.
	box.writeApp(t, "public", "Demo")
	sid := box.bootApp(t)

	t.Run("owner still gets the scrollback", func(t *testing.T) {
		replay, output := readAttach(t, box.attach(t, sid, true))
		if replay != "full" {
			t.Errorf("replay = %q, want %q", replay, "full")
		}
		// The launch banner wsh writes at spawn: `$ cd <cwd> && <command>`.
		if !strings.Contains(output, "app.js") {
			t.Errorf("owner did not receive the launch banner; got %q", output)
		}
	})

	t.Run("a forwarded stranger gets none", func(t *testing.T) {
		replay, output := readAttach(t, box.attach(t, sid, false))
		if replay != "none" {
			t.Errorf("replay = %q, want %q", replay, "none")
		}
		if output != "" {
			t.Errorf("stranger received %d bytes of the app's server log: %q", len(output), output)
		}
	})
}
