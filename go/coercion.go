// Coercion: lenient JSON decoding for Safaricom's inconsistent value types.

package mpesa

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// FlexString coerces JSON strings or numbers into a Go string. Daraja mixes
// both (e.g. STK Query ResultCode arrives as "1032" in some captures, 1032 in
// others).
type FlexString string

// UnmarshalJSON accepts quoted strings, bare numbers, booleans, and null.
func (f *FlexString) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "null" || s == "" {
		*f = ""
		return nil
	}
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		var v string
		if err := json.Unmarshal(b, &v); err != nil {
			return err
		}
		*f = FlexString(v)
		return nil
	}
	var num json.Number
	if err := json.Unmarshal(b, &num); err == nil {
		*f = FlexString(num.String())
		return nil
	}
	*f = FlexString(s)
	return nil
}

// String returns the coerced wire representation of the value.
func (f FlexString) String() string { return string(f) }

// FlexInt64 coerces JSON numbers or numeric strings into an int64. OAuth's
// expires_in arrives as the STRING "3599" in official captures and as a bare
// number elsewhere.
type FlexInt64 int64

// UnmarshalJSON accepts quoted numeric strings, bare numbers, and null;
// null or "" map to 0 — callers treat <=0 as TTL unknown. Malformed input
// (doubled quotes, alphabetic content) is a hard error. Integral floats
// like 3599.0 are accepted (Python coerce_int + TS safeJsonInt parity);
// non-integral floats like 1.5 are rejected.
func (f *FlexInt64) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "null" || s == "" {
		*f = 0
		return nil
	}
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		var str string
		if err := json.Unmarshal(b, &str); err != nil {
			return err
		}
		str = strings.TrimSpace(str)
		if str == "" {
			*f = 0
			return nil
		}
		// Strict integer fast path: plain ASCII digits with optional sign.
		if v, err := strconv.ParseInt(str, 10, 64); err == nil {
			*f = FlexInt64(v)
			return nil
		}
		// Lenient fallback: integral floats only ("3599.0" → 3599);
		// non-integral, non-finite or out-of-range values stay hard errors.
		// Pattern copied from classification.go parseResultCode.
		if v, err := parseIntegralFloat(str); err == nil {
			*f = FlexInt64(v)
			return nil
		}
		return fmt.Errorf("mpesa: cannot parse %s as integer", b)
	}
	// Strict integer fast path for bare numbers.
	if v, err := strconv.ParseInt(s, 10, 64); err == nil {
		*f = FlexInt64(v)
		return nil
	}
	// Lenient fallback: bare integral floats only (3599.0 → 3599).
	if v, err := parseIntegralFloat(s); err == nil {
		*f = FlexInt64(v)
		return nil
	}
	return fmt.Errorf("mpesa: cannot parse %s as integer", b)
}

// parseIntegralFloat converts an integral-float rendering to int64,
// rejecting non-integral fractions, non-finite values and out-of-int64
// magnitudes. It mirrors classification.go's lenient fallback so OAuth
// TTLs (Python coerce_int integral-float branch, TS safeJsonInt) accept
// 3599.0 while 1.5/NaN/Inf/1e30 stay errors.
func parseIntegralFloat(s string) (int64, error) {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || f < math.MinInt64 || f > math.MaxInt64 {
		return 0, fmt.Errorf("not an integral float: %q", s)
	}
	return int64(f), nil
}
