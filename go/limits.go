// Transaction limits: configurable per-service amount ceilings.
//
// WHY CONFIGURABLE (the bug this replaces): B2C's ceiling used to be the
// literal 250000 KES baked into B2CPayoutRequest.Validate. Safaricom raises
// a merchant's tier dynamically — once a merchant is upgraded, a hardcoded
// ceiling rejects legitimate traffic that the gateway would happily accept,
// and the only "fix" was a new SDK release. The default stays the standard
// Safaricom cap (250000 KES per transaction, 500000 KES per day,
// docs/apis/b2c.md); Safaricom-approved higher tiers are raised explicitly
// via Config.Limits.
//
// HYBRID CONFIGURABLE DEFAULTS: the SDK ships DefaultTransactionLimits and a
// developer overrides SPECIFIC VALUES on top of it. Config.Limits is a partial
// overlay, never a replacement — every field left nil inherits the baseline,
// so a caller who configures only B2C cannot silently disarm the STK/C2B/
// Default ceilings it never mentioned (the failure mode of the previous
// "partial struct = unlimited" design). Disabling a ceiling is also possible
// and must be EXPLICIT: set the field to 0 or a negative value, which is the
// only spell for "no client-side cap" for a merchant on an unlimited tier.
//
// The merge is resolved exactly once, at NewClient, into a fully materialized
// TransactionLimits owned by the Client. Nothing re-resolves per request, and
// the resolved copy never aliases caller-owned memory, so a live client's
// ceilings cannot move under it — which is what lets the daily ledger read
// them without any locking beyond its own accumulator mutex.

package mpesa

import (
	"strconv"
	"sync"
	"time"
)

// ServiceLimits bounds one Daraja service.
//
// Each field is a *int64 with THREE states, not two:
//
//	nil              INHERIT the Safaricom default for this field. This is
//	                 what a developer gets who overrides one service and
//	                 leaves the rest alone, so a partial config can never
//	                 silently disable a ceiling it never mentioned.
//	0 or negative    UNLIMITED. Merchants on a private/unlimited tier must be
//	                 able to express "no client-side cap" explicitly.
//	positive         The ceiling.
//
// Nil vs explicit-zero is the whole point of the pointer: the alternative —
// a plain int64 where 0 means either "unset" or "unlimited" — forces a choice
// between two wrong behaviours, and the original choice (0 = unset = inherit)
// disabled every ceiling a caller did not touch, while the other (0 =
// unlimited) silently disarmed a guard on a typo. Use Limit() to build one.
type ServiceLimits struct {
	MaxPerTransaction *int64
	MaxPerDay         *int64
}

// Limit returns a *int64 holding v, for building ServiceLimits values:
//
//	Limit(700_000)   → ceiling of 700000 KES
//	Limit(0)         → unlimited
//
// Without a helper every ServiceLimits literal needs a throwaway variable,
// because &700000 is not a valid Go expression — and that friction is what
// pushes callers toward plain int64 fields, which cannot express nil-vs-0.
func Limit(v int64) *int64 { return &v }

// ceiling returns the enforced ceiling: nil, 0 and every negative value all
// map to UNLIMITED (0 is what a typo produces, and "reject everything" would
// brick an integration over a mistake). ONE resolution rule, shared by the
// per-transaction gate and the daily ledger, so no two guards can disagree.
func (s ServiceLimits) ceiling(max *int64) (int64, bool) {
	if max == nil || *max <= 0 {
		return 0, false // unlimited
	}
	return *max, true
}

// TransactionLimits holds per-service ceilings. Reversal and QR have their
// own entries; Default applies to services without a dedicated entry
// (TransactionStatus and anything unspecialized).
//
// A PARTIALLY-FILLED TransactionLimits is an override, not a replacement: a
// field left nil inherits the value in DefaultTransactionLimits(). Merge it
// with Config.resolvedLimits (called once, at NewClient) before enforcing it —
// the enforcement helpers treat nil as unlimited and must therefore never see
// an unmerged config.
type TransactionLimits struct {
	STK       ServiceLimits
	C2B       ServiceLimits
	B2C       ServiceLimits
	Reversal  ServiceLimits
	QR        ServiceLimits
	Default   ServiceLimits
}

// DefaultTransactionLimits returns the Safaricom baseline (see docs). It is
// the BASELINE other configs merge OVER, never a replaced default: every field
// is materialized (non-nil), so it also documents the "no Limits field was
// set at all" policy and what an unset field inherits.
//
// B2C defaults to the standard Safaricom cap (250000 KES per transaction /
// 500000 KES per day, docs/apis/b2c.md); higher tiers for Safaricom-approved
// merchants are raised explicitly via Config.Limits.
func DefaultTransactionLimits() TransactionLimits {
	return TransactionLimits{
		STK:       ServiceLimits{MaxPerTransaction: Limit(250_000), MaxPerDay: Limit(500_000)},
		C2B:       ServiceLimits{MaxPerTransaction: Limit(250_000), MaxPerDay: Limit(500_000)},
		B2C:       ServiceLimits{MaxPerTransaction: Limit(250_000), MaxPerDay: Limit(500_000)},
		Reversal:  ServiceLimits{MaxPerTransaction: Limit(250_000), MaxPerDay: Limit(500_000)},
		QR:        ServiceLimits{MaxPerTransaction: Limit(250_000), MaxPerDay: Limit(500_000)},
		Default:   ServiceLimits{MaxPerTransaction: Limit(250_000), MaxPerDay: Limit(500_000)},
	}
}

