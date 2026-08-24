// Runnable godoc examples: offline by construction — HTTP is intercepted at
// the transport level, so `go test` executes them without touching Daraja.

package mpesa_test

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	mpesa "github.com/mpesa-sdk/go"
)

// stubTransport serves canned Daraja payloads so examples run offline.
type stubTransport struct{}

func (stubTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	body := `{"access_token":"sandbox-token","expires_in":"3599"}`
	if req.URL.Path == "/mpesa/stkpush/v1/processrequest" {
		body = `{"MerchantRequestID":"29115-34620561-1",` +
			`"CheckoutRequestID":"ws_CO_191220191020363925",` +
			`"ResponseCode":"0",` +
			`"ResponseDescription":"Success. Request accepted for processing",` +
			`"CustomerMessage":"Success. Request accepted for processing"}`
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}, nil
}

// Build a client and send an STK Push prompt. Acceptance (ResponseCode "0")
// is NOT payment confirmation — settle only via callback or STKQuery.
func ExampleNewClient() {
	cfg := mpesa.Config{
		ConsumerKey:    "your-consumer-key",
		ConsumerSecret: "your-consumer-secret",
		Shortcode:      "174379",
		Passkey:        "your-passkey",
		Environment:    mpesa.Sandbox,
		Timeout:        15 * time.Second,
		// Offline stub for this example — omit in production.
		HTTPClient: &http.Client{Transport: stubTransport{}},
	}
	client := mpesa.NewClient(cfg)

	resp, err := client.STKPush(context.Background(), mpesa.STKPushRequest{
		TransactionType:  mpesa.TransactionTypePayBillOnline,
		Amount:           100,
		PartyA:           "254712345678",
		PhoneNumber:      "254712345678",
		CallBackURL:      "https://example.com/callback",
		AccountReference: "Order 42",
		TransactionDesc:  "test payment",
	})
	if err != nil {
		fmt.Println("push failed:", err)
		return
	}
	fmt.Println(resp.IsAccepted(), resp.CheckoutRequestID)
	// Output: true ws_CO_191220191020363925
}

// Parse a callback body Safaricom POSTed to your CallBackURL. The helper
// accepts the full envelope OR a bare result object; metadata is read
// defensively because failures carry none.
func ExampleParseSTKCallback() {
	raw := []byte(`{"Body":{"stkCallback":{` +
		`"MerchantRequestID":"29115-34620561-1",` +
		`"CheckoutRequestID":"ws_CO_191220191020363925",` +
		`"ResultCode":0,` +
		`"ResultDesc":"The service request is processed successfully.",` +
		`"CallbackMetadata":{"Item":[` +
		`{"Name":"Amount","Value":1.00},` +
		`{"Name":"MpesaReceiptNumber","Value":"NLJ7RT61SV"}]}}}}`)

	res, err := mpesa.ParseSTKCallback(raw)
	if err != nil {
		fmt.Println("bad callback:", err)
		return
	}
	md := res.MetadataMap()
	fmt.Println(res.Classify(), md["MpesaReceiptNumber"], res.DuplicateKeys())
	// Output: success NLJ7RT61SV 0
}
