// Errors: the typed surface for Daraja's standard error envelope.
package mpesa

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MpesaError is the typed surface for non-2xx Daraja responses carrying the
// standard {requestId, errorCode, errorMessage} envelope.
type MpesaError struct {
	StatusCode   int
	RequestID    string
	ErrorCode    string
	ErrorMessage string
}

// Error is a deprecated alias for MpesaError, kept for backward compatibility.
// Existing code using mpesa.Error continues to compile; new code should use
// MpesaError for cross-language consistency (Python MpesaError, TypeScript MpesaError).
//
// Deprecated: use MpesaError instead.
type Error = MpesaError

func (e *MpesaError) Error() string {
	parts := []string{fmt.Sprintf("HTTP %d", e.StatusCode)}
	if e.ErrorMessage != "" {
		parts = append(parts, e.ErrorMessage)
	}
	if e.ErrorCode != "" {
		parts = append(parts, "["+e.ErrorCode+"]")
	}
	if e.RequestID != "" {
		parts = append(parts, "requestId="+e.RequestID)
	}
	return "mpesa: " + strings.Join(parts, " ")
}

// errorEnvelope is the wire shape of Daraja's synchronous error body.
//
// Every field is a FlexString rather than a string: json.Unmarshal into a
// struct aborts and discards ALL fields on the FIRST type mismatch, so a
// gateway that sends `"errorCode": 401` as a bare number used to flatten the
// whole envelope into "unexpected error response from gateway" — losing the
// requestId, the errorMessage and, critically, the errorCode the 401 retry
// probe in Client.post keys on. FlexString coerces strings, numbers, booleans
// and null, so a single mistyped field can no longer erase the others.
type errorEnvelope struct {
	RequestID    FlexString `json:"requestId"`
	ErrorCode    FlexString `json:"errorCode"`
	ErrorMessage FlexString `json:"errorMessage"`
}

const (
	maxWireFieldBytes = 512
	maxSnippetBytes   = 200
)

// ErrorLogger receives detailed diagnostic information about non-standard
// error responses (WAF pages, HTML errors, etc.). Implementations must be
// safe for concurrent use. When nil, detailed diagnostics are discarded.
type ErrorLogger interface {
	LogError(status int, contentType string, body []byte)
}

// parseError converts a non-2xx response into the typed surface. Envelope
// fields are sanitized (control runes stripped, byte-capped) so hostile or
// corrupted gateway output can never inject newlines/escapes into logs.
//
// Two distinct failure modes are handled separately:
//
//   - "not JSON at all" (WAF pages, HTML, truncated bodies, bare scalars,
//     arrays) — json.Unmarshal into errorEnvelope fails and the caller sees a
//     generic message, while detailed diagnostics (content-type, byte length,
//     ASCII snippet) are forwarded to the optional logger.
//   - "JSON with wrong types" — the tolerant FlexString fields absorb the
//     mismatch, so whatever survived decoding still reaches the caller. Only a
//     body that decodes as JSON but carries NO envelope field at all ("null",
//     "{}") falls back to the generic message.
func parseError(status int, contentType string, body []byte, logger ErrorLogger) error {
	var env errorEnvelope
	notJSON := json.Unmarshal(body, &env) != nil
	e := &MpesaError{
		StatusCode:   status,
		RequestID:    sanitizeWireString(string(env.RequestID), maxWireFieldBytes),
		ErrorCode:    sanitizeWireString(string(env.ErrorCode), maxWireFieldBytes),
		ErrorMessage: sanitizeWireString(string(env.ErrorMessage), maxWireFieldBytes),
	}
	if notJSON || (env.ErrorCode == "" && env.ErrorMessage == "" && env.RequestID == "") {
		e.ErrorMessage = "unexpected error response from gateway"
		if logger != nil {
			logger.LogError(status, contentType, body)
		}
	}
	return e
}

// sanitizeWireString strips control runes — the C0 range and DEL, plus the
// C1 range (U+0080–U+009F) — and Unicode Cf format characters (zero-width
// spaces, BOM, directional marks), then truncates to limit bytes on a rune
// boundary. Tri-language parity with the Python/TypeScript sanitizer engines:
// hostile gateway output cannot smuggle invisible or log-injecting characters
// into diagnostics through any binding.
func sanitizeWireString(s string, limit int) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		// utf8.RuneLen(r) rather than len(string(r)): the latter allocates a
		// fresh string for every rune on a path that runs over every error
		// field the gateway ever returns.
		size := utf8.RuneLen(r)
		if size < 0 || n+size > limit {
			break
		}
		b.WriteRune(r)
		n += size
	}
	return b.String()
}
