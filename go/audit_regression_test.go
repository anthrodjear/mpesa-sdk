package mpesa

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// Regression pins for the 2026-11-22 security/correctness audit.

func TestAuditSanitizeWireStringDropsLineSeparators(t *testing.T) {
	got := sanitizeWireString("a\u2028b\u2029c\x00d", 512)
	if got != "abcd" {
		t.Fatalf("sanitizeWireString = %q, want %q", got, "abcd")
	}
}

func TestAuditGeneratePasswordRejectsBlankPasskey(t *testing.T) {
	for _, passkey := range []string{"", "   ", "\t\n"} {
		if _, _, err := GeneratePassword("600992", passkey, time.Now()); err == nil {
			t.Errorf("GeneratePassword with passkey %q: expected error", passkey)
		}
	}
}

func TestAuditCallbackMetadataKeepsLargeIntegerExact(t *testing.T) {
	m := MetadataItem{Name: "Amount", Value: json.RawMessage(`9007199254740993`)}
	got := m.decodedValue()
	v, ok := got.(int64)
	if !ok || v != 9007199254740993 {
		t.Fatalf("decodedValue = %#v (%T), want int64(9007199254740993)", got, got)
	}
}

func TestAuditResultCodeExponentIsIndeterminate(t *testing.T) {
	if got := ClassifyResultCode("0e0"); got != ResultClassIndeterminate {
		t.Fatalf("ClassifyResultCode(\"0e0\") = %q, want %q", got, ResultClassIndeterminate)
	}
}

func TestAuditReferenceItemNumericValueDoesNotBreakDecode(t *testing.T) {
	var rd ReferenceData
	body := []byte(`{"ReferenceItem":{"Key":"k","Value":123}}`)
	if err := json.Unmarshal(body, &rd); err != nil {
		t.Fatalf("unexpected decode error: %v", err)
	}
	if len(rd.ReferenceItem) != 1 || rd.ReferenceItem[0].Value != "123" {
		t.Fatalf("ReferenceItem = %#v, want single item with Value \"123\"", rd.ReferenceItem)
	}
}

func TestAuditSTKPushRejectsControlCharacters(t *testing.T) {
	r := STKPushRequest{
		BusinessShortCode: "600992",
		TransactionType:   "CustomerPayBillOnline",
		Amount:            1,
		PartyA:            "254708374149",
		PartyB:            "600992",
		PhoneNumber:       "254708374149",
		CallBackURL:       "https://example.com/cb",
		AccountReference:  "ref\nX",
		TransactionDesc:   "desc",
	}
	if err := r.ValidateWithLimits(DefaultTransactionLimits()); err == nil {
		t.Fatal("expected control character in AccountReference to be rejected")
	}
	r.AccountReference = "ref"
	r.TransactionDesc = "desc\x00more"
	if err := r.ValidateWithLimits(DefaultTransactionLimits()); err == nil {
		t.Fatal("expected NUL in TransactionDesc to be rejected")
	}
	r.TransactionDesc = strings.Repeat("d", 13)
	if err := r.ValidateWithLimits(DefaultTransactionLimits()); err != nil {
		t.Fatalf("valid STK request rejected: %v", err)
	}
}
