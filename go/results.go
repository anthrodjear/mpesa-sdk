// Results: async Result envelopes posted to ResultURL and their parsers.

package mpesa

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// AsyncResult is the shared envelope POSTed to ResultURL by async APIs.
type AsyncResult struct {
	Result AsyncResultBody `json:"Result"`
}

// AsyncResultBody carries header fields plus the Key/Value parameter list.
type AsyncResultBody struct {
	ResultType               FlexString        `json:"ResultType"`
	ResultCode               FlexString        `json:"ResultCode"`
	ResultDesc               string            `json:"ResultDesc"`
	OriginatorConversationID string            `json:"OriginatorConversationID"`
	ConversationID           string            `json:"ConversationID"`
	TransactionID            string            `json:"TransactionID"`
	ResultParameters         *ResultParameters `json:"ResultParameters,omitempty"`
	ReferenceData            *ReferenceData    `json:"ReferenceData,omitempty"`
}

// Parameters flattens ResultParameters tolerating absent sections; values are
// rendered leniently as strings since Safaricom mixes types.
//
// First-wins: on duplicate Key entries (gateway retries) the FIRST value
// wins, matching MetadataMap(), Python parameters()/metadata() and
// TypeScript MetadataMap. Earlier last-wins behavior silently diverged
// across SDKs on duplicate keys — fixed to first-wins.
func (r AsyncResultBody) Parameters() map[string]string {
	out := make(map[string]string)
	if r.ResultParameters == nil {
		return out
	}
	for _, p := range r.ResultParameters.ResultParameter {
		if _, exists := out[p.Key]; exists {
			continue
		}
		fs := FlexString("")
		if err := json.Unmarshal(p.Value, &fs); err != nil {
			out[p.Key] = string(p.Value)
			continue
		}
		out[p.Key] = fs.String()
	}
	return out
}

// ResultParameters wraps the repeated {Key,Value} objects.
type ResultParameters struct {
	ResultParameter []ResultParameter `json:"ResultParameter"`
}

// ResultParameter is one async-result key/value pair with a raw value.
type ResultParameter struct {
	Key   string          `json:"Key"`
	Value json.RawMessage `json:"Value,omitempty"`
}

// ReferenceData wraps the optional ReferenceItem echo some async results
// carry (e.g. B2C QueueTimeoutURL).
type ReferenceData struct {
	ReferenceItem []ReferenceItem `json:"ReferenceItem,omitempty"`
}

// UnmarshalJSON tolerates both observed Safaricom shapes: ReferenceItem as a
// single object (b2c.md sample) or as a list.
func (rd *ReferenceData) UnmarshalJSON(b []byte) error {
	var probe struct {
		ReferenceItem json.RawMessage `json:"ReferenceItem"`
	}
	if err := json.Unmarshal(b, &probe); err != nil {
		return err
	}
	if len(probe.ReferenceItem) == 0 || string(probe.ReferenceItem) == "null" {
		return nil
	}
	var single ReferenceItem
	if err := json.Unmarshal(probe.ReferenceItem, &single); err == nil {
		rd.ReferenceItem = []ReferenceItem{single}
		return nil
	}
	var many []ReferenceItem
	if err := json.Unmarshal(probe.ReferenceItem, &many); err != nil {
		return err
	}
	rd.ReferenceItem = many
	return nil
}

// ReferenceItem is one key/value echo entry of async-result ReferenceData.
type ReferenceItem struct {
	Key   string `json:"Key"`
	Value string `json:"Value"`
}

// BalanceSegment is one parsed account row of an Account Balance result.
// The floats are display-only conveniences — Raw preserves the authoritative
// source segment verbatim.
type BalanceSegment struct {
	AccountName string
	Currency    string
	Available   float64
	Uncleared   float64
	Reserved    float64
	Min         float64
	Raw         string
}

// balanceNumRe is the ASCII gate for balance amounts (Python results.py
// _BALANCE_NUM_RE parity): optional sign, 1–18 integer digits, optional
// fraction with 1–6 digits. It rejects what strconv.ParseFloat would
// otherwise accept but must not survive: underscore separators ("1_000"),
// hex/octal ("0x10"), Unicode Nd digits ("١٢٣"), overlong digit runs, and
// empty/alpha strings. The 18-digit cap plus the post-parse 2^53 check keep
// display floats exactly representable.
var balanceNumRe = regexp.MustCompile(`^[+-]?[0-9]{1,18}(\.[0-9]{1,6})?$`)

