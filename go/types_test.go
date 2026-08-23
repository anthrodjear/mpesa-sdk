package mpesa

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
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
		if got := ClassifyResultCode(resp.ResultCode.String()); got != ResultClassFailure {
			t.Errorf("1032 classified %q, want failure (user-cancelled is terminal, new intent ok)", got)
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
		t.Fatalf("Amount must stay float64, got %v (%T)", md["Amount"], md["Amount"])
	}
	if date, ok := md["TransactionDate"].(int64); !ok || date != 20191219102115 {
		t.Fatalf("integral TransactionDate must decode as int64, got %v (%T)", md["TransactionDate"], md["TransactionDate"])
	}
	if phone, ok := md["PhoneNumber"].(int64); !ok || phone != 254708374149 {
		t.Fatalf("integral PhoneNumber must decode as int64, got %v (%T)", md["PhoneNumber"], md["PhoneNumber"])
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

// Matrix beside ClassifyResultCode: success only ever 0; terminal failures
// per stk-push.md/b2c.md/account-balance.md; everything else indeterminate.
func TestClassifyResultCodeMatrix(t *testing.T) {
	cases := []struct {
		code string
		want ResultClass
	}{
		{"0", ResultClassSuccess},
		{"0.0", ResultClassSuccess}, // integral float fallback
		{"1", ResultClassFailure},
		{"17", ResultClassFailure},
		{"1019", ResultClassFailure},
		{"1025", ResultClassFailure},
		{"1032", ResultClassFailure}, // user-cancelled: terminal, new intent ok
		{"2001", ResultClassFailure},
		{"9999", ResultClassFailure},
		{"1001", ResultClassIndeterminate},
		{"1037", ResultClassIndeterminate},
		{"26", ResultClassIndeterminate},
		{"4999", ResultClassIndeterminate},
		{"1.5", ResultClassIndeterminate}, // non-integral never coerces
		{"-5", ResultClassIndeterminate},
		{"123456", ResultClassIndeterminate},
		{"SFC_IC0003", ResultClassIndeterminate},
		{"", ResultClassIndeterminate},
	}
	for _, tc := range cases {
		if got := ClassifyResultCode(tc.code); got != tc.want {
			t.Errorf("ClassifyResultCode(%q) = %q, want %q", tc.code, got, tc.want)
		}
	}
}

// Catalogs transcribed from docs/apis/b2c.md and docs/apis/account-balance.md;
// guards the async terminal-failure set against catalog drift.
func TestAsyncTerminalFailureCatalogs(t *testing.T) {
	b2c := map[string]ResultClass{
		"0":          ResultClassSuccess,
		"1":          ResultClassFailure,
		"2":          ResultClassFailure,
		"3":          ResultClassFailure,
		"4":          ResultClassFailure,
		"8":          ResultClassFailure,
		"11":         ResultClassFailure,
		"21":         ResultClassFailure,
		"2001":       ResultClassFailure,
		"2006":       ResultClassFailure,
		"2028":       ResultClassFailure,
		"2040":       ResultClassFailure,
		"8006":       ResultClassFailure,
		"SFC_IC0003": ResultClassIndeterminate,
	}
	accountBalance := map[string]ResultClass{
		"15":          ResultClassFailure,
		"17":          ResultClassFailure,
		"22":          ResultClassFailure,
		"18":          ResultClassIndeterminate,
		"20":          ResultClassIndeterminate,
		"24":          ResultClassIndeterminate,
		"25":          ResultClassIndeterminate,
		"26":          ResultClassIndeterminate,
		"29":          ResultClassIndeterminate,
		"100000011":   ResultClassIndeterminate,
		"00.002.1001": ResultClassIndeterminate,
	}
	for _, catalog := range []map[string]ResultClass{b2c, accountBalance} {
		for code, want := range catalog {
			if got := ClassifyResultCode(code); got != want {
				t.Errorf("catalog code %q classified %q, want %q", code, got, want)
			}
		}
	}
}

func TestSecretRedaction(t *testing.T) {
	cfg := Config{
		ConsumerKey:    "ck-visible",
		ConsumerSecret: "cs-TOPSECRET",
		Shortcode:      "174379",
		Passkey:        "pass-TOPSECRET",
		Environment:    Sandbox,
		Timeout:        30 * time.Second,
	}
	shown := fmt.Sprintf("%+v", cfg)
	if strings.Contains(shown, "cs-TOPSECRET") || strings.Contains(shown, "pass-TOPSECRET") {
		t.Fatalf("Config %%+v leaked secrets: %s", shown)
	}
	for _, want := range []string{"secrets:redacted", "ck-visible", "174379"} {
		if !strings.Contains(shown, want) {
			t.Fatalf("Config GoString missing %q: %s", want, shown)
		}
	}
	reqs := []any{
		B2CPayoutRequest{SecurityCredential: "cred-TOPSECRET", InitiatorName: "init-visible"},
		TransactionStatusRequest{SecurityCredential: "cred-TOPSECRET", Initiator: "init-visible"},
		ReversalRequest{SecurityCredential: "cred-TOPSECRET", Initiator: "init-visible"},
		AccountBalanceRequest{SecurityCredential: "cred-TOPSECRET", Initiator: "init-visible"},
	}
	for _, r := range reqs {
		shown := fmt.Sprintf("%+v", r)
		if strings.Contains(shown, "cred-TOPSECRET") {
			t.Fatalf("%T %%+v leaked SecurityCredential: %s", r, shown)
		}
		if !strings.Contains(shown, "[REDACTED]") {
			t.Fatalf("%T GoString missing [REDACTED] marker: %s", r, shown)
		}
	}
}

func TestFlexStringBranches(t *testing.T) {
	cases := []struct {
		json string
		want string
	}{
		{`"1032"`, "1032"},
		{`1032`, "1032"},
		{`1.0`, "1.0"},
		{`true`, "true"},
		{`null`, ""},
		{`"line\nbreak"`, "line\nbreak"},
	}
	for _, tc := range cases {
		var fs FlexString
		if err := json.Unmarshal([]byte(tc.json), &fs); err != nil {
			t.Errorf("FlexString(%s) error: %v", tc.json, err)
			continue
		}
		if fs.String() != tc.want {
			t.Errorf("FlexString(%s) = %q, want %q", tc.json, fs.String(), tc.want)
		}
	}
}

func TestFlexInt64Edges(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		want    FlexInt64
		wantErr bool
	}{
		{"quoted", `"3599"`, 3599, false},
		{"bare number", `3599`, 3599, false},
		{"null maps to zero", `null`, 0, false},
		{"empty string maps to zero", `""`, 0, false},
		{"padded quoted", `"3599 "`, 3599, false},
		{"doubled quotes rejected", `""3599""`, 0, true},
		{"alpha string rejected", `"abc"`, 0, true},
		{"bare alpha rejected", `abc`, 0, true},
	}
	for _, tc := range cases {
		var fi FlexInt64
		err := json.Unmarshal([]byte(tc.json), &fi)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s: FlexInt64(%s) = %d, want error", tc.name, tc.json, fi)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: FlexInt64(%s) error: %v", tc.name, tc.json, err)
			continue
		}
		if fi != tc.want {
			t.Errorf("%s: FlexInt64(%s) = %d, want %d", tc.name, tc.json, fi, tc.want)
		}
	}
}

