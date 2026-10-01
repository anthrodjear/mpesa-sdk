package mpesa

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// resetPinnedSPKIHashes clears the global pin registry before and after each
// pinning test so pins never leak across tests via the package-level map.
func resetPinnedSPKIHashes(t *testing.T) {
	t.Helper()
	pinnedSPKIMutex.Lock()
	pinnedSPKIHashes = make(map[string][][]byte)
	pinnedSPKIMutex.Unlock()
	t.Cleanup(func() {
		pinnedSPKIMutex.Lock()
		pinnedSPKIHashes = make(map[string][][]byte)
		pinnedSPKIMutex.Unlock()
	})
}

// generatePinnedCert creates a real self-signed RSA certificate and returns
// its DER encoding (suitable as rawCerts[0]) plus the genuine SPKI SHA-256
// hash computed through x509.MarshalPKIXPublicKey — the same path
// verifySPKIPinning exercises. No fake hashes.
func generatePinnedCert(t *testing.T) (rawDER []byte, spkiHash []byte) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "pin-test.example.com"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"pin-test.example.com"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create test certificate: %v", err)
	}
	spkiDER, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatalf("marshal test SPKI: %v", err)
	}
	sum := sha256.Sum256(spkiDER)
	return der, sum[:]
}

// loadSandboxCertDER parses testdata/SandboxCertificate.cer (PEM or raw DER)
// and returns its DER bytes plus the genuine SPKI SHA-256 hash.
func loadSandboxCertDER(t *testing.T) (rawDER []byte, spkiHash []byte) {
	t.Helper()
	pemBytes, err := os.ReadFile("testdata/SandboxCertificate.cer")
	if err != nil {
		t.Fatalf("read testdata cert: %v", err)
	}
	der := pemBytes
	if block, _ := pem.Decode(pemBytes); block != nil {
		der = block.Bytes
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse testdata cert: %v", err)
	}
	spkiDER, err := x509.MarshalPKIXPublicKey(cert.PublicKey)
	if err != nil {
		t.Fatalf("marshal sandbox SPKI: %v", err)
	}
	sum := sha256.Sum256(spkiDER)
	return der, sum[:]
}

func TestPin_MatchingPin_AllowsConnection(t *testing.T) {
	resetPinnedSPKIHashes(t)
	rawDER, hash := generatePinnedCert(t)
	const hostname = "pin-match.example.com"
	PinSPKI(hostname, hash)

	verify := verifySPKIPinning(hostname)
	if err := verify([][]byte{rawDER}, nil); err != nil {
		t.Fatalf("matching pin rejected: %v", err)
	}
}

func TestPin_MismatchedPin_RejectsConnection(t *testing.T) {
	resetPinnedSPKIHashes(t)
	rawDER, hash := generatePinnedCert(t)
	const hostname = "pin-mismatch.example.com"
	wrong := make([]byte, len(hash))
	copy(wrong, hash)
	wrong[0] ^= 0xFF
	PinSPKI(hostname, wrong)

	verify := verifySPKIPinning(hostname)
	err := verify([][]byte{rawDER}, nil)
	if err == nil {
		t.Fatal("mismatched pin allowed connection, want rejection")
	}
	if !strings.Contains(err.Error(), "SPKI hash mismatch") {
		t.Fatalf("mismatched pin err = %v, want SPKI hash mismatch", err)
	}
	if !strings.Contains(err.Error(), hostname) {
		t.Fatalf("mismatched pin err = %v, want hostname %q", err, hostname)
	}
}

func TestPin_UnknownHostname_AllowsConnection(t *testing.T) {
	resetPinnedSPKIHashes(t)
	rawDER, hash := generatePinnedCert(t)
	PinSPKI("pin-other.example.com", hash)

	verify := verifySPKIPinning("pin-unknown.example.com")
	if err := verify([][]byte{rawDER}, nil); err != nil {
		t.Fatalf("unknown hostname rejected: %v (pinning is opt-in per-hostname)", err)
	}
}

func TestPin_EmptyRawCerts_ReturnsError(t *testing.T) {
	resetPinnedSPKIHashes(t)
	verify := verifySPKIPinning("pin-empty.example.com")
	if err := verify(nil, nil); err == nil {
		t.Fatal("empty rawCerts allowed, want error")
	} else if !strings.Contains(err.Error(), "no certificates") {
		t.Fatalf("empty rawCerts err = %v, want no-certificates error", err)
	}
	if err := verify([][]byte{}, nil); err == nil {
		t.Fatal("zero-length rawCerts allowed, want error")
	}
}

func TestPin_SandboxCertificate_MatchingPin_AllowsConnection(t *testing.T) {
	resetPinnedSPKIHashes(t)
	rawDER, hash := loadSandboxCertDER(t)
	const hostname = "pin-sandbox.example.com"
	PinSPKI(hostname, hash)

	verify := verifySPKIPinning(hostname)
	if err := verify([][]byte{rawDER}, nil); err != nil {
		t.Fatalf("sandbox cert matching pin rejected: %v", err)
	}
}

func TestPin_NewClientWithPinning_InstallsVerifyPeerCertificate(t *testing.T) {
	resetPinnedSPKIHashes(t)
	c, err := NewClient(Config{
		ConsumerKey:       "test-key",
		ConsumerSecret:    "test-secret",
		Environment:       Sandbox,
		TLSPinningEnabled: true,
	})
	if err != nil {
		t.Fatalf("NewClient with pinning: %v", err)
	}
	tr, ok := c.http.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("Transport = %T, want *http.Transport", c.http.Transport)
	}
	if tr.TLSClientConfig == nil {
		t.Fatal("TLSClientConfig is nil, want pinning config")
	}
	if tr.TLSClientConfig.VerifyPeerCertificate == nil {
		t.Fatal("VerifyPeerCertificate is nil, want verifySPKIPinning callback")
	}
	// The installed callback must be functional: empty rawCerts errors.
	if err := tr.TLSClientConfig.VerifyPeerCertificate(nil, nil); err == nil {
		t.Fatal("installed VerifyPeerCertificate allowed empty rawCerts, want error")
	}
}
