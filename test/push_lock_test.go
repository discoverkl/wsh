package wsh_test

import (
	"archive/tar"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// Two applies promoting into one tree — one of them deleting — is the window
// where a concurrent push can actually destroy work, so applies over
// overlapping trees are serialized.
//
// Live *plans* deliberately hold nothing. A push that dies mid-upload leaves
// its plan behind, and the next thing the user does is re-run the command to
// continue; a plan-time lock would answer that with 409 and break the one
// recovery path that matters. TestPushResumeByRerunSkipsWhatLanded covers that
// directly.

func planFor(t *testing.T, srv *server, rel, target string, entries []map[string]any, extra map[string]any) (int, map[string]any) {
	t.Helper()
	body := map[string]any{"rel": rel, "target": target, "entries": entries}
	for k, v := range extra {
		body[k] = v
	}
	return srv.postJSONRaw(t, "/api/push/plan", body)
}

// Planning the same tree twice is fine — that is a re-run, not a conflict.
func TestPushRepeatedPlansDoNotConflict(t *testing.T) {
	srv, home := setupPush(t)
	proj := filepath.Join(home, "workspace", "proj")
	entries := []map[string]any{
		entry("a.txt", "file", 1, time.Now()),
	}
	for i := 0; i < 3; i++ {
		if code, resp := planFor(t, srv, "workspace/proj", proj, entries, nil); code != 200 {
			t.Fatalf("plan %d: status %d, want 200: %v", i, code, resp)
		}
	}
}

// An apply in flight keeps overlapping pushes out, and lets disjoint ones
// through. The first apply is held open by a body that never finishes until the
// test says so, which is what an upload in progress looks like.
func TestPushApplyOverlapIsSerialized(t *testing.T) {
	srv, home := setupPush(t)
	proj := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	entries := []map[string]any{
		entry("a.txt", "file", 1, time.Now()),
	}
	_, plan := planFor(t, srv, "workspace/proj", proj, entries, nil)
	planID, _ := plan["plan_id"].(string)
	if planID == "" {
		t.Fatalf("no plan_id: %v", plan)
	}

	// Hold an apply open: the body stays unfinished until release is closed.
	body, release := blockingTarBody(t, "sent")
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		srv.postTar(t, "/api/push/apply?plan_id="+planID+"&final=0", body, "sent")
	}()

	// Poll until the apply has registered, which is also the assertion: an
	// overlapping push must be turned away while one is writing.
	sub := filepath.Join(proj, "src")
	code, resp := 0, map[string]any(nil)
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if code, resp = planFor(t, srv, "workspace/proj/src", sub, entries, nil); code == 409 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if code != 409 {
		close(release)
		wg.Wait()
		t.Fatalf("status %d, want 409 while an apply is writing there: %v", code, resp)
	}

	// Disjoint trees are untouched by it — blocking every unrelated push for
	// the duration of a big one would be a worse cure than the disease.
	other := filepath.Join(home, "workspace", "other")
	if code, resp := planFor(t, srv, "workspace/other", other, entries, nil); code != 200 {
		t.Errorf("status %d, want 200 for a disjoint tree: %v", code, resp)
	}

	close(release)
	wg.Wait()

	// Once the apply is done the tree is free again, with no timeout to wait out.
	if code, resp := planFor(t, srv, "workspace/proj/src", sub, entries, nil); code != 200 {
		t.Errorf("status %d after the apply finished, want 200: %v", code, resp)
	}
}

// blockingTarBody yields a tar stream that stalls after its first entry and
// completes only when the returned channel is closed — an upload in progress,
// which is the state the apply lock is scoped to.
func blockingTarBody(t *testing.T, sentinel string) (io.Reader, chan struct{}) {
	t.Helper()
	release := make(chan struct{})
	pr, pw := io.Pipe()
	go func() {
		tw := tar.NewWriter(pw)
		_ = tw.WriteHeader(&tar.Header{Name: "hold.txt", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644})
		_, _ = tw.Write([]byte("x"))
		_ = tw.Flush()
		<-release
		_ = tw.WriteHeader(&tar.Header{
			Name: ".abox-push-sentinel", Typeflag: tar.TypeReg,
			Size: int64(len(sentinel)), Mode: 0o644,
		})
		_, _ = tw.Write([]byte(sentinel))
		_ = tw.Close()
		_ = pw.Close()
	}()
	return pr, release
}

// `push -n ~` followed by `push ~` is the most natural sequence there is, so a
// dry run must not even be given a plan to hold.
func TestPushDryRunHoldsNothing(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	entries := []map[string]any{
		entry("a.txt", "file", 1, time.Now()),
	}
	code, dry := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": "workspace/proj", "target": target, "dry_run": true,
	}, entries)
	if code != 200 {
		t.Fatalf("dry run: status %d: %v", code, dry)
	}
	if id, _ := dry["plan_id"].(string); id != "" {
		t.Errorf("plan_id = %q, want empty — a dry run is never applied", id)
	}
}

