// Errors: the typed surface for Daraja's standard error envelope.

package mpesa

import (
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
