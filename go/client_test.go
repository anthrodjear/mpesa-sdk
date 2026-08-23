package mpesa

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

var fixedClock = time.Date(2021, 6, 28, 9, 24, 8, 0, time.UTC)

func testClient(t *testing.T, baseURL string) *Client {
	t.Helper()
	c := NewClient(Config{
		ConsumerKey:    "test-key",
		ConsumerSecret: "test-secret",
		Shortcode:      testShortcode,
		Passkey:        testPasskey,
		Environment:    Sandbox,
		Now:            func() time.Time { return fixedClock },
	})
	c.baseURL = baseURL
	return c
}

func writeJSON(t *testing.T, w http.ResponseWriter, status int, v any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		t.Errorf("encode mock response: %v", err)
	}
}

func oauthHandler(t *testing.T, hits *int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("oauth method = %s, want GET", r.Method)
		}
		want := "Basic " + base64.StdEncoding.EncodeToString([]byte("test-key:test-secret"))
		if got := r.Header.Get("Authorization"); got != want {
			t.Errorf("oauth Authorization = %q, want Basic credentials", got)
		}
		if !strings.Contains(r.URL.RawQuery, "grant_type=client_credentials") {
			t.Errorf("oauth query = %q", r.URL.RawQuery)
		}
		*hits++
		writeJSON(t, w, http.StatusOK, map[string]any{"access_token": "tok-123", "expires_in": "3599"})
	}
}

func validSTKPushRequest() STKPushRequest {
	return STKPushRequest{
		TransactionType:  TransactionTypePayBillOnline,
		Amount:           1,
		PartyA:           "254722000000",
		PartyB:           testShortcode,
		PhoneNumber:      "254722111111",
		CallBackURL:      "https://mydomain.com/path",
		AccountReference: "accountref",
		TransactionDesc:  "txndesc",
	}
}

