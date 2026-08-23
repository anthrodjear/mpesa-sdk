// Callbacks: payloads Safaricom POSTs to CallBackURL (STK family).

package mpesa

import (
	"encoding/json"
	"math"
	"strings"
)

// StkCallback is the top-level envelope POSTed to CallBackURL.
//
// Safaricom callbacks carry NO HMAC signature, so ingestion endpoints must
// harden themselves: bind on CheckoutRequestID, validate amount/phone against
// the original request, and wrap request bodies in http.MaxBytesReader
// (recommend >=1 MiB cap) before unmarshalling into this type.
type StkCallback struct {
	Body StkCallbackBody `json:"Body"`
}

// StkCallbackBody wraps the inner stkCallback object.
type StkCallbackBody struct {
	StkCallback StkCallbackResult `json:"stkCallback"`
}

// StkCallbackResult is the transaction outcome. CallbackMetadata is absent on
// failures — parse defensively via MetadataMap.
type StkCallbackResult struct {
	MerchantRequestID string            `json:"MerchantRequestID"`
	CheckoutRequestID string            `json:"CheckoutRequestID"`
	ResultCode        FlexString        `json:"ResultCode"`
	ResultDesc        string            `json:"ResultDesc"`
	CallbackMetadata  *CallbackMetadata `json:"CallbackMetadata,omitempty"`
}

func (r StkCallbackResult) metadataItems() []MetadataItem {
	if r.CallbackMetadata == nil {
		return nil
	}
	return r.CallbackMetadata.Item
}

// MetadataMap flattens callback metadata items, tolerating absent metadata;
// integral values decode as int64, decimals as float64. On duplicate names
// the FIRST item wins — check DuplicateKeys to detect lossy collisions.
func (r StkCallbackResult) MetadataMap() map[string]any {
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
func (r StkCallbackResult) DuplicateKeys() int {
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
