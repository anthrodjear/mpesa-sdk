package mpesa

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// Every request type that carries a callback/result URL must redact it in
// BOTH fmt verbs and LogSafe().
//
// Why this matters: the callback URLs Daraja hands out may embed the 128-bit
// capability token used to authenticate callbacks, so a leaked callback URL
// is a leaked callback credential.
//
// CAVEAT (documented, not asserted here): json.Marshal(req) STILL emits the
// URL in cleartext — it bypasses the GoString/Format hooks, which only
// cover fmt verbs. That is exactly why LogSafe() exists, and why every
// LogSafe() docstring in requests.go warns "never json.Marshal(req) for
// logging". This test deliberately does NOT assert the leak, so a future
// redacting MarshalJSON can be added without breaking it.
func TestCallbackURLRedactedInFmtAndLogSafe(t *testing.T) {
	const (
		callbackURL = "https://mydomain.com/callback?capability_token=TOPSECRETTOKEN"
		resultURL   = "https://mydomain.com/result?capability_token=TOPSECRETTOKEN"
		confirmURL  = "https://mydomain.com/confirm?capability_token=TOPSECRETTOKEN"
		validURL    = "https://mydomain.com/validate?capability_token=TOPSECRETTOKEN"
	)

	stk := STKPushRequest{
		BusinessShortCode: "174379", TransactionType: TransactionTypePayBillOnline, Amount: 1,
		PartyA: "254722000000", PartyB: "174379", PhoneNumber: "254722111111",
		CallBackURL: callbackURL, AccountReference: "accountref", TransactionDesc: "txndesc",
	}
	b2c := B2CPayoutRequest{
		OriginatorConversationID: "abc123", InitiatorName: "testapi",
		SecurityCredential: "cred", CommandID: CommandBusinessPayment, Amount: 100,
		PartyA: "600992", PartyB: "254705912645", Remarks: "refund order 42",
		QueueTimeOutURL: resultURL, ResultURL: resultURL,
	}
	tx := TransactionStatusRequest{
		Initiator: "testapi", SecurityCredential: "cred", TransactionID: "NLJ7RT61SV",
		PartyA: "600992", Remarks: "reconcile", ResultURL: resultURL, QueueTimeOutURL: resultURL,
	}
	rev := ReversalRequest{
		Initiator: "testapi", SecurityCredential: "cred", TransactionID: "NLJ7RT61SV",
		Amount: 100, ReceiverParty: "600992", Remarks: "wrong deposit",
		ResultURL: resultURL, QueueTimeOutURL: resultURL,
	}
	bal := AccountBalanceRequest{
		Initiator: "testapi", SecurityCredential: "cred", PartyA: "600992",
		Remarks: "eod balance", ResultURL: resultURL, QueueTimeOutURL: resultURL,
	}
	reg := C2BRegisterRequest{
		ShortCode: "174379", ResponseType: ResponseTypeCompleted,
		ConfirmationURL: confirmURL, ValidationURL: validURL,
	}

	cases := []struct {
		name     string
		urls     []string
		render   string
		logSafe  map[string]any
		redacted []string
	}{
		{"STKPush", []string{callbackURL}, fmt.Sprintf("%v", stk), stk.LogSafe(), []string{"CallBackURL"}},
		{"B2C", []string{resultURL}, fmt.Sprintf("%v", b2c), b2c.LogSafe(), []string{"ResultURL", "QueueTimeOutURL"}},
		{"TxStatus", []string{resultURL}, fmt.Sprintf("%v", tx), tx.LogSafe(), []string{"ResultURL", "QueueTimeOutURL"}},
		{"Reversal", []string{resultURL}, fmt.Sprintf("%v", rev), rev.LogSafe(), []string{"ResultURL", "QueueTimeOutURL"}},
		{"Balance", []string{resultURL}, fmt.Sprintf("%v", bal), bal.LogSafe(), []string{"ResultURL", "QueueTimeOutURL"}},
		{"C2BRegister", []string{confirmURL, validURL}, fmt.Sprintf("%v", reg), reg.LogSafe(), []string{"ConfirmationURL", "ValidationURL"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 1. Every fmt verb must render redacted.
			for _, url := range tc.urls {
				if strings.Contains(tc.render, url) {
					t.Errorf("%%v rendering leaks the callback URL %q: %s", url, tc.render)
				}
			}
			// 2. LogSafe() must carry the marker for every URL-bearing key,
			//    and its serialized form must not contain the URL.
			for _, key := range tc.redacted {
				got, ok := tc.logSafe[key]
				if !ok {
					t.Fatalf("LogSafe missing %q key: %v", key, tc.logSafe)
				}
				if got != "[REDACTED]" {
					t.Errorf("LogSafe[%q] = %v, want [REDACTED]", key, got)
				}
			}
			b, err := json.Marshal(tc.logSafe)
			if err != nil {
				t.Fatalf("marshal LogSafe: %v", err)
			}
			for _, url := range tc.urls {
				if strings.Contains(string(b), url) {
					t.Errorf("LogSafe JSON leaks the callback URL %q: %s", url, b)
				}
			}
		})
	}
}

