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
// GoString/Format redact.
type Config struct {
	ConsumerKey    string
	ConsumerSecret string
	Shortcode      string
	Passkey        string
	Environment    Environment
	Timeout        time.Duration
	Now            func() time.Time
	HTTPClient     *http.Client
}

// GoString redacts ConsumerSecret and Passkey for %#v formatting.
func (c Config) GoString() string {
	return fmt.Sprintf("mpesa.Config{ConsumerKey:%q Shortcode:%q Environment:%d Timeout:%s secrets:redacted}",
		c.ConsumerKey, c.Shortcode, int(c.Environment), c.Timeout)
}

// Format routes EVERY fmt verb (%v, %+v, %s, ...) through the redacted form;
// GoStringer alone only covers %#v, while %+v prints raw struct fields.
func (c Config) Format(f fmt.State, verb rune) {
	_, _ = fmt.Fprint(f, c.GoString())
}

// MarshalJSON renders Config for structured logging with live secrets
// replaced by [REDACTED].
//
// Why this exists (OWASP log-injection / secret-scanning baseline):
// GoString/Format only cover fmt verbs — encoding/json bypasses
// fmt.Formatter entirely, so json.Marshal(cfg) used to emit
// ConsumerSecret and Passkey in cleartext to log aggregators.
// MarshalJSON closes that path; raw struct copies still carry secrets,
// so never marshal a shadow struct — always marshal Config itself.
//
// ConsumerKey stays visible by design (GoString parity across SDKs);
// ConsumerSecret and Passkey are redacted. See SECURITY.md.
func (c Config) MarshalJSON() ([]byte, error) {
	type shadow Config // avoid recursion into this method
	b, err := json.Marshal(shadow(c))
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return b, nil
	}
	m["ConsumerSecret"] = "[REDACTED]"
	m["Passkey"] = "[REDACTED]"
	return json.Marshal(m)
}

// Validate checks that the Config fields are well-formed. An empty Shortcode
// is allowed (some APIs don't require one), but when present it must be 5–10
// digits. ConsumerKey must not contain ':' — it becomes the Basic-auth
// username in "key:secret" (docs/apis/oauth.md) and a colon would split
// credentials ambiguously at the gateway or a forward proxy.
func (c Config) Validate() error {
	if c.Shortcode != "" {
		if ok, _ := regexp.MatchString(`^\d{5,10}$`, c.Shortcode); !ok {
			return fmt.Errorf("mpesa: invalid shortcode %q: must be 5–10 digits", c.Shortcode)
		}
	}
	if strings.Contains(c.ConsumerKey, ":") {
		return fmt.Errorf("mpesa: invalid ConsumerKey: must not contain ':' (Basic-auth separator)")
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
