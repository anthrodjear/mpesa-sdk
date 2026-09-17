// Responses: synchronous acknowledgement payloads.

package mpesa

import "fmt"

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

// C2BAckResponse matches Safaricom's unique ACK shape: the misspelled
// OriginatorCoversationID key and NO ConversationID field.
type C2BAckResponse struct {
	OriginatorConversationID string `json:"OriginatorCoversationID"`
	ResponseCode             string `json:"ResponseCode"`
	ResponseDescription      string `json:"ResponseDescription"`
}

// QRCodeResponse exposes the QR payload verbatim. ResponseCode here is an
// opaque alphanumeric tracking string, not a status code.
type QRCodeResponse struct {
	ResponseCode        string `json:"ResponseCode"`
	RequestID           string `json:"RequestID"`
	ResponseDescription string `json:"ResponseDescription"`
	QRCode              string `json:"QRCode"`
}

// oauthTokenResponse is the GET /oauth/v1/generate payload; ExpiresIn
// coerces Safaricom's string-or-number expires_in encodings.
type oauthTokenResponse struct {
	AccessToken string    `json:"access_token"`
	ExpiresIn   FlexInt64 `json:"expires_in"`
}

// redactedOAuth renders the token response without the bearer value: only
// the token LENGTH (proof of presence/shape) and the TTL are shown. The
// bearer is a live credential — even len+prefix would aid brute-force
// validation, so only len is exposed and never any token bytes.
func (t oauthTokenResponse) redactedOAuth() string {
	return fmt.Sprintf("oauthTokenResponse{access_token_len:%d expires_in:%d}", len(t.AccessToken), int64(t.ExpiresIn))
}

// String redacts the bearer token (len-only, never the bearer) for %v/%s
// formatting so accidental log.Printf("%v", tok) cannot leak credentials.
func (t oauthTokenResponse) String() string { return t.redactedOAuth() }

// GoString redacts the bearer token (len-only, never the bearer) for %#v
// formatting.
func (t oauthTokenResponse) GoString() string { return t.redactedOAuth() }

// Format routes EVERY fmt verb through the redacted form (GoStringer only
// covers %#v and Stringer only %v/%s, while %+v on a struct with no Format
// prints raw fields including the bearer).
func (t oauthTokenResponse) Format(f fmt.State, verb rune) {
	_, _ = fmt.Fprint(f, t.redactedOAuth())
}
