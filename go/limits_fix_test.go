package mpesa

// Tests for the configurable transaction-limits system (limits.go). Each test
// documents the property that the hardcoded-ceiling design broke, so a future
// refactor cannot silently reinstate a baked-in number.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// limitsClient builds a Client backed by an httptest server that answers OAuth
// plus every business endpoint, so limit rejections can be distinguished from
// network failures by inspecting whether the request reached the handler.
// The returned counter is shared by every handler and counts OAuth and
// business hits alike.
func limitsClient(t *testing.T, cfg Config) (*Client, *atomic.Int64) {
	t.Helper()
	if cfg.ConsumerKey == "" {
		cfg.ConsumerKey = "test-key"
	}
	if cfg.ConsumerSecret == "" {
		cfg.ConsumerSecret = "test-secret"
	}
	// Sandbox is the zero Environment, so a partially-filled Config always
	// validates; Production must stay Production.
	if cfg.Environment != Production {
		cfg.Environment = Sandbox
	}
	if cfg.Now == nil {
		cfg.Now = func() time.Time { return time.Date(2024, 5, 1, 12, 0, 0, 0, time.UTC) }
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

	// hits is atomic because httptest handlers run on server goroutines while
	// the test goroutine reads the counter — a plain int64 with a local
	// mutex (or none) races under concurrent load.
	var hits atomic.Int64
	record := func() {
		hits.Add(1)
	}
	mux := http.NewServeMux()
	mux.Handle("/oauth/v1/generate", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		record()
		writeJSON(t, w, http.StatusOK, map[string]any{"access_token": "tok-limits", "expires_in": "3599"})
	}))
	for _, p := range []string{stkPushPath, stkQueryPath, b2cPath, c2bRegisterPath, c2bSimulatePath,
		txStatusPath, reversalPath, accountBalancePath, qrCodePath} {
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			record()
			writeJSON(t, w, http.StatusOK, ConversationResponse{ResponseCode: "0"})
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c.baseURL = srv.URL
	return c, &hits
}

// hitCount reads the handler counter with an atomic load: handlers increment
// it from httptest server goroutines while assertions run on the test
// goroutine, so any non-atomic read races (see
// TestDailyTrackingIsExactUnderConcurrency, which must be verified with
// go test -race in CI — this environment has no gcc, so -race cannot run
// here).
func hitCount(hits *atomic.Int64) int64 {
	return hits.Load()
}

func b2cAmount(amount int64) B2CPayoutRequest {
	return B2CPayoutRequest{
		OriginatorConversationID: "a1b2c3d4e5f6a7b8",
		InitiatorName:            "testapi",
		SecurityCredential:       strings.Repeat("x", 344),
		CommandID:                CommandBusinessPayment,
		Amount:                   amount,
		PartyA:                   "600992",
		PartyB:                   "254705912645",
		Remarks:                  "payout",
		QueueTimeOutURL:          "https://mydomain.com/timeout",
		ResultURL:                "https://mydomain.com/result",
	}
}

// stkAmount returns a fully valid STK Push request so the ONLY thing under
// test is the amount ceiling (BusinessShortCode/PartyB default off config
// through the Client, but must be explicit for direct Validate() calls).
func stkAmount(amount int64) STKPushRequest {
	r := validSTKPushRequest()
	r.Amount = amount
	r.BusinessShortCode = testShortcode
	r.PartyB = testShortcode
	return r
}

func qrAmount(amount int64) QRCodeRequest {
	return QRCodeRequest{MerchantName: "TEST", RefNo: "ref", Amount: amount, TrxCode: QRTrxBuyGoods, CPI: "174379", Size: "300"}
}

func c2bAmount(amount int64) C2BSimulateRequest {
	return C2BSimulateRequest{CommandID: TransactionTypePayBillOnline, Amount: amount, Msisdn: "0712345678", BillRefNumber: "acct-1"}
}

func reversalAmount(amount int64) ReversalRequest {
	return ReversalRequest{
		Initiator: "i", SecurityCredential: "c", TransactionID: "NLJ7RT61SV", Amount: amount,
		ReceiverParty: "600992", Remarks: "wrong deposit",
		ResultURL: "https://a.com/r", QueueTimeOutURL: "https://a.com/t",
	}
}

// --- comparison helpers -----------------------------------------------------

