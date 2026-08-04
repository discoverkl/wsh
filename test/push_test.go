package wsh_test

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// push integration tests target the in-box wsh /api/push/{plan,apply} endpoints
// that abox-cli push uses for client→box folder sync. The server walks $HOME, so
// each test points HOME at a fresh tempdir before starting the server.

// setupPush: tempdir → $HOME, start server, return (srv, home).
func setupPush(t *testing.T) (*server, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	srv := startServer(t)
	return srv, home
}

// postTar sends a tar body to path with the given sentinel header, returns
// (status, decoded JSON body).
func (s *server) postTar(t *testing.T, path string, body io.Reader, sentinel string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, s.url(path), body)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/x-tar")
	req.Header.Set("X-Abox-Push-Sentinel", sentinel)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// tarFile appends one file entry; tarSentinel appends the final sentinel.
type tarFile struct {
	name  string
	mode  int64
	body  []byte
	typ   byte // tar.TypeReg / tar.TypeDir / tar.TypeSymlink
	link  string
	mtime time.Time
	// Extended header records. Set on a ranged slice, which declares where in
	// its file the body belongs; nil on every ordinary entry, which is what
	// keeps the tars these tests wrote before ranges byte-identical.
	pax map[string]string
}

func writeTar(t *testing.T, files []tarFile, sentinel string) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, f := range files {
		hdr := &tar.Header{Name: f.name, Mode: f.mode, Typeflag: f.typ, ModTime: f.mtime, Linkname: f.link}
		if f.typ == tar.TypeReg {
			hdr.Size = int64(len(f.body))
		}
		if f.pax != nil {
			hdr.Format = tar.FormatPAX
			hdr.PAXRecords = f.pax
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("write header %s: %v", f.name, err)
		}
		if f.typ == tar.TypeReg && len(f.body) > 0 {
			if _, err := tw.Write(f.body); err != nil {
				t.Fatalf("write body %s: %v", f.name, err)
			}
		}
	}
	if sentinel != "" {
		if err := tw.WriteHeader(&tar.Header{
			Name: ".abox-push-sentinel", Typeflag: tar.TypeReg,
			Size: int64(len(sentinel)), Mode: 0o644,
		}); err != nil {
			t.Fatalf("sentinel hdr: %v", err)
		}
		if _, err := tw.Write([]byte(sentinel)); err != nil {
			t.Fatalf("sentinel body: %v", err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tw.Close: %v", err)
	}
	return &buf
}

// Plan against a missing target dir → every client entry is in `add`,
// nothing in update/delete.
func TestPushPlanEmptyTarget(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "fresh")
	body := map[string]any{
		"rel":    "workspace/fresh",
		"target": target,
		"entries": []map[string]any{
			{"path": "a.txt", "type": "file", "size": 5, "mtime_ns": time.Now().UnixNano(), "mode": 0o644},
			{"path": "sub", "type": "dir", "mode": 0o755},
		},
	}
	resp := srv.postJSON(t, "/api/push/plan", body)
	add, _ := resp["add"].([]any)
	upd, _ := resp["update"].([]any)
	del, _ := resp["delete"].([]any)
	if len(add) != 2 {
		t.Errorf("add: got %d, want 2 (resp=%v)", len(add), resp)
	}
	if len(upd) != 0 || len(del) != 0 {
		t.Errorf("expected empty update/delete, got upd=%v del=%v", upd, del)
	}
	if id, _ := resp["plan_id"].(string); id == "" {
		t.Errorf("plan_id missing")
	}
}

