package mpesa

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// eatZone is East Africa Time (UTC+3), the only timezone Safaricom accepts in
// request timestamps.
var eatZone = time.FixedZone("EAT", 3*60*60)

const eatLayout = "20060102150405"

// GeneratePassword builds the STK Push/Query Password and Timestamp pair from
// a single instant. The returned timestamp MUST be sent verbatim in the
// request body alongside the password — deriving them from different clocks
// causes intermittent 500.001.1001 errors (the two-clock bug).
func GeneratePassword(shortcode, passkey string, t time.Time) (password, timestamp string) {
	timestamp = t.In(eatZone).Format(eatLayout)
	password = base64.StdEncoding.EncodeToString([]byte(shortcode + passkey + timestamp))
	return password, timestamp
}

var phonePattern = regexp.MustCompile(`^254[17]\d{8}$`)

// NormalizePhone converts Kenyan MSISDN shorthand to gateway form:
// 07XXXXXXXX / +2547XXXXXXXX / 2547XXXXXXXX → 2547XXXXXXXX (or 2541…).
func NormalizePhone(s string) (string, error) {
	p := strings.Map(func(r rune) rune {
		switch r {
		case ' ', '-', '(', ')':
			return -1
		}
		return r
	}, strings.TrimSpace(s))
	switch {
	case strings.HasPrefix(p, "+254"):
		p = p[1:]
	case strings.HasPrefix(p, "0"):
		p = "254" + p[1:]
	}
	if !phonePattern.MatchString(p) {
		return "", fmt.Errorf("mpesa: %q is not a valid Kenyan MSISDN (want 07XX/+2547XX/2547XX)", s)
	}
	return p, nil
}

// SecurityCredential encrypts the initiator password with the M-Pesa public
// key certificate using RSA PKCS#1 v1.5 and base64-encodes the ciphertext.
// The certificate may be PEM or raw DER; validity dates and chains are
// deliberately NOT verified because official certs ship long-expired by design.
func SecurityCredential(certPEMorDER []byte, initiatorPassword string) (string, error) {
	der := certPEMorDER
	if block, _ := pem.Decode(der); block != nil {
		der = block.Bytes
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return "", fmt.Errorf("mpesa: parse M-Pesa certificate: %w", err)
	}
	pub, ok := cert.PublicKey.(*rsa.PublicKey)
	if !ok {
		return "", fmt.Errorf("mpesa: M-Pesa certificate carries non-RSA public key %T", cert.PublicKey)
	}
	if initiatorPassword == "" {
		return "", fmt.Errorf("mpesa: initiator password is required")
	}
	ct, err := rsa.EncryptPKCS1v15(rand.Reader, pub, []byte(initiatorPassword))
	if err != nil {
		return "", fmt.Errorf("mpesa: encrypt security credential: %w", err)
	}
	return base64.StdEncoding.EncodeToString(ct), nil
}

// newOriginatorID mints an idempotency key for async APIs when the caller
// omits OriginatorConversationID (<20 chars per Daraja constraint).
func newOriginatorID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return fmt.Sprintf("%x", b)
}

func requireNonEmpty(field, v string) error {
	if strings.TrimSpace(v) == "" {
		return fmt.Errorf("mpesa: %s is required", field)
	}
	return nil
}

func requireMaxLen(field string, v string, max int) error {
	if len(v) > max {
		return fmt.Errorf("mpesa: %s exceeds %d characters (got %d)", field, max, len(v))
	}
	return nil
}

