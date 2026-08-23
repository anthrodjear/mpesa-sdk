package mpesa

import (
	"encoding/json"
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
