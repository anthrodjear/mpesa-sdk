// Callbacks: payloads Safaricom POSTs to CallBackURL (STK family).

package mpesa

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

// maxCallbackBodyBytes caps the accepted callback body size at 1 MiB to
// prevent memory exhaustion from oversized or malicious POSTs.
const maxCallbackBodyBytes = 1 << 20

// STKCallback is the top-level envelope POSTed to CallBackURL.
//
// Safaricom callbacks carry NO HMAC signature, so ingestion endpoints must
// harden themselves. Ranked controls: settle ONLY via STKQuery with
// ResultCode==0 bound to YOUR CheckoutRequestID record (a body that parses
// is never proof of payment — forged callbacks parse fine); gate the
// endpoint with callbacktoken.go's bearer-capability URL tokens;
// CheckoutRequestID binding is a DEDUP/IDEMPOTENCY control, not origin
// authentication — a forged body carries whatever IDs its author likes.
// Validate amount/phone against the original request and wrap bodies in
// http.MaxBytesReader (recommend >=1 MiB cap) before unmarshalling.
type STKCallback struct {
	Body STKCallbackBody `json:"Body"`
}

// STKCallbackBody wraps the inner stkCallback object.
type STKCallbackBody struct {
	STKCallback STKCallbackResult `json:"stkCallback"`
}

// STKCallbackResult is the transaction outcome. CallbackMetadata is absent on
// failures — parse defensively via MetadataMap.
type STKCallbackResult struct {
	MerchantRequestID string            `json:"MerchantRequestID"`
	CheckoutRequestID string            `json:"CheckoutRequestID"`
	ResultCode        FlexString        `json:"ResultCode"`
	ResultDesc        string            `json:"ResultDesc"`
	CallbackMetadata  *CallbackMetadata `json:"CallbackMetadata,omitempty"`
}

func (r STKCallbackResult) metadataItems() []MetadataItem {
	if r.CallbackMetadata == nil {
		return nil
	}
	return r.CallbackMetadata.Item
}

// MetadataMap flattens callback metadata items, tolerating absent metadata;
// integral values decode as int64, decimals as float64. On duplicate names
// the FIRST item wins — check DuplicateKeys to detect lossy collisions.
func (r STKCallbackResult) MetadataMap() map[string]any {
	out := make(map[string]any)
	for _, item := range r.metadataItems() {
		if _, exists := out[item.Name]; !exists {
			out[item.Name] = item.decodedValue()
		}
	}
	return out
}

// DuplicateKeys reports how many metadata items were shadowed by an earlier
// same-named item (Safaricom duplicates have been observed on retries).
func (r STKCallbackResult) DuplicateKeys() int {
	seen := make(map[string]bool)
	dupes := 0
	for _, item := range r.metadataItems() {
		if seen[item.Name] {
			dupes++
			continue
		}
		seen[item.Name] = true
	}
	return dupes
}

// ParseSTKCallback decodes a raw callback POST body into its outcome,
// accepting EITHER Safaricom's full envelope {"Body":{"stkCallback":…}}
// OR a bare stkCallback result object (fixtures, replayed captures).
// Shape problems are loud errors; absent CallbackMetadata stays tolerated —
// read values defensively via MetadataMap. Bodies carry NO signature: cap
// them upstream (http.MaxBytesReader ≥ 1 MiB). Binding on CheckoutRequestID
// against your own request record dedups/idempotency-guards processing —
// it is NOT origin authentication; settle via STKQuery before any
// irreversible action.
func ParseSTKCallback(body []byte) (*STKCallbackResult, error) {
	if len(body) > maxCallbackBodyBytes {
		return nil, fmt.Errorf("mpesa: callback body too large (%d bytes, max %d)", len(body), maxCallbackBodyBytes)
	}
	var envelope struct {
		Body *struct {
			StkCallback *STKCallbackResult `json:"stkCallback"`
		} `json:"Body"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("mpesa: parse stk callback body: %w", err)
	}
	if envelope.Body != nil && envelope.Body.StkCallback != nil {
		return envelope.Body.StkCallback, nil
	}
	var bare STKCallbackResult
	if err := json.Unmarshal(body, &bare); err != nil {
		return nil, fmt.Errorf("mpesa: unexpected stk callback shape: "+
			"want {\"Body\":{\"stkCallback\":{…}}} or a bare result object: %w", err)
	}
	if bare.ResultCode.String() == "" && bare.MerchantRequestID == "" &&
		bare.CheckoutRequestID == "" {
		return nil, fmt.Errorf("mpesa: unexpected stk callback shape: " +
			"missing Body.stkCallback")
	}
	return &bare, nil
}

// CallbackMetadata holds the Item list Safaricom sends on success.
type CallbackMetadata struct {
	Item []MetadataItem `json:"Item,omitempty"`
}

// MetadataItem is one named metadata value; Value stays raw because Safaricom
// mixes numeric and string encodings.
type MetadataItem struct {
	Name  string          `json:"Name"`
	Value json.RawMessage `json:"Value,omitempty"`
}

// decodedValue coerces raw JSON leniently: empty/null → nil (explicit absence,
// never a fake zero); integers without ./e/E → int64 (preserves
// TransactionDate/PhoneNumber magnitudes); then float64, string, bool, and
// finally raw bytes for anything unrecognized.
func (m MetadataItem) decodedValue() any {
	raw := strings.TrimSpace(string(m.Value))
	if raw == "" || raw == "null" {
		return nil
	}
	var f float64
	if err := json.Unmarshal(m.Value, &f); err == nil {
		if !strings.ContainsAny(raw, ".eE") && f >= math.MinInt64 && f <= math.MaxInt64 {
			return int64(f)
		}
		return f
	}
	var s string
	if err := json.Unmarshal(m.Value, &s); err == nil {
		return s
	}
	var b bool
	if err := json.Unmarshal(m.Value, &b); err == nil {
		return b
	}
	return m.Value
}