func requireURL(field, v string) error {
	if err := requireNonEmpty(field, v); err != nil {
		return err
	}
	if !strings.HasPrefix(v, "http://") && !strings.HasPrefix(v, "https://") {
		return fmt.Errorf("mpesa: %s must be an absolute http(s) URL", field)
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

// Validate checks every documented STK Push constraint (amount, MSISDNs,
// length caps, callback URL, transaction-type enum) — safe to call before
// hand-marshalling.
func (r *STKPushRequest) Validate() error {
	if err := requireNonEmpty("BusinessShortCode", r.BusinessShortCode); err != nil {
		return err
	}
	switch r.TransactionType {
	case "", TransactionTypePayBillOnline, TransactionTypeBuyGoodsOnline:
	default:
		return fmt.Errorf("mpesa: TransactionType %q not in {CustomerPayBillOnline, CustomerBuyGoodsOnline}", r.TransactionType)
	}
	if r.Amount <= 0 {
		return fmt.Errorf("mpesa: Amount must be a positive whole number, got %d", r.Amount)
	}
	if _, err := requireMSISDN("PartyA", r.PartyA); err != nil {
		return err
	}
	if _, err := requireMSISDN("PhoneNumber", r.PhoneNumber); err != nil {
		return err
	}
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

var b2cCommands = map[CommandID]bool{
	CommandSalaryPayment: true, CommandBusinessPayment: true, CommandPromotionPayment: true,
}

// Validate checks every documented constraint (amount bounds, remarks length,
// command enum, URL shape) and normalizes PartyB — safe to call before
// hand-marshalling.
func (r *B2CPayoutRequest) Validate() error {
	if err := requireNonEmpty("InitiatorName", r.InitiatorName); err != nil {
		return err
	}
	if err := requireNonEmpty("SecurityCredential", r.SecurityCredential); err != nil {
		return err
	}
	if !b2cCommands[r.CommandID] {
		return fmt.Errorf("mpesa: B2C CommandID %q not in {SalaryPayment, BusinessPayment, PromotionPayment}", r.CommandID)
	}
	if r.Amount < 10 || r.Amount > 250000 {
		return fmt.Errorf("mpesa: B2C Amount %d outside [10,250000] KES", r.Amount)
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
func (r *TransactionStatusRequest) Validate() error {
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
	if err := requireURL("ResultURL", r.ResultURL); err != nil {
		return err
	}
	return requireURL("QueueTimeOutURL", r.QueueTimeOutURL)
}

// Validate checks reversal constraints; RecieverIdentifierType defaulting to
// "11" is applied by the client — safe to call before hand-marshalling.
func (r *ReversalRequest) Validate() error {
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
func (r *C2BSimulateRequest) Validate() error {
	switch r.CommandID {
	case TransactionTypePayBillOnline, TransactionTypeBuyGoodsOnline:
	default:
		return fmt.Errorf("mpesa: simulate CommandID %q not in {CustomerPayBillOnline, CustomerBuyGoodsOnline}", r.CommandID)
	}
	if r.Amount <= 0 {
		return fmt.Errorf("mpesa: simulate Amount must be positive, got %d", r.Amount)
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
func (r *QRCodeRequest) Validate() error {
	if err := requireNonEmpty("MerchantName", r.MerchantName); err != nil {
		return err
	}
	if err := requireNonEmpty("RefNo", r.RefNo); err != nil {
		return err
	}
	if r.Amount <= 0 {
		return fmt.Errorf("mpesa: QR Amount must be positive, got %d", r.Amount)
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

// ParseBalanceSegments splits the Account Balance result blob — segments
// joined by "&", fields joined by "|" into typed rows. Per account-balance.md
// tolerance requirements, trailing separators, unknown extra fields and
// MALFORMED ROWS ARE SKIPPED AND COUNTED in skipped, never fatal. Parsed
// floats are display-only; BalanceSegment.Raw preserves each source segment.
func ParseBalanceSegments(s string) (segments []BalanceSegment, skipped int) {
	for _, seg := range strings.Split(s, "&") {
		fields := strings.Split(seg, "|")
		if len(strings.TrimSpace(strings.Join(fields, ""))) == 0 {
			continue
		}
		row := BalanceSegment{Raw: seg}
		if len(fields) < 6 {
			skipped++
			continue
		}
		row.AccountName = strings.TrimSpace(fields[0])
		row.Currency = strings.TrimSpace(fields[1])
		nums := [4]float64{}
		bad := false
		for i := range nums {
			v, err := strconv.ParseFloat(strings.TrimSpace(fields[2+i]), 64)
			if err != nil {
				skipped++
				bad = true
				break
			}
			nums[i] = v
		}
		if bad {
			continue
		}
		row.Available, row.Uncleared, row.Reserved, row.Min = nums[0], nums[1], nums[2], nums[3]
		segments = append(segments, row)
	}
	return segments, skipped
}
