// Helpers: EAT clock/password generation, MSISDN normalization and
// SecurityCredential encryption.

package mpesa

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// eatZone is East Africa Time (UTC+3), the only timezone Safaricom accepts in
// request timestamps.
var eatZone = time.FixedZone("EAT", 3*60*60)

const eatLayout = "20060102150405"

// GeneratePassword builds the STK Push/Query Password and Timestamp pair from
// a single instant. The returned timestamp MUST be sent verbatim in the
// request body alongside the password — deriving them from different clocks
// causes intermittent 500.001.1001 errors (the two-clock bug).
func GeneratePassword(shortcode, passkey string, t time.Time) (password, timestamp string) {
	timestamp = t.In(eatZone).Format(eatLayout)
	password = base64.StdEncoding.EncodeToString([]byte(shortcode + passkey + timestamp))
	return password, timestamp
}

var phonePattern = regexp.MustCompile(`^254[17]\d{8}$`)

// NormalizePhone converts Kenyan MSISDN shorthand to gateway form:
// 07XXXXXXXX / +2547XXXXXXXX / 2547XXXXXXXX → 2547XXXXXXXX (or 2541…).
func NormalizePhone(s string) (string, error) {
	p := strings.Map(func(r rune) rune {
		switch r {
		case ' ', '-', '(', ')':
			return -1
		}
		return r
	}, strings.TrimSpace(s))
	switch {
	case strings.HasPrefix(p, "+254"):
		p = p[1:]
	case strings.HasPrefix(p, "0"):
		p = "254" + p[1:]
	}
	if !phonePattern.MatchString(p) {
		return "", fmt.Errorf("mpesa: %q is not a valid Kenyan MSISDN (want 07XX/+2547XX/2547XX)", s)
	}
	return p, nil
}

// SecurityCredential encrypts the initiator password with the M-Pesa public
// key certificate using RSA PKCS#1 v1.5 and base64-encodes the ciphertext.
// The certificate may be PEM or raw DER; validity dates and chains are
// deliberately NOT verified because official certs ship long-expired by design.
func SecurityCredential(certPEMorDER []byte, initiatorPassword string) (string, error) {
	der := certPEMorDER
	if block, _ := pem.Decode(der); block != nil {
		der = block.Bytes
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return "", fmt.Errorf("mpesa: parse M-Pesa certificate: %w", err)
	}
	pub, ok := cert.PublicKey.(*rsa.PublicKey)
	if !ok {
		return "", fmt.Errorf("mpesa: M-Pesa certificate carries non-RSA public key %T", cert.PublicKey)
	}
	if initiatorPassword == "" {
		return "", fmt.Errorf("mpesa: initiator password is required")
	}
	ct, err := rsa.EncryptPKCS1v15(rand.Reader, pub, []byte(initiatorPassword))
	if err != nil {
		return "", fmt.Errorf("mpesa: encrypt security credential: %w", err)
	}
	return base64.StdEncoding.EncodeToString(ct), nil
}

// newOriginatorID mints an idempotency key for async APIs when the caller
// omits OriginatorConversationID (<20 chars per Daraja constraint).
func newOriginatorID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return fmt.Sprintf("%x", b)
}
