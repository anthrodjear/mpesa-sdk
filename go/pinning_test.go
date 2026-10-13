package mpesa

import (
	"bytes"
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
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "pin-test.example.com"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
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

// TestPin_MatchingPin_AllowsConnection uses a snapshot-verifier closure, the
// same object NewClient installs. buildTrustedVerifyClient builds one through
// NewClient so the full wiring is exercised.
func TestPin_MatchingPin_AllowsConnection(t *testing.T) {
	resetPinnedSPKIHashes(t)
	rawDER, hash := generatePinnedCert(t)
	const hostname = "pin-match.example.com"
	if err := PinSPKI(hostname, hash); err != nil {
		t.Fatalf("PinSPKI: %v", err)
	}

	verify := SPKIVerifier(hostname, [][]byte{hash})
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
	if err := PinSPKI(hostname, wrong); err != nil {
		t.Fatalf("PinSPKI: %v", err)
	}

	verify := SPKIVerifier(hostname, [][]byte{wrong})
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

// The fail-closed contract that replaced the old "unknown hostname ⇒ allow":
// an EMPTY pin set must be rejected, never treated as "pinning is opt-in for
// this host". SPKIVerifier is the escape hatch for callers pinning their own
// transports, so it has to fail closed on its own.
func TestPin_EmptyPinSet_ReturnsError(t *testing.T) {
	resetPinnedSPKIHashes(t)
	rawDER, hash := generatePinnedCert(t)
	const hostname = "pin-empty.example.com"
	if err := PinSPKI("pin-other.example.com", hash); err != nil {
		t.Fatalf("PinSPKI: %v", err)
	}

	verify := SPKIVerifier(hostname, nil)
	err := verify([][]byte{rawDER}, nil)
	if err == nil {
		t.Fatal("empty pin set allowed connection, want fail-closed rejection")
	}
	if !strings.Contains(err.Error(), "no SPKI pins") {
		t.Fatalf("empty pin set err = %v, want no-pins rejection", err)
	}
	if err := verify(nil, nil); err == nil {
		t.Fatal("empty rawCerts allowed, want error")
	}
}

func TestPin_EmptyRawCerts_ReturnsError(t *testing.T) {
	resetPinnedSPKIHashes(t)
	verify := SPKIVerifier("pin-empty.example.com", [][]byte{[]byte("pin")})
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
	if err := PinSPKI(hostname, hash); err != nil {
		t.Fatalf("PinSPKI: %v", err)
	}

	verify := SPKIVerifier(hostname, [][]byte{hash})
	if err := verify([][]byte{rawDER}, nil); err != nil {
		t.Fatalf("sandbox cert matching pin rejected: %v", err)
	}
}

// PinSPKI must reject a hash that is not exactly sha256.Size bytes and must
// de-duplicate identical registrations.
func TestPinSPKIRejectsWrongLengthAndDeduplicates(t *testing.T) {
	resetPinnedSPKIHashes(t)
	const hostname = "pin-length.example.com"
	good := bytes.Repeat([]byte{0xAB}, sha256.Size)

	for _, bad := range []int{0, 1, 31, 33, 64} {
		if err := PinSPKI(hostname, make([]byte, bad)); err == nil {
			t.Errorf("PinSPKI with %d-byte hash accepted, want length rejection", bad)
		}
	}
	if err := PinSPKI(hostname, good); err != nil {
		t.Fatalf("PinSPKI with 32-byte hash: %v", err)
	}
	// Duplicates must not grow the pin set.
	if err := PinSPKI(hostname, good); err != nil {
		t.Fatalf("duplicate PinSPKI: %v", err)
	}
	if err := PinSPKI(hostname, good); err != nil {
		t.Fatalf("duplicate PinSPKI: %v", err)
	}
	pinnedSPKIMutex.RLock()
	n := len(pinnedSPKIHashes[hostname])
	pinnedSPKIMutex.RUnlock()
	if n != 1 {
		t.Fatalf("pin set size = %d after 3 registrations (1 unique + 2 duplicates), want 1", n)
	}
}

// A pin registered after NewClient must NOT change an already-built client:
// construction snapshots the registry once, so a built client keeps enforcing
// exactly the set that existed when it was created (no process-global read at
// handshake time, no ordering-dependent trust decision).
func TestPinSnapshotAtConstructionIgnoresLaterRegistrations(t *testing.T) {
	resetPinnedSPKIHashes(t)
	// Pin the hostname the client will actually connect to.
	hostname := hostnameFromURL(Sandbox.BaseURL())
	// Register the GENUINE hash of a freshly minted certificate: PinSPKI
	// deep-copies its input, so the registry must keep enforcing exactly this
	// value even though the helper below used to overwrite the caller's array
	// in place (an aliasing shortcut the G4 fix removed).
	rawFirst, hashFirst := generatePinnedCert(t)
	if err := PinSPKI(hostname, hashFirst); err != nil {
		t.Fatalf("PinSPKI: %v", err)
	}

	c, err := NewClient(Config{
		ConsumerKey: "test-key", ConsumerSecret: "test-secret", Environment: Sandbox,
		TLSPinningEnabled: true,
	})
	if err != nil {
		t.Fatalf("NewClient with pinning: %v", err)
	}
	tr, ok := c.http.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("Transport = %T, want *http.Transport", c.http.Transport)
	}
	verify := tr.TLSClientConfig.VerifyPeerCertificate
	if verify == nil {
		t.Fatal("VerifyPeerCertificate is nil")
	}

	// A certificate matching the snapshot is accepted.
	if err := verify([][]byte{rawFirst}, nil); err != nil {
		t.Fatalf("snapshot pin rejected a matching certificate: %v", err)
	}
	// Register a LATE pin, then present a certificate matching only it: the
	// built client must still reject it.
	rawSecond, hashSecond := generatePinnedCert(t)
	if err := PinSPKI(hostname, hashSecond); err != nil {
		t.Fatalf("late PinSPKI: %v", err)
	}
	err = verify([][]byte{rawSecond}, nil)
	if err == nil {
		t.Fatal("late pin accepted by an already-built client, want snapshot-only enforcement")
	}
	if !strings.Contains(err.Error(), "SPKI hash mismatch") {
		t.Fatalf("err = %v, want SPKI hash mismatch", err)
	}
	// The snapshot is immutable: the original certificate is still accepted
	// after the late registration.
	if err := verify([][]byte{rawFirst}, nil); err != nil {
		t.Fatalf("snapshot pin stopped matching after a late registration: %v", err)
	}
}

func TestPin_NewClientWithPinning_InstallsVerifyPeerCertificate(t *testing.T) {
	resetPinnedSPKIHashes(t)
	hostname := hostnameFromURL(Sandbox.BaseURL())
	_, hash := generatePinnedCert(t)
	if err := PinSPKI(hostname, hash); err != nil {
		t.Fatalf("PinSPKI: %v", err)
	}

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
		t.Fatal("VerifyPeerCertificate is nil, want the SPKI verifier callback")
	}
	// The installed callback must be functional: empty rawCerts errors.
	if err := tr.TLSClientConfig.VerifyPeerCertificate(nil, nil); err == nil {
		t.Fatal("installed VerifyPeerCertificate allowed empty rawCerts, want error")
	}
}

