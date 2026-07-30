package wsh_test

import (
	"archive/tar"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The box's deny rules (/etc/abox/push-ignore.d/*.conf, overridden here via
// ABOX_PUSH_IGNORE_DIR) hold back env-bound config and box-local state on an
// inbound push. The motivating case is pushing a whole office box onto an sg
// box: nearly everything should travel, but the files whose hostnames the image
// build rewrote for prod must not.
//
// The rule is two-way — a denied path is neither overwritten nor deleted. The
// delete half is the one that fails silently if you only filter the upload, so
// most of what follows is about deletes.

// setupPushDeny is setupPush plus a deny-rule directory. Must run before
// startServer: the server reads ABOX_PUSH_IGNORE_DIR at module load.
func setupPushDeny(t *testing.T, conf string) (*server, string) {
	t.Helper()
	home := t.TempDir()
	rules := t.TempDir()
	if err := os.WriteFile(filepath.Join(rules, "50-test.conf"), []byte(conf), 0o644); err != nil {
		t.Fatal(err)
	}
	// A non-.conf file in the directory must be ignored, so a README can live
	// alongside the rules (the shipped directory has one).
	if err := os.WriteFile(filepath.Join(rules, "README.md"), []byte("/not-a-rule.txt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("ABOX_PUSH_IGNORE_DIR", rules)
	return startServer(t), home
}

func strSet(t *testing.T, m map[string]any, key string) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	arr, _ := m[key].([]any)
	for _, v := range arr {
		s, _ := v.(string)
		out[s] = true
	}
	return out
}

// A denied path in the client manifest is dropped from the diff, so it is never
// uploaded — and the response says so rather than leaving the user to notice an
// absence.
func TestPushDenyBlocksUpload(t *testing.T) {
	srv, home := setupPushDeny(t, "/.trae/traecli.yaml\n")
	target := filepath.Join(home, ".trae")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}

	// Pushing ~/.trae directly is the bypass this anchoring exists to close:
	// the manifest's only entry is "traecli.yaml", so a rule matched against
	// push-root-relative paths would never fire. Rules are written against
	// $HOME and matched there, so `/.trae/traecli.yaml` still catches it no
	// matter how far down the push starts.
	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":    ".trae",
		"target": target,
		"entries": []map[string]any{
			{"path": "traecli.yaml", "type": "file", "size": 9, "mtime_ns": time.Now().UnixNano(), "mode": 0o644},
			{"path": "notes.md", "type": "file", "size": 4, "mtime_ns": time.Now().UnixNano(), "mode": 0o644},
		},
	})
	add := strSet(t, plan, "add")
	if add["traecli.yaml"] {
		t.Error("a denied path must not be scheduled for upload")
	}
	if !add["notes.md"] {
		t.Errorf("non-denied siblings must still be pushed, add=%v", add)
	}
}

// The delete half. The target holds a denied file the client does not have;
// a naive implementation filters only the incoming manifest, leaving the diff's
// leftover pass to delete exactly the file the rule protects.
func TestPushDenyBlocksDelete(t *testing.T) {
	srv, home := setupPushDeny(t, "/workspace/proj/keep-me.conf\n")
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	protected := filepath.Join(target, "keep-me.conf")
	if err := os.WriteFile(protected, []byte("env-bound"), 0o644); err != nil {
		t.Fatal(err)
	}
	doomed := filepath.Join(target, "stale.txt")
	if err := os.WriteFile(doomed, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":     "workspace/proj",
		"target":  target,
		"entries": []map[string]any{},
	})
	del := strSet(t, plan, "delete")
	if del["keep-me.conf"] {
		t.Error("a denied path must never be scheduled for deletion")
	}
	if !del["stale.txt"] {
		t.Errorf("unprotected stale files must still be deleted, delete=%v", del)
	}
	if numField(plan, "preserved_count") != 1 {
		t.Errorf("preserved_count: got %v, want 1 (resp=%v)", plan["preserved_count"], plan)
	}
	if !strSet(t, plan, "preserved")["workspace/proj/keep-me.conf"] {
		t.Errorf("preserved should name the protected path, got %v", plan["preserved"])
	}

	// Follow through to apply — the plan is only half the guarantee.
	planID, _ := plan["plan_id"].(string)
	code, resp := srv.postTar(t, "/api/push/apply?plan_id="+planID, writeTar(t, nil, "s"), "s")
	if code != 200 {
		t.Fatalf("apply: status %d body=%v", code, resp)
	}
	if _, err := os.Stat(protected); err != nil {
		t.Errorf("protected file was deleted: %v", err)
	}
	if _, err := os.Stat(doomed); !os.IsNotExist(err) {
		t.Errorf("stale.txt should be gone (err=%v)", err)
	}
}

