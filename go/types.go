// Package mpesa is a dependency-free Safaricom Daraja API engine.
//
// Safety-critical semantics (ADR-010): result codes 1001/1037/26/4999 and any
// unknown code classify as indeterminate, never failed — marking them failed
// risks refunding orders that settle minutes later.
package mpesa

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Environment selects the Daraja deployment a Client talks to.
type Environment int

const (
	// Sandbox is the developer test environment, wire base URL
	// https://sandbox.safaricom.co.ke.
	Sandbox Environment = iota
	// Production is the live environment, wire base URL
	// https://api.safaricom.co.ke.
	Production
)

// BaseURL returns the platform root for the environment.
func (e Environment) BaseURL() string {
	if e == Production {
		return "https://api.safaricom.co.ke"
	}
	return "https://sandbox.safaricom.co.ke"
}

// Config configures a Client. Timeout defaults to 30s; Now may inject a clock
// for tests (defaults to time.Now). Config contains credentials — never log
// directly; GoString/Format redact.
type Config struct {
	ConsumerKey    string
	ConsumerSecret string
	Shortcode      string
	Passkey        string
	Environment    Environment
	Timeout        time.Duration
	Now            func() time.Time
}

// GoString redacts ConsumerSecret and Passkey for %#v formatting.
func (c Config) GoString() string {
	return fmt.Sprintf("mpesa.Config{ConsumerKey:%q Shortcode:%q Environment:%d Timeout:%s secrets:redacted}",
		c.ConsumerKey, c.Shortcode, int(c.Environment), c.Timeout)
}

// Format routes EVERY fmt verb (%v, %+v, %s, ...) through the redacted form;
// GoStringer alone only covers %#v, while %+v prints raw struct fields.
func (c Config) Format(f fmt.State, verb rune) {
	_, _ = fmt.Fprint(f, c.GoString())
}

// redactCredentials renders r as JSON with the named secret fields replaced
// by [REDACTED]. It operates on serialized bytes, so it cannot recurse into
// the type's own Format/GoString hooks.
func redactCredentials(r any, secretFields ...string) string {
	b, err := json.Marshal(r)
	if err != nil {
		return "<unserializable>"
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return string(b)
	}
	for _, k := range secretFields {
		if _, ok := m[k]; ok {
			m[k] = "[REDACTED]"
		}
	}
	out, err := json.Marshal(m)
	if err != nil {
		return "<unserializable>"
	}
	return string(out)
}

// Error is the typed surface for non-2xx Daraja responses carrying the
// standard {requestId, errorCode, errorMessage} envelope.
type Error struct {
	StatusCode   int
	RequestID    string
	ErrorCode    string
	ErrorMessage string
}

func (e *Error) Error() string {
	parts := []string{fmt.Sprintf("HTTP %d", e.StatusCode)}
	if e.ErrorMessage != "" {
		parts = append(parts, e.ErrorMessage)
	}
	if e.ErrorCode != "" {
		parts = append(parts, "["+e.ErrorCode+"]")
	}
	if e.RequestID != "" {
		parts = append(parts, "requestId="+e.RequestID)
	}
	return "mpesa: " + strings.Join(parts, " ")
}

// ResultClass buckets a Daraja result code for retry-safe decisions.
type ResultClass string

const (
	// ResultClassSuccess is wire ResultCode 0 — settled successfully.
	ResultClassSuccess ResultClass = "success"
	// ResultClassFailure is a known terminal failure across the STK Push
	// (stk-push.md), B2C (b2c.md) and Account Balance (account-balance.md)
	// catalogs.
	ResultClassFailure ResultClass = "failure"
	// ResultClassIndeterminate covers unknown, non-terminal and non-numeric
	// codes: never auto-fail, keep querying (ADR-010).
	ResultClassIndeterminate ResultClass = "indeterminate"
)

// resultCodeFailure unions the documented terminal-failure catalogs:
// STK Push {1,17,1019,1025,1032,2001,9999} · B2C {2,3,4,8,11,21,2001,2006,
// 2028,2040,8006} · Account Balance {15,22} (17/21 shared with B2C).
var resultCodeFailure = map[int64]bool{
	1: true, 2: true, 3: true, 4: true, 8: true, 11: true, 15: true, 17: true,
	21: true, 22: true, 1019: true, 1025: true, 1032: true, 2001: true,
	2006: true, 2028: true, 2040: true, 8006: true, 9999: true,
}

