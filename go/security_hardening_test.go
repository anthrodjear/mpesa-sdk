package mpesa

// Regression tests for the scoped security-hardening round (HIGH items 1–4
// plus NEW-2/6/N8a/NEW-9). Each test documents the attack or correctness
// gap it closes so future refactors cannot silently reopen it.

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// 1. Request redaction parity: LogSafe() + oauthTokenResponse redaction.
// ---------------------------------------------------------------------------

// LogSafe must return the exact JSON wire shape with only SecurityCredential
// redacted: every other key stays verbatim for debuggability, while the
// bearer credential never reaches log aggregators. This closes the
// json.Marshal(req) leak that bypasses GoString/Format (which only cover
// fmt verbs).
func TestRequestLogSafeRedactsCredential(t *testing.T) {
	b2c := B2CPayoutRequest{
		OriginatorConversationID: "abc123",
		InitiatorName:            "init-visible",
		SecurityCredential:       "cred-TOPSECRET",
		CommandID:                CommandBusinessPayment,
		Amount:                   100,
		PartyA:                   "600992",
		PartyB:                   "254705912645",
		Remarks:                  "refund order 42",
		QueueTimeOutURL:          "https://mydomain.com/timeout",
		ResultURL:                "https://mydomain.com/result",
		Occassion:                "Xmas",
	}
	tx := TransactionStatusRequest{
		Initiator: "init-visible", SecurityCredential: "cred-TOPSECRET",
		TransactionID: "NLJ7RT61SV", PartyA: "600992", Remarks: "reconcile",
		ResultURL: "https://mydomain.com/result", QueueTimeOutURL: "https://mydomain.com/timeout",
	}
	rev := ReversalRequest{
		Initiator: "init-visible", SecurityCredential: "cred-TOPSECRET",
		TransactionID: "NLJ7RT61SV", Amount: 100, ReceiverParty: "600992",
		Remarks: "wrong deposit", ResultURL: "https://mydomain.com/result",
		QueueTimeOutURL: "https://mydomain.com/timeout",
	}
	bal := AccountBalanceRequest{
		Initiator: "init-visible", SecurityCredential: "cred-TOPSECRET",
		PartyA: "600992", Remarks: "eod balance",
		ResultURL: "https://mydomain.com/result", QueueTimeOutURL: "https://mydomain.com/timeout",
	}
	cases := []struct {
		name string
		safe map[string]any
		// visibleKeys must survive verbatim; secret must be redacted.
		visibleKeys map[string]string
	}{
		{"B2C", b2c.LogSafe(), map[string]string{"InitiatorName": "init-visible", "Occassion": "Xmas"}},
		{"TxStatus", tx.LogSafe(), map[string]string{"Initiator": "init-visible", "TransactionID": "NLJ7RT61SV"}},
		{"Reversal", rev.LogSafe(), map[string]string{"Initiator": "init-visible", "TransactionID": "NLJ7RT61SV"}},
		{"Balance", bal.LogSafe(), map[string]string{"Initiator": "init-visible", "PartyA": "600992"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Secret key must exist (shape parity) but carry the marker.
			got, ok := tc.safe["SecurityCredential"]
			if !ok {
				t.Fatalf("LogSafe missing SecurityCredential key: %v", tc.safe)
			}
			if got != "[REDACTED]" {
				t.Fatalf("SecurityCredential = %v, want [REDACTED]", got)
			}
			for k, want := range tc.visibleKeys {
				if tc.safe[k] != want {
					t.Errorf("LogSafe[%q] = %v, want %q (full map %v)", k, tc.safe[k], want, tc.safe)
				}
			}
			// Serializing the SAFE map must never contain the secret.
			b, err := json.Marshal(tc.safe)
			if err != nil {
				t.Fatalf("marshal LogSafe: %v", err)
			}
			if strings.Contains(string(b), "cred-TOPSECRET") {
				t.Fatalf("LogSafe JSON leaks credential: %s", b)
			}
		})
	}
	// Document the gap LogSafe closes: raw json.Marshal DOES leak.
	raw, _ := json.Marshal(b2c)
	if !strings.Contains(string(raw), "cred-TOPSECRET") {
		t.Fatalf("precondition broken: raw json.Marshal should leak (that is why LogSafe exists): %s", raw)
	}
}

