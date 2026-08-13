package wsh_test

// ┌───────────────────────────────────────┬───────────────────────────────────────────────────┐
// │ Test                                  │ Description                                       │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestAppsMerge                         │ POST /api/apps/<key> — the write half of push app  │
// │  └ creates an entry                   │ a new key lands and is live on the next /api/apps  │
// │  └ replaces, never field-merges       │ the pusher's definition is the truth for that key  │
// │  └ leaves other entries alone         │ the target box keeps its own cards                 │
// │  └ preserves comments                 │ a hand-written apps.yaml survives the write        │
// │  └ refuses reserved keys              │ _skills holds shared defaults, not an app          │
// │  └ refuses a traversing key           │ the key is one path segment, never a path          │
// │  └ refuses a bad key                  │ the key is a URL segment and a YAML key            │
// │  └ an empty mapping is legal          │ a useless app is still a well-formed one           │
// └───────────────────────────────────────┴───────────────────────────────────────────────────┘

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// appsYAMLAt reads the user layer back off disk — what the next loadApps() will
// see, which is the only thing that decides whether a pushed card exists.
func appsYAMLAt(t *testing.T, home string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(home, ".wsh", "apps.yaml"))
	if err != nil {
		t.Fatalf("read apps.yaml: %v", err)
	}
	return string(b)
}

func TestAppsMerge(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".wsh"), 0o755); err != nil {
		t.Fatalf("mkdir .wsh: %v", err)
	}
	// A file with a comment and a card the receiving box already had. Both are
	// what a push must leave untouched: it names one key.
	cfg := "" +
		"# my own notes about this box\n" +
		"theirs:\n" +
		"  command: sleep 100\n" +
		"  title: Theirs\n"
	if err := os.WriteFile(filepath.Join(home, ".wsh", "apps.yaml"), []byte(cfg), 0o644); err != nil {
		t.Fatalf("write apps.yaml: %v", err)
	}

	srv := startServer(t)

	t.Run("creates an entry", func(t *testing.T) {
		code, resp := srv.postJSONRaw(t, "/api/apps/mynotes", map[string]any{
			"command": "./serve --port $WSH_PORT",
			"type":    "web",
			"title":   "My Notes",
		})
		assertEqual(t, code, 200)
		assertEqual(t, resp["created"], true)

		// Live immediately: loadApps() reads the file on every request, so there
		// is nothing to reload and the card is in the catalog now.
		list := srv.getJSON(t, "/api/apps")
		found := false
		for _, a := range list["apps"].([]any) {
			app := a.(map[string]any)
			if app["key"] == "mynotes" {
				found = true
				assertEqual(t, app["type"], "web")
				assertEqual(t, app["title"], "My Notes")
			}
		}
		if !found {
			t.Fatal("merged app is not in /api/apps")
		}
	})

	t.Run("leaves other entries alone", func(t *testing.T) {
		if s := appsYAMLAt(t, home); !strings.Contains(s, "theirs:") || !strings.Contains(s, "Theirs") {
			t.Errorf("the box's own card did not survive the merge:\n%s", s)
		}
	})

	t.Run("preserves comments", func(t *testing.T) {
		// The six toggles round-trip this file through plain objects and drop
		// every comment. A push must not: it promises to touch one entry.
		if s := appsYAMLAt(t, home); !strings.Contains(s, "# my own notes about this box") {
			t.Errorf("comment was lost:\n%s", s)
		}
	})

	t.Run("replaces, never field-merges", func(t *testing.T) {
		code, resp := srv.postJSONRaw(t, "/api/apps/mynotes", map[string]any{
			"command": "./serve2",
			"type":    "web",
		})
		assertEqual(t, code, 200)
		assertEqual(t, resp["created"], false)
		// `title` is gone rather than surviving from the previous definition —
		// a hybrid of two boxes' configs is a state neither box has.
		s := appsYAMLAt(t, home)
		if strings.Contains(s, "My Notes") {
			t.Errorf("stale field survived a replace:\n%s", s)
		}
		if !strings.Contains(s, "./serve2") {
			t.Errorf("new definition did not land:\n%s", s)
		}
	})

	t.Run("refuses reserved keys", func(t *testing.T) {
		code, _ := srv.postJSONRaw(t, "/api/apps/_skills", map[string]any{"agent": "codex"})
		assertEqual(t, code, 400)
	})

	t.Run("refuses a traversing key", func(t *testing.T) {
		code, _ := srv.postJSONRaw(t, "/api/apps/mynotes/../evil", map[string]any{"command": "x"})
		if code == 200 {
			t.Error("a traversing key was accepted")
		}
	})

	t.Run("refuses a bad key", func(t *testing.T) {
		code, _ := srv.postJSONRaw(t, "/api/apps/not%20a%20key", map[string]any{"command": "x"})
		assertEqual(t, code, 400)
	})

	t.Run("an empty mapping is a legal app", func(t *testing.T) {
		code, _ := srv.postJSONRaw(t, "/api/apps/empty", map[string]any{})
		assertEqual(t, code, 200)
	})

	// The system-layer refusal (a key /etc/wsh already defines) is not covered
	// here: SYSTEM_CONFIG_DIR is a fixed path, and a test that wrote to /etc/wsh
	// would need root and would edit the machine running it. abox-cli refuses
	// those keys independently before sending, which is where the case is
	// tested — see TestPushEntityResolutionErrors.
}
