package mpesa

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// Documented endpoint paths (docs/apis/*). Casing and version segments are
// contractual.
const (
	oauthPath          = "/oauth/v1/generate?grant_type=client_credentials"
	stkPushPath        = "/mpesa/stkpush/v1/processrequest"
	stkQueryPath       = "/mpesa/stkpushquery/v1/query"
	b2cPath            = "/mpesa/b2c/v3/paymentrequest"
	c2bRegisterPath    = "/mpesa/c2b/v2/registerurl"
	c2bSimulatePath    = "/mpesa/c2b/v2/simulate"
	txStatusPath       = "/mpesa/transactionstatus/v1/query"
	reversalPath       = "/mpesa/reversal/v1/request"
	accountBalancePath = "/mpesa/accountbalance/v1/query"
	qrCodePath         = "/mpesa/qrcode/v1/generate"

	// Tokens live ~1h but a new fetch invalidates the previous one, so the
	// cache refreshes proactively at 50 minutes under a single-flight lock.
	tokenRefreshAfter = 50 * time.Minute

	errCodeInvalidToken = "401.003.01"

	defaultTimeout = 30 * time.Second
	maxResponseLen = 1 << 20
)

// Client is a concurrency-safe Daraja API engine. Create one per environment
// and share it; the OAuth token cache is guarded internally.
type Client struct {
	cfg     Config
	baseURL string
	http    *http.Client

	mu        sync.RWMutex
	token     string
	fetchedAt time.Time
}

