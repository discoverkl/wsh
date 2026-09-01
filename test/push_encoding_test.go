package wsh_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

// A first whole-box push is many gigabytes of mostly source and config, so the
// apply body is worth compressing. Which compression is not negotiated by
// trial — the box advertises what it can decompress in the plan reply, because
// the alternative is finding out it cannot only after streaming the whole
// thing at it.

// postEncodedTar sends a tar body under the named compression, labelled the way
// a current client labels it.
func postEncodedTar(t *testing.T, srv *server, path string, tarBody *bytes.Buffer, sentinel, encoding string) (int, map[string]any) {
	t.Helper()
	var body bytes.Buffer
	switch encoding {
	case "":
		body = *tarBody
	case "gzip":
		gz := gzip.NewWriter(&body)
		if _, err := io.Copy(gz, tarBody); err != nil {
			t.Fatalf("gzip: %v", err)
		}
		if err := gz.Close(); err != nil {
			t.Fatalf("gzip close: %v", err)
		}
	case "zstd":
		zw, err := zstd.NewWriter(&body)
		if err != nil {
			t.Fatalf("zstd: %v", err)
		}
		if _, err := io.Copy(zw, tarBody); err != nil {
			t.Fatalf("zstd copy: %v", err)
		}
		if err := zw.Close(); err != nil {
			t.Fatalf("zstd close: %v", err)
		}
	case "gzip-lie":
		// A plain tar that will be announced as gzip: the box must reject it
		// rather than half-extract whatever it makes of the bytes.
		body = *tarBody
		encoding = "gzip"
	default:
		body = *tarBody
	}
	req, err := http.NewRequest(http.MethodPost, srv.url(path), &body)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Abox-Push-Sentinel", sentinel)
	if encoding != "" {
		req.Header.Set(aboxCompression, encoding)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestPushPlanV2AdvertisesAcceptedEncodings(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	code, resp := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": "workspace/proj", "target": target,
	}, []map[string]any{entry("a.txt", "file", 1, time.Now())})
	if code != 200 {
		t.Fatalf("status %d: %v", code, resp)
	}
	accepted := map[string]bool{}
	arr, _ := resp["accept_encoding"].([]any)
	for _, v := range arr {
		s, _ := v.(string)
		accepted[s] = true
	}
	// gzip is the floor and must always be offered; zstd depends on the Node
	// this box is actually running, which is why the list is probed and not
	// hard-coded.
	if !accepted["gzip"] {
		t.Errorf("accept_encoding = %v, want gzip at minimum", resp["accept_encoding"])
	}
}

// Every advertised encoding has to round-trip a real apply.
func TestPushApplyAcceptsEncodedBodies(t *testing.T) {
	for _, encoding := range []string{"", "gzip", "zstd"} {
		name := encoding
		if name == "" {
			name = "identity"
		}
		t.Run(name, func(t *testing.T) {
			srv, home := setupPush(t)
			target := filepath.Join(home, "workspace", "proj")
			mtime := time.Now().Truncate(time.Second)
			plan := srv.postJSON(t, "/api/push/plan", map[string]any{
				"rel": "workspace/proj", "target": target,
				"entries": []map[string]any{
					entry("a.txt", "file", 5, mtime),
				},
			})
			planID, _ := plan["plan_id"].(string)

			body := writeTar(t, []tarFile{
				{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: mtime},
			}, "sent")
			code, resp := postEncodedTar(t, srv, "/api/push/apply?plan_id="+planID, body, "sent", encoding)
			if code != 200 {
				t.Fatalf("status %d: %v", code, resp)
			}
			got, err := os.ReadFile(filepath.Join(target, "a.txt"))
			if err != nil || string(got) != "alpha" {
				t.Errorf("file did not land: %q err=%v", got, err)
			}
		})
	}
}

