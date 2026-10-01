package mpesa

import (
	"strings"
	"testing"
)

// captureLogger is a test ErrorLogger that records the last diagnostic.
type captureLogger struct {
	status      int
	contentType string
	body        []byte
	called      bool
}

func (l *captureLogger) LogError(status int, contentType string, body []byte) {
	l.status = status
	l.contentType = contentType
	l.body = body
	l.called = true
}

func TestErrorFormatting(t *testing.T) {
	e := &Error{StatusCode: 400, RequestID: "27504-1", ErrorCode: "400.002.02", ErrorMessage: "Bad Request - Invalid BusinessShortCode"}
	msg := e.Error()
	for _, want := range []string{"400", "400.002.02", "Invalid BusinessShortCode", "27504-1"} {
		if !strings.Contains(msg, want) {
			t.Errorf("Error() = %q, want substring %q", msg, want)
		}
	}
}

// Tri-language parity with the Python/TypeScript sanitizers: beyond C0/DEL,
// C1 control runes and Unicode Cf format characters must be stripped, while
// printable emoji/astral text passes through untouched.
func TestSanitizeWireStringStripsC1AndCfRunes(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"C1 next line U+0085", "a\u0085b", "ab"},
		{"C1 APC U+009F", "a\u009Fb", "ab"},
		{"zero-width space U+200B", "a\u200Bb", "ab"},
		{"left-to-right mark U+200E", "a\u200Eb", "ab"},
		{"byte order mark U+FEFF", "a\uFEFFb", "ab"},
		{"mixed hostile run", "\u0085x\u009Fy\u200Bz\u200Ew\uFEFFv", "xyzwv"},
		{"emoji/astral survives", "paid \U0001F4B8 \U0001F480 done", "paid \U0001F4B8 \U0001F480 done"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeWireString(tc.in, maxWireFieldBytes); got != tc.want {
				t.Fatalf("sanitizeWireString(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// When the response body is not the standard envelope, callers must see a
// generic message — no content-type, body snippet, or response size.
func TestParseErrorNonEnvelopeGenericMessage(t *testing.T) {
	body := []byte("<html><body>WAF Blocked</body></html>")
	var logger captureLogger
	err := parseError(502, "text/html", body, &logger)

	e, ok := err.(*Error)
	if !ok {
		t.Fatalf("parseError returned %T, want *Error", err)
	}
	if e.StatusCode != 502 {
		t.Errorf("StatusCode = %d, want 502", e.StatusCode)
	}
	if e.ErrorMessage != "unexpected error response from gateway" {
		t.Errorf("ErrorMessage = %q, want generic message", e.ErrorMessage)
	}
	// The generic message must not leak content-type or body content.
	msg := e.Error()
	for _, leak := range []string{"text/html", "WAF", "Blocked", "502 bytes"} {
		if strings.Contains(msg, leak) {
			t.Errorf("Error() = %q, must not contain %q", msg, leak)
		}
	}
}

// When an ErrorLogger is configured, it must receive the full diagnostic
// (status, content-type, body) even though the caller sees a generic message.
func TestParseErrorLoggerReceivesDiagnostics(t *testing.T) {
	body := []byte("<html><body>WAF Blocked</body></html>")
	var logger captureLogger
	_ = parseError(502, "text/html", body, &logger)

	if !logger.called {
		t.Fatal("ErrorLogger.LogError was not called")
	}
	if logger.status != 502 {
		t.Errorf("logger status = %d, want 502", logger.status)
	}
	if logger.contentType != "text/html" {
		t.Errorf("logger contentType = %q, want %q", logger.contentType, "text/html")
	}
	if string(logger.body) != string(body) {
		t.Errorf("logger body = %q, want %q", logger.body, body)
	}
}

// When no logger is configured, detailed diagnostics are discarded —
// the caller still gets the generic message and no panic occurs.
func TestParseErrorNoLoggerNoPanic(t *testing.T) {
	body := []byte("<html><body>WAF Blocked</body></html>")
	err := parseError(502, "text/html", body, nil)

	e := err.(*Error)
	if e.ErrorMessage != "unexpected error response from gateway" {
		t.Errorf("ErrorMessage = %q, want generic message", e.ErrorMessage)
	}
}

// When the response IS the standard envelope, the logger must NOT be called
// and the caller sees the envelope fields as before.
func TestParseErrorEnvelopeNoLoggerCall(t *testing.T) {
	body := []byte(`{"requestId":"27504-1","errorCode":"400.002.02","errorMessage":"Bad Request"}`)
	var logger captureLogger
	err := parseError(400, "application/json", body, &logger)

	e := err.(*Error)
	if e.ErrorCode != "400.002.02" {
		t.Errorf("ErrorCode = %q, want %q", e.ErrorCode, "400.002.02")
	}
	if e.RequestID != "27504-1" {
		t.Errorf("RequestID = %q, want %q", e.RequestID, "27504-1")
	}
	if logger.called {
		t.Error("ErrorLogger.LogError must not be called for standard envelope responses")
	}
}