// Deleting a directory is recursive, so a directory that still holds a denied
// path has to survive too — otherwise the protected file goes out with its
// parent and the rule holds only for the shallow case.
func TestPushDenyBlocksRecursiveParentDelete(t *testing.T) {
	srv, home := setupPushDeny(t, "/workspace/proj/cfg/env.json\n")
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(filepath.Join(target, "cfg"), 0o755); err != nil {
		t.Fatal(err)
	}
	protected := filepath.Join(target, "cfg", "env.json")
	if err := os.WriteFile(protected, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	sibling := filepath.Join(target, "cfg", "other.json")
	if err := os.WriteFile(sibling, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Client has nothing: without the ancestor guard, `cfg` itself lands in the
	// delete list and `rm -rf` takes env.json with it.
	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":     "workspace/proj",
		"target":  target,
		"entries": []map[string]any{},
	})
	if strSet(t, plan, "delete")["cfg"] {
		t.Error("a directory holding a denied path must not be scheduled for deletion")
	}

	planID, _ := plan["plan_id"].(string)
	code, resp := srv.postTar(t, "/api/push/apply?plan_id="+planID, writeTar(t, nil, "s"), "s")
	if code != 200 {
		t.Fatalf("apply: status %d body=%v", code, resp)
	}
	if _, err := os.Stat(protected); err != nil {
		t.Errorf("protected file was deleted along with its parent: %v", err)
	}
	if _, err := os.Stat(sibling); !os.IsNotExist(err) {
		t.Errorf("unprotected sibling should be gone (err=%v)", err)
	}
}

// apply does not check entry names against the plan's add/update sets, so the
// plan-time filter alone would not stop a client that tars a denied path
// anyway. A correct client cannot — the plan it was handed never names one —
// which makes this fail-closed rather than merely defensive.
func TestPushDenyRejectsDeniedTarEntry(t *testing.T) {
	srv, home := setupPushDeny(t, "/workspace/proj/secret.conf\n")
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(target, "secret.conf")
	if err := os.WriteFile(original, []byte("target-owned"), 0o644); err != nil {
		t.Fatal(err)
	}

	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":    "workspace/proj",
		"target": target,
		"entries": []map[string]any{
			{"path": "ok.txt", "type": "file", "size": 2, "mtime_ns": time.Now().UnixNano(), "mode": 0o644},
		},
	})
	planID, _ := plan["plan_id"].(string)

	// A rogue/stale client tars the denied path regardless of the plan.
	sentinel := "rogue"
	body := writeTar(t, []tarFile{
		{name: "ok.txt", mode: 0o644, body: []byte("hi"), typ: tar.TypeReg, mtime: time.Now()},
		{name: "secret.conf", mode: 0o644, body: []byte("clobbered"), typ: tar.TypeReg, mtime: time.Now()},
	}, sentinel)
	code, resp := srv.postTar(t, "/api/push/apply?plan_id="+planID, body, sentinel)
	if code != 400 {
		t.Fatalf("denied tar entry: status %d, want 400 (body=%v)", code, resp)
	}
	if msg, _ := resp["error"].(string); !strings.Contains(msg, "denied") {
		t.Errorf("error should name the denial, got %q", msg)
	}
	// Staged writes are discarded wholesale, so the target keeps its own copy.
	got, err := os.ReadFile(original)
	if err != nil || string(got) != "target-owned" {
		t.Errorf("target's file was modified: %q (err=%v)", got, err)
	}
}

// No rule directory (an older image, or a host that isn't a box) means no
// rules — push behaves exactly as it did before this existed.
func TestPushNoDenyDirIsInert(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ABOX_PUSH_IGNORE_DIR", filepath.Join(home, "does-not-exist"))
	srv := startServer(t)

	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "stale.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":     "workspace/proj",
		"target":  target,
		"entries": []map[string]any{},
	})
	if !strSet(t, plan, "delete")["stale.txt"] {
		t.Errorf("with no rules, deletes must be unaffected, got %v", plan["delete"])
	}
	if numField(plan, "preserved_count") > 0 {
		t.Errorf("nothing should be preserved without rules, got %v", plan["preserved_count"])
	}
}

// --- The client's own skip list ---
//
// A skipped path is absent from the manifest, which without help reads to the
// diff as "present on the box, gone upstream" — i.e. delete it. That turns
// "ignore node_modules" into "delete node_modules on the box", so the client
// ships its skip list and the box applies it to its own walk.

