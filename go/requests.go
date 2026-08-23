// Requests: outgoing payloads for every business endpoint, with their
// exported Validate() guardrails and shared validation primitives.

package mpesa

import (
	"fmt"
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

// STKQueryRequest checks an existing push outcome. BusinessShortCode,
// Password and Timestamp are injected by the client.
type STKQueryRequest struct {
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

var b2cCommands = map[CommandID]bool{
	CommandSalaryPayment: true, CommandBusinessPayment: true, CommandPromotionPayment: true,
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