// OAuth must be fetched once and reused across sequential business calls.
func TestOAuthCalledOnceAcrossSequentialBusinessCalls(t *testing.T) {
	oauthHits, pushHits, queryHits := 0, 0, 0
	mux := http.NewServeMux()
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))
	mux.HandleFunc(stkPushPath, func(w http.ResponseWriter, r *http.Request) {
		pushHits++
		writeJSON(t, w, http.StatusOK, STKPushResponse{MerchantRequestID: "mr-1", CheckoutRequestID: "ws_CO_1", ResponseCode: "0", ResponseDescription: "accepted", CustomerMessage: "ok"})
	})
	mux.HandleFunc(stkQueryPath, func(w http.ResponseWriter, r *http.Request) {
		queryHits++
		writeJSON(t, w, http.StatusOK, STKQueryResponse{ResponseCode: "0", ResultCode: "1032", ResultDesc: "Request cancelled by user"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := testClient(t, srv.URL)
	ctx := context.Background()

	push, err := c.STKPush(ctx, validSTKPushRequest())
	if err != nil {
		t.Fatalf("STKPush: %v", err)
	}
	if push.CheckoutRequestID != "ws_CO_1" {
		t.Fatalf("CheckoutRequestID = %q", push.CheckoutRequestID)
	}
	query, err := c.STKQuery(ctx, STKQueryRequest{CheckoutRequestID: push.CheckoutRequestID})
	if err != nil {
		t.Fatalf("STKQuery: %v", err)
	}
	if query.ResultCode.String() != "1032" {
		t.Fatalf("query ResultCode = %q", query.ResultCode.String())
	}

	if oauthHits != 1 {
		t.Fatalf("oauth hits = %d, want exactly 1 across two business calls", oauthHits)
	}
	if pushHits != 1 || queryHits != 1 {
		t.Fatalf("business hits push=%d query=%d, want 1/1", pushHits, queryHits)
	}
}

// Every endpoint must hit its exact documented path carrying the Bearer token.
func TestAllEndpointsHitDocumentedPathsWithBearer(t *testing.T) {
	oauthHits := 0
	var mu sync.Mutex
	authByPath := map[string]string{}
	bodies := map[string][]byte{}

	mux := http.NewServeMux()
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))

	record := func(path string, respond func(w http.ResponseWriter, r *http.Request)) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			authByPath[path] = r.Header.Get("Authorization")
			bodies[path], _ = io.ReadAll(r.Body)
			mu.Unlock()
			respond(w, r)
		})
	}
	conversationACK := func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, http.StatusOK, ConversationResponse{OriginatorConversationID: "o", ConversationID: "AG_1", ResponseCode: "0", ResponseDescription: "Accept the service request successfully."})
	}

	record(stkPushPath, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, http.StatusOK, STKPushResponse{MerchantRequestID: "mr", CheckoutRequestID: "ws_CO_x", ResponseCode: "0", ResponseDescription: "accepted", CustomerMessage: "Success. Request accepted for processing"})
	})
	record(stkQueryPath, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, http.StatusOK, STKQueryResponse{ResponseCode: "0", ResultCode: "0", ResultDesc: "processed"})
	})
	record(b2cPath, conversationACK)
	record(c2bRegisterPath, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, http.StatusOK, C2BAckResponse{OriginatorConversationID: "53e3-coversation-misspelled", ResponseCode: "0", ResponseDescription: "Accept the service request successfully."})
	})
	record(c2bSimulatePath, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, http.StatusOK, C2BAckResponse{OriginatorConversationID: "sim-ack", ResponseCode: "0", ResponseDescription: "Accept the service request successfully."})
	})
	record(txStatusPath, conversationACK)
	record(reversalPath, conversationACK)
	record(accountBalancePath, conversationACK)
	record(qrCodePath, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, http.StatusOK, QRCodeResponse{ResponseCode: "AG_20191219_000043fdf6", RequestID: "16738-27456357-1", ResponseDescription: "QR Code Successfully Generated", QRCode: "qrpayload"})
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := testClient(t, srv.URL)
	ctx := context.Background()

	stkPushResp, err := c.STKPush(ctx, validSTKPushRequest())
	if err != nil {
		t.Fatalf("STKPush: %v", err)
	}
	if stkPushResp.ResponseCode != "0" || stkPushResp.CustomerMessage == "" {
		t.Fatalf("stkpush resp = %+v", stkPushResp)
	}
	if _, err := c.STKQuery(ctx, STKQueryRequest{CheckoutRequestID: "ws_CO_x"}); err != nil {
		t.Fatalf("STKQuery: %v", err)
	}
	b2cResp, err := c.B2CPayout(ctx, B2CPayoutRequest{
		InitiatorName: "testapi", SecurityCredential: strings.Repeat("x", 344), CommandID: CommandBusinessPayment,
		Amount: 100, PartyA: "600992", PartyB: "254705912645", Remarks: "refund order 42",
		QueueTimeOutURL: "https://mydomain.com/timeout", ResultURL: "https://mydomain.com/result",
	})
	if err != nil {
		t.Fatalf("B2CPayout: %v", err)
	}
	if b2cResp.ConversationID != "AG_1" {
		t.Fatalf("b2c ack = %+v", b2cResp)
	}
	regAck, err := c.C2BRegisterURL(ctx, C2BRegisterRequest{
		ResponseType:    ResponseTypeCompleted,
		ConfirmationURL: "https://mydomain.com/c2b/confirmation",
		ValidationURL:   "https://mydomain.com/c2b/validation",
	})
	if err != nil {
		t.Fatalf("C2BRegisterURL: %v", err)
	}
	if regAck.OriginatorConversationID != "53e3-coversation-misspelled" {
		t.Fatalf("misspelled ACK field not surfaced cleanly: %+v", regAck)
	}
	if _, err := c.C2BSimulate(ctx, C2BSimulateRequest{CommandID: TransactionTypePayBillOnline, Amount: 10, Msisdn: "0712345678", BillRefNumber: "acct-1"}); err != nil {
		t.Fatalf("C2BSimulate: %v", err)
	}
	if _, err := c.TransactionStatus(ctx, TransactionStatusRequest{
		Initiator: "testapi", SecurityCredential: "cred", TransactionID: "NLJ7RT61SV",
		PartyA: "600992", Remarks: "reconcile", ResultURL: "https://mydomain.com/result", QueueTimeOutURL: "https://mydomain.com/timeout",
	}); err != nil {
		t.Fatalf("TransactionStatus: %v", err)
	}
	if _, err := c.Reversal(ctx, ReversalRequest{
		Initiator: "testapi", SecurityCredential: "cred", TransactionID: "NLJ7RT61SV", Amount: 100,
		ReceiverParty: "600992", Remarks: "wrong deposit", ResultURL: "https://mydomain.com/result", QueueTimeOutURL: "https://mydomain.com/timeout",
	}); err != nil {
		t.Fatalf("Reversal: %v", err)
	}
	if _, err := c.AccountBalance(ctx, AccountBalanceRequest{
		Initiator: "testapi", SecurityCredential: "cred", PartyA: "600992", Remarks: "eod balance",
		ResultURL: "https://mydomain.com/result", QueueTimeOutURL: "https://mydomain.com/timeout",
	}); err != nil {
		t.Fatalf("AccountBalance: %v", err)
	}
	qr, err := c.GenerateQRCode(ctx, QRCodeRequest{MerchantName: "TEST SUPERMARKET", RefNo: "Invoice Test", Amount: 1, TrxCode: "BG", CPI: "174379", Size: "300"})
	if err != nil {
		t.Fatalf("GenerateQRCode: %v", err)
	}
	if qr.QRCode != "qrpayload" || qr.RequestID != "16738-27456357-1" {
		t.Fatalf("qr passthrough broken: %+v", qr)
	}

	for _, path := range []string{stkPushPath, stkQueryPath, b2cPath, c2bRegisterPath, c2bSimulatePath, txStatusPath, reversalPath, accountBalancePath, qrCodePath} {
		if authByPath[path] != "Bearer tok-123" {
			t.Errorf("path %s Authorization = %q, want Bearer token", path, authByPath[path])
		}
	}
	if oauthHits != 1 {
		t.Errorf("oauth hits = %d after nine cached business calls, want 1", oauthHits)
	}

	assertBody := func(path string, check func(m map[string]any)) {
		t.Helper()
		var m map[string]any
		raw := bodies[path]
		if len(raw) == 0 {
			t.Fatalf("no body captured for %s", path)
		}
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("decode %s body %s: %v", path, raw, err)
		}
		check(m)
	}
	assertBody(b2cPath, func(m map[string]any) {
		if m["Occassion"] != nil && m["Occassion"] == "" {
			t.Error("empty Occassion should be omitted")
		}
		if m["InitiatorName"] != "testapi" {
			t.Errorf("b2c InitiatorName = %v", m["InitiatorName"])
		}
		ocid, _ := m["OriginatorConversationID"].(string)
		if ocid == "" || len(ocid) > 20 {
			t.Errorf("auto-generated OriginatorConversationID = %q (must be non-empty, <=20 chars)", ocid)
		}
	})
	assertBody(txStatusPath, func(m map[string]any) {
		if m["CommandID"] != CommandTransactionStatusQuery {
			t.Errorf("txstatus CommandID = %v", m["CommandID"])
		}
		if m["IdentifierType"] != IdentifierOrgShortcode {
			t.Errorf("txstatus IdentifierType default = %v, want 4", m["IdentifierType"])
		}
	})
	assertBody(reversalPath, func(m map[string]any) {
		if m["RecieverIdentifierType"] != ReceiverIdentifierOrg {
			t.Errorf("reversal RecieverIdentifierType default = %v, want 11", m["RecieverIdentifierType"])
		}
		if m["CommandID"] != CommandTransactionReversal {
			t.Errorf("reversal CommandID = %v", m["CommandID"])
		}
	})
	assertBody(accountBalancePath, func(m map[string]any) {
		if m["CommandID"] != CommandAccountBalance {
			t.Errorf("balance CommandID = %v", m["CommandID"])
		}
	})
	assertBody(qrCodePath, func(m map[string]any) {
		if _, ok := m["RefNo"]; !ok {
			t.Errorf("qr body missing RefNo: %v", m)
		}
	})
	assertBody(c2bSimulatePath, func(m map[string]any) {
		if m["Msisdn"] != "254712345678" {
			t.Errorf("simulate Msisdn = %v, want normalized 254712345678", m["Msisdn"])
		}
	})
	assertBody(stkPushPath, func(m map[string]any) { verifySingleClockBody(t, m) })
}