// ServiceLimits fields are *int64, so a struct comparison would compare
// pointer identity instead of the policy it expresses.
func sameCeiling(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func sameServiceLimits(a, b ServiceLimits) bool {
	return sameCeiling(a.MaxPerTransaction, b.MaxPerTransaction) &&
		sameCeiling(a.MaxPerDay, b.MaxPerDay)
}

func sameTransactionLimits(a, b TransactionLimits) bool {
	return sameServiceLimits(a.STK, b.STK) && sameServiceLimits(a.C2B, b.C2B) &&
		sameServiceLimits(a.B2C, b.B2C) && sameServiceLimits(a.Default, b.Default)
}

func ceilingOf(s ServiceLimits, m *int64) string {
	if m == nil {
		return "<nil>"
	}
	return strconvItoa(*m)
}

func strconvItoa(v int64) string {
	return strconv.FormatInt(v, 10)
}

// everyFieldSet reports whether both ceilings of s are non-nil, i.e. s is
// fully materialized and carries no inherited field.
func everyFieldSet(s ServiceLimits) bool {
	return s.MaxPerTransaction != nil && s.MaxPerDay != nil
}

// allFieldsMaterialized checks a whole TransactionLimits.
func allFieldsMaterialized(l TransactionLimits) error {
	for name, svc := range map[string]ServiceLimits{
		"STK": l.STK, "C2B": l.C2B, "B2C": l.B2C, "Default": l.Default,
	} {
		if !everyFieldSet(svc) {
			return errors.New(name + " still carries a nil (unset) field: " +
				"txn=" + ceilingOf(svc, svc.MaxPerTransaction) +
				" day=" + ceilingOf(svc, svc.MaxPerDay))
		}
	}
	return nil
}

// Defaults must be the documented Safaricom baseline, per service, and every
// field must be MATERIALIZED — the baseline is what a nil field inherits.
func TestDefaultTransactionLimitsArePerService(t *testing.T) {
	d := DefaultTransactionLimits()
	want := []struct {
		name    string
		got     ServiceLimits
		wantTxn int64
		wantDay int64
	}{
		{"STK", d.STK, 250_000, 500_000},
		{"C2B", d.C2B, 250_000, 500_000},
		// B2C defaults to the standard Safaricom cap (same ceilings as STK
		// here); Safaricom-approved higher tiers are raised via Config.Limits.
		{"B2C", d.B2C, 250_000, 500_000},
		{"Default", d.Default, 250_000, 500_000},
	}
	for _, tc := range want {
		if tc.got.MaxPerTransaction == nil || *tc.got.MaxPerTransaction != tc.wantTxn {
			t.Errorf("%s.MaxPerTransaction = %s, want %d", tc.name,
				ceilingOf(tc.got, tc.got.MaxPerTransaction), tc.wantTxn)
		}
		if tc.got.MaxPerDay == nil || *tc.got.MaxPerDay != tc.wantDay {
			t.Errorf("%s.MaxPerDay = %s, want %d", tc.name,
				ceilingOf(tc.got, tc.got.MaxPerDay), tc.wantDay)
		}
	}
	if err := allFieldsMaterialized(d); err != nil {
		t.Errorf("DefaultTransactionLimits is not fully materialized: %v", err)
	}
	// limitsFor must route each enumerated service to its own entry and
	// everything else (Reversal, TransactionStatus, QR) to Default.
	if got := d.limitsFor(ServiceSTK); !sameServiceLimits(got, d.STK) {
		t.Errorf("STK entry not routed: %+v", got)
	}
	if got := d.limitsFor(ServiceB2C); !sameServiceLimits(got, d.B2C) {
		t.Errorf("B2C entry not routed: %+v", got)
	}
	if got := d.limitsFor(ServiceDefault); !sameServiceLimits(got, d.Default) {
		t.Errorf("Default entry not used for un-enumerated services: %+v", got)
	}
}

// --- (a) A partial config inherits ALL defaults -----------------------------

// &TransactionLimits{} is the regression case: under the old value-typed
// ServiceLimits every field read 0 == unlimited, so a caller who configured
// nothing silently disabled every ceiling in the SDK.
func TestPartialEmptyConfigInheritsAllDefaults(t *testing.T) {
	c, _ := limitsClient(t, Config{Limits: &TransactionLimits{}})
	if !sameTransactionLimits(c.limits, DefaultTransactionLimits()) {
		t.Fatalf("empty &TransactionLimits{} resolved to %+v, want the full default baseline", c.limits)
	}
	// End-to-end: the baseline ceiling still bites through the Client.
	if _, err := c.STKPush(context.Background(), stkAmount(300_000)); err == nil {
		t.Error("empty Config.Limits disabled the STK ceiling, want the 250000 baseline")
	}
	// A partially-filled entry behaves the same way: setting one field must
	// not zero out the other.
	c2, _ := limitsClient(t, Config{Limits: &TransactionLimits{STK: ServiceLimits{MaxPerTransaction: Limit(1_000_000)}}})
	stk := c2.limits.STK
	if stk.MaxPerDay == nil || *stk.MaxPerDay != 500_000 {
		t.Errorf("setting STK.MaxPerTransaction left MaxPerDay = %s, want it to inherit 500000",
			ceilingOf(stk, stk.MaxPerDay))
	}
	// The field that WAS set must survive the merge.
	if stk.MaxPerTransaction == nil || *stk.MaxPerTransaction != 1_000_000 {
		t.Errorf("explicit STK.MaxPerTransaction did not survive the merge: %s",
			ceilingOf(stk, stk.MaxPerTransaction))
	}
	// A whole untouched entry resolves to the baseline untouched.
	if got := c2.limits.B2C; !sameServiceLimits(got, DefaultTransactionLimits().B2C) {
		t.Errorf("an untouched B2C entry resolved to %+v, want the baseline", got)
	}
}

// --- (b) Override one service; the others still enforce ---------------------

// The exact regression case: raising B2C to 700k must NOT disarm the STK
// ceiling at 250k.
func TestPartialServiceOverrideKeepsOtherCeilings(t *testing.T) {
	c, _ := limitsClient(t, Config{
		Limits: &TransactionLimits{
			B2C: ServiceLimits{MaxPerTransaction: Limit(700_000)},
		},
	})
	ctx := context.Background()
	// B2C is raised: 700k now passes, 700001 fails.
	if _, err := c.B2CPayout(ctx, b2cAmount(700_000)); err != nil {
		t.Errorf("B2C 700000 rejected with a 700000 override: %v", err)
	}
	above := b2cAmount(700_001)
	if err := above.ValidateWithLimits(c.limits); err == nil {
		t.Error("B2C 700001 accepted, want rejection one past the override")
	}
	// STK is UNTOUCHED and must still enforce the 250000 baseline.
	if _, err := c.STKPush(ctx, stkAmount(300_000)); err == nil {
		t.Fatal("raising B2C silently disabled the STK ceiling, want 250000 enforcement")
	}
	// C2B and Default are untouched too.
	if _, err := c.C2BSimulate(ctx, c2bAmount(300_000)); err == nil {
		t.Error("raising B2C silently disabled the C2B ceiling, want 250000 enforcement")
	}
	if _, err := c.Reversal(ctx, reversalAmount(300_000)); err == nil {
		t.Error("raising B2C silently disabled the Default ceiling, want 250000 enforcement")
	}
}

// STK/C2B keep their own ceilings while Reversal/QR fall back to Default;
// B2C defaults to the standard Safaricom cap (250000 KES), so 300000 is
// rejected unless the merchant's approved tier is configured via Config.Limits.
func TestPerServiceCeilingsEnforcedAgainstRealRequests(t *testing.T) {
	c, _ := limitsClient(t, Config{})
	ctx := context.Background()

	if _, err := c.STKPush(ctx, stkAmount(300_000)); err == nil {
		t.Error("STK 300000 accepted, want rejection at the 250000 default ceiling")
	}
	if _, err := c.B2CPayout(ctx, b2cAmount(300_000)); err == nil {
		t.Error("B2C 300000 accepted, want rejection at the 250000 default ceiling")
	}
	if _, err := c.C2BSimulate(ctx, c2bAmount(300_000)); err == nil {
		t.Error("C2B 300000 accepted, want rejection at the 250000 ceiling")
	}
	if _, err := c.Reversal(ctx, reversalAmount(300_000)); err == nil {
		t.Error("Reversal 300000 accepted, want rejection at the Default ceiling")
	}
	if _, err := c.GenerateQRCode(ctx, qrAmount(300_000)); err == nil {
		t.Error("QR 300000 accepted, want rejection at the Default ceiling")
	}
	// Override escape hatch: an explicitly configured higher B2C tier accepts
	// the same 300000 payout the default rejects.
	co, hits := limitsClient(t, Config{Limits: &TransactionLimits{
		B2C: ServiceLimits{MaxPerTransaction: Limit(500_000)},
	}})
	if _, err := co.B2CPayout(ctx, b2cAmount(300_000)); err != nil {
		t.Errorf("B2C 300000 rejected with an explicit 500000 override: %v", err)
	}
	if hitCount(hits) == 0 {
		t.Fatal("no network traffic at all: the override-accepted B2C payout must have dispatched")
	}
}

// The error must name the service, the ceiling and how to override it.
func TestLimitErrorNamesServiceCeilingAndConfigPath(t *testing.T) {
	r := stkAmount(300_000)
	err := r.ValidateWithLimits(DefaultTransactionLimits())
	if err == nil {
		t.Fatal("expected limit rejection")
	}
	var le *LimitError
	if !errors.As(err, &le) {
		t.Fatalf("error = %T (%v), want *LimitError", err, err)
	}
	want := "mpesa: STK Push Amount 300000 exceeds configured max 250000 KES " +
		"(set Config.Limits.STK.MaxPerTransaction, or 0 for unlimited)"
	if err.Error() != want {
		t.Fatalf("message mismatch:\n got %q\nwant %q", err.Error(), want)
	}
	if le.Service != "STK Push" || le.Kind != "MaxPerTransaction" || le.Amount != 300_000 || le.Max != 250_000 {
		t.Fatalf("LimitError fields = %+v", le)
	}
}

// An override must be able to both RAISE and LOWER a ceiling.
func TestLimitOverridesRaiseAndLowerCeilings(t *testing.T) {
	high := TransactionLimits{STK: ServiceLimits{MaxPerTransaction: Limit(1_000_000)}}
	r := stkAmount(300_000)
	if err := r.ValidateWithLimits(high); err != nil {
		t.Errorf("custom limit rejected 300000: %v (override must raise the ceiling)", err)
	}
	low := TransactionLimits{STK: ServiceLimits{MaxPerTransaction: Limit(100)}}
	if err := r.ValidateWithLimits(low); err == nil {
		t.Error("custom limit accepted 300000, want rejection at the lowered ceiling")
	}
	// Config.Limits must reach the Client and be used end-to-end.
	c, hits := limitsClient(t, Config{Limits: &TransactionLimits{STK: ServiceLimits{MaxPerTransaction: Limit(1_000_000)}}})
	if _, err := c.STKPush(context.Background(), stkAmount(300_000)); err != nil {
		t.Errorf("Client with raised ceiling rejected 300000: %v", err)
	}
	if hitCount(hits) == 0 {
		t.Error("raised-ceiling request never dispatched")
	}
}

// --- (c) An EXPLICIT 0 or negative means unlimited, for that field only ------

// Limit(0) and Limit(-1) disable a ceiling; a merchant on a private unlimited
// tier must be able to express that. Crucially it is PER FIELD: disabling
// STK's per-transaction ceiling must not touch anything else.
func TestExplicitZeroDisablesOnlyThatCeiling(t *testing.T) {
	for _, tc := range []struct {
		name string
		val  int64
	}{
		{"Limit(0) is unlimited", 0},
		{"Limit(-1) is unlimited", -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, hits := limitsClient(t, Config{
				Limits: &TransactionLimits{
					STK: ServiceLimits{MaxPerTransaction: Limit(tc.val)},
				},
				TrackDaily: true,
			})
			ctx := context.Background()
			// The overridden ceiling is gone. 400000 clears the 250000
			// per-transaction ceiling AND the 500000 daily default, so only
			// the per-transaction gate is under test here.
			if _, err := c.STKPush(ctx, stkAmount(400_000)); err != nil {
				t.Fatalf("explicit %d rejected a 400000 STK push: %v", tc.val, err)
			}
			if hitCount(hits) == 0 {
				t.Fatal("unlimited STK request never dispatched")
			}
			// Every OTHER ceiling still applies.
			if _, err := c.B2CPayout(ctx, b2cAmount(600_000)); err == nil {
				t.Error("disabling the STK ceiling also disabled B2C's 250000 ceiling")
			}
			if _, err := c.C2BSimulate(ctx, c2bAmount(300_000)); err == nil {
				t.Error("disabling the STK ceiling also disabled the C2B ceiling")
			}
			if _, err := c.Reversal(ctx, reversalAmount(300_000)); err == nil {
				t.Error("disabling the STK ceiling also disabled the Default ceiling")
			}
		})
	}
}