func parseResultCode(code string) (int64, bool) {
	s := strings.TrimSpace(strings.Trim(code, `"`))
	if v, err := strconv.ParseInt(s, 10, 64); err == nil {
		return v, true
	}
	// Lenient fallback: integral floats only ("0.0" → 0); non-integral or
	// out-of-range values are not result codes.
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f != math.Trunc(f) || f < math.MinInt64 || f > math.MaxInt64 {
		return 0, false
	}
	return int64(f), true
}

// ClassifyResultCode maps a result code to its safety class. Success is only
// ever 0; failure is limited to documented terminal codes across all API
// catalogs; everything else — including unknown or non-numeric codes — is
// indeterminate and must never be auto-failed (debits have been observed
// landing minutes later).
func ClassifyResultCode(code string) ResultClass {
	v, ok := parseResultCode(code)
	if !ok {
		return ResultClassIndeterminate
	}
	switch {
	case v == 0:
		return ResultClassSuccess
	case resultCodeFailure[v]:
		return ResultClassFailure
	default:
		return ResultClassIndeterminate
	}
}

// FlexString coerces JSON strings or numbers into a Go string. Daraja mixes
// both (e.g. STK Query ResultCode arrives as "1032" in some captures, 1032 in
// others).
type FlexString string

// UnmarshalJSON accepts quoted strings, bare numbers, booleans, and null.
func (f *FlexString) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "null" || s == "" {
		*f = ""
		return nil
	}
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		var v string
		if err := json.Unmarshal(b, &v); err != nil {
			return err
		}
		*f = FlexString(v)
		return nil
	}
	var num json.Number
	if err := json.Unmarshal(b, &num); err == nil {
		*f = FlexString(num.String())
		return nil
	}
	*f = FlexString(s)
	return nil
}

// String returns the coerced wire representation of the value.
func (f FlexString) String() string { return string(f) }

// FlexInt64 coerces JSON numbers or numeric strings into an int64. OAuth's
// expires_in arrives as the STRING "3599" in official captures and as a bare
// number elsewhere.
type FlexInt64 int64

// UnmarshalJSON accepts quoted numeric strings, bare numbers, and null;
// null or "" map to 0 — callers treat <=0 as TTL unknown. Malformed input
// (doubled quotes, alphabetic content) is a hard error.
func (f *FlexInt64) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "null" || s == "" {
		*f = 0
		return nil
	}
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		var str string
		if err := json.Unmarshal(b, &str); err != nil {
			return err
		}
		str = strings.TrimSpace(str)
		if str == "" {
			*f = 0
			return nil
		}
		v, err := strconv.ParseInt(str, 10, 64)
		if err != nil {
			return fmt.Errorf("mpesa: cannot parse %s as integer", b)
		}
		*f = FlexInt64(v)
		return nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return fmt.Errorf("mpesa: cannot parse %s as integer", b)
	}
	*f = FlexInt64(v)
	return nil
}

// CommandID is the wire CommandID enum string shared by B2C, Transaction
// Status, Reversal, Account Balance and C2B Simulate.
type CommandID string

// TrxCode is the Dynamic QR transaction-type enum string (wire values
// BG/WA/PB/SM/SB).
type TrxCode string

// ResponseType is the C2B URL-registration fallback enum string.
type ResponseType string