// NewClient returns a Client for cfg. Timeout defaults to 30s and Now to
// time.Now when unset.
func NewClient(cfg Config) *Client {
	if cfg.Timeout <= 0 {
		cfg.Timeout = defaultTimeout
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Client{
		cfg:     cfg,
		baseURL: cfg.Environment.BaseURL(),
		http:    &http.Client{Timeout: cfg.Timeout},
	}
}

// Token returns the cached Bearer token, refreshing it single-flight when it
// is older than 50 minutes (a fresh fetch invalidates the previous token).
func (c *Client) Token(ctx context.Context) (string, error) {
	c.mu.RLock()
	tok, fresh := c.token, c.tokenFresh()
	c.mu.RUnlock()
	if fresh {
		return tok, nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.tokenFresh() {
		return c.token, nil
	}
	return c.refreshLocked(ctx)
}

func (c *Client) tokenFresh() bool {
	return c.token != "" && c.cfg.Now().Sub(c.fetchedAt) < tokenRefreshAfter
}

func (c *Client) refreshLocked(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+oauthPath, nil)
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(c.cfg.ConsumerKey, c.cfg.ConsumerSecret)
	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("mpesa: oauth request: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseLen))
	if err != nil {
		return "", fmt.Errorf("mpesa: read oauth response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", parseError(resp.StatusCode, body)
	}
	var tok struct {
		AccessToken string    `json:"access_token"`
		ExpiresIn   FlexInt64 `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return "", fmt.Errorf("mpesa: decode oauth response: %w", err)
	}
	if tok.AccessToken == "" {
		return "", fmt.Errorf("mpesa: oauth response missing access_token")
	}
	c.token = tok.AccessToken
	c.fetchedAt = c.cfg.Now()
	return c.token, nil
}

func (c *Client) forceRefresh(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.token = ""
	return c.refreshLocked(ctx)
}

type errorEnvelope struct {
	RequestID    string `json:"requestId"`
	ErrorCode    string `json:"errorCode"`
	ErrorMessage string `json:"errorMessage"`
}

func parseError(status int, body []byte) error {
	var env errorEnvelope
	_ = json.Unmarshal(body, &env)
	return &Error{StatusCode: status, RequestID: env.RequestID, ErrorCode: env.ErrorCode, ErrorMessage: env.ErrorMessage}
}

func (c *Client) attempt(ctx context.Context, token, path string, payload any) (int, []byte, error) {
	buf, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, fmt.Errorf("mpesa: encode %s request: %w", path, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(buf))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("mpesa: POST %s: %w", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseLen))
	if err != nil {
		return 0, nil, fmt.Errorf("mpesa: read %s response: %w", path, err)
	}
	return resp.StatusCode, body, nil
}

// post performs an authenticated business call. On HTTP 401 carrying
// errorCode 401.003.01 (invalid/expired token), it force-refreshes the token
// once and retries the business call exactly once before surfacing errors.
func (c *Client) post(ctx context.Context, path string, payload any, out any) error {
	tok, err := c.Token(ctx)
	if err != nil {
		return err
	}
	status, body, err := c.attempt(ctx, tok, path, payload)
	if err != nil {
		return err
	}

	if status == http.StatusUnauthorized {
		var probe errorEnvelope
		if json.Unmarshal(body, &probe) == nil && probe.ErrorCode == errCodeInvalidToken {
			freshTok, ferr := c.forceRefresh(ctx)
			if ferr != nil {
				return ferr
			}
			status, body, err = c.attempt(ctx, freshTok, path, payload)
			if err != nil {
				return err
			}
		}
	}

	if status < 200 || status > 299 {
		return parseError(status, body)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("mpesa: decode %s response: %w", path, err)
	}
	return nil
}

// STKPush sends a payment prompt to the customer's phone. Password and
// Timestamp derive from ONE shared EAT instant per call.
func (c *Client) STKPush(ctx context.Context, r STKPushRequest) (*STKPushResponse, error) {
	if r.BusinessShortCode == "" {
		r.BusinessShortCode = c.cfg.Shortcode
	}
	if r.PartyB == "" {
		r.PartyB = r.BusinessShortCode
	}
	if r.TransactionType == "" {
		r.TransactionType = TransactionTypePayBillOnline
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	// Password binds to the shortcode actually sent — divergent values cause
	// 500.001.1001 credential mismatches.
	password, timestamp := GeneratePassword(r.BusinessShortCode, c.cfg.Passkey, c.cfg.Now())
	payload := struct {
		STKPushRequest
		Password  string `json:"Password"`
		Timestamp string `json:"Timestamp"`
	}{STKPushRequest: r, Password: password, Timestamp: timestamp}

	var out STKPushResponse
	if err := c.post(ctx, stkPushPath, payload, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// STKQuery checks the outcome of a push; the fallback when callbacks are late.
func (c *Client) STKQuery(ctx context.Context, r STKQueryRequest) (*STKQueryResponse, error) {
	if err := r.Validate(); err != nil {
		return nil, err
	}
	password, timestamp := GeneratePassword(c.cfg.Shortcode, c.cfg.Passkey, c.cfg.Now())
	payload := struct {
		BusinessShortCode string `json:"BusinessShortCode"`
		Password          string `json:"Password"`
		Timestamp         string `json:"Timestamp"`
		STKQueryRequest
	}{BusinessShortCode: c.cfg.Shortcode, Password: password, Timestamp: timestamp, STKQueryRequest: r}

	var out STKQueryResponse
	if err := c.post(ctx, stkQueryPath, payload, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// B2CPayout pays a registered shortcode out to a customer MSISDN (async).
func (c *Client) B2CPayout(ctx context.Context, r B2CPayoutRequest) (*B2CResponse, error) {
	if r.OriginatorConversationID == "" {
		r.OriginatorConversationID = newOriginatorID()
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	var out B2CResponse
	if err := c.post(ctx, b2cPath, r, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// TransactionStatus queries any transaction by receipt XOR conversation ID.
func (c *Client) TransactionStatus(ctx context.Context, r TransactionStatusRequest) (*ConversationResponse, error) {
	if r.CommandID == "" {
		r.CommandID = CommandTransactionStatusQuery
	}
	if r.IdentifierType == "" {
		r.IdentifierType = IdentifierOrgShortcode
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	var out ConversationResponse
	if err := c.post(ctx, txStatusPath, r, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Reversal reverses a recent C2B transaction (B2C payouts reverse via portal).
func (c *Client) Reversal(ctx context.Context, r ReversalRequest) (*ConversationResponse, error) {
	if r.CommandID == "" {
		r.CommandID = CommandTransactionReversal
	}
	if r.ReceiverIdentifierType == "" {
		r.ReceiverIdentifierType = ReceiverIdentifierOrg
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	var out ConversationResponse
	if err := c.post(ctx, reversalPath, r, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AccountBalance queries organization shortcode balances (async).
func (c *Client) AccountBalance(ctx context.Context, r AccountBalanceRequest) (*ConversationResponse, error) {
	if r.CommandID == "" {
		r.CommandID = CommandAccountBalance
	}
	if r.IdentifierType == "" {
		r.IdentifierType = IdentifierOrgShortcode
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	var out ConversationResponse
	if err := c.post(ctx, accountBalancePath, r, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// C2BRegisterURL registers validation/confirmation callback URLs (v2).
// Production registration is effectively one-shot.
func (c *Client) C2BRegisterURL(ctx context.Context, r C2BRegisterRequest) (*C2BAckResponse, error) {
	if r.ShortCode == "" {
		r.ShortCode = c.cfg.Shortcode
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	var out C2BAckResponse
	if err := c.post(ctx, c2bRegisterPath, r, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// C2BSimulate fakes an inbound payment (sandbox only).
func (c *Client) C2BSimulate(ctx context.Context, r C2BSimulateRequest) (*C2BAckResponse, error) {
	if r.ShortCode == "" {
		r.ShortCode = c.cfg.Shortcode
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	var out C2BAckResponse
	if err := c.post(ctx, c2bSimulatePath, r, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GenerateQRCode creates a dynamic M-PESA QR image payload (fully synchronous).
func (c *Client) GenerateQRCode(ctx context.Context, r QRCodeRequest) (*QRCodeResponse, error) {
	if err := r.Validate(); err != nil {
		return nil, err
	}
	var out QRCodeResponse
	if err := c.post(ctx, qrCodePath, r, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
