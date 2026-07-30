package wsh_test

import (
	"archive/tar"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A push larger than one chunk arrives as several applies against a single
// plan. Each promotes what it carried; only the last runs the deletes, the
// repair hook, and the plan's own cleanup.
//
// That split is what makes an interrupted push resumable, and the mechanism is
// worth being precise about because it is not a resume protocol: apply restores
// each file's mtime, so a file that landed matches the client's manifest on
// size and mtime, and the next plan simply doesn't list it. Re-running the same
// command is the resume. The tests below assert both halves — that a non-final
// chunk really does land, and that a subsequent plan really does skip it.

// applyChunk posts one tar to the plan, optionally marking it non-final.
func applyChunk(t *testing.T, srv *server, planID string, files []tarFile, final bool) (int, map[string]any) {
	t.Helper()
	path := "/api/push/apply?plan_id=" + planID
	if !final {
		path += "&final=0"
	}
	return srv.postTar(t, path, writeTar(t, files, "sent"), "sent")
}

// A non-final chunk promotes its files and stops. The deletes the plan named
// must still be sitting there: running them against a half-updated tree is the
// harm chunking exists to avoid, and if the client then died the box would be
// missing files that no longer exist anywhere.
func TestPushApplyNonFinalChunkDefersDeletes(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	doomed := filepath.Join(target, "doomed.txt")
	if err := os.WriteFile(doomed, []byte("bye"), 0o644); err != nil {
		t.Fatal(err)
	}

	mtime := time.Now().Add(-time.Hour).Truncate(time.Second)
	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel": "workspace/proj", "target": target,
		"entries": []map[string]any{
			entry("a.txt", "file", 5, mtime),
			entry("b.txt", "file", 5, mtime),
		},
	})
	planID, _ := plan["plan_id"].(string)
	if planID == "" {
		t.Fatalf("no plan_id: %v", plan)
	}
	if got := strSet(t, plan, "delete"); !got["doomed.txt"] {
		t.Fatalf("plan should have named doomed.txt for deletion: %v", plan["delete"])
	}

	// Chunk 1 of 2.
	code, resp := applyChunk(t, srv, planID, []tarFile{
		{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: mtime},
	}, false)
	if code != 200 {
		t.Fatalf("non-final apply: status %d: %v", code, resp)
	}
	if got, _ := resp["deleted"].(float64); got != 0 {
		t.Errorf("deleted = %v after a non-final chunk, want 0", got)
	}
	if _, err := os.Stat(doomed); err != nil {
		t.Errorf("a non-final chunk must not delete: %v", err)
	}
	// ...and what it carried is really on disk, not still in staging.
	if b, err := os.ReadFile(filepath.Join(target, "a.txt")); err != nil || string(b) != "alpha" {
		t.Errorf("chunk 1 should have promoted a.txt, got %q err=%v", b, err)
	}

	// Chunk 2, final: same plan, and now the deletes run.
	code, resp = applyChunk(t, srv, planID, []tarFile{
		{name: "b.txt", mode: 0o644, body: []byte("bravo"), typ: tar.TypeReg, mtime: mtime},
	}, true)
	if code != 200 {
		t.Fatalf("final apply: status %d: %v", code, resp)
	}
	if got, _ := resp["deleted"].(float64); got != 1 {
		t.Errorf("deleted = %v on the final chunk, want 1", got)
	}
	if _, err := os.Stat(doomed); !os.IsNotExist(err) {
		t.Errorf("the final chunk should have deleted doomed.txt, err=%v", err)
	}
	if b, err := os.ReadFile(filepath.Join(target, "b.txt")); err != nil || string(b) != "bravo" {
		t.Errorf("chunk 2 should have promoted b.txt, got %q err=%v", b, err)
	}
}

