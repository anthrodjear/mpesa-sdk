// Results: async Result envelopes posted to ResultURL and their parsers.

package mpesa

import (
	"encoding/json"
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
func (r AsyncResultBody) Parameters() map[string]string {
	out := make(map[string]string)
	if r.ResultParameters == nil {
		return out
	}
	for _, p := range r.ResultParameters.ResultParameter {
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

// ParseBalanceSegments splits the Account Balance result blob — segments
// joined by "&", fields joined by "|" into typed rows. Per account-balance.md
// tolerance requirements, trailing separators, unknown extra fields and
// MALFORMED ROWS ARE SKIPPED AND COUNTED in skipped, never fatal. Parsed
// floats are display-only; BalanceSegment.Raw preserves each source segment.
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
			v, err := strconv.ParseFloat(strings.TrimSpace(fields[2+i]), 64)
			if err != nil {
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