// TLSPinningEnabled with NO registered pin must fail closed: NewClient
// returns an error instead of silently building an unpinned client.
func TestPin_NewClientPinningWithoutPin_FailsClosed(t *testing.T) {
	resetPinnedSPKIHashes(t)
	_, err := NewClient(Config{
		ConsumerKey: "test-key", ConsumerSecret: "test-secret", Environment: Sandbox,
		TLSPinningEnabled: true,
	})
	if err == nil {
		t.Fatal("NewClient with pinning and no pin succeeded, want fail-closed error")
	}
	if !strings.Contains(err.Error(), "fail closed") && !strings.Contains(err.Error(), "PinSPKI") {
		t.Fatalf("err = %v, want an actionable PinSPKI message", err)
	}
}

// A wrapper/custom RoundTripper cannot be pinned without silently discarding
// the caller's middleware or silently skipping the check, so NewClient must
// refuse and point at SPKIVerifier.
func TestPin_NewClientPinningCustomRoundTripper_Errors(t *testing.T) {
	resetPinnedSPKIHashes(t)
	// Pin the hostname the client connects to, so this test isolates the
	// RoundTripper refusal rather than the empty-pin-set refusal.
	_, hash := generatePinnedCert(t)
	if err := PinSPKI(hostnameFromURL(Sandbox.BaseURL()), hash); err != nil {
		t.Fatalf("PinSPKI: %v", err)
	}
	for name, rt := range map[string]http.RoundTripper{
		"opaque":    opaqueTransport{inner: &http.Transport{}},
		"wrapped":   unwrapTransport{inner: &http.Transport{}},
		"bare func": roundTripperFunc(func(*http.Request) (*http.Response, error) { return nil, nil }),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := NewClient(Config{
				ConsumerKey: "test-key", ConsumerSecret: "test-secret", Environment: Sandbox,
				TLSPinningEnabled: true,
				HTTPClient:        &http.Client{Transport: rt},
			})
			if err == nil {
				t.Fatalf("NewClient with pinning on %s RoundTripper succeeded, want refusal", name)
			}
			if !strings.Contains(err.Error(), "SPKIVerifier") {
				t.Fatalf("err = %v, want a pointer at mpesa.SPKIVerifier", err)
			}
		})
	}
}