// oauthTokenResponse carries the live bearer: every fmt verb must render
// len-only, never token bytes. %+v on a struct without Format prints raw
// fields, so String/GoString alone are insufficient — Format is the backstop.
func TestOAuthTokenResponseRedactsBearer(t *testing.T) {
	tok := oauthTokenResponse{AccessToken: "bearer-TOPSECRET-123", ExpiresIn: 3599}
	for _, rendered := range []string{
		fmt.Sprintf("%v", tok),
		fmt.Sprintf("%+v", tok),
		fmt.Sprintf("%#v", tok),
		fmt.Sprintf("%s", tok),
		tok.String(),
		tok.GoString(),
	} {
		if strings.Contains(rendered, "bearer-TOPSECRET-123") {
			t.Fatalf("oauth token leaked in %q", rendered)
		}
	}
	// Len-only proof-of-presence plus TTL must still be visible for debugging.
	shown := fmt.Sprintf("%+v", tok)
	if !strings.Contains(shown, fmt.Sprintf("%d", len("bearer-TOPSECRET-123"))) {
		t.Errorf("redacted form should expose token len, got %q", shown)
	}
	if !strings.Contains(shown, "3599") {
		t.Errorf("redacted form should expose expires_in, got %q", shown)
	}
}

// ---------------------------------------------------------------------------
// 2. InsecureSkipVerify wrapper-chain walk.
// ---------------------------------------------------------------------------

// unwrapTransport is a minimal tracing/retry-style wrapper: it delegates
// RoundTrip to an inner transport and exposes it via Unwrap, the standard
// library convention NewClient must see through.
type unwrapTransport struct{ inner http.RoundTripper }

func (w unwrapTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return w.inner.RoundTrip(r)
}

// Unwrap exposes the inner RoundTripper so verification checks can descend.
func (w unwrapTransport) Unwrap() http.RoundTripper { return w.inner }

// opaqueTransport is a wrapper WITHOUT Unwrap: the checker cannot see
// through it, so it must be treated as safe (nothing provably insecure).
type opaqueTransport struct{ inner http.RoundTripper }

func (w opaqueTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return w.inner.RoundTrip(r)
}

