// STK Push example using the M-Pesa Daraja SDK.
//
// Run:
//
//	export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... \
//	       MPESA_SHORTCODE=... MPESA_PASSKEY=...
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
	// 1. Build config from environment variables.
	cfg := mpesa.Config{
		ConsumerKey:    os.Getenv("MPESA_CONSUMER_KEY"),
		ConsumerSecret: os.Getenv("MPESA_CONSUMER_SECRET"),
		Shortcode:      os.Getenv("MPESA_SHORTCODE"),
		Passkey:        os.Getenv("MPESA_PASSKEY"),
		Environment:    mpesa.Sandbox,
		Timeout:        15 * time.Second,
	}

	// 2. Create a concurrency-safe client (share across goroutines).
	client, err := mpesa.NewClient(cfg)
	if err != nil {
		log.Fatalf("bad config: %v", err)
	}

	// 3. Send the STK Push prompt.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := client.STKPush(ctx, mpesa.STKPushRequest{
		TransactionType:  mpesa.TransactionTypePayBillOnline,
		Amount:           100,
		PartyA:           "254712345678",
		PhoneNumber:      "254712345678",
		CallBackURL:      "https://example.com/callback",
		AccountReference: "Order 42",
		TransactionDesc:  "test payment",
	})
	if err != nil {
		log.Fatalf("STK Push failed: %v", err)
	}

	// 4. Check acceptance (ResponseCode "0" = Daraja accepted the request).
	//    Accepted is NOT paid — settle only via callback or STK Query.
	fmt.Printf("MerchantRequestID:  %s\n", resp.MerchantRequestID)
	fmt.Printf("CheckoutRequestID:  %s\n", resp.CheckoutRequestID)
	fmt.Printf("ResponseCode:       %s\n", resp.ResponseCode)
	fmt.Printf("CustomerMessage:    %s\n", resp.CustomerMessage)

	if resp.IsAccepted() {
		fmt.Println("\n✓ Push accepted — wait for callback or query with STKQuery.")
	} else {
		fmt.Printf("\n✗ Push rejected (code %s): %s\n", resp.ResponseCode, resp.ResponseDescription)
	}
}