// --- (e) An explicit MaxPerDay of 0 disables ONLY the daily ceiling ----------

func TestExplicitZeroMaxPerDayKeepsPerTransactionCeiling(t *testing.T) {
	c, _ := limitsClient(t, Config{
		Limits: &TransactionLimits{
			STK: ServiceLimits{MaxPerDay: Limit(0)},
		},
		TrackDaily: true,
	})
	ctx := context.Background()
	// Daily accumulation for STK is disabled: far more than the 500000
	// baseline daily total still goes through.
	for i := 0; i < 6; i++ {
		if _, err := c.STKPush(ctx, stkAmount(200_000)); err != nil {
			t.Fatalf("explicit MaxPerDay=0 still enforced a daily ceiling on call %d: %v", i, err)
		}
	}
	// The per-transaction DEFAULT still applies.
	if _, err := c.STKPush(ctx, stkAmount(300_000)); err == nil {
		t.Fatal("explicit MaxPerDay=0 also disabled the 250000 per-transaction ceiling")
	}
}

// --- (e, mirrored) An explicit MaxPerTransaction of 0 keeps the daily one ----

func TestExplicitZeroMaxPerTransactionKeepsDailyCeiling(t *testing.T) {
	c, _ := limitsClient(t, Config{
		Limits: &TransactionLimits{
			STK: ServiceLimits{
				MaxPerTransaction: Limit(0), // unlimited per transaction
				MaxPerDay:         Limit(0), // ...and the same for the day
			},
			B2C: ServiceLimits{MaxPerDay: Limit(0)}, // B2C day only
		},
		TrackDaily: true,
	})
	if _, err := c.STKPush(context.Background(), stkAmount(900_000_000)); err != nil {
		t.Fatalf("explicit unlimited STK rejected an absurd amount: %v", err)
	}
	// B2C's own daily ceiling is off but its per-transaction default is on.
	if _, err := c.B2CPayout(context.Background(), b2cAmount(600_000)); err == nil {
		t.Error("B2C per-transaction default was disabled by an unrelated STK override")
	}
}

