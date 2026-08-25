package mpesa

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSecretRedaction(t *testing.T) {
	cfg := Config{
		ConsumerKey:    "ck-visible",
		ConsumerSecret: "cs-TOPSECRET",
		Shortcode:      "174379",
		Passkey:        "pass-TOPSECRET",
		Environment:    Sandbox,
		Timeout:        30 * time.Second,
	}
	shown := fmt.Sprintf("%+v", cfg)
	if strings.Contains(shown, "cs-TOPSECRET") || strings.Contains(shown, "pass-TOPSECRET") {
		t.Fatalf("Config %%+v leaked secrets: %s", shown)
	}
	for _, want := range []string{"secrets:redacted", "ck-visible", "174379"} {
		if !strings.Contains(shown, want) {
			t.Fatalf("Config GoString missing %q: %s", want, shown)
		}
	}
	reqs := []any{
		B2CPayoutRequest{SecurityCredential: "cred-TOPSECRET", InitiatorName: "init-visible"},
		TransactionStatusRequest{SecurityCredential: "cred-TOPSECRET", Initiator: "init-visible"},
		ReversalRequest{SecurityCredential: "cred-TOPSECRET", Initiator: "init-visible"},
		AccountBalanceRequest{SecurityCredential: "cred-TOPSECRET", Initiator: "init-visible"},
	}
	for _, r := range reqs {
		shown := fmt.Sprintf("%+v", r)
		if strings.Contains(shown, "cred-TOPSECRET") {
			t.Fatalf("%T %%+v leaked SecurityCredential: %s", r, shown)
		}
		if !strings.Contains(shown, "[REDACTED]") {
			t.Fatalf("%T GoString missing [REDACTED] marker: %s", r, shown)
		}
	}
}

func TestConfigValidateShortcode(t *testing.T) {
	tests := []struct {
		name    string
		short   string
		wantErr bool
	}{
		{"valid 6-digit", "174379", false},
		{"valid 5-digit", "12345", false},
		{"empty allowed", "", false},
		{"too short 4-digit", "1234", true},
		{"too long 11-digit", "12345678901", true},
		{"contains letters", "17437A", true},
		{"contains space", "17 4379", true},
		{"alpha only", "abc", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := Config{Shortcode: tc.short}
			err := cfg.Validate()
			if (err != nil) != tc.wantErr {
				t.Errorf("Validate(%q) err = %v, wantErr = %v", tc.short, err, tc.wantErr)
			}
		})
	}
}
