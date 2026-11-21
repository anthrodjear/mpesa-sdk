// C2B flow example using the M-Pesa Daraja SDK: register callbacks, then
// simulate an inbound PayBill payment in the sandbox.
//
// Run from this directory:
//
//	export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=...
//	go run .
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	mpesa "github.com/anthrodjear/mpesa-sdk/go"
)

func main() {
	cfg := mpesa.Config{
		ConsumerKey:    os.Getenv("MPESA_CONSUMER_KEY"),
		ConsumerSecret: os.Getenv("MPESA_CONSUMER_SECRET"),
		Shortcode:      os.Getenv("MPESA_SHORTCODE"),
		Environment:    mpesa.Sandbox, // switch to mpesa.Production for live
		Timeout:        15 * time.Second,
	}
	client, err := mpesa.NewClient(cfg)
	if err != nil {
		log.Fatalf("bad config (check the MPESA_* env vars): %v", err)
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// 1. Register validation/confirmation URLs. In production this is
	//    effectively one-shot — do it at deployment, not per payment.
	//    Callback URLs may embed a capability token: %+v redacts them.
	regReq := mpesa.C2BRegisterRequest{
		ResponseType:    mpesa.ResponseTypeCompleted,
		ConfirmationURL: "https://example.com/c2b/confirm",
		ValidationURL:   "https://example.com/c2b/validate",
	}
	fmt.Printf("register (redacted): %+v\n", regReq)
	reg, err := client.C2BRegisterURL(ctx, regReq)
	if err != nil {
		log.Fatalf("C2B register URL failed: %v", err)
	}
	fmt.Printf("registered: code=%s description=%s\n", reg.ResponseCode, reg.ResponseDescription)

	// 2. SANDBOX ONLY: simulate an inbound PayBill payment. PayBill REQUIRES
	//    BillRefNumber — the account the customer is paying into.
	//    The ACK is not proof of settlement: settle from the CONFIRMATION
	//    callback, which is unsigned. Cap its body and gate the endpoint.
	ack, err := client.C2BSimulate(ctx, mpesa.C2BSimulateRequest{
		CommandID:     mpesa.TransactionTypePayBillOnline,
		Amount:        100,
		Msisdn:        "254712345678",
		BillRefNumber: "ACCOUNT-42",
	})
	if err != nil {
		log.Fatalf("C2B simulate failed: %v", err)
	}
	// The ACK's OriginatorCoversationID is Safaricom's wire misspelling (no second 's'); the Go field is OriginatorConversationID.
	fmt.Printf("simulated: OriginatorCoversationID=%s code=%s\n", ack.OriginatorConversationID, ack.ResponseCode)

	// Buy Goods (till) differences: use CommandID TransactionTypeBuyGoodsOnline
	// and OMIT BillRefNumber — a till has no account reference. Example:
	//
	//   _, err = client.C2BSimulate(ctx, mpesa.C2BSimulateRequest{
	//       CommandID: mpesa.TransactionTypeBuyGoodsOnline,
	//       Amount:    100,
	//       Msisdn:    "254712345678",
	//   })
	fmt.Println("\n✓ ACK only — settle from the confirmation callback, never from this ACK.")
}