// An encoding the box never advertised, and a body that lies about its own
// encoding, both have to fail closed — nothing may land from a stream the box
// cannot actually read.
func TestPushApplyRejectsBadEncoding(t *testing.T) {
	t.Run("unknown encoding", func(t *testing.T) {
		srv, home := setupPush(t)
		target := filepath.Join(home, "workspace", "proj")
		mtime := time.Now().Truncate(time.Second)
		plan := srv.postJSON(t, "/api/push/plan", map[string]any{
			"rel": "workspace/proj", "target": target,
			"entries": []map[string]any{
				entry("a.txt", "file", 5, mtime),
			},
		})
		planID, _ := plan["plan_id"].(string)
		body := writeTar(t, []tarFile{
			{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: mtime},
		}, "sent")
		code, _ := postEncodedTar(t, srv, "/api/push/apply?plan_id="+planID, body, "sent", "br")
		if code != 400 {
			t.Errorf("status %d for an unknown compression, want 400", code)
		}
		if _, err := os.Stat(filepath.Join(target, "a.txt")); !os.IsNotExist(err) {
			t.Errorf("nothing should have landed, err=%v", err)
		}
	})

	t.Run("body lies about its encoding", func(t *testing.T) {
		srv, home := setupPush(t)
		target := filepath.Join(home, "workspace", "proj")
		mtime := time.Now().Truncate(time.Second)
		plan := srv.postJSON(t, "/api/push/plan", map[string]any{
			"rel": "workspace/proj", "target": target,
			"entries": []map[string]any{
				entry("a.txt", "file", 5, mtime),
			},
		})
		planID, _ := plan["plan_id"].(string)
		// A plain tar sent as "gzip": the decompressor errors, no sentinel is
		// ever seen, and staging is discarded.
		body := writeTar(t, []tarFile{
			{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: mtime},
		}, "sent")
		code, _ := postEncodedTar(t, srv, "/api/push/apply?plan_id="+planID, body, "sent", "gzip-lie")
		if code == 200 {
			t.Error("a body that is not in the encoding it claims must not succeed")
		}
		if _, err := os.Stat(filepath.Join(target, "a.txt")); !os.IsNotExist(err) {
			t.Errorf("nothing should have landed, err=%v", err)
		}
	})
}

// The box advertises the same list under both names. `accept_encoding` is what
// a client predating the header rename reads; `accept_compression` is what a
// current one reads, and its absence is how that client knows it reached a box
// old enough that a compressed body could only go up under the header the
// middle of the network is the reason we stopped using.
func TestPushPlanV2AdvertisesAcceptCompression(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	code, resp := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": "workspace/proj", "target": target,
	}, []map[string]any{entry("a.txt", "file", 1, time.Now())})
	if code != 200 {
		t.Fatalf("status %d: %v", code, resp)
	}
	arr, _ := resp["accept_compression"].([]any)
	found := false
	for _, v := range arr {
		if c, _ := v.(string); c == "gzip" {
			found = true
		}
	}
	if !found {
		t.Errorf("accept_compression = %v, want gzip at minimum", resp["accept_compression"])
	}
}

// A client predating the rename labels its manifest Content-Encoding. The box
// still reads it — and only reads it; nothing here ever sends it.
func TestPushPlanV2StillReadsContentEncoding(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	body := ndjsonBody(t, map[string]any{"rel": "workspace/proj", "target": target},
		[]map[string]any{entry("a.txt", "file", 1, time.Now())}, false)
	resp, raw := srv.postNdjsonWith(t, "/api/push/plan2", body,
		map[string]string{"Content-Encoding": "gzip"})
	if resp.StatusCode != 200 {
		t.Fatalf("status %d: %s", resp.StatusCode, raw)
	}
}

// A manifest with no compression at all plans the same way, which is what a
// client falls back to when a box refuses the compressed one.
func TestPushPlanV2AcceptsPlainManifest(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	body := ndjsonBody(t, map[string]any{"rel": "workspace/proj", "target": target},
		[]map[string]any{entry("a.txt", "file", 1, time.Now())}, true)
	resp, raw := srv.postNdjsonWith(t, "/api/push/plan2", body, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d: %s", resp.StatusCode, raw)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if id, _ := out["plan_id"].(string); id == "" {
		t.Errorf("no plan came back: %v", out)
	}
}

