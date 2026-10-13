// Requests: outgoing payloads for every business endpoint, with their
// exported Validate() guardrails and shared validation primitives.

package mpesa

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// STKPushRequest is the Lipa na M-Pesa Online prompt request. The client
// injects Password/Timestamp from ONE shared EAT timestamp at call time —
// callers must never manage clocks themselves (two-clock bug ⇒ 500.001.1001).
type STKPushRequest struct {
	BusinessShortCode string `json:"BusinessShortCode"`
	TransactionType   string `json:"TransactionType,omitempty"`
	Amount            int64  `json:"Amount"`
	PartyA            string `json:"PartyA"`
	PartyB            string `json:"PartyB,omitempty"`
	PhoneNumber       string `json:"PhoneNumber"`
	CallBackURL       string `json:"CallBackURL"`
	AccountReference  string `json:"AccountReference"`
	TransactionDesc   string `json:"TransactionDesc"`
}

// STKQueryRequest checks an existing push outcome. Password and Timestamp
// are injected by the client; BusinessShortCode defaults to cfg.Shortcode
// when empty but may be overridden (the password then binds to it).
type STKQueryRequest struct {
	BusinessShortCode string `json:"BusinessShortCode,omitempty"`
	CheckoutRequestID string `json:"CheckoutRequestID"`
}

// B2CPayoutRequest pays out to a customer MSISDN (v3 API). JSON keys follow
// Safaricom exactly, including the double-s Occassion and InitiatorName.
// Contains credentials — never log directly; GoString/Format redact.
type B2CPayoutRequest struct {
	OriginatorConversationID string `json:"OriginatorConversationID,omitempty"`
	InitiatorName            string `json:"InitiatorName"`
	// Build via mpesa.SecurityCredential() — see docs/apis/getting-started.md.
	SecurityCredential string    `json:"SecurityCredential"`
	CommandID          CommandID `json:"CommandID"`
	Amount             int64     `json:"Amount"`
	PartyA             string    `json:"PartyA"`
	PartyB             string    `json:"PartyB"`
	Remarks            string    `json:"Remarks"`
	QueueTimeOutURL    string    `json:"QueueTimeOutURL"`
	ResultURL          string    `json:"ResultURL"`
	Occassion          string    `json:"Occassion,omitempty"`
}

// GoString redacts SecurityCredential for %#v formatting.
func (r B2CPayoutRequest) GoString() string {
	return redactCredentials(r, "SecurityCredential")
}

// Format routes EVERY fmt verb through the redacted form (GoStringer only
// covers %#v, while %+v prints raw struct fields).
func (r B2CPayoutRequest) Format(f fmt.State, verb rune) {
	_, _ = fmt.Fprint(f, r.GoString())
}

// LogSafe returns the JSON wire shape as a map with SecurityCredential
// replaced by "[REDACTED]" for structured logging.
//
// Security: never json.Marshal(req) for logging — use LogSafe().
// json.Marshal emits SecurityCredential in cleartext and bypasses the
// GoString/Format redaction hooks (which only cover fmt verbs), so logging
// the raw struct or its JSON bytes leaks the bearer credential to log
// aggregators. LogSafe preserves every other wire key verbatim for
// debuggability while redacting only the secret.
func (r B2CPayoutRequest) LogSafe() map[string]any {
	return logSafeRedacted(r, "SecurityCredential")
}

// TransactionStatusRequest queries by receipt XOR original conversation ID.
// Contains credentials — never log directly; GoString/Format redact.
type TransactionStatusRequest struct {
	Initiator string `json:"Initiator"`
	// Build via mpesa.SecurityCredential() — see docs/apis/getting-started.md.
	SecurityCredential     string    `json:"SecurityCredential"`
	CommandID              CommandID `json:"CommandID,omitempty"`
	TransactionID          string    `json:"TransactionID,omitempty"`
	OriginalConversationID string    `json:"OriginalConversationID,omitempty"`
	PartyA                 string    `json:"PartyA"`
	IdentifierType         string    `json:"IdentifierType,omitempty"`
	ResultURL              string    `json:"ResultURL"`
	QueueTimeOutURL        string    `json:"QueueTimeOutURL"`
	Remarks                string    `json:"Remarks"`
	Occasion               string    `json:"Occasion,omitempty"`
}

// GoString redacts SecurityCredential for %#v formatting.
func (r TransactionStatusRequest) GoString() string {
	return redactCredentials(r, "SecurityCredential")
}

