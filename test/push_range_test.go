package wsh_test

import (
	"archive/tar"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// A file bigger than one chunk used to be indivisible: the chunker cuts between
// entries, never inside one, so a single 5 GB file became a single 5 GB request
// no matter what the chunk size said. That is what meets a proxy body limit as
// a 413, and it is why the limit only ever bit the pushes carrying the most.
//
// Ranged slices remove the special case. A slice is an ordinary tar entry with
// two extended-header records saying where in its file the body belongs; the
// box accumulates them into `<name>.abox-partial-<total>` and renames that over
// the destination when the last one lands. Everything below is about the three
// ways that can go wrong quietly — bytes at the wrong offset, a partial that
// leaks into the user's tree, and a resume that trusts bytes nobody verified.

const (
	rangeOffKey   = "ABOX.range.off"
	rangeTotalKey = "ABOX.range.total"
)

// slice builds one ranged tar entry for `name`.
func slice(name string, off, total int, body []byte, mtime time.Time) tarFile {
	return tarFile{
		name: name, typ: tar.TypeReg, mode: 0o644, body: body, mtime: mtime,
		pax: map[string]string{
			rangeOffKey:   strconv.Itoa(off),
			rangeTotalKey: strconv.Itoa(total),
		},
	}
}

// partialName mirrors the box's accumulator naming.
func partialName(base string, total int) string {
	return fmt.Sprintf("%s.abox-partial-%d", base, total)
}

// planRanged plans a single oversized file and returns the plan id.
func planRanged(t *testing.T, srv *server, rel, target, name string, size int, mtime time.Time) string {
	t.Helper()
	code, resp := planFor(t, srv, rel, target,
		[]map[string]any{entry(name, "file", size, mtime)}, nil)
	if code != 200 {
		t.Fatalf("plan: status %d, want 200: %v", code, resp)
	}
	id, _ := resp["plan_id"].(string)
	if id == "" {
		t.Fatalf("plan returned no plan_id: %v", resp)
	}
	return id
}

// The whole point: two slices, one file, byte-exact — and the destination only
// exists once the last slice has landed. A reader that sees the path at all has
// to see the finished file, which is the same promise an unranged push makes.
func TestPushRangeAssemblesWholeFile(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	first, second := []byte("hello "), []byte("world")
	total := len(first) + len(second)
	mtime := time.Now().Add(-time.Hour).Truncate(time.Second)
	planID := planRanged(t, srv, "workspace/proj", target, "big.bin", total, mtime)

	dst := filepath.Join(target, "big.bin")
	if code, resp := applyChunk(t, srv, planID, []tarFile{slice("big.bin", 0, total, first, mtime)}, false); code != 200 {
		t.Fatalf("first slice: status %d: %v", code, resp)
	}
	// Half a file must not be visible under the name the user will read.
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatalf("destination exists after one slice of two (err=%v)", err)
	}
	if got, err := os.Stat(partialName(dst, total)); err != nil {
		t.Fatalf("no accumulator after first slice: %v", err)
	} else if got.Size() != int64(len(first)) {
		t.Errorf("accumulator is %d bytes, want %d", got.Size(), len(first))
	}

	if code, resp := applyChunk(t, srv, planID, []tarFile{slice("big.bin", len(first), total, second, mtime)}, true); code != 200 {
		t.Fatalf("second slice: status %d: %v", code, resp)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read assembled file: %v", err)
	}
	if string(got) != "hello world" {
		t.Errorf("assembled %q, want %q", got, "hello world")
	}
	// The accumulator is scratch and must not survive as a sibling of the file.
	if _, err := os.Stat(partialName(dst, total)); !os.IsNotExist(err) {
		t.Errorf("accumulator survived the final slice (err=%v)", err)
	}
	st, err := os.Stat(dst)
	if err != nil {
		t.Fatal(err)
	}
	// mtime is load-bearing beyond tidiness: the next plan diffs on it, so a
	// file assembled with the wrong one is re-sent forever.
	if !st.ModTime().Truncate(time.Second).Equal(mtime) {
		t.Errorf("mtime %v, want %v", st.ModTime(), mtime)
	}
	if st.Mode().Perm() != 0o644 {
		t.Errorf("mode %v, want 0644", st.Mode().Perm())
	}
}

