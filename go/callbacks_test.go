package mpesa

import (
	"encoding/json"
	"testing"
)

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
