// Errors: the typed surface for Daraja's standard error envelope.
package mpesa

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Error is the typed surface for non-2xx Daraja responses carrying the
// standard {requestId, errorCode, errorMessage} envelope.
type Error struct {
	StatusCode   int
	RequestID    string
	ErrorCode    string
	ErrorMessage string
}

func (e *Error) Error() string {
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
type errorEnvelope struct {
	RequestID    string `json:"requestId"`
	ErrorCode    string `json:"errorCode"`
	ErrorMessage string `json:"errorMessage"`
}

const (
	maxWireFieldBytes = 512
	maxSnippetBytes   = 200
)

// parseError converts a non-2xx response into the typed surface. Envelope
// fields are sanitized (control runes stripped, byte-capped) so hostile or
// corrupted gateway output can never inject newlines/escapes into logs. A
// body that is not the envelope at all (WAF pages, HTML errors) yields a
// diagnostic carrying content-type, byte length and an ASCII snippet.
func parseError(status int, contentType string, body []byte) error {
	var env errorEnvelope
	_ = json.Unmarshal(body, &env)
	e := &Error{
		StatusCode:   status,
		RequestID:    sanitizeWireString(env.RequestID, maxWireFieldBytes),
		ErrorCode:    sanitizeWireString(env.ErrorCode, maxWireFieldBytes),
		ErrorMessage: sanitizeWireString(env.ErrorMessage, maxWireFieldBytes),
	}
	if env.ErrorCode == "" && env.ErrorMessage == "" && env.RequestID == "" {
		e.ErrorMessage = fmt.Sprintf("unparseable error body (%d bytes, content-type %q): %q",
			len(body), contentType, asciiSnippet(string(body), maxSnippetBytes))
	}
	return e
}

// sanitizeWireString strips control runes (<0x20 and DEL) and truncates to
// limit bytes on a rune boundary.
func sanitizeWireString(s string, limit int) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			continue
		}
		size := len(string(r))
		if n+size > limit {
			break
		}
		b.WriteRune(r)
		n += size
	}
	return b.String()
}

// asciiSnippet keeps only printable ASCII up to limit bytes for diagnostics.
func asciiSnippet(s string, limit int) string {
	var b strings.Builder
	for _, r := range s {
		if b.Len() >= limit {
			break
		}
		if r < 0x20 || r > 0x7e {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