// overlay merges over ON TOP OF base, field by field, and returns a fully
// materialized entry. A nil field in over inherits base's value; a non-nil
// field (including 0/negative) wins outright.
//
// The pointee is COPIED, not aliased: the result is stored on a Client that
// must stay immutable after construction, so a caller who keeps mutating the
// ServiceLimits value they passed in (or the int64 it points at) must not be
// able to move a live client's ceiling. That immutability is what lets the
// daily ledger read limits without any extra locking.
func overlay(base, over ServiceLimits) ServiceLimits {
	out := ServiceLimits{}
	for _, f := range []struct {
		field **int64
		b, o  *int64
	}{
		{&out.MaxPerTransaction, base.MaxPerTransaction, over.MaxPerTransaction},
		{&out.MaxPerDay, base.MaxPerDay, over.MaxPerDay},
	} {
		src := f.b
		if f.o != nil {
			src = f.o
		}
		if src == nil {
			continue
		}
		v := *src // copy the pointee: never alias caller-owned memory
		*f.field = &v
	}
	return out
}

// Limits identifies a Daraja service for limit lookup and daily
// accumulation. The zero value is deliberately not a valid service so an
// uninitialised key can never silently alias a real one.
type Service string

const (
	ServiceSTK      Service = "STK Push"
	ServiceC2B      Service = "C2B"
	ServiceB2C      Service = "B2C"
	ServiceReversal Service = "Reversal"
	ServiceQR       Service = "QR"
	ServiceDefault  Service = "Default"
)

// limitsFor returns the ceiling entry that governs s. Unknown and
// un-enumerated services fall back to Default, which is what keeps
// TransactionStatus covered without duplicating another entry.
func (l TransactionLimits) limitsFor(s Service) ServiceLimits {
	switch s {
	case ServiceSTK:
		return l.STK
	case ServiceC2B:
		return l.C2B
	case ServiceB2C:
		return l.B2C
	case ServiceReversal:
		return l.Reversal
	case ServiceQR:
		return l.QR
	default:
		return l.Default
	}
}

// LimitError reports an amount rejected by a configured transaction limit.
// It is returned for BOTH the per-transaction and the daily ceiling so
// callers can distinguish a policy rejection from a network failure with a
// single errors.As check, and it names the exact Config path to change — plus
// the fact that an explicit 0 is how a caller disables a ceiling, so the hint
// is actionable for both directions (raise it, or remove it).
type LimitError struct {
	// Service is the human-readable service name, e.g. "STK Push".
	Service string
	// Kind is "MaxPerTransaction" or "MaxPerDay".
	Kind string
	// Amount is the rejected amount: the transaction amount for
	// MaxPerTransaction, the cumulative day total for MaxPerDay.
	Amount int64
	// Max is the configured ceiling that rejected it.
	Max int64
	// ConfigPath is the fully-qualified field to override.
	ConfigPath string
}

func (e *LimitError) Error() string {
	subject := "Amount"
	if e.Kind == "MaxPerDay" {
		subject = "daily total"
	}
	return "mpesa: " + e.Service + " " + subject + " " +
		itoaKes(e.Amount) + " exceeds configured max " + itoaKes(e.Max) +
		" KES (set " + e.ConfigPath + ", or 0 for unlimited)"
}

// itoaKes renders an int64 without a strconv round-trip on the error path.
func itoaKes(v int64) string {
	return strconv.FormatInt(v, 10)
}

// checkPerTransaction enforces the per-transaction ceiling for service.
// Nil as 0 (already merged) and an explicit 0/negative both mean UNLIMITED.
// Kept separate from the daily check so the per-transaction gate is available
// to ValidateWithLimits without a Client (and hence without TrackDaily state).
func checkPerTransaction(service Service, amount int64, limits ServiceLimits) error {
	if max, ok := limits.ceiling(limits.MaxPerTransaction); ok && amount > max {
		return &LimitError{
			Service:    string(service),
			Kind:       "MaxPerTransaction",
			Amount:     amount,
			Max:        max,
			ConfigPath: limitsConfigPath(service, "MaxPerTransaction"),
		}
	}
	return nil
}

