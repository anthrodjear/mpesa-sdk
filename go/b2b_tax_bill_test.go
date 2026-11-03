package mpesa

// Tests for the three endpoint families added on top of the B2C/QR/C2B
// patterns: B2B Express Checkout, Tax Remittance and the Bill Manager
// register/query/update/delete quartet.
//
// Every test below follows the wire-test style of client_test.go: a real
// httptest server, real JSON bytes on the wire, and real rejection before
// any fetch.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// newFamiliesServer builds a Client whose new endpoints answer the documented
// ACKs, and returns the per-path Authorization headers plus the raw request
// bodies each handler observed, so the wire contract is asserted on real
// bytes written after the response.
func newFamiliesServer(t *testing.T) (*Client, map[string]string, map[string][]byte) {
	t.Helper()
	var mu sync.Mutex
	authByPath := map[string]string{}
	bodies := map[string][]byte{}

	mux := http.NewServeMux()
	oauthHits := 0
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))
	conversationACK := func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, http.StatusOK, ConversationResponse{
			OriginatorConversationID: "o-id", ConversationID: "AG_1",
			ResponseCode: "0", ResponseDescription: "Accept the service request successfully.",
		})
	}
	billACK := func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, http.StatusOK, BillAckResponse{
			ResponseCode: "0", ResponseDescription: "Accept the service request successfully.",
			ConversationID: "AG_2", OriginatorConversationID: "o-bill",
			BillRefNumber: "INV-1",
		})
	}
	record := func(path string, respond func(w http.ResponseWriter, r *http.Request)) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			mu.Lock()
			authByPath[path] = r.Header.Get("Authorization")
			bodies[path] = raw
			mu.Unlock()
			respond(w, r)
		})
	}
	record(b2bPaymentPath, conversationACK)
	record(taxRemittancePath, conversationACK)
	record(billRegisterPath, billACK)
	record(billQueryPath, billACK)
	record(billUpdatePath, billACK)
	record(billDeletePath, billACK)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return testClient(t, srv.URL), authByPath, bodies
}

// decodeBody unmarshals a captured wire body into a map.
func decodeBody(t *testing.T, path string, raw []byte) map[string]any {
	t.Helper()
	if len(raw) == 0 {
		t.Fatalf("no body captured for %s", path)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("decode %s body %s: %v", path, raw, err)
	}
	return m
}

// bodyString renders a captured body as text for key-shape assertions.
func bodyString(t *testing.T, path string, raw []byte) string {
	t.Helper()
	if len(raw) == 0 {
		t.Fatalf("no body captured for %s", path)
	}
	return string(raw)
}

// isLowerHex reports whether s is non-empty lowercase hexadecimal — the shape
// newOriginatorID mints.
func isLowerHex(s string) bool {
	if s == "" {
		return false
	}
	for _, ch := range s {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return false
		}
	}
	return true
}

func validB2BRequest() B2BRequest {
	return B2BRequest{
		Initiator:          "testapi",
		SecurityCredential: "cred",
		CommandID:          CommandBusinessPayBill,
		Amount:             100,
		PartyA:             "600992",
		PartyB:             testShortcode,
		AccountReference:   "acct-1",
		Remarks:            "settle invoice",
		QueueTimeOutURL:    "https://mydomain.com/timeout",
		ResultURL:          "https://mydomain.com/result",
	}
}

func validTaxRequest() TaxRemittanceRequest {
	return TaxRemittanceRequest{
		Initiator:          "testapi",
		SecurityCredential: "cred",
		CommandID:          CommandTaxRemittance,
		Amount:             1000,
		PartyA:             "600992",
		PartyB:             testShortcode,
		AccountReference:   "KRA-PAYE-01",
		Remarks:            "PAYE January",
		QueueTimeOutURL:    "https://mydomain.com/timeout",
		ResultURL:          "https://mydomain.com/result",
		TaxPeriod:          "2026-01",
		TaxObligation:      "PAYE",
		TaxPayerPIN:        "A012345678Z",
	}
}

func validBillRegisterRequest() BillRegisterRequest {
	return BillRegisterRequest{
		ShortCode:     testShortcode,
		BillRefNumber: "INV-1",
		BillName:      "Invoice 1",
		Amount:        250,
		ExpiryDate:    "2026-03-01",
		CallBackURL:   "https://mydomain.com/bill/callback",
	}
}

