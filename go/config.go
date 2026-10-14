// Configuration: Client settings and credential redaction.

package mpesa

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Config configures a Client. Timeout defaults to 30s; Now may inject a clock
// for tests (defaults to time.Now). HTTPClient optionally injects a custom
// *http.Client (proxies, tracing, tests) — it is cloned, never mutated, and
// always inherits the SDK's never-follow-redirects policy plus a timeout
// default when zero. Config contains credentials — never log directly;
// GoString/Format redact and ConsumerKey is masked to its first/last 4 runes.
type Config struct {
	ConsumerKey       string
	ConsumerSecret    string
	Shortcode         string
	Passkey           string
	Environment       Environment
	Timeout           time.Duration
	Now               func() time.Time
	HTTPClient        *http.Client
	TLSPinningEnabled bool
	// Limits bounds per-transaction and per-day amounts per service.
	//
	// It is a PARTIAL OVERLAY, not a replacement: nil
	// (Config.Limits == nil) means DefaultTransactionLimits(), and any
	// individual field left nil inside it inherits the baseline value for
	// that field. Configuring only B2C therefore cannot silently disarm the
	// STK/C2B/Default ceilings — the failure mode of an all-or-nothing
	// struct. To DISABLE a ceiling, set it explicitly to 0 or a negative
	// value with mpesa.Limit(): that is the only spelling for "unlimited",
	// and it stays a deliberate act rather than a side effect of an unset
	// field.
	//
	// Example — raise B2C to 700k, leave everything else at the baseline:
	//	Limits: &TransactionLimits{
	//		B2C: ServiceLimits{MaxPerTransaction: Limit(700_000)},
	//	}
	//
	// The merge is resolved once in NewClient; the Client owns a fully
	// materialized, immutable copy thereafter.
	Limits *TransactionLimits
	// TrackDaily enables per-service daily accumulation against
	// Limits.*.MaxPerDay. OPT-IN and OFF by default.
	//
	// Why off: the accumulator lives in this process, so it only observes
	// traffic that goes through THIS Client. Daraja merchants routinely run
	// several replicas (or several processes) behind one shortcode, and
	// Daraja enforces the daily ceiling on the SHORTCODE, not per process.
	// A local accumulator would therefore under-count the day's volume and
	// reject a legitimate transaction that the gateway would accept — a
	// false negative that is worse than no ceiling at all. Enable it only
	// when you know this process is the sole originator for the service.
	TrackDaily bool
// ErrorLogger optionally receives detailed diagnostics for non-standard
// error responses (content-type, body snippet). When nil, detailed
// diagnostics are discarded. Not serialized by GoString/Format/MarshalJSON.
ErrorLogger ErrorLogger
// DisableRetryOnUnauthorized disables the automatic retry on 401.003.01
// (invalid/expired token). Default is false (retry enabled). Set to true
// to surface the 401 immediately without a refresh round-trip — useful for
// observability or when the caller wants to manage refresh explicitly.
DisableRetryOnUnauthorized bool
}

// resolvedLimits merges Config.Limits over the Safaricom baseline and returns
// a FULLY MATERIALIZED set (every field non-nil), so the enforcement helpers
// never have to resolve anything and never see an unmerged config.
//
// This is the single place the merge happens — NewClient calls it once, which
// is what makes the result immutable and lock-free to read afterwards.
// Nil-pointee safety matters here: a zero-value *TransactionLimits field
// (all-nil ServiceLimits) must inherit every baseline, not disable it.
func (c Config) resolvedLimits() TransactionLimits {
	base := DefaultTransactionLimits()
	if c.Limits == nil {
		return base
	}
	over := *c.Limits
	return TransactionLimits{
		STK:      overlay(base.STK, over.STK),
		C2B:      overlay(base.C2B, over.C2B),
		B2C:      overlay(base.B2C, over.B2C),
		Reversal: overlay(base.Reversal, over.Reversal),
		QR:       overlay(base.QR, over.QR),
		Default:  overlay(base.Default, over.Default),
	}
}

