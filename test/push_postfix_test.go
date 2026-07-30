package wsh_test

import (
	"archive/tar"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The post-push hook is an image-owned script wsh runs once a push has finished
// writing. wsh knows nothing about what a repair is — it runs the script, feeds
// it the written paths, and passes its output back — so these tests pin the
// contract rather than any particular repair.

// writeHook installs a fake hook and points the server at it. Must run before
// startServer: the path is read from the environment at module load.
func setupPushHook(t *testing.T, script string) (*server, string) {
	t.Helper()
	home := t.TempDir()
	hook := filepath.Join(t.TempDir(), "abox-push-postfix")
	if err := os.WriteFile(hook, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("ABOX_PUSH_POSTFIX_HOOK", hook)
	return startServer(t), home
}

// pushOneFile plans and applies a single-file push, returning the apply response.
// `rel` of "." means a whole-box push (target is $HOME), which is the only shape
// the hook runs for; anything else exercises the subdirectory path.
func pushOneFile(t *testing.T, srv *server, target, rel, name, body string) map[string]any {
	t.Helper()
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":    rel,
		"target": target,
		"home":   rel == ".",
		"entries": []map[string]any{
			{"path": name, "type": "file", "size": len(body), "mtime_ns": time.Now().UnixNano(), "mode": 0o644},
		},
	})
	planID, _ := plan["plan_id"].(string)
	sentinel := "hook-test"
	tarBuf := writeTar(t, []tarFile{
		{name: name, mode: 0o644, body: []byte(body), typ: tar.TypeReg, mtime: time.Now()},
	}, sentinel)
	code, resp := srv.postTar(t, "/api/push/apply?plan_id="+planID, tarBuf, sentinel)
	if code != 200 {
		t.Fatalf("apply: status %d body=%v", code, resp)
	}
	return resp
}

// The hook's stdout comes back to the client verbatim — that is how a repair
// reports itself without wsh needing to know what a repair is.
func TestPushPostfixOutputIsPassedThrough(t *testing.T) {
	srv, home := setupPushHook(t, "#!/bin/sh\necho 'fixed one thing'\necho 'and another'\nexit 0\n")
	resp := pushOneFile(t, srv, home, ".", "app.txt", "hi")

	pf, ok := resp["postfix"].(map[string]any)
	if !ok {
		t.Fatalf("expected a postfix result, got %v", resp["postfix"])
	}
	if numField(pf, "code") != 0 {
		t.Errorf("code: got %v, want 0", pf["code"])
	}
	out, _ := pf["output"].(string)
	if out != "fixed one thing\nand another" {
		t.Errorf("output: got %q, want both lines verbatim", out)
	}
}

// The hook gets no stdin. It used to receive the list of written paths so it
// could skip files the push had not touched — a false economy, since its repairs
// are idempotent, and a way to stay broken, since a box that missed a repair once
// would never be re-sent the unchanged file. A hook that reads stdin must see
// EOF immediately rather than hang until wsh's timeout kills it.
func TestPushPostfixHasNoStdin(t *testing.T) {
	srv, home := setupPushHook(t, "#!/bin/sh\nn=$(cat | wc -l | tr -d '[:space:]')\necho \"stdin lines: $n\"\nexit 0\n")
	resp := pushOneFile(t, srv, home, ".", "app.txt", "hi")

	pf, ok := resp["postfix"].(map[string]any)
	if !ok {
		t.Fatalf("expected a postfix result, got %v", resp["postfix"])
	}
	if numField(pf, "code") != 0 {
		t.Fatalf("hook should exit cleanly, got %v", pf)
	}
	if out, _ := pf["output"].(string); !strings.Contains(out, "stdin lines: 0") {
		t.Errorf("hook should see empty stdin, got %q", out)
	}
}

