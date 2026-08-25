package mpesa

import (
	"bytes"
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
	c, err := NewClient(Config{
		ConsumerKey:    "test-key",
		ConsumerSecret: "test-secret",
		Shortcode:      testShortcode,
		Passkey:        testPasskey,
		Environment:    Sandbox,
		Now:            func() time.Time { return fixedClock },
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
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
		if m["CommandID"] != string(CommandTransactionStatusQuery) {
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
		if m["CommandID"] != string(CommandTransactionReversal) {
			t.Errorf("reversal CommandID = %v", m["CommandID"])
		}
	})
	assertBody(accountBalancePath, func(m map[string]any) {
		if m["CommandID"] != string(CommandAccountBalance) {
			t.Errorf("balance CommandID = %v", m["CommandID"])
		}
		if m["IdentifierType"] != IdentifierOrgShortcode {
			t.Errorf("balance IdentifierType default = %v, want 4", m["IdentifierType"])
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

	c, err := NewClient(Config{
		ConsumerKey: "test-key", ConsumerSecret: "test-secret", Shortcode: testShortcode, Passkey: testPasskey,
		Environment: Sandbox, Now: currentNow,
	})
	if err != nil {
		t.Fatal(err)
	}
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
		{"stk missing transaction type", func() error {
			r := validSTKPushRequest()
			r.TransactionType = ""
			_, err := c.STKPush(ctx, r)
			return err
		}, "TransactionType is required"},
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

// --- Consolidated review round: client hardening (K1..S9) ---

// K2 + test gap: STKQuery honors a BusinessShortCode override end-to-end and
// binds the password to the EFFECTIVE shortcode; the default path keeps
// cfg.Shortcode. Body must always carry BusinessShortCode/Password/Timestamp.
func TestSTKQueryOverrideAndDefaultBinding(t *testing.T) {
	oauthHits := 0
	var mu sync.Mutex
	var bodies []map[string]any
	mux := http.NewServeMux()
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))
	mux.HandleFunc(stkQueryPath, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Errorf("bad query body %s: %v", raw, err)
		}
		mu.Lock()
		bodies = append(bodies, m)
		mu.Unlock()
		writeJSON(t, w, http.StatusOK, STKQueryResponse{ResponseCode: "0", ResultCode: "0"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := testClient(t, srv.URL)
	ctx := context.Background()

	if _, err := c.STKQuery(ctx, STKQueryRequest{CheckoutRequestID: "ws_CO_default"}); err != nil {
		t.Fatalf("default query: %v", err)
	}
	if _, err := c.STKQuery(ctx, STKQueryRequest{CheckoutRequestID: "ws_CO_override", BusinessShortCode: "999888"}); err != nil {
		t.Fatalf("override query: %v", err)
	}

	if len(bodies) != 2 {
		t.Fatalf("captured %d bodies, want 2", len(bodies))
	}
	def, ov := bodies[0], bodies[1]
	for _, m := range []map[string]any{def, ov} {
		for _, key := range []string{"BusinessShortCode", "Password", "Timestamp"} {
			if _, ok := m[key]; !ok {
				t.Fatalf("query body missing %q: %v", key, m)
			}
		}
	}
	if def["BusinessShortCode"] != testShortcode {
		t.Errorf("default BusinessShortCode = %v, want cfg.Shortcode", def["BusinessShortCode"])
	}
	verifyPasswordBinding(t, def, testShortcode)
	if ov["BusinessShortCode"] != "999888" {
		t.Errorf("override BusinessShortCode = %v, want 999888", ov["BusinessShortCode"])
	}
	verifyPasswordBinding(t, ov, "999888")
}

func verifyPasswordBinding(t *testing.T, m map[string]any, shortcode string) {
	t.Helper()
	ts, _ := m["Timestamp"].(string)
	pw, _ := m["Password"].(string)
	want := base64.StdEncoding.EncodeToString([]byte(shortcode + testPasskey + ts))
	if pw != want {
		t.Fatalf("password not bound to effective shortcode %q / timestamp %q", shortcode, ts)
	}
}

// Test gap: PartyB defaults to the shortcode and passes explicit values through.
func TestPartyBDefaultAndPassthrough(t *testing.T) {
	var mu sync.Mutex
	var partyBs []any
	mux := http.NewServeMux()
	oauthHits := 0
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))
	mux.HandleFunc(stkPushPath, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		mu.Lock()
		partyBs = append(partyBs, m["PartyB"])
		mu.Unlock()
		writeJSON(t, w, http.StatusOK, STKPushResponse{ResponseCode: "0", CheckoutRequestID: "ws_CO_1"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := testClient(t, srv.URL)

	noB := validSTKPushRequest()
	noB.PartyB = ""
	withB := validSTKPushRequest()
	withB.PartyB = "999777"
	if _, err := c.STKPush(context.Background(), noB); err != nil {
		t.Fatal(err)
	}
	if _, err := c.STKPush(context.Background(), withB); err != nil {
		t.Fatal(err)
	}
	if partyBs[0] != testShortcode {
		t.Errorf("empty PartyB = %v, want default shortcode", partyBs[0])
	}
	if partyBs[1] != "999777" {
		t.Errorf("explicit PartyB = %v, want passthrough 999777", partyBs[1])
	}
}

// K4: zero-config clients fail with an actionable message before any network I/O.
func TestZeroConfigSurfacesActionableError(t *testing.T) {
	totalHits := 0
	mux := http.NewServeMux()
	guard := func(pattern string) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			totalHits++
			http.Error(w, "must not be reached", http.StatusInternalServerError)
		})
	}
	guard("/oauth/v1/generate")
	guard(stkPushPath)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c, err := NewClient(Config{Environment: Sandbox})
	if err != nil {
		t.Fatal(err)
	}
	c.baseURL = srv.URL

	if _, err := c.Token(context.Background()); err == nil ||
		!strings.Contains(err.Error(), "Config.ConsumerKey and Config.ConsumerSecret are required") {
		t.Fatalf("Token err = %v, want actionable config error", err)
	}
	req := validSTKPushRequest()
	req.BusinessShortCode = testShortcode
	if _, err := c.STKPush(context.Background(), req); err == nil ||
		!strings.Contains(err.Error(), "Config.ConsumerKey and Config.ConsumerSecret are required") {
		t.Fatalf("STKPush err = %v, want same actionable config error", err)
	}
	if totalHits != 0 {
		t.Fatalf("network hits = %d, want 0", totalHits)
	}
}

// S1: Daraja never legitimately redirects; the SDK must surface redirects as
// responses, never follow them (307/308 would replay the body cross-host).
func TestRedirectsNeverFollowed(t *testing.T) {
	targetHits := 0
	mux := http.NewServeMux()
	oauthHits := 0
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))
	mux.HandleFunc(qrCodePath, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "/elsewhere")
		w.WriteHeader(http.StatusFound)
	})
	mux.HandleFunc("/elsewhere", func(w http.ResponseWriter, r *http.Request) {
		targetHits++
		writeJSON(t, w, http.StatusOK, QRCodeResponse{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, err := testClient(t, srv.URL).GenerateQRCode(context.Background(),
		QRCodeRequest{MerchantName: "m", RefNo: "r", Amount: 1, TrxCode: QRTrxBuyGoods, CPI: "174379", Size: "300"})
	var mpesaErr *Error
	if !errors.As(err, &mpesaErr) || mpesaErr.StatusCode != http.StatusFound {
		t.Fatalf("err = %v, want typed HTTP 302 error", err)
	}
	if targetHits != 0 {
		t.Fatalf("redirect target hit %d times, want never followed", targetHits)
	}
}

// S2: concurrent 401.003.01 holders must produce exactly ONE forced refetch;
// the loser adopts the winner's token via the generation guard.
func TestConcurrent401GenerationGuardSingleRefetch(t *testing.T) {
	var mu sync.Mutex
	oauthHits, okCount := 0, 0
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/v1/generate", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		oauthHits++
		n := oauthHits
		mu.Unlock()
		tok := "tok-v1"
		if n > 1 {
			tok = "tok-v2"
		}
		writeJSON(t, w, http.StatusOK, map[string]any{"access_token": tok, "expires_in": "3599"})
	})
	mux.HandleFunc(stkPushPath, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer tok-v1" {
			writeJSON(t, w, http.StatusUnauthorized, errorEnvelope{ErrorCode: "401.003.01", ErrorMessage: "Invalid access token"})
			return
		}
		mu.Lock()
		okCount++
		mu.Unlock()
		writeJSON(t, w, http.StatusOK, STKPushResponse{ResponseCode: "0"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := testClient(t, srv.URL)

	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, err := c.STKPush(context.Background(), validSTKPushRequest()); err != nil {
				errs <- err
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent retry failed: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if okCount != 2 {
		t.Errorf("successful pushes = %d, want 2 (peer adoption must still succeed)", okCount)
	}
	if oauthHits != 2 {
		t.Errorf("oauth fetches = %d, want exactly 2 (initial + ONE guarded refresh)", oauthHits)
	}
}

// Test gap: a 401 WITHOUT errorCode 401.003.01 is not retryable — surface it
// immediately after exactly one attempt.
func TestNonRetryable401SurfacesImmediately(t *testing.T) {
	pushHits, oauthHits := 0, 0
	mux := http.NewServeMux()
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))
	mux.HandleFunc(stkPushPath, func(w http.ResponseWriter, r *http.Request) {
		pushHits++
		writeJSON(t, w, http.StatusUnauthorized, errorEnvelope{ErrorCode: "500.001.1001", ErrorMessage: "wrong credentials"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, err := testClient(t, srv.URL).STKPush(context.Background(), validSTKPushRequest())
	var mpesaErr *Error
	if !errors.As(err, &mpesaErr) || mpesaErr.StatusCode != http.StatusUnauthorized {
		t.Fatalf("err = %v, want typed 401", err)
	}
	if pushHits != 1 || oauthHits != 1 {
		t.Fatalf("pushHits=%d oauthHits=%d, want 1/1 (no retry for other error codes)", pushHits, oauthHits)
	}
}

// Test gap: persistent 401.003.01 exhausts the single retry and surfaces a
// typed error — never an infinite loop.
func TestRetryExhaustionTypedError(t *testing.T) {
	pushHits, oauthHits := 0, 0
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/v1/generate", func(w http.ResponseWriter, r *http.Request) {
		oauthHits++
		writeJSON(t, w, http.StatusOK, map[string]any{"access_token": fmt.Sprintf("tok-%d", oauthHits), "expires_in": "3599"})
	})
	mux.HandleFunc(stkPushPath, func(w http.ResponseWriter, r *http.Request) {
		pushHits++
		writeJSON(t, w, http.StatusUnauthorized, errorEnvelope{ErrorCode: "401.003.01", ErrorMessage: "still invalid"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, err := testClient(t, srv.URL).STKPush(context.Background(), validSTKPushRequest())
	var mpesaErr *Error
	if !errors.As(err, &mpesaErr) || mpesaErr.StatusCode != http.StatusUnauthorized {
		t.Fatalf("err = %v, want typed 401 after exhaustion", err)
	}
	if pushHits != 2 || oauthHits != 2 {
		t.Fatalf("pushHits=%d oauthHits=%d, want exactly one retry (2/2)", pushHits, oauthHits)
	}
}

// S4: expires_in drives refresh cadence (TTL-60s), not a fixed 50 minutes.
func TestShortTTLDrivesRefreshCadence(t *testing.T) {
	now := fixedClock
	clockMu := sync.Mutex{}
	currentNow := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return now
	}
	oauthHits := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/v1/generate", func(w http.ResponseWriter, r *http.Request) {
		oauthHits++
		writeJSON(t, w, http.StatusOK, map[string]any{"access_token": "tok-short", "expires_in": "120"})
	})
	mux.HandleFunc(accountBalancePath, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, http.StatusOK, ConversationResponse{ResponseCode: "0"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c, err := NewClient(Config{
		ConsumerKey: "test-key", ConsumerSecret: "test-secret",
		Shortcode: testShortcode, Passkey: testPasskey,
		Environment: Sandbox, Now: currentNow,
	})
	if err != nil {
		t.Fatal(err)
	}
	c.baseURL = srv.URL
	bal := AccountBalanceRequest{
		Initiator: "i", SecurityCredential: "c", PartyA: "600992", Remarks: "eod",
		ResultURL: "https://a.com/r", QueueTimeOutURL: "https://a.com/t",
	}
	ctx := context.Background()

	if _, err := c.AccountBalance(ctx, bal); err != nil {
		t.Fatal(err)
	}
	clockMu.Lock()
	now = fixedClock.Add(59 * time.Second)
	clockMu.Unlock()
	if _, err := c.AccountBalance(ctx, bal); err != nil {
		t.Fatal(err)
	}
	if oauthHits != 1 {
		t.Fatalf("within TTL-60s cadence token must be cached; oauthHits=%d", oauthHits)
	}
	clockMu.Lock()
	now = fixedClock.Add(70 * time.Second)
	clockMu.Unlock()
	if _, err := c.AccountBalance(ctx, bal); err != nil {
		t.Fatal(err)
	}
	if oauthHits != 2 {
		t.Fatalf("past TTL-60s (60s for a 120s TTL) token must refresh; oauthHits=%d", oauthHits)
	}
}

// S5: hostile envelope fields are control-stripped and byte-capped.
func TestHostileErrorEnvelopeSanitized(t *testing.T) {
	mux := http.NewServeMux()
	oauthHits := 0
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))
	mux.HandleFunc(qrCodePath, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, http.StatusBadRequest, map[string]any{
			"requestId":    strings.Repeat("A", 600),
			"errorCode":    "X\x1b[31m",
			"errorMessage": "line1\n\x1b[32mline2<script>",
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, err := testClient(t, srv.URL).GenerateQRCode(context.Background(),
		QRCodeRequest{MerchantName: "m", RefNo: "r", Amount: 1, TrxCode: QRTrxPaybill, CPI: "174379", Size: "300"})
	var mpesaErr *Error
	if !errors.As(err, &mpesaErr) {
		t.Fatalf("err = %v, want typed error", err)
	}
	if len(mpesaErr.RequestID) != 512 {
		t.Errorf("requestId len = %d, want capped at 512", len(mpesaErr.RequestID))
	}
	for _, field := range []string{mpesaErr.ErrorCode, mpesaErr.ErrorMessage} {
		if strings.ContainsAny(field, "\n\x1b\x07") {
			t.Errorf("field %q retains control characters", field)
		}
	}
	msg := mpesaErr.Error()
	if strings.ContainsAny(msg, "\n\x1b") {
		t.Errorf("Error() = %q renders multi-line/escape output", msg)
	}
}

// S6/C7: non-2xx bodies that are NOT the Daraja envelope yield diagnostics:
// content-type, byte length and a control-stripped ASCII snippet.
func TestUnparseableBodyDiagnostics(t *testing.T) {
	body := "<html>request blocked by WAF</html>"
	mux := http.NewServeMux()
	oauthHits := 0
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))
	mux.HandleFunc(accountBalancePath, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(body))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	bal := AccountBalanceRequest{
		Initiator: "i", SecurityCredential: "c", PartyA: "600992", Remarks: "eod",
		ResultURL: "https://a.com/r", QueueTimeOutURL: "https://a.com/t",
	}
	_, err := testClient(t, srv.URL).AccountBalance(context.Background(), bal)
	var mpesaErr *Error
	if !errors.As(err, &mpesaErr) {
		t.Fatalf("err = %v, want typed error", err)
	}
	msg := mpesaErr.Error()
	for _, want := range []string{"text/html", fmt.Sprintf("%d bytes", len(body)), "blocked by WAF"} {
		if !strings.Contains(msg, want) {
			t.Errorf("diagnostic error %q missing %q", msg, want)
		}
	}
}

// S8: optional injected *http.Client is cloned (never mutated) and still gets
// the no-redirect policy plus a timeout default when zero.
func TestHTTPClientInjection(t *testing.T) {
	injected := &http.Client{Timeout: 5 * time.Second}
	c, err := NewClient(Config{Environment: Sandbox, HTTPClient: injected})
	if err != nil {
		t.Fatal(err)
	}
	if c.http == injected {
		t.Fatal("injected client must be cloned, not aliased")
	}
	if c.http.Timeout != 5*time.Second {
		t.Errorf("cloned timeout = %v, want injected 5s preserved", c.http.Timeout)
	}
	req := httptest.NewRequest(http.MethodGet, "http://example/", nil)
	if c.http.CheckRedirect == nil || c.http.CheckRedirect(req, nil) != http.ErrUseLastResponse {
		t.Error("injected client must inherit ErrUseLastResponse redirect policy")
	}

	def, err := NewClient(Config{Environment: Sandbox})
	if err != nil {
		t.Fatal(err)
	}
	if def.http.Timeout != defaultTimeout {
		t.Errorf("default timeout = %v, want %v", def.http.Timeout, defaultTimeout)
	}
	zero := &http.Client{}
	c2, err := NewClient(Config{Environment: Sandbox, HTTPClient: zero})
	if err != nil {
		t.Fatal(err)
	}
	if c2.http.Timeout != defaultTimeout {
		t.Errorf("zero-timeout injection should get default; got %v", c2.http.Timeout)
	}
	if injected.Timeout != 5*time.Second || zero.Timeout != 0 {
		t.Error("injected clients were mutated")
	}
}

// Test gap: raw misspelled ACK bytes straight off the wire decode through the
// HTTP path into the clean Go field name.
// Test gap: a 200 response whose body exceeds the 1MiB LimitReader cap must
// fail loudly — never buffer 2MiB whole or silently truncate into the decoder.
func TestOversizedResponseBodyRejected(t *testing.T) {
	oauthHits := 0
	mux := http.NewServeMux()
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))
	mux.HandleFunc(b2cPath, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(bytes.Repeat([]byte("A"), 2<<20)) // 2MiB > maxResponseLen
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	b2c := B2CPayoutRequest{
		InitiatorName: "testapi", SecurityCredential: strings.Repeat("x", 344), CommandID: CommandBusinessPayment,
		Amount: 100, PartyA: "600992", PartyB: "254705912645", Remarks: "cap check",
		QueueTimeOutURL: "https://mydomain.com/timeout", ResultURL: "https://mydomain.com/result",
	}
	_, err := testClient(t, srv.URL).B2CPayout(context.Background(), b2c)
	if err == nil {
		t.Fatal("expected oversized-response cap error")
	}
	want := fmt.Sprintf("response exceeds %d bytes", maxResponseLen)
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v, want substring %q", err, want)
	}
}

// refreshAfterInvalidToken must check wall-clock freshness before adopting a
// peer's token. When the peer refreshed (gen bumped) but its token has since
// expired, the caller must force-refresh rather than re-use the stale token.
func TestRefreshAfterInvalidTokenRejectsStalePeerToken(t *testing.T) {
	var mu sync.Mutex
	oauthHits := 0
	now := fixedClock
	currentNow := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/v1/generate", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		oauthHits++
		n := oauthHits
		mu.Unlock()
		tok := "tok-v1"
		if n > 1 {
			tok = "tok-v2"
		}
		writeJSON(t, w, http.StatusOK, map[string]any{"access_token": tok, "expires_in": "120"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c, err := NewClient(Config{
		ConsumerKey: "test-key", ConsumerSecret: "test-secret",
		Shortcode: testShortcode, Passkey: testPasskey,
		Environment: Sandbox, Now: currentNow,
	})
	if err != nil {
		t.Fatal(err)
	}
	c.baseURL = srv.URL
	ctx := context.Background()

	// 1. Fetch initial token (tok-v1, gen=1, expiry=now+60s for 120s TTL).
	tok, err := c.Token(ctx)
	if err != nil {
		t.Fatalf("initial token: %v", err)
	}
	if tok != "tok-v1" {
		t.Fatalf("initial token = %q, want tok-v1", tok)
	}

	// 2. Simulate a peer refresh: bump gen directly (as if another goroutine
	//    called refreshLocked) and set c.token to tok-v2 without resetting
	//    tokenExpiry — the peer's token is logically "new" but we advance
	//    the clock past expiry to make it stale by wall-clock.
	c.mu.Lock()
	c.gen++
	c.token = "tok-v2"
	// Keep tokenExpiry from the original tok-v1 fetch — the clock advance
	// will make tokenFresh() return false.
	c.mu.Unlock()

	// 3. Advance clock past the original token expiry.
	mu.Lock()
	now = fixedClock.Add(70 * time.Second) // past 120s TTL - 60s safety = 60s cadence
	mu.Unlock()

	// 4. Call refreshAfterInvalidToken with myGen=0 (stale caller).
	//    c.gen==1 != myGen==0, so the old code would return c.token (tok-v2)
	//    unconditionally. With the fix, tokenFresh() is false so it must
	//    force-refresh and return tok-v2 from the server (oauthHits=2).
	tok, err = c.refreshAfterInvalidToken(ctx, 0)
	if err != nil {
		t.Fatalf("refreshAfterInvalidToken: %v", err)
	}
	if tok != "tok-v2" {
		t.Fatalf("token = %q, want tok-v2 (fresh from server)", tok)
	}
	mu.Lock()
	defer mu.Unlock()
	if oauthHits != 2 {
		t.Fatalf("oauthHits = %d, want 2 (forced refresh for stale peer token)", oauthHits)
	}
}

func TestC2BAckRawMisspelledBytesThroughHTTP(t *testing.T) {
	mux := http.NewServeMux()
	oauthHits := 0
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))
	mux.HandleFunc(c2bRegisterPath, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"OriginatorCoversationID":"raw-bytes-check","ResponseCode":"0","ResponseDescription":"Accept"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	ack, err := testClient(t, srv.URL).C2BRegisterURL(context.Background(),
		C2BRegisterRequest{ResponseType: ResponseTypeCompleted, ConfirmationURL: "https://a.com/c", ValidationURL: "https://a.com/v"})
	if err != nil {
		t.Fatal(err)
	}
	if ack.OriginatorConversationID != "raw-bytes-check" {
		t.Fatalf("OriginatorConversationID = %q, want raw-bytes-check", ack.OriginatorConversationID)
	}
}
