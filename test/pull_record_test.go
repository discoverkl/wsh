package wsh_test

import (
	"os"
	"path/filepath"
	"testing"
)

// A pull establishes an agreement, so it has to be able to record one.
//
// Nothing did before: the only writer of a push-state line was inside
// /api/push/apply, so a successful pull stored nothing and the NEXT pull read
// no_record — group 3, --yes refused. A scripted pull worked exactly once, and
// no test noticed because pull's own tests stop at the plan.
func TestPullRecordsTheAgreement(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/recorded"
	dir := filepath.Join(home, rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("alpha"), 0o644); err != nil {
		t.Fatal(err)
	}

	// The box hands the client its own hash while planning — free, because a
	// pull does not change the box, so that answer is still true afterwards.
	plan := pullPlan(t, srv, rel, dir, nil)
	boxHash, _ := plan["box_hash"].(string)
	if len(boxHash) != 64 {
		t.Fatalf("the pull plan should carry the box's hash, got %q", boxHash)
	}

	local := syncFakeHash("c")
	code, resp := srv.postJSONRaw(t, "/api/sync/record", map[string]any{
		"replica": syncReplica,
		"root": map[string]any{
			"rel": rel, "skip_fp": "none", "local_hash": local, "box_hash": boxHash,
		},
	})
	if code != 200 {
		t.Fatalf("record: status %d, body=%v", code, resp)
	}

	// And the very next check reads it back as agreed.
	if got := syncState(t, srv, syncRoot(rel, local)); got != "in_sync" {
		t.Errorf("state after a recorded pull = %q, want in_sync", got)
	}
	// A pull never deletes, so what it records is an overlay — a later
	// `push --delete` still has work to do.
	if agreed, _ := syncCheck(t, srv, syncRoot(rel, local))["deletes_agreed"].(bool); agreed {
		t.Error("a pull recorded a mirror; it can only ever agree an overlay")
	}
}

// The record endpoint takes untrusted input like every other one.
func TestPullRecordRefusesBadInput(t *testing.T) {
	srv, _ := setupPush(t)
	good := map[string]any{
		"rel": "workspace/x", "skip_fp": "none",
		"local_hash": syncFakeHash("a"), "box_hash": syncFakeHash("b"),
	}
	for _, tc := range []struct {
		name string
		mut  func(m map[string]any)
	}{
		{"escaping rel", func(m map[string]any) { m["rel"] = "../outside" }},
		{"absolute rel", func(m map[string]any) { m["rel"] = "/etc" }},
		{"short local hash", func(m map[string]any) { m["local_hash"] = "abc" }},
		{"missing box hash", func(m map[string]any) { delete(m, "box_hash") }},
		{"no skip_fp", func(m map[string]any) { delete(m, "skip_fp") }},
		{"file with a slash", func(m map[string]any) { m["file"] = "a/b" }},
	} {
		root := map[string]any{}
		for k, v := range good {
			root[k] = v
		}
		tc.mut(root)
		code, _ := srv.postJSONRaw(t, "/api/sync/record",
			map[string]any{"replica": syncReplica, "root": root})
		if code != 400 {
			t.Errorf("%s: status %d, want 400", tc.name, code)
		}
	}
	// And a malformed replica, which becomes a filename.
	code, _ := srv.postJSONRaw(t, "/api/sync/record",
		map[string]any{"replica": "../../etc/passwd", "root": good})
	if code != 400 {
		t.Errorf("malformed replica: status %d, want 400", code)
	}
}