// Plan + apply happy path: heterogeneous entries land byte-faithfully on disk,
// counts match, response fields are populated.
func TestPushApplyHappyPath(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "happy")

	// Plan
	now := time.Now()
	bodyAlpha := []byte("alpha content")
	bodyBeta := []byte{0, 1, 2, 3, 4, 5}
	planReq := map[string]any{
		"rel":    "workspace/happy",
		"target": target,
		"entries": []map[string]any{
			{"path": "alpha.txt", "type": "file", "size": len(bodyAlpha), "mtime_ns": now.UnixNano(), "mode": 0o644},
			{"path": "sub", "type": "dir", "mode": 0o755},
			{"path": "sub/beta.bin", "type": "file", "size": len(bodyBeta), "mtime_ns": now.UnixNano(), "mode": 0o600},
		},
	}
	plan := srv.postJSON(t, "/api/push/plan", planReq)
	planID, _ := plan["plan_id"].(string)
	if planID == "" {
		t.Fatalf("no plan_id: %v", plan)
	}

	// Apply
	sentinel := "push-sentinel-happy"
	tarBuf := writeTar(t, []tarFile{
		{name: "alpha.txt", mode: 0o644, body: bodyAlpha, typ: tar.TypeReg, mtime: now},
		{name: "sub/", mode: 0o755, typ: tar.TypeDir, mtime: now},
		{name: "sub/beta.bin", mode: 0o600, body: bodyBeta, typ: tar.TypeReg, mtime: now},
	}, sentinel)
	code, resp := srv.postTar(t, "/api/push/apply?plan_id="+planID, tarBuf, sentinel)
	if code != 200 {
		t.Fatalf("apply: status %d, body=%v", code, resp)
	}
	if got := numField(resp, "added"); got != 3 {
		t.Errorf("added: got %v, want 3", got)
	}
	// files_written counts every tar entry successfully promoted (file, dir,
	// symlink) so it matches the client's filesSent denominator on the UI.
	if got := numField(resp, "files_written"); got != 3 {
		t.Errorf("files_written: got %v, want 3", got)
	}

	// On-disk verification
	if b, err := os.ReadFile(filepath.Join(target, "alpha.txt")); err != nil || string(b) != string(bodyAlpha) {
		t.Errorf("alpha.txt: err=%v body=%q", err, string(b))
	}
	if b, err := os.ReadFile(filepath.Join(target, "sub", "beta.bin")); err != nil || !bytes.Equal(b, bodyBeta) {
		t.Errorf("sub/beta.bin: err=%v body=%v", err, b)
	}
	// Staging dir cleaned up
	ents, _ := os.ReadDir(target)
	for _, e := range ents {
		if filepath.HasPrefix(e.Name(), ".abox-push-staging-") {
			t.Errorf("staging dir leaked: %s", e.Name())
		}
	}
}

// Apply that finishes without sending the sentinel entry → 400. Target tree
// must remain untouched and no staging dir should leak.
func TestPushApplySentinelMissing(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "incomplete")

	// Pre-seed an existing file so we can prove it survives the rejected apply.
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	preExisting := []byte("untouched")
	if err := os.WriteFile(filepath.Join(target, "keep.txt"), preExisting, 0o644); err != nil {
		t.Fatal(err)
	}

	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":    "workspace/incomplete",
		"target": target,
		"entries": []map[string]any{
			{"path": "new.txt", "type": "file", "size": 3, "mtime_ns": time.Now().UnixNano(), "mode": 0o644},
		},
	})
	planID, _ := plan["plan_id"].(string)

	// Build a tar WITH the file but no sentinel.
	tarBuf := writeTar(t, []tarFile{
		{name: "new.txt", mode: 0o644, body: []byte("abc"), typ: tar.TypeReg, mtime: time.Now()},
	}, "" /* no sentinel */)

	// The server still sees the X-Abox-Push-Sentinel header; the apply path is
	// "headerExpected but never seen in tar" → 400. Use a non-empty value so
	// the missing-header guard doesn't fire instead.
	code, resp := srv.postTar(t, "/api/push/apply?plan_id="+planID, tarBuf, "expected-value")
	if code != 400 {
		t.Fatalf("expected 400 (incomplete stream), got %d body=%v", code, resp)
	}

	// Pre-existing file untouched
	if b, _ := os.ReadFile(filepath.Join(target, "keep.txt")); !bytes.Equal(b, preExisting) {
		t.Errorf("pre-existing file modified: got %q, want %q", string(b), string(preExisting))
	}
	// New file MUST NOT exist
	if _, err := os.Stat(filepath.Join(target, "new.txt")); !os.IsNotExist(err) {
		t.Errorf("new.txt should not exist after rejected apply (err=%v)", err)
	}
	// Staging dir cleaned
	ents, _ := os.ReadDir(target)
	for _, e := range ents {
		if filepath.HasPrefix(e.Name(), ".abox-push-staging-") {
			t.Errorf("staging dir leaked: %s", e.Name())
		}
	}
}

