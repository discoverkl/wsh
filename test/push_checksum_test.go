package wsh_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

// --checksum is the flag for the case metadata cannot see: a file whose size
// and mtime match the box's copy while the contents differ. Restoring an
// archive, a build that rewrites in place, a clock that went backwards.
//
// It never worked. The box compared `c.sha256 !== s.sha256` guarded on
// `s.sha256` being set, and nothing on this side has ever set it — pushWalk
// reports size, mtime and mode. So the guard was permanently false: the client
// paid a full read of every file it pushed, sent 64 bytes per entry, and the
// diff came out identical to a run without the flag. There was no test.

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// The forged-mtime case, which is the entire reason the flag exists.
func TestPushChecksumCatchesMatchingMetadata(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/sums"
	dir := filepath.Join(home, rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	boxBody := []byte("what the box holds")
	// Same length by construction: size is the one signal the box compares
	// before reaching for a hash, so the test has to hold it equal.
	clientBody := bytes.Repeat([]byte("x"), len(boxBody))
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), boxBody, 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(dir, "a.txt"))
	if err != nil {
		t.Fatal(err)
	}

	// Same size, same mtime, different content — indistinguishable without a
	// content hash, which is the whole point.
	entry := map[string]any{
		"path": "a.txt", "type": "file", "size": len(clientBody),
		"mtime_ns": st.ModTime().UnixNano(), "mode": 0o644,
		"sha256": sha256Hex(clientBody),
	}
	header := map[string]any{"rel": rel, "target": dir, "deletes": true}

	code, plan := srv.postNdjson(t, "/api/push/plan2", header, []map[string]any{entry})
	if code != 200 {
		t.Fatalf("plan2: status %d, body=%v", code, plan)
	}
	if got := numField(plan, "update_count"); got != 0 {
		t.Errorf("without --checksum the metadata matches, so nothing should be an update; got %v", got)
	}

	header["checksum"] = true
	code, plan = srv.postNdjson(t, "/api/push/plan2", header, []map[string]any{entry})
	if code != 200 {
		t.Fatalf("plan2 with checksum: status %d, body=%v", code, plan)
	}
	if got := numField(plan, "update_count"); got != 1 {
		t.Errorf("--checksum must notice the contents differ; update_count=%v (plan=%v)", got, plan)
	}
}

// And it must not manufacture work. A file that genuinely matches stays
// matched, or `push -c` re-uploads the whole tree every time.
func TestPushChecksumLeavesIdenticalFilesAlone(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/same"
	dir := filepath.Join(home, rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte("identical on both sides")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(dir, "a.txt"))
	if err != nil {
		t.Fatal(err)
	}

	code, plan := srv.postNdjson(t, "/api/push/plan2",
		map[string]any{"rel": rel, "target": dir, "deletes": true, "checksum": true},
		[]map[string]any{{
			"path": "a.txt", "type": "file", "size": len(body),
			"mtime_ns": st.ModTime().UnixNano(), "mode": 0o644,
			"sha256": sha256Hex(body),
		}})
	if code != 200 {
		t.Fatalf("plan2: status %d, body=%v", code, plan)
	}
	if got := numField(plan, "update_count"); got != 0 {
		t.Errorf("a file that matches by content is not an update; got %v", got)
	}
	if got := numField(plan, "add_count"); got != 0 {
		t.Errorf("nor an add; got %v", got)
	}
}

// A file the box cannot read counts as different. Re-sending is the safe
// direction; the alternative is a push that silently skips exactly the files
// it could not verify.
func TestPushChecksumResendsUnreadableFiles(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root, which can read anything")
	}
	srv, home := setupPush(t)
	rel := "workspace/locked"
	dir := filepath.Join(home, rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte("unreadable")
	abs := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(abs, body, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(abs, 0o644) })
	st, err := os.Stat(abs)
	if err != nil {
		t.Fatal(err)
	}

	code, plan := srv.postNdjson(t, "/api/push/plan2",
		map[string]any{"rel": rel, "target": dir, "deletes": true, "checksum": true},
		[]map[string]any{{
			"path": "a.txt", "type": "file", "size": len(body),
			"mtime_ns": st.ModTime().UnixNano(), "mode": 0o644,
			"sha256": sha256Hex(body),
		}})
	if code != 200 {
		t.Fatalf("plan2: status %d, body=%v", code, plan)
	}
	if got := numField(plan, "update_count"); got != 1 {
		t.Errorf("a file we cannot hash should be re-sent; got %v", got)
	}
}
