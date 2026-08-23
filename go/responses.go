// Responses: synchronous acknowledgement payloads.

package mpesa

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