// Each new endpoint must hit its EXACT documented path, carrying the Bearer
// token the OAuth call minted, and must surface the shared ACK envelope.
func TestNewFamiliesHitDocumentedPathsWithBearer(t *testing.T) {
	c, authByPath, bodies := newFamiliesServer(t)
	ctx := context.Background()

	b2b, err := c.B2BPayment(ctx, validB2BRequest())
	if err != nil {
		t.Fatalf("B2BPayment: %v", err)
	}
	if b2b.ConversationID != "AG_1" || b2b.ResponseCode != "0" {
		t.Fatalf("B2B ACK not surfaced: %+v", b2b)
	}
	tax, err := c.TaxRemittance(ctx, validTaxRequest())
	if err != nil {
		t.Fatalf("TaxRemittance: %v", err)
	}
	if tax.ConversationID != "AG_1" {
		t.Fatalf("Tax ACK not surfaced: %+v", tax)
	}
	reg, err := c.BillRegister(ctx, validBillRegisterRequest())
	if err != nil {
		t.Fatalf("BillRegister: %v", err)
	}
	if reg.ConversationID != "AG_2" || reg.BillRefNumber != "INV-1" {
		t.Fatalf("Bill register ACK not surfaced: %+v", reg)
	}
	q, err := c.BillQuery(ctx, BillQueryRequest{ShortCode: testShortcode, BillRefNumber: "INV-1"})
	if err != nil {
		t.Fatalf("BillQuery: %v", err)
	}
	if q.ConversationID != "AG_2" {
		t.Fatalf("Bill query ACK not surfaced: %+v", q)
	}
	up, err := c.BillUpdate(ctx, BillUpdateRequest{ShortCode: testShortcode, BillRefNumber: "INV-1", Amount: 300})
	if err != nil {
		t.Fatalf("BillUpdate: %v", err)
	}
	if up.ConversationID != "AG_2" {
		t.Fatalf("Bill update ACK not surfaced: %+v", up)
	}
	// An update that supplies only the two identifiers must omit EVERY
	// optional field rather than send zero values.
	noop, err := c.BillUpdate(ctx, BillUpdateRequest{ShortCode: testShortcode, BillRefNumber: "INV-1"})
	if err != nil {
		t.Fatalf("amountless BillUpdate: %v", err)
	}
	if noop.ConversationID != "AG_2" {
		t.Fatalf("amountless BillUpdate ACK not surfaced: %+v", noop)
	}
	noopBody := bodyString(t, billUpdatePath, bodies[billUpdatePath])
	for _, key := range []string{"Amount", "ExpiryDate", "CallBackURL", "PayerNumber", "PayerName"} {
		if strings.Contains(noopBody, `"`+key+`"`) {
			t.Errorf("amountless update sent %s: %s", key, noopBody)
		}
	}
	del, err := c.BillDelete(ctx, BillDeleteRequest{ShortCode: testShortcode, BillRefNumber: "INV-1"})
	if err != nil {
		t.Fatalf("BillDelete: %v", err)
	}
	if del.ConversationID != "AG_2" {
		t.Fatalf("Bill delete ACK not surfaced: %+v", del)
	}

	for _, path := range []string{b2bPaymentPath, taxRemittancePath, billRegisterPath, billQueryPath, billUpdatePath, billDeletePath} {
		if authByPath[path] != "Bearer tok-123" {
			t.Errorf("path %s Authorization = %q, want Bearer token", path, authByPath[path])
		}
		if len(bodies[path]) == 0 {
			t.Errorf("path %s sent no body", path)
		}
	}

	// Contractual casing: the wire keys are part of the contract, so a casing
	// regression must fail here rather than at the gateway.
	for _, key := range []string{"OriginatorConversationID", "Initiator", "SecurityCredential", "CommandID",
		"SenderIdentifierType", "ReceiverIdentifierType", "Amount", "PartyA", "PartyB", "AccountReference",
		"Remarks", "QueueTimeOutURL", "ResultURL"} {
		if !strings.Contains(bodyString(t, b2bPaymentPath, bodies[b2bPaymentPath]), `"`+key+`"`) {
			t.Errorf("b2b body missing wire key %s: %s", key, bodyString(t, b2bPaymentPath, bodies[b2bPaymentPath]))
		}
	}
	if !strings.Contains(bodyString(t, b2bPaymentPath, bodies[b2bPaymentPath]), `"CommandID":"BusinessPayBill"`) {
		t.Errorf("b2b body must send CommandID BusinessPayBill: %s", bodyString(t, b2bPaymentPath, bodies[b2bPaymentPath]))
	}
	for _, key := range []string{"TaxPeriod", "TaxObligation", "TaxPayerPIN"} {
		if !strings.Contains(bodyString(t, taxRemittancePath, bodies[taxRemittancePath]), `"`+key+`"`) {
			t.Errorf("tax body missing wire key %s: %s", key, bodyString(t, taxRemittancePath, bodies[taxRemittancePath]))
		}
	}
	if !strings.Contains(bodyString(t, taxRemittancePath, bodies[taxRemittancePath]), `"CommandID":"TaxRemittance"`) {
		t.Errorf("tax body must send CommandID TaxRemittance: %s", bodyString(t, taxRemittancePath, bodies[taxRemittancePath]))
	}
	for _, key := range []string{"ShortCode", "BillRefNumber", "BillName", "Amount", "ExpiryDate", "CallBackURL"} {
		if !strings.Contains(bodyString(t, billRegisterPath, bodies[billRegisterPath]), `"`+key+`"`) {
			t.Errorf("bill register body missing wire key %s: %s", key, bodyString(t, billRegisterPath, bodies[billRegisterPath]))
		}
	}
	if strings.Contains(bodyString(t, billRegisterPath, bodies[billRegisterPath]), `"PayerNumber"`) {
		t.Errorf("absent optional PayerNumber must be omitted: %s", bodyString(t, billRegisterPath, bodies[billRegisterPath]))
	}
	for _, path := range []string{billQueryPath, billDeletePath} {
		for _, key := range []string{"ShortCode", "BillRefNumber"} {
			if !strings.Contains(bodyString(t, path, bodies[path]), `"`+key+`"`) {
				t.Errorf("%s body missing wire key %s: %s", path, key, bodyString(t, path, bodies[path]))
			}
		}
	}
}