func verifySingleClockBody(t *testing.T, m map[string]any) {
	t.Helper()
	ts, ok := m["Timestamp"].(string)
	if !ok || ts != "20210628122408" {
		t.Fatalf("Timestamp = %v, want EAT rendering of injected clock", m["Timestamp"])
	}
	pw, _ := m["Password"].(string)
	want := base64.StdEncoding.EncodeToString([]byte(testShortcode + testPasskey + ts))
	if pw != want {
		t.Fatalf("Password does not bind to body Timestamp (two-clock bug): %q vs %q", pw, want)
	}
	if m["BusinessShortCode"] != testShortcode {
		t.Fatalf("BusinessShortCode = %v, want config shortcode", m["BusinessShortCode"])
	}
}

func TestErrorEnvelopeParsedIntoTypedError(t *testing.T) {
	mux := http.NewServeMux()
	oauthHits := 0
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))
	mux.HandleFunc(stkPushPath, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, http.StatusBadRequest, errorEnvelope{RequestID: "27504-4b64-1", ErrorCode: "400.002.02", ErrorMessage: "Bad Request - Invalid BusinessShortCode"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, err := testClient(t, srv.URL).STKPush(context.Background(), validSTKPushRequest())
	if err == nil {
		t.Fatal("expected typed error")
	}
	var mpesaErr *Error
	if !errors.As(err, &mpesaErr) {
		t.Fatalf("error type = %T (%v), want *mpesa.Error", err, err)
	}
	if mpesaErr.StatusCode != http.StatusBadRequest || mpesaErr.ErrorCode != "400.002.02" ||
		mpesaErr.ErrorMessage != "Bad Request - Invalid BusinessShortCode" || mpesaErr.RequestID != "27504-4b64-1" {
		t.Fatalf("parsed error = %+v", mpesaErr)
	}
}

func TestUnauthorizedForceRefreshRetriesOnce(t *testing.T) {
	oauthHits, pushHits := 0, 0
	mux := http.NewServeMux()
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))
	mux.HandleFunc(stkPushPath, func(w http.ResponseWriter, r *http.Request) {
		pushHits++
		if pushHits == 1 {
			writeJSON(t, w, http.StatusUnauthorized, errorEnvelope{ErrorCode: "401.003.01", ErrorMessage: "Invalid access token"})
			return
		}
		writeJSON(t, w, http.StatusOK, STKPushResponse{CheckoutRequestID: "ws_CO_retry", ResponseCode: "0"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := testClient(t, srv.URL).STKPush(context.Background(), validSTKPushRequest())
	if err != nil {
		t.Fatalf("retry-after-401 failed: %v", err)
	}
	if resp.CheckoutRequestID != "ws_CO_retry" || pushHits != 2 || oauthHits != 2 {
		t.Fatalf("resp=%+v pushHits=%d oauthHits=%d; want success after exactly one forced refresh", resp, pushHits, oauthHits)
	}
}

func TestTokenRefreshedAfterFiftyMinutes(t *testing.T) {
	oauthHits, pushHits := 0, 0
	now := fixedClock
	clockMu := sync.Mutex{}
	currentNow := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return now
	}
	mux := http.NewServeMux()
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))
	mux.HandleFunc(stkPushPath, func(w http.ResponseWriter, r *http.Request) {
		pushHits++
		writeJSON(t, w, http.StatusOK, STKPushResponse{ResponseCode: "0"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := NewClient(Config{
		ConsumerKey: "test-key", ConsumerSecret: "test-secret", Shortcode: testShortcode, Passkey: testPasskey,
		Environment: Sandbox, Now: currentNow,
	})
	c.baseURL = srv.URL
	ctx := context.Background()

	if _, err := c.STKPush(ctx, validSTKPushRequest()); err != nil {
		t.Fatal(err)
	}
	if _, err := c.STKPush(ctx, validSTKPushRequest()); err != nil {
		t.Fatal(err)
	}
	if oauthHits != 1 {
		t.Fatalf("fresh-token reuse broke: oauthHits=%d", oauthHits)
	}
	clockMu.Lock()
	now = fixedClock.Add(51 * time.Minute)
	clockMu.Unlock()
	if _, err := c.STKPush(ctx, validSTKPushRequest()); err != nil {
		t.Fatal(err)
	}
	if oauthHits != 2 {
		t.Fatalf("token older than 50min did not refresh: oauthHits=%d", oauthHits)
	}
}

func TestConcurrentTokenCallersSingleFlight(t *testing.T) {
	oauthHits := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/v1/generate", func(w http.ResponseWriter, r *http.Request) {
		oauthHits++
		writeJSON(t, w, http.StatusOK, map[string]any{"access_token": "tok-shared", "expires_in": "3599"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := testClient(t, srv.URL)
	const n = 16
	var wg sync.WaitGroup
	errCh := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tok, err := c.Token(context.Background())
			if err != nil {
				errCh <- err
				return
			}
			if tok != "tok-shared" {
				errCh <- fmt.Errorf("token = %q", tok)
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Errorf("concurrent Token: %v", err)
	}
	if oauthHits != 1 {
		t.Fatalf("oauth fetches = %d with %d concurrent callers, want single-flight 1", oauthHits, n)
	}
}

func TestValidationBeforeAnyNetworkCall(t *testing.T) {
	networkTouched := false
	mux := http.NewServeMux()
	guard := func(pattern string) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			networkTouched = true
			http.Error(w, "validation must run client-side", http.StatusInternalServerError)
		})
	}
	for _, p := range []string{"/oauth/v1/generate", stkPushPath, b2cPath, txStatusPath, reversalPath, accountBalancePath, qrCodePath, c2bRegisterPath, c2bSimulatePath} {
		guard(p)
	}
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := testClient(t, srv.URL)
	ctx := context.Background()

	cases := []struct {
		name string
		call func() error
		want string
	}{
		{"stk amount zero", func() error {
			r := validSTKPushRequest()
			r.Amount = 0
			_, err := c.STKPush(ctx, r)
			return err
		}, "Amount"},
		{"stk negative amount", func() error {
			r := validSTKPushRequest()
			r.Amount = -5
			_, err := c.STKPush(ctx, r)
			return err
		}, "Amount"},
		{"stk account reference too long", func() error {
			r := validSTKPushRequest()
			r.AccountReference = "thirteen-chars"
			_, err := c.STKPush(ctx, r)
			return err
		}, "AccountReference"},
		{"stk description too long", func() error {
			r := validSTKPushRequest()
			r.TransactionDesc = "fourteen chars!"
			_, err := c.STKPush(ctx, r)
			return err
		}, "TransactionDesc"},
		{"stk bad phone", func() error {
			r := validSTKPushRequest()
			r.PhoneNumber = "07123"
			_, err := c.STKPush(ctx, r)
			return err
		}, "MSISDN"},
		{"stk bad transaction type", func() error {
			r := validSTKPushRequest()
			r.TransactionType = "CustomerTelepathyOnline"
			_, err := c.STKPush(ctx, r)
			return err
		}, "TransactionType"},
		{"b2c remarks too short", func() error {
			_, err := c.B2CPayout(ctx, B2CPayoutRequest{InitiatorName: "i", SecurityCredential: "c", CommandID: CommandSalaryPayment, Amount: 500, PartyA: "600992", PartyB: "254705912645", Remarks: "x", QueueTimeOutURL: "https://a.com/t", ResultURL: "https://a.com/r"})
			return err
		}, "Remarks"},
		{"b2c remarks too long", func() error {
			_, err := c.B2CPayout(ctx, B2CPayoutRequest{InitiatorName: "i", SecurityCredential: "c", CommandID: CommandSalaryPayment, Amount: 500, PartyA: "600992", PartyB: "254705912645", Remarks: strings.Repeat("r", 101), QueueTimeOutURL: "https://a.com/t", ResultURL: "https://a.com/r"})
			return err
		}, "Remarks"},
		{"b2c amount below minimum", func() error {
			_, err := c.B2CPayout(ctx, B2CPayoutRequest{InitiatorName: "i", SecurityCredential: "c", CommandID: CommandSalaryPayment, Amount: 9, PartyA: "600992", PartyB: "254705912645", Remarks: "ok", QueueTimeOutURL: "https://a.com/t", ResultURL: "https://a.com/r"})
			return err
		}, "Amount"},
		{"b2c amount above maximum", func() error {
			_, err := c.B2CPayout(ctx, B2CPayoutRequest{InitiatorName: "i", SecurityCredential: "c", CommandID: CommandSalaryPayment, Amount: 250001, PartyA: "600992", PartyB: "254705912645", Remarks: "ok", QueueTimeOutURL: "https://a.com/t", ResultURL: "https://a.com/r"})
			return err
		}, "Amount"},
		{"b2c invalid command", func() error {
			_, err := c.B2CPayout(ctx, B2CPayoutRequest{InitiatorName: "i", SecurityCredential: "c", CommandID: "SendMoneyPls", Amount: 500, PartyA: "600992", PartyB: "254705912645", Remarks: "ok", QueueTimeOutURL: "https://a.com/t", ResultURL: "https://a.com/r"})
			return err
		}, "CommandID"},
		{"txstatus both identifiers", func() error {
			_, err := c.TransactionStatus(ctx, TransactionStatusRequest{Initiator: "i", SecurityCredential: "c", TransactionID: "R1", OriginalConversationID: "o-1", PartyA: "600992", Remarks: "ok", ResultURL: "https://a.com/r", QueueTimeOutURL: "https://a.com/t"})
			return err
		}, "exactly one"},
		{"txstatus neither identifier", func() error {
			_, err := c.TransactionStatus(ctx, TransactionStatusRequest{Initiator: "i", SecurityCredential: "c", PartyA: "600992", Remarks: "ok", ResultURL: "https://a.com/r", QueueTimeOutURL: "https://a.com/t"})
			return err
		}, "exactly one"},
		{"reversal remarks out of band", func() error {
			_, err := c.Reversal(ctx, ReversalRequest{Initiator: "i", SecurityCredential: "c", TransactionID: "R1", Amount: 10, ReceiverParty: "600992", Remarks: "", ResultURL: "https://a.com/r", QueueTimeOutURL: "https://a.com/t"})
			return err
		}, "Remarks"},
		{"qr invalid trx code", func() error {
			_, err := c.GenerateQRCode(ctx, QRCodeRequest{MerchantName: "m", RefNo: "ref", Amount: 1, TrxCode: "ZZ", CPI: "174379", Size: "300"})
			return err
		}, "TrxCode"},
		{"qr zero amount", func() error {
			_, err := c.GenerateQRCode(ctx, QRCodeRequest{MerchantName: "m", RefNo: "ref", Amount: 0, TrxCode: "BG", CPI: "174379", Size: "300"})
			return err
		}, "Amount"},
		{"register invalid response type", func() error {
			_, err := c.C2BRegisterURL(ctx, C2BRegisterRequest{ResponseType: "Maybe", ConfirmationURL: "https://a.com/c", ValidationURL: "https://a.com/v"})
			return err
		}, "ResponseType"},
		{"simulate paybill without bill ref", func() error {
			_, err := c.C2BSimulate(ctx, C2BSimulateRequest{CommandID: TransactionTypePayBillOnline, Amount: 5, Msisdn: "0712345678"})
			return err
		}, "BillRefNumber"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call()
			if err == nil {
				t.Fatalf("expected validation error containing %q", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q missing %q", err, tc.want)
			}
		})
	}
	if networkTouched {
		t.Fatal("network was touched during validation failures")
	}
}