func TestStkCallbackMetadataDuplicatesFirstWins(t *testing.T) {
	payload := []byte(`{"Body":{"stkCallback":{"CheckoutRequestID":"ws_CO_1","ResultCode":0,"CallbackMetadata":{"Item":[` +
		`{"Name":"MpesaReceiptNumber","Value":"AAA111"},` +
		`{"Name":"Amount","Value":10},` +
		`{"Name":"MpesaReceiptNumber","Value":"BBB222"}]}}}}`)
	var cb StkCallback
	if err := json.Unmarshal(payload, &cb); err != nil {
		t.Fatal(err)
	}
	res := cb.Body.StkCallback
	if res.MetadataMap()["MpesaReceiptNumber"] != "AAA111" {
		t.Fatalf("duplicate key must be first-wins: %v", res.MetadataMap())
	}
	if res.DuplicateKeys() != 1 {
		t.Fatalf("DuplicateKeys = %d, want 1", res.DuplicateKeys())
	}
}

func TestStkCallbackAbsentOrNullValues(t *testing.T) {
	payload := []byte(`{"Body":{"stkCallback":{"CheckoutRequestID":"ws_CO_1","ResultCode":1,"CallbackMetadata":{"Item":[` +
		`{"Name":"Ghost"},` +
		`{"Name":"Nothing","Value":null}]}}}}`)
	var cb StkCallback
	if err := json.Unmarshal(payload, &cb); err != nil {
		t.Fatal(err)
	}
	md := cb.Body.StkCallback.MetadataMap()
	v, ok := md["Ghost"]
	if !ok || v != nil {
		t.Fatalf("absent Value must surface as nil, got %v (%T)", v, v)
	}
	if v, ok := md["Nothing"]; !ok || v != nil {
		t.Fatalf("null Value must surface as nil, got %v (%T)", v, v)
	}
}