// The plan survives a non-final chunk and is gone after the final one. A plan
// swept between chunks would 404 partway through a large upload, which is why
// its TTL scales with the payload rather than sitting at a flat five minutes.
func TestPushApplyPlanLifetimeAcrossChunks(t *testing.T) {
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

	for i := 0; i < 3; i++ {
		code, resp := applyChunk(t, srv, planID, nil, false)
		if code != 200 {
			t.Fatalf("non-final chunk %d: status %d: %v", i, code, resp)
		}
	}
	if code, resp := applyChunk(t, srv, planID, nil, true); code != 200 {
		t.Fatalf("final chunk: status %d: %v", code, resp)
	}
	// Spent. A replay of the same plan_id has nothing to apply against.
	if code, _ := applyChunk(t, srv, planID, nil, true); code != 404 {
		t.Errorf("status %d after the final chunk, want 404 — the plan should be gone", code)
	}
}

// Resume, end to end and without a resume protocol: land part of a push, then
// ask for a fresh plan with the same manifest. What already arrived must not be
// listed again, because that — not a saved job — is what makes re-running the
// command continue rather than start over.
func TestPushResumeByRerunSkipsWhatLanded(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	mtime := time.Now().Add(-2 * time.Hour).Truncate(time.Second)

	manifest := []map[string]any{
		entry("a.txt", "file", 5, mtime),
		entry("b.txt", "file", 5, mtime),
		entry("c.txt", "file", 5, mtime),
	}
	body := map[string]any{"rel": "workspace/proj", "target": target, "entries": manifest}

	first := srv.postJSON(t, "/api/push/plan", body)
	if got := len(strSet(t, first, "add")); got != 3 {
		t.Fatalf("first plan add = %d, want 3", got)
	}
	planID, _ := first["plan_id"].(string)

	// One chunk lands, then the "connection drops" — no further applies.
	code, resp := applyChunk(t, srv, planID, []tarFile{
		{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: mtime},
	}, false)
	if code != 200 {
		t.Fatalf("chunk 1: status %d: %v", code, resp)
	}

	// Re-run: same manifest, new plan. a.txt matches on size and mtime now, so
	// it is not listed — the diff is the resume mechanism.
	//
	// The assertion has to be "needs no transfer", not "is not an add". A file
	// that landed without its mtime restored merely moves from add to update,
	// which is still a full re-send and would make this test pass while resume
	// was thoroughly broken.
	second := srv.postJSON(t, "/api/push/plan", body)
	add, upd := strSet(t, second, "add"), strSet(t, second, "update")
	if add["a.txt"] || upd["a.txt"] {
		t.Errorf("a.txt landed in the first attempt and must not be re-sent (add=%v update=%v)", add, upd)
	}
	if !add["b.txt"] || !add["c.txt"] {
		t.Errorf("b.txt and c.txt still need sending, got %v", add)
	}
	if got := len(add) + len(upd); got != 2 {
		t.Errorf("second plan names %d files to send, want 2 (add=%v update=%v)", got, add, upd)
	}
	// And nothing has been mistaken for a deletion along the way.
	if got := strSet(t, second, "delete"); len(got) != 0 {
		t.Errorf("second plan delete = %v, want none", got)
	}
}

// An interrupted chunk leaves the target untouched by *that* chunk: staging is
// discarded when the sentinel never arrives, so a half-received chunk cannot
// promote. Only whole chunks land.
func TestPushApplyIncompleteChunkPromotesNothing(t *testing.T) {
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

	// A tar with no sentinel is what a dropped connection looks like.
	code, _ := srv.postTar(t, "/api/push/apply?plan_id="+planID+"&final=0",
		writeTar(t, []tarFile{
			{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: mtime},
		}, ""), "sent")
	if code != 400 {
		t.Errorf("status %d for a sentinel-less chunk, want 400", code)
	}
	if _, err := os.Stat(filepath.Join(target, "a.txt")); !os.IsNotExist(err) {
		t.Errorf("an incomplete chunk must promote nothing, err=%v", err)
	}
	// The plan is still good, so the client can retry the chunk.
	if code, resp := applyChunk(t, srv, planID, []tarFile{
		{name: "a.txt", mode: 0o644, body: []byte("alpha"), typ: tar.TypeReg, mtime: mtime},
	}, true); code != 200 {
		t.Errorf("retry after an incomplete chunk: status %d: %v", code, resp)
	}
}
