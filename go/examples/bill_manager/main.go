// Bill Manager example using the M-Pesa Daraja SDK: register → query →
// update → delete. All four calls are synchronous and authenticated by the
// bearer token alone — there is NO initiator or SecurityCredential here.
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

	shortcode := os.Getenv("MPESA_SHORTCODE")
	ref := "INV-001" // business reference, safe to log (not a secret)

	// 1. Register a bill. Use a callback URL you control; it may carry a
	//    capability token. The request's Format hook redacts the callback URL
	//    for any fmt verb; use LogSafe() for structured logging.
	regReq := mpesa.BillRegisterRequest{
		ShortCode:     shortcode,
		BillRefNumber: ref,
		BillName:      "Invoice 001",
		Amount:        100,
		ExpiryDate:    "2030-12-31",
		CallBackURL:   "https://example.com/bills/callback",
	}
	fmt.Printf("register (redacted): %+v\n", regReq)
	if _, err := client.BillRegister(ctx, regReq); err != nil {
		log.Fatalf("bill register failed: %v", err)
	}
	fmt.Println("✓ bill registered")

	// 2. Query. BillRefNumber is optional on the ACK echo; you identify the
	//    bill by the reference YOU sent, not by the echoed value.
	if _, err := client.BillQuery(ctx, mpesa.BillQueryRequest{
		ShortCode: shortcode, BillRefNumber: ref,
	}); err != nil {
		log.Fatalf("bill query failed: %v", err)
	}
	fmt.Println("✓ bill queried")

	// 3. Update. Amount 0 means "leave the amount alone" — a partial update.
	if _, err := client.BillUpdate(ctx, mpesa.BillUpdateRequest{
		ShortCode: shortcode, BillRefNumber: ref, Amount: 150,
	}); err != nil {
		log.Fatalf("bill update failed: %v", err)
	}
	fmt.Println("✓ bill updated")

	// 4. Delete.
	if _, err := client.BillDelete(ctx, mpesa.BillDeleteRequest{
		ShortCode: shortcode, BillRefNumber: ref,
	}); err != nil {
		log.Fatalf("bill delete failed: %v", err)
	}
	fmt.Println("✓ bill deleted")

	// ResponseCode "0" means the OPERATION was accepted — never that money
	// moved. Settlement is exclusively from the OperationResult callback.
}
