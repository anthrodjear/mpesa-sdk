// B2C payout example using the M-Pesa Daraja SDK.
//
// Run from this directory:
//
//	export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=... \
//	       MPESA_INITIATOR_NAME=... MPESA_INITIATOR_PASSWORD=... \
//	       MPESA_CERT_PATH=/path/to/mpesa_public_cert.cer
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
	// 1. Config from environment. A passkey is NOT needed for B2C.
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
	defer client.Close() // zeroes the cached bearer token

	// 2. B2C (and every credentialed async API) needs a SecurityCredential:
	//    the initiator password RSA-encrypted with Daraja's PUBLIC certificate.
	//    Never log the password, the certificate, or the resulting credential.
	//    The cert must match the configured Environment (Sandbox ≠ Production);
	//    a mismatch fails with error 2001 — see docs/apis/getting-started.md.
	cert, err := os.ReadFile(os.Getenv("MPESA_CERT_PATH"))
	if err != nil {
		log.Fatalf("read M-Pesa certificate: %v", err)
	}
	cred, err := mpesa.SecurityCredential(cert, os.Getenv("MPESA_INITIATOR_PASSWORD"))
	if err != nil {
		log.Fatalf("build security credential: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// 3. Queue the payout. PartyA defaults to cfg.Shortcode; the SDK mints a
	//    16-hex OriginatorConversationID as the idempotency key when omitted.
	req := mpesa.B2CPayoutRequest{
		InitiatorName:      os.Getenv("MPESA_INITIATOR_NAME"),
		SecurityCredential: cred,
		CommandID:          mpesa.CommandBusinessPayment,
		Amount:             100, // B2C minimum is 10 KES
		PartyB:             "254712345678",
		Remarks:            "payout",
		QueueTimeOutURL:    "https://example.com/b2c/timeout",
		ResultURL:          "https://example.com/b2c/result",
	}
	// %+v is SAFE here: the request's Format hook redacts the credential and
	// both callback URLs. Use req.LogSafe() for structured logging.
	fmt.Printf("request (redacted): %+v\n", req)

	ack, err := client.B2CPayout(ctx, req)
	if err != nil {
		log.Fatalf("B2C payout failed: %v", err)
	}

	// 4. The ACK means QUEUED, not PAID. Money moves (or fails) asynchronously:
	//    Daraja POSTs an async Result envelope to ResultURL. SETTLE ONLY after
	//    parsing that Result with ResultCode "0" bound to YOUR
	//    OriginatorConversationID record — a forged body proves nothing.
	fmt.Printf("OriginatorConversationID: %s\n", ack.OriginatorConversationID)
	fmt.Printf("ConversationID:           %s\n", ack.ConversationID)
	fmt.Printf("ResponseCode:             %s\n", ack.ResponseCode)
	fmt.Printf("ResponseDescription:      %s\n", ack.ResponseDescription)
	fmt.Println("\n✓ Payout queued — settle ONLY from the async Result envelope.")
}