// limitsFieldName maps a Service to the Go field that holds its entry, so the
// error message names a path the caller can actually edit
// ("Config.Limits.STK.MaxPerTransaction", NOT "Config.Limits.STK Push...",
// which is the display name rather than the struct field).
func limitsFieldName(service Service) string {
	switch service {
	case ServiceSTK:
		return "STK"
	case ServiceC2B:
		return "C2B"
	case ServiceB2C:
		return "B2C"
	case ServiceReversal:
		return "Reversal"
	case ServiceQR:
		return "QR"
	default:
		return "Default"
	}
}

// limitsConfigPath renders the Config field a caller must edit to raise the
// ceiling that just rejected them, e.g. Config.Limits.STK.MaxPerTransaction.
func limitsConfigPath(service Service, field string) string {
	return "Config.Limits." + limitsFieldName(service) + "." + field
}

// nairobiUTCOffset is Africa/Nairobi's fixed offset: UTC+3 year-round, no
// DST. Hardcoding the offset (rather than loading the IANA zone) keeps the
// day boundary independent of the host's tzdata version and makes the day key
// reproducible in tests that inject cfg.Now.
const nairobiUTCOffset = 3 * time.Hour

// dailyLedger accumulates per-service totals for the current Africa/Nairobi
// day. Guarded by its own mutex so the accumulator can be consulted from any
// Client method without serialising business traffic on the token mutex.
type dailyLedger struct {
	mu   sync.Mutex
	day  string // "2006-01-02" rendered in Nairobi time; "" before first use
	used map[Service]int64
}

// nairobiDay renders t as the calendar day Daraja's merchant reporting uses:
// Africa/Nairobi (UTC+3, no DST). Nairobi midnight is 21:00 UTC the previous
// day, so the day MUST be computed in Nairobi time — a UTC day boundary would
// roll the accumulator three hours early and under-count the tail of the day.
func nairobiDay(t time.Time) string {
	return t.UTC().Add(nairobiUTCOffset).Format("2006-01-02")
}

// consume checks amount against the service's daily ceiling and, if it fits,
// records it atomically. A nil or non-positive MaxPerDay means unlimited, so
// no state is accumulated for it.
//
// It returns the Africa/Nairobi day the amount was charged on, or "" when
// nothing was charged (an unlimited ceiling). The caller hands that day back
// to rollback: a refund may only credit the bucket the amount was actually
// charged against (Python _accrue_daily parity).
//
// The check and the increment happen under one mutex acquisition: releasing
// the lock between them would let two concurrent goroutines both observe a
// total just under the ceiling and both succeed, so N concurrent calls of
// ceil(Max/N) would slip Max+N through the gate. Check-then-add must be
// indivisible, which is what makes the ledger exact.
//
// The limits argument is read-only: Config.resolvedLimits materializes the
// merge once at NewClient, so this path never resolves a config and never
// needs extra locking to read the ceilings.
func (d *dailyLedger) consume(service Service, amount int64, limits TransactionLimits, today string) (string, error) {
	svc := limits.limitsFor(service)
	max, capped := svc.ceiling(svc.MaxPerDay)
	if !capped {
		return "", nil // unlimited: nothing to accumulate, nothing to reject
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	// Roll FORWARD only: a day strictly after the current bucket resets it;
	// a same-day or backward-clock reading keeps accumulating. A backward
	// clock must never zero the accumulator — that would silently discard
	// the day's real volume and let an over-ceiling merchant spend again.
	if d.used == nil || d.day == "" || today > d.day {
		d.day = today
		d.used = make(map[Service]int64)
	}
	used := d.used[service] + amount
	if used > max {
		return "", &LimitError{
			Service:    string(service),
			Kind:       "MaxPerDay",
			Amount:     used,
			Max:        max,
			ConfigPath: limitsConfigPath(service, "MaxPerDay"),
		}
	}
	d.used[service] = used
	return today, nil
}

// rollback removes amount from the bucket it was charged against after a
// transport-class failure — the mirror of consume for requests that never
// received a gateway answer.
//
// accrualDay is the Africa/Nairobi day the amount was charged on ("" when
// nothing was charged). A refund whose day differs from the CURRENT day is
// REFUSED: the amount was never counted against the current day's bucket, so
// crediting it there would hand back quota the payment never consumed — and
// would wipe a day's real volume (Python _rollback_daily parity: the
// same rule, the same "no refund across a day change" outcome).
//
// It is also a no-op when the ledger recorded nothing for the service, and it
// floors at zero so a double-rollback can never drive the accumulator
// negative.
func (d *dailyLedger) rollback(service Service, amount int64, accrualDay string, today string) {
	if accrualDay == "" {
		return // nothing was charged: there is nothing to give back
	}
	if today != accrualDay {
		// The Nairobi day rolled while the request was in flight: the
		// reservation belongs to a bucket that is no longer the current one.
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.used == nil {
		return
	}
	if v := d.used[service] - amount; v > 0 {
		d.used[service] = v
	} else {
		delete(d.used, service)
	}
}