// Format routes EVERY fmt verb through the redacted form (GoStringer only
// covers %#v, while %+v prints raw struct fields).
func (r TransactionStatusRequest) Format(f fmt.State, verb rune) {
	_, _ = fmt.Fprint(f, r.GoString())
}

// LogSafe returns the JSON wire shape as a map with SecurityCredential
// replaced by "[REDACTED]" for structured logging.
//
// Security: never json.Marshal(req) for logging — use LogSafe().
// json.Marshal emits SecurityCredential in cleartext and bypasses the
// GoString/Format redaction hooks (which only cover fmt verbs), so logging
// the raw struct or its JSON bytes leaks the bearer credential to log
// aggregators. LogSafe preserves every other wire key verbatim for
// debuggability while redacting only the secret.
func (r TransactionStatusRequest) LogSafe() map[string]any {
	return logSafeRedacted(r, "SecurityCredential")
}

// ReversalRequest reverses a recent C2B transaction. The wire field stays
// Safaricom's misspelled "RecieverIdentifierType" while the Go field is
// spelled correctly; default "11".
// Contains credentials — never log directly; GoString/Format redact.
type ReversalRequest struct {
	Initiator string `json:"Initiator"`
	// Build via mpesa.SecurityCredential() — see docs/apis/getting-started.md.
	SecurityCredential     string    `json:"SecurityCredential"`
	CommandID              CommandID `json:"CommandID,omitempty"`
	TransactionID          string    `json:"TransactionID"`
	Amount                 int64     `json:"Amount"`
	ReceiverParty          string    `json:"ReceiverParty"`
	ReceiverIdentifierType string    `json:"RecieverIdentifierType,omitempty"`
	ResultURL              string    `json:"ResultURL"`
	QueueTimeOutURL        string    `json:"QueueTimeOutURL"`
	Remarks                string    `json:"Remarks"`
}

// GoString redacts SecurityCredential for %#v formatting.
func (r ReversalRequest) GoString() string {
	return redactCredentials(r, "SecurityCredential")
}

// Format routes EVERY fmt verb through the redacted form (GoStringer only
// covers %#v, while %+v prints raw struct fields).
func (r ReversalRequest) Format(f fmt.State, verb rune) {
	_, _ = fmt.Fprint(f, r.GoString())
}

// LogSafe returns the JSON wire shape as a map with SecurityCredential
// replaced by "[REDACTED]" for structured logging.
//
// Security: never json.Marshal(req) for logging — use LogSafe().
// json.Marshal emits SecurityCredential in cleartext and bypasses the
// GoString/Format redaction hooks (which only cover fmt verbs), so logging
// the raw struct or its JSON bytes leaks the bearer credential to log
// aggregators. LogSafe preserves every other wire key verbatim for
// debuggability while redacting only the secret.
func (r ReversalRequest) LogSafe() map[string]any {
	return logSafeRedacted(r, "SecurityCredential")
}

// AccountBalanceRequest queries organization shortcode balances.
// Contains credentials — never log directly; GoString/Format redact.
type AccountBalanceRequest struct {
	Initiator string `json:"Initiator"`
	// Build via mpesa.SecurityCredential() — see docs/apis/getting-started.md.
	SecurityCredential string    `json:"SecurityCredential"`
	CommandID          CommandID `json:"CommandID,omitempty"`
	PartyA             string    `json:"PartyA"`
	IdentifierType     string    `json:"IdentifierType,omitempty"`
	Remarks            string    `json:"Remarks"`
	QueueTimeOutURL    string    `json:"QueueTimeOutURL"`
	ResultURL          string    `json:"ResultURL"`
}

// GoString redacts SecurityCredential for %#v formatting.
func (r AccountBalanceRequest) GoString() string {
	return redactCredentials(r, "SecurityCredential")
}

// Format routes EVERY fmt verb through the redacted form (GoStringer only
// covers %#v, while %+v prints raw struct fields).
func (r AccountBalanceRequest) Format(f fmt.State, verb rune) {
	_, _ = fmt.Fprint(f, r.GoString())
}

// LogSafe returns the JSON wire shape as a map with SecurityCredential
// replaced by "[REDACTED]" for structured logging.
//
// Security: never json.Marshal(req) for logging — use LogSafe().
// json.Marshal emits SecurityCredential in cleartext and bypasses the
// GoString/Format redaction hooks (which only cover fmt verbs), so logging
// the raw struct or its JSON bytes leaks the bearer credential to log
// aggregators. LogSafe preserves every other wire key verbatim for
// debuggability while redacting only the secret.
func (r AccountBalanceRequest) LogSafe() map[string]any {
	return logSafeRedacted(r, "SecurityCredential")
}

