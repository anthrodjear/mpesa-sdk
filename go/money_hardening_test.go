package mpesa

// Money-handling hardening tests (M3/M9 of the 2026-11-24 review):
//   - STKCallbackResult.Amount / AmountMatches give callers a strict,
//     settlement-safe view of the advisory callback amount without changing
//     MetadataMap's wire-compatible mixed-type view.
//   - dailyLedger arithmetic saturates instead of wrapping, and a rollback
//     can never credit more than the bucket actually holds.

import (
	"encoding/json"
	"errors"
	"math"
	"testing"
)

// callbackWithAmountValue parses a callback whose Amount metadata carries the
// supplied raw JSON token, so these tests exercise the real decodedValue and
// the parse-time metadata cache (not a hand-built approximation of them).
func callbackWithAmountValue(t *testing.T, valueJSON string) STKCallbackResult {
	t.Helper()
	payload := []byte(`{"Body":{"stkCallback":{"MerchantRequestID":"m",` +
		`"CheckoutRequestID":"ws_CO_1","ResultCode":0,"ResultDesc":"ok",` +
		`"CallbackMetadata":{"Item":[{"Name":"Amount","Value":` + valueJSON + `}]}}}}`)
	res, err := ParseSTKCallback(payload)
	if err != nil {
		t.Fatalf("ParseSTKCallback(%s): %v", valueJSON, err)
	}
	return *res
}

// TestSTKCallbackAmountAcceptsSupportedShapes pins the three deliberate
// shapes: a positive int64, a canonical unsigned decimal string of at most
// 12 digits, and an integral float64. Anything else is refused by
// TestSTKCallbackAmountRejectsUnsupportedShapes.
func TestSTKCallbackAmountAcceptsSupportedShapes(t *testing.T) {
	cases := []struct {
		name      string
		valueJSON string
		want      int64
	}{
		{"integer", `100`, 100},
		{"string of digits", `"100"`, 100},
		{"integral float", `100.0`, 100},
		{"single digit string", `"1"`, 1},
		{"12 digit string", `"999999999999"`, 999_999_999_999},
		{"leading zeros string", `"000000000100"`, 100},
		{"exact upper bound as integer", `1000000000000`, 1_000_000_000_000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := callbackWithAmountValue(t, tc.valueJSON)
			got, ok := res.Amount()
			if !ok {
				t.Fatalf("Amount() from %s rejected, want (%d, true)", tc.valueJSON, tc.want)
			}
			if got != tc.want {
				t.Fatalf("Amount() = %d, want %d", got, tc.want)
			}
		})
	}
}

// TestSTKCallbackAmountRejectsUnsupportedShapes is the security boundary:
// a forged callback must never be able to smuggle a non-positive, fractional,
// oversized, or wrong-typed Amount into a settlement decision.
func TestSTKCallbackAmountRejectsUnsupportedShapes(t *testing.T) {
	cases := []struct {
		name      string
		valueJSON string
	}{
		{"fractional float", `100.5`},
		{"negative integer", `-5`},
		{"negative float", `-5.0`},
		{"zero integer", `0`},
		{"zero float", `0.0`},
		{"zero string", `"0"`},
		{"exponent string", `"1e999"`},
		{"signed string", `"+100"`},
		{"negative string", `"-5"`},
		{"fractional string", `"100.5"`},
		{"whitespace string", `" 100"`},
		{"13 digit string", `"1000000000000"`},
		{"string above bound", `"9999999999999"`},
		{"integer above bound", `1000000000001`},
		{"bool", `true`},
		{"null", `null`},
		{"object", `{"n":1}`},
		{"array", `[100]`},
		{"exponent overflow token", `1e999`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := callbackWithAmountValue(t, tc.valueJSON)
			if got, ok := res.Amount(); ok {
				t.Fatalf("Amount() from %s = (%d, true), want rejection", tc.valueJSON, got)
			}
			if res.AmountMatches(100) {
				t.Fatalf("AmountMatches(100) from %s = true, want false", tc.valueJSON)
			}
		})
	}
}