func TestB2CRequestUsesOfficialOccassionSpelling(t *testing.T) {
	b, err := json.Marshal(B2CPayoutRequest{
		OriginatorConversationID: "600997_Test_32et3241ed8yu",
		InitiatorName:            "testapi",
		SecurityCredential:       "cred",
		CommandID:                CommandBusinessPayment,
		Amount:                   10,
		PartyA:                   "600992",
		PartyB:                   "254705912645",
		Remarks:                  "remarked",
		QueueTimeOutURL:          "https://mydomain.com/timeout",
		ResultURL:                "https://mydomain.com/result",
		Occassion:                "ChristmasPay",
	})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"Occassion", "InitiatorName", "QueueTimeOutURL", "ResultURL", "OriginatorConversationID"} {
		if _, ok := m[key]; !ok {
			t.Errorf("missing JSON key %q in %s", key, b)
		}
	}
	if _, ok := m["Initiator"]; ok {
		t.Error("B2C must use InitiatorName, not Initiator")
	}
	if _, ok := m["Occasion"]; ok {
		t.Error("B2C must use double-s Occassion")
	}
}

func TestReversalRequestRecieverIdentifierTypeSpelling(t *testing.T) {
	b, _ := json.Marshal(ReversalRequest{ReceiverIdentifierType: ReceiverIdentifierOrg})
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["RecieverIdentifierType"]; !ok {
		t.Fatalf("wire key must stay misspelled RecieverIdentifierType in %s", b)
	}
	if _, ok := m["ReceiverIdentifierType"]; ok {
		t.Error("correctly-spelled wire key must not be emitted")
	}
}

func TestQRCodeRequestRefNoFieldName(t *testing.T) {
	b, _ := json.Marshal(QRCodeRequest{
		MerchantName: "TEST SUPERMARKET",
		RefNo:        "Invoice Test",
		Amount:       1,
		TrxCode:      QRTrxBuyGoods,
		CPI:          "174379",
		Size:         "300",
	})
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["RefNo"]; !ok {
		t.Errorf("missing RefNo key in %s", b)
	}
	if _, ok := m["RefNumber"]; ok {
		t.Errorf("RefNumber must never appear; got %s", b)
	}
}

func TestExportedValidateGuardrails(t *testing.T) {
	bad := STKPushRequest{
		BusinessShortCode: "174379", TransactionType: TransactionTypePayBillOnline, Amount: -1,
		PartyA: "254722000000", PartyB: "174379", PhoneNumber: "254722111111",
		CallBackURL: "https://mydomain.com/path", AccountReference: "accountref", TransactionDesc: "txndesc",
	}
	if err := bad.Validate(); err == nil || !strings.Contains(err.Error(), "Amount") {
		t.Fatalf("direct Validate() = %v, want Amount error", err)
	}
	good := STKPushRequest{
		BusinessShortCode: "174379", TransactionType: TransactionTypePayBillOnline, Amount: 1,
		PartyA: "254722000000", PartyB: "174379", PhoneNumber: "254722111111",
		CallBackURL: "https://mydomain.com/path", AccountReference: "accountref", TransactionDesc: "txndesc",
	}
	if err := good.Validate(); err != nil {
		t.Fatalf("valid fixture rejected: %v", err)
	}
	// K1: no invented default — empty TransactionType must be rejected with
	// both enum values named.
	noTT := good
	noTT.TransactionType = ""
	err := noTT.Validate()
	if err == nil || !strings.Contains(err.Error(), "(CustomerPayBillOnline | CustomerBuyGoodsOnline)") {
		t.Fatalf("empty TransactionType err = %v, want required-with-enums message", err)
	}
	qr := QRCodeRequest{MerchantName: "m", RefNo: "r", Amount: 1, TrxCode: QRTrxSendMoney, CPI: "254712345678", Size: "300"}
	if err := qr.Validate(); err != nil {
		t.Fatalf("valid QR fixture rejected: %v", err)
	}
}

