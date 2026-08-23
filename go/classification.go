// Classification: retry-safe bucketing of Daraja result codes.

package mpesa

import (
	"math"
	"strconv"
	"strings"
)

// ResultClass buckets a Daraja result code for retry-safe decisions.
type ResultClass string

const (
	// ResultClassSuccess is wire ResultCode 0 — settled successfully.
	ResultClassSuccess ResultClass = "success"
	// ResultClassFailure is a known terminal failure across the STK Push
	// (stk-push.md), B2C (b2c.md) and Account Balance (account-balance.md)
	// catalogs.
	ResultClassFailure ResultClass = "failure"
	// ResultClassIndeterminate covers unknown, non-terminal and non-numeric
	// codes: never auto-fail, keep querying (ADR-010).
	ResultClassIndeterminate ResultClass = "indeterminate"
)

// resultCodeFailure unions the documented terminal-failure catalogs:
// STK Push {1,17,1019,1025,1032,2001,9999} · B2C {2,3,4,8,11,21,2001,2006,
// 2028,2040,8006} · Account Balance {15,22} (17/21 shared with B2C).
var resultCodeFailure = map[int64]bool{
	1: true, 2: true, 3: true, 4: true, 8: true, 11: true, 15: true, 17: true,
	21: true, 22: true, 1019: true, 1025: true, 1032: true, 2001: true,
	2006: true, 2028: true, 2040: true, 8006: true, 9999: true,
}

func parseResultCode(code string) (int64, bool) {
	s := strings.TrimSpace(strings.Trim(code, `"`))
	if v, err := strconv.ParseInt(s, 10, 64); err == nil {
		return v, true
	}
	// Lenient fallback: integral floats only ("0.0" → 0); non-integral or
	// out-of-range values are not result codes.
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f != math.Trunc(f) || f < math.MinInt64 || f > math.MaxInt64 {
		return 0, false
	}
	return int64(f), true
}

// ClassifyResultCode maps a result code to its safety class. Success is only
// ever 0; failure is limited to documented terminal codes across all API
// catalogs; everything else — including unknown or non-numeric codes — is
// indeterminate and must never be auto-failed (debits have been observed
// landing minutes later).
func ClassifyResultCode(code string) ResultClass {
	v, ok := parseResultCode(code)
	if !ok {
		return ResultClassIndeterminate
	}
	switch {
	case v == 0:
		return ResultClassSuccess
	case resultCodeFailure[v]:
		return ResultClassFailure
	default:
		return ResultClassIndeterminate
	}
}

// Classify buckets the callback outcome per ADR-010 safety rules.
func (r StkCallbackResult) Classify() ResultClass {
	return ClassifyResultCode(r.ResultCode.String())
}

// Classify buckets the async result outcome per ADR-010 safety rules.
func (r AsyncResultBody) Classify() ResultClass {
	return ClassifyResultCode(r.ResultCode.String())
}
