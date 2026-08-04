package wsh_test

import (
	"archive/tar"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Single-file push: the plan header carries `file`, naming the one entry under
// `target` the push may touch. It exists because `abox-cli push ~/.zshrc` is
// otherwise shaped exactly like replicating a home directory — target $HOME,
// rel ".", home true — and would therefore run the box's repair script over
// config the push never mentioned.
//
// Three properties carry the mode, and each has a test below: the hook does not
// run, nothing is ever deleted, and apply will write the declared name and
// nothing else. The last is what makes the first two safe rather than merely
// intended — a file-mode plan is allowed into $HOME, so the body has to be
// pinned to one path.

// planFile asks for a single-file plan and returns (status, response).
func planFile(t *testing.T, srv *server, target, rel, name string, hdr map[string]any) (int, map[string]any) {
	t.Helper()
	header := map[string]any{
		"rel":     rel,
		"target":  target,
		"home":    rel == ".",
		"file":    name,
		"deletes": false,
	}
	for k, v := range hdr {
		header[k] = v
	}
	return srv.postNdjson(t, "/api/push/plan2", header, []map[string]any{
		entry(name, "file", 2, time.Now()),
	})
}

// applyOne uploads a tar for a plan and returns (status, response).
func applyOne(t *testing.T, srv *server, planID string, files []tarFile) (int, map[string]any) {
	t.Helper()
	const sentinel = "file-mode-test"
	return srv.postTar(t, "/api/push/apply?plan_id="+planID, writeTar(t, files, sentinel), sentinel)
}

// The reason the mode exists. A file in $HOME is planned with rel "." and
// home true — indistinguishable from a whole-box push to the hook's trigger —
// so `file` is what tells the two apart.
func TestPushFileModeSkipsPostfixHook(t *testing.T) {
	srv, home := setupPushHook(t, "#!/bin/sh\necho 'hook ran'\nexit 0\n")

	code, plan := planFile(t, srv, home, ".", ".zshrc", nil)
	if code != 200 {
		t.Fatalf("plan: status %d body=%v", code, plan)
	}
	if got, _ := plan["file"].(string); got != ".zshrc" {
		t.Errorf("plan should echo file=%q, got %q — the client uses it to tell a box that understood the mode from one that ignored the field", ".zshrc", got)
	}
	planID, _ := plan["plan_id"].(string)

	code, resp := applyOne(t, srv, planID, []tarFile{
		{name: ".zshrc", mode: 0o644, body: []byte("hi"), typ: tar.TypeReg, mtime: time.Now()},
	})
	if code != 200 {
		t.Fatalf("apply: status %d body=%v", code, resp)
	}
	if _, ran := resp["postfix"]; ran {
		t.Errorf("postfix ran for a single-file push: %v", resp["postfix"])
	}
	if b, err := os.ReadFile(filepath.Join(home, ".zshrc")); err != nil || string(b) != "hi" {
		t.Errorf("file did not land: %q %v", b, err)
	}
}

// A whole-box push through the same endpoint still runs the hook — the skip is
// `file`'s doing, not something that broke the trigger for everyone.
func TestPushWholeBoxStillRunsPostfixHook(t *testing.T) {
	srv, home := setupPushHook(t, "#!/bin/sh\necho 'hook ran'\nexit 0\n")

	code, plan := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": ".", "target": home, "home": true, "deletes": false,
	}, []map[string]any{entry(".zshrc", "file", 2, time.Now())})
	if code != 200 {
		t.Fatalf("plan: status %d body=%v", code, plan)
	}
	planID, _ := plan["plan_id"].(string)
	code, resp := applyOne(t, srv, planID, []tarFile{
		{name: ".zshrc", mode: 0o644, body: []byte("hi"), typ: tar.TypeReg, mtime: time.Now()},
	})
	if code != 200 {
		t.Fatalf("apply: status %d body=%v", code, resp)
	}
	if _, ran := resp["postfix"]; !ran {
		t.Errorf("whole-box push did not run the hook")
	}
}