// maskCredential renders a value with only its first and last four runes
// visible ("9f3d…c1a2") so logs stay correlatable without exposing the whole
// secret. Values shorter than 8 runes carry no useful anchor, so they collapse
// to a same-length run of asterisks (an empty value renders empty — an empty
// consumer key is itself the diagnostic).
func maskCredential(s string) string {
	r := []rune(s)
	switch {
	case len(r) == 0:
		return ""
	case len(r) < 8:
		return strings.Repeat("*", len(r))
	default:
		return string(r[:4]) + "\u2026" + string(r[len(r)-4:])
	}
}

// GoString redacts ConsumerSecret and Passkey for %#v formatting and masks
// ConsumerKey (first 4 … last 4 runes).
//
// Why mask the key too: SECURITY.md ("Consumer Keys are secrets, not
// identifiers") — a consumer key authenticates every OAuth token request and
// grants full access to the Daraja app, so printing it in cleartext writes a
// long-lived credential into logs, APM traces and crash dumps that outlive
// the process. The masked form keeps enough of the value to correlate
// "which app is this?" at a glance.
func (c Config) GoString() string {
	return fmt.Sprintf("mpesa.Config{ConsumerKey:%q Shortcode:%q Environment:%d Timeout:%s secrets:redacted}",
		maskCredential(c.ConsumerKey), c.Shortcode, int(c.Environment), c.Timeout)
}

// Format routes EVERY fmt verb (%v, %+v, %s, ...) through the redacted form;
// GoStringer alone only covers %#v, while %+v prints raw struct fields.
func (c Config) Format(f fmt.State, verb rune) {
	_, _ = fmt.Fprint(f, c.GoString())
}

// MarshalJSON renders Config for structured logging with live secrets
// excluded entirely (never emitted, not even as "[REDACTED]" placeholders).
//
// Why an explicit safe struct (OWASP log-injection / secret-scanning
// baseline): the previous implementation marshalled a shadow copy of the
// whole Config, which included the Now func field (encoding/json cannot
// marshal funcs — UnsupportedTypeError, i.e. a panic-equivalent error path
// whenever Now was set) and the *http.Client (huge, transport-dependent
// shape that could leak proxy/TLS internals and also error on its
// CheckRedirect func field). GoString/Format only cover fmt verbs —
// encoding/json bypasses fmt.Formatter entirely, so json.Marshal(cfg)
// must itself be safe.
//
// The explicit struct below carries ConsumerKey MASKED (see maskCredential —
// a consumer key authenticates every token request, so it is a secret, not an
// identifier; the previous cleartext rendering contradicted SECURITY.md),
// Shortcode, Environment NAME ("sandbox"/"production", Python log_safe / TS
// toJSON parity) and Timeout. ConsumerSecret, Passkey, Now and HTTPClient are
// omitted by construction, so setting Now or injecting an HTTPClient can
// neither panic nor leak. See SECURITY.md.
func (c Config) MarshalJSON() ([]byte, error) {
	// safeConfig is the complete JSON shape: no secret, func or transport
	// fields exist here by design, so future Config fields are deny-by-
	// default (must be allow-listed explicitly to appear in logs).
	type safeConfig struct {
		ConsumerKey string `json:"ConsumerKey"`
		Shortcode   string `json:"Shortcode"`
		Environment string `json:"Environment"`
		Timeout     string `json:"Timeout"`
	}
	envName := "sandbox"
	if c.Environment == Production {
		envName = "production"
	}
	return json.Marshal(safeConfig{
		ConsumerKey: maskCredential(c.ConsumerKey),
		Shortcode:   c.Shortcode,
		Environment: envName,
		Timeout:     c.Timeout.String(),
	})
}

