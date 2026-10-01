package mpesa

import (
	"encoding/json"
	"strings"
	"testing"
)

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
