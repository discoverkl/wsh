package wsh_test

// ┌───────────────────────────────────────┬───────────────────────────────────────────────────┐
// │ Test                                  │ Description                                       │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestPublicCLIPrecheck                 │ POST /api/cli refuses before it creates anything   │
// │  ├ missing                            │ no ~/cli → cli_missing                            │
// │  ├ directory                          │ ~/cli is a directory → cli_not_a_file             │
// │  ├ not executable                     │ ~/cli without the x bit → cli_not_executable      │
// │  ├ no shebang                         │ executable, no #! and no ELF → cli_not_runnable   │
// │  ├ runnable                           │ good ~/cli → the wrapper decides (see below)      │
// │  └ rechecked per request              │ ~/cli deleted mid-life → cli_missing again        │
// │ TestPublicCLIBadArgs                  │ argv bounds are the caller's own fault            │
// └───────────────────────────────────────┴───────────────────────────────────────────────────┘
//
// Covers the ladder in front of the one program an unauthenticated caller may
// run: each way ~/cli can fail to be a program, told apart because the box owner
// is who fixes them and each has a different fix.
//
// CLI_WRAPPER is /etc/wsh/cli-run — a fixed system path a test cannot create,
// the same limit apps_merge_test.go records for the system apps.yaml layer. So
// the "runnable" case asserts the rule rather than one outcome: with a good
// ~/cli, a box that has the wrapper runs it and a box that does not refuses with
// cli_wrapper_missing. Off a box that is the fail-closed path; run inside one it
// is the happy path, and the same assertion covers both.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// wrapperInstalled reports whether this machine has the image's environment
// policy hook. Only a box does.
func wrapperInstalled() bool {
	st, err := os.Stat("/etc/wsh/cli-run")
	return err == nil && st.Mode().IsRegular()
}

// cliRefusal posts an empty argv and returns wsh's `error` code, failing the
// test if the box accepted the request instead.
func cliRefusal(t *testing.T, srv *server) (int, string) {
	t.Helper()
	status, body := srv.postJSONRaw(t, "/api/cli", map[string]any{"args": []string{}})
	if status == 200 {
		t.Fatalf("POST /api/cli was accepted (session %v), want a refusal", body["id"])
	}
	code, _ := body["error"].(string)
	if code == "" {
		t.Fatalf("refusal carries no error code: %v", body)
	}
	return status, code
}

func TestPublicCLIPrecheck(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cli := filepath.Join(home, "cli")

	// One server for every case: the checks run per request, not at startup, so
	// rewriting ~/cli between subtests is exactly what a box owner does.
	srv := startServer(t)

	t.Run("missing", func(t *testing.T) {
		if _, code := cliRefusal(t, srv); code != "cli_missing" {
			t.Fatalf("no ~/cli: got %q, want cli_missing", code)
		}
	})

	t.Run("directory", func(t *testing.T) {
		// A directory passes access(X_OK), so only isFile() rules it out. Without
		// that check this would reach spawn() and fail as EACCES on attach.
		if err := os.Mkdir(cli, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		defer os.Remove(cli)
		if _, code := cliRefusal(t, srv); code != "cli_not_a_file" {
			t.Fatalf("directory: got %q, want cli_not_a_file", code)
		}
	})

	t.Run("not executable", func(t *testing.T) {
		writeCLI(t, cli, "#!/bin/sh\nexit 0\n", 0o644)
		defer os.Remove(cli)
		if _, code := cliRefusal(t, srv); code != "cli_not_executable" {
			t.Fatalf("mode 0644: got %q, want cli_not_executable", code)
		}
	})

	t.Run("no shebang", func(t *testing.T) {
		// The two-byte read earns its keep here. Behind the wrapper the kernel is
		// satisfied by /bin/sh, so without this check the request would succeed
		// and sh would report the failure into a stranger's output at exit 126.
		writeCLI(t, cli, "echo hello\n", 0o755)
		defer os.Remove(cli)
		if _, code := cliRefusal(t, srv); code != "cli_not_runnable" {
			t.Fatalf("no #!: got %q, want cli_not_runnable", code)
		}
	})

	t.Run("runnable", func(t *testing.T) {
		writeCLI(t, cli, "#!/bin/sh\nexit 0\n", 0o755)
		defer os.Remove(cli)

		status, body := srv.postJSONRaw(t, "/api/cli", map[string]any{"args": []string{}})
		if wrapperInstalled() {
			if status != 200 {
				t.Fatalf("wrapper installed but POST /api/cli refused: %d %v", status, body)
			}
			id, _ := body["id"].(string)
			if len(id) != 6 {
				t.Fatalf("session id %q is not 6 characters", id)
			}
			return
		}
		// No wrapper: refused, and refused as the image's omission rather than
		// the owner's. wsh never spawns ~/cli unwrapped, which is the whole
		// reason shipping wsh alone cannot open a box to anonymous callers.
		if status != 500 {
			t.Fatalf("no wrapper: status %d, want 500 (%v)", status, body)
		}
		if code, _ := body["error"].(string); code != "cli_wrapper_missing" {
			t.Fatalf("no wrapper: got %q, want cli_wrapper_missing", code)
		}
	})

	t.Run("rechecked per request", func(t *testing.T) {
		// Nothing is cached at startup, because an owner may install or rewrite
		// either file from ~/.abox/setup.sh long after wsh came up.
		if _, code := cliRefusal(t, srv); code != "cli_missing" {
			t.Fatalf("after removal: got %q, want cli_missing", code)
		}
	})
}

// bad_args is the one refusal on this endpoint aimed at the caller rather than
// at the box, so it is the one whose detail abox-cli prints back to them.
func TestPublicCLIBadArgs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeCLI(t, filepath.Join(home, "cli"), "#!/bin/sh\nexit 0\n", 0o755)

	srv := startServer(t)

	cases := []struct {
		what string
		args any
	}{
		{"not an array", "echo hi"},
		{"not strings", []any{1, 2}},
		{"too many", make([]string, 65)},
		{"too long", []string{strings.Repeat("x", 17*1024)}},
	}
	for _, c := range cases {
		t.Run(c.what, func(t *testing.T) {
			status, body := srv.postJSONRaw(t, "/api/cli", map[string]any{"args": c.args})
			if status != 400 {
				t.Fatalf("status %d, want 400 (%v)", status, body)
			}
			if code, _ := body["error"].(string); code != "bad_args" {
				t.Fatalf("error %q, want bad_args", code)
			}
			// The caller can act on this one, so it has to say what was wrong.
			if detail, _ := body["detail"].(string); detail == "" {
				t.Fatal("bad_args carries no detail")
			}
		})
	}
}

func writeCLI(t *testing.T, path, body string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), mode); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	// WriteFile honours the umask, and 0o755 through a 022 umask is still 0755
	// — but a stricter umask would silently turn this into the case above.
	if err := os.Chmod(path, mode); err != nil {
		t.Fatalf("chmod %s: %v", path, err)
	}
}