// A one-entry manifest against a populated directory says "everything else is
// leftover". In a tree push that is a delete list; here it must be nothing at
// all — and not because the client remembered to ask, which is why the header
// below says deletes: true.
func TestPushFileModeNeverDeletes(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"keep-a.txt", "keep-b.txt"} {
		if err := os.WriteFile(filepath.Join(target, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	code, plan := planFile(t, srv, target, "workspace/proj", "notes.md", map[string]any{"deletes": true})
	if code != 200 {
		t.Fatalf("plan: status %d body=%v", code, plan)
	}
	if got := numField(plan, "leftover_count"); got != 0 {
		t.Errorf("leftover_count = %d, want 0 — a file push has no opinion about the siblings", got)
	}
	if got, _ := plan["deletes"].(bool); got {
		t.Errorf("deletes = true for a single-file push; the header must not be able to turn them on")
	}
	planID, _ := plan["plan_id"].(string)

	code, resp := applyOne(t, srv, planID, []tarFile{
		{name: "notes.md", mode: 0o644, body: []byte("hi"), typ: tar.TypeReg, mtime: time.Now()},
	})
	if code != 200 {
		t.Fatalf("apply: status %d body=%v", code, resp)
	}
	if got := numField(resp, "deleted"); got != 0 {
		t.Errorf("deleted = %d, want 0", got)
	}
	for _, name := range []string{"keep-a.txt", "keep-b.txt"} {
		if _, err := os.Stat(filepath.Join(target, name)); err != nil {
			t.Errorf("%s was removed by a single-file push: %v", name, err)
		}
	}
}

// The pin. apply otherwise takes the plan's word for what the body contains, so
// without this a file-mode plan — which may be aimed at $HOME — would be a way
// to write anywhere under it.
func TestPushFileModeRejectsForeignTarEntry(t *testing.T) {
	srv, home := setupPush(t)

	code, plan := planFile(t, srv, home, ".", ".zshrc", nil)
	if code != 200 {
		t.Fatalf("plan: status %d body=%v", code, plan)
	}
	planID, _ := plan["plan_id"].(string)

	code, resp := applyOne(t, srv, planID, []tarFile{
		{name: ".zshrc", mode: 0o644, body: []byte("hi"), typ: tar.TypeReg, mtime: time.Now()},
		{name: ".ssh/id_rsa", mode: 0o600, body: []byte("stolen"), typ: tar.TypeReg, mtime: time.Now()},
	})
	if code != 400 {
		t.Fatalf("apply: status %d body=%v, want 400", code, resp)
	}
	// Staging is discarded whole on a rejected apply, so neither entry lands —
	// not the smuggled one, and not the legitimate one alongside it.
	for _, name := range []string{".zshrc", ".ssh/id_rsa"} {
		if _, err := os.Stat(filepath.Join(home, name)); err == nil {
			t.Errorf("%s landed from a rejected apply", name)
		}
	}
}

// The manifest has to agree with the header. A header claiming one file and a
// body carrying a tree is a client to disbelieve rather than reconcile — the
// whole safety argument is that the plan can name exactly one path.
func TestPushFileModeRejectsManifestMismatch(t *testing.T) {
	srv, home := setupPush(t)
	now := time.Now()
	cases := []struct {
		name    string
		entries []map[string]any
	}{
		{"two entries", []map[string]any{entry("a.txt", "file", 1, now), entry("b.txt", "file", 1, now)}},
		{"wrong name", []map[string]any{entry("b.txt", "file", 1, now)}},
		{"empty manifest", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, resp := srv.postNdjson(t, "/api/push/plan2", map[string]any{
				"rel": ".", "target": home, "home": true, "file": "a.txt", "deletes": false,
			}, tc.entries)
			if code != 400 {
				t.Errorf("status %d body=%v, want 400", code, resp)
			}
		})
	}
}

// `file` names one entry in the target directory, so anything with a separator
// in it is a client trying to reach further than the target check validated.
func TestPushFileModeRejectsBadName(t *testing.T) {
	srv, home := setupPush(t)
	for _, name := range []string{"sub/a.txt", "../escape", "..", "."} {
		code, resp := srv.postNdjson(t, "/api/push/plan2", map[string]any{
			"rel": ".", "target": home, "home": true, "file": name, "deletes": false,
		}, []map[string]any{entry(name, "file", 1, time.Now())})
		if code != 400 {
			t.Errorf("file=%q: status %d body=%v, want 400", name, code, resp)
		}
	}
}

// v1 deletes unconditionally — it predates the `deletes` header and has no way
// to express "keep what you have". A one-entry manifest there would take a copy
// of one file and remove every sibling, so the mode is refused outright rather
// than half-supported.
func TestPushFileModeRefusedByV1(t *testing.T) {
	srv, home := setupPush(t)
	code, resp := srv.postJSONRaw(t, "/api/push/plan", map[string]any{
		"rel": "workspace/proj", "target": filepath.Join(home, "workspace", "proj"), "file": "a.txt",
		"entries": []map[string]any{entry("a.txt", "file", 1, time.Now())},
	})
	if code != 400 {
		t.Errorf("status %d body=%v, want 400", code, resp)
	}
}

// The diff is one lstat, not a walk — a file already on the box in the same
// shape is not re-sent, and a changed one is an update rather than an add.
func TestPushFileModeDiffsThatPathOnly(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	abs := filepath.Join(target, "notes.md")
	if err := os.WriteFile(abs, []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(abs)
	if err != nil {
		t.Fatal(err)
	}

	// Same size and mtime as the box's copy → nothing to do.
	code, plan := srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": "workspace/proj", "target": target, "file": "notes.md", "deletes": false,
	}, []map[string]any{entry("notes.md", "file", 2, st.ModTime())})
	if code != 200 {
		t.Fatalf("plan: status %d body=%v", code, plan)
	}
	if a, u := numField(plan, "add_count"), numField(plan, "update_count"); a != 0 || u != 0 {
		t.Errorf("identical file: add=%d update=%d, want 0/0", a, u)
	}

	// Different size → update, not add: the box saw its own copy.
	code, plan = srv.postNdjson(t, "/api/push/plan2", map[string]any{
		"rel": "workspace/proj", "target": target, "file": "notes.md", "deletes": false,
	}, []map[string]any{entry("notes.md", "file", 99, time.Now())})
	if code != 200 {
		t.Fatalf("plan: status %d body=%v", code, plan)
	}
	if a, u := numField(plan, "add_count"), numField(plan, "update_count"); a != 0 || u != 1 {
		t.Errorf("changed file: add=%d update=%d, want 0/1", a, u)
	}
}