// A dry run reports what a push would do and changes nothing — which has to
// include not quietly reclaiming disk on its way past.
func TestPushDryRunDoesNotSweepStaging(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	orphan := filepath.Join(target, ".abox-push-staging-deadbeef")
	if err := os.MkdirAll(orphan, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphan, "leftover.bin"), make([]byte, 2048), 0o644); err != nil {
		t.Fatal(err)
	}
	entries := []map[string]any{
		entry("a.txt", "file", 1, time.Now()),
	}

	code, resp := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": "workspace/proj", "target": target, "dry_run": true,
	}, entries)
	if code != 200 {
		t.Fatalf("dry run: status %d: %v", code, resp)
	}
	if _, err := os.Stat(orphan); err != nil {
		t.Errorf("a dry run must not sweep staging directories: %v", err)
	}
	if got := numField(resp, "reclaimed_bytes"); got != 0 {
		t.Errorf("reclaimed_bytes = %d on a dry run, want 0", got)
	}

	// The real run does sweep it.
	code, resp = srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": "workspace/proj", "target": target,
	}, entries)
	if code != 200 {
		t.Fatalf("real run: status %d: %v", code, resp)
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Errorf("the real run should have swept it, err=%v", err)
	}
}

// Releasing a plan drops it. A plan's TTL scales with its payload, so an
// abandoned 40k-path delete list would otherwise sit in memory for hours.
func TestPushReleasePlanDropsIt(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	entries := []map[string]any{
		entry("a.txt", "file", 1, time.Now()),
	}
	_, plan := planFor(t, srv, "workspace/proj", target, entries, nil)
	planID, _ := plan["plan_id"].(string)

	code, resp := srv.deleteJSONRaw(t, "/api/push/plan/"+planID)
	if code != 200 {
		t.Fatalf("release: status %d: %v", code, resp)
	}
	if released, _ := resp["released"].(bool); !released {
		t.Errorf("released = %v, want true", resp["released"])
	}
	// Gone: applying it now has nothing to apply against.
	if code, _ := applyChunk(t, srv, planID, nil, true); code != 404 {
		t.Errorf("status %d after release, want 404", code)
	}
	// And releasing something already gone is not an error.
	if code, resp := srv.deleteJSONRaw(t, "/api/push/plan/"+planID); code != 200 {
		t.Errorf("second release: status %d: %v", code, resp)
	}
}

// A staging directory left by a push whose handler died is invisible to every
// walk — push can never see it, never diffs it, and never deletes it — so
// nothing but this sweep would ever reclaim the space it holds.
func TestPushSweepsOrphanedStaging(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	orphan := filepath.Join(target, ".abox-push-staging-deadbeef", "sub")
	if err := os.MkdirAll(orphan, 0o755); err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, 4096)
	if err := os.WriteFile(filepath.Join(orphan, "leftover.bin"), payload, 0o644); err != nil {
		t.Fatal(err)
	}
	// A real file alongside it, which must survive.
	if err := os.WriteFile(filepath.Join(target, "keep.txt"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}

	entries := []map[string]any{
		entry("keep.txt", "file", 4, time.Now()),
	}
	code, resp := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": "workspace/proj", "target": target,
	}, entries)
	if code != 200 {
		t.Fatalf("status %d: %v", code, resp)
	}
	if _, err := os.Stat(filepath.Join(target, ".abox-push-staging-deadbeef")); !os.IsNotExist(err) {
		t.Errorf("the orphaned staging directory should have been swept, err=%v", err)
	}
	if got := numField(resp, "reclaimed_bytes"); got < len(payload) {
		t.Errorf("reclaimed_bytes = %d, want at least %d", got, len(payload))
	}
	if _, err := os.Stat(filepath.Join(target, "keep.txt")); err != nil {
		t.Errorf("the sweep must only touch staging directories: %v", err)
	}
	// And the staging directory was never mistaken for something to delete.
	if got := numField(resp, "leftover_count"); got != 0 {
		t.Errorf("leftover_count = %d, want 0: %v", got, resp["leftover"])
	}
}

// Tens of thousands of individual delete lines is not a confirmation prompt.
// The rollup is computed from the full list, not the sample that crosses the
// wire, so the summary describes the push rather than the first 200 paths.
func TestPushDeleteRollup(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	for _, dir := range []string{"big", "small"} {
		if err := os.MkdirAll(filepath.Join(target, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 300; i++ {
		name := filepath.Join(target, "big", "f"+string(rune('a'+i%26))+string(rune('a'+i/26)))
		if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(target, "small", "one.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// An empty manifest would trip the client's own refusal, so send one entry.
	if err := os.WriteFile(filepath.Join(target, "kept.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Lstat(filepath.Join(target, "kept.txt"))
	entries := []map[string]any{
		entry("kept.txt", "file", 1, st.ModTime()),
	}
	code, resp := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": "workspace/proj", "target": target,
	}, entries)
	if code != 200 {
		t.Fatalf("status %d: %v", code, resp)
	}

	// The sample is capped; the rollup is not derived from it.
	if got := len(strSet(t, resp, "leftover")); got > 200 {
		t.Errorf("leftover sample = %d paths, want it capped", got)
	}
	rollup, _ := resp["leftover_rollup"].([]any)
	if len(rollup) == 0 {
		t.Fatalf("no leftover_rollup in %v", resp)
	}
	first, _ := rollup[0].(map[string]any)
	if dir, _ := first["dir"].(string); dir != "big" {
		t.Errorf("largest group is %q, want \"big\"", dir)
	}
	if got, _ := first["count"].(float64); int(got) != 300 {
		t.Errorf("big count = %v, want 300 — the rollup must come from the full list", got)
	}
}