// maxSafeBalance is 2^53: floats above this lose integer precision, so a
// hostile or corrupt balance blob must be skipped rather than rendered as a
// precision-corrupted display value (Python coerce_amount parity).
const maxSafeBalance = float64(1 << 53)

// maxSafeBalanceStr is the decimal rendering of 2^53 for exact string
// comparison (see exceedsSafeBalance).
const maxSafeBalanceStr = "9007199254740992"

// exceedsSafeBalance reports whether the ASCII-gated decimal text exceeds
// ±2^53 in magnitude WITHOUT rounding through float64 first.
//
// Why string comparison (precision trap): float64 cannot represent
// 9007199254740993 — ParseFloat rounds it to exactly 9007199254740992, so
// a post-parse `math.Abs(v) > 2^53` check passes a hostile value that is
// textually beyond the safe-integer boundary. Comparing the integer digits
// (and any non-zero fraction when equal to max) rejects the hostile text
// exactly. Call only with balanceNumRe-passing input.
func exceedsSafeBalance(text string) bool {
	s := text
	if len(s) > 0 && (s[0] == '+' || s[0] == '-') {
		s = s[1:]
	}
	intPart := s
	fracPart := ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intPart = s[:i]
		fracPart = s[i+1:]
	}
	// Strip leading zeros so length comparison is by magnitude.
	intPart = strings.TrimLeft(intPart, "0")
	if intPart == "" {
		intPart = "0"
	}
	if len(intPart) > len(maxSafeBalanceStr) {
		return true
	}
	if len(intPart) < len(maxSafeBalanceStr) {
		return false
	}
	// Same digit count: lexicographic compare equals numeric compare.
	if intPart > maxSafeBalanceStr {
		return true
	}
	if intPart < maxSafeBalanceStr {
		return false
	}
	// Integer part is exactly 2^53: any non-zero fraction exceeds it.
	for i := 0; i < len(fracPart); i++ {
		if fracPart[i] != '0' {
			return true
		}
	}
	return false
}

// ParseBalanceSegments splits the Account Balance result blob — segments
// joined by "&", fields joined by "|" into typed rows. Per account-balance.md
// tolerance requirements, trailing separators, unknown extra fields and
// MALFORMED ROWS ARE SKIPPED AND COUNTED in skipped, never fatal. Parsed
// floats are display-only; BalanceSegment.Raw preserves each source segment.
//
// Amount hardening (N8a, Python results.py parity): each of the four numeric
// fields is first gated by balanceNumRe (ASCII shape), then parsed, then
// rejected if NaN/Inf or beyond ±2^53. This blocks "NaN"/"Inf"/"1e30"
// smuggling through ParseFloat's lenient grammar.
func ParseBalanceSegments(s string) (segments []BalanceSegment, skipped int) {
	for _, seg := range strings.Split(s, "&") {
		fields := strings.Split(seg, "|")
		if len(strings.TrimSpace(strings.Join(fields, ""))) == 0 {
			continue
		}
		row := BalanceSegment{Raw: seg}
		if len(fields) < 6 {
			skipped++
			continue
		}
		row.AccountName = strings.TrimSpace(fields[0])
		row.Currency = strings.TrimSpace(fields[1])
		nums := [4]float64{}
		bad := false
		for i := range nums {
			// ASCII gate BEFORE ParseFloat: float() would otherwise accept
			// "1_000" and Unicode Nd digits that must not survive.
			text := strings.TrimSpace(fields[2+i])
			if !balanceNumRe.MatchString(text) {
				skipped++
				bad = true
				break
			}
			// Precision gate BEFORE float rounding: 9007199254740993
			// parses to exactly 2^53, so the check must be textual.
			if exceedsSafeBalance(text) {
				skipped++
				bad = true
				break
			}
			v, err := strconv.ParseFloat(text, 64)
			if err != nil {
				skipped++
				bad = true
				break
			}
			// Non-finite (NaN/±Inf) defense-in-depth: the ASCII gate
			// already blocks these spellings, but a future regex change
			// must never surface them as display values.
			if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > maxSafeBalance {
				skipped++
				bad = true
				break
			}
			nums[i] = v
		}
		if bad {
			continue
		}
		row.Available, row.Uncleared, row.Reserved, row.Min = nums[0], nums[1], nums[2], nums[3]
		segments = append(segments, row)
	}
	return segments, skipped
}