// Exponent-form integral tokens decode as float64 and are accepted by the
// strict accessor (documented in Amount). They remain bounded and positive —
// settlement must gate on AmountMatches against the stored order amount.
func TestSTKCallbackAmountAcceptsExponentFormIntegralTokens(t *testing.T) {
	res := callbackWithAmountValue(t, `1e3`)
	got, ok := res.Amount()
	if !ok || got != 1000 {
		t.Fatalf("Amount() from `1e3` = (%d, %t), want (1000, true)", got, ok)
	}
	if !res.AmountMatches(1000) {
		t.Fatal("AmountMatches(1000) from `1e3` = false, want true")
	}
}

// A missing Amount key (or a wholly absent CallbackMetadata) is a refusal,
// never a zero-value amount a caller could mistake for a real payment.
func TestSTKCallbackAmountRejectsMissingAmount(t *testing.T) {
	cases := []struct {
		name    string
		payload string
	}{
		{"no metadata", `{"Body":{"stkCallback":{"CheckoutRequestID":"ws_CO_1","ResultCode":0}}}`},
		{"other key only", `{"Body":{"stkCallback":{"CheckoutRequestID":"ws_CO_1","ResultCode":0,` +
			`"CallbackMetadata":{"Item":[{"Name":"Receipt","Value":"ABC"}]}}}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := ParseSTKCallback([]byte(tc.payload))
			if err != nil {
				t.Fatalf("ParseSTKCallback: %v", err)
			}
			if got, ok := res.Amount(); ok {
				t.Fatalf("Amount() = (%d, true), want rejection", got)
			}
		})
	}
}

// json.RawMessage is decodedValue's fallback for unrecognised tokens. It must
// never be interpreted as money even when the raw bytes look numeric.
func TestSTKCallbackAmountRejectsRawMessage(t *testing.T) {
	res := STKCallbackResult{CallbackMetadata: &CallbackMetadata{Item: []MetadataItem{
		{Name: "Amount", Value: json.RawMessage(`1e999`)},
	}}}
	if _, ok := res.MetadataMap()["Amount"].(json.RawMessage); !ok {
		t.Fatalf("test setup: expected a json.RawMessage, got %T", res.MetadataMap()["Amount"])
	}
	if got, ok := res.Amount(); ok {
		t.Fatalf("Amount() = (%d, true), want rejection of json.RawMessage", got)
	}
}

// Duplicate metadata is first-wins in MetadataMap for wire parity, but the
// verification helper must refuse the ambiguous value outright. The duplicate
// may be on a DIFFERENT key: any shadowed item makes the callback suspect.
func TestSTKCallbackAmountRejectsDuplicateMetadata(t *testing.T) {
	cases := []struct {
		name string
		item string
	}{
		{"duplicate Amount", `{"Name":"Amount","Value":10},` +
			`{"Name":"Amount","Value":999}`},
		{"duplicate other key", `{"Name":"Amount","Value":10},` +
			`{"Name":"Receipt","Value":"A"},{"Name":"Receipt","Value":"B"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := []byte(`{"Body":{"stkCallback":{"CheckoutRequestID":"ws_CO_1","ResultCode":0,` +
				`"CallbackMetadata":{"Item":[` + tc.item + `]}}}}`)
			res, err := ParseSTKCallback(payload)
			if err != nil {
				t.Fatalf("ParseSTKCallback: %v", err)
			}
			if res.DuplicateKeys() == 0 {
				t.Fatal("test setup: expected DuplicateKeys() > 0")
			}
			if got, ok := res.Amount(); ok {
				t.Fatalf("Amount() = (%d, true), want rejection with duplicates", got)
			}
			if res.AmountMatches(10) {
				t.Fatal("AmountMatches(10) = true, want false with duplicates")
			}
		})
	}
}