// Context the hook needs to decide what to do, without re-deriving it.
func TestPushPostfixEnvironment(t *testing.T) {
	srv, home := setupPushHook(t,
		"#!/bin/sh\necho \"rel=$ABOX_PUSH_REL added=$ABOX_PUSH_ADDED updated=$ABOX_PUSH_UPDATED deleted=$ABOX_PUSH_DELETED\"\nexit 0\n")
	resp := pushOneFile(t, srv, home, ".", "app.txt", "hi")

	pf, _ := resp["postfix"].(map[string]any)
	out, _ := pf["output"].(string)
	// The delete count is whatever this whole-box push swept out of the temp
	// $HOME, so assert it agrees with the apply response rather than pinning a
	// number — the contract is that the hook is told the truth, not a constant.
	want := fmt.Sprintf("rel=. added=1 updated=0 deleted=%d", numField(resp, "deleted"))
	if out != want {
		t.Errorf("output: got %q, want %q", out, want)
	}
}

// A failing hook is reported but must not fail the push — the files have
// already landed and there is nothing to roll back.
func TestPushPostfixFailureDoesNotFailPush(t *testing.T) {
	srv, home := setupPushHook(t, "#!/bin/sh\necho 'something broke' >&2\nexit 3\n")
	resp := pushOneFile(t, srv, home, ".", "app.txt", "hi")

	pf, ok := resp["postfix"].(map[string]any)
	if !ok {
		t.Fatalf("expected a postfix result, got %v", resp["postfix"])
	}
	if numField(pf, "code") != 3 {
		t.Errorf("code: got %v, want 3", pf["code"])
	}
	if out, _ := pf["output"].(string); !strings.Contains(out, "something broke") {
		t.Errorf("stderr should be captured, got %q", out)
	}
	// The push itself succeeded and the file is on disk.
	if numField(resp, "files_written") != 1 {
		t.Errorf("files_written: got %v, want 1", resp["files_written"])
	}
	if b, err := os.ReadFile(filepath.Join(home, "app.txt")); err != nil || string(b) != "hi" {
		t.Errorf("pushed file should be intact: %q (err=%v)", b, err)
	}
}

// No hook installed is the normal case for an older image; push behaves exactly
// as it did before the hook existed.
func TestPushPostfixAbsentIsInert(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ABOX_PUSH_POSTFIX_HOOK", filepath.Join(home, "no-such-hook"))
	srv := startServer(t)

	resp := pushOneFile(t, srv, home, ".", "app.txt", "hi")
	if _, present := resp["postfix"]; present {
		t.Errorf("no hook should mean no postfix field, got %v", resp["postfix"])
	}
	if numField(resp, "files_written") != 1 {
		t.Errorf("files_written: got %v, want 1", resp["files_written"])
	}
}

// A non-executable file at the hook path is treated as no hook, not as an error.
func TestPushPostfixNonExecutableIsInert(t *testing.T) {
	home := t.TempDir()
	hook := filepath.Join(t.TempDir(), "abox-push-postfix")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nexit 0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("ABOX_PUSH_POSTFIX_HOOK", hook)
	srv := startServer(t)

	resp := pushOneFile(t, srv, home, ".", "app.txt", "hi")
	if _, present := resp["postfix"]; present {
		t.Errorf("a non-executable hook should be skipped, got %v", resp["postfix"])
	}
}

