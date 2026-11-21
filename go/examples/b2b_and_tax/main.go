// B2B Express Checkout + Tax Remittance example using the M-Pesa Daraja SDK.
// Both are async: this queues them; the callbacks example parses the Result.
//
// Run from this directory:
//
//	export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=... \
//	       MPESA_INITIATOR_NAME=... MPESA_INITIATOR_PASSWORD=... \
//	       MPESA_CERT_PATH=/path/to/mpesa_public_cert.cer MPESA_TAX_PIN=...
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

	// The cert must match the configured Environment (Sandbox ≠ Production);
	// a mismatch fails with error 2001 — see docs/apis/getting-started.md.
	cert, err := os.ReadFile(os.Getenv("MPESA_CERT_PATH"))
	if err != nil {
		log.Fatalf("read M-Pesa certificate: %v", err)
	}
	cred, err := mpesa.SecurityCredential(cert, os.Getenv("MPESA_INITIATOR_PASSWORD"))
	if err != nil {
		log.Fatalf("build security credential: %v", err)
	}
	initiator, shortcode := os.Getenv("MPESA_INITIATOR_NAME"), os.Getenv("MPESA_SHORTCODE")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// 1. B2B Express Checkout: BOTH parties are organization shortcodes.
	//    Identifier types + OriginatorConversationID are client-injected.
	b2bReq := mpesa.B2BRequest{
		Initiator:          initiator,
		SecurityCredential: cred,
		CommandID:          mpesa.CommandBusinessPayBill,
		Amount:             1000,
		PartyA:             shortcode,
		PartyB:             "600123",
		AccountReference:   "INV-001",
		Remarks:            "services",
		QueueTimeOutURL:    "https://example.com/b2b/timeout",
		ResultURL:          "https://example.com/b2b/result",
	}
	// Never log raw requests: Format/LogSafe redact the credential and URLs.
	fmt.Printf("B2B request (redacted): %+v\n", b2bReq)
	ack, err := client.B2BPayment(ctx, b2bReq)
	if err != nil {
		log.Fatalf("B2B payment failed: %v", err)
	}
	fmt.Printf("B2B queued: conv=%s code=%s\n", ack.ConversationID, ack.ResponseCode)

	// 2. Tax Remittance: B2B core + tax fields, CommandID pinned. TaxPayerPIN
	//    is a SECRET and is redacted by Format/LogSafe alongside the credential.
	taxReq := mpesa.TaxRemittanceRequest{
		Initiator:          initiator,
		SecurityCredential: cred,
		CommandID:          mpesa.CommandTaxRemittance,
		Amount:             5000,
		PartyA:             shortcode,
		PartyB:             "572700",
		AccountReference:   "TAX-2024-Q3",
		Remarks:            "VAT Q3 2024",
		QueueTimeOutURL:    "https://example.com/tax/timeout",
		ResultURL:          "https://example.com/tax/result",
		TaxPeriod:          "2024Q3",
		TaxObligation:      "VAT",
		TaxPayerPIN:        os.Getenv("MPESA_TAX_PIN"),
	}
	fmt.Printf("Tax request (redacted): %+v\n", taxReq)
	taxAck, err := client.TaxRemittance(ctx, taxReq)
	if err != nil {
		log.Fatalf("tax remittance failed: %v", err)
	}
	fmt.Printf("Tax queued: conv=%s code=%s\n", taxAck.ConversationID, taxAck.ResponseCode)

	// Both ACKs mean QUEUED, not completed. Settle ONLY from the async Result
	// envelope at ResultURL with ResultCode "0", bound to your
	// OriginatorConversationID record. Callbacks are unsigned.
}
