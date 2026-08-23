package mpesa

import (
	"encoding/base64"
	"encoding/pem"
	"os"
	"testing"
	"time"
)

const (
	testShortcode = "174379"
	testPasskey   = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"
)

// Golden vector: docs/apis/stk-push.md sandbox credentials with the clock
// fixed at 2021-06-28T09:24:08Z. The timestamp must render in EAT (UTC+3).
func TestGeneratePasswordGoldenVector(t *testing.T) {
	clock := time.Date(2021, 6, 28, 9, 24, 8, 0, time.UTC)
	password, timestamp := GeneratePassword(testShortcode, testPasskey, clock)

	if timestamp != "20210628122408" {
		t.Fatalf("timestamp = %q, want %q", timestamp, "20210628122408")
	}
	want := base64.StdEncoding.EncodeToString([]byte(testShortcode + testPasskey + "20210628122408"))
	if password != want {
		t.Fatalf("password = %q, want %q", password, want)
	}
	if len(password) != len(want) || password[:12] != "MTc0Mzc5YmZi" {
		t.Fatalf("password prefix = %q, want official sample alphabet MTc0Mzc5YmZi", password[:min(12, len(password))])
	}
}

func TestGeneratePasswordEATDayBoundaries(t *testing.T) {
	cases := []struct {
		name string
		in   time.Time
		want string
	}{
		{"just before midnight EAT", time.Date(2021, 6, 28, 20, 59, 59, 0, time.UTC), "20210628235959"},
		{"midnight rollover EAT", time.Date(2021, 6, 28, 21, 0, 0, 0, time.UTC), "20210629000000"},
		{"year rollover EAT", time.Date(2021, 12, 31, 21, 30, 0, 0, time.UTC), "20220101003000"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, got := GeneratePassword(testShortcode, testPasskey, tc.in)
			if got != tc.want {
				t.Fatalf("timestamp = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNormalizePhone(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"0712345678", "254712345678", false},
		{"+254712345678", "254712345678", false},
		{"254712345678", "254712345678", false},
		{"0110123456", "254110123456", false},
		{"+254110123456", "254110123456", false},
		{"0723 456 789", "254723456789", false},
		{"", "", true},
		{"071234567", "", true},
		{"07123456789", "", true},
		{"254612345678", "", true},
		{"abcdefghijk", "", true},
		{"+441234567890", "", true},
	}
	for _, tc := range cases {
		got, err := NormalizePhone(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("NormalizePhone(%q) = %q, want error", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("NormalizePhone(%q) error: %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("NormalizePhone(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestSecurityCredentialSandboxCert(t *testing.T) {
	certPEM, err := os.ReadFile("testdata/SandboxCertificate.cer")
	if err != nil {
		t.Fatalf("read testdata cert: %v", err)
	}
	cred, err := SecurityCredential(certPEM, "initiator-password")
	if err != nil {
		t.Fatalf("SecurityCredential: %v", err)
	}
	// 2048-bit RSA => 256-byte ciphertext => exactly 344 base64 chars.
	if len(cred) != 344 {
		t.Fatalf("credential length = %d, want 344", len(cred))
	}
	raw, err := base64.StdEncoding.DecodeString(cred)
	if err != nil {
		t.Fatalf("credential not valid base64: %v", err)
	}
	if len(raw) != 256 {
		t.Fatalf("decoded ciphertext = %d bytes, want 256", len(raw))
	}
}

func TestSecurityCredentialAcceptsRawDER(t *testing.T) {
	certPEM, err := os.ReadFile("testdata/SandboxCertificate.cer")
	if err != nil {
		t.Fatalf("read testdata cert: %v", err)
	}
	block, _ := pem.Decode(certPEM)
	if block == nil {
		t.Fatal("testdata cert is not PEM")
	}
	if _, err := SecurityCredential(block.Bytes, "pw"); err != nil {
		t.Fatalf("raw DER rejected: %v", err)
	}
}

func TestSecurityCredentialRejectsGarbage(t *testing.T) {
	if _, err := SecurityCredential([]byte("definitely not a certificate"), "pw"); err == nil {
		t.Fatal("expected error for non-certificate input")
	}
}

func TestParseBalanceSegments(t *testing.T) {
	in := "Working Account|KES|700000.00|700000.00|0.00|0.00&Utility Account|KES|228037.00|228037.00|0.00|0.00&Charges Paid Account|KES|-1540.00|-1540.00|0.00|0.00&"
	segs, skipped := ParseBalanceSegments(in)
	if skipped != 0 {
		t.Fatalf("clean input skipped = %d, want 0", skipped)
	}
	if len(segs) != 3 {
		t.Fatalf("got %d segments, want 3", len(segs))
	}
	last := segs[2]
	if last.AccountName != "Charges Paid Account" || last.Available != -1540.0 || last.Currency != "KES" {
		t.Fatalf("last segment = %+v", last)
	}
	wantRaw := "Charges Paid Account|KES|-1540.00|-1540.00|0.00|0.00"
	if last.Raw != wantRaw {
		t.Fatalf("Raw = %q, want %q", last.Raw, wantRaw)
	}

	// Malformed rows are skipped and counted, never fatal (account-balance.md
	// tolerance requirement).
	junk := "Utility Account|KES|1.00|1.00|0.00|0.00&GARBAGE ROW&Charges Paid Account|KES|-1540.00|-1540.00|0.00|0.00&Short|Row&"
	segs, skipped = ParseBalanceSegments(junk)
	if len(segs) != 2 || skipped != 2 {
		t.Fatalf("junk input: %d segments (want 2), skipped %d (want 2)", len(segs), skipped)
	}
	segs, skipped = ParseBalanceSegments("")
	if segs != nil || skipped != 0 {
		t.Fatalf("empty input: segs=%v skipped=%d", segs, skipped)
	}
}