// Daily accumulation must reject once the day's total crosses the ceiling,
// must be keyed to the NAIROBI day, and must NOT be observable at all when
// TrackDaily is off (the default).
func TestDailyLimitEnforcedOnlyWhenTracked(t *testing.T) {
	now := time.Date(2024, 5, 1, 12, 0, 0, 0, time.UTC) // 15:00 Nairobi
	if got := nairobiDay(now); got != "2024-05-01" {
		t.Fatalf("nairobiDay = %q, want 2024-05-01", got)
	}

	off, _ := limitsClient(t, Config{Now: func() time.Time { return now }})
	for i := 0; i < 6; i++ {
		if _, err := off.STKPush(context.Background(), stkAmount(200_000)); err != nil {
			t.Fatalf("TrackDaily=false rejected call %d: %v (accumulation must be opt-in)", i, err)
		}
	}

	on, hits := limitsClient(t, Config{
		Now: func() time.Time { return now },
		Limits: &TransactionLimits{
			STK: ServiceLimits{MaxPerTransaction: Limit(900_000), MaxPerDay: Limit(500_000)},
		},
		TrackDaily: true,
	})
	ctx := context.Background()
	// 2 x 250000 = 500000 fits exactly; the third crosses the ceiling.
	for i := 0; i < 2; i++ {
		if _, err := on.STKPush(ctx, stkAmount(250_000)); err != nil {
			t.Fatalf("call %d within daily ceiling rejected: %v", i, err)
		}
	}
	_, err := on.STKPush(ctx, stkAmount(250_000))
	if err == nil {
		t.Fatal("third 250000 accepted past the 500000 daily ceiling, want rejection")
	}
	var le *LimitError
	if !errors.As(err, &le) {
		t.Fatalf("err = %T (%v), want *LimitError", err, err)
	}
	if le.Kind != "MaxPerDay" {
		t.Fatalf("Kind = %q, want MaxPerDay", le.Kind)
	}
	want := "mpesa: STK Push daily total 750000 exceeds configured max 500000 KES (set Config.Limits.STK.MaxPerDay, or 0 for unlimited)"
	if err.Error() != want {
		t.Fatalf("message mismatch:\n got %q\nwant %q", err.Error(), want)
	}
	// The rejected request must never reach the gateway: only the OAuth fetch
	// plus the two accepted pushes (3 hits) may have occurred.
	if got := hitCount(hits); got != 3 {
		t.Fatalf("network hits = %d, want 3 (oauth + 2 accepted pushes); a rejected request must not dispatch", got)
	}
}

