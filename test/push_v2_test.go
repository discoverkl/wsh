package wsh_test

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// /api/push/plan2 is the streaming plan endpoint: one gzipped NDJSON header
// line, then one manifest entry per line, answered in manifest *positions*
// rather than paths.
//
// v1 buffers the whole manifest as one JSON body and express caps that at 50mb
// — roughly 400k entries — so a whole-box push fails outright with a 413. v2
// exists to remove that ceiling, and the tests below are mostly about the two
// places the position-based answer can go wrong quietly: the index has to be
// the position as *received* (before the box's own deny filter removes
// anything), and the box's entry count has to match what the client sent.

// The header a manifest's codec travels under. Not Content-Encoding: that one
// is the corner of HTTP every proxy between a CLI and a box believes it may act
// on, so the codec is named privately and stays end to end. The box still reads
// the standard header, and only reads it, for clients predating the rename —
// see TestPushPlanV2StillReadsContentEncoding.
const aboxCompression = "X-Abox-Compression"
const aboxAcceptCompression = "X-Abox-Accept-Compression"

// ndjsonBody encodes a header line plus entries, gzipped unless plain is set.
func ndjsonBody(t *testing.T, header map[string]any, entries []map[string]any, plain bool) *bytes.Buffer {
	t.Helper()
	var raw bytes.Buffer
	var w io.Writer = &raw
	var gz *gzip.Writer
	if !plain {
		gz = gzip.NewWriter(&raw)
		w = gz
	}
	enc := json.NewEncoder(w)
	if err := enc.Encode(header); err != nil {
		t.Fatalf("encode header: %v", err)
	}
	for _, e := range entries {
		if err := enc.Encode(e); err != nil {
			t.Fatalf("encode entry: %v", err)
		}
	}
	if gz != nil {
		if err := gz.Close(); err != nil {
			t.Fatalf("gzip close: %v", err)
		}
	}
	return &raw
}

// postNdjsonWith sends a prepared body under the given request headers and
// hands back the live response, for tests that care what came back and not only
// what it decoded to.
func (s *server) postNdjsonWith(t *testing.T, path string, body *bytes.Buffer, reqHeaders map[string]string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, s.url(path), body)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	for k, v := range reqHeaders {
		req.Header.Set(k, v)
	}
	// No transparent decoding: what the box compressed it labelled itself, and
	// a test that let net/http unwrap it could not tell the two apart.
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	return resp, raw
}

// postNdjson sends a header line plus entries as gzipped NDJSON, labelled the
// way a current client labels it.
func (s *server) postNdjson(t *testing.T, path string, header map[string]any, entries []map[string]any) (int, map[string]any) {
	t.Helper()
	resp, raw := s.postNdjsonWith(t, path, ndjsonBody(t, header, entries, false),
		map[string]string{aboxCompression: "gzip"})
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

// bitsSet decodes a base64 bitmap into the ascending positions it names.
func bitsSet(t *testing.T, m map[string]any, key string) []int {
	t.Helper()
	b64, _ := m[key].(string)
	if b64 == "" {
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("bad %s bitmap %q: %v", key, b64, err)
	}
	var out []int
	for i, v := range raw {
		for bit := 0; bit < 8; bit++ {
			if v&(1<<bit) != 0 {
				out = append(out, i*8+bit)
			}
		}
	}
	return out
}

// entry builds one manifest line.
func entry(path, typ string, size int, mtime time.Time) map[string]any {
	e := map[string]any{"path": path, "type": typ}
	if typ == "file" {
		e["size"] = size
		e["mtime_ns"] = mtime.UnixNano()
		e["mode"] = 0o644
	}
	return e
}

// A fresh target: every entry is an add, named by its own position, and nothing
// is an update or a delete.
func TestPushPlanV2EmptyTarget(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "fresh")
	now := time.Now()
	entries := []map[string]any{
		entry("a.txt", "file", 5, now),
		{"path": "sub", "type": "dir"},
		entry("sub/b.txt", "file", 3, now),
	}
	code, resp := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": "workspace/fresh", "target": target,
	}, entries)
	if code != 200 {
		t.Fatalf("status %d: %v", code, resp)
	}
	if got := numField(resp, "manifest_count"); got != len(entries) {
		t.Errorf("manifest_count = %d, want %d", got, len(entries))
	}
	if got, want := bitsSet(t, resp, "add_bits"), []int{0, 1, 2}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("add_bits = %v, want %v", got, want)
	}
	if got := bitsSet(t, resp, "update_bits"); len(got) != 0 {
		t.Errorf("update_bits = %v, want none", got)
	}
	if got := numField(resp, "add_count"); got != 3 {
		t.Errorf("add_count = %d, want 3", got)
	}
	if got := numField(resp, "leftover_count"); got != 0 {
		t.Errorf("delete_count = %d, want 0", got)
	}
	// Only files count toward the upload: 5 + 3, with the directory free.
	if got := numField(resp, "bytes_to_send"); got != 8 {
		t.Errorf("bytes_to_send = %d, want 8", got)
	}
}