// Shared enum values using Safaricom's exact spellings.
const (
	// TransactionTypePayBillOnline is wire value "CustomerPayBillOnline",
	// accepted by STK Push and C2B Simulate.
	TransactionTypePayBillOnline = "CustomerPayBillOnline"
	// TransactionTypeBuyGoodsOnline is wire value "CustomerBuyGoodsOnline",
	// accepted by STK Push and C2B Simulate.
	TransactionTypeBuyGoodsOnline = "CustomerBuyGoodsOnline"

	// CommandSalaryPayment is wire value "SalaryPayment" for B2C payouts.
	CommandSalaryPayment CommandID = "SalaryPayment"
	// CommandBusinessPayment is wire value "BusinessPayment" for B2C payouts.
	CommandBusinessPayment CommandID = "BusinessPayment"
	// CommandPromotionPayment is wire value "PromotionPayment" for B2C
	// payouts.
	CommandPromotionPayment CommandID = "PromotionPayment"
	// CommandTransactionStatusQuery is wire value "TransactionStatusQuery",
	// the only valid CommandID for Transaction Status.
	CommandTransactionStatusQuery CommandID = "TransactionStatusQuery"
	// CommandTransactionReversal is wire value "TransactionReversal", the
	// only valid CommandID for Reversal.
	CommandTransactionReversal CommandID = "TransactionReversal"
	// CommandAccountBalance is wire value "AccountBalance", the only valid
	// CommandID for Account Balance.
	CommandAccountBalance CommandID = "AccountBalance"

	// ResponseTypeCompleted is wire value "Completed" for C2B URL
	// registration: complete the transaction when validation is unreachable.
	ResponseTypeCompleted ResponseType = "Completed"
	// ResponseTypeCancelled is wire value "Cancelled" for C2B URL
	// registration: cancel the transaction when validation is unreachable.
	ResponseTypeCancelled ResponseType = "Cancelled"

	// IdentifierOrgShortcode is wire value "4": organization shortcode,
	// used by Transaction Status and Account Balance IdentifierType.
	IdentifierOrgShortcode = "4"
	// ReceiverIdentifierOrg is wire value "11": organization shortcode as
	// the Reversal RecieverIdentifierType (Safaricom's misspelled field).
	ReceiverIdentifierOrg = "11"

	// QRTrxBuyGoods is wire value "BG": pay merchant (buy goods), Dynamic QR.
	QRTrxBuyGoods TrxCode = "BG"
	// QRTrxWithdrawAtAgentTill is wire value "WA": withdraw cash at agent
	// till, Dynamic QR.
	QRTrxWithdrawAtAgentTill TrxCode = "WA"
	// QRTrxPaybill is wire value "PB": paybill/business number, Dynamic QR.
	QRTrxPaybill TrxCode = "PB"
	// QRTrxSendMoney is wire value "SM": send money (mobile MSISDN),
	// Dynamic QR.
	QRTrxSendMoney TrxCode = "SM"
	// QRTrxSendToBusiness is wire value "SB": sent to business (CPI in
	// MSISDN format), Dynamic QR.
	QRTrxSendToBusiness TrxCode = "SB"
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

// STKPushResponse is the synchronous acknowledgement. ResponseCode "0" means
// accepted — NOT paid. Persist CheckoutRequestID as the dedup/join key.
type STKPushResponse struct {
	MerchantRequestID   string `json:"MerchantRequestID"`
	CheckoutRequestID   string `json:"CheckoutRequestID"`
	ResponseCode        string `json:"ResponseCode"`
	ResponseDescription string `json:"ResponseDescription"`
	CustomerMessage     string `json:"CustomerMessage"`
}

// IsAccepted reports whether Daraja acknowledged the push (ResponseCode "0").
// Acceptance is NOT payment confirmation — settle only via callback or query.
func (r STKPushResponse) IsAccepted() bool { return r.ResponseCode == "0" }

// STKQueryRequest checks an existing push outcome. BusinessShortCode,
// Password and Timestamp are injected by the client.
type STKQueryRequest struct {
	CheckoutRequestID string `json:"CheckoutRequestID"`
}

// STKQueryResponse carries both the ack and the transaction outcome;
// ResultCode coerces Safaricom's inconsistent string/int encodings.
type STKQueryResponse struct {
	ResponseCode        string     `json:"ResponseCode"`
	ResponseDescription string     `json:"ResponseDescription"`
	MerchantRequestID   string     `json:"MerchantRequestID"`
	CheckoutRequestID   string     `json:"CheckoutRequestID"`
	ResultCode          FlexString `json:"ResultCode"`
	ResultDesc          string     `json:"ResultDesc"`
}

// B2CPayoutRequest pays out to a customer MSISDN (v3 API). JSON keys follow
// Safaricom exactly, including the double-s Occassion and InitiatorName.
// Contains credentials — never log directly; GoString/Format redact.
type B2CPayoutRequest struct {
	OriginatorConversationID string    `json:"OriginatorConversationID,omitempty"`
	InitiatorName            string    `json:"InitiatorName"`
	SecurityCredential       string    `json:"SecurityCredential"`
	CommandID                CommandID `json:"CommandID"`
	Amount                   int64     `json:"Amount"`
	PartyA                   string    `json:"PartyA"`
	PartyB                   string    `json:"PartyB"`
	Remarks                  string    `json:"Remarks"`
	QueueTimeOutURL          string    `json:"QueueTimeOutURL"`
	ResultURL                string    `json:"ResultURL"`
	Occassion                string    `json:"Occassion,omitempty"`
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

// ConversationResponse is the sync ACK of async APIs
// (B2C, Transaction Status, Reversal, Account Balance).
type ConversationResponse struct {
	OriginatorConversationID string `json:"OriginatorConversationID"`
	ConversationID           string `json:"ConversationID"`
	ResponseCode             string `json:"ResponseCode"`
	ResponseDescription      string `json:"ResponseDescription"`
}

// B2CResponse aliases the shared ACK shape returned by B2CPayout.
type B2CResponse = ConversationResponse

// TransactionStatusRequest queries by receipt XOR original conversation ID.
// Contains credentials — never log directly; GoString/Format redact.
type TransactionStatusRequest struct {
	Initiator              string    `json:"Initiator"`
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
	Initiator              string    `json:"Initiator"`
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
	Initiator          string    `json:"Initiator"`
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

// C2BAckResponse matches Safaricom's unique ACK shape: the misspelled
// OriginatorCoversationID key and NO ConversationID field.
type C2BAckResponse struct {
	OriginatorConversationID string `json:"OriginatorCoversationID"`
	ResponseCode             string `json:"ResponseCode"`
	ResponseDescription      string `json:"ResponseDescription"`
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

// QRCodeResponse exposes the QR payload verbatim. ResponseCode here is an
// opaque alphanumeric tracking string, not a status code.
type QRCodeResponse struct {
	ResponseCode        string `json:"ResponseCode"`
	RequestID           string `json:"RequestID"`
	ResponseDescription string `json:"ResponseDescription"`
	QRCode              string `json:"QRCode"`
}

// StkCallback is the top-level envelope POSTed to CallBackURL.
//
// Safaricom callbacks carry NO HMAC signature, so ingestion endpoints must
// harden themselves: bind on CheckoutRequestID, validate amount/phone against
// the original request, and wrap request bodies in http.MaxBytesReader
// (recommend >=1 MiB cap) before unmarshalling into this type.
type StkCallback struct {
	Body StkCallbackBody `json:"Body"`
}

// StkCallbackBody wraps the inner stkCallback object.
type StkCallbackBody struct {
	StkCallback StkCallbackResult `json:"stkCallback"`
}

// StkCallbackResult is the transaction outcome. CallbackMetadata is absent on
// failures — parse defensively via MetadataMap.
type StkCallbackResult struct {
	MerchantRequestID string            `json:"MerchantRequestID"`
	CheckoutRequestID string            `json:"CheckoutRequestID"`
	ResultCode        FlexString        `json:"ResultCode"`
	ResultDesc        string            `json:"ResultDesc"`
	CallbackMetadata  *CallbackMetadata `json:"CallbackMetadata,omitempty"`
}

// Classify buckets the callback outcome per ADR-010 safety rules.
func (r StkCallbackResult) Classify() ResultClass {
	return ClassifyResultCode(r.ResultCode.String())
}

func (r StkCallbackResult) metadataItems() []MetadataItem {
	if r.CallbackMetadata == nil {
		return nil
	}
	return r.CallbackMetadata.Item
}

// MetadataMap flattens callback metadata items, tolerating absent metadata;
// integral values decode as int64, decimals as float64. On duplicate names
// the FIRST item wins — check DuplicateKeys to detect lossy collisions.
func (r StkCallbackResult) MetadataMap() map[string]any {
	out := make(map[string]any)
	for _, item := range r.metadataItems() {
		if _, exists := out[item.Name]; !exists {
			out[item.Name] = item.decodedValue()
		}
	}
	return out
}

// DuplicateKeys reports how many metadata items were shadowed by an earlier
// same-named item (Safaricom duplicates have been observed on retries).
func (r StkCallbackResult) DuplicateKeys() int {
	seen := make(map[string]bool)
	dupes := 0
	for _, item := range r.metadataItems() {
		if seen[item.Name] {
			dupes++
			continue
		}
		seen[item.Name] = true
	}
	return dupes
}

// CallbackMetadata holds the Item list Safaricom sends on success.
type CallbackMetadata struct {
	Item []MetadataItem `json:"Item,omitempty"`
}

// MetadataItem is one named metadata value; Value stays raw because Safaricom
// mixes numeric and string encodings.
type MetadataItem struct {
	Name  string          `json:"Name"`
	Value json.RawMessage `json:"Value,omitempty"`
}

// decodedValue coerces raw JSON leniently: empty/null → nil (explicit absence,
// never a fake zero); integers without ./e/E → int64 (preserves
// TransactionDate/PhoneNumber magnitudes); then float64, string, bool, and
// finally raw bytes for anything unrecognized.
func (m MetadataItem) decodedValue() any {
	raw := strings.TrimSpace(string(m.Value))
	if raw == "" || raw == "null" {
		return nil
	}
	var f float64
	if err := json.Unmarshal(m.Value, &f); err == nil {
		if !strings.ContainsAny(raw, ".eE") && f >= math.MinInt64 && f <= math.MaxInt64 {
			return int64(f)
		}
		return f
	}
	var s string
	if err := json.Unmarshal(m.Value, &s); err == nil {
		return s
	}
	var b bool
	if err := json.Unmarshal(m.Value, &b); err == nil {
		return b
	}
	return m.Value
}

// AsyncResult is the shared envelope POSTed to ResultURL by async APIs.
type AsyncResult struct {
	Result AsyncResultBody `json:"Result"`
}

// AsyncResultBody carries header fields plus the Key/Value parameter list.
type AsyncResultBody struct {
	ResultType               FlexString        `json:"ResultType"`
	ResultCode               FlexString        `json:"ResultCode"`
	ResultDesc               string            `json:"ResultDesc"`
	OriginatorConversationID string            `json:"OriginatorConversationID"`
	ConversationID           string            `json:"ConversationID"`
	TransactionID            string            `json:"TransactionID"`
	ResultParameters         *ResultParameters `json:"ResultParameters,omitempty"`
	ReferenceData            *ReferenceData    `json:"ReferenceData,omitempty"`
}

// Classify buckets the async result outcome per ADR-010 safety rules.
func (r AsyncResultBody) Classify() ResultClass {
	return ClassifyResultCode(r.ResultCode.String())
}

// Parameters flattens ResultParameters tolerating absent sections; values are
// rendered leniently as strings since Safaricom mixes types.
func (r AsyncResultBody) Parameters() map[string]string {
	out := make(map[string]string)
	if r.ResultParameters == nil {
		return out
	}
	for _, p := range r.ResultParameters.ResultParameter {
		fs := FlexString("")
		if err := json.Unmarshal(p.Value, &fs); err != nil {
			out[p.Key] = string(p.Value)
			continue
		}
		out[p.Key] = fs.String()
	}
	return out
}

// ResultParameters wraps the repeated {Key,Value} objects.
type ResultParameters struct {
	ResultParameter []ResultParameter `json:"ResultParameter"`
}

// ResultParameter is one async-result key/value pair with a raw value.
type ResultParameter struct {
	Key   string          `json:"Key"`
	Value json.RawMessage `json:"Value,omitempty"`
}

// ReferenceData wraps the optional ReferenceItem echo some async results
// carry (e.g. B2C QueueTimeoutURL).
type ReferenceData struct {
	ReferenceItem []ReferenceItem `json:"ReferenceItem,omitempty"`
}

// UnmarshalJSON tolerates both observed Safaricom shapes: ReferenceItem as a
// single object (b2c.md sample) or as a list.
func (rd *ReferenceData) UnmarshalJSON(b []byte) error {
	var probe struct {
		ReferenceItem json.RawMessage `json:"ReferenceItem"`
	}
	if err := json.Unmarshal(b, &probe); err != nil {
		return err
	}
	if len(probe.ReferenceItem) == 0 || string(probe.ReferenceItem) == "null" {
		return nil
	}
	var single ReferenceItem
	if err := json.Unmarshal(probe.ReferenceItem, &single); err == nil {
		rd.ReferenceItem = []ReferenceItem{single}
		return nil
	}
	var many []ReferenceItem
	if err := json.Unmarshal(probe.ReferenceItem, &many); err != nil {
		return err
	}
	rd.ReferenceItem = many
	return nil
}

// ReferenceItem is one key/value echo entry of async-result ReferenceData.
type ReferenceItem struct {
	Key   string `json:"Key"`
	Value string `json:"Value"`
}

// BalanceSegment is one parsed account row of an Account Balance result.
// The floats are display-only conveniences — Raw preserves the authoritative
// source segment verbatim.
type BalanceSegment struct {
	AccountName string
	Currency    string
	Available   float64
	Uncleared   float64
	Reserved    float64
	Min         float64
	Raw         string
}