// The day boundary is Nairobi midnight (21:00 UTC), so the accumulator rolls
// there — not at UTC midnight, which would under-count the last three hours.
func TestDailyLedgerRollsAtNairobiMidnight(t *testing.T) {
	// 20:59:59 UTC on May 1 is 23:59:59 in Nairobi — still the May 1 trading
	// day. One second later is 00:00:00 May 2, because Nairobi midnight is
	// 21:00 UTC the previous day (UTC+3, no DST).
	now := time.Date(2024, 5, 1, 20, 59, 59, 0, time.UTC)
	if got := nairobiDay(now); got != "2024-05-01" {
		t.Fatalf("nairobiDay(boundary-1s) = %q, want 2024-05-01", got)
	}
	c, _ := limitsClient(t, Config{
		Now: func() time.Time { return now },
		Limits: &TransactionLimits{
			STK: ServiceLimits{MaxPerTransaction: Limit(900_000), MaxPerDay: Limit(250_000)},
		},
		TrackDaily: true,
	})
	ctx := context.Background()
	if _, err := c.STKPush(ctx, stkAmount(250_000)); err != nil {
		t.Fatalf("first push within the day: %v", err)
	}
	if _, err := c.STKPush(ctx, stkAmount(1)); err == nil {
		t.Fatal("second push within the same Nairobi day accepted, want daily rejection")
	}
	// One second later is May 2 in Nairobi, so the ledger must reset.
	c.cfg.Now = func() time.Time { return now.Add(time.Second) }
	if _, err := c.STKPush(ctx, stkAmount(250_000)); err != nil {
		t.Fatalf("push after Nairobi midnight rejected: %v (ledger did not roll over)", err)
	}
	// Boundary assertions in both directions.
	if got := nairobiDay(time.Date(2024, 5, 1, 20, 59, 59, 999999999, time.UTC)); got != "2024-05-01" {
		t.Fatalf("nairobiDay(pre-midnight) = %q, want 2024-05-01", got)
	}
	if got := nairobiDay(time.Date(2024, 5, 1, 21, 0, 0, 0, time.UTC)); got != "2024-05-02" {
		t.Fatalf("nairobiDay(midnight) = %q, want 2024-05-02", got)
	}
	// A UTC-midnight boundary would roll THREE HOURS EARLY: at 21:00 UTC the
	// Nairobi day is 00:00 of the NEXT date, so a UTC-keyed ledger would
	// already have reset here.
	if got := nairobiDay(time.Date(2024, 5, 1, 21, 0, 0, 0, time.UTC)); got == "2024-05-01" {
		t.Fatal("ledger keyed on the UTC day, want the Nairobi day")
	}
}

