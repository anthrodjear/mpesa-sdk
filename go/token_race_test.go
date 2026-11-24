package mpesa

// Regression test for the generation-guard TOCTOU behind the flaky
// TestConcurrent401GenerationGuardSingleRefetch on CI (oauth fetches = 3,
// want exactly 2): a caller that observed errorCode 401.003.01 with an old
// generation must ADOPT a peer's freshly committed token instead of issuing
// a second forced refresh.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// TestLeadForcedRefreshAfterGenAdoptsFreshPeerToken pins the invariant that
// closes the race window. The caller's generation read and the claim of
// leadership must be atomic: when a peer has already committed a new,
// still-fresh token since myGen, no further OAuth request is made.
func TestLeadForcedRefreshAfterGenAdoptsFreshPeerToken(t *testing.T) {
	var mu sync.Mutex
	oauthHits := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/v1/generate", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		oauthHits++
		n := oauthHits
		mu.Unlock()
		tok := "tok-v1"
		if n > 1 {
			tok = "tok-v2"
		}
		writeJSON(t, w, http.StatusOK, map[string]any{"access_token": tok, "expires_in": "3599"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := testClient(t, srv.URL)
	ctx := context.Background()

	// Caller's original token: tok-v1 at generation 1.
	tok, gen, err := c.tokenWithGen(ctx)
	if err != nil || tok != "tok-v1" || gen == 0 {
		t.Fatalf("tokenWithGen = (%q, %d, %v), want (tok-v1, >0, nil)", tok, gen, err)
	}

	// A peer completes a forced refresh in the meantime: gen is bumped and
	// tok-v2 is committed and still fresh.
	peerTok, err := c.forceRefresh(ctx)
	if err != nil || peerTok != "tok-v2" {
		t.Fatalf("peer forceRefresh = (%q, %v), want (tok-v2, nil)", peerTok, err)
	}

	// Our caller saw the 401 with the OLD generation and now enters the
	// forced-refresh path. It must adopt the peer's token with NO third
	// OAuth round-trip.
	got, err := c.leadForcedRefreshAfterGen(ctx, gen)
	if err != nil {
		t.Fatalf("leadForcedRefreshAfterGen: %v", err)
	}
	if got != "tok-v2" {
		t.Fatalf("token = %q, want tok-v2 (peer's fresh token)", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if oauthHits != 2 {
		t.Fatalf("oauth fetches = %d, want exactly 2 (initial + peer refresh, no third)", oauthHits)
	}
}
