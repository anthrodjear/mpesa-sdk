// Package mpesa is a dependency-free Safaricom Daraja API engine.
//
// Safety-critical semantics (ADR-010): result codes 1001/1037/26/4999 and any
// unknown code classify as indeterminate, never failed — marking them failed
// risks refunding orders that settle minutes later.
package mpesa

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Environment selects the Daraja deployment a Client talks to.
type Environment int

const (
	// Sandbox is the developer test environment.
	Sandbox Environment = iota
	// Production is the live environment.
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
// for tests (defaults to time.Now).
type Config struct {
	ConsumerKey    string
	ConsumerSecret string
	Shortcode      string
	Passkey        string
	Environment    Environment
	Timeout        time.Duration
	Now            func() time.Time
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
	ResultClassSuccess       ResultClass = "success"
	ResultClassFailure       ResultClass = "failure"
	ResultClassIndeterminate ResultClass = "indeterminate"
)

var resultCodeFailure = map[int64]bool{1: true, 17: true, 1019: true, 1025: true, 2001: true, 9999: true}

// ClassifyResultCode maps a result code to its safety class. Success is only
// ever 0; failure is limited to known terminal codes; everything else —
// including unknown or non-numeric codes — is indeterminate and must never be
// auto-failed (debits have been observed landing minutes later).
func ClassifyResultCode(code string) ResultClass {
	v, err := strconv.ParseInt(strings.TrimSpace(strings.Trim(code, `"`)), 10, 64)
	if err != nil {
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

func (f FlexString) String() string { return string(f) }

// FlexInt64 coerces JSON numbers or numeric strings into an int64 (e.g. OAuth
// expires_in arrives as the STRING "3599").
type FlexInt64 int64

// UnmarshalJSON accepts numbers and numeric strings.
func (f *FlexInt64) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	s = strings.Trim(s, `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return fmt.Errorf("mpesa: cannot parse %s as integer", b)
	}
	*f = FlexInt64(v)
	return nil
}

// Shared enum values using Safaricom's exact spellings.
const (
	TransactionTypePayBillOnline  = "CustomerPayBillOnline"
	TransactionTypeBuyGoodsOnline = "CustomerBuyGoodsOnline"

	CommandSalaryPayment          = "SalaryPayment"
	CommandBusinessPayment        = "BusinessPayment"
	CommandPromotionPayment       = "PromotionPayment"
	CommandTransactionStatusQuery = "TransactionStatusQuery"
	CommandTransactionReversal    = "TransactionReversal"
	CommandAccountBalance         = "AccountBalance"

	ResponseTypeCompleted = "Completed"
	ResponseTypeCancelled = "Cancelled"

	IdentifierOrgShortcode = "4"
	ReceiverIdentifierOrg  = "11"

	QRTrxBuyGoods            = "BG"
	QRTrxWithdrawAtAgentTill = "WA"
	QRTrxPaybill             = "PB"
	QRTrxSendMoney           = "SM"
	QRTrxSendToBusiness      = "SB"
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
type B2CPayoutRequest struct {
	OriginatorConversationID string `json:"OriginatorConversationID,omitempty"`
	InitiatorName            string `json:"InitiatorName"`
	SecurityCredential       string `json:"SecurityCredential"`
	CommandID                string `json:"CommandID"`
	Amount                   int64  `json:"Amount"`
	PartyA                   string `json:"PartyA"`
	PartyB                   string `json:"PartyB"`
	Remarks                  string `json:"Remarks"`
	QueueTimeOutURL          string `json:"QueueTimeOutURL"`
	ResultURL                string `json:"ResultURL"`
	Occassion                string `json:"Occassion,omitempty"`
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
type TransactionStatusRequest struct {
	Initiator              string `json:"Initiator"`
	SecurityCredential     string `json:"SecurityCredential"`
	CommandID              string `json:"CommandID,omitempty"`
	TransactionID          string `json:"TransactionID,omitempty"`
	OriginalConversationID string `json:"OriginalConversationID,omitempty"`
	PartyA                 string `json:"PartyA"`
	IdentifierType         string `json:"IdentifierType,omitempty"`
	ResultURL              string `json:"ResultURL"`
	QueueTimeOutURL        string `json:"QueueTimeOutURL"`
	Remarks                string `json:"Remarks"`
	Occasion               string `json:"Occasion,omitempty"`
}

// ReversalRequest reverses a recent C2B transaction. RecieverIdentifierType
// reproduces Safaricom's misspelling; default "11".
type ReversalRequest struct {
	Initiator              string `json:"Initiator"`
	SecurityCredential     string `json:"SecurityCredential"`
	CommandID              string `json:"CommandID,omitempty"`
	TransactionID          string `json:"TransactionID"`
	Amount                 int64  `json:"Amount"`
	ReceiverParty          string `json:"ReceiverParty"`
	RecieverIdentifierType string `json:"RecieverIdentifierType,omitempty"`
	ResultURL              string `json:"ResultURL"`
	QueueTimeOutURL        string `json:"QueueTimeOutURL"`
	Remarks                string `json:"Remarks"`
}

// AccountBalanceRequest queries organization shortcode balances.
type AccountBalanceRequest struct {
	Initiator          string `json:"Initiator"`
	SecurityCredential string `json:"SecurityCredential"`
	CommandID          string `json:"CommandID,omitempty"`
	PartyA             string `json:"PartyA"`
	IdentifierType     string `json:"IdentifierType,omitempty"`
	Remarks            string `json:"Remarks"`
	QueueTimeOutURL    string `json:"QueueTimeOutURL"`
	ResultURL          string `json:"ResultURL"`
}

// C2BRegisterRequest registers validation/confirmation callback URLs (v2).
type C2BRegisterRequest struct {
	ShortCode       string `json:"ShortCode,omitempty"`
	ResponseType    string `json:"ResponseType"`
	ConfirmationURL string `json:"ConfirmationURL"`
	ValidationURL   string `json:"ValidationURL"`
}

// C2BSimulateRequest fakes an inbound payment (sandbox only).
type C2BSimulateRequest struct {
	ShortCode     string `json:"ShortCode,omitempty"`
	CommandID     string `json:"CommandID"`
	Amount        int64  `json:"Amount"`
	Msisdn        string `json:"Msisdn"`
	BillRefNumber string `json:"BillRefNumber,omitempty"`
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
	MerchantName string `json:"MerchantName"`
	RefNo        string `json:"RefNo"`
	Amount       int64  `json:"Amount"`
	TrxCode      string `json:"TrxCode"`
	CPI          string `json:"CPI"`
	Size         string `json:"Size"`
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

// MetadataMap flattens callback metadata items, tolerating absent metadata.
func (r StkCallbackResult) MetadataMap() map[string]any {
	out := make(map[string]any)
	if r.CallbackMetadata == nil {
		return out
	}
	for _, item := range r.CallbackMetadata.Item {
		out[item.Name] = item.decodedValue()
	}
	return out
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

func (m MetadataItem) decodedValue() any {
	var f float64
	if err := json.Unmarshal(m.Value, &f); err == nil {
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

// BalanceSegment is one parsed account row of an Account Balance result.
type BalanceSegment struct {
	AccountName string
	Currency    string
	Available   float64
	Uncleared   float64
	Reserved    float64
	Min         float64
}
