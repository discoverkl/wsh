package wsh_test

import (
	"archive/tar"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The box used to walk its tree twice per sync: once for /api/sync/check to
// answer who moved, and again for the plan that followed, seconds later, over a
// tree nobody touched in between. sync.md → rule-2: step 2 reuses step 1's work.
//
// What has to hold is not that the reuse happens — a miss is always allowed and
// never reported — but that a plan built from a retained walk is the same plan
// as one built from its own. The filter has side effects the diff depends on,
// and those are the ones a naive entry cache would silently drop.

func syncWalkToken(t *testing.T, s *server, root map[string]any) string {
	t.Helper()
	tok, _ := syncCheck(t, s, root)["walk_token"].(string)
	return tok
}

// Kept when a plan is going to follow, dropped when this answer ends the run.
// An in-sync check that held a few hundred megabytes of entries for a client
// that has already stopped is how a box runs out of memory saying "nothing
// changed".
func TestSyncRetainsAWalkOnlyWhenAPlanFollows(t *testing.T) {
	srv, _ := setupPush(t)
	rel := "workspace/walk"
	local := syncFakeHash("a")

	if tok := syncWalkToken(t, srv, syncRoot(rel, local)); tok == "" {
		t.Error("no_record means the client will plan, so the walk is worth keeping")
	}

	syncPush(t, srv, rel, local, []tarFile{
		{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: time.Now()},
	})

	root := syncRoot(rel, local)
	if got := syncState(t, srv, root); got != "in_sync" {
		t.Fatalf("state after a completed push = %q, want in_sync", got)
	}
	if tok := syncWalkToken(t, srv, root); tok != "" {
		t.Errorf("an in-sync check ends the run and should keep nothing, got token %q", tok)
	}
}

// A single file is one lstat. There is no walk to keep, and offering a token
// for one would be a lookup that can only ever miss.
func TestSyncKeepsNoWalkForASingleFile(t *testing.T) {
	srv, home := setupPush(t)
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte("export X=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := map[string]any{
		"rel": ".", "home": true, "file": ".zshrc",
		"skip_fp": "file", "local_hash": syncFakeHash("a"),
	}
	if tok := syncWalkToken(t, srv, root); tok != "" {
		t.Errorf("a single-file check has no walk to retain, got %q", tok)
	}
}

// The plan a retained walk produces is the plan the walk would have produced.
func TestSyncPlanFromARetainedWalkMatches(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/reuse"
	target := filepath.Join(home, rel)
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"stays.txt", "goes.txt"} {
		if err := os.WriteFile(filepath.Join(target, n), []byte("box"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	manifest := []map[string]any{
		{"path": "stays.txt", "type": "file", "size": 3, "mtime_ns": time.Now().UnixNano(), "mode": 0o644},
		{"path": "new.txt", "type": "file", "size": 3, "mtime_ns": time.Now().UnixNano(), "mode": 0o644},
	}
	plan := func(token string) map[string]any {
		hdr := map[string]any{"rel": rel, "target": target, "deletes": true, "dry_run": true}
		if token != "" {
			hdr["walk_token"] = token
		}
		code, out := srv.postNdjson(t, "/api/push/plan2", hdr, manifest)
		if code != 200 {
			t.Fatalf("plan2(%q): status %d, body=%v", token, code, out)
		}
		return out
	}

	tok := syncWalkToken(t, srv, syncRoot(rel, syncFakeHash("a")))
	if tok == "" {
		t.Fatal("expected a retained walk to test against")
	}
	reused, fresh := plan(tok), plan("")
	for _, k := range []string{"add_bits", "update_bits", "add_count", "update_count", "leftover_count", "manifest_count"} {
		if got, want := reused[k], fresh[k]; got != want {
			t.Errorf("%s: reused=%v, walked=%v", k, got, want)
		}
	}
	if !strSet(t, reused, "leftover")["goes.txt"] {
		t.Errorf("the leftover the box holds should survive reuse, got %v", reused["leftover"])
	}
}

// The subtle one. `preserved` and the held-ancestor set are side effects of the
// filter running during the walk — a cache of bare entries would leave both
// empty, so a plan built from it would report nothing protected and would
// schedule the protected file for deletion.
func TestSyncRetainedWalkKeepsTheDenyRules(t *testing.T) {
	srv, home := setupPushDeny(t, "/workspace/proj/keep-me.conf\n")
	rel := "workspace/proj"
	target := filepath.Join(home, rel)
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "keep-me.conf"), []byte("env-bound"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "stale.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	tok := syncWalkToken(t, srv, syncRoot(rel, syncFakeHash("a")))
	if tok == "" {
		t.Fatal("expected a retained walk to test against")
	}
	code, plan := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": rel, "target": target, "deletes": true, "dry_run": true,
		"walk_token": tok,
	}, []map[string]any{})
	if code != 200 {
		t.Fatalf("plan2: status %d, body=%v", code, plan)
	}

	del := strSet(t, plan, "leftover")
	if del["keep-me.conf"] {
		t.Error("a denied path must never be scheduled for deletion, retained walk or not")
	}
	if !del["stale.txt"] {
		t.Errorf("unprotected files must still go, leftover=%v", del)
	}
	if numField(plan, "preserved_count") != 1 {
		t.Errorf("preserved_count: got %v, want 1 — the filter's side effects must travel with the walk", plan["preserved_count"])
	}
	if !strSet(t, plan, "preserved")["workspace/proj/keep-me.conf"] {
		t.Errorf("preserved should still name the protected path, got %v", plan["preserved"])
	}
}

// The client's own skip list is the other half of the same filter: an excluded
// path is present on the box and absent upstream, which without heldLocal reads
// as "delete it".
func TestSyncRetainedWalkKeepsTheClientSkipList(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/skipped"
	target := filepath.Join(home, rel)
	if err := os.MkdirAll(filepath.Join(target, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "node_modules", "dep.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "stale.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := map[string]any{
		"rel": rel, "skip_fp": "nm", "local_hash": syncFakeHash("a"),
		"skip": []string{"node_modules/"},
	}
	tok := syncWalkToken(t, srv, root)
	if tok == "" {
		t.Fatal("expected a retained walk to test against")
	}
	code, plan := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": rel, "target": target, "deletes": true, "dry_run": true,
		"skip": []string{"node_modules/"}, "walk_token": tok,
	}, []map[string]any{})
	if code != 200 {
		t.Fatalf("plan2: status %d, body=%v", code, plan)
	}
	del := strSet(t, plan, "leftover")
	if del["node_modules"] || del["node_modules/dep.js"] {
		t.Errorf("an excluded path must not become a deletion, leftover=%v", del)
	}
	if !del["stale.txt"] {
		t.Errorf("unexcluded files must still go, leftover=%v", del)
	}
}

// A miss is not an error. Every one of these walks the tree instead and answers
// exactly what it would have answered before the cache existed — which is what
// makes the retained walk an optimisation rather than something correctness
// rests on.
func TestSyncPlanSurvivesAUselessWalkToken(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/miss"
	target := filepath.Join(home, rel)
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "there.txt"), []byte("box"), 0o644); err != nil {
		t.Fatal(err)
	}

	good := syncWalkToken(t, srv, syncRoot(rel, syncFakeHash("a")))
	if good == "" {
		t.Fatal("expected a retained walk to test against")
	}
	for _, tc := range []struct{ name, token string }{
		{"never issued", "00000000-0000-0000-0000-000000000000"},
		{"not a uuid", "../../etc/passwd"},
		{"empty", ""},
		{"already spent", good}, // single use: the run below consumed it
		{"spent twice", good},   // and again, which must also just walk
	} {
		code, plan := srv.postNdjson(t, "/api/push/plan2", map[string]any{
			"rel": rel, "target": target, "deletes": true, "dry_run": true,
			"walk_token": tc.token,
		}, []map[string]any{})
		if code != 200 {
			t.Fatalf("%s: status %d, body=%v", tc.name, code, plan)
		}
		if !strSet(t, plan, "leftover")["there.txt"] {
			t.Errorf("%s: the box's own file should still be seen, leftover=%v", tc.name, plan["leftover"])
		}
	}
}

// A token issued for one root must not answer for another. The key covers
// everything the walk depended on, so a mismatch reads as a miss.
func TestSyncWalkTokenDoesNotCrossRoots(t *testing.T) {
	srv, home := setupPush(t)
	for _, rel := range []string{"workspace/one", "workspace/two"} {
		if err := os.MkdirAll(filepath.Join(home, rel), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(home, "workspace/two", "only-in-two.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	tok := syncWalkToken(t, srv, syncRoot("workspace/one", syncFakeHash("a")))
	if tok == "" {
		t.Fatal("expected a retained walk to test against")
	}
	code, plan := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": "workspace/two", "target": filepath.Join(home, "workspace/two"),
		"deletes": true, "dry_run": true, "walk_token": tok,
	}, []map[string]any{})
	if code != 200 {
		t.Fatalf("plan2: status %d, body=%v", code, plan)
	}
	if !strSet(t, plan, "leftover")["only-in-two.txt"] {
		t.Errorf("a token from another root must be ignored and the real tree walked, got %v", plan["leftover"])
	}
}