// The load-bearing invariant. A denied entry is dropped from the diff but must
// NOT renumber the manifest: the client addresses what it uploads by position
// against the slice it streamed, and it has no idea the box refused anything.
// Renumbering here would shift every bit after the first denied path, and the
// push would send the wrong files with no other symptom.
func TestPushPlanV2IndexCountedBeforeDenyFilter(t *testing.T) {
	srv, home := setupPushDeny(t, "/.trae/traecli.yaml\n")
	now := time.Now()
	// The denied path sits in the middle, so a renumbering bug moves the
	// entries after it by exactly one.
	entries := []map[string]any{
		entry("first.txt", "file", 1, now),
		{"path": ".trae", "type": "dir"},
		entry(".trae/traecli.yaml", "file", 9, now), // denied — index 2 consumed
		entry("last.txt", "file", 1, now),           // must still be index 3
	}
	code, resp := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": ".", "target": home, "home": true,
	}, entries)
	if code != 200 {
		t.Fatalf("status %d: %v", code, resp)
	}
	if got := numField(resp, "manifest_count"); got != 4 {
		t.Errorf("manifest_count = %d, want 4 — denied entries still count", got)
	}
	got := bitsSet(t, resp, "add_bits")
	want := []int{0, 1, 3} // 2 is denied and absent; 3 keeps its position
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("add_bits = %v, want %v — a denied entry must not renumber the ones after it", got, want)
	}
	if got := numField(resp, "preserved_count"); got != 1 {
		t.Errorf("preserved_count = %d, want 1", got)
	}
}