// The client injects OriginatorConversationID and both identifier types, on
// its OWN COPY — the caller's request must come back untouched.
func TestB2BAndTaxInjectDefaultsWithoutMutatingTheCaller(t *testing.T) {
	c, _, bodies := newFamiliesServer(t)
	ctx := context.Background()

	b2b := validB2BRequest()
	if _, err := c.B2BPayment(ctx, b2b); err != nil {
		t.Fatalf("B2BPayment: %v", err)
	}
	if b2b.OriginatorConversationID != "" || b2b.SenderIdentifierType != "" || b2b.ReceiverIdentifierType != "" {
		t.Fatalf("caller's B2B request was mutated: %+v", b2b)
	}
	tax := validTaxRequest()
	if _, err := c.TaxRemittance(ctx, tax); err != nil {
		t.Fatalf("TaxRemittance: %v", err)
	}
	if tax.OriginatorConversationID != "" || tax.SenderIdentifierType != "" || tax.ReceiverIdentifierType != "" {
		t.Fatalf("caller's Tax request was mutated: %+v", tax)
	}

	for _, path := range []string{b2bPaymentPath, taxRemittancePath} {
		m := decodeBody(t, path, bodies[path])
		ocid, _ := m["OriginatorConversationID"].(string)
		if len(ocid) != 16 || !isLowerHex(ocid) {
			t.Errorf("%s auto-generated OriginatorConversationID = %q, want 16 lowercase-hex chars", path, ocid)
		}
		if len(ocid) >= 20 {
			t.Errorf("%s OriginatorConversationID = %q exceeds the <20 char contract", path, ocid)
		}
		if m["SenderIdentifierType"] != IdentifierOrgShortcode || m["ReceiverIdentifierType"] != IdentifierOrgShortcode {
			t.Errorf("%s identifier types = %v/%v, want both %q",
				path, m["SenderIdentifierType"], m["ReceiverIdentifierType"], IdentifierOrgShortcode)
		}
	}

	// An explicit OriginatorConversationID is the caller's idempotency key and
	// must pass through untouched, not be regenerated.
	mine := validB2BRequest()
	mine.OriginatorConversationID = "my-own-idempotency"
	if _, err := c.B2BPayment(ctx, mine); err != nil {
		t.Fatalf("B2BPayment with an explicit OriginatorConversationID: %v", err)
	}
	if !strings.Contains(bodyString(t, b2bPaymentPath, bodies[b2bPaymentPath]), `"OriginatorConversationID":"my-own-idempotency"`) {
		t.Errorf("explicit OriginatorConversationID not passed through: %s", bodyString(t, b2bPaymentPath, bodies[b2bPaymentPath]))
	}
}

// Bill Manager: the optional PayerNumber is normalized to gateway MSISDN form
// and the optional PayerName passes through.
func TestBillRegisterNormalizesOptionalPayerNumber(t *testing.T) {
	c, _, bodies := newFamiliesServer(t)
	r := validBillRegisterRequest()
	r.PayerNumber = "0712345678"
	r.PayerName = "Jane Doe"
	if _, err := c.BillRegister(context.Background(), r); err != nil {
		t.Fatalf("BillRegister: %v", err)
	}
	m := decodeBody(t, billRegisterPath, bodies[billRegisterPath])
	if m["PayerNumber"] != "254712345678" {
		t.Errorf("PayerNumber = %v, want normalized 254712345678", m["PayerNumber"])
	}
	if m["PayerName"] != "Jane Doe" {
		t.Errorf("PayerName = %v, want passthrough", m["PayerName"])
	}
}

// A response that omits the OPTIONAL BillRefNumber key entirely must still
// decode: the bill stays identified by the reference the caller sent.
func TestBillAckToleratesAbsentBillRefNumber(t *testing.T) {
	const raw = `{"ResponseCode":"0","ResponseDescription":"ok","ConversationID":"AG_9","OriginatorConversationID":"o-9"}`
	var ack BillAckResponse
	if err := json.Unmarshal([]byte(raw), &ack); err != nil {
		t.Fatalf("decode ack without BillRefNumber: %v", err)
	}
	if ack.ResponseCode != "0" || ack.ConversationID != "AG_9" || ack.OriginatorConversationID != "o-9" {
		t.Fatalf("ack fields lost: %+v", ack)
	}
	if ack.BillRefNumber != "" {
		t.Fatalf("absent BillRefNumber decoded to %q, want empty", ack.BillRefNumber)
	}

	// And the same body over real HTTP, so the tolerance is end-to-end.
	mux := http.NewServeMux()
	oauthHits := 0
	mux.Handle("/oauth/v1/generate", oauthHandler(t, &oauthHits))
	mux.HandleFunc(billRegisterPath, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(raw))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	got, err := testClient(t, srv.URL).BillRegister(context.Background(), validBillRegisterRequest())
	if err != nil {
		t.Fatalf("BillRegister against an ack without BillRefNumber: %v", err)
	}
	if got.ConversationID != "AG_9" || got.BillRefNumber != "" {
		t.Fatalf("ack passthrough broken: %+v", got)
	}
}