// Tar-slip: an entry name like "../outside.txt" must be rejected. The
// surrounding test target tree must remain untouched.
func TestPushApplyTarSlip(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "safe")

	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":    "workspace/safe",
		"target": target,
		"entries": []map[string]any{
			{"path": "real.txt", "type": "file", "size": 3, "mtime_ns": time.Now().UnixNano(), "mode": 0o644},
		},
	})
	planID, _ := plan["plan_id"].(string)
	if planID == "" {
		t.Fatalf("plan_id missing: %v", plan)
	}

	sentinel := "slip-test"
	tarBuf := writeTar(t, []tarFile{
		{name: "../outside.txt", mode: 0o644, body: []byte("evil"), typ: tar.TypeReg, mtime: time.Now()},
	}, sentinel)
	code, resp := srv.postTar(t, "/api/push/apply?plan_id="+planID, tarBuf, sentinel)
	if code != 400 {
		t.Fatalf("expected 400 for tar-slip, got %d body=%v", code, resp)
	}
	// Nothing written outside target's parent
	if _, err := os.Stat(filepath.Join(home, "workspace", "outside.txt")); !os.IsNotExist(err) {
		t.Errorf("outside.txt should not exist (err=%v)", err)
	}
}

// Plan diff: mtime delta within tolerance (<1s) → file NOT in update list.
// Delta > 1s → file IS in update.
func TestPushPlanMtimeTolerance(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "mtime")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}

	body := []byte("x")
	fp := filepath.Join(target, "f.txt")
	if err := os.WriteFile(fp, body, 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(fp)
	if err != nil {
		t.Fatal(err)
	}
	serverMtimeNS := st.ModTime().UnixNano()

	// Within tolerance (500ms ahead)
	planA := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":    "workspace/mtime",
		"target": target,
		"entries": []map[string]any{
			{"path": "f.txt", "type": "file", "size": len(body), "mtime_ns": serverMtimeNS + int64(500*time.Millisecond), "mode": 0o644},
		},
	})
	if upd, _ := planA["update"].([]any); len(upd) != 0 {
		t.Errorf("within-tolerance: expected empty update, got %v", upd)
	}

	// Beyond tolerance (2s ahead)
	planB := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":    "workspace/mtime",
		"target": target,
		"entries": []map[string]any{
			{"path": "f.txt", "type": "file", "size": len(body), "mtime_ns": serverMtimeNS + int64(2*time.Second), "mode": 0o644},
		},
	})
	if upd, _ := planB["update"].([]any); len(upd) != 1 {
		t.Errorf("beyond-tolerance: expected 1 update, got %v", upd)
	}
}

// Apply with deletes: server applies the plan's delete list. Local file
// disappears from target after apply.
func TestPushApplyDeletes(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "deletes")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(target, "stale.txt")
	if err := os.WriteFile(stale, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Client manifest has NO entries → server marks stale.txt as delete.
	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":     "workspace/deletes",
		"target":  target,
		"entries": []map[string]any{},
	})
	del, _ := plan["delete"].([]any)
	if len(del) != 1 {
		t.Fatalf("expected 1 delete, got %v", del)
	}
	planID, _ := plan["plan_id"].(string)

	// Apply with just the sentinel (no file entries — pure delete apply).
	sentinel := "deletes-only"
	tarBuf := writeTar(t, nil, sentinel)
	code, resp := srv.postTar(t, "/api/push/apply?plan_id="+planID, tarBuf, sentinel)
	if code != 200 {
		t.Fatalf("delete-only apply: status %d body=%v", code, resp)
	}
	if got := numField(resp, "deleted"); got != 1 {
		t.Errorf("deleted: got %v, want 1", got)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("stale.txt should be gone (err=%v)", err)
	}
}

// Stale plan_id (or unknown) → 404.
func TestPushApplyStalePlanID(t *testing.T) {
	srv, _ := setupPush(t)
	tarBuf := writeTar(t, nil, "x")
	code, _ := srv.postTar(t, "/api/push/apply?plan_id=nonexistent-id", tarBuf, "x")
	if code != 404 {
		t.Errorf("stale plan_id: got %d, want 404", code)
	}
}

// numField extracts a numeric JSON field (int or float64 — Go decodes JSON
// numbers as float64 into map[string]any), returning -1 on absence/type miss.
func numField(m map[string]any, key string) int {
	switch v := m[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	}
	return -1
}

// silence unused-import on environments where fmt isn't otherwise used (we use
// it via the helper signatures elsewhere; this var is a deliberate no-op).
var _ = fmt.Sprintf
