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
// Arrays and objects are hard errors: swallowing them as raw JSON text would
// contradict the documented contract (strings/numbers/booleans/null only)
// and let one mistyped envelope field surface as "[...]"/"{...}" literal
// text instead of falling back to the generic error path.
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
	if len(s) > 0 && (s[0] == '[' || s[0] == '{') {
		return fmt.Errorf("mpesa: cannot parse %s as string", b)
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
// non-integral floats like 1.5 are rejected. All parsed values must fit in
// int64; out-of-range values are hard errors.
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
		// non-integral, non-finite or out-of-range/lossy values stay hard errors.
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

// maxExactInt64Float is the smallest float64 that is NOT a valid int64.
// math.MaxInt64 does not exist as a float64: 2^63-1 is not representable in
// binary64, so math.MaxInt64 rounds UP to exactly 2^63. Comparing
// f <= math.MaxInt64 therefore admits a value one past the real bound, and
// int64(f) for exactly 2^63 is implementation-defined (on amd64 it yields
// -2^63 — a silent sign flip). Compare against this literal instead.
const maxExactInt64Float = 9223372036854775808.0

// floatToInt64 converts f to int64, rejecting anything outside the closed
// range [-2^63, 2^63-1] and all non-finite values.
//
// The upper bound matters: math.MinInt64 IS exactly representable, so
// f < math.MinInt64 is a correct lower test, but the upper test must use the
// literal 2^63 rather than math.MaxInt64 (which rounds up to it). Callers
// previously used `f <= math.MaxInt64`, so a JSON value of exactly 2^63
// converted to a negative int64 while the comment claimed out-of-range input
// was rejected. The lower bound is left as math.MinInt64 deliberately —
// there is no rounding problem there.
func floatToInt64(f float64) (int64, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) || f < math.MinInt64 || f >= maxExactInt64Float {
		return 0, fmt.Errorf("mpesa: value %v is outside the int64 range", f)
	}
	return int64(f), nil
}

// parseIntegralFloat converts an integral-float rendering to int64,
// rejecting non-integral fractions, non-finite values and out-of-int64
// magnitudes. It mirrors classification.go's lenient fallback so OAuth
// TTLs (Python coerce_int integral-float branch, TS safeJsonInt) accept
// 3599.0 while 1.5/NaN/Inf/1e30 stay errors.
// It also rejects values that lose precision when parsed as float64
// (e.g. "-9223372036854775809" which rounds to MinInt64 in float64).
func parseIntegralFloat(s string) (int64, error) {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
		return 0, fmt.Errorf("not an integral float: %q", s)
	}
	// Range gate BEFORE the conversion: int64(f) for f >= 2^63 is
	// implementation-defined and silently negative on amd64.
	v, cerr := floatToInt64(f)
	if cerr != nil {
		return 0, fmt.Errorf("not an integral float: %q", s)
	}
	// Precision gate: if the original string was an integer (no decimal
	// point), verify the round-trip matches. This catches values like
	// "-9223372036854775809" which parse as float64 but round to
	// MinInt64, losing the fact they were out of range.
	if !strings.Contains(s, ".") && !strings.Contains(s, "e") && !strings.Contains(s, "E") {
		if strconv.FormatInt(v, 10) != s {
			return 0, fmt.Errorf("not an integral float: %q", s)
		}
	}
	return v, nil
}