// Same tree, same inputs, both endpoints: the verdicts have to agree, or a
// client falling back to v1 against an older box would upload a different set.
func TestPushPlanV2AgreesWithV1(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(filepath.Join(target, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	// same.txt matches; stale.txt differs in size; gone.txt is only on the box.
	mtime := time.Now().Add(-time.Hour)
	for name, body := range map[string]string{
		"same.txt":  "hello",
		"stale.txt": "old",
		"gone.txt":  "bye",
	} {
		p := filepath.Join(target, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
	entries := []map[string]any{
		entry("same.txt", "file", 5, mtime),
		entry("stale.txt", "file", 99, mtime),
		entry("new.txt", "file", 4, time.Now()),
	}
	hdr := map[string]any{"rel": "workspace/proj", "target": target}

	code, v2 := srv.postNdjson(t, "/api/push/plan2", hdr, entries)
	if code != 200 {
		t.Fatalf("v2 status %d: %v", code, v2)
	}
	v1 := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel": "workspace/proj", "target": target, "entries": entries,
	})

	// v1 answers in paths, v2 in positions — translate and compare.
	v2Add := map[string]bool{}
	for _, i := range bitsSet(t, v2, "add_bits") {
		v2Add[entries[i]["path"].(string)] = true
	}
	v2Upd := map[string]bool{}
	for _, i := range bitsSet(t, v2, "update_bits") {
		v2Upd[entries[i]["path"].(string)] = true
	}
	if want := strSet(t, v1, "add"); fmt.Sprint(v2Add) != fmt.Sprint(want) {
		t.Errorf("add: v2 %v, v1 %v", v2Add, want)
	}
	if want := strSet(t, v1, "update"); fmt.Sprint(v2Upd) != fmt.Sprint(want) {
		t.Errorf("update: v2 %v, v1 %v", v2Upd, want)
	}
	if got, want := numField(v2, "leftover_count"), len(strSet(t, v1, "delete")); got != want {
		t.Errorf("delete_count: v2 %d, v1 %d", got, want)
	}
	if got := numField(v2, "bytes_to_send"); got != int(v1["bytes_to_send"].(float64)) {
		t.Errorf("bytes_to_send: v2 %d, v1 %v", got, v1["bytes_to_send"])
	}
}

// deletes:false is the whole-box default. The leftovers are reported the same
// way regardless — one list, one count, one rollup — and `deletes` says whether
// they will be removed. That is what makes the default a visible fact about
// this box rather than a line in --help.
func TestPushPlanV2ReportsLeftoversEitherWay(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "theirs.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	entries := []map[string]any{entry("mine.txt", "file", 4, time.Now())}
	hdr := map[string]any{"rel": "workspace/proj", "target": target, "deletes": false}

	code, resp := srv.postNdjson(t, "/api/push/plan2", hdr, entries)
	if code != 200 {
		t.Fatalf("status %d: %v", code, resp)
	}
	// Same list, same count, either way — only `deletes` says what happens to it.
	if acting, _ := resp["deletes"].(bool); acting {
		t.Error("deletes = true, want false when the client asked for none")
	}
	if got := numField(resp, "leftover_count"); got != 1 {
		t.Errorf("leftover_count = %d, want 1", got)
	}
	if got := strSet(t, resp, "leftover"); !got["theirs.txt"] {
		t.Errorf("leftover = %v, want theirs.txt", got)
	}

	// And with deletes on, the same tree reports it as a delete instead.
	hdr["deletes"] = true
	code, resp = srv.postNdjson(t, "/api/push/plan2", hdr, entries)
	if code != 200 {
		t.Fatalf("status %d: %v", code, resp)
	}
	if acting, _ := resp["deletes"].(bool); !acting {
		t.Error("deletes = false, want true when the client asked for them")
	}
	if got := numField(resp, "leftover_count"); got != 1 {
		t.Errorf("leftover_count = %d, want 1", got)
	}
}

// A malformed manifest line is a 400, not a partial plan: a plan built from
// half a manifest would read as "the client no longer has the rest".
func TestPushPlanV2RejectsBadInput(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	hdr := map[string]any{"rel": "workspace/proj", "target": target}

	cases := []struct {
		name    string
		entries []map[string]any
	}{
		{"missing path", []map[string]any{{"type": "file"}}},
		{"unknown type", []map[string]any{{"path": "a.txt", "type": "device"}}},
		{"absolute path", []map[string]any{{"path": "/etc/passwd", "type": "file"}}},
		{"dotdot component", []map[string]any{{"path": "../escape.txt", "type": "file"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, resp := srv.postNdjson(t, "/api/push/plan2", hdr, tc.entries)
			if code != 400 {
				t.Errorf("status %d, want 400 (%v)", code, resp)
			}
		})
	}

	// An empty body has no header line to read.
	code, _ := srv.postNdjson(t, "/api/push/plan2", nil, nil)
	if code == 200 {
		t.Error("an empty body should not produce a plan")
	}
}

// The client's skip list filters the box's walk, so an excluded path is not
// reported as something the box holds and we don't — which the diff would
// otherwise resolve by deleting it.
func TestPushPlanV2SkipFiltersTargetWalk(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(filepath.Join(target, "node_modules", "dep"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "node_modules", "dep", "i.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	entries := []map[string]any{entry("a.txt", "file", 1, time.Now())}

	code, resp := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": "workspace/proj", "target": target, "skip": []string{"node_modules"},
	}, entries)
	if code != 200 {
		t.Fatalf("status %d: %v", code, resp)
	}
	if got := numField(resp, "leftover_count"); got != 0 {
		t.Errorf("delete_count = %d, want 0 — a skipped path must not become a delete (%v)", got, resp["delete"])
	}
}
