package wsh_test

// ┌───────────────────────────────────────┬───────────────────────────────────────────────────┐
// │ Test                                  │ Description                                       │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestPublicCLIPrecheck                 │ POST /api/cli refuses before it creates anything   │
// │  ├ missing                            │ no ~/cli → cli_missing                            │
// │  ├ directory                          │ ~/cli is a directory → cli_not_a_file             │
// │  ├ not executable                     │ ~/cli without the x bit → cli_not_executable      │
// │  ├ no shebang is fine                 │ `printenv` + x bit is a working CLI               │
// │  ├ runnable                           │ good ~/cli → the wrapper decides (see below)      │
// │  └ rechecked per request              │ ~/cli deleted mid-life → cli_missing again        │
// │ TestPublicCLIBadArgs                  │ argv bounds are the caller's own fault            │
// │ TestOnlyTheCLIRouteMakesCLISessions   │ nothing in the box can mint one                   │
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

	t.Run("no shebang is fine", func(t *testing.T) {
		// A shebang is not required, and refusing one is a real bug we shipped:
		// a box owner whose /root/cli was the single line `printenv` got told the
		// service was unavailable.
		//
		// ~/cli is reached through the wrapper's `exec "$HOME/cli"`, which is
		// sh's builtin, and sh answers ENOEXEC by rerunning the file as a shell
		// script — the same reason `./cli` works at a prompt. Only the kernel
		// demands magic bytes, and the only file it is handed here is the
		// wrapper.
		writeCLI(t, cli, "echo hello\n", 0o755)
		defer os.Remove(cli)

		status, body := srv.postJSONRaw(t, "/api/cli", map[string]any{"args": []string{}})
		if code, _ := body["error"].(string); code == "cli_not_runnable" || code == "cli_not_a_file" {
			t.Fatalf("a shebang-less script was refused as unrunnable: %d %v", status, body)
		}
		// Where it lands past that is the wrapper's business, asserted below;
		// what matters here is that the file's first bytes did not decide it.
		assertWrapperVerdict(t, status, body)
	})

	t.Run("runnable", func(t *testing.T) {
		writeCLI(t, cli, "#!/bin/sh\nexit 0\n", 0o755)
		defer os.Remove(cli)

		status, body := srv.postJSONRaw(t, "/api/cli", map[string]any{"args": []string{}})
		assertWrapperVerdict(t, status, body)
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

// The four /api/cli/<sid>/… routes are unauthenticated, and cliOnly is the only
// thing standing between a stranger and every other session on the box. It
// admits a sid on one basis: that POST /api/cli created it.
//
// So "created it" has to be unforgeable from inside the box. It was not, for a
// while: the flag rode on AppConfig, which is the apps.yaml schema, and
// mergeApps() spreads parsed YAML into that type with no key whitelist. A
// `cli: true` in a box's own apps.yaml — or in a POST /api/sessions body —
// reached the same spawn, wrote the same marker, and handed that session's sid
// to the anonymous routes. Owner-caused rather than a hole, but it made the
// design's "nothing inside the box can repoint the public endpoint" true of the
// route and false of the flag.
//
// It is a parameter now, so only the route can pass it. This is the test that
// says so.
func TestOnlyTheCLIRouteMakesCLISessions(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// An app that asks to be a cli session, in the file a box owner controls.
	if err := os.MkdirAll(filepath.Join(home, ".wsh"), 0o755); err != nil {
		t.Fatalf("mkdir .wsh: %v", err)
	}
	apps := "sneaky:\n  command: sleep 30\n  type: job\n  cli: true\n  args: [\"--anything\"]\n"
	if err := os.WriteFile(filepath.Join(home, ".wsh", "apps.yaml"), []byte(apps), 0o644); err != nil {
		t.Fatalf("write apps.yaml: %v", err)
	}

	srv := startServer(t)

	for _, c := range []struct {
		what string
		body map[string]any
	}{
		{"via apps.yaml", map[string]any{"app": "sneaky"}},
		{"via the request body", map[string]any{
			"type": "job", "command": "sleep 30", "cli": true, "args": []string{"--anything"},
		}},
	} {
		t.Run(c.what, func(t *testing.T) {
			status, body := srv.postJSONRaw(t, "/api/sessions", c.body)
			if status != 200 {
				t.Skipf("could not create the session to test with: %d %v", status, body)
			}
			id, _ := body["id"].(string)
			if id == "" {
				t.Fatalf("no session id: %v", body)
			}
			t.Cleanup(func() { srv.deleteJSONRaw(t, "/api/sessions/"+id) })

			// The marker is what answers after the child exits, so its absence
			// is the durable half of the claim.
			if _, err := os.Stat(filepath.Join(home, ".wsh", "logs", id+".cli")); err == nil {
				t.Errorf("a session created outside POST /api/cli wrote a .cli marker")
			}
			// And this is the half a stranger would actually use.
			code, _ := srv.deleteJSONRaw(t, "/api/cli/"+id)
			if code != 404 {
				t.Errorf("DELETE /api/cli/%s answered %d — an ordinary session is addressable anonymously", id, code)
			}
		})
	}
}

// assertWrapperVerdict checks the half of the outcome that CLI_WRAPPER decides,
// for a ~/cli that is already known to be fine.
//
// CLI_WRAPPER is /etc/wsh/cli-run, a fixed system path a test cannot create —
// the same limit apps_merge_test.go records for the system apps.yaml layer. So
// this asserts the rule rather than one outcome: a box that has the wrapper
// runs the CLI, and a machine that does not refuses with cli_wrapper_missing.
// Off a box that is the fail-closed path; inside one it is the happy path.
func assertWrapperVerdict(t *testing.T, status int, body map[string]any) {
	t.Helper()
	if wrapperInstalled() {
		if status != 200 {
			t.Fatalf("wrapper installed but POST /api/cli refused: %d %v", status, body)
		}
		if id, _ := body["id"].(string); len(id) != 6 {
			t.Fatalf("session id %q is not 6 characters", id)
		}
		return
	}
	// No wrapper: refused as the image's omission rather than the owner's. wsh
	// never spawns ~/cli unwrapped, which is the whole reason shipping wsh alone
	// cannot open a box to anonymous callers.
	if status != 500 {
		t.Fatalf("no wrapper: status %d, want 500 (%v)", status, body)
	}
	if code, _ := body["error"].(string); code != "cli_wrapper_missing" {
		t.Fatalf("no wrapper: got %q, want cli_wrapper_missing", code)
	}
}
