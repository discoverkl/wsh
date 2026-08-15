package wsh_test

import (
	"archive/tar"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// /api/sync/check is the box's half of the agreed-state record: one round trip
// that answers "has anyone changed this box since we last agreed?", so a push
// can tell what it is about to destroy from what it is merely about to replace.
//
// The record is an optimization, never a safety mechanism — every degraded case
// answers no_record, and the client's response to that is to stop and ask. So
// what these tests pin is mostly that the degraded cases really do degrade:
// an unseen filter, a damaged file, a push that never finished.

const syncReplica = "0123456789abcdef0123456789abcdef"

// syncCheck posts a check for one root and returns the `root` object.
func syncCheck(t *testing.T, s *server, root map[string]any) map[string]any {
	t.Helper()
	resp := s.postJSON(t, "/api/sync/check", map[string]any{"replica": syncReplica, "root": root})
	out, _ := resp["root"].(map[string]any)
	if out == nil {
		t.Fatalf("no root in check response: %v", resp)
	}
	return out
}

func syncState(t *testing.T, s *server, root map[string]any) string {
	t.Helper()
	st, _ := syncCheck(t, s, root)["state"].(string)
	return st
}

// A hash the box never has to interpret — it only ever compares ours to a
// previous ours, so any stable 64 hex digits stands in for a client's tree.
func syncFakeHash(seed string) string {
	h := strings.Repeat(seed, 64)
	return h[:64]
}

func syncRoot(rel, localHash string) map[string]any {
	return map[string]any{"rel": rel, "skip_fp": "none", "local_hash": localHash}
}

// syncPush runs a full plan2 + apply carrying a record intent, and returns the
// box hash the check reported before it ran.
func syncPush(t *testing.T, s *server, rel, localHash string, files []tarFile) {
	t.Helper()
	entries := make([]map[string]any, 0, len(files))
	for _, f := range files {
		entries = append(entries, map[string]any{
			"path": f.name, "type": "file", "size": len(f.body),
			"mtime_ns": f.mtime.UnixNano(), "mode": 0o644,
		})
	}
	code, plan := s.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel":        rel,
		"target":     filepath.Join(os.Getenv("HOME"), rel),
		"deletes":    true,
		"replica":    syncReplica,
		"skip_fp":    "none",
		"local_hash": localHash,
	}, entries)
	if code != 200 {
		t.Fatalf("plan2: status %d, body=%v", code, plan)
	}
	planID, _ := plan["plan_id"].(string)
	if planID == "" {
		t.Fatalf("no plan_id: %v", plan)
	}
	sentinel := "sync-sentinel"
	code, resp := s.postTar(t, "/api/push/apply?plan_id="+planID, writeTar(t, files, sentinel), sentinel)
	if code != 200 {
		t.Fatalf("apply: status %d, body=%v", code, resp)
	}
}

// The whole cycle: nothing agreed, push, agreed. This is the case every other
// one below is a degradation of.
func TestSyncRecordsWhatAPushAgreed(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/sync"
	local := syncFakeHash("a")

	before := syncCheck(t, srv, syncRoot(rel, local))
	if got, _ := before["state"].(string); got != "no_record" {
		t.Errorf("state before any push = %q, want no_record", got)
	}
	// An empty destination has nothing that could have been deleted, which is
	// what lets a first push land without a prompt.
	if empty, _ := before["empty"].(bool); !empty {
		t.Error("a destination that does not exist should report empty")
	}

	now := time.Now()
	syncPush(t, srv, rel, local, []tarFile{
		{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: now},
	})

	// The record lands under the pushing machine's own id.
	recPath := filepath.Join(home, ".wsh", "sync-state", syncReplica)
	if _, err := os.Stat(recPath); err != nil {
		t.Fatalf("no record written at %s: %v", recPath, err)
	}
	after := syncCheck(t, srv, syncRoot(rel, local))
	if got, _ := after["state"].(string); got != "in_sync" {
		t.Errorf("state after a completed push = %q, want in_sync", got)
	}
	if empty, _ := after["empty"].(bool); empty {
		t.Error("the destination now holds a file and should not report empty")
	}
	if agreed, _ := after["deletes_agreed"].(bool); !agreed {
		t.Error("the push deleted, so the record should say the agreement was a mirror rather than an overlay")
	}
}

