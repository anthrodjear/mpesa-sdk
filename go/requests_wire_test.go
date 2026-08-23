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