// Promote renames the staged file over the target, which fails on a directory,
// and a mode that never deletes has nothing that could clear the way. Said at
// plan time so it reads as a fact about the box rather than as a rename error
// at the far end of an upload.
func TestPushFileModeRefusesDirectoryOnBox(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(filepath.Join(target, "notes.md"), 0o755); err != nil {
		t.Fatal(err)
	}
	code, resp := planFile(t, srv, target, "workspace/proj", "notes.md", nil)
	if code != 400 {
		t.Errorf("status %d body=%v, want 400", code, resp)
	}
}

// Box-owned deny rules still win. The mode changes what a push may carry, never
// what the box is willing to receive.
func TestPushFileModeStillObeysDeny(t *testing.T) {
	srv, home := setupPushDeny(t, "/.trae/traecli.yaml\n")
	target := filepath.Join(home, ".trae")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	code, plan := planFile(t, srv, target, ".trae", "traecli.yaml", nil)
	if code != 200 {
		t.Fatalf("plan: status %d body=%v", code, plan)
	}
	if got := numField(plan, "add_count"); got != 0 {
		t.Errorf("add_count = %d, want 0 — the denied file must not be scheduled", got)
	}
	if got := numField(plan, "preserved_count"); got != 1 {
		t.Errorf("preserved_count = %d, want 1", got)
	}
}