// An accumulator belongs to the protocol, not to the user's tree. If a plan
// reported it, the next push would offer to delete it — and a resumable upload
// whose resume deletes the thing it resumes from is worse than no resume.
func TestPushRangePartialIsInvisibleToPlan(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	mtime := time.Now().Truncate(time.Second)
	planID := planRanged(t, srv, "workspace/proj", target, "big.bin", 11, mtime)
	if code, resp := applyChunk(t, srv, planID, []tarFile{slice("big.bin", 0, 11, []byte("hello "), mtime)}, false); code != 200 {
		t.Fatalf("first slice: status %d: %v", code, resp)
	}

	// A fresh plan for an unrelated file: the accumulator must appear in
	// neither the leftovers nor anything derived from them.
	code, resp := planFor(t, srv, "workspace/proj", target,
		[]map[string]any{entry("other.txt", "file", 3, mtime)}, nil)
	if code != 200 {
		t.Fatalf("plan: status %d: %v", code, resp)
	}
	for _, key := range []string{"delete", "leftover"} {
		list, _ := resp[key].([]any)
		for _, v := range list {
			if s, _ := v.(string); s != "" && s != "other.txt" {
				t.Errorf("%s names %q — the accumulator leaked into the tree view", key, s)
			}
		}
	}
}

