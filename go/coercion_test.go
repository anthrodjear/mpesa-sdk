package mpesa

import (
	"encoding/json"
	"math"
	"testing"
)

func TestOAuthExpiresInLenient(t *testing.T) {
	var s struct {
		Token     string    `json:"access_token"`
		ExpiresIn FlexInt64 `json:"expires_in"`
	}
	if err := json.Unmarshal([]byte(`{"access_token":"t","expires_in":"3599"}`), &s); err != nil || s.ExpiresIn != 3599 {
		t.Fatalf("string expires_in: %+v err=%v", s, err)
	}
	if err := json.Unmarshal([]byte(`{"access_token":"t","expires_in":3600}`), &s); err != nil || s.ExpiresIn != 3600 {
		t.Fatalf("numeric expires_in: %+v err=%v", s, err)
	}
}

func TestFlexStringBranches(t *testing.T) {
	cases := []struct {
		json string
		want string
	}{
		{`"1032"`, "1032"},
		{`1032`, "1032"},
		{`1.0`, "1.0"},
		{`true`, "true"},
		{`null`, ""},
		{`"line\nbreak"`, "line\nbreak"},
	}
	for _, tc := range cases {
		var fs FlexString
		if err := json.Unmarshal([]byte(tc.json), &fs); err != nil {
			t.Errorf("FlexString(%s) error: %v", tc.json, err)
			continue
		}
		if fs.String() != tc.want {
			t.Errorf("FlexString(%s) = %q, want %q", tc.json, fs.String(), tc.want)
		}
	}
}

// Arrays and objects are NOT strings: they must be hard errors rather than
// raw JSON text, per the documented contract (strings/numbers/booleans/null
// only). Quoted strings that merely CONTAIN brackets must still coerce.
func TestFlexStringRejectsArraysAndObjects(t *testing.T) {
	for _, payload := range []string{
		`[1,2]`, `[]`, `[ ]`, `[{"a":1}]`,
		`{"a":1}`, `{}`, `{ }`,
	} {
		var fs FlexString
		if err := json.Unmarshal([]byte(payload), &fs); err == nil {
			t.Errorf("FlexString(%s) = %q, want a hard error", payload, fs.String())
		}
	}
	// Scalars covered by the contract keep coercing, including quoted
	// strings that contain brackets and bare booleans/numbers.
	kept := []struct {
		json string
		want string
	}{
		{`"[]"`, "[]"},
		{`" [1,2] "`, " [1,2] "},
		{`true`, "true"},
		{`false`, "false"},
		{`1.5`, "1.5"},
	}
	for _, tc := range kept {
		var fs FlexString
		if err := json.Unmarshal([]byte(tc.json), &fs); err != nil {
			t.Errorf("FlexString(%s) error: %v", tc.json, err)
			continue
		}
		if fs.String() != tc.want {
			t.Errorf("FlexString(%s) = %q, want %q", tc.json, fs.String(), tc.want)
		}
	}
}

func TestFlexInt64Edges(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		want    FlexInt64
		wantErr bool
	}{
		{"quoted", `"3599"`, 3599, false},
		{"bare number", `3599`, 3599, false},
		{"null maps to zero", `null`, 0, false},
		{"empty string maps to zero", `""`, 0, false},
		{"padded quoted", `"3599 "`, 3599, false},
		{"doubled quotes rejected", `""3599""`, 0, true},
		{"alpha string rejected", `"abc"`, 0, true},
		{"bare alpha rejected", `abc`, 0, true},
	}
	for _, tc := range cases {
		var fi FlexInt64
		err := json.Unmarshal([]byte(tc.json), &fi)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s: FlexInt64(%s) = %d, want error", tc.name, tc.json, fi)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: FlexInt64(%s) error: %v", tc.name, tc.json, err)
			continue
		}
		if fi != tc.want {
			t.Errorf("%s: FlexInt64(%s) = %d, want %d", tc.name, tc.json, fi, tc.want)
		}
	}
}

