package wsh_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// `--all` is a filtered directory sync, not a loop of one pull per project.
//
// One root — ~/workspace — with the projects no card names added to the skip
// list. Skip is two-way invisible, so an unreferenced project is neither
// fetched nor removed, which is the only reading of "every app" that does not
// turn a batch into a workspace-wide replace. The alternative, a root per app,
// is several commands wearing one name: each with its own record, its own plan
// and its own prompt.

func entityAllSetup(t *testing.T, apps map[string]any, projects []string) *server {
	t.Helper()
	srv, home := setupPush(t)
	wsh := filepath.Join(home, ".wsh")
	if err := os.MkdirAll(wsh, 0o755); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(apps) // JSON is valid YAML
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wsh, "apps.yaml"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, p := range projects {
		if err := os.MkdirAll(filepath.Join(home, "workspace", p), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return srv
}

func entityStrings(t *testing.T, body map[string]any, key string) []string {
	t.Helper()
	arr, _ := body[key].([]any)
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		s, _ := v.(string)
		out = append(out, s)
	}
	return out
}

func TestEntityAllIsOneFilteredRoot(t *testing.T) {
	srv := entityAllSetup(t, map[string]any{
		"_skills":   map[string]any{"agent": "claude"},
		"summarize": map[string]any{"skill": "summarize"},
		"notes":     map[string]any{"command": "python ~/workspace/one/app.py"},
		"linker":    map[string]any{"command": "wsh goto localhost:8080"},
	}, []string{"one", "two", "three"})

	code, body := srv.getJSONRaw(t, "/api/sync/entity?all=1&filtered=1")
	if code != 200 {
		t.Fatalf("status %d: %v", code, body)
	}
	if got := entityStrings(t, body, "roots"); !reflect.DeepEqual(got, []string{"workspace"}) {
		t.Errorf("roots = %v, want [workspace] — one root, filtered", got)
	}
	// Only the projects no card names. `one` is referenced, so it stays in.
	if got := entityStrings(t, body, "skip"); !reflect.DeepEqual(got, []string{"/workspace/three", "/workspace/two"}) {
		t.Errorf("skip = %v, want the two unreferenced projects", got)
	}
	// Reserved keys are shared defaults, and a skill card's body is not in
	// apps.yaml at all — so a sweep would land the card and not the skill.
	var keys []string
	for _, c := range body["cards"].([]any) {
		keys = append(keys, c.(map[string]any)["key"].(string))
	}
	if !reflect.DeepEqual(keys, []string{"linker", "notes"}) {
		t.Errorf("cards = %v, want the two ordinary apps", keys)
	}
}

// Naming one app is one project, or none — never the whole workspace, and never
// a filter.
func TestEntityNamedIsOneProject(t *testing.T) {
	srv := entityAllSetup(t, map[string]any{
		"notes": map[string]any{"command": "python ~/workspace/one/app.py"},
		"bare":  map[string]any{"command": "wsh goto localhost:8080"},
	}, []string{"one", "two"})

	code, body := srv.getJSONRaw(t, "/api/sync/entity?name=notes")
	if code != 200 {
		t.Fatalf("status %d: %v", code, body)
	}
	if got := entityStrings(t, body, "roots"); !reflect.DeepEqual(got, []string{"workspace/one"}) {
		t.Errorf("roots = %v, want [workspace/one]", got)
	}
	if got := entityStrings(t, body, "skip"); len(got) != 0 {
		t.Errorf("skip = %v, want none — a named app needs no filter", got)
	}

	// A command naming no project carries only the card, which is a fact about
	// the app rather than a failure.
	code, body = srv.getJSONRaw(t, "/api/sync/entity?name=bare")
	if code != 200 {
		t.Fatalf("status %d: %v", code, body)
	}
	if got := entityStrings(t, body, "roots"); len(got) != 0 {
		t.Errorf("roots = %v, want none", got)
	}
}

// No workspace at all is a box whose cards are pure config, not an error — and
// not a root that does not exist.
func TestEntityAllWithoutAWorkspace(t *testing.T) {
	srv := entityAllSetup(t, map[string]any{
		"linker": map[string]any{"command": "wsh goto localhost:8080"},
	}, nil)

	code, body := srv.getJSONRaw(t, "/api/sync/entity?all=1&filtered=1")
	if code != 200 {
		t.Fatalf("status %d: %v", code, body)
	}
	if got := entityStrings(t, body, "roots"); len(got) != 0 {
		t.Errorf("roots = %v, want none", got)
	}
	if got := entityStrings(t, body, "skip"); len(got) != 0 {
		t.Errorf("skip = %v, want none", got)
	}
}

// A client that predates the filtered sweep gets the shape it expects: one root
// per referenced project, and no skip list.
//
// The capability rides on the request because only the caller knows what it can
// read, and guessing wrong is destructive rather than merely wrong — an old
// client reads `roots: ["workspace"]` as "the whole workspace is the scope", and
// with --delete that prunes every local project the box does not have.
func TestEntityAllWithoutTheFilteredFlag(t *testing.T) {
	srv := entityAllSetup(t, map[string]any{
		"notes":  map[string]any{"command": "python ~/workspace/one/app.py"},
		"linker": map[string]any{"command": "wsh goto localhost:8080"},
	}, []string{"one", "two", "three"})

	code, body := srv.getJSONRaw(t, "/api/sync/entity?all=1")
	if code != 200 {
		t.Fatalf("status %d: %v", code, body)
	}
	if got := entityStrings(t, body, "roots"); !reflect.DeepEqual(got, []string{"workspace/one"}) {
		t.Errorf("roots = %v, want the referenced project alone", got)
	}
	if got := entityStrings(t, body, "skip"); len(got) != 0 {
		t.Errorf("skip = %v, want none — an old client would ignore it anyway", got)
	}
}
