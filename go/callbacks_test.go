package mpesa

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSTKCallbackParseWithMetadata(t *testing.T) {
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
	var cb STKCallback
	if err := json.Unmarshal(payload, &cb); err != nil {
		t.Fatal(err)
	}
	res := cb.Body.STKCallback
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

func TestSTKCallbackAbsentMetadataTolerated(t *testing.T) {
	payload := []byte(`{"Body":{"stkCallback":{"MerchantRequestID":"x","CheckoutRequestID":"ws_CO_1","ResultCode":1037,"ResultDesc":"DS timeout"}}}`)
	var cb STKCallback
	if err := json.Unmarshal(payload, &cb); err != nil {
		t.Fatal(err)
	}
	md := cb.Body.STKCallback.MetadataMap()
	if len(md) != 0 {
		t.Fatalf("metadata = %v, want empty map", md)
	}
	if got := ClassifyResultCode(cb.Body.STKCallback.ResultCode.String()); got != ResultClassIndeterminate {
		t.Fatalf("1037 classified %q", got)
	}
}

func TestSTKCallbackMetadataDuplicatesFirstWins(t *testing.T) {
	payload := []byte(`{"Body":{"stkCallback":{"CheckoutRequestID":"ws_CO_1","ResultCode":0,"CallbackMetadata":{"Item":[` +
		`{"Name":"MpesaReceiptNumber","Value":"AAA111"},` +
		`{"Name":"Amount","Value":10},` +
		`{"Name":"MpesaReceiptNumber","Value":"BBB222"}]}}}}`)
	var cb STKCallback
	if err := json.Unmarshal(payload, &cb); err != nil {
		t.Fatal(err)
	}
	res := cb.Body.STKCallback
	if res.MetadataMap()["MpesaReceiptNumber"] != "AAA111" {
		t.Fatalf("duplicate key must be first-wins: %v", res.MetadataMap())
	}
	if res.DuplicateKeys() != 1 {
		t.Fatalf("DuplicateKeys = %d, want 1", res.DuplicateKeys())
	}
}

func TestSTKCallbackAbsentOrNullValues(t *testing.T) {
	payload := []byte(`{"Body":{"stkCallback":{"CheckoutRequestID":"ws_CO_1","ResultCode":1,"CallbackMetadata":{"Item":[` +
		`{"Name":"Ghost"},` +
		`{"Name":"Nothing","Value":null}]}}}}`)
	var cb STKCallback
	if err := json.Unmarshal(payload, &cb); err != nil {
		t.Fatal(err)
	}
	md := cb.Body.STKCallback.MetadataMap()
	v, ok := md["Ghost"]
	if !ok || v != nil {
		t.Fatalf("absent Value must surface as nil, got %v (%T)", v, v)
	}
	if v, ok := md["Nothing"]; !ok || v != nil {
		t.Fatalf("null Value must surface as nil, got %v (%T)", v, v)
	}
}

// ParseSTKCallback must accept BOTH wire shapes: Safaricom's full envelope
// and a bare stkCallback result object (fixtures, replayed captures).
func TestParseSTKCallbackEnvelopeAndBare(t *testing.T) {
	envelope := []byte(`{"Body":{"stkCallback":{` +
		`"MerchantRequestID":"29115-34620561-1",` +
		`"CheckoutRequestID":"ws_CO_191220191020363925",` +
		`"ResultCode":0,` +
		`"ResultDesc":"The service request is processed successfully.",` +
		`"CallbackMetadata":{"Item":[` +
		`{"Name":"Amount","Value":1.0},` +
		`{"Name":"MpesaReceiptNumber","Value":"NLJ7RT61SV"}]}}}}`)
	res, err := ParseSTKCallback(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if res.ResultCode.String() != "0" || res.CheckoutRequestID != "ws_CO_191220191020363925" {
		t.Fatalf("envelope result = %+v", res)
	}
	if md := res.MetadataMap(); md["MpesaReceiptNumber"] != "NLJ7RT61SV" {
		t.Fatalf("envelope metadata = %v", md)
	}
	if got := res.Classify(); got != ResultClassSuccess {
		t.Fatalf("envelope code 0 classified %q", got)
	}

	bare := []byte(`{"MerchantRequestID":"m","CheckoutRequestID":"ws_CO_1",` +
		`"ResultCode":"1032","ResultDesc":"Request cancelled by user"}`)
	bres, err := ParseSTKCallback(bare)
	if err != nil {
		t.Fatal(err)
	}
	if bres.ResultCode.String() != "1032" || bres.MetadataMap() == nil ||
		len(bres.MetadataMap()) != 0 {
		t.Fatalf("bare result = %+v metadata = %v", bres, bres.MetadataMap())
	}
	if got := bres.Classify(); got != ResultClassFailure {
		t.Fatalf("bare 1032 (terminal user-cancel) classified %q", got)
	}
}

// Malformed and wrong-shape inputs must error loudly instead of yielding a
// zero-value result a caller could mistake for a settled transaction.
func TestParseSTKCallbackRejectsMalformed(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		wantErr string
	}{
		{"invalid json", `{not-json`, "parse stk callback body"},
		{"array top level", `[1,2]`, "parse stk callback body"},
		{"body as array", `{"Body":[]}`, "parse stk callback body"},
		{"body as string", `{"Body":"x"}`, "parse stk callback body"},
		{"empty object", `{}`, "missing Body.stkCallback"},
		{"null body", `null`, "missing Body.stkCallback"},
		{"body without stkCallback", `{"Body":{}}`, "missing Body.stkCallback"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := ParseSTKCallback([]byte(tc.payload))
			if err == nil {
				t.Fatalf("want error, got result %+v", res)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error %q does not mention %q", err, tc.wantErr)
			}
		})
	}
}
