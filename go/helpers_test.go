package mpesa

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

const (
	testShortcode = "174379"
	testPasskey   = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"
)

// Golden vector: docs/apis/stk-push.md sandbox credentials with the clock
// fixed at 2021-06-28T09:24:08Z. The timestamp must render in EAT (UTC+3).
// The expected password is a hardcoded literal so any drift in concat order,
// EAT rendering or base64 alphabet breaks loudly.
func TestGeneratePasswordGoldenVector(t *testing.T) {
	clock := time.Date(2021, 6, 28, 9, 24, 8, 0, time.UTC)
	password, timestamp, err := GeneratePassword(testShortcode, testPasskey, clock)
	if err != nil {
		t.Fatalf("GeneratePassword: %v", err)
	}

	if timestamp != "20210628122408" {
		t.Fatalf("timestamp = %q, want %q", timestamp, "20210628122408")
	}
	const wantGolden = "MTc0Mzc5YmZiMjc5ZjlhYTliZGJjZjE1OGU5N2RkNzFhNDY3Y2QyZTBjODkzMDU5YjEwZjc4ZTZiNzJhZGExZWQyYzkxOTIwMjEwNjI4MTIyNDA4"
	if password != wantGolden {
		t.Fatalf("password = %q, want golden literal %q", password, wantGolden)
	}
	if decoded, derr := base64.StdEncoding.DecodeString(password); derr != nil ||
		string(decoded) != testShortcode+testPasskey+"20210628122408" {
		t.Fatalf("golden literal does not decode to shortcode+passkey+timestamp: %v", derr)
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
			_, got, err := GeneratePassword(testShortcode, testPasskey, tc.in)
			if err != nil {
				t.Fatalf("GeneratePassword: %v", err)
			}
			if got != tc.want {
				t.Fatalf("timestamp = %q, want %q", got, tc.want)
			}
		})
	}
}

// A zero time.Time would render as well-formed garbage ("00010101030000");
// it must fail loudly instead.
func TestGeneratePasswordRejectsZeroTime(t *testing.T) {
	password, timestamp, err := GeneratePassword(testShortcode, testPasskey, time.Time{})
	if err == nil {
		t.Fatal("zero time.Time must be rejected")
	}
	if !strings.Contains(err.Error(), "zero") {
		t.Fatalf("error = %v, want zero-time mention", err)
	}
	if password != "" || timestamp != "" {
		t.Fatalf("zero time must not emit values: password=%q timestamp=%q", password, timestamp)
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
		{" 0712345678 ", "254712345678", false},
		{"\t0712345678\n", "254712345678", false},
		{"", "", true},
		{"+", "", true},
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

func TestNormalizePhoneRejectsOverlongInput(t *testing.T) {
	_, err := NormalizePhone(strings.Repeat("0", 33))
	if err == nil || !strings.Contains(err.Error(), "too long") {
		t.Fatalf("overlong input err = %v, want 'too long' rejection", err)
	}
	_, err = NormalizePhone(strings.Repeat("0", 32))
	if err == nil {
		t.Fatal("32 garbage bytes must still fail shape validation")
	}
}

var originatorIDPattern = regexp.MustCompile(`^[0-9a-f]+$`)

func TestNewOriginatorIDProperties(t *testing.T) {
	for i := 0; i < 16; i++ {
		id, err := newOriginatorID()
		if err != nil {
			t.Fatalf("newOriginatorID: %v", err)
		}
		if len(id) == 0 || len(id) > 19 {
			t.Fatalf("id %q violates Daraja <20-char originator constraint", id)
		}
		if !originatorIDPattern.MatchString(id) {
			t.Fatalf("id %q is not lowercase hex", id)
		}
	}
}

func TestNewOriginatorIDPropagatesRandFailure(t *testing.T) {
	orig := randRead
	randRead = func([]byte) (int, error) { return 0, errors.New("rand unavailable") }
	defer func() { randRead = orig }()
	if _, err := newOriginatorID(); err == nil {
		t.Fatal("entropy failure must propagate — predictable fallback IDs are forbidden")
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

func TestSecurityCredentialEmptyPassword(t *testing.T) {
	for _, pw := range []string{"", " "} {
		// Garbage cert proves the cheap password check runs BEFORE parsing:
		// the reported error must be about the password, never the cert.
		_, err := SecurityCredential([]byte("definitely not a certificate"), pw)
		if err == nil {
			t.Fatalf("password %q accepted", pw)
		}
		if !strings.Contains(err.Error(), "initiator password is required") {
			t.Fatalf("password %q: err = %v, want cheapest-first password rejection", pw, err)
		}
	}
}

// A certificate whose RSA key is BELOW the 2048-bit floor must be REFUSED:
// that key encrypts the initiator password on the wire, and a key this weak
// is exactly what the floor exists to keep out. The weak certificate is
// generated HERE, so no weak key material is ever committed to the repo.
func TestSecurityCredentialRejectsWeakRSAKey(t *testing.T) {
	weak := selfSignedCertPEM(t, 1024)
	_, err := SecurityCredential(weak, "pw")
	if err == nil {
		t.Fatal("1024-bit RSA key accepted, want rejection")
	}
	if !strings.Contains(err.Error(), "1024") {
		t.Fatalf("err = %v, want the ACTUAL key size named", err)
	}

	// The floor must not reject a legitimate key: a 2048-bit certificate
	// — the size the official M-Pesa certs ship — still encrypts.
	cred, err := SecurityCredential(selfSignedCertPEM(t, 2048), "pw")
	if err != nil {
		t.Fatalf("2048-bit RSA key rejected: %v", err)
	}
	if len(cred) != 344 {
		t.Fatalf("credential length = %d, want 344", len(cred))
	}
}

// selfSignedCertPEM builds a self-signed certificate carrying an RSA key of
// the requested size. Self-signed is enough: SecurityCredential never checks
// the chain or the validity dates (the official certs ship long-expired by
// design), so only the public key matters here.
func selfSignedCertPEM(t *testing.T, bits int) []byte {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, bits)
	if err != nil {
		t.Fatalf("generate %d-bit RSA key: %v", bits, err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "mpesa-key-size-test"},
		NotBefore:    time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:     time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func TestSecurityCredentialRejectsGarbage(t *testing.T) {
	if _, err := SecurityCredential([]byte("definitely not a certificate"), "pw"); err == nil {
		t.Fatal("expected error for non-certificate input")
	}
}