// The resume path. A plan tells the client how much of an oversized file the
// box is already holding, so a run that died at 4 GB does not start at zero.
func TestPushRangePlanReportsPartial(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	// Big enough for the box to bother looking: only a file that could be
	// ranged is worth a stat when planning.
	const total = 300 * 1024 * 1024
	dst := filepath.Join(target, "big.bin")
	if err := os.WriteFile(partialName(dst, total), []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	mtime := time.Now().Truncate(time.Second)
	code, resp := srv.postNdjson(t, "/api/push/plan2",
		map[string]any{"rel": "workspace/proj", "target": target},
		[]map[string]any{entry("big.bin", "file", total, mtime)})
	if code != 200 {
		t.Fatalf("plan2: status %d: %v", code, resp)
	}
	if resp["accept_ranges"] != true {
		t.Errorf("accept_ranges is %v, want true — a client cannot range without it", resp["accept_ranges"])
	}
	partials, _ := resp["partials"].(map[string]any)
	if partials == nil {
		t.Fatalf("no partials reported: %v", resp)
	}
	if got, _ := partials["big.bin"].(float64); got != 10 {
		t.Errorf("partials[big.bin] = %v, want 10", partials["big.bin"])
	}
}

// A size change between runs makes the old accumulator meaningless: resuming
// onto a prefix of a different file splices two generations together into
// something every checksum downstream would call correct. The total is in the
// accumulator's name precisely so this cannot happen.
func TestPushRangePartialOfDifferentSizeIsIgnored(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	const total = 300 * 1024 * 1024
	dst := filepath.Join(target, "big.bin")
	if err := os.WriteFile(partialName(dst, total+1), []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, resp := srv.postNdjson(t, "/api/push/plan2",
		map[string]any{"rel": "workspace/proj", "target": target},
		[]map[string]any{entry("big.bin", "file", total, time.Now())})
	if code != 200 {
		t.Fatalf("plan2: status %d: %v", code, resp)
	}
	if partials, ok := resp["partials"].(map[string]any); ok {
		if _, named := partials["big.bin"]; named {
			t.Errorf("resumed onto an accumulator for a different size: %v", partials)
		}
	}
}

// A slice that starts past what has landed would leave a hole — a run of bytes
// nobody ever wrote, indistinguishable afterwards from data. Refusing costs a
// re-run; accepting produces a corrupt file that reports itself as complete.
func TestPushRangeRejectsGap(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	mtime := time.Now().Truncate(time.Second)
	planID := planRanged(t, srv, "workspace/proj", target, "big.bin", 20, mtime)
	code, resp := applyChunk(t, srv, planID, []tarFile{slice("big.bin", 10, 20, []byte("0123456789"), mtime)}, true)
	if code == 200 {
		t.Fatalf("a slice starting past the end of the accumulator was accepted: %v", resp)
	}
	if _, err := os.Stat(filepath.Join(target, "big.bin")); !os.IsNotExist(err) {
		t.Errorf("destination was written despite the refusal (err=%v)", err)
	}
}

// A body that runs past the declared total is a client that has miscounted.
// Writing it would push the accumulator past the size the name promises, which
// is the one thing the resume check relies on.
func TestPushRangeRejectsOverrun(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	mtime := time.Now().Truncate(time.Second)
	planID := planRanged(t, srv, "workspace/proj", target, "big.bin", 5, mtime)
	code, resp := applyChunk(t, srv, planID, []tarFile{slice("big.bin", 0, 5, []byte("far too many bytes"), mtime)}, true)
	if code == 200 {
		t.Fatalf("a slice longer than its file was accepted: %v", resp)
	}
}

// A truncated upload must leave the accumulator exactly as it found it. The
// length is what the next plan reports as landed, so bytes that arrived without
// a sentinel behind them would be resumed *from* — writing unverified data into
// the middle of a file and never looking at it again.
func TestPushRangeTruncatedSliceDoesNotAdvancePartial(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	mtime := time.Now().Truncate(time.Second)
	total := 12
	planID := planRanged(t, srv, "workspace/proj", target, "big.bin", total, mtime)
	if code, resp := applyChunk(t, srv, planID, []tarFile{slice("big.bin", 0, total, []byte("aaaa"), mtime)}, false); code != 200 {
		t.Fatalf("first slice: status %d: %v", code, resp)
	}
	dst := filepath.Join(target, "big.bin")
	part := partialName(dst, total)
	before, err := os.Stat(part)
	if err != nil {
		t.Fatalf("no accumulator: %v", err)
	}

	// Same shape as a real truncation: the body arrives, the sentinel does not.
	body := writeTar(t, []tarFile{slice("big.bin", 4, total, []byte("bbbb"), mtime)}, "")
	code, _ := srv.postTar(t, "/api/push/apply?plan_id="+planID+"&final=0", body, "sent")
	if code == 200 {
		t.Fatal("an apply with no sentinel was accepted")
	}
	after, err := os.Stat(part)
	if err != nil {
		t.Fatalf("accumulator vanished: %v", err)
	}
	if after.Size() != before.Size() {
		t.Errorf("accumulator grew from %d to %d on a stream that never completed", before.Size(), after.Size())
	}
}

// An entry with no range records is the ordinary file every push has always
// carried, and it must still take the staging-and-promote path untouched.
func TestPushUnrangedEntryStillLandsDirectly(t *testing.T) {
	srv, home := setupPush(t)
	target := filepath.Join(home, "workspace", "proj")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	mtime := time.Now().Truncate(time.Second)
	planID := planRanged(t, srv, "workspace/proj", target, "plain.txt", 5, mtime)
	if code, resp := applyChunk(t, srv, planID, []tarFile{
		{name: "plain.txt", typ: tar.TypeReg, mode: 0o644, body: []byte("hello"), mtime: mtime},
	}, true); code != 200 {
		t.Fatalf("apply: status %d: %v", code, resp)
	}
	got, err := os.ReadFile(filepath.Join(target, "plain.txt"))
	if err != nil || string(got) != "hello" {
		t.Fatalf("read back %q, err=%v", got, err)
	}
}
