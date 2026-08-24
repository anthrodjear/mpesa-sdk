package mpesa

import (
	"encoding/json"
	"testing"
)

// Matrix beside ClassifyResultCode: success only ever 0; terminal failures
// per stk-push.md/b2c.md/account-balance.md; everything else indeterminate.
func TestClassifyResultCodeMatrix(t *testing.T) {
	cases := []struct {
		code string
		want ResultClass
	}{
		{"0", ResultClassSuccess},
		{"0.0", ResultClassSuccess}, // integral float fallback
		{"1", ResultClassFailure},
		{"17", ResultClassFailure},
		{"1019", ResultClassFailure},
		{"1025", ResultClassFailure},
		{"1032", ResultClassFailure}, // user-cancelled: terminal, new intent ok
		{"2001", ResultClassFailure},
		{"9999", ResultClassFailure},
		{"1001", ResultClassIndeterminate},
		{"1037", ResultClassIndeterminate},
		{"26", ResultClassIndeterminate},
		{"4999", ResultClassIndeterminate},
		{"1.5", ResultClassIndeterminate}, // non-integral never coerces
		{"-5", ResultClassIndeterminate},
		{"123456", ResultClassIndeterminate},
		{"SFC_IC0003", ResultClassIndeterminate},
		{"", ResultClassIndeterminate},
	}
	for _, tc := range cases {
		if got := ClassifyResultCode(tc.code); got != tc.want {
			t.Errorf("ClassifyResultCode(%q) = %q, want %q", tc.code, got, tc.want)
		}
	}
}

// Catalogs transcribed from docs/apis/b2c.md and docs/apis/account-balance.md;
// guards the async terminal-failure set against catalog drift.
func TestAsyncTerminalFailureCatalogs(t *testing.T) {
	b2c := map[string]ResultClass{
		"0":          ResultClassSuccess,
		"1":          ResultClassFailure,
		"2":          ResultClassFailure,
		"3":          ResultClassFailure,
		"4":          ResultClassFailure,
		"8":          ResultClassFailure,
		"11":         ResultClassFailure,
		"21":         ResultClassFailure,
		"2001":       ResultClassFailure,
		"2006":       ResultClassFailure,
		"2028":       ResultClassFailure,
		"2040":       ResultClassFailure,
		"8006":       ResultClassFailure,
		"SFC_IC0003": ResultClassIndeterminate,
	}
	accountBalance := map[string]ResultClass{
		"15":          ResultClassFailure,
		"17":          ResultClassFailure,
		"22":          ResultClassFailure,
		"18":          ResultClassIndeterminate,
		"20":          ResultClassIndeterminate,
		"24":          ResultClassIndeterminate,
		"25":          ResultClassIndeterminate,
		"26":          ResultClassIndeterminate,
		"29":          ResultClassIndeterminate,
		"100000011":   ResultClassIndeterminate,
		"00.002.1001": ResultClassIndeterminate,
	}
	for _, catalog := range []map[string]ResultClass{b2c, accountBalance} {
		for code, want := range catalog {
			if got := ClassifyResultCode(code); got != want {
				t.Errorf("catalog code %q classified %q, want %q", code, got, want)
			}
		}
	}
}

// STKQueryResponse.Classify mirrors the callback/async receivers: decode via
// FlexString so both string and numeric wire encodings are exercised.
func TestSTKQueryResponseClassifyRows(t *testing.T) {
	cases := []struct {
		name       string
		resultCode string // raw JSON value encoding
		want       ResultClass
	}{
		{"string success", `"0"`, ResultClassSuccess},
		{"numeric success", `0`, ResultClassSuccess},
		{"terminal failure", `"1032"`, ResultClassFailure},
		{"unknown indeterminate", `1001`, ResultClassIndeterminate},
		{"non-numeric indeterminate", `"SFC_IC0003"`, ResultClassIndeterminate},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var resp STKQueryResponse
			if err := json.Unmarshal([]byte(`{"ResultCode":`+tc.resultCode+`}`), &resp); err != nil {
				t.Fatal(err)
			}
			if got := resp.Classify(); got != tc.want {
				t.Errorf("STKQueryResponse{ResultCode:%s}.Classify() = %q, want %q",
					tc.resultCode, got, tc.want)
			}
		})
	}
}