// CommandID restrictions must fire before any network I/O — including the
// OAuth token fetch.
func TestB2BAndTaxRejectBadCommandBeforeAnyNetworkCall(t *testing.T) {
	networkTouched := false
	mux := http.NewServeMux()
	for _, p := range []string{"/oauth/v1/generate", b2bPaymentPath, taxRemittancePath} {
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			networkTouched = true
			http.Error(w, "validation must run client-side", http.StatusInternalServerError)
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := testClient(t, srv.URL)
	ctx := context.Background()

	b2b := validB2BRequest()
	b2b.CommandID = CommandBusinessPayment // a B2C command, NOT a B2B one
	_, err := c.B2BPayment(ctx, b2b)
	if err == nil {
		t.Fatal("B2BPayment accepted a non-B2B CommandID")
	} else if !strings.Contains(err.Error(), "CommandID") {
		t.Fatalf("B2B CommandID error = %v, want it to name %q", err, "CommandID")
	}

	empty := validB2BRequest()
	empty.CommandID = ""
	if _, err := c.B2BPayment(ctx, empty); err == nil {
		t.Error("B2BPayment accepted an empty CommandID, want rejection")
	}

	tax := validTaxRequest()
	tax.CommandID = CommandTransactionReversal
	_, err = c.TaxRemittance(ctx, tax)
	if err == nil {
		t.Fatal("TaxRemittance accepted a non-tax CommandID")
	} else if !strings.Contains(err.Error(), "CommandID must be TaxRemittance") {
		t.Fatalf("Tax CommandID error = %v, want %q", err, "CommandID must be TaxRemittance")
	}

	if networkTouched {
		t.Fatal("network was touched during CommandID rejection")
	}
}

// Shortcode-shape and missing-field rejections across all six new methods.
func TestNewFamiliesRejectMalformedInputBeforeAnyNetworkCall(t *testing.T) {
	networkTouched := false
	mux := http.NewServeMux()
	for _, p := range []string{"/oauth/v1/generate", b2bPaymentPath, taxRemittancePath,
		billRegisterPath, billQueryPath, billUpdatePath, billDeletePath} {
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			networkTouched = true
			http.Error(w, "validation must run client-side", http.StatusInternalServerError)
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := testClient(t, srv.URL)
	ctx := context.Background()

	cases := []struct {
		name string
		call func() error
		want string
	}{
		{"b2b short PartyA", func() error {
			r := validB2BRequest()
			r.PartyA = "6009" // 4 digits: below the documented 5-10
			_, err := c.B2BPayment(ctx, r)
			return err
		}, "PartyA"},
		{"b2b non-numeric PartyB", func() error {
			r := validB2BRequest()
			r.PartyB = "abcde"
			_, err := c.B2BPayment(ctx, r)
			return err
		}, "PartyB"},
		{"b2b missing credential", func() error {
			r := validB2BRequest()
			r.SecurityCredential = ""
			_, err := c.B2BPayment(ctx, r)
			return err
		}, "SecurityCredential"},
		{"b2b zero amount", func() error {
			r := validB2BRequest()
			r.Amount = 0
			_, err := c.B2BPayment(ctx, r)
			return err
		}, "Amount"},
		{"b2b localhost result URL", func() error {
			r := validB2BRequest()
			r.ResultURL = "https://localhost/result"
			_, err := c.B2BPayment(ctx, r)
			return err
		}, "ResultURL"},
		{"b2b overlong remarks", func() error {
			r := validB2BRequest()
			r.Remarks = strings.Repeat("r", 101)
			_, err := c.B2BPayment(ctx, r)
			return err
		}, "Remarks"},
		{"b2b overlong account reference", func() error {
			r := validB2BRequest()
			r.AccountReference = strings.Repeat("a", 65)
			_, err := c.B2BPayment(ctx, r)
			return err
		}, "AccountReference"},
		{"tax missing PIN", func() error {
			r := validTaxRequest()
			r.TaxPayerPIN = ""
			_, err := c.TaxRemittance(ctx, r)
			return err
		}, "TaxPayerPIN"},
		{"tax missing tax period", func() error {
			r := validTaxRequest()
			r.TaxPeriod = "  "
			_, err := c.TaxRemittance(ctx, r)
			return err
		}, "TaxPeriod"},
		{"tax missing obligation", func() error {
			r := validTaxRequest()
			r.TaxObligation = ""
			_, err := c.TaxRemittance(ctx, r)
			return err
		}, "TaxObligation"},
		{"tax overlong period", func() error {
			r := validTaxRequest()
			r.TaxPeriod = strings.Repeat("2", 17)
			_, err := c.TaxRemittance(ctx, r)
			return err
		}, "TaxPeriod"},
		{"tax overlong PIN", func() error {
			r := validTaxRequest()
			r.TaxPayerPIN = strings.Repeat("1", 65)
			_, err := c.TaxRemittance(ctx, r)
			return err
		}, "TaxPayerPIN"},
		{"bill register overlong bill ref", func() error {
			r := validBillRegisterRequest()
			r.BillRefNumber = strings.Repeat("r", 33)
			_, err := c.BillRegister(ctx, r)
			return err
		}, "BillRefNumber"},
		{"bill register overlong name", func() error {
			r := validBillRegisterRequest()
			r.BillName = strings.Repeat("n", 65)
			_, err := c.BillRegister(ctx, r)
			return err
		}, "BillName"},
		{"bill register overlong expiry", func() error {
			r := validBillRegisterRequest()
			r.ExpiryDate = strings.Repeat("9", 11)
			_, err := c.BillRegister(ctx, r)
			return err
		}, "ExpiryDate"},
		{"bill update overlong expiry", func() error {
			_, err := c.BillUpdate(ctx, BillUpdateRequest{
				ShortCode: testShortcode, BillRefNumber: "INV-1", ExpiryDate: strings.Repeat("9", 11),
			})
			return err
		}, "ExpiryDate"},
		{"bill update overlong payer name", func() error {
			_, err := c.BillUpdate(ctx, BillUpdateRequest{
				ShortCode: testShortcode, BillRefNumber: "INV-1", PayerName: strings.Repeat("n", 65),
			})
			return err
		}, "PayerName"},
		{"b2b overlong identifier type", func() error {
			r := validB2BRequest()
			r.SenderIdentifierType = strings.Repeat("4", 13)
			_, err := c.B2BPayment(ctx, r)
			return err
		}, "SenderIdentifierType"},
		{"tax overlong identifier type", func() error {
			r := validTaxRequest()
			r.ReceiverIdentifierType = strings.Repeat("4", 13)
			_, err := c.TaxRemittance(ctx, r)
			return err
		}, "ReceiverIdentifierType"},
		{"bill register bad shortcode", func() error {
			r := validBillRegisterRequest()
			r.ShortCode = "12"
			_, err := c.BillRegister(ctx, r)
			return err
		}, "ShortCode"},
		{"bill register zero amount", func() error {
			r := validBillRegisterRequest()
			r.Amount = 0
			_, err := c.BillRegister(ctx, r)
			return err
		}, "Amount"},
		{"bill register missing expiry", func() error {
			r := validBillRegisterRequest()
			r.ExpiryDate = ""
			_, err := c.BillRegister(ctx, r)
			return err
		}, "ExpiryDate"},
		{"bill register bad payer number", func() error {
			r := validBillRegisterRequest()
			r.PayerNumber = "0712"
			_, err := c.BillRegister(ctx, r)
			return err
		}, "PayerNumber"},
		{"bill query missing bill ref", func() error {
			_, err := c.BillQuery(ctx, BillQueryRequest{ShortCode: testShortcode})
			return err
		}, "BillRefNumber"},
		{"bill update negative amount", func() error {
			_, err := c.BillUpdate(ctx, BillUpdateRequest{ShortCode: testShortcode, BillRefNumber: "INV-1", Amount: -5})
			return err
		}, "Amount"},
		{"bill update bad callback URL", func() error {
			_, err := c.BillUpdate(ctx, BillUpdateRequest{ShortCode: testShortcode, BillRefNumber: "INV-1", CallBackURL: "ftp://mydomain.com/x"})
			return err
		}, "CallBackURL"},
		{"bill delete bad shortcode", func() error {
			_, err := c.BillDelete(ctx, BillDeleteRequest{ShortCode: "abc", BillRefNumber: "INV-1"})
			return err
		}, "ShortCode"},
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

// familiesLimitsClient mirrors limitsClient for the NEW paths only: a ceiling
// rejection must keep the hit counter at zero, and an accepted amount must
// dispatch. The counter is shared by OAuth and every business handler.
func familiesLimitsClient(t *testing.T, cfg Config) (*Client, *atomic.Int64) {
	t.Helper()
	if cfg.ConsumerKey == "" {
		cfg.ConsumerKey = "test-key"
	}
	if cfg.ConsumerSecret == "" {
		cfg.ConsumerSecret = "test-secret"
	}
	if cfg.Environment != Production {
		cfg.Environment = Sandbox
	}
	if cfg.Now == nil {
		cfg.Now = func() time.Time { return fixedClock }
	}
	if cfg.Shortcode == "" {
		cfg.Shortcode = testShortcode
	}
	if cfg.Passkey == "" {
		cfg.Passkey = testPasskey
	}
	c, err := NewClient(cfg)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	var hits atomic.Int64
	mux := http.NewServeMux()
	mux.Handle("/oauth/v1/generate", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		writeJSON(t, w, http.StatusOK, map[string]any{"access_token": "tok-new", "expires_in": "3599"})
	}))
	for _, p := range []string{b2bPaymentPath, taxRemittancePath, billRegisterPath, billUpdatePath} {
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			hits.Add(1)
			writeJSON(t, w, http.StatusOK, ConversationResponse{ResponseCode: "0"})
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c.baseURL = srv.URL
	return c, &hits
}

// The per-transaction ceiling must bite for every new amount-bearing family,
// before any network I/O, and must name its own Config path.
func TestNewFamilyPerTransactionCeilings(t *testing.T) {
	c, hits := familiesLimitsClient(t, Config{})
	ctx := context.Background()

	reject := func(name string, err error) {
		t.Helper()
		if err == nil {
			t.Fatalf("%s accepted 300000, want rejection at the 250000 default ceiling", name)
		}
		var le *LimitError
		if !errors.As(err, &le) || le.Kind != "MaxPerTransaction" {
			t.Fatalf("%s error = %v, want a MaxPerTransaction LimitError", name, err)
		}
	}

	b2b := validB2BRequest()
	b2b.Amount = 300_000
	_, err := c.B2BPayment(ctx, b2b)
	reject("B2BPayment", err)

	tax := validTaxRequest()
	tax.Amount = 300_000
	_, err = c.TaxRemittance(ctx, tax)
	reject("TaxRemittance", err)

	reg := validBillRegisterRequest()
	reg.Amount = 300_000
	_, err = c.BillRegister(ctx, reg)
	reject("BillRegister", err)

	_, err = c.BillUpdate(ctx, BillUpdateRequest{ShortCode: testShortcode, BillRefNumber: "INV-1", Amount: 300_000})
	reject("BillUpdate", err)

	if n := hitCount(hits); n != 0 {
		t.Fatalf("network hits = %d, want 0: the ceiling must reject before any fetch", n)
	}

	// At the ceiling the amount is accepted and DOES dispatch.
	ok := validB2BRequest()
	ok.Amount = 250_000
	if _, err := c.B2BPayment(ctx, ok); err != nil {
		t.Fatalf("B2BPayment 250000 rejected: %v", err)
	}
	if hitCount(hits) == 0 {
		t.Fatal("no dispatch at the ceiling amount")
	}

	// Raising the dedicated B2B/Tax/Bill entries lifts ONLY those ceilings.
	raised, _ := familiesLimitsClient(t, Config{Limits: &TransactionLimits{
		B2B:  ServiceLimits{MaxPerTransaction: Limit(700_000)},
		Tax:  ServiceLimits{MaxPerTransaction: Limit(700_000)},
		Bill: ServiceLimits{MaxPerTransaction: Limit(700_000)},
	}})
	rb := validB2BRequest()
	rb.Amount = 700_000
	if _, err := raised.B2BPayment(ctx, rb); err != nil {
		t.Errorf("B2B 700000 rejected with a 700000 override: %v", err)
	}
	rt := validTaxRequest()
	rt.Amount = 700_000
	if _, err := raised.TaxRemittance(ctx, rt); err != nil {
		t.Errorf("Tax 700000 rejected with a 700000 override: %v", err)
	}
	rr := validBillRegisterRequest()
	rr.Amount = 700_000
	if _, err := raised.BillRegister(ctx, rr); err != nil {
		t.Errorf("Bill 700000 rejected with a 700000 override: %v", err)
	}
	// The untouched families still enforce the baseline.
	if _, err := raised.B2CPayout(ctx, b2cAmount(300_000)); err == nil {
		t.Error("raising B2B/Tax/Bill silently disabled the B2C ceiling, want 250000 enforcement")
	}
	if _, err := raised.Reversal(ctx, reversalAmount(300_000)); err == nil {
		t.Error("raising B2B/Tax/Bill silently disabled the Reversal ceiling")
	}
}

// The LimitError must name the bucket the caller has to edit.
func TestNewFamilyLimitErrorNamesConfigPath(t *testing.T) {
	// Direct ValidateWithLimits demands an explicit OriginatorConversationID
	// (the client is what auto-generates one), so set it before asserting on
	// the ceiling.
	b := validB2BRequest()
	b.OriginatorConversationID = "a1b2c3d4e5f6a7b8"
	b.Amount = 300_000
	err := b.ValidateWithLimits(DefaultTransactionLimits())
	if err == nil {
		t.Fatal("expected a ceiling rejection")
	}
	want := "mpesa: B2B Amount 300000 exceeds configured max 250000 KES " +
		"(set Config.Limits.B2B.MaxPerTransaction, or 0 for unlimited)"
	if err.Error() != want {
		t.Fatalf("B2B LimitError message:\n got %q\nwant %q", err.Error(), want)
	}
	tx := validTaxRequest()
	tx.OriginatorConversationID = "a1b2c3d4e5f6a7b8"
	tx.Amount = 300_000
	err = tx.ValidateWithLimits(DefaultTransactionLimits())
	if err == nil || !strings.Contains(err.Error(), "Config.Limits.Tax.MaxPerTransaction") {
		t.Fatalf("Tax LimitError = %v, want it to name Config.Limits.Tax.MaxPerTransaction", err)
	}
	br := validBillRegisterRequest()
	br.Amount = 300_000
	err = br.ValidateWithLimits(DefaultTransactionLimits())
	if err == nil || !strings.Contains(err.Error(), "Config.Limits.Bill.MaxPerTransaction") {
		t.Fatalf("Bill LimitError = %v, want it to name Config.Limits.Bill.MaxPerTransaction", err)
	}
}

// ServiceDefault must NOT absorb the new buckets: raising Default leaves
// B2B/Tax/Bill at the baseline.
func TestNewBucketsAreNotAbsorbedByServiceDefault(t *testing.T) {
	c, _ := limitsClient(t, Config{Limits: &TransactionLimits{
		Default: ServiceLimits{MaxPerTransaction: Limit(5_000_000)},
	}})
	for _, tc := range []struct {
		svc  Service
		got  ServiceLimits
		name string
	}{
		{ServiceB2B, c.limits.B2B, "B2B"},
		{ServiceTax, c.limits.Tax, "Tax"},
		{ServiceBill, c.limits.Bill, "Bill"},
	} {
		if tc.got.MaxPerTransaction == nil || *tc.got.MaxPerTransaction != 250_000 {
			t.Errorf("%s inherited the Default ceiling (%s), want the 250000 baseline",
				tc.name, ceilingOf(tc.got, tc.got.MaxPerTransaction))
		}
		if tc.got.MaxPerDay == nil || *tc.got.MaxPerDay != 500_000 {
			t.Errorf("%s inherited the Default daily ceiling (%s), want 500000",
				tc.name, ceilingOf(tc.got, tc.got.MaxPerDay))
		}
		// limitsFor routes to the dedicated entry, not Default.
		if got := c.limits.limitsFor(tc.svc); !sameServiceLimits(got, tc.got) {
			t.Errorf("limitsFor(%s) = %+v, want the dedicated entry", tc.svc, got)
		}
		// limitsFieldName drives the Config path printed in the error.
		if got := limitsFieldName(tc.svc); got != tc.name {
			t.Errorf("limitsFieldName(%s) = %q, want %q", tc.svc, got, tc.name)
		}
	}
	// A Default override still governs the un-enumerated services.
	d := c.limits.limitsFor(ServiceDefault)
	if d.MaxPerTransaction == nil || *d.MaxPerTransaction != 5_000_000 {
		t.Errorf("Default override lost: %s", ceilingOf(d, d.MaxPerTransaction))
	}
}

// Each new family keeps its OWN daily bucket once TrackDaily is on, and the
// daily ceiling refuses the next unit exactly at 500000.
func TestNewFamilyDailyBucketsAreIndependent(t *testing.T) {
	c, _ := familiesLimitsClient(t, Config{TrackDaily: true})
	ctx := context.Background()

	if _, err := c.B2BPayment(ctx, validB2BRequest()); err != nil {
		t.Fatalf("B2BPayment: %v", err)
	}
	if _, err := c.TaxRemittance(ctx, validTaxRequest()); err != nil {
		t.Fatalf("TaxRemittance: %v", err)
	}
	if _, err := c.BillRegister(ctx, validBillRegisterRequest()); err != nil {
		t.Fatalf("BillRegister: %v", err)
	}

	for _, tc := range []struct {
		svc  Service
		want int64
	}{
		{ServiceB2B, 100}, {ServiceTax, 1000}, {ServiceBill, 250},
	} {
		if got := dailyUsed(&c.daily, tc.svc); got != tc.want {
			t.Errorf("%s daily used = %d, want %d", tc.svc, got, tc.want)
		}
	}
	for _, other := range []Service{ServiceB2C, ServiceSTK, ServiceC2B, ServiceQR, ServiceReversal, ServiceDefault} {
		if got := dailyUsed(&c.daily, other); got != 0 {
			t.Errorf("%s daily used = %d, want 0 (the new families must not leak into it)", other, got)
		}
	}

	// A per-transaction rejection must NOT consume daily budget: the
	// per-transaction gate runs before the daily check, so the ledger stays
	// untouched at exactly 100.
	two := validB2BRequest()
	two.Amount = 300_000
	_, err := c.B2BPayment(ctx, two)
	var le *LimitError
	if !errors.As(err, &le) || le.Kind != "MaxPerTransaction" {
		t.Fatalf("B2BPayment 300000 err = %v, want a MaxPerTransaction LimitError", err)
	}
	if got := dailyUsed(&c.daily, ServiceB2B); got != 100 {
		t.Fatalf("B2B daily used = %d after a per-transaction rejection, want 100", got)
	}

	// 100 + 250000 + 249900 = 500000 is exactly the daily ceiling (each call
	// stays under the 250000 per-transaction cap), so both must pass...
	for _, amount := range []int64{250_000, 249_900} {
		at := validB2BRequest()
		at.Amount = amount
		if _, err := c.B2BPayment(ctx, at); err != nil {
			t.Fatalf("B2BPayment %d toward the 500000 daily ceiling: %v", amount, err)
		}
	}
	if got := dailyUsed(&c.daily, ServiceB2B); got != 500_000 {
		t.Fatalf("B2B daily used = %d at the ceiling, want 500000", got)
	}
	// ...and one more shilling must be refused by the DAILY ceiling, without
	// consuming anything.
	over := validB2BRequest()
	over.Amount = 1
	_, err = c.B2BPayment(ctx, over)
	if !errors.As(err, &le) || le.Kind != "MaxPerDay" {
		t.Fatalf("B2BPayment past the daily ceiling err = %v, want a MaxPerDay LimitError", err)
	}
	if got := dailyUsed(&c.daily, ServiceB2B); got != 500_000 {
		t.Errorf("B2B daily used = %d after the refused shilling, want 500000", got)
	}
}

// Every new credentialed/PII-carrying type must render redacted at %v, %+v
// and %#v.
func TestNewFamilyRendersRedacted(t *testing.T) {
	const (
		leakCred      = "SUPERSECRETCRED"
		leakPIN       = "A012345678Z"
		leakPayerName = "Jane Doe"
		leakPayerNum  = "254712345678"
	)

	b2b := validB2BRequest()
	b2b.SecurityCredential = leakCred
	tax := validTaxRequest()
	tax.SecurityCredential = leakCred
	tax.TaxPayerPIN = leakPIN
	reg := validBillRegisterRequest()
	reg.PayerName = leakPayerName
	reg.PayerNumber = leakPayerNum

	cases := []struct {
		name   string
		render func() string
		secret string
	}{
		{"B2BRequest value %v", func() string { return fmt.Sprintf("%v", b2b) }, leakCred},
		{"B2BRequest pointer %+v", func() string { return fmt.Sprintf("%+v", &b2b) }, leakCred},
		{"B2BRequest %#v", func() string { return fmt.Sprintf("%#v", b2b) }, leakCred},
		{"TaxRemittanceRequest %v", func() string { return fmt.Sprintf("%v", tax) }, leakCred},
		{"TaxRemittanceRequest %+v", func() string { return fmt.Sprintf("%+v", tax) }, leakPIN},
		{"TaxRemittanceRequest %#v", func() string { return fmt.Sprintf("%#v", tax) }, leakPIN},
		{"TaxRemittanceRequest pointer", func() string { return fmt.Sprintf("%v", &tax) }, leakPIN},
		{"BillRegisterRequest %v", func() string { return fmt.Sprintf("%v", reg) }, leakPayerName},
		{"BillRegisterRequest %+v", func() string { return fmt.Sprintf("%+v", reg) }, leakPayerNum},
		{"BillRegisterRequest %#v", func() string { return fmt.Sprintf("%#v", reg) }, leakPayerNum},
	}
	for _, tc := range cases {
		rendered := tc.render()
		if strings.Contains(rendered, tc.secret) {
			t.Errorf("%s renders %q in cleartext: %s", tc.name, tc.secret, rendered)
		}
		if !strings.Contains(rendered, "[REDACTED]") {
			t.Errorf("%s carries no [REDACTED] marker: %s", tc.name, rendered)
		}
	}

	// BillRefNumber is business data, NOT PII: it must survive so a support
	// engineer can identify the bill from a log line.
	for _, rendered := range []string{fmt.Sprintf("%v", reg), reg.GoString()} {
		if !strings.Contains(rendered, "INV-1") {
			t.Errorf("BillRefNumber lost from the redacted render: %s", rendered)
		}
	}
	// The callback URL is masked too (the C2B pattern).
	for _, rendered := range []string{fmt.Sprintf("%v", reg), reg.GoString()} {
		if strings.Contains(rendered, "mydomain.com/bill/callback") {
			t.Errorf("CallBackURL leaked: %s", rendered)
		}
	}
	// Non-secret wire fields stay useful.
	if !strings.Contains(fmt.Sprintf("%v", b2b), "BusinessPayBill") {
		t.Errorf("redacted B2B render lost the CommandID: %v", b2b)
	}

	// LogSafe is the documented structured-logging form.
	ls := tax.LogSafe()
	for _, k := range []string{"TaxPayerPIN", "SecurityCredential", "ResultURL", "QueueTimeOutURL"} {
		if ls[k] != "[REDACTED]" {
			t.Errorf("TaxRemittanceRequest.LogSafe did not redact %s: %v", k, ls)
		}
	}
	if ls["CommandID"] != string(CommandTaxRemittance) {
		t.Errorf("TaxRemittanceRequest.LogSafe lost the CommandID: %v", ls)
	}
	bl := reg.LogSafe()
	for _, k := range []string{"CallBackURL", "PayerNumber", "PayerName"} {
		if bl[k] != "[REDACTED]" {
			t.Errorf("BillRegisterRequest.LogSafe did not redact %s: %v", k, bl)
		}
	}
	if bl["BillRefNumber"] != "INV-1" {
		t.Errorf("BillRegisterRequest.LogSafe redacted BillRefNumber: %v", bl)
	}
	bu := BillUpdateRequest{ShortCode: testShortcode, BillRefNumber: "INV-1", PayerNumber: leakPayerNum}
	if s := fmt.Sprintf("%v", bu); strings.Contains(s, leakPayerNum) {
		t.Errorf("BillUpdateRequest renders PayerNumber in cleartext: %s", s)
	}
	if !strings.Contains(fmt.Sprintf("%v", bu), "INV-1") {
		t.Errorf("BillUpdateRequest render lost BillRefNumber: %v", bu)
	}
}

// The new wire enum values must be exactly Safaricom's spellings, and the B2B
// whitelist must hold its two members and nothing else.
func TestNewCommandIDEnumValues(t *testing.T) {
	for _, tc := range []struct {
		name string
		got  CommandID
		want string
	}{
		{"CommandBusinessPayBill", CommandBusinessPayBill, "BusinessPayBill"},
		{"CommandBusinessBuyGoods", CommandBusinessBuyGoods, "BusinessBuyGoods"},
		{"CommandTaxRemittance", CommandTaxRemittance, "TaxRemittance"},
	} {
		if string(tc.got) != tc.want {
			t.Errorf("%s = %q, want %q", tc.name, string(tc.got), tc.want)
		}
	}
	if !b2bCommands[CommandBusinessPayBill] || !b2bCommands[CommandBusinessBuyGoods] {
		t.Error("the B2B CommandID whitelist lost one of its two members")
	}
	if b2bCommands[CommandTaxRemittance] {
		t.Error("TaxRemittance must NOT be accepted on the B2B Express Checkout endpoint")
	}
	if len(b2bCommands) != 2 {
		t.Errorf("B2B whitelist holds %d commands, want exactly 2", len(b2bCommands))
	}
}

// Both B2B commands are accepted end-to-end, not just in the whitelist.
func TestB2BAcceptsBothDocumentedCommands(t *testing.T) {
	c, _, _ := newFamiliesServer(t)
	for _, cmd := range []CommandID{CommandBusinessPayBill, CommandBusinessBuyGoods} {
		r := validB2BRequest()
		r.CommandID = cmd
		if _, err := c.B2BPayment(context.Background(), r); err != nil {
			t.Errorf("B2BPayment with CommandID %s rejected: %v", cmd, err)
		}
	}
}