// logSafeRedacted renders v through its JSON tags into a map and replaces
// the named secret fields with "[REDACTED]". It operates on serialized
// bytes so the returned map always mirrors the exact wire shape (including
// omitempty behavior) without duplicating struct tags. On marshal failure
// it returns a minimal redacted marker rather than leaking partial state.
func logSafeRedacted(v any, secretFields ...string) map[string]any {
	b, err := json.Marshal(v)
	if err != nil {
		return map[string]any{"redacted": "[REDACTED]"}
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return map[string]any{"redacted": "[REDACTED]"}
	}
	for _, k := range secretFields {
		if _, ok := m[k]; ok {
			m[k] = "[REDACTED]"
		}
	}
	return m
}

// C2BRegisterRequest registers validation/confirmation callback URLs (v2).
type C2BRegisterRequest struct {
	ShortCode       string       `json:"ShortCode,omitempty"`
	ResponseType    ResponseType `json:"ResponseType"`
	ConfirmationURL string       `json:"ConfirmationURL"`
	ValidationURL   string       `json:"ValidationURL"`
}

// C2BSimulateRequest fakes an inbound payment (sandbox only).
type C2BSimulateRequest struct {
	ShortCode     string    `json:"ShortCode,omitempty"`
	CommandID     CommandID `json:"CommandID"`
	Amount        int64     `json:"Amount"`
	Msisdn        string    `json:"Msisdn"`
	BillRefNumber string    `json:"BillRefNumber,omitempty"`
}

// QRCodeRequest generates a dynamic M-PESA QR image. RefNo must stay un-aliased.
type QRCodeRequest struct {
	MerchantName string  `json:"MerchantName"`
	RefNo        string  `json:"RefNo"`
	Amount       int64   `json:"Amount"`
	TrxCode      TrxCode `json:"TrxCode"`
	CPI          string  `json:"CPI"`
	Size         string  `json:"Size"`
}

func requireNonEmpty(field, v string) error {
	if strings.TrimSpace(v) == "" {
		return fmt.Errorf("mpesa: %s is required", field)
	}
	return nil
}

func requireMaxLen(field string, v string, max int) error {
	if len(v) > max {
		return fmt.Errorf("mpesa: %s exceeds %d bytes (got %d)", field, max, len(v))
	}
	return nil
}

// inetATonPartRe matches one inet_aton component: decimal ("127"),
// octal (leading zero, "0177") or 0x-hex ("0x7f"). Anything else means the
// host is a DNS name, not a numeric literal.
var inetATonPartRe = regexp.MustCompile(`^(?:0[xX][0-9a-fA-F]+|[0-9]+)$`)

// inetATonPartsMax is inet_aton's documented maximum of four dot-separated
// components.
const inetATonPartsMax = 4

// looksLikeNumericHost reports whether every dot-separated component of host
// is an inet_aton-style number (decimal/octal/hex). Such a host is ALWAYS an
// attempt to name an IPv4 address by value, so it must be normalised before
// the blocklist runs — see normalizeNumericHost. The part count is NOT capped
// here: a five-part numeric host is numeric-looking and must be rejected by
// normalizeNumericHost, not waved through as an ordinary DNS name.
func looksLikeNumericHost(host string) bool {
	if host == "" {
		return false
	}
	for _, p := range strings.Split(host, ".") {
		if p == "" || !inetATonPartRe.MatchString(p) {
			return false
		}
	}
	return true
}

// inetATonPartValue parses one inet_aton component in decimal, octal (leading
// 0) or 0x-hex. strconv is used with an explicit base rather than
// ParseUint's base-detection so a leading "0" is treated as octal — the
// inet_aton behaviour that makes "017700000001" resolve to 127.0.0.1.
func inetATonPartValue(s string) (uint64, bool) {
	if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
		v, err := strconv.ParseUint(s[2:], 16, 32)
		return v, err == nil
	}
	if len(s) > 1 && s[0] == '0' {
		v, err := strconv.ParseUint(s, 8, 32)
		return v, err == nil
	}
	v, err := strconv.ParseUint(s, 10, 32)
	return v, err == nil
}