// AmountMatches is the settlement gate: true only for the exact expected
// amount in an unambiguous callback, false on mismatch or parse failure.
func TestSTKCallbackAmountMatches(t *testing.T) {
	res := callbackWithAmountValue(t, `"100"`)
	if !res.AmountMatches(100) {
		t.Fatal("AmountMatches(100) = false, want true")
	}
	if res.AmountMatches(99) {
		t.Fatal("AmountMatches(99) = true, want false")
	}
	if res.AmountMatches(101) {
		t.Fatal("AmountMatches(101) = true, want false")
	}
	// A strict accessor must not weaken MetadataMap's wire-compatible view.
	if got := res.MetadataMap()["Amount"]; got != "100" {
		t.Fatalf("MetadataMap()[Amount] = %v (%T), want the raw string \"100\"", got, got)
	}
}

// TestDailyLedgerConsumeSaturatesAtCeiling pins M9: adding a huge (but
// well-formed int64) amount to a non-empty bucket used to wrap NEGATIVE, so
// `used > max` was false and the request was accepted with a negative running
// total — after which unlimited spend was possible. The check must be
// `amount > max - used`, and the reported total must saturate rather than wrap.
func TestDailyLedgerConsumeSaturatesAtCeiling(t *testing.T) {
	limits := TransactionLimits{
		STK: ServiceLimits{MaxPerTransaction: Limit(math.MaxInt64), MaxPerDay: Limit(500_000)},
	}
	cases := []struct {
		name   string
		used   int64
		amount int64
	}{
		{"huge amount wraps int64 when added", 500_000, math.MaxInt64},
		{"near-max amount with prior spend", 250_000, math.MaxInt64 - 100},
		{"one past the remaining budget", 499_999, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := dailyLedger{day: "2024-05-01", used: map[Service]int64{ServiceSTK: tc.used}}
			day, err := d.consume(ServiceSTK, tc.amount, limits, "2024-05-01")
			var le *LimitError
			if !errors.As(err, &le) || le.Kind != "MaxPerDay" {
				t.Fatalf("consume(used=%d, amount=%d) = (day=%q, err=%v), want a MaxPerDay LimitError", tc.used, tc.amount, day, err)
			}
			if le.Amount <= le.Max {
				t.Fatalf("reported daily total = %d, want > ceiling %d (wrapped/unsaturated total)", le.Amount, le.Max)
			}
			if got := d.used[ServiceSTK]; got != tc.used {
				t.Fatalf("rejected consume mutated the bucket: used = %d, want unchanged %d", got, tc.used)
			}
		})
	}
}

// TestDailyLedgerRollbackClampsCreditToUsed pins the other half of M9: the
// credit is bounded by what the bucket actually holds. The old `used - amount`
// path deleted the whole key as soon as the result was non-positive, losing
// the bucket's identity (and, for hostile amounts, risking a wrapped credit).
func TestDailyLedgerRollbackClampsCreditToUsed(t *testing.T) {
	cases := []struct {
		name        string
		used        int64
		credit      int64
		want        int64
		wantKeyKept bool
	}{
		{"partial refund", 1_000, 400, 600, true},
		{"exact refund leaves a zeroed bucket", 1_000, 1_000, 0, true},
		{"over-refund clamps to zero", 1_000, 1_500, 0, true},
		{"hostile over-refund clamps to zero", 1_000, math.MaxInt64, 0, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := dailyLedger{day: "2024-05-01", used: map[Service]int64{ServiceSTK: tc.used}}
			d.rollback(ServiceSTK, tc.credit, "2024-05-01")
			if got := d.used[ServiceSTK]; got != tc.want {
				t.Fatalf("used after rollback = %d, want %d", got, tc.want)
			}
			if _, exists := d.used[ServiceSTK]; exists != tc.wantKeyKept {
				t.Fatalf("bucket key present = %t, want %t (over-rollback must clamp, not delete)", exists, tc.wantKeyKept)
			}
		})
	}
}
