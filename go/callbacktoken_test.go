// Tests for the callback URL token primitives: shape, entropy uniqueness,
// and the exact truth table of the constant-time comparison.

package mpesa

import (
	"fmt"
	"regexp"
	"testing"
)

// callbackTokenAlphabet is unpadded base64url: A-Z a-z 0-9 '-' '_',
// exactly 22 characters for a 16-byte draw.
var callbackTokenAlphabet = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

// 1000 draws must all be 22 chars, strictly inside the base64url alphabet,
// and pairwise unique — any collision across 2^14+ sampled bits implies
// broken randomness, not bad luck.
func TestNewCallbackTokenShapeAndUniqueness(t *testing.T) {
	const draws = 1000
	seen := make(map[string]bool, draws)
	for i := 0; i < draws; i++ {
		tok, err := NewCallbackToken()
		if err != nil {
			t.Fatalf("NewCallbackToken() draw %d: unexpected error: %v", i, err)
		}
		if len(tok) != 22 {
			t.Fatalf("draw %d: token %q has length %d, want 22", i, tok, len(tok))
		}
		if !callbackTokenAlphabet.MatchString(tok) {
			t.Fatalf("draw %d: token %q outside base64url alphabet", i, tok)
		}
		if seen[tok] {
			t.Fatalf("draw %d: duplicate token %q across %d draws", i, tok, draws)
		}
		seen[tok] = true
	}
}

// Full truth table. Both-empty MUST be false even though
// subtle.ConstantTimeCompare("", "") == 1 — the empty guard exists
// precisely to override that stdlib edge case.
func TestCallbackTokenEqualTruthTable(t *testing.T) {
	const onFile = "dQw4w9WgXcQ_ab12CD34ef"
	cases := []struct {
		name     string
		expected string
		provided string
		want     bool
	}{
		{"exact match", onFile, "dQw4w9WgXcQ_ab12CD34ef", true},
		{"same-length mismatch", onFile, "dQw4w9WgXcQ_ab12CD34eg", false},
		{"both empty", "", "", false},
		{"expected empty, provided set", "", onFile, false},
		{"provided empty, expected set", onFile, "", false},
		{"case sensitivity", "DQW4W9WGXCQ_AB12CD34EF", "dqw4w9wgxcq_ab12cd34ef", false},
		{"lengths differ", "short", onFile, false},
		{"provided truncates expected", onFile, "dQw4w9WgXcQ_ab12CD34e", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := CallbackTokenEqual(tc.expected, tc.provided); got != tc.want {
				t.Errorf("CallbackTokenEqual(%q, %q) = %v, want %v",
					tc.expected, tc.provided, got, tc.want)
			}
		})
	}
}

func ExampleCallbackTokenEqual() {
	onFile := "dQw4w9WgXcQ_ab12CD34ef" // stored beside the request record

	fmt.Println(CallbackTokenEqual(onFile, "dQw4w9WgXcQ_ab12CD34ef")) // genuine hit
	fmt.Println(CallbackTokenEqual(onFile, "forged_but_same_length")) // same-length guess
	fmt.Println(CallbackTokenEqual("", ""))                           // unset endpoint never matches
	// Output:
	// true
	// false
	// false
}
