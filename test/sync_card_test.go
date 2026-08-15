package wsh_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// A card goes through the same guard as the files beside it — so the check has
// to answer for one, and the merge has to hand back the box's half of the
// agreement it just established.
//
// `present` is the load-bearing half. A pushing client cannot work it out for
// itself: the receiver's card state is at this end, and the merge endpoint
// reports `created` only after it has written. It is the same reason the root
// half already carries target_type.

const syncCardReplica = "0123456789abcdef0123456789abcdef"

// Any well-formed digest will do for the root half of these requests: the cards
// are what is under test, and the root's own comparison is asserted elsewhere.
const syncCardAnyHash = "00000000000000000000000000000000000000000000000000000000000000aa"

func syncCardApps(t *testing.T, home string, apps map[string]any) {
	t.Helper()
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
}

// syncCardCheck asks who moved for one card, under a hash the caller controls.
func syncCardCheck(t *testing.T, srv *server, home, key, localHash string) map[string]any {
	t.Helper()
	// The shape the client actually sends: ~/.wsh/apps.yaml named in *file*
	// mode, so the box stats one path. Naming the file as the rel would ask it
	// to walk a regular file, which is not a question a walk can answer.
	body := srv.postJSON(t, "/api/sync/check", map[string]any{
		"replica": syncCardReplica,
		"root": map[string]any{
			"rel": ".wsh", "file": "apps.yaml", "skip_fp": "card:",
			"local_hash": syncCardAnyHash,
		},
		"cards": []map[string]any{{"key": key, "local_hash": localHash}},
	})
	cards, _ := body["cards"].([]any)
	if len(cards) != 1 {
		t.Fatalf("check answered %d cards, want 1 (%v)", len(cards), body)
	}
	return cards[0].(map[string]any)
}

func TestSyncCheckAnswersForCards(t *testing.T) {
	srv, home := setupPush(t)
	syncCardApps(t, home, map[string]any{"mynotes": map[string]any{"command": "./serve"}})
	someHash := "11111111111111111111111111111111111111111111111111111111111111ab"

	// A key the box holds, with no record: it cannot say the two sides ever
	// agreed, which is the case that stops and asks.
	got := syncCardCheck(t, srv, home, "mynotes", someHash)
	if got["present"] != true {
		t.Errorf("present = %v, want true", got["present"])
	}
	if got["state"] != "no_record" {
		t.Errorf("state = %v, want no_record", got["state"])
	}
	boxHash, _ := got["box_hash"].(string)
	if len(boxHash) != 64 {
		t.Errorf("box_hash = %q, want a sha256 digest of the entry", boxHash)
	}

	// A key it does not hold is an add, whatever any record says — and the
	// client needs `present` to know that.
	got = syncCardCheck(t, srv, home, "absent", someHash)
	if got["present"] != false {
		t.Errorf("present = %v, want false", got["present"])
	}

	// Once an agreement exists, a card that has not moved on either side reads
	// in_sync — which is what lets --yes carry a replacement.
	srv.postJSON(t, "/api/sync/record", map[string]any{
		"replica": syncCardReplica,
		"root": map[string]any{
			"rel": ".wsh/apps.yaml", "skip_fp": "card:mynotes",
			"local_hash": someHash, "box_hash": boxHash,
		},
	})
	got = syncCardCheck(t, srv, home, "mynotes", someHash)
	if got["state"] != "in_sync" {
		t.Errorf("state = %v, want in_sync after recording the agreement", got["state"])
	}

	// Edit the card on the box and the same question answers box_moved: the
	// receiver has diverged, and what would die exists nowhere else.
	syncCardApps(t, home, map[string]any{"mynotes": map[string]any{"command": "./serve --port 9"}})
	got = syncCardCheck(t, srv, home, "mynotes", someHash)
	if got["state"] != "box_moved" {
		t.Errorf("state = %v, want box_moved", got["state"])
	}
}

// A path push carries no cards, and its check must stay the ~100 bytes it has
// always been rather than growing an empty list.
func TestSyncCheckOmitsCardsWhenNoneAsked(t *testing.T) {
	srv, home := setupPush(t)
	syncCardApps(t, home, map[string]any{"mynotes": map[string]any{"command": "./serve"}})
	body := srv.postJSON(t, "/api/sync/check", map[string]any{
		"replica": syncCardReplica,
		"root":    map[string]any{"rel": ".", "home": true, "local_hash": syncCardAnyHash, "skip_fp": "none"},
	})
	if _, ok := body["cards"]; ok {
		t.Errorf("a check that asked about no cards got an answer about them: %v", body["cards"])
	}
}

// The merge reports the box's canonical hash of what it now holds — the half of
// the agreement the client cannot compute, because a hash is only ever compared
// against one from the same side.
func TestMergeReportsItsCardHash(t *testing.T) {
	srv, home := setupPush(t)
	syncCardApps(t, home, map[string]any{})

	body := srv.postJSON(t, "/api/apps/mynotes", map[string]any{"command": "./serve", "title": "Notes"})
	hash, _ := body["hash"].(string)
	if len(hash) != 64 {
		t.Fatalf("hash = %q, want a sha256 digest", hash)
	}
	// And it is the value the check then reports for the same key, or the
	// record the client writes would never match anything.
	got := syncCardCheck(t, srv, home, "mynotes", syncCardAnyHash)
	if got["box_hash"] != hash {
		t.Errorf("merge said %q, check says %v — the two must agree", hash, got["box_hash"])
	}
}
