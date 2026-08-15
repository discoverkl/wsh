package wsh_test

import (
	"archive/tar"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// pull is push's diff read the other way round, off the same walk: what push
// calls an `update` is a file a pull wants the box's copy of, and what push
// calls a `leftover` is a file the client has never seen.
//
// What is NOT shared is trust. A push sends bytes into a box; a pull writes
// box-controlled bytes into a home directory holding ~/.ssh/authorized_keys and
// the shell rc files. The client does the load-bearing validation (pull.go), but
// this end must not offer anything it would be wrong to send.

// pullPlan posts a manifest and returns the plan.
func pullPlan(t *testing.T, s *server, rel, target string, entries []map[string]any) map[string]any {
	t.Helper()
	if entries == nil {
		entries = []map[string]any{}
	}
	code, plan := s.postNdjson(t, "/api/pull/plan2",
		map[string]any{"rel": rel, "target": target}, entries)
	if code != 200 {
		t.Fatalf("pull plan: status %d, body=%v", code, plan)
	}
	return plan
}

// pullFetch downloads a plan and returns the tar entries by name, plus the
// sentinel header.
func pullFetch(t *testing.T, s *server, planID string, from int) (map[string]string, string) {
	t.Helper()
	url := s.url("/api/pull/fetch?plan_id=" + planID)
	if from > 0 {
		url += "&from=" + itoa(from)
	}
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET fetch: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("fetch: status %d", resp.StatusCode)
	}
	out := map[string]string{}
	tr := tar.NewReader(resp.Body)
	for {
		hdr, terr := tr.Next()
		if terr == io.EOF {
			break
		}
		if terr != nil {
			t.Fatalf("read tar: %v", terr)
		}
		body, _ := io.ReadAll(tr)
		out[hdr.Name] = string(body)
	}
	return out, resp.Header.Get("X-Abox-Pull-Sentinel")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// The headline case: a directory this machine has never seen.
func TestPullFetchesWhatTheClientLacks(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/only-on-box"
	dir := filepath.Join(home, rel)
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("alpha"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sub", "b.txt"), []byte("bravo"), 0o644); err != nil {
		t.Fatal(err)
	}

	plan := pullPlan(t, srv, rel, dir, nil)
	if got := numField(plan, "fetch_count"); got != 3 {
		t.Errorf("fetch_count = %v, want 3 (a.txt, sub, sub/b.txt) — plan=%v", got, plan)
	}

	planID, _ := plan["plan_id"].(string)
	entries, sentinel := pullFetch(t, srv, planID, 0)
	if sentinel == "" {
		t.Fatal("no sentinel header — a download whose completion cannot be proven")
	}
	if entries[".abox-pull-sentinel"] != sentinel {
		t.Errorf("sentinel entry %q does not match the header %q", entries[".abox-pull-sentinel"], sentinel)
	}
	if entries["a.txt"] != "alpha" || entries["sub/b.txt"] != "bravo" {
		t.Errorf("wrong contents: %v", entries)
	}
}

// Directories are sent before the files inside them, so a client extracting in
// stream order always has the parent of whatever it is about to write.
func TestPullSendsParentsFirst(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/order"
	if err := os.MkdirAll(filepath.Join(home, rel, "deep", "deeper"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, rel, "deep", "deeper", "x.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	plan := pullPlan(t, srv, rel, filepath.Join(home, rel), nil)
	fetch, _ := plan["fetch"].([]any)
	seenFile := false
	for _, e := range fetch {
		m := e.(map[string]any)
		if m["type"] == "file" {
			seenFile = true
		} else if m["type"] == "dir" && seenFile {
			t.Errorf("a directory arrives after a file — extraction order is not safe: %v", fetch)
		}
	}
}

// A client that already matches the box fetches nothing, however large the box
// is. The plan is the delta, not the tree.
func TestPullFetchesNothingWhenInStep(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/same"
	dir := filepath.Join(home, rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte("identical")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(dir, "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	plan := pullPlan(t, srv, rel, dir, []map[string]any{
		{"path": "a.txt", "type": "file", "size": len(body), "mtime_ns": st.ModTime().UnixNano(), "mode": 0o644},
	})
	if got := numField(plan, "fetch_count"); got != 0 {
		t.Errorf("fetch_count = %v, want 0 — the two sides already match", got)
	}
}

// A file the client has and the box does not is reported, never removed: the
// box is not the authority on what belongs on someone's laptop.
func TestPullReportsLocalOnlyFilesAndNeverRemovesThem(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/mine"
	dir := filepath.Join(home, rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	plan := pullPlan(t, srv, rel, dir, []map[string]any{
		{"path": "local.txt", "type": "file", "size": 3, "mtime_ns": time.Now().UnixNano(), "mode": 0o644},
	})
	if got := numField(plan, "local_only_count"); got != 1 {
		t.Errorf("local_only_count = %v, want 1", got)
	}
	if got := numField(plan, "fetch_count"); got != 0 {
		t.Errorf("fetch_count = %v, want 0 — there is nothing on the box to send", got)
	}
}

// The box's deny rules apply in this direction too. They exist to keep
// env-bound config and box-local state from travelling; a pull that ignored
// them would carry the box's identity onto a laptop.
func TestPullNeverSendsDeniedPaths(t *testing.T) {
	srv, home := setupPush(t)
	// The record store is denied by wsh itself, whatever the image ships —
	// under its current name and under the one it had before `pull` existed,
	// since a box that synced back then still holds the old directory.
	// Both halves of the protocol's own bookkeeping: the box's under ~/.wsh,
	// and the client's under ~/.abox. push-state is the record store's old name,
	// still denied because a box that synced before the rename still holds it.
	denied := []string{".wsh/sync-state/", ".wsh/push-state/", ".wsh/trash/", ".abox/trash/"}
	for _, dir := range denied {
		if err := os.MkdirAll(filepath.Join(home, filepath.FromSlash(dir)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(home, filepath.FromSlash(dir), "abcd"), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// A file rather than a directory, and the sharpest of the lot: carry it and
	// the far end becomes a second machine claiming this one's replica id.
	if err := os.WriteFile(filepath.Join(home, ".abox", "replica"), []byte("0123456789abcdef0123456789abcdef"), 0o600); err != nil {
		t.Fatal(err)
	}
	denied = append(denied, ".abox/replica")
	if err := os.WriteFile(filepath.Join(home, "ok.txt"), []byte("fine"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, plan := srv.postNdjson(t, "/api/pull/plan2",
		map[string]any{"rel": ".", "target": home, "home": true}, []map[string]any{})
	if code != 200 {
		t.Fatalf("pull plan: status %d, body=%v", code, plan)
	}
	for _, e := range plan["fetch"].([]any) {
		p := e.(map[string]any)["path"].(string)
		for _, dir := range denied {
			if p == strings.TrimSuffix(dir, "/") || strings.HasPrefix(p, dir) {
				t.Errorf("a pull would carry the protocol's own bookkeeping: %s", p)
			}
		}
	}
}

// A resumed fetch picks up at an entry boundary rather than restarting.
func TestPullResumesFromAnIndex(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/resume"
	dir := filepath.Join(home, rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"a.txt", "b.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte(n), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	plan := pullPlan(t, srv, rel, dir, nil)
	planID, _ := plan["plan_id"].(string)

	all, _ := pullFetch(t, srv, planID, 0)
	if len(all) != 4 { // three files plus the sentinel
		t.Fatalf("first fetch carried %d entries, want 4: %v", len(all), all)
	}
	rest, _ := pullFetch(t, srv, planID, 2)
	if len(rest) != 2 { // one file plus the sentinel
		t.Errorf("resume from 2 carried %d entries, want 2: %v", len(rest), rest)
	}
	if _, ok := rest["c.txt"]; !ok {
		t.Errorf("resume should carry the tail: %v", rest)
	}
}

// A pull changes nothing on the box — no deletes, no staging sweep, no trash.
func TestPullChangesNothingOnTheBox(t *testing.T) {
	srv, home := setupPush(t)
	rel := "workspace/readonly"
	dir := filepath.Join(home, rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep.txt"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A manifest naming a file the box does not have: to a push this is an add,
	// and its leftovers would be a delete list. A pull must act on neither.
	pullPlan(t, srv, rel, dir, []map[string]any{
		{"path": "ghost.txt", "type": "file", "size": 1, "mtime_ns": time.Now().UnixNano(), "mode": 0o644},
	})
	if _, err := os.Stat(filepath.Join(dir, "keep.txt")); err != nil {
		t.Errorf("a pull plan removed a box-side file: %v", err)
	}
	if b := trashBatches(t, home); len(b) != 0 {
		t.Errorf("a pull created trash on the box: %v", b)
	}
}

// Pulling a file this machine does not have — the headline case, and the one
// that could not work.
//
// Two box-side assumptions were built for a single-file PUSH, where a manifest
// of exactly one entry is guaranteed: the plan threw unless it got one, and it
// forced `leftover` empty because a push's leftovers in file mode are every
// sibling of the file. For a pull both are backwards. The manifest is empty
// precisely because the client has nothing, and that single leftover IS what
// the pull carries.
func TestPullFileTheClientDoesNotHave(t *testing.T) {
	srv, home := setupPush(t)
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte("export X=1"), 0o644); err != nil {
		t.Fatal(err)
	}

	// rel is $HOME, file is the one name under it, manifest empty.
	code, plan := srv.postNdjson(t, "/api/pull/plan2",
		map[string]any{"rel": ".", "target": home, "home": true, "file": ".zshrc"},
		[]map[string]any{})
	if code != 200 {
		t.Fatalf("pull plan: status %d, body=%v", code, plan)
	}
	if got := numField(plan, "fetch_count"); got != 1 {
		t.Fatalf("fetch_count = %v, want 1 — the file the client lacks is the payload (plan=%v)", got, plan)
	}

	planID, _ := plan["plan_id"].(string)
	entries, sentinel := pullFetch(t, srv, planID, 0)
	if entries[".zshrc"] != "export X=1" {
		t.Errorf("the file did not come down: %v", entries)
	}
	if sentinel == "" || entries[".abox-pull-sentinel"] != sentinel {
		t.Error("the sentinel must still prove the download completed")
	}
}

// And a client that already has it fetches nothing — the same mode, the other
// answer, so the exemption above cannot have broken the ordinary case.
func TestPullFileTheClientAlreadyHas(t *testing.T) {
	srv, home := setupPush(t)
	body := []byte("export X=1")
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(home, ".zshrc"))
	if err != nil {
		t.Fatal(err)
	}
	code, plan := srv.postNdjson(t, "/api/pull/plan2",
		map[string]any{"rel": ".", "target": home, "home": true, "file": ".zshrc"},
		[]map[string]any{
			{"path": ".zshrc", "type": "file", "size": len(body), "mtime_ns": st.ModTime().UnixNano(), "mode": 0o644},
		})
	if code != 200 {
		t.Fatalf("pull plan: status %d, body=%v", code, plan)
	}
	if got := numField(plan, "fetch_count"); got != 0 {
		t.Errorf("fetch_count = %v, want 0 — the two sides already match", got)
	}
}

// The check reports what the box holds, so a client with nothing locally can
// resolve in one step rather than planning twice.
func TestSyncCheckReportsTargetType(t *testing.T) {
	srv, home := setupPush(t)
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, "workspace", "101"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ rel, want string }{
		{".zshrc", "file"},
		{"workspace/101", "dir"},
		{"workspace/nope", "missing"},
	} {
		got, _ := syncCheck(t, srv, syncRoot(tc.rel, syncFakeHash("a")))["target_type"].(string)
		if got != tc.want {
			t.Errorf("target_type for %s = %q, want %q", tc.rel, got, tc.want)
		}
	}
}
