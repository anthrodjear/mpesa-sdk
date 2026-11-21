// Transaction Status / Reversal / Account Balance / Dynamic QR example.
// First three are async (ACK only); QR is synchronous.
//
// Run from this directory:
//
//	export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=... \
//	       MPESA_INITIATOR_NAME=... MPESA_INITIATOR_PASSWORD=... MPESA_CERT_PATH=...
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

func report(name string, ack *mpesa.ConversationResponse, err error) {
	if err != nil {
		log.Fatalf("%s failed: %v", name, err)
	}
	// ACK = QUEUED, not settled; the verdict arrives at ResultURL.
	fmt.Printf("%s ACK: code=%s conv=%s\n", name, ack.ResponseCode, ack.ConversationID)
}

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
	resultURL, timeoutURL := "https://example.com/ops/result", "https://example.com/ops/timeout"

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// 1. Transaction Status — exactly one of TransactionID / OriginalConversationID.
	status, err := client.TransactionStatus(ctx, mpesa.TransactionStatusRequest{
		Initiator:          initiator,
		SecurityCredential: cred,
		TransactionID:      "NLJ7RT61SV",
		PartyA:             shortcode,
		Remarks:            "status check",
		ResultURL:          resultURL,
		QueueTimeOutURL:    timeoutURL,
	})
	report("TransactionStatus", status, err)

	// 2. Reversal — C2B ONLY; reverse B2C payouts manually in the M-PESA portal.
	reversal, err := client.Reversal(ctx, mpesa.ReversalRequest{
		Initiator:          initiator,
		SecurityCredential: cred,
		TransactionID:      "NLJ7RT61SV",
		Amount:             100,
		ReceiverParty:      shortcode,
		Remarks:            "duplicate charge",
		ResultURL:          resultURL,
		QueueTimeOutURL:    timeoutURL,
	})
	report("Reversal", reversal, err)

	// 3. Account Balance — parse the Result blob with mpesa.ParseBalanceSegments.
	balance, err := client.AccountBalance(ctx, mpesa.AccountBalanceRequest{
		Initiator:          initiator,
		SecurityCredential: cred,
		PartyA:             shortcode,
		Remarks:            "balance check",
		QueueTimeOutURL:    timeoutURL,
		ResultURL:          resultURL,
	})
	report("AccountBalance", balance, err)

	// 4. Dynamic QR — synchronous; QRCode is an opaque payload.
	qr, err := client.GenerateQRCode(ctx, mpesa.QRCodeRequest{
		MerchantName: "Test Merchant",
		RefNo:        "ORDER-42",
		Amount:       100,
		TrxCode:      mpesa.QRTrxBuyGoods,
		CPI:          "600123",
		Size:         "300",
	})
	if err != nil {
		log.Fatalf("GenerateQRCode failed: %v", err)
	}
	fmt.Printf("QR request=%s response=%s payload_len=%d\n", qr.RequestID, qr.ResponseCode, len(qr.QRCode))
	fmt.Println("\n✓ Status/Reversal/Balance are async — settle only from the Result envelope.")
}
