// Callback URL tokens: bearer-capability primitives for hardening callback
// endpoints against forged POSTs.
//
// Threat model — read before wiring any Daraja callback endpoint. Safaricom
// sends NO signature of any kind on callback traffic (no HMAC, no signed
// header): anyone who learns or guesses your CallBackURL can forge a body
// that parses cleanly into STKCallback. The URL path is the only channel
// you control end to end, so treat it as a bearer capability — generate an
// unguessable token and embed it in the registered path:
//
//	https://api.example.com/mpesa/callback/<token>
//
// Be precise about what this buys: the token authenticates the ENDPOINT —
// proof the caller knows the URL — NOT payload content. A hit never
// replaces settlement, and the capability's lifetime carries obligations:
//
//   - ALWAYS settle via STKQuery (or the async result) ResultCode == 0,
//     bound to your own CheckoutRequestID record, before marking anything
//     paid; forged hits parse just fine.
//   - Scrub access logs, proxy and APM traces: the token travels in the URL
//     and leaks wherever URLs are logged, cached or shared.
//   - Rotate long-lived C2B registrations through an overlap window that
//     accepts old and new tokens simultaneously until traffic migrates,
//     then retire the old one.
//
// Shape of the whole flow:
//
//	token, err := mpesa.NewCallbackToken()
//	callbackURL := "https://api.example.com/mpesa/callback/" + token
//	// register callbackURL on the STK Push request / C2B registration...
//	// ...later, inside the handler for that path:
//	got := strings.TrimPrefix(r.URL.Path, "/mpesa/callback/")
//	if !mpesa.CallbackTokenEqual(tokenOnFile, got) {
//	    http.NotFound(w, r) // identical answer for wrong and unknown paths
//	    return
//	}
//	res, err := client.STKQuery(ctx, checkoutRequestID)
//	if err == nil && res.Classify() == mpesa.ResultClassSuccess {
//	    markPaid(orderID) // settled by query, never by the bare hit
//	}

package mpesa

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
)

// callbackTokenEntropyBytes is 128 bits — the floor for unguessable URL
// capabilities — encoding to exactly 22 unpadded base64url characters.
const callbackTokenEntropyBytes = 16

// NewCallbackToken returns a fresh URL-safe callback token: 22 characters
// carrying 128 bits of entropy from crypto/rand, encoded unpadded base64url.
// Generate one per registered CallBackURL (or per order), embed it in the
// URL path and store it beside the request record for later comparison.
// CSPRNG failures propagate verbatim — there is deliberately NO fallback to
// math/rand or time-derived values, because a guessable token silently
// converts every registered endpoint into a forgery target. See the
// threat-model notes atop callbacktoken.go for logging, rotation and
// settlement rules.
func NewCallbackToken() (string, error) {
	buf := make([]byte, callbackTokenEntropyBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("mpesa: crypto/rand failed: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// CallbackTokenEqual compares the token held on file against the token
// provided on a request hit in constant time. Either side empty returns
// false immediately — including BOTH empty — because an unconfigured
// expectation must never bless a request (subtle.ConstantTimeCompare alone
// returns 1 for two empty inputs, which is exactly backwards here). Differing
// lengths return false per stdlib semantics; comparison cost stays flat in
// byte equality, leaking length only, which is public anyway.
func CallbackTokenEqual(expected, provided string) bool {
	if expected == "" || provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(provided)) == 1
}