// roundTripperFunc adapts a function to http.RoundTripper for tests that need
// a fully custom, non-*http.Transport implementation.
type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// TestPinSPKIDeepCopiesCallerBytes verifies the pin-bytes aliasing fix:
// PinSPKI must clone the caller's slice, snapshots must deep-clone each
// entry, and SPKIVerifier must capture its own copy — so mutating
// caller-owned bytes after registration can never move the live pin set.
func TestPinSPKIDeepCopiesCallerBytes(t *testing.T) {
	resetPinnedSPKIHashes(t)
	const hostname = "pin-clone.example.com"
	rawDER, hash := generatePinnedCert(t)
	want := bytes.Clone(hash)

	if err := PinSPKI(hostname, hash); err != nil {
		t.Fatalf("PinSPKI: %v", err)
	}
	// Mutate the caller's array after registration.
	hash[0] ^= 0xFF
	hash[sha256.Size-1] ^= 0xFF

	// The live registry must still hold the original bytes.
	snap := pinnedPinsSnapshot(hostname)
	if len(snap) != 1 || !bytes.Equal(snap[0], want) {
		t.Fatal("caller mutation after PinSPKI moved the registered pin; PinSPKI must clone")
	}
	// A verifier over the snapshot must still accept the genuine certificate.
	if err := SPKIVerifier(hostname, snap)([][]byte{rawDER}, nil); err != nil {
		t.Fatalf("snapshot verifier rejected the genuine certificate after caller mutation: %v", err)
	}

	// Mutating a snapshot must not move the live registry (deep-clone).
	snap[0][0] ^= 0xFF
	fresh := pinnedPinsSnapshot(hostname)
	if len(fresh) != 1 || !bytes.Equal(fresh[0], want) {
		t.Fatal("snapshot mutation moved the live pin set; snapshots must deep-clone each entry")
	}

	// Mutating the pins handed to SPKIVerifier must not move the verifier —
	// neither through the inner arrays nor by replacing the outer entries.
	pins := [][]byte{bytes.Clone(want)}
	verify := SPKIVerifier(hostname, pins)
	pins[0][0] ^= 0xFF
	pins[0] = bytes.Repeat([]byte{0x00}, sha256.Size)
	if err := verify([][]byte{rawDER}, nil); err != nil {
		t.Fatalf("SPKIVerifier followed caller mutation; it must capture a deep copy: %v", err)
	}
}