// trustedBaseURLs is the allowlist of Daraja platform base URLs. The OAuth
// leg ships the Basic-auth credential (consumer_key:consumer_secret) to
// this host, so a non-allowlisted base URL must be rejected before any
// network use — a confused-deputy base URL could otherwise harvest
// credentials. Mirrors python/mpesa/auth.py _TRUSTED_BASE_URLS and
// typescript/src/config.ts TRUSTED_BASE_URLS.
var trustedBaseURLs = map[string]bool{
	"https://sandbox.safaricom.co.ke": true,
	"https://api.safaricom.co.ke":     true,
}

// Validate checks that the Config fields are well-formed. An empty Shortcode
// is allowed (some APIs don't require one), but when present it must be 5–10
// digits. ConsumerKey must not contain ':' — it becomes the Basic-auth
// username in "key:secret" (docs/apis/oauth.md) and a colon would split
// credentials ambiguously at the gateway or a forward proxy. ConsumerKey and
// ConsumerSecret must be ASCII-only (Python auth.py + TS auth.ts parity):
// non-ASCII breaks Basic-auth encoding, which is defined over bytes, and
// would otherwise produce gateway-dependent credential corruption.
// ConsumerKey and ConsumerSecret must be non-empty (fail-fast at
// construction, Python MpesaClient.__init__ + TS Config constructor parity).
// The Environment's base URL must be in the trusted allowlist (Python
// auth.py _TRUSTED_BASE_URLS + TS TRUSTED_BASE_URLS parity).
func (c Config) Validate() error {
	if c.ConsumerKey == "" || c.ConsumerSecret == "" {
		return fmt.Errorf("mpesa: Config.ConsumerKey and Config.ConsumerSecret are required")
	}
	if c.Shortcode != "" {
		if ok, _ := regexp.MatchString(`^\d{5,10}$`, c.Shortcode); !ok {
			return fmt.Errorf("mpesa: invalid shortcode %q: must be 5–10 digits", c.Shortcode)
		}
	}
	if strings.Contains(c.ConsumerKey, ":") {
		return fmt.Errorf("mpesa: invalid ConsumerKey: must not contain ':' (Basic-auth separator)")
	}
	// ASCII gate: Basic-auth transmits "key:secret" as bytes (RFC 7617);
	// non-ASCII runes (>0x7F) have no canonical byte form and break auth
	// at the gateway or proxies. Reject explicitly with a field-named error.
	for _, r := range c.ConsumerKey {
		if r > 0x7F {
			return fmt.Errorf("mpesa: invalid ConsumerKey: must be ASCII-only (non-ASCII breaks Basic-auth)")
		}
	}
	for _, r := range c.ConsumerSecret {
		if r > 0x7F {
			return fmt.Errorf("mpesa: invalid ConsumerSecret: must be ASCII-only (non-ASCII breaks Basic-auth)")
		}
	}
	// Trusted-URL allowlist: the OAuth leg sends the Basic-auth credential
	// to Environment.BaseURL() — reject any non-allowlisted host before any
	// network use. Trailing slashes are stripped before the membership test
	// (Python auth.py parity). Environment.BaseURL() is derived from the
	// Environment enum, so this is a defense-in-depth guard against future
	// enum modifications or custom Environment values.
	baseURL := strings.TrimRight(c.Environment.BaseURL(), "/")
	if !trustedBaseURLs[baseURL] {
		return fmt.Errorf("mpesa: refusing untrusted base_url %q (want https://sandbox.safaricom.co.ke or https://api.safaricom.co.ke)", baseURL)
	}
	return nil
}

// redactCredentials renders r as JSON with the named secret fields replaced
// by [REDACTED]. It operates on serialized bytes, so it cannot recurse into
// the type's own Format/GoString hooks.
func redactCredentials(r any, secretFields ...string) string {
	b, err := json.Marshal(r)
	if err != nil {
		return "<unserializable>"
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return string(b)
	}
	for _, k := range secretFields {
		if _, ok := m[k]; ok {
			m[k] = "[REDACTED]"
		}
	}
	out, err := json.Marshal(m)
	if err != nil {
		return "<unserializable>"
	}
	return string(out)
}