// Movement on either side, told apart. This is the only question the check
// answers; what it licenses is the client's business.
func TestSyncSeesWhichSideMoved(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/moved"
	local := syncFakeHash("a")
	now := time.Now()
	syncPush(t, srv, rel, local, []tarFile{
		{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: now},
	})

	// A different client hash is this machine having moved on.
	if got := syncState(t, srv, syncRoot(rel, syncFakeHash("b"))); got != "local_moved" {
		t.Errorf("state with a changed client hash = %q, want local_moved", got)
	}

	// Someone worked in the box's web terminal — the case push could not see
	// before, and the one this whole design exists for.
	if err := os.WriteFile(filepath.Join(home, rel, "theirs.txt"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := syncState(t, srv, syncRoot(rel, local)); got != "box_moved" {
		t.Errorf("state after a box-side edit = %q, want box_moved", got)
	}
	if got := syncState(t, srv, syncRoot(rel, syncFakeHash("b"))); got != "both_moved" {
		t.Errorf("state with both changed = %q, want both_moved", got)
	}
}

// A record describes a filtered VIEW of a directory, so the filter belongs in
// its key. Two commands syncing one root under different filters would
// otherwise invalidate each other's record on every single run.
func TestSyncRecordIsKeyedByFilter(t *testing.T) {
	srv, _ := setupPush(t)
	rel := "workspace/filtered"
	local := syncFakeHash("a")
	syncPush(t, srv, rel, local, []tarFile{
		{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: time.Now()},
	})

	other := syncRoot(rel, local)
	other["skip_fp"] = "a-filter-never-seen-before"
	if got := syncState(t, srv, other); got != "no_record" {
		t.Errorf("state under an unseen filter = %q, want no_record", got)
	}
	// And the original view is untouched by having been asked about.
	if got := syncState(t, srv, syncRoot(rel, local)); got != "in_sync" {
		t.Errorf("the original record should survive: %q", got)
	}
}

// A single file is a sync root like any other — one whose walk is one lstat.
// Without a record of its own, `push ~/.zshrc` onto a box that already has one
// could never climb out of "cannot tell who last changed this".
func TestSyncRecordsASingleFile(t *testing.T) {
	srv, home := setupPush(t)
	local := syncFakeHash("a")
	root := map[string]any{"rel": ".", "home": true, "file": ".zshrc", "skip_fp": "file", "local_hash": local}

	if got := syncState(t, srv, root); got != "no_record" {
		t.Errorf("state before any push = %q, want no_record", got)
	}
	if empty, _ := syncCheck(t, srv, root)["empty"].(bool); !empty {
		t.Error("a file that does not exist yet should report empty")
	}

	now := time.Now()
	code, plan := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": ".", "target": home, "home": true, "file": ".zshrc",
		"replica": syncReplica, "skip_fp": "file", "local_hash": local,
	}, []map[string]any{
		{"path": ".zshrc", "type": "file", "size": 5, "mtime_ns": now.UnixNano(), "mode": 0o644},
	})
	if code != 200 {
		t.Fatalf("plan2: status %d, body=%v", code, plan)
	}
	planID, _ := plan["plan_id"].(string)
	sentinel := "sync-file-sentinel"
	code, resp := srv.postTar(t, "/api/push/apply?plan_id="+planID,
		writeTar(t, []tarFile{{name: ".zshrc", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: now}}, sentinel), sentinel)
	if code != 200 {
		t.Fatalf("apply: status %d, body=%v", code, resp)
	}

	if got := syncState(t, srv, root); got != "in_sync" {
		t.Errorf("state after the file landed = %q, want in_sync", got)
	}
	// Recorded under the file's own path, not the directory that contains it —
	// otherwise a dotfile push and a whole-box push would fight over one line.
	data, err := os.ReadFile(filepath.Join(home, ".wsh", "sync-state", syncReplica))
	if err != nil {
		t.Fatal(err)
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(data))), &rec); err != nil {
		t.Fatalf("record is not one JSON object per line: %v (%q)", err, data)
	}
	if rec["rel"] != ".zshrc" {
		t.Errorf("record rel = %v, want the file's own path", rec["rel"])
	}

	// Touching the file on the box is box movement, exactly as for a tree.
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte("theirs, longer"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := syncState(t, srv, root); got != "box_moved" {
		t.Errorf("state after a box-side edit of the file = %q, want box_moved", got)
	}
}