// normalizeNumericHost converts an inet_aton-style literal to its dotted-quad
// form, or reports that it cannot be a valid IPv4 address.
//
// The blocklist below used to test the raw host with net.ParseIP, which
// returns nil for every alternative inet_aton spelling — "2852039166",
// "0x7f000001", "2130706433", "017700000001" and the short form "127.1" all
// slipped through and were sent straight to the resolver, which happily
// connects to 169.254.169.254 (the cloud metadata service) or 127.0.0.1.
//
// inet_aton's part-to-byte mapping, verified against glibc/Python:
//
//	n=4 "a.b.c.d" → a<<24 | b<<16 | c<<8 | d
//	n=3 "a.b.c"   → a<<24 | b<<16 | c        (c owns the low 8 bits)
//	n=2 "a.b"     → a<<24 | b                (b owns the low 24 bits)
//	n=1 "a"       → a                        (a full 32-bit value)
//
// So every part before the LAST is top-aligned at 8*(3-i) bits and always
// gets the widest slot available to it, while the last part never shifts.
// That is why "127.1" is 127.0.0.1 and "2130706433" is 127.0.0.1 too.
//
// Numeric host but no valid IPv4 → (nil, false): fail closed. A host that
// tries hard to look like an IP literal and still fails (e.g. "1.2.3.4.5",
// "999.1.1.1", "0xzz") is far more likely an SSRF obfuscation attempt than a
// misconfigured callback, so it is rejected rather than allowed.
func normalizeNumericHost(host string) (net.IP, bool) {
	parts := strings.Split(host, ".")
	if len(parts) > inetATonPartsMax {
		return nil, false
	}
	var value uint64
	for i, p := range parts {
		v, valid := inetATonPartValue(p)
		if !valid {
			return nil, false
		}
		// Byte slot for this part (see the doc comment for the mapping):
		// a lone part IS the whole 32-bit value; every part before the last
		// is top-aligned; the last part fills the lowest bytes.
		shift, width := 0, 8
		switch {
		case len(parts) == 1:
			shift, width = 0, 32
		case i == len(parts)-1:
			shift, width = 0, 8
		default:
			shift, width = 8*(inetATonPartsMax-1-i), 8*(inetATonPartsMax-i)
		}
		if v >= uint64(1)<<width {
			return nil, false // does not fit the bytes this part owns
		}
		value |= v << shift
	}
	return net.IPv4(byte(value>>24), byte(value>>16), byte(value>>8), byte(value)), true
}

// nonRoutableIPReason reports why ip must not be used as a callback target,
// or "" when it is publicly routable. Loopback, RFC1918, unspecified,
// link-local (unicast + multicast), interface-local and other multicast
// ranges are all SSRF sinks.
func nonRoutableIPReason(ip net.IP) string {
	switch {
	case ip.IsLoopback():
		return "loopback"
	case ip.IsPrivate():
		return "private"
	case ip.IsUnspecified():
		return "unspecified"
	case ip.IsLinkLocalUnicast(), ip.IsLinkLocalMulticast():
		return "link-local"
	case ip.IsInterfaceLocalMulticast():
		return "interface-local"
	case ip.IsMulticast():
		return "multicast"
	}
	return ""
}

func requireURL(field, v string) error {
	if err := requireNonEmpty(field, v); err != nil {
		return err
	}
	u, err := url.Parse(v)
	if err != nil {
		return fmt.Errorf("mpesa: %s is not a valid URL: %w", field, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("mpesa: %s must use http or https scheme, got %q", field, u.Scheme)
	}
	if u.User != nil {
		return fmt.Errorf("mpesa: %s must not contain embedded credentials", field)
	}
	if u.Host == "" {
		return fmt.Errorf("mpesa: %s must have a non-empty host", field)
	}
	// Strip port for IP validation
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("mpesa: %s must have a valid host", field)
	}
	// The root label is optional in DNS ("localhost." is the same name as
	// "localhost"), so strip trailing dots before every host comparison —
	// url.Parse keeps them, and an FQDN with a trailing dot would otherwise
	// sail past the localhost guard. Python (host.rstrip(".")) and
	// TypeScript already do this.
	host = strings.TrimRight(host, ".")
	if host == "" {
		return fmt.Errorf("mpesa: %s must have a valid host", field)
	}
	// Reject localhost by name (SSRF protection)
	if strings.EqualFold(host, "localhost") {
		return fmt.Errorf("mpesa: %s must not point to localhost", field)
	}
	// Reject internal/private IP addresses (SSRF protection).
	//
	// net.ParseIP alone is not enough: it only understands dotted-quad and
	// (compressed) IPv6 text, so it returns nil for every inet_aton alias of
	// an IPv4 address. Normalise first — see normalizeNumericHost — and run
	// the blocklist on the RESULT, never on the raw host.
	ip := net.ParseIP(host)
	if looksLikeNumericHost(host) {
		normalized, ok := normalizeNumericHost(host)
		if !ok {
			// Numeric-looking host that is not a valid IPv4 literal: reject
			// (fail closed) instead of letting the resolver interpret it.
			return fmt.Errorf("mpesa: %s host %q is not a valid IP address", field, host)
		}
		ip = normalized
	}
	if ip != nil {
		if reason := nonRoutableIPReason(ip); reason != "" {
			return fmt.Errorf("mpesa: %s must not point to an internal or private IP address (%s)", field, reason)
		}
	}
	return nil
}

