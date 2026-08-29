package wsh_test

// ┌────────────────────────────────────────┬──────────────────────────────────────────────────┐
// │ Test                                   │ Description                                      │
// ├────────────────────────────────────────┼──────────────────────────────────────────────────┤
// │ TestJobStreamRawIsByteExact            │ all 256 byte values survive the stream           │
// │ TestJobStreamFramesCannotCarryBytes    │ the frame's loss, pinned so it stays a choice    │
// │ TestWildcardAcceptStillGetsFrames      │ a browser must not fall into the raw path        │
// │ TestRawStreamCarriesNoFrameBytes       │ nothing but the child's output is in the body    │
// └────────────────────────────────────────┴──────────────────────────────────────────────────┘
//
// `GET <sid>/stream` answers with SSE frames — `data: {"text": "..."}` — and a
// JSON string carries text, not bytes. Piping a binary through it corrupted it:
// a 15 MB executable came back at 23 MB, every byte above 0x7f replaced with
// U+FFFD. `Accept: application/octet-stream` asks for the log bytes instead,
// with no envelope, no decode and no escape-stripping.
//
// The exit code is not in the envelope on either path — clients read it from
// `GET <sid>/exit` — so raw loses nothing by having no frames to put it in.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// allByteValues is the payload that separates the two paths: 0x00-0x7f is
// unchanged by a UTF-8 round trip and everything above it is not.
func allByteValues() []byte {
	b := make([]byte, 256)
	for i := range b {
		b[i] = byte(i)
	}
	return b
}

// catJob starts a job that copies `payload` to stdout and returns its id. A
// file rather than a printf so the bytes reach the child untouched by a shell.
func catJob(t *testing.T, srv *server, payload []byte) string {
	t.Helper()
	blob := filepath.Join(t.TempDir(), "blob")
	if err := os.WriteFile(blob, payload, 0o644); err != nil {
		t.Fatalf("write blob: %v", err)
	}
	resp := srv.postJSON(t, "/api/sessions", map[string]any{
		"type":    "job",
		"command": "cat " + blob,
	})
	id, ok := resp["id"].(string)
	if !ok || id == "" {
		t.Fatalf("no session id in %v", resp)
	}
	return id
}

// streamWith reads the whole stream body under one Accept header, and returns
// what the server said it was sending along with the bytes it sent.
func streamWith(t *testing.T, srv *server, id, accept string) (string, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, srv.url("/api/sessions/"+id+"/stream"), nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("Accept", accept)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET stream: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read stream: %v", err)
	}
	return resp.Header.Get("Content-Type"), body
}

// decodeFrames concatenates the .text of every data: frame, which is all a
// client can recover from the framed path.
func decodeFrames(body []byte) string {
	var out strings.Builder
	for _, line := range strings.Split(string(body), "\n") {
		payload, ok := strings.CutPrefix(strings.TrimRight(line, "\r"), "data: ")
		if !ok || payload == "[DONE]" {
			continue
		}
		var frame struct {
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(payload), &frame) == nil {
			out.WriteString(frame.Text)
		}
	}
	return out.String()
}

func TestJobStreamRawIsByteExact(t *testing.T) {
	srv := startServer(t)
	payload := allByteValues()
	id := catJob(t, srv, payload)

	ct, got := streamWith(t, srv, id, "application/octet-stream")
	if !strings.HasPrefix(ct, "application/octet-stream") {
		t.Fatalf("Content-Type = %q, want application/octet-stream", ct)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("stream changed the bytes: %d in, %d out", len(payload), len(got))
		for i := range payload {
			if i >= len(got) || got[i] != payload[i] {
				t.Fatalf("first difference at offset %d", i)
			}
		}
	}
}

