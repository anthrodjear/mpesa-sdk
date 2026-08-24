package mpesa

import (
	"strings"
	"testing"
)

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