func requireMSISDN(field, v string) (string, error) {
	norm, err := NormalizePhone(v)
	if err != nil {
		return "", fmt.Errorf("mpesa: invalid %s: %w", field, err)
	}
	return norm, nil
}

var b2cCommands = map[CommandID]bool{
	CommandSalaryPayment: true, CommandBusinessPayment: true, CommandPromotionPayment: true,
}

// shortcodeRe matches the shortcode shape Daraja documents for STK Push
// PartyB/BusinessShortCode (stk-push.md): a numeric receiving shortcode,
// 5-10 digits. Same shape as Config.Validate's Shortcode gate.
var shortcodeRe = regexp.MustCompile(`^\d{5,10}$`)

// requireShortcode enforces the documented shortcode shape. Used for
// STK Push PartyB, which the client default-injects from BusinessShortCode.
//
// Why validate it here: PartyB used to reach the wire unvalidated, so a typo
// surfaced as the gateway's generic 500.001.1001 "wrong credentials" (which
// reads like a password/timestamp problem) instead of a clear client-side
// error naming the field.
func requireShortcode(field, v string) error {
	if !shortcodeRe.MatchString(v) {
		return fmt.Errorf("mpesa: %s %q must be a numeric shortcode of 5-10 digits", field, v)
	}
	return nil
}

// Validate checks every documented STK Push constraint (amount, MSISDNs,
// PartyB shortcode, length caps, callback URL, transaction-type enum) — safe
// to call before hand-marshalling. TransactionType has NO default: callers
// must choose.
//
// Validate delegates to ValidateWithLimits with DefaultTransactionLimits so
// the behaviour of a direct call is unchanged; the Client calls the
// limits-aware variant with the caller's resolved Config.Limits.
func (r *STKPushRequest) Validate() error {
	return r.ValidateWithLimits(DefaultTransactionLimits())
}

// ValidateWithLimits is Validate with a configurable per-transaction ceiling.
// Every other check is identical. Existing minimums are preserved (Amount
// must be positive); only the maximum now comes from Config.
//
// The limits are enforced AS GIVEN — this function does NOT merge anything —
// so pass a materialized set: DefaultTransactionLimits(), or the Client's
// resolved Config.Limits (which is merged once at NewClient). Merging here
// would re-resolve a config on every request, and a nil field handed
// straight to this function means "no ceiling", not "inherit the baseline".
func (r *STKPushRequest) ValidateWithLimits(limits TransactionLimits) error {
	if err := requireNonEmpty("BusinessShortCode", r.BusinessShortCode); err != nil {
		return err
	}
	if err := requireShortcode("BusinessShortCode", r.BusinessShortCode); err != nil {
		return err
	}
	if err := requireShortcode("PartyB", r.PartyB); err != nil {
		return err
	}
	if r.TransactionType == "" {
		return fmt.Errorf("mpesa: TransactionType is required (CustomerPayBillOnline | CustomerBuyGoodsOnline)")
	}
	switch r.TransactionType {
	case TransactionTypePayBillOnline, TransactionTypeBuyGoodsOnline:
	default:
		return fmt.Errorf("mpesa: TransactionType %q not in {CustomerPayBillOnline, CustomerBuyGoodsOnline}", r.TransactionType)
	}
	if r.Amount <= 0 {
		return fmt.Errorf("mpesa: Amount must be a positive whole number, got %d", r.Amount)
	}
	if err := checkPerTransaction(ServiceSTK, r.Amount, limits.limitsFor(ServiceSTK)); err != nil {
		return err
	}
	partyA, err := requireMSISDN("PartyA", r.PartyA)
	if err != nil {
		return err
	}
	r.PartyA = partyA
	phoneNumber, err := requireMSISDN("PhoneNumber", r.PhoneNumber)
	if err != nil {
		return err
	}
	r.PhoneNumber = phoneNumber
	if err := requireURL("CallBackURL", r.CallBackURL); err != nil {
		return err
	}
	if err := requireNonEmpty("AccountReference", r.AccountReference); err != nil {
		return err
	}
	if err := requireMaxLen("AccountReference", r.AccountReference, 12); err != nil {
		return err
	}
	if err := requireNonEmpty("TransactionDesc", r.TransactionDesc); err != nil {
		return err
	}
	return requireMaxLen("TransactionDesc", r.TransactionDesc, 13)
}

