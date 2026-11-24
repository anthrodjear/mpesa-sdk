// Callback parsing example using the M-Pesa Daraja SDK: STK callbacks via
// ParseSTKCallback, async Result envelopes via a plain json.Unmarshal.
//
// Run from this directory:
//
//	export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=... \
//	       MPESA_PASSKEY=...
//	go run .
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	mpesa "github.com/anthrodjear/mpesa-sdk/go"
)

// Captures below are illustrative. In a real handler, cap the POST body with
// http.MaxBytesReader (>= 1 MiB) BEFORE calling ParseSTKCallback.
const stkCallback = `{"Body":{"stkCallback":{` +
	`"MerchantRequestID":"29115-34620561-1",` +
	`"CheckoutRequestID":"ws_CO_191220191020363925",` +
	`"ResultCode":0,"ResultDesc":"success",` +
	`"CallbackMetadata":{"Item":[{"Name":"Amount","Value":100},` +
	`{"Name":"MpesaReceiptNumber","Value":"NLJ7RT61SV"}]}}}}`

const asyncResult = `{"Result":{"ResultType":0,"ResultCode":0,` +
	`"ResultDesc":"success","OriginatorConversationID":"a1b2c3d4e5f6a7b8",` +
	`"ConversationID":"AG_20200101_00001abc","TransactionID":"NLJ7RT61SV",` +
	`"ResultParameters":{"ResultParameter":[` +
	`{"Key":"TransactionReceipt","Value":"NLJ7RT61SV"}]}}}`

func main() {
	cfg := mpesa.Config{
		ConsumerKey:    os.Getenv("MPESA_CONSUMER_KEY"),
		ConsumerSecret: os.Getenv("MPESA_CONSUMER_SECRET"),
		Shortcode:      os.Getenv("MPESA_SHORTCODE"),
		Passkey:        os.Getenv("MPESA_PASSKEY"), // needed by STKQuery
		Environment:    mpesa.Sandbox,              // switch to mpesa.Production for live
		Timeout:        15 * time.Second,
	}
	client, err := mpesa.NewClient(cfg)
	if err != nil {
		log.Fatalf("bad config (check the MPESA_* env vars): %v", err)
	}
	defer client.Close()

	// 1. STK callback. Metadata is ADVISORY and the body is UNSIGNED —
	//    binding on CheckoutRequestID is a dedup control, not authentication.
	res, err := mpesa.ParseSTKCallback([]byte(stkCallback))
	if err != nil {
		log.Fatalf("parse STK callback: %v", err)
	}
	fmt.Printf("CheckoutRequestID: %s, ResultCode: %s\n", res.CheckoutRequestID, res.ResultCode.String())
	md := res.MetadataMap()
	fmt.Printf("Metadata (advisory): amount=%v receipt=%v duplicates=%d\n",
		md["Amount"], md["MpesaReceiptNumber"], res.DuplicateKeys())

	// The callback amount is NEVER authoritative: compare it with the amount
	// YOUR system stored on the order. AmountMatches returns false for a
	// missing, duplicate, fractional, non-positive, or hostile value, so it
	// is safe to use as a settlement gate. Keep MetadataMap for display of
	// the raw wire value only.
	const storedOrderAmount int64 = 100 // from your own order record
	amount, ok := res.Amount()
	if !ok {
		fmt.Println("! Callback amount rejected by the strict accessor — do not settle on it")
	}
	fmt.Printf("Callback amount (advisory): %d, matches stored order: %t\n",
		amount, res.AmountMatches(storedOrderAmount))

	// 2. SETTLE ONLY BY QUERY: STKQuery ResultCode "0" bound to YOUR stored
	//    CheckoutRequestID record, AND a verified amount match. A parsed
	//    callback is never proof of payment.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	query, err := client.STKQuery(ctx, mpesa.STKQueryRequest{
		CheckoutRequestID: res.CheckoutRequestID,
	})
	if err != nil {
		log.Fatalf("STK query failed: %v", err)
	}
	if query.Classify() == mpesa.ResultClassSuccess && res.AmountMatches(storedOrderAmount) {
		fmt.Println("✓ Query confirms payment and the amount matches the stored order — settle now.")
	} else {
		fmt.Printf("✗ Not settled (%s): %s — keep reconciling (query success alone is not enough).\n",
			query.ResultCode.String(), query.ResultDesc)
	}

	// 3. Async Result (B2C / TxStatus / Reversal / Balance): Go has NO SDK
	//    Result parser. Unmarshal into mpesa.AsyncResult yourself, after
	//    enforcing the same 1 MiB body cap in your own handler.
	var envelope mpesa.AsyncResult
	if err := json.Unmarshal([]byte(asyncResult), &envelope); err != nil {
		log.Fatalf("parse async Result: %v", err)
	}
	body := envelope.Result
	fmt.Printf("Async Result: code=%s conv=%s receipt=%s\n",
		body.ResultCode.String(), body.ConversationID,
		body.Parameters()["TransactionReceipt"])
	if body.Classify() == mpesa.ResultClassIndeterminate {
		fmt.Println("INDETERMINATE — keep reconciling; never auto-refund.")
	}
	// Bind on OriginatorConversationID; settle only on ResultCode "0".
}