func TestSTKPushResponseIsAccepted(t *testing.T) {
	if !(STKPushResponse{ResponseCode: "0"}).IsAccepted() {
		t.Error(`ResponseCode "0" must be accepted`)
	}
	if (STKPushResponse{ResponseCode: "1"}).IsAccepted() {
		t.Error(`ResponseCode "1" must not be accepted`)
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
	qr := QRCodeRequest{MerchantName: "m", RefNo: "r", Amount: 1, TrxCode: "SM", CPI: "254712345678", Size: "300"}
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

func TestConversationResponseUnmarshalShape(t *testing.T) {
	payload := `{"OriginatorConversationID":"o-1","ConversationID":"AG_20240706_20106e9209f64bebd05b","ResponseCode":"0","ResponseDescription":"Accept the service request successfully."}`
	var cr ConversationResponse
	if err := json.Unmarshal([]byte(payload), &cr); err != nil {
		t.Fatal(err)
	}
	if cr.OriginatorConversationID != "o-1" || cr.ConversationID != "AG_20240706_20106e9209f64bebd05b" ||
		cr.ResponseCode != "0" || cr.ResponseDescription == "" {
		t.Fatalf("shape mismatch: %+v", cr)
	}
}

func TestQRCodeResponseUnmarshalShape(t *testing.T) {
	payload := `{"ResponseCode":"AG_20191219_000043fdf61864fe9ff5","RequestID":"16738-27456357-1","ResponseDescription":"QR Code Successfully Generated","QRCode":"imgdata"}`
	var qr QRCodeResponse
	if err := json.Unmarshal([]byte(payload), &qr); err != nil {
		t.Fatal(err)
	}
	if qr.ResponseCode != "AG_20191219_000043fdf61864fe9ff5" || qr.RequestID != "16738-27456357-1" ||
		qr.QRCode != "imgdata" || qr.ResponseDescription == "" {
		t.Fatalf("shape mismatch: %+v", qr)
	}
}

func TestAsyncResultReferenceDataShapes(t *testing.T) {
	single := `{"Result":{"ResultCode":0,"ReferenceData":{"ReferenceItem":{"Key":"QueueTimeoutURL","Value":"https://internalsandbox.safaricom.co.ke/submit"}}}}`
	var one AsyncResult
	if err := json.Unmarshal([]byte(single), &one); err != nil {
		t.Fatal(err)
	}
	items := one.Result.ReferenceData.ReferenceItem
	if len(items) != 1 || items[0].Key != "QueueTimeoutURL" || items[0].Value == "" {
		t.Fatalf("single ReferenceItem shape: %+v", one.Result.ReferenceData)
	}
	list := `{"Result":{"ResultCode":0,"ReferenceData":{"ReferenceItem":[{"Key":"a","Value":"1"},{"Key":"b","Value":"2"}]}}}`
	var many AsyncResult
	if err := json.Unmarshal([]byte(list), &many); err != nil {
		t.Fatal(err)
	}
	if len(many.Result.ReferenceData.ReferenceItem) != 2 {
		t.Fatalf("list ReferenceItem shape: %+v", many.Result.ReferenceData)
	}
	var absent AsyncResultBody
	if absent.ReferenceData != nil {
		t.Fatal("omitted ReferenceData must stay nil")
	}
}