// Validate requires a CheckoutRequestID — safe to call before
// hand-marshalling.
func (r *STKQueryRequest) Validate() error {
	return requireNonEmpty("CheckoutRequestID", r.CheckoutRequestID)
}

// Validate checks every documented constraint (amount bounds, remarks length,
// command enum, URL shape) and normalizes PartyB — safe to call before
// hand-marshalling.
//
// Validate delegates to ValidateWithLimits with DefaultTransactionLimits;
// the Client calls the limits-aware variant with its resolved Config.Limits.
// B2C defaults to the standard Safaricom cap (250000 KES per transaction,
// 500000 KES per day, docs/apis/b2c.md); Safaricom-approved higher tiers
// are raised explicitly via Config.Limits.B2C.
//
// OriginatorConversationID bound: Daraja requires <20 chars (1..19 bytes).
// Client.B2CPayout auto-generates a 16-char lowercase-hex idempotency key
// when empty, so direct Validate() rejects empty (callers must either set
// one or go through the client) and rejects longer than 19 chars to fail
// fast instead of surfacing a gateway rejection.
func (r *B2CPayoutRequest) Validate() error {
	return r.ValidateWithLimits(DefaultTransactionLimits())
}

// ValidateWithLimits is Validate with a configurable per-transaction ceiling
// (B2C). The documented B2C MINIMUM of 10 KES is preserved verbatim; only the
// maximum comes from Config. Limits are enforced as given, never merged here.
func (r *B2CPayoutRequest) ValidateWithLimits(limits TransactionLimits) error {
	// OriginatorConversationID is the async idempotency key: contract <20
	// chars, generated IDs are 16 lowercase-hex chars (see newOriginatorID).
	if err := requireNonEmpty("OriginatorConversationID", r.OriginatorConversationID); err != nil {
		return err
	}
	if err := requireMaxLen("OriginatorConversationID", r.OriginatorConversationID, 19); err != nil {
		return err
	}
	if err := requireNonEmpty("InitiatorName", r.InitiatorName); err != nil {
		return err
	}
	if err := requireNonEmpty("SecurityCredential", r.SecurityCredential); err != nil {
		return err
	}
	if !b2cCommands[r.CommandID] {
		return fmt.Errorf("mpesa: B2C CommandID %q not in {SalaryPayment, BusinessPayment, PromotionPayment}", r.CommandID)
	}
	if r.Amount < 10 {
		return fmt.Errorf("mpesa: B2C Amount %d outside [10,...] KES (below the documented minimum)", r.Amount)
	}
	if err := checkPerTransaction(ServiceB2C, r.Amount, limits.limitsFor(ServiceB2C)); err != nil {
		return err
	}
	if err := requireNonEmpty("PartyA", r.PartyA); err != nil {
		return err
	}
	partyB, err := requireMSISDN("PartyB", r.PartyB)
	if err != nil {
		return err
	}
	r.PartyB = partyB
	if n := len(strings.TrimSpace(r.Remarks)); n < 2 || n > 100 {
		return fmt.Errorf("mpesa: B2C Remarks must be 2-100 characters, got %d", n)
	}
	if err := requireURL("QueueTimeOutURL", r.QueueTimeOutURL); err != nil {
		return err
	}
	return requireURL("ResultURL", r.ResultURL)
}

// Validate enforces the exactly-one-of TransactionID XOR OriginalConversationID
// rule plus credential/URL/remarks constraints; fills IdentifierType default
// expectations — safe to call before hand-marshalling.
//
// Validate delegates to ValidateWithLimits with DefaultTransactionLimits;
// TransactionStatus has no dedicated ceiling entry, so it is bounded by
// TransactionLimits.Default.
func (r *TransactionStatusRequest) Validate() error {
	return r.ValidateWithLimits(DefaultTransactionLimits())
}