// The record is a cache of agreements. Damaging it must cost a confirmation
// prompt, which is what having no record has always meant — never a box nobody
// can sync to.
func TestSyncSurvivesADamagedRecord(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/damaged"
	local := syncFakeHash("a")
	syncPush(t, srv, rel, local, []tarFile{
		{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: time.Now()},
	})

	recPath := filepath.Join(home, ".wsh", "sync-state", syncReplica)
	if err := os.WriteFile(recPath, []byte("{not json at all\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := syncState(t, srv, syncRoot(rel, local)); got != "no_record" {
		t.Errorf("state with a damaged record = %q, want no_record", got)
	}
}

// A replica id becomes a filename, so a lax reader here is how a path separator
// gets into one.
func TestSyncRefusesAMalformedReplica(t *testing.T) {
	srv, _ := setupPush(t)
	for _, bad := range []any{"../../etc/passwd", "", "short", 42, nil} {
		code, _ := srv.postJSONRaw(t, "/api/sync/check", map[string]any{
			"replica": bad,
			"root":    syncRoot("workspace/x", syncFakeHash("a")),
		})
		if code != 400 {
			t.Errorf("replica %v: status %d, want 400", bad, code)
		}
	}
}

// And a rel is still a path, checked the same way every other push path is.
func TestSyncRefusesAnEscapingRel(t *testing.T) {
	srv, _ := setupPush(t)
	for _, bad := range []string{"../outside", "/etc", "workspace/../../x"} {
		code, _ := srv.postJSONRaw(t, "/api/sync/check", map[string]any{
			"replica": syncReplica,
			"root":    syncRoot(bad, syncFakeHash("a")),
		})
		if code != 400 {
			t.Errorf("rel %q: status %d, want 400", bad, code)
		}
	}
}

// A push that dies mid-chunk leaves the record alone, so the next run sees more
// difference than there is. That is the safe direction: it stops and asks.
func TestSyncRecordsNothingForANonFinalChunk(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/partial"
	local := syncFakeHash("a")
	now := time.Now()
	code, plan := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": rel, "target": filepath.Join(home, rel), "deletes": true,
		"replica": syncReplica, "skip_fp": "none", "local_hash": local,
	}, []map[string]any{
		{"path": "a.txt", "type": "file", "size": 5, "mtime_ns": now.UnixNano(), "mode": 0o644},
	})
	if code != 200 {
		t.Fatalf("plan2: status %d, body=%v", code, plan)
	}
	planID, _ := plan["plan_id"].(string)
	sentinel := "sync-partial-sentinel"
	code, resp := srv.postTar(t, "/api/push/apply?plan_id="+planID+"&final=0",
		writeTar(t, []tarFile{{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: now}}, sentinel), sentinel)
	if code != 200 {
		t.Fatalf("apply: status %d, body=%v", code, resp)
	}
	if _, err := os.Stat(filepath.Join(home, ".wsh", "sync-state", syncReplica)); !os.IsNotExist(err) {
		t.Error("a chunk with more to come recorded an agreement the push has not yet earned")
	}
	if got := syncState(t, srv, syncRoot(rel, local)); got != "no_record" {
		t.Errorf("state after a non-final chunk = %q, want no_record", got)
	}
}

// A client that says nothing about records gets none kept — the fields are
// additive, and an older client simply does not send them.
func TestSyncRecordsNothingWithoutAReplica(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/anon"
	now := time.Now()
	code, plan := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": rel, "target": filepath.Join(home, rel), "deletes": true,
	}, []map[string]any{
		{"path": "a.txt", "type": "file", "size": 5, "mtime_ns": now.UnixNano(), "mode": 0o644},
	})
	if code != 200 {
		t.Fatalf("plan2: status %d, body=%v", code, plan)
	}
	planID, _ := plan["plan_id"].(string)
	sentinel := "sync-anon-sentinel"
	code, resp := srv.postTar(t, "/api/push/apply?plan_id="+planID,
		writeTar(t, []tarFile{{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: now}}, sentinel), sentinel)
	if code != 200 {
		t.Fatalf("apply: status %d, body=%v", code, resp)
	}
	if _, err := os.Stat(filepath.Join(home, ".wsh", "sync-state")); !os.IsNotExist(err) {
		t.Error("a push that named no replica should leave no records behind")
	}
}