// Concurrent tracking must be EXACT: callers cannot jointly exceed the ceiling
// because the check and the increment share one mutex acquisition.
// Run under -race.
func TestDailyTrackingIsExactUnderConcurrency(t *testing.T) {
	now := time.Date(2024, 5, 1, 6, 0, 0, 0, time.UTC)
	c, hits := limitsClient(t, Config{
		Now: func() time.Time { return now },
		Limits: &TransactionLimits{
			STK: ServiceLimits{MaxPerTransaction: Limit(900_000), MaxPerDay: Limit(100_000)},
		},
		TrackDaily: true,
	})
	const n = 50
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make(chan error, n)
	var mu sync.Mutex
	var accepted int64
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := c.STKPush(context.Background(), stkAmount(30_000))
			mu.Lock()
			if err == nil {
				accepted++
			}
			mu.Unlock()
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)

	var rejects int
	for err := range errs {
		if err == nil {
			continue
		}
		var le *LimitError
		if !errors.As(err, &le) {
			t.Errorf("non-limit error from a concurrent push: %v", err)
			continue
		}
		if le.Kind != "MaxPerDay" {
			t.Errorf("Kind = %q, want MaxPerDay", le.Kind)
		}
		rejects++
	}
	// 100000 / 30000 = 3 accepted exactly; a 4th would be 120000 > 100000.
	if accepted != 3 {
		t.Fatalf("accepted = %d, want exactly 3 (ceiling 100000 / 30000 per call)", accepted)
	}
	if rejects != n-3 {
		t.Fatalf("rejected = %d, want %d", rejects, n-3)
	}
	// Only the accepted pushes plus the single OAuth fetch may hit the wire.
	if got := hitCount(hits); got != 4 {
		t.Fatalf("network hits = %d, want 4 (1 oauth + 3 accepted)", got)
	}
}

// Per-service ledgers are INDEPENDENT: exhausting one service's daily ceiling
// must not block any other service.
func TestDailyLedgersAreIndependentPerService(t *testing.T) {
	now := time.Date(2024, 5, 1, 6, 0, 0, 0, time.UTC)
	c, _ := limitsClient(t, Config{
		Now: func() time.Time { return now },
		Limits: &TransactionLimits{
			STK:     ServiceLimits{MaxPerTransaction: Limit(900_000), MaxPerDay: Limit(100_000)},
			Default: ServiceLimits{MaxPerTransaction: Limit(900_000), MaxPerDay: Limit(100_000)},
			B2C:     ServiceLimits{MaxPerTransaction: Limit(900_000), MaxPerDay: Limit(100_000)},
		},
		TrackDaily: true,
	})
	ctx := context.Background()
	// Exhaust STK: 3 x 30000 = 90000, the 4th crosses 100000.
	for i := 0; i < 3; i++ {
		if _, err := c.STKPush(ctx, stkAmount(30_000)); err != nil {
			t.Fatalf("STK call %d rejected: %v", i, err)
		}
	}
	if _, err := c.STKPush(ctx, stkAmount(30_000)); err == nil {
		t.Fatal("STK daily ceiling not enforced, want rejection")
	}
	// The Default-capped service must be untouched.
	if _, err := c.Reversal(ctx, reversalAmount(30_000)); err != nil {
		t.Fatalf("Reversal blocked by another service's ledger: %v", err)
	}
	// And so must B2C.
	if _, err := c.B2CPayout(ctx, b2cAmount(30_000)); err != nil {
		t.Fatalf("B2C blocked by another service's ledger: %v", err)
	}
}