// ValidateWithLimits is Validate with the Default ceiling applied to Amount.
func (r *TransactionStatusRequest) ValidateWithLimits(limits TransactionLimits) error {
	switch {
	case r.TransactionID == "" && r.OriginalConversationID == "":
		return fmt.Errorf("mpesa: exactly one of TransactionID or OriginalConversationID is required")
	case r.TransactionID != "" && r.OriginalConversationID != "":
		return fmt.Errorf("mpesa: exactly one of TransactionID or OriginalConversationID must be set, got both")
	}
	if r.CommandID != "" && r.CommandID != CommandTransactionStatusQuery {
		return fmt.Errorf("mpesa: TransactionStatus CommandID must be TransactionStatusQuery")
	}
	if err := requireNonEmpty("Initiator", r.Initiator); err != nil {
		return err
	}
	if err := requireNonEmpty("SecurityCredential", r.SecurityCredential); err != nil {
		return err
	}
	if err := requireNonEmpty("PartyA", r.PartyA); err != nil {
		return err
	}
	if n := len(strings.TrimSpace(r.Remarks)); n < 1 || n > 100 {
		return fmt.Errorf("mpesa: Remarks must be 1-100 characters, got %d", n)
	}
	// TransactionStatusRequest carries NO Amount, so there is nothing to
	// gate here; the Default ceiling exists for symmetry with the other
	// requests and for the other language bindings.
	if err := requireURL("ResultURL", r.ResultURL); err != nil {
		return err
	}
	return requireURL("QueueTimeOutURL", r.QueueTimeOutURL)
}

// Validate checks reversal constraints; RecieverIdentifierType defaulting to
// "11" is applied by the client — safe to call before hand-marshalling.
//
// Validate delegates to ValidateWithLimits with DefaultTransactionLimits;
// Reversal is bounded by TransactionLimits.Default.
func (r *ReversalRequest) Validate() error {
	return r.ValidateWithLimits(DefaultTransactionLimits())
}

// ValidateWithLimits is Validate with the Default ceiling applied to Amount.
func (r *ReversalRequest) ValidateWithLimits(limits TransactionLimits) error {
	if r.CommandID != "" && r.CommandID != CommandTransactionReversal {
		return fmt.Errorf("mpesa: Reversal CommandID must be TransactionReversal")
	}
	if err := requireNonEmpty("Initiator", r.Initiator); err != nil {
		return err
	}
	if err := requireNonEmpty("SecurityCredential", r.SecurityCredential); err != nil {
		return err
	}
	if err := requireNonEmpty("TransactionID", r.TransactionID); err != nil {
		return err
	}
	if r.Amount <= 0 {
		return fmt.Errorf("mpesa: Reversal Amount must be positive, got %d", r.Amount)
	}
	if err := checkPerTransaction(ServiceDefault, r.Amount, limits.limitsFor(ServiceDefault)); err != nil {
		return err
	}
	if err := requireNonEmpty("ReceiverParty", r.ReceiverParty); err != nil {
		return err
	}
	if n := len(strings.TrimSpace(r.Remarks)); n < 2 || n > 100 {
		return fmt.Errorf("mpesa: Reversal Remarks must be 2-100 characters, got %d", n)
	}
	if err := requireURL("ResultURL", r.ResultURL); err != nil {
		return err
	}
	return requireURL("QueueTimeOutURL", r.QueueTimeOutURL)
}

// Validate checks balance-query constraints — safe to call before
// hand-marshalling.
func (r *AccountBalanceRequest) Validate() error {
	if r.CommandID != "" && r.CommandID != CommandAccountBalance {
		return fmt.Errorf("mpesa: AccountBalance CommandID must be AccountBalance")
	}
	if err := requireNonEmpty("Initiator", r.Initiator); err != nil {
		return err
	}
	if err := requireNonEmpty("SecurityCredential", r.SecurityCredential); err != nil {
		return err
	}
	if err := requireNonEmpty("PartyA", r.PartyA); err != nil {
		return err
	}
	if n := len(strings.TrimSpace(r.Remarks)); n < 1 || n > 100 {
		return fmt.Errorf("mpesa: Remarks must be 1-100 characters, got %d", n)
	}
	if err := requireURL("QueueTimeOutURL", r.QueueTimeOutURL); err != nil {
		return err
	}
	return requireURL("ResultURL", r.ResultURL)
}

