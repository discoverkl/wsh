package wsh_test

import (
	"archive/tar"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The trash is what makes a push that overwrites recoverable rather than merely
// confirmed. The guard in sync.md stops the damage; this undoes it when someone
// says yes anyway.
//
// Nothing is copied: apply already stages then promotes by rename, so setting
// the old file aside is one extra rename() on the same filesystem. That is what
// makes it affordable on a whole-box push — it holds the overwritten set, never
// the tree — and it is why a mirror onto a fresh box trashes nothing at all.

// trashBatches lists the batch directories under ~/.wsh/trash.
func trashBatches(t *testing.T, home string) []string {
	t.Helper()
	ents, err := os.ReadDir(filepath.Join(home, ".wsh", "trash"))
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out
}

// pushOne runs a plan2 + apply carrying one file, and returns the apply reply.
func pushOne(t *testing.T, s *server, home, rel, name, body string, extra map[string]any) map[string]any {
	t.Helper()
	now := time.Now()
	header := map[string]any{
		"rel": rel, "target": filepath.Join(home, rel), "deletes": true,
	}
	for k, v := range extra {
		header[k] = v
	}
	code, plan := s.postNdjson(t, "/api/push/plan2", header, []map[string]any{
		{"path": name, "type": "file", "size": len(body), "mtime_ns": now.UnixNano(), "mode": 0o644},
	})
	if code != 200 {
		t.Fatalf("plan2: status %d, body=%v", code, plan)
	}
	planID, _ := plan["plan_id"].(string)
	sentinel := "trash-sentinel-" + name
	code, resp := s.postTar(t, "/api/push/apply?plan_id="+planID,
		writeTar(t, []tarFile{{name: name, mode: 0o644, body: []byte(body), typ: tar.TypeReg, mtime: now}}, sentinel), sentinel)
	if code != 200 {
		t.Fatalf("apply: status %d, body=%v", code, resp)
	}
	return resp
}

// An overwrite sets the old contents aside, under the path it had.
func TestPushTrashKeepsWhatItOverwrote(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/over"
	dir := filepath.Join(home, rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("theirs, the old one"), 0o644); err != nil {
		t.Fatal(err)
	}

	resp := pushOne(t, srv, home, rel, "a.txt", "ours, the new one", nil)
	if got := numField(resp, "trashed"); got != 1 {
		t.Errorf("trashed = %v, want 1 (resp=%v)", got, resp)
	}

	// The new contents landed.
	got, err := os.ReadFile(filepath.Join(dir, "a.txt"))
	if err != nil || string(got) != "ours, the new one" {
		t.Fatalf("destination = %q, %v", got, err)
	}
	// And the old ones are recoverable, at the same shape under the batch.
	batches := trashBatches(t, home)
	if len(batches) != 1 {
		t.Fatalf("batches = %v, want exactly one", batches)
	}
	kept, err := os.ReadFile(filepath.Join(home, ".wsh", "trash", batches[0], rel, "a.txt"))
	if err != nil {
		t.Fatalf("nothing kept at %s/%s/a.txt: %v", batches[0], rel, err)
	}
	if string(kept) != "theirs, the old one" {
		t.Errorf("kept %q, want the contents the push replaced", kept)
	}
}

// A delete is the case the trash exists for most: it is the one thing a push
// does that nothing else can undo.
func TestPushTrashKeepsWhatItDeleted(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/del"
	dir := filepath.Join(home, rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "theirs.txt"), []byte("only on the box"), 0o644); err != nil {
		t.Fatal(err)
	}

	resp := pushOne(t, srv, home, rel, "a.txt", "ours", nil)
	if got := numField(resp, "deleted"); got != 1 {
		t.Errorf("deleted = %v, want 1", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "theirs.txt")); !os.IsNotExist(err) {
		t.Error("the leftover should be gone from the tree")
	}
	batches := trashBatches(t, home)
	if len(batches) != 1 {
		t.Fatalf("batches = %v, want exactly one", batches)
	}
	kept, err := os.ReadFile(filepath.Join(home, ".wsh", "trash", batches[0], rel, "theirs.txt"))
	if err != nil {
		t.Fatalf("a deleted file was not recoverable: %v", err)
	}
	if string(kept) != "only on the box" {
		t.Errorf("kept %q", kept)
	}
}

// A push onto a box that holds none of the files displaces nothing. This is the
// property that makes the trash affordable on a first whole-box mirror.
func TestPushTrashCostsNothingOnAFreshBox(t *testing.T) {
	srv, home := setupPush(t)
	resp := pushOne(t, srv, home, "workspace/fresh", "a.txt", "brand new", nil)
	if got := numField(resp, "trashed"); got > 0 {
		t.Errorf("trashed = %v, want 0 — nothing was there to displace", got)
	}
	if b := trashBatches(t, home); len(b) != 0 {
		t.Errorf("batches = %v, want none", b)
	}
}

// --no-trash destroys outright, for the box that is short of disk.
func TestPushNoTrashOverwritesOutright(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/notrash"
	dir := filepath.Join(home, rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("gone forever"), 0o644); err != nil {
		t.Fatal(err)
	}

	resp := pushOne(t, srv, home, rel, "a.txt", "replacement", map[string]any{"no_trash": true})
	if got := numField(resp, "trashed"); got > 0 {
		t.Errorf("trashed = %v, want 0 with --no-trash", got)
	}
	if b := trashBatches(t, home); len(b) != 0 {
		t.Errorf("batches = %v, want none with --no-trash", b)
	}
}

// The trash is denied in push-ignore.d, so a mirror can neither carry the
// source box's undo in nor delete the target's as a leftover. Two-way
// invisibility is the whole property; this pins the delete half, which is the
// one that fails silently.
func TestPushTrashIsInvisibleToTheDiff(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/invis"
	dir := filepath.Join(home, rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("first"), 0o644); err != nil {
		t.Fatal(err)
	}
	pushOne(t, srv, home, rel, "a.txt", "second", nil)
	batches := trashBatches(t, home)
	if len(batches) != 1 {
		t.Fatalf("expected a batch to exist, got %v", batches)
	}

	// A whole-box push with deletes on. Without the deny rule the trash is a
	// path the box holds and the client did not send — a leftover — and this
	// push would take it.
	now := time.Now()
	code, plan := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": ".", "target": home, "home": true, "deletes": true,
	}, []map[string]any{
		{"path": "keep.txt", "type": "file", "size": 4, "mtime_ns": now.UnixNano(), "mode": 0o644},
	})
	if code != 200 {
		t.Fatalf("plan2: status %d, body=%v", code, plan)
	}
	for _, p := range plan["leftover"].([]any) {
		if strings.HasPrefix(p.(string), ".wsh/trash") {
			t.Fatalf("the trash was listed as a leftover and would be deleted: %v", p)
		}
	}
	planID, _ := plan["plan_id"].(string)
	sentinel := "invis-sentinel"
	code, resp := srv.postTar(t, "/api/push/apply?plan_id="+planID,
		writeTar(t, []tarFile{{name: "keep.txt", mode: 0o644, body: []byte("keep"), typ: tar.TypeReg, mtime: now}}, sentinel), sentinel)
	if code != 200 {
		t.Fatalf("apply: status %d, body=%v", code, resp)
	}
	if _, err := os.Stat(filepath.Join(home, ".wsh", "trash", batches[0], rel, "a.txt")); err != nil {
		t.Errorf("a whole-box push deleted the box's own undo history: %v", err)
	}
}