func TestSTKPushRequestWireKeys(t *testing.T) {
	b, _ := json.Marshal(STKPushRequest{
		BusinessShortCode: "174379", Amount: 1, PartyA: "254722000000", PartyB: "174379",
		PhoneNumber: "254722111111", CallBackURL: "https://mydomain.com/path",
		AccountReference: "accountref", TransactionDesc: "txndesc",
	})
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"BusinessShortCode", "Amount", "PartyA", "PartyB", "PhoneNumber", "CallBackURL", "AccountReference", "TransactionDesc"} {
		if _, ok := m[key]; !ok {
			t.Errorf("missing wire key %q in %s", key, b)
		}
	}
	if _, ok := m["Password"]; ok {
		t.Error("Password must be client-injected, never a request field")
	}
	if _, ok := m["Timestamp"]; ok {
		t.Error("Timestamp must be client-injected, never a request field")
	}
}

func TestRequireURL(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		// Valid URLs
		{name: "valid https", input: "https://example.com/callback", wantErr: false},
		{name: "valid http", input: "http://example.com/path", wantErr: false},
		{name: "valid with port", input: "https://example.com:8443/hook", wantErr: false},
		{name: "valid with path and query", input: "https://api.example.com/v1/cb?token=abc", wantErr: false},

		// Embedded credentials
		{name: "credentials https", input: "https://user:pass@example.com/cb", wantErr: true},
		{name: "credentials http", input: "http://admin:secret@localhost/hook", wantErr: true},

		// Invalid schemes
		{name: "file scheme", input: "file:///etc/passwd", wantErr: true},
		{name: "gopher scheme", input: "gopher://example.com", wantErr: true},
		{name: "ftp scheme", input: "ftp://example.com/file", wantErr: true},
		{name: "no scheme", input: "example.com/callback", wantErr: true},

		// Empty host
		{name: "empty host https", input: "https:///path", wantErr: true},
		{name: "empty host http", input: "http:///path", wantErr: true},

		// Malformed URLs
		{name: "malformed", input: "https://exam ple.com/sp ace", wantErr: true},
		{name: "just text", input: "not-a-url", wantErr: true},
		{name: "empty string", input: "", wantErr: true},

		// Internal/private IPs (SSRF)
		{name: "localhost", input: "http://localhost:8080/cb", wantErr: true},
		{name: "loopback 127.0.0.1", input: "http://127.0.0.1/admin", wantErr: true},
		{name: "private 10.x", input: "http://10.0.0.1/internal", wantErr: true},
		{name: "private 192.168.x", input: "http://192.168.1.1/router", wantErr: true},
		{name: "private 172.16.x", input: "http://172.16.0.1/service", wantErr: true},
		{name: "unspecified 0.0.0.0", input: "http://0.0.0.0/", wantErr: true},
		{name: "0.0.0.0/8 member", input: "http://0.1.2.3/", wantErr: true},

		// IPv6 zone identifiers (net.ParseIP rejects "fe80::1%eth0", so the
		// zone form must be rejected before the IP guards).
		{name: "ipv6 zone fe80", input: "http://[fe80::1%25eth0]/", wantErr: true},
		{name: "ipv6 zone doc", input: "http://[2001:db8::1%25eth0]/", wantErr: true},

		// inet_aton aliases: leading parts are one byte; the last part owns
		// the remaining bits (24/16/8 for n=2/3/4). Out-of-slot values must
		// fail closed; in-slot short forms normalise and hit the blocklist.
		{name: "inet_aton first part overflow", input: "http://256.1.1.1/", wantErr: true},
		{name: "inet_aton second part overflow", input: "http://1.256.1.1/", wantErr: true},
		{name: "inet_aton three-part overflow", input: "http://1.2.16777215/", wantErr: true},
		{name: "inet_aton two-part loopback", input: "http://127.1/", wantErr: true},
		{name: "inet_aton hex loopback", input: "http://0x7f.1/", wantErr: true},
		{name: "inet_aton two-part public", input: "http://1.16777215/", wantErr: false},
		{name: "inet_aton three-part public", input: "http://1.2.65535/", wantErr: false},

		// Numeric-shaped no-dot hosts fail closed instead of falling to DNS.
		{name: "signed decimal host", input: "http://-1/", wantErr: true},
		{name: "plus-signed host", input: "http://+1/", wantErr: true},
		{name: "invalid hex token", input: "http://0xzz/", wantErr: true},
		{name: "hex-looking domain still DNS", input: "http://0xdeadbeef.com/", wantErr: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := requireURL("TestURL", tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("requireURL(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
			}
		})
	}
}