// TestFloatToInt64RangeGuard verifies the int64 range gate in floatToInt64:
// - 2^63 (maxExactInt64Float) is rejected (upper bound exclusive)
// - math.MinInt64 is accepted (exact representation in float64)
// - NaN and Inf are rejected
// - integral floats like 3599.0 are accepted
func TestFloatToInt64RangeGuard(t *testing.T) {
	cases := []struct {
		name    string
		input   float64
		want    int64
		wantErr bool
	}{
		{"max_exact_float_rejected", maxExactInt64Float, 0, true},
		{"min_int64_accepted", math.MinInt64, math.MinInt64, false},
		{"nan_rejected", math.NaN(), 0, true},
		{"pos_inf_rejected", math.Inf(1), 0, true},
		{"neg_inf_rejected", math.Inf(-1), 0, true},
		{"integral_float_accepted", 3599.0, 3599, false},
		// maxExactInt64Float is 2^63; the next float64 DOWN is 2^63 - 1024
		// (float64 has 53-bit mantissa, spacing at 2^63 is 2^(63-53) = 1024).
		{"largest_float_below_2pow63", 9223372036854774784.0, 9223372036854774784, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := floatToInt64(tc.input)
			if tc.wantErr {
				if err == nil {
					t.Errorf("floatToInt64(%v) = %d, want error", tc.input, got)
				}
				return
			}
			if err != nil {
				t.Errorf("floatToInt64(%v) error: %v", tc.input, err)
				return
			}
			if got != tc.want {
				t.Errorf("floatToInt64(%v) = %d, want %d", tc.input, got, tc.want)
			}
		})
	}
}

// TestFlexInt64Negative verifies negative integer parsing (F23).
// "-1" should parse to -1; "-1.5" should be rejected as non-integral.
func TestFlexInt64Negative(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		want    FlexInt64
		wantErr bool
	}{
		{"quoted_negative", `"-1"`, -1, false},
		{"bare_negative", `-1`, -1, false},
		{"quoted_negative_integral_float", `"-1.0"`, -1, false},
		{"bare_negative_integral_float", `-1.0`, -1, false},
		{"quoted_non_integral_float", `"-1.5"`, 0, true},
		{"bare_non_integral_float", `-1.5`, 0, true},
		{"quoted_large_negative", `"-9223372036854775808"`, math.MinInt64, false},
		{"bare_large_negative", `-9223372036854775808`, math.MinInt64, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var fi FlexInt64
			err := json.Unmarshal([]byte(tc.json), &fi)
			if tc.wantErr {
				if err == nil {
					t.Errorf("FlexInt64(%s) = %d, want error", tc.json, fi)
				}
				return
			}
			if err != nil {
				t.Errorf("FlexInt64(%s) error: %v", tc.json, err)
				return
			}
			if fi != tc.want {
				t.Errorf("FlexInt64(%s) = %d, want %d", tc.json, fi, tc.want)
			}
		})
	}
}

// TestFlexInt64EdgesExtended adds more edge cases to the existing test.
func TestFlexInt64EdgesExtended(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		want    FlexInt64
		wantErr bool
	}{
		{"max_int64", `9223372036854775807`, math.MaxInt64, false},
		{"min_int64", `-9223372036854775808`, math.MinInt64, false},
		{"overflow_quoted", `"9223372036854775808"`, 0, true},
		{"overflow_bare", `9223372036854775808`, 0, true},
		{"underflow_quoted", `"-9223372036854775809"`, 0, true},
		{"underflow_bare", `-9223372036854775809`, 0, true},
		{"float_large_rejected", `1e30`, 0, true},
		{"float_small_rejected", `0.1`, 0, true},
		{"whitespace_quoted", `" 3599 "`, 3599, false},
		{"whitespace_bare", ` 3599 `, 3599, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var fi FlexInt64
			err := json.Unmarshal([]byte(tc.json), &fi)
			if tc.wantErr {
				if err == nil {
					t.Errorf("FlexInt64(%s) = %d, want error", tc.json, fi)
				}
				return
			}
			if err != nil {
				t.Errorf("FlexInt64(%s) error: %v", tc.json, err)
				return
			}
			if fi != tc.want {
				t.Errorf("FlexInt64(%s) = %d, want %d", tc.json, fi, tc.want)
			}
		})
	}
}
