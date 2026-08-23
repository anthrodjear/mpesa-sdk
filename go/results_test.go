package mpesa

import (
	"encoding/json"
	"testing"
)

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

func TestParseBalanceSegments(t *testing.T) {
	in := "Working Account|KES|700000.00|700000.00|0.00|0.00&Utility Account|KES|228037.00|228037.00|0.00|0.00&Charges Paid Account|KES|-1540.00|-1540.00|0.00|0.00&"
	segs, skipped := ParseBalanceSegments(in)
	if skipped != 0 {
		t.Fatalf("clean input skipped = %d, want 0", skipped)
	}
	if len(segs) != 3 {
		t.Fatalf("got %d segments, want 3", len(segs))
	}
	last := segs[2]
	if last.AccountName != "Charges Paid Account" || last.Available != -1540.0 || last.Currency != "KES" {
		t.Fatalf("last segment = %+v", last)
	}
	wantRaw := "Charges Paid Account|KES|-1540.00|-1540.00|0.00|0.00"
	if last.Raw != wantRaw {
		t.Fatalf("Raw = %q, want %q", last.Raw, wantRaw)
	}

	// Malformed rows are skipped and counted, never fatal (account-balance.md
	// tolerance requirement).
	junk := "Utility Account|KES|1.00|1.00|0.00|0.00&GARBAGE ROW&Charges Paid Account|KES|-1540.00|-1540.00|0.00|0.00&Short|Row&"
	segs, skipped = ParseBalanceSegments(junk)
	if len(segs) != 2 || skipped != 2 {
		t.Fatalf("junk input: %d segments (want 2), skipped %d (want 2)", len(segs), skipped)
	}
	segs, skipped = ParseBalanceSegments("")
	if segs != nil || skipped != 0 {
		t.Fatalf("empty input: segs=%v skipped=%d", segs, skipped)
	}
}
