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

// postEncodedTar sends a tar body under the named Content-Encoding.
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
	req.Header.Set("Content-Type", "application/x-tar")
	req.Header.Set("X-Abox-Push-Sentinel", sentinel)
	if encoding != "" {
		req.Header.Set("Content-Encoding", encoding)
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
			t.Errorf("status %d for Content-Encoding: br, want 400", code)
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