var c2bResponseTypes = map[ResponseType]bool{ResponseTypeCompleted: true, ResponseTypeCancelled: true}

// Validate checks response-type enum and callback URL shapes — safe to call
// before hand-marshalling.
func (r *C2BRegisterRequest) Validate() error {
	if !c2bResponseTypes[r.ResponseType] {
		return fmt.Errorf("mpesa: ResponseType %q must be Completed or Cancelled", r.ResponseType)
	}
	if err := requireURL("ConfirmationURL", r.ConfirmationURL); err != nil {
		return err
	}
	return requireURL("ValidationURL", r.ValidationURL)
}

// Validate checks simulation constraints and normalizes Msisdn — safe to call
// before hand-marshalling.
//
// Validate delegates to ValidateWithLimits with DefaultTransactionLimits;
// C2BSimulate is bounded by TransactionLimits.C2B.
func (r *C2BSimulateRequest) Validate() error {
	return r.ValidateWithLimits(DefaultTransactionLimits())
}

// ValidateWithLimits is Validate with the C2B ceiling applied to Amount.
func (r *C2BSimulateRequest) ValidateWithLimits(limits TransactionLimits) error {
	switch r.CommandID {
	case TransactionTypePayBillOnline, TransactionTypeBuyGoodsOnline:
	default:
		return fmt.Errorf("mpesa: simulate CommandID %q not in {CustomerPayBillOnline, CustomerBuyGoodsOnline}", r.CommandID)
	}
	if r.Amount <= 0 {
		return fmt.Errorf("mpesa: simulate Amount must be positive, got %d", r.Amount)
	}
	if err := checkPerTransaction(ServiceC2B, r.Amount, limits.limitsFor(ServiceC2B)); err != nil {
		return err
	}
	msisdn, err := requireMSISDN("Msisdn", r.Msisdn)
	if err != nil {
		return err
	}
	r.Msisdn = msisdn
	if r.CommandID == TransactionTypePayBillOnline && strings.TrimSpace(r.BillRefNumber) == "" {
		return fmt.Errorf("mpesa: BillRefNumber is required for CustomerPayBillOnline simulation")
	}
	return nil
}

var qrTrxCodes = map[TrxCode]bool{QRTrxBuyGoods: true, QRTrxWithdrawAtAgentTill: true, QRTrxPaybill: true, QRTrxSendMoney: true, QRTrxSendToBusiness: true}

// Validate checks merchant/reference presence, amount positivity, TrxCode
// whitelist, CPI digit-shape and Size — safe to call before hand-marshalling.
//
// Validate delegates to ValidateWithLimits with DefaultTransactionLimits; the
// QR flow is bounded by TransactionLimits.Default.
func (r *QRCodeRequest) Validate() error {
	return r.ValidateWithLimits(DefaultTransactionLimits())
}

// ValidateWithLimits is Validate with the Default ceiling applied to Amount.
func (r *QRCodeRequest) ValidateWithLimits(limits TransactionLimits) error {
	if err := requireNonEmpty("MerchantName", r.MerchantName); err != nil {
		return err
	}
	if err := requireNonEmpty("RefNo", r.RefNo); err != nil {
		return err
	}
	if r.Amount <= 0 {
		return fmt.Errorf("mpesa: QR Amount must be positive, got %d", r.Amount)
	}
	if err := checkPerTransaction(ServiceDefault, r.Amount, limits.limitsFor(ServiceDefault)); err != nil {
		return err
	}
	if !qrTrxCodes[r.TrxCode] {
		return fmt.Errorf("mpesa: TrxCode %q not in {BG, WA, PB, SM, SB}", r.TrxCode)
	}
	cpi := strings.TrimSpace(r.CPI)
	if len(cpi) < 5 || len(cpi) > 12 {
		return fmt.Errorf("mpesa: CPI %q must be 5-12 digits", cpi)
	}
	for _, ch := range cpi {
		if ch < '0' || ch > '9' {
			return fmt.Errorf("mpesa: CPI %q must be digits only", cpi)
		}
	}
	size := strings.TrimSpace(r.Size)
	n, err := strconv.Atoi(size)
	if err != nil || n <= 0 {
		return fmt.Errorf("mpesa: Size %q must be a positive integer", r.Size)
	}
	r.CPI = cpi
	r.Size = size
	return nil
}
