package wsh_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The box's half of the shared fixture.
//
// "Scan a command for one ~/workspace/<name>" is implemented twice, because
// resolution belongs to the side that owns the entity: abox-cli for a push,
// /api/sync/entity for a pull. Two implementations of one rule drift silently,
// and they did — abox matched only a literal expanded $HOME/workspace/, so
// `cd ~/workspace/101 && ./run` resolved to nothing on push and to 101 here.
//
// Both suites now read the same file. If they diverge again, one goes red.
const commandProjectFixture = "../../abox/cmd/abox-cli/testdata/command-projects.json"

type cpCase struct {
	Command string  `json:"command"`
	Want    *string `json:"want"`
	Refuse  bool    `json:"refuse"`
}

// cpCard is one card as somebody writes one: the three fields that can name a
// project, and the one project the whole rule must arrive at.
type cpCard struct {
	Why     string  `json:"why"`
	Cwd     string  `json:"cwd"`
	Command string  `json:"command"`
	Project string  `json:"project"`
	Want    *string `json:"want"`
	Refuse  bool    `json:"refuse"`
}

func TestSyncEntityMatchesTheSharedFixture(t *testing.T) {
	raw, err := os.ReadFile(commandProjectFixture)
	if err != nil {
		// Skipping is right when the abox repo simply is not checked out beside
		// this one — CI may build wsh alone. It is NOT right when the repo is
		// there and the fixture has moved or been deleted, which is exactly how
		// a shared fixture stops being shared without anyone noticing.
		if _, serr := os.Stat(filepath.Dir(filepath.Dir(filepath.Dir(commandProjectFixture)))); serr == nil {
			t.Fatalf("the abox repo is here but the shared fixture is not (%v) — "+
				"if it moved, update commandProjectFixture; the two resolvers drift the moment nothing compares them", err)
		}
		t.Skipf("abox not checked out beside this repo — shared fixture unavailable (%v)", err)
	}
	var f struct {
		Home  string   `json:"home"`
		Cases []cpCase `json:"cases"`
		Cards []cpCard `json:"cards"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}

	srv, home := setupPush(t)
	wsh := filepath.Join(home, ".wsh")
	if err := os.MkdirAll(wsh, 0o755); err != nil {
		t.Fatal(err)
	}

	for i, tc := range f.Cases {
		// The fixture is written against the box's own $HOME (/root); this test
		// box lives in a tempdir, so the expanded spelling is substituted. The
		// other three — ~, $HOME, /root — are literal and must match as written.
		cmd := strings.ReplaceAll(tc.Command, f.Home+"/workspace/", home+"/workspace/")

		card, err := json.Marshal(map[string]any{"probe": map[string]any{"command": cmd}})
		if err != nil {
			t.Fatal(err)
		}
		// JSON is valid YAML, which sidesteps quoting a shell line by hand.
		if err := os.WriteFile(filepath.Join(wsh, "apps.yaml"), card, 0o644); err != nil {
			t.Fatal(err)
		}

		code, body := srv.getJSONRaw(t, "/api/sync/entity?name=probe")
		if tc.Refuse {
			if code != 409 {
				t.Errorf("case %d %q: status %d, want 409 — it names more than one project", i, tc.Command, code)
			}
			continue
		}
		if code != 200 {
			t.Errorf("case %d %q: status %d, want 200 (%v)", i, tc.Command, code, body)
			continue
		}
		roots, _ := body["roots"].([]any)
		if tc.Want == nil {
			if len(roots) != 0 {
				t.Errorf("case %d %q: resolved %v, want none", i, tc.Command, roots)
			}
			continue
		}
		want := "workspace/" + *tc.Want
		if len(roots) != 1 || roots[0] != want {
			t.Errorf("case %d %q: resolved %v, want [%s]", i, tc.Command, roots, want)
		}
	}

	// And the whole rule over a whole card: which field is read, and in what
	// order. The scan above is one string in and names out; this is the part
	// that says `project` beats `cwd` beats `command` — the half a user
	// experiences, and the half that used to differ from the push side for the
	// most ordinary card there is, a cwd in the workspace with a command
	// relative to it.
	if len(f.Cards) == 0 {
		t.Fatal("the shared fixture has no card cases — it grew a `cards` array; if it lost one, the two resolvers are unheld again")
	}
	for _, tc := range f.Cards {
		entry := map[string]any{}
		for k, v := range map[string]string{
			"cwd":     strings.ReplaceAll(tc.Cwd, f.Home+"/workspace/", home+"/workspace/"),
			"command": strings.ReplaceAll(tc.Command, f.Home+"/workspace/", home+"/workspace/"),
			"project": tc.Project,
		} {
			// Only the fields the card was written with: a case about a card
			// with no cwd is a card with no cwd, not one holding "".
			if v != "" {
				entry[k] = v
			}
		}
		card, err := json.Marshal(map[string]any{"probe": entry})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(wsh, "apps.yaml"), card, 0o644); err != nil {
			t.Fatal(err)
		}

		code, body := srv.getJSONRaw(t, "/api/sync/entity?name=probe")
		if tc.Refuse {
			if code != 409 {
				t.Errorf("%s: status %d, want 409", tc.Why, code)
			}
			continue
		}
		if code != 200 {
			t.Errorf("%s: status %d, want 200 (%v)", tc.Why, code, body)
			continue
		}
		roots, _ := body["roots"].([]any)
		if tc.Want == nil {
			if len(roots) != 0 {
				t.Errorf("%s: resolved %v, want none", tc.Why, roots)
			}
			continue
		}
		want := "workspace/" + *tc.Want
		if len(roots) != 1 || roots[0] != want {
			t.Errorf("%s: resolved %v, want [%s]", tc.Why, roots, want)
		}
	}
}

// getJSONRaw is getJSON with the status code, for endpoints whose refusal is
// the thing under test.
func (s *server) getJSONRaw(t *testing.T, path string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Get(s.url(path))
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}