// The real shipped script, driven through a real push: an office-flavoured
// traecli.yaml landing on a prod box comes out pointing at prod endpoints, with
// everything else in the file untouched.
func TestPushPostfixShippedScriptNormalizesEndpoints(t *testing.T) {
	script, err := os.ReadFile(filepath.Join("..", "..", "abox", "img", "shared", "bin", "abox-push-postfix"))
	if err != nil {
		t.Skipf("shipped hook not available: %v", err)
	}
	home := t.TempDir()
	hookDir := t.TempDir()
	hook := filepath.Join(hookDir, "abox-push-postfix")
	// Redirect the variant probe at a file we control; everything else is the
	// script exactly as it ships.
	variantFile := filepath.Join(hookDir, "config_variant")
	if err := os.WriteFile(variantFile, []byte("prod\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	patched := strings.ReplaceAll(string(script), "/etc/abox/config_variant", variantFile)
	if err := os.WriteFile(hook, []byte(patched), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("ABOX_PUSH_POSTFIX_HOOK", hook)
	srv := startServer(t)

	const body = `models:
  - name: mine
    open_ai:
      api_key: SECRET-KEY-KEEP-ME
      base_url: https://api.internal.example/api/modelhub/online
`
	resp := pushOneFile(t, srv, home, ".", ".trae/traecli.yaml", body)

	pf, ok := resp["postfix"].(map[string]any)
	if !ok {
		t.Fatalf("expected a postfix result, got %v", resp["postfix"])
	}
	if numField(pf, "code") != 0 {
		t.Fatalf("hook failed: %v", pf)
	}
	if out, _ := pf["output"].(string); !strings.Contains(out, "normalized ~/.trae/traecli.yaml") {
		t.Errorf("hook should report what it fixed, got %q", out)
	}

	got, err := os.ReadFile(filepath.Join(home, ".trae", "traecli.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "api.internal.example") {
		t.Errorf("endpoint not normalized to prod:\n%s", got)
	}
	if strings.Contains(string(got), "internal.example") {
		t.Errorf("nonprod host survived:\n%s", got)
	}
	// The point of carrying the file instead of denying it: the user's own
	// content has to survive the trip.
	if !strings.Contains(string(got), "SECRET-KEY-KEEP-ME") || !strings.Contains(string(got), "name: mine") {
		t.Errorf("user content was lost:\n%s", got)
	}
}

// The gate. Replicating a box is what lands one box's env-bound config on
// another; a push of some subdirectory does not, and must not pay for the hook.
func TestPushPostfixSkippedForSubdirPush(t *testing.T) {
	srv, home := setupPushHook(t, "#!/bin/sh\necho ran\nexit 0\n")
	resp := pushOneFile(t, srv, filepath.Join(home, "workspace", "proj"), "workspace/proj", "app.txt", "hi")
	if _, present := resp["postfix"]; present {
		t.Errorf("hook must not run for a subdirectory push, got %v", resp["postfix"])
	}
	if numField(resp, "files_written") != 1 {
		t.Errorf("the push itself must be unaffected, files_written=%v", resp["files_written"])
	}
}

// A whole-box push has rel ".", so the $HOME-relative form of a manifest path
// is the path itself. Joining blindly would produce "./x" and match no anchored
// deny rule — silently disarming the rules on the one push shape they exist for.
func TestPushDenyOnWholeBoxPush(t *testing.T) {
	srv, home := setupPushDeny(t, "/.abox/active-tokens.json\n")
	if err := os.MkdirAll(filepath.Join(home, ".abox"), 0o755); err != nil {
		t.Fatal(err)
	}
	token := filepath.Join(home, ".abox", "active-tokens.json")
	if err := os.WriteFile(token, []byte("target-token"), 0o644); err != nil {
		t.Fatal(err)
	}
	plan := srv.postJSON(t, "/api/push/plan", map[string]any{
		"rel":    ".",
		"target": home,
		"home":   true,
		"entries": []map[string]any{
			{"path": ".abox/active-tokens.json", "type": "file", "size": 12, "mtime_ns": time.Now().UnixNano(), "mode": 0o600},
			{"path": "work.txt", "type": "file", "size": 2, "mtime_ns": time.Now().UnixNano(), "mode": 0o644},
		},
	})
	if strSet(t, plan, "add")[".abox/active-tokens.json"] {
		t.Error("deny must still apply when the push root is $HOME")
	}
	if !strSet(t, plan, "add")["work.txt"] {
		t.Errorf("ordinary files must still be pushed, add=%v", plan["add"])
	}
	if !strSet(t, plan, "preserved")[".abox/active-tokens.json"] {
		t.Errorf("preserved should name the path without a './' prefix, got %v", plan["preserved"])
	}
}

// $HOME is only reachable when the client says so, so a client that miscomputes
// `rel` still cannot slide into syncing over the whole home directory.
func TestPushWholeBoxRequiresExplicitFlag(t *testing.T) {
	srv, home := setupPush(t)
	for name, body := range map[string]map[string]any{
		"no home flag":            {"rel": ".", "target": home, "entries": []map[string]any{}},
		"home but subdir":         {"rel": "workspace", "target": home, "home": true, "entries": []map[string]any{}},
		"home flag, wrong target": {"rel": ".", "target": filepath.Join(home, "workspace"), "home": true, "entries": []map[string]any{}},
	} {
		code, _ := srv.postJSONRaw(t, "/api/push/plan", body)
		if code != 400 {
			t.Errorf("%s: status %d, want 400", name, code)
		}
	}
}