func TestNormalizeNumericHostWidths(t *testing.T) {
	tests := []struct {
		host    string
		want    string // dotted-quad; empty means must be rejected
		wantErr bool
	}{
		// Leading parts are exactly one byte: a value >= 256 cannot fit.
		{host: "256.1.1.1", wantErr: true},
		{host: "1.256.1.1", wantErr: true},
		{host: "1.1.1.256", wantErr: true},
		// The last part owns the remaining bits: 24 for n=2, 16 for n=3.
		{host: "1.2.16777215", wantErr: true},
		{host: "1.2.65535", want: "1.2.255.255"},
		{host: "1.16777215", want: "1.255.255.255"},
		{host: "127.1", want: "127.0.0.1"},
		{host: "0x7f.1", want: "127.0.0.1"},
		{host: "127.0.0.1", want: "127.0.0.1"},
		{host: "4294967295", want: "255.255.255.255"},
		{host: "0xzz", wantErr: true},
		{host: "-1", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.host, func(t *testing.T) {
			ip, ok := normalizeNumericHost(tt.host)
			if tt.wantErr {
				if ok {
					t.Fatalf("normalizeNumericHost(%q) = %v, want rejection", tt.host, ip)
				}
				return
			}
			if !ok {
				t.Fatalf("normalizeNumericHost(%q) rejected, want %s", tt.host, tt.want)
			}
			if got := ip.String(); got != tt.want {
				t.Errorf("normalizeNumericHost(%q) = %s, want %s", tt.host, got, tt.want)
			}
		})
	}
}

func TestC2BWireKeys(t *testing.T) {
	reg, _ := json.Marshal(C2BRegisterRequest{ShortCode: "174379", ResponseType: ResponseTypeCompleted, ConfirmationURL: "https://a.com/c", ValidationURL: "https://a.com/v"})
	var regM map[string]json.RawMessage
	if err := json.Unmarshal(reg, &regM); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"ResponseType", "ConfirmationURL", "ValidationURL", "ShortCode"} {
		if _, ok := regM[key]; !ok {
			t.Errorf("register missing wire key %q in %s", key, reg)
		}
	}
	sim, _ := json.Marshal(C2BSimulateRequest{ShortCode: "174379", CommandID: TransactionTypePayBillOnline, Amount: 5, Msisdn: "254712345678", BillRefNumber: "acct-1"})
	var simM map[string]json.RawMessage
	if err := json.Unmarshal(sim, &simM); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"ResponseType"} {
		if _, ok := simM[key]; ok {
			t.Errorf("simulate must not carry register-only key %q", key)
		}
	}
	for _, key := range []string{"CommandID", "Amount", "Msisdn", "BillRefNumber", "ShortCode"} {
		if _, ok := simM[key]; !ok {
			t.Errorf("simulate missing wire key %q in %s", key, sim)
		}
	}
}

// TestSTKQueryBusinessShortCodeValidation verifies Python parity:
// BusinessShortCode is validated as 5-10 digits WHEN PRESENT (it's
// optional in STKQueryRequest, defaulting to client's cfg.Shortcode).
// Empty = skip (client will inject), non-empty = must match shortcodeRe.
func TestSTKQueryBusinessShortCodeValidation(t *testing.T) {
	tests := []struct {
		name      string
		shortcode string
		wantErr   bool
	}{
		{name: "empty_skips_validation", shortcode: "", wantErr: false},
		{name: "valid_5_digits", shortcode: "12345", wantErr: false},
		{name: "valid_10_digits", shortcode: "1234567890", wantErr: false},
		{name: "too_short_4_digits", shortcode: "1234", wantErr: true},
		{name: "too_long_11_digits", shortcode: "12345678901", wantErr: true},
		{name: "non_digits", shortcode: "abcde", wantErr: true},
		{name: "mixed", shortcode: "1234a", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := STKQueryRequest{
				BusinessShortCode: tt.shortcode,
				CheckoutRequestID: "ws_CO_test",
			}
			err := r.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() with shortcode=%q err=%v, wantErr=%v", tt.shortcode, err, tt.wantErr)
			}
		})
	}
}