// An apply body under the old header keeps working too, for the same reason.
func TestPushApplyStillReadsContentEncoding(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	mtime := time.Now().Truncate(time.Second)
	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel": "workspace/proj", "target": target,
		"entries": []map[string]any{entry("a.txt", "file", 5, mtime)},
	})
	planID, _ := plan["plan_id"].(string)

	tarBody := writeTar(t, []tarFile{
		{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: mtime},
	}, "sent")
	var body bytes.Buffer
	gz := gzip.NewWriter(&body)
	if _, err := io.Copy(gz, tarBody); err != nil {
		t.Fatalf("gzip: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, srv.url("/api/push/apply?plan_id="+planID), &body)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Abox-Push-Sentinel", "sent")
	req.Header.Set("Content-Encoding", "gzip")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST apply: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if got, err := os.ReadFile(filepath.Join(target, "a.txt")); err != nil || string(got) != "alpha" {
		t.Errorf("file did not land: %q err=%v", got, err)
	}
}

// A plan reply compresses when the caller offered a codec, and names it in the
// private header only. Pull is the one that matters: its `fetch` list has to
// name every file the client is missing and cannot be folded into bitmaps, so
// it is the largest JSON either endpoint ever returns.
func TestPlanRepliesCompressWhenOffered(t *testing.T) {
	for _, tc := range []struct{ name, path string }{
		{"push", "/api/push/plan2"},
		{"pull", "/api/pull/plan2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, home := setupPush(t)
			target := filepath.Join(home, "workspace", "proj")
			if err := os.MkdirAll(target, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(target, "a.txt"), []byte("alpha"), 0o644); err != nil {
				t.Fatal(err)
			}
			hdr := map[string]any{"rel": "workspace/proj", "target": target}

			resp, raw := srv.postNdjsonWith(t, tc.path, ndjsonBody(t, hdr, nil, false),
				map[string]string{aboxCompression: "gzip", aboxAcceptCompression: "gzip"})
			if resp.StatusCode != 200 {
				t.Fatalf("status %d: %s", resp.StatusCode, raw)
			}
			if got := resp.Header.Get(aboxCompression); got != "gzip" {
				t.Fatalf("reply %s = %q, want gzip", aboxCompression, got)
			}
			// The standard header stays off the wire in this direction too: it
			// is the one that invites the middle to act on a body that is ours.
			if got := resp.Header.Get("Content-Encoding"); got != "" {
				t.Errorf("reply Content-Encoding = %q, want it absent", got)
			}
			zr, err := gzip.NewReader(bytes.NewReader(raw))
			if err != nil {
				t.Fatalf("reply did not gunzip: %v", err)
			}
			var out map[string]any
			if err := json.NewDecoder(zr).Decode(&out); err != nil {
				t.Fatalf("decode compressed reply: %v", err)
			}
			if id, _ := out["plan_id"].(string); id == "" {
				t.Errorf("no plan in the compressed reply: %v", out)
			}

			// No offer, no compression: a client that cannot decode must never
			// be handed something it has to.
			resp2, raw2 := srv.postNdjsonWith(t, tc.path, ndjsonBody(t, hdr, nil, false),
				map[string]string{aboxCompression: "gzip"})
			if resp2.StatusCode != 200 {
				t.Fatalf("status %d: %s", resp2.StatusCode, raw2)
			}
			if got := resp2.Header.Get(aboxCompression); got != "" {
				t.Errorf("reply %s = %q, want none when nothing was offered", aboxCompression, got)
			}
			if !bytes.HasPrefix(bytes.TrimSpace(raw2), []byte("{")) {
				t.Errorf("unoffered reply is not plain JSON: %.40s", raw2)
			}
		})
	}
}