func TestNewClientRefusesInsecureSkipVerify(t *testing.T) {
	insecure := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	secure := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: false}}
	nilTLS := &http.Transport{TLSClientConfig: nil}

	// Direct insecure transport must be refused (original behavior).
	if _, err := NewClient(Config{Environment: Sandbox, HTTPClient: &http.Client{Transport: insecure}}); err == nil ||
		!strings.Contains(err.Error(), "InsecureSkipVerify") {
		t.Errorf("direct insecure transport err = %v, want InsecureSkipVerify refusal", err)
	}
	// Wrapped insecure transports must ALSO be refused (the HIGH fix):
	// single and double wrapping.
	wrapped := unwrapTransport{inner: insecure}
	if _, err := NewClient(Config{Environment: Sandbox, HTTPClient: &http.Client{Transport: wrapped}}); err == nil ||
		!strings.Contains(err.Error(), "InsecureSkipVerify") {
		t.Errorf("wrapped insecure transport err = %v, want refusal", err)
	}
	doubleWrapped := unwrapTransport{inner: unwrapTransport{inner: insecure}}
	if _, err := NewClient(Config{Environment: Sandbox, HTTPClient: &http.Client{Transport: doubleWrapped}}); err == nil ||
		!strings.Contains(err.Error(), "InsecureSkipVerify") {
		t.Errorf("double-wrapped insecure transport err = %v, want refusal", err)
	}
	// Secure / nil-TLSConfig / nil-Transport cases must be ALLOWED.
	for _, tc := range []struct {
		name string
		rt   http.RoundTripper
	}{
		{"secure TLSConfig", secure},
		{"nil TLSConfig verifies by default", nilTLS},
		{"nil Transport means DefaultTransport", nil},
		{"wrapped secure inner", unwrapTransport{inner: secure}},
		{"opaque wrapper cannot prove insecurity", opaqueTransport{inner: insecure}},
	} {
		t.Run("allows/"+tc.name, func(t *testing.T) {
			var hc *http.Client
			if tc.rt == nil {
				hc = &http.Client{Transport: nil}
			} else {
				hc = &http.Client{Transport: tc.rt}
			}
			if _, err := NewClient(Config{Environment: Sandbox, HTTPClient: hc}); err != nil {
				t.Errorf("NewClient(%s) = %v, want success", tc.name, err)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 3. Config MarshalJSON robustness (explicit safe struct).
// ---------------------------------------------------------------------------

// MarshalJSON must use the explicit safe struct (ConsumerKey, Shortcode,
// Environment name, Timeout) so a set Now func or *http.Client can neither
// panic (funcs are unmarshalable) nor leak transport internals/secrets.
func TestConfigMarshalJSONRedactsSecrets(t *testing.T) {
	cfg := Config{
		ConsumerKey:    "ck-visible",
		ConsumerSecret: "cs-TOPSECRET",
		Shortcode:      "174379",
		Passkey:        "pass-TOPSECRET",
		Environment:    Sandbox,
		Timeout:        30 * time.Second,
		// The regression trigger: previous shadow-struct marshal errored on
		// func fields and serialized the transport. These must be ignored.
		Now:        func() time.Time { return time.Now() },
		HTTPClient: &http.Client{Timeout: 5 * time.Second},
	}
	b, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("MarshalJSON with Now+HTTPClient set: %v (must not panic/error)", err)
	}
	s := string(b)
	for _, leaked := range []string{"cs-TOPSECRET", "pass-TOPSECRET"} {
		if strings.Contains(s, leaked) {
			t.Fatalf("MarshalJSON leaks secret %q: %s", leaked, s)
		}
	}
	// Func/transport internals must not appear either.
	for _, leaked := range []string{"HTTPClient", "Now", "CheckRedirect", "Transport"} {
		if strings.Contains(s, leaked) {
			t.Fatalf("MarshalJSON leaks internal field %q: %s", leaked, s)
		}
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	// Explicit safe shape: only these four keys.
	for _, key := range []string{"ConsumerKey", "Shortcode", "Environment", "Timeout"} {
		if _, ok := m[key]; !ok {
			t.Errorf("MarshalJSON missing safe key %q in %s", key, s)
		}
	}
	if m["ConsumerKey"] != "ck-visible" {
		t.Errorf("ConsumerKey = %v, want ck-visible (visible by design)", m["ConsumerKey"])
	}
	if m["Shortcode"] != "174379" {
		t.Errorf("Shortcode = %v, want 174379", m["Shortcode"])
	}
	if m["Environment"] != "sandbox" {
		t.Errorf("Environment = %v, want sandbox name (Python log_safe/TS toJSON parity)", m["Environment"])
	}
	// Production maps to its name as well.
	cfg.Environment = Production
	b, _ = json.Marshal(cfg)
	var pm map[string]any
	_ = json.Unmarshal(b, &pm)
	if pm["Environment"] != "production" {
		t.Errorf("production Environment = %v, want production", pm["Environment"])
	}
	if _, ok := m["ConsumerSecret"]; ok {
		t.Errorf("ConsumerSecret must be omitted entirely (deny-by-default), got %s", s)
	}
	if _, ok := m["Passkey"]; ok {
		t.Errorf("Passkey must be omitted entirely (deny-by-default), got %s", s)
	}
}

// ---------------------------------------------------------------------------
// 4. Credential validation: colon + ASCII gates.
// ---------------------------------------------------------------------------

// ConsumerKey must not contain ':' (Basic-auth "key:secret" separator would
// split ambiguously) and both credentials must be ASCII-only (non-ASCII
// breaks Basic-auth byte encoding; Python auth.py + TS auth.ts parity).
func TestConfigValidateRejectsColonInConsumerKey(t *testing.T) {
	if err := (Config{ConsumerKey: "key:with:colon"}).Validate(); err == nil ||
		!strings.Contains(err.Error(), "':'") {
		t.Fatalf("colon ConsumerKey err = %v, want Basic-auth separator rejection", err)
	}
	// Colon-free ASCII keys pass (shortcode empty is allowed).
	if err := (Config{ConsumerKey: "plain-key", ConsumerSecret: "plain-secret"}).Validate(); err != nil {
		t.Fatalf("valid ASCII credentials rejected: %v", err)
	}
}

func TestConfigValidateRejectsNonASCII(t *testing.T) {
	// Non-ASCII runes (>0x7F) in either credential must fail with an
	// ASCII-specific message naming the field.
	for _, tc := range []struct {
		name   string
		key    string
		secret string
		field  string
	}{
		{"non-ASCII key", "clé", "secret", "ConsumerKey"},
		{"non-ASCII secret", "key", "sécret", "ConsumerSecret"},
		{"emoji key", "key🔑", "secret", "ConsumerKey"},
		{"CJK secret", "key", "秘密", "ConsumerSecret"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := (Config{ConsumerKey: tc.key, ConsumerSecret: tc.secret}).Validate()
			if err == nil {
				t.Fatalf("non-ASCII credentials accepted (key=%q secret=%q)", tc.key, tc.secret)
			}
			if !strings.Contains(err.Error(), "ASCII") || !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("err = %v, want ASCII + %q mention", err, tc.field)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 9a. AsyncResult first-wins on duplicate keys.
// ---------------------------------------------------------------------------

// On gateway retries the same Key can appear twice: the FIRST value wins
// (Python parameters()/metadata() + TS MetadataMap parity). Last-wins
// silently diverged across SDKs.
func TestAsyncResultParametersFirstWins(t *testing.T) {
	body := AsyncResultBody{
		ResultParameters: &ResultParameters{
			ResultParameter: []ResultParameter{
				{Key: "A", Value: json.RawMessage(`1`)},
				{Key: "A", Value: json.RawMessage(`2`)},
			},
		},
	}
	params := body.Parameters()
	if params["A"] != "1" {
		t.Fatalf("duplicate Key A=1,2 → %q, want first-wins \"1\"", params["A"])
	}
}

// ---------------------------------------------------------------------------
// 5. Classification trim order: spaces→quotes→spaces.
// ---------------------------------------------------------------------------

// Padded quoted codes like ' "0" ' must classify by their inner value:
// the old TrimSpace(Trim(code,'"')) stripped quotes before spaces and left
// '"0"' intact, misclassifying success as indeterminate.
func TestClassifyTrimOrderSpacesQuotesSpaces(t *testing.T) {
	cases := []struct {
		code string
		want ResultClass
	}{
		{` "0" `, ResultClassSuccess},   // the NEW-2 vector
		{`"0"`, ResultClassSuccess},     // unpadded quoted still works
		{`  0  `, ResultClassSuccess},   // unquoted padding still works
		{` "1" `, ResultClassFailure},   // padded quoted failure
		{` "1032" `, ResultClassFailure},
		{` " 0 " `, ResultClassSuccess}, // inner padding after quote strip
	}
	for _, tc := range cases {
		if got := ClassifyResultCode(tc.code); got != tc.want {
			t.Errorf("ClassifyResultCode(%q) = %q, want %q", tc.code, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// 6. OriginatorConversationID length bound (<20; generated are 16 hex).
// ---------------------------------------------------------------------------

func validB2CWithOCID(ocid string) B2CPayoutRequest {
	return B2CPayoutRequest{
		OriginatorConversationID: ocid,
		InitiatorName:            "testapi",
		SecurityCredential:       "cred",
		CommandID:                CommandBusinessPayment,
		Amount:                   100,
		PartyA:                   "600992",
		PartyB:                   "254705912645",
		Remarks:                  "refund order 42",
		QueueTimeOutURL:          "https://mydomain.com/timeout",
		ResultURL:                "https://mydomain.com/result",
	}
}

func TestB2COriginatorConversationIDLength(t *testing.T) {
	// Empty must be rejected by direct Validate (client path generates
	// before validating, so only direct callers see this). Each request is
	// bound to an addressable variable because Validate has a pointer
	// receiver and Go cannot take the address of a function return value.
	checkOCID := func(ocid string) error {
		req := validB2CWithOCID(ocid)
		return req.Validate()
	}
	if err := checkOCID(""); err == nil ||
		!strings.Contains(err.Error(), "OriginatorConversationID") {
		t.Errorf("empty OCID err = %v, want OriginatorConversationID rejection", err)
	}
	// Longer than 19 chars (>contract <20) must be rejected.
	if err := checkOCID(strings.Repeat("x", 20)); err == nil ||
		!strings.Contains(err.Error(), "OriginatorConversationID") {
		t.Errorf("20-char OCID err = %v, want length rejection", err)
	}
	if err := checkOCID(strings.Repeat("y", 32)); err == nil {
		t.Errorf("32-char OCID accepted, want rejection")
	}
	// Boundary: 19 allowed, 16-hex generated shape allowed.
	if err := checkOCID(strings.Repeat("z", 19)); err != nil {
		t.Errorf("19-char OCID rejected: %v (contract is <20)", err)
	}
	if err := checkOCID("abcdef0123456789"); err != nil {
		t.Errorf("16-hex generated OCID rejected: %v", err)
	}
}

// ---------------------------------------------------------------------------
// 7. Balance gate: ASCII shape + finite + 2^53.
// ---------------------------------------------------------------------------

func TestParseBalanceSegmentsHardening(t *testing.T) {
	// Baseline valid row still parses.
	segs, skipped := ParseBalanceSegments("Working Account|KES|700000.00|700000.00|0.00|0.00")
	if len(segs) != 1 || skipped != 0 {
		t.Fatalf("baseline: segs=%d skipped=%d, want 1/0", len(segs), skipped)
	}
	// Each hostile numeric must be SKIPPED (never fatal, never surfaced).
	hostiles := []struct {
		name  string
		value string
	}{
		{"underscore separator", "1_000"},
		{"hex literal", "0x10"},
		{"unicode Nd digits", "١٢٣"},
		{"NaN literal", "NaN"},
		{"Inf literal", "Inf"},
		{"exponent notation", "1e30"},
		{"overlong int digits", "1234567890123456789"},
		{"too many fraction digits", "1.1234567"},
		{"empty numeric", ""},
		{"alpha numeric", "abc"},
		{"beyond 2^53", "9007199254740993"},
		{"negative beyond 2^53", "-9007199254740993"},
	}
	for _, tc := range hostiles {
		t.Run(tc.name, func(t *testing.T) {
			blob := "Acct|KES|" + tc.value + "|0.00|0.00|0.00"
			segs, skipped := ParseBalanceSegments(blob)
			if len(segs) != 0 {
				t.Fatalf("hostile %q parsed as %v, want skipped", tc.value, segs)
			}
			if skipped != 1 {
				t.Fatalf("hostile %q skipped=%d, want 1", tc.value, skipped)
			}
		})
	}
	// Mixed blob: one good row survives, hostile rows counted.
	mixed := "Good|KES|10.00|10.00|0.00|0.00&Bad|KES|1_000|0.00|0.00|0.00&Good2|KES|-5.50|0.00|0.00|0.00"
	segs, skipped = ParseBalanceSegments(mixed)
	if len(segs) != 2 || skipped != 1 {
		t.Fatalf("mixed: segs=%d skipped=%d, want 2/1", len(segs), skipped)
	}
}

// ---------------------------------------------------------------------------
// 8. FlexInt64 integral-float TTL.
// ---------------------------------------------------------------------------

func TestFlexInt64IntegralFloat(t *testing.T) {
	// Integral floats (bare and quoted) must coerce; non-integral must error.
	accepts := []struct {
		raw  string
		want FlexInt64
	}{
		{`3599.0`, 3599},   // the NEW-9 vector: bare integral float
		{`"3599.0"`, 3599}, // quoted integral float (TS safeJsonInt parity)
		{`3599`, 3599},
		{`"3599"`, 3599},
		{`0.0`, 0},
	}
	for _, tc := range accepts {
		var v FlexInt64
		if err := json.Unmarshal([]byte(tc.raw), &v); err != nil {
			t.Errorf("FlexInt64(%s) error: %v, want %d", tc.raw, err, tc.want)
			continue
		}
		if v != tc.want {
			t.Errorf("FlexInt64(%s) = %d, want %d", tc.raw, v, tc.want)
		}
	}
	rejects := []string{`1.5`, `"1.5"`, `"abc"`, `abc`}
	for _, raw := range rejects {
		var v FlexInt64
		if err := json.Unmarshal([]byte(raw), &v); err == nil {
			t.Errorf("FlexInt64(%s) = %d, want error", raw, v)
		}
	}
}