// B2C's documented MINIMUM (10 KES) is preserved; the maximum is the standard
// 250000 KES default ceiling (exact edge accepted, one past rejected).
func TestB2CMinimumPreservedAndMaximumCorrected(t *testing.T) {
	// Each fixture is bound to a variable because Validate has a pointer
	// receiver and Go cannot take the address of a function return value.
	below := b2cAmount(9)
	if err := below.ValidateWithLimits(DefaultTransactionLimits()); err == nil || !strings.Contains(err.Error(), "minimum") {
		t.Fatalf("B2C 9 KES err = %v, want the documented minimum rejection", err)
	}
	atMin := b2cAmount(10)
	if err := atMin.ValidateWithLimits(DefaultTransactionLimits()); err != nil {
		t.Errorf("B2C 10 KES rejected: %v", err)
	}
	// 300000 exceeds the standard 250000 default: it is rejected unless the
	// merchant's Safaricom-approved tier is configured via Config.Limits.
	mid := b2cAmount(300_000)
	if err := mid.ValidateWithLimits(DefaultTransactionLimits()); err == nil {
		t.Error("B2C 300000 accepted, want rejection above the 250000 default ceiling")
	}
	above := b2cAmount(250_001)
	if err := above.ValidateWithLimits(DefaultTransactionLimits()); err == nil {
		t.Error("B2C 250001 accepted, want rejection one past the default ceiling")
	}
	atMax := b2cAmount(250_000)
	if err := atMax.ValidateWithLimits(DefaultTransactionLimits()); err != nil {
		t.Errorf("B2C 250000 rejected: %v, want acceptance exactly at the default ceiling", err)
	}
	// Override escape hatch: an explicitly configured higher tier accepts
	// payouts above the default.
	raised := TransactionLimits{B2C: ServiceLimits{MaxPerTransaction: Limit(500_000)}}
	if err := mid.ValidateWithLimits(raised); err != nil {
		t.Errorf("B2C 300000 rejected with an explicit 500000 override: %v", err)
	}
	// Validate() with no explicit limits must keep the same effective bounds.
	midPlain := b2cAmount(300_000)
	if err := midPlain.Validate(); err == nil {
		t.Error("Validate() accepted B2C 300000, want default-ceiling rejection")
	}
	abovePlain := b2cAmount(250_001)
	if err := abovePlain.Validate(); err == nil {
		t.Error("Validate() accepted B2C 250001, want default-ceiling rejection")
	}
	atMaxPlain := b2cAmount(250_000)
	if err := atMaxPlain.Validate(); err != nil {
		t.Errorf("Validate() rejected B2C 250000: %v, want acceptance exactly at the default ceiling", err)
	}
}

// Validate() (defaults) and ValidateWithLimits(defaults) must agree, and an
// unlimited policy must accept whatever the defaults reject.
func TestValidateDelegatesToLimitsAwareVariant(t *testing.T) {
	def := DefaultTransactionLimits()

	stk := stkAmount(300_000)
	stkPlain, stkLimited := stk.Validate(), stk.ValidateWithLimits(def)
	if (stkPlain == nil) != (stkLimited == nil) {
		t.Fatalf("STK: Validate() = %v, ValidateWithLimits(defaults) = %v", stkPlain, stkLimited)
	}

	b2c := b2cAmount(200_000)
	if b2c.Validate() != nil || b2c.ValidateWithLimits(def) != nil {
		t.Errorf("B2C: Validate() = %v, ValidateWithLimits(defaults) = %v (200000 must pass both)", b2c.Validate(), b2c.ValidateWithLimits(def))
	}
	b2cBad := b2cAmount(300_000)
	if b2cBad.Validate() == nil || b2cBad.ValidateWithLimits(def) == nil {
		t.Error("B2C: Validate() and ValidateWithLimits(defaults) accepted 300000, want default-ceiling rejection from both")
	}

	c2b := c2bAmount(300_000)
	c2bPlain, c2bLimited := c2b.Validate(), c2b.ValidateWithLimits(def)
	if (c2bPlain == nil) != (c2bLimited == nil) {
		t.Fatalf("C2B: Validate() = %v, ValidateWithLimits(defaults) = %v", c2bPlain, c2bLimited)
	}

	rev := reversalAmount(300_000)
	revPlain, revLimited := rev.Validate(), rev.ValidateWithLimits(def)
	if (revPlain == nil) != (revLimited == nil) {
		t.Fatalf("Reversal: Validate() = %v, ValidateWithLimits(defaults) = %v", revPlain, revLimited)
	}

	qr := qrAmount(300_000)
	qrPlain, qrLimited := qr.Validate(), qr.ValidateWithLimits(def)
	if (qrPlain == nil) != (qrLimited == nil) {
		t.Fatalf("QR: Validate() = %v, ValidateWithLimits(defaults) = %v", qrPlain, qrLimited)
	}

	// Every type that carries an Amount must gain a limits-aware entry point;
	// an unlimited policy must accept what the defaults reject.
	if stk.ValidateWithLimits(TransactionLimits{}) != nil {
		t.Errorf("all-unlimited TransactionLimits still rejects STK 300000: %v", stk.ValidateWithLimits(TransactionLimits{}))
	}
	if b2cBad.ValidateWithLimits(TransactionLimits{}) != nil {
		t.Errorf("all-unlimited TransactionLimits still rejects B2C 300000: %v", b2cBad.ValidateWithLimits(TransactionLimits{}))
	}
	if rev.ValidateWithLimits(TransactionLimits{}) != nil {
		t.Errorf("all-unlimited TransactionLimits still rejects Reversal 300000: %v", rev.ValidateWithLimits(TransactionLimits{}))
	}
	if c2b.ValidateWithLimits(TransactionLimits{}) != nil {
		t.Errorf("all-unlimited TransactionLimits still rejects C2B 300000: %v", c2b.ValidateWithLimits(TransactionLimits{}))
	}
	if qr.ValidateWithLimits(TransactionLimits{}) != nil {
		t.Errorf("all-unlimited TransactionLimits still rejects QR 300000: %v", qr.ValidateWithLimits(TransactionLimits{}))
	}
}

