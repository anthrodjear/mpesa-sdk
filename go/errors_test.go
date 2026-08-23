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