func TestPushSkipBlocksDelete(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(filepath.Join(target, "node_modules", "dep"), 0o755); err != nil {
		t.Fatal(err)
	}
	kept := filepath.Join(target, "node_modules", "dep", "index.js")
	if err := os.WriteFile(kept, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	doomed := filepath.Join(target, "stale.txt")
	if err := os.WriteFile(doomed, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":     "workspace/proj",
		"target":  target,
		"skip":    []string{"node_modules/"},
		"entries": []map[string]any{},
	})
	del := strSet(t, plan, "delete")
	for _, p := range []string{"node_modules", "node_modules/dep", "node_modules/dep/index.js"} {
		if del[p] {
			t.Errorf("%q was scheduled for deletion despite the skip list", p)
		}
	}
	if !del["stale.txt"] {
		t.Errorf("unskipped stale files must still be deleted, delete=%v", del)
	}
	// A skip is the user's own choice, not the box's rule — it must not be
	// reported as something the box preserved.
	if numField(plan, "preserved_count") != 0 {
		t.Errorf("skip must not count as preserved, got %v", plan["preserved_count"])
	}

	planID, _ := plan["plan_id"].(string)
	code, resp := srv.postTar(t, "/api/push/apply?plan_id="+planID, writeTar(t, nil, "s"), "s")
	if code != 200 {
		t.Fatalf("apply: status %d body=%v", code, resp)
	}
	if _, err := os.Stat(kept); err != nil {
		t.Errorf("skipped path was deleted: %v", err)
	}
	if _, err := os.Stat(doomed); !os.IsNotExist(err) {
		t.Errorf("stale.txt should be gone (err=%v)", err)
	}
}

// Same recursive-parent hazard as deny: the project directory holding a skipped
// node_modules must not be removed out from under it.
func TestPushSkipBlocksRecursiveParentDelete(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(filepath.Join(target, "app", "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	kept := filepath.Join(target, "app", "node_modules", "dep.js")
	if err := os.WriteFile(kept, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":     "workspace/proj",
		"target":  target,
		"skip":    []string{"node_modules/"},
		"entries": []map[string]any{},
	})
	if strSet(t, plan, "delete")["app"] {
		t.Error("a directory holding a skipped path must not be scheduled for deletion")
	}

	planID, _ := plan["plan_id"].(string)
	code, resp := srv.postTar(t, "/api/push/apply?plan_id="+planID, writeTar(t, nil, "s"), "s")
	if code != 200 {
		t.Fatalf("apply: status %d body=%v", code, resp)
	}
	if _, err := os.Stat(kept); err != nil {
		t.Errorf("skipped path went out with its parent: %v", err)
	}
}

// skip filters the box's walk only. It must never suppress an upload the client
// did ask for — the client already pruned its own side.
func TestPushSkipDoesNotFilterManifest(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":    "workspace/proj",
		"target": target,
		"skip":   []string{"*.log"},
		"entries": []map[string]any{
			{"path": "keep.log", "type": "file", "size": 1, "mtime_ns": 1, "mode": 0o644},
		},
	})
	if !strSet(t, plan, "add")["keep.log"] {
		t.Errorf("skip must not filter the client manifest, add=%v", plan["add"])
	}
}

func TestPushSkipRejectsBadInput(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	huge := make([]string, 1001)
	for i := range huge {
		huge[i] = "*.tmp"
	}
	for name, skip := range map[string]any{
		"not strings": []any{1, 2},
		"too many":    huge,
	} {
		code, _ := srv.postJSONRaw(t, "/api/push/plan", map[string]any{
			"rel": "workspace/proj", "target": target, "skip": skip, "entries": []map[string]any{},
		})
		if code != 400 {
			t.Errorf("%s: status %d, want 400", name, code)
		}
	}
}

// Skip patterns are $HOME-relative, matching the box's own rules. An anchored one
// therefore names the same path regardless of which directory the push ran from —
// necessary because ~/.aboxignore is a single file shared by every push.
func TestPushSkipAnchoredToHome(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(filepath.Join(target, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	kept := filepath.Join(target, "dist", "bundle.js")
	if err := os.WriteFile(kept, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// $HOME-relative: names this dist because the push root is workspace/proj.
	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":     "workspace/proj",
		"target":  target,
		"skip":    []string{"/workspace/proj/dist"},
		"entries": []map[string]any{},
	})
	if strSet(t, plan, "delete")["dist"] {
		t.Errorf("an anchored skip should protect dist from deletion, delete=%v", plan["delete"])
	}

	// A push-root-relative reading of the same pattern would be "dist" and would
	// fire here too; anchoring to $HOME means it does not.
	plan = srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":     "workspace/proj",
		"target":  target,
		"skip":    []string{"/dist"},
		"entries": []map[string]any{},
	})
	if !strSet(t, plan, "delete")["dist"] {
		t.Errorf("/dist names ~/dist, not this one — it must not fire, delete=%v", plan["delete"])
	}
}