// The counterpart, and the reason the raw path exists. Pinned rather than
// merely known: if someone later makes the frame lossless, this failing is the
// signal to reconsider which path a pipe should take — not a bug to paper over.
func TestJobStreamFramesCannotCarryBytes(t *testing.T) {
	srv := startServer(t)
	payload := allByteValues()
	id := catJob(t, srv, payload)

	ct, body := streamWith(t, srv, id, "text/event-stream")
	if !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}
	text := decodeFrames(body)
	if text == string(payload) {
		t.Fatal("the framed path round-tripped every byte — raw mode may no longer be needed")
	}
	if !strings.Contains(text, "�") {
		t.Errorf("expected U+FFFD in the framed output; got %d bytes without any", len(text))
	}
}

// A browser sends a wildcard Accept and must keep getting frames: it has no way
// to read a raw log, and the gateway's keepalive injection is keyed off the SSE
// content type too.
func TestWildcardAcceptStillGetsFrames(t *testing.T) {
	srv := startServer(t)
	id := catJob(t, srv, []byte("hello\n"))

	for _, accept := range []string{"*/*", "text/html", ""} {
		ct, body := streamWith(t, srv, id, accept)
		if !strings.HasPrefix(ct, "text/event-stream") {
			t.Errorf("Accept %q: Content-Type = %q, want text/event-stream", accept, ct)
		}
		if !strings.Contains(string(body), "data: ") {
			t.Errorf("Accept %q: no frames in the body", accept)
		}
	}
}

// awaitJobExit blocks until /exit reports a code, which is the state the length
// header is about: the child is gone, the log is closed, and nothing can append.
func awaitJobExit(t *testing.T, srv *server, id string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(srv.url("/api/sessions/" + id + "/exit"))
		if err == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("job %s never recorded an exit code", id)
}

// A finished job's raw stream declares its length, which is the only way a
// client can tell a complete download from one an intermediary ended early.
//
// The framed path ends with `data: [DONE]` — positive proof the box decided the
// stream was over. Raw cannot carry a marker, because any byte in it is a byte
// the child never wrote, so without a declared length a body that stops half
// way is indistinguishable from one that finished. Content-Length lives in the
// envelope rather than the bytes, costs nothing, and makes an HTTP client fail
// a short read on its own.
func TestFinishedRawStreamDeclaresItsLength(t *testing.T) {
	srv := startServer(t)
	payload := []byte("hello\n")
	id := catJob(t, srv, payload)
	awaitJobExit(t, srv, id)

	req, err := http.NewRequest(http.MethodGet, srv.url("/api/sessions/"+id+"/stream"), nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("Accept", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET stream: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read stream: %v", err)
	}
	if resp.ContentLength != int64(len(payload)) {
		t.Errorf("Content-Length = %d, want %d", resp.ContentLength, len(payload))
	}
	if string(body) != string(payload) {
		t.Errorf("body = %q, want %q", body, payload)
	}
}

// The framed path must NOT gain a length: it stays chunked so the gateway can
// interleave `:keepalive` comments into it, and a declared length would make
// that injection a protocol error rather than a heartbeat.
func TestFinishedFramedStreamStaysUnsized(t *testing.T) {
	srv := startServer(t)
	id := catJob(t, srv, []byte("hello\n"))
	awaitJobExit(t, srv, id)

	req, err := http.NewRequest(http.MethodGet, srv.url("/api/sessions/"+id+"/stream"), nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET stream: %v", err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.ContentLength != -1 {
		t.Errorf("framed Content-Length = %d, want unset (chunked)", resp.ContentLength)
	}
}

// The raw body is the child's output and nothing else — no [DONE], no exit
// frame, and no `:keepalive` comment. Any of those would be bytes the child
// never wrote, landing in whatever file the caller redirected into.
func TestRawStreamCarriesNoFrameBytes(t *testing.T) {
	srv := startServer(t)
	id := catJob(t, srv, []byte("hello\n"))

	_, body := streamWith(t, srv, id, "application/octet-stream")
	if string(body) != "hello\n" {
		t.Fatalf("raw body = %q, want %q", body, "hello\n")
	}
}
