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
	b, _ := json.Marshal(ReversalRequest{RecieverIdentifierType: ReceiverIdentifierOrg})
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["RecieverIdentifierType"]; !ok {
		t.Fatalf("missing misspelled key RecieverIdentifierType in %s", b)
	}
	if _, ok := m["ReceiverIdentifierType"]; ok {
		t.Error("correctly-spelled key must not be emitted")
	}
}

func TestC2BAckParsesMisspelledField(t *testing.T) {
	payload := `{"OriginatorCoversationID":"53e3-4aa8-9fe0-8fb5e4092cdd3405976","ResponseCode":"0","ResponseDescription":"Accept the service request successfully."}`
	var ack C2BAckResponse
	if err := json.Unmarshal([]byte(payload), &ack); err != nil {
		t.Fatal(err)
	}
	if ack.OriginatorConversationID != "53e3-4aa8-9fe0-8fb5e4092cdd3405976" {
		t.Fatalf("OriginatorConversationID = %q", ack.OriginatorConversationID)
	}
}

func TestQRCodeRequestRefNoFieldName(t *testing.T) {
	b, _ := json.Marshal(QRCodeRequest{
		MerchantName: "TEST SUPERMARKET",
		RefNo:        "Invoice Test",
		Amount:       1,
		TrxCode:      "BG",
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

func TestSTKQueryResponseResultCodeCoercesStringOrInt(t *testing.T) {
	for _, payload := range []string{
		`{"ResponseCode":"0","ResultCode":"1032","ResultDesc":"Request cancelled by user"}`,
		`{"ResponseCode":"0","ResultCode":1032,"ResultDesc":"Request cancelled by user"}`,
	} {
		var resp STKQueryResponse
		if err := json.Unmarshal([]byte(payload), &resp); err != nil {
			t.Fatal(err)
		}
		if resp.ResultCode.String() != "1032" {
			t.Errorf("ResultCode = %q, want 1032 (payload %s)", resp.ResultCode.String(), payload)
		}
		if got := ClassifyResultCode(resp.ResultCode.String()); got != ResultClassIndeterminate {
			t.Errorf("1032 classified %q, want indeterminate", got)
		}
	}
}

func TestOAuthExpiresInLenient(t *testing.T) {
	var s struct {
		Token     string    `json:"access_token"`
		ExpiresIn FlexInt64 `json:"expires_in"`
	}
	if err := json.Unmarshal([]byte(`{"access_token":"t","expires_in":"3599"}`), &s); err != nil || s.ExpiresIn != 3599 {
		t.Fatalf("string expires_in: %+v err=%v", s, err)
	}
	if err := json.Unmarshal([]byte(`{"access_token":"t","expires_in":3600}`), &s); err != nil || s.ExpiresIn != 3600 {
		t.Fatalf("numeric expires_in: %+v err=%v", s, err)
	}
}

func TestStkCallbackParseWithMetadata(t *testing.T) {
	payload := []byte(`{
		"Body": {"stkCallback": {
			"MerchantRequestID": "29115-34620561-1",
			"CheckoutRequestID": "ws_CO_191220191020363925",
			"ResultCode": 0,
			"ResultDesc": "The service request is processed successfully.",
			"CallbackMetadata": {"Item": [
				{"Name": "Amount", "Value": 1.0},
				{"Name": "MpesaReceiptNumber", "Value": "NLJ7RT61SV"},
				{"Name": "TransactionDate", "Value": 20191219102115},
				{"Name": "PhoneNumber", "Value": 254708374149}
			]}
		}}
	}`)
	var cb StkCallback
	if err := json.Unmarshal(payload, &cb); err != nil {
		t.Fatal(err)
	}
	res := cb.Body.StkCallback
	if res.MerchantRequestID != "29115-34620561-1" || res.CheckoutRequestID != "ws_CO_191220191020363925" {
		t.Fatalf("ids = %+v", res)
	}
	if res.ResultCode.String() != "0" {
		t.Fatalf("ResultCode = %q", res.ResultCode.String())
	}
	if ClassifyResultCode(res.ResultCode.String()) != ResultClassSuccess {
		t.Fatal("code 0 must classify success")
	}
	md := res.MetadataMap()
	if md["MpesaReceiptNumber"] != "NLJ7RT61SV" {
		t.Fatalf("receipt = %v (%T)", md["MpesaReceiptNumber"], md["MpesaReceiptNumber"])
	}
	if amt, ok := md["Amount"].(float64); !ok || amt != 1.0 {
		t.Fatalf("amount = %v (%T)", md["Amount"], md["Amount"])
	}
	if date, ok := md["TransactionDate"].(float64); !ok || date != 20191219102115 {
		t.Fatalf("TransactionDate = %v (%T)", md["TransactionDate"], md["TransactionDate"])
	}
	if phone, ok := md["PhoneNumber"].(float64); !ok || phone != 254708374149 {
		t.Fatalf("PhoneNumber = %v (%T)", md["PhoneNumber"], md["PhoneNumber"])
	}
}

func TestStkCallbackAbsentMetadataTolerated(t *testing.T) {
	payload := []byte(`{"Body":{"stkCallback":{"MerchantRequestID":"x","CheckoutRequestID":"ws_CO_1","ResultCode":1037,"ResultDesc":"DS timeout"}}}`)
	var cb StkCallback
	if err := json.Unmarshal(payload, &cb); err != nil {
		t.Fatal(err)
	}
	md := cb.Body.StkCallback.MetadataMap()
	if len(md) != 0 {
		t.Fatalf("metadata = %v, want empty map", md)
	}
	if got := ClassifyResultCode(cb.Body.StkCallback.ResultCode.String()); got != ResultClassIndeterminate {
		t.Fatalf("1037 classified %q", got)
	}
}

func TestAsyncResultParameters(t *testing.T) {
	payload := []byte(`{"Result":{"ResultType":0,"ResultCode":0,"ResultDesc":"ok","OriginatorConversationID":"o1","ConversationID":"AG_1","TransactionID":"SG632NMUAB","ResultParameters":{"ResultParameter":[{"Key":"TransactionReceipt","Value":"SG632NMUAB"},{"Key":"TransactionAmount","Value":10},{"Key":"B2CRecipientIsRegisteredCustomer","Value":"Y"}]}}}`)
	var ar AsyncResult
	if err := json.Unmarshal(payload, &ar); err != nil {
		t.Fatal(err)
	}
	params := ar.Result.Parameters()
	if params["TransactionReceipt"] != "SG632NMUAB" || params["TransactionAmount"] != "10" || params["B2CRecipientIsRegisteredCustomer"] != "Y" {
		t.Fatalf("params = %v", params)
	}
	var missing AsyncResultBody
	if p := missing.Parameters(); len(p) != 0 {
		t.Fatalf("absent parameters gave %v", p)
	}
}

func TestErrorFormatting(t *testing.T) {
	e := &Error{StatusCode: 400, RequestID: "27504-1", ErrorCode: "400.002.02", ErrorMessage: "Bad Request - Invalid BusinessShortCode"}
	msg := e.Error()
	for _, want := range []string{"400", "400.002.02", "Invalid BusinessShortCode", "27504-1"} {
		if !strings.Contains(msg, want) {
			t.Errorf("Error() = %q, want substring %q", msg, want)
		}
	}
}