// A nil Config.Limits (the zero-value pointer field) must be safe and fall
// back to the baseline defaults rather than panicking or freeing all traffic.
func TestNilConfigLimitsIsSafe(t *testing.T) {
	c, _ := limitsClient(t, Config{Limits: nil})
	if !sameTransactionLimits(c.limits, DefaultTransactionLimits()) {
		t.Fatalf("Client.limits = %+v, want the baseline defaults", c.limits)
	}
	if _, err := c.STKPush(context.Background(), stkAmount(300_000)); err == nil {
		t.Error("nil Limits disabled the default ceiling, want the 250000 baseline to apply")
	}
	if _, err := c.STKPush(context.Background(), stkAmount(200_000)); err != nil {
		t.Errorf("nil Limits rejected a 200000 push within the default ceiling: %v", err)
	}
}

// --- (f) Resolved limits are frozen after construction -----------------------

// The daily ledger reads the client's limits with no locking of its own, so
// the resolved set must be immune to any later mutation of the caller's
// Config.Limits — including through the *int64 it pointed at. This is the
// property that lets a Client be shared by concurrent goroutines without the
// ledger racing a config write.
func TestResolvedLimitsFrozenAfterConstruction(t *testing.T) {
	b2cMax := int64(700_000)
	stkDay := int64(5_000_000)
	user := &TransactionLimits{
		B2C: ServiceLimits{MaxPerTransaction: &b2cMax},
		STK: ServiceLimits{MaxPerDay: &stkDay},
	}
	c, _ := limitsClient(t, Config{Limits: user})

	// Snapshot the resolved policy by VALUE. A shallow struct copy would
	// share the *int64 fields with c.limits and could not detect a pointee
	// mutation, so the assertion below would pass even with aliasing.
	snap := struct {
		stkTxn, stkDay, c2bTxn, c2bDay int64
		b2cTxn, b2cDay, defTxn, defDay int64
	}{
		stkTxn: *c.limits.STK.MaxPerTransaction, stkDay: *c.limits.STK.MaxPerDay,
		c2bTxn: *c.limits.C2B.MaxPerTransaction, c2bDay: *c.limits.C2B.MaxPerDay,
		b2cTxn: *c.limits.B2C.MaxPerTransaction, b2cDay: *c.limits.B2C.MaxPerDay,
		defTxn: *c.limits.Default.MaxPerTransaction, defDay: *c.limits.Default.MaxPerDay,
	}
	if err := allFieldsMaterialized(c.limits); err != nil {
		t.Fatalf("resolved limits are not fully materialized: %v", err)
	}
	// Sanity: the overrides really did land, and the untouched STK
	// per-transaction ceiling inherited the baseline.
	if snap.b2cTxn != 700_000 || snap.stkDay != 5_000_000 || snap.stkTxn != 250_000 {
		t.Fatalf("merge did not land as expected: %+v", snap)
	}

	// Now mutate the caller's struct AND the values it pointed at.
	b2cMax = 999_999_999
	stkDay = 1
	user.STK = ServiceLimits{MaxPerTransaction: Limit(123)}
	user.C2B = ServiceLimits{MaxPerTransaction: Limit(456)}
	user.Default = ServiceLimits{MaxPerTransaction: Limit(789)}

	now := c.limits
	if *now.STK.MaxPerTransaction != snap.stkTxn || *now.STK.MaxPerDay != snap.stkDay ||
		*now.C2B.MaxPerTransaction != snap.c2bTxn || *now.C2B.MaxPerDay != snap.c2bDay ||
		*now.B2C.MaxPerTransaction != snap.b2cTxn || *now.B2C.MaxPerDay != snap.b2cDay ||
		*now.Default.MaxPerTransaction != snap.defTxn || *now.Default.MaxPerDay != snap.defDay {
		t.Fatalf("resolved limits moved after construction:\n got  %+v\nwant %+v", now, snap)
	}
	// Concretely: the live ceiling is still 700000, so 700001 is rejected.
	above := b2cAmount(700_001)
	if err := above.ValidateWithLimits(c.limits); err == nil {
		t.Fatal("B2C ceiling moved after construction, want a 700001 rejection")
	}
	// A second Client built from the SAME (now mutated) config must pick up the
	// new values — proving it is the COPY that froze, not a lost pointer.
	c2, _ := limitsClient(t, Config{Limits: user})
	if got := c2.limits.STK; got.MaxPerTransaction == nil || *got.MaxPerTransaction != 123 {
		t.Errorf("second Client picked up the wrong STK override: %s", ceilingOf(got, got.MaxPerTransaction))
	}
}
