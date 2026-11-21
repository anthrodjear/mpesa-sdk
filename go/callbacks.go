// Callbacks: payloads Safaricom POSTs to CallBackURL (STK family).

package mpesa

import (
	"encoding/json"
	"fmt"
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

	// metaCache is built once by UnmarshalJSON (a pointer so value copies of
	// the result share it). It is nil for hand-built values, which fall back
	// to computing the view on demand in the accessors below.
	metaCache *stkMetadataCache
}

// stkMetadataCache is the flattened, first-wins view of a callback's metadata,
// built at parse time so repeated accessor calls do not re-decode every item.
type stkMetadataCache struct {
	values map[string]any
	dupes  int
}

// buildSTKMetadataCache flattens items with first-wins semantics and counts
// shadowed duplicates. It is the single source of truth for both accessors.
func buildSTKMetadataCache(items []MetadataItem) *stkMetadataCache {
	values := make(map[string]any)
	seen := make(map[string]bool)
	dupes := 0
	for _, item := range items {
		if seen[item.Name] {
			dupes++
			continue
		}
		seen[item.Name] = true
		values[item.Name] = item.decodedValue()
	}
	return &stkMetadataCache{values: values, dupes: dupes}
}

// UnmarshalJSON decodes the wire shape and eagerly builds the flattened
// metadata view. The alias avoids recursion (and leaves metaCache unset until
// we assign it here); FlexString still decodes through its own UnmarshalJSON.
func (r *STKCallbackResult) UnmarshalJSON(b []byte) error {
	type plain STKCallbackResult
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*r = STKCallbackResult(p)
	r.metaCache = buildSTKMetadataCache(r.metadataItems())
	return nil
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
//
// The flattened view is built once at parse time; each call returns a fresh
// map (a shallow copy of the cached view), so callers may freely mutate the
// result without affecting later calls.
func (r STKCallbackResult) MetadataMap() map[string]any {
	cache := r.metaCache
	if cache == nil {
		cache = buildSTKMetadataCache(r.metadataItems())
	}
	out := make(map[string]any, len(cache.values))
	for k, v := range cache.values {
		out[k] = v
	}
	return out
}

// DuplicateKeys reports how many metadata items were shadowed by an earlier
// same-named item (Safaricom duplicates have been observed on retries).
func (r STKCallbackResult) DuplicateKeys() int {
	if r.metaCache != nil {
		return r.metaCache.dupes
	}
	return buildSTKMetadataCache(r.metadataItems()).dupes
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
//
// Both shapes are decoded in ONE pass via a union struct. The former two-pass
// approach decoded a bare body once into an envelope probe (scanning all of it
// only to find no Body key) and then again into the bare shape — a full second
// scan of the body (+71% CPU at 1 MiB). On the rare decode-error path the old
// cheap envelope probe is replayed so both prior outcomes are preserved: a
// valid envelope still wins, and error text keeps its original stage
// attribution. Valid callbacks never reach that path.
func ParseSTKCallback(body []byte) (*STKCallbackResult, error) {
	if len(body) > maxCallbackBodyBytes {
		return nil, fmt.Errorf("mpesa: callback body too large (%d bytes, max %d)", len(body), maxCallbackBodyBytes)
	}
	var union struct {
		Body *struct {
			StkCallback *STKCallbackResult `json:"stkCallback"`
		} `json:"Body"`
		// Bare-shape outcome fields (the same keys as STKCallbackResult).
		MerchantRequestID string            `json:"MerchantRequestID"`
		CheckoutRequestID string            `json:"CheckoutRequestID"`
		ResultCode        FlexString        `json:"ResultCode"`
		ResultDesc        string            `json:"ResultDesc"`
		CallbackMetadata  *CallbackMetadata `json:"CallbackMetadata,omitempty"`
	}
	if err := json.Unmarshal(body, &union); err != nil {
		// Replay the original envelope-first probe on the error path only.
		// It can still find a valid envelope that a stray bare-side field
		// made the union reject (the old code ignored such extra keys), and
		// it tells a stage-1 "parse ... body" failure from a stage-2
		// "unexpected ... shape" failure exactly as before.
		res, probeOK := replayEnvelopeProbe(body)
		if probeOK && res != nil {
			return res, nil
		}
		if !probeOK {
			return nil, fmt.Errorf("mpesa: parse stk callback body: %w", err)
		}
		return nil, fmt.Errorf("mpesa: unexpected stk callback shape: "+
			"want {\"Body\":{\"stkCallback\":{…}}} or a bare result object: %w", err)
	}
	if union.Body != nil && union.Body.StkCallback != nil {
		return union.Body.StkCallback, nil
	}
	if union.ResultCode.String() == "" && union.MerchantRequestID == "" &&
		union.CheckoutRequestID == "" {
		return nil, fmt.Errorf("mpesa: unexpected stk callback shape: " +
			"missing Body.stkCallback")
	}
	// A bare body was decoded straight into the union fields; assemble the
	// result and build its metadata view so accessors stay cached, exactly as
	// they are on the envelope path (where UnmarshalJSON built it).
	res := &STKCallbackResult{
		MerchantRequestID: union.MerchantRequestID,
		CheckoutRequestID: union.CheckoutRequestID,
		ResultCode:        union.ResultCode,
		ResultDesc:        union.ResultDesc,
		CallbackMetadata:  union.CallbackMetadata,
	}
	res.metaCache = buildSTKMetadataCache(res.metadataItems())
	return res, nil
}

// replayEnvelopeProbe re-runs the original first-stage decode (envelope only)
// on the error path. It returns (result, true) when that probe found a valid
// envelope, (nil, true) when it succeeded with no stkCallback (the old code
// then fell through to the bare decode), and (nil, false) when the probe
// itself failed — which decides the original error message's stage.
func replayEnvelopeProbe(body []byte) (*STKCallbackResult, bool) {
	var envelope struct {
		Body *struct {
			StkCallback *STKCallbackResult `json:"stkCallback"`
		} `json:"Body"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, false
	}
	if envelope.Body != nil && envelope.Body.StkCallback != nil {
		return envelope.Body.StkCallback, true
	}
	return nil, true
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
		if !strings.ContainsAny(raw, ".eE") {
			// Range gate BEFORE int64(f): the previous `f <= math.MaxInt64`
			// admitted exactly 2^63, which converts to a negative int64 on
			// amd64 (silent sign flip). See floatToInt64.
			if v, cerr := floatToInt64(f); cerr == nil {
				return v
			}
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
