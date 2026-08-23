// Coercion: lenient JSON decoding for Safaricom's inconsistent value types.

package mpesa

import (
	"encoding/json"
	"fmt"
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
// (doubled quotes, alphabetic content) is a hard error.
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
		v, err := strconv.ParseInt(str, 10, 64)
		if err != nil {
			return fmt.Errorf("mpesa: cannot parse %s as integer", b)
		}
		*f = FlexInt64(v)
		return nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return fmt.Errorf("mpesa: cannot parse %s as integer", b)
	}
	*f = FlexInt64(v)
	return nil
}
