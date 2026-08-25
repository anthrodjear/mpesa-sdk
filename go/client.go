// Client: concurrency-safe Daraja transport with generation-guarded token
// caching, redirect refusal and typed error surfacing.
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

	errCodeInvalidToken = "401.003.01"

	defaultTimeout = 30 * time.Second
	maxResponseLen = 1 << 20
)

// Client is a concurrency-safe Daraja API engine. Create one per environment
// and share it; the OAuth token cache is guarded internally.
//
// Token refresh holds the WRITE lock across the OAuth round-trip — a
// deliberate ~once-per-refresh-window stall traded for strict single-flight,
// because requesting a token invalidates every previously issued one. Across
// replicas there is effectively ONE logical token owner per credential per
// deployment: sibling refreshes invalidate each other's cached tokens by
// design (docs/apis/oauth.md); the 401.003.01 generation guard below handles
// that cross-owner case without a refresh stampede.
type Client struct {
	cfg     Config
	baseURL string
	http    *http.Client

	mu          sync.RWMutex
	token       string
	tokenExpiry time.Time // now + clamp(ExpiresIn-60s); zero until first fetch
	gen         uint64    // bumped on every successful refresh
}

// NewClient returns a Client for cfg. Timeout defaults to 30s and Now to
// time.Now when unset. An injected Config.HTTPClient is cloned (never
// mutated) and always gets the never-follow-redirects policy: Daraja never
// legitimately redirects, and following 307/308 would replay request bodies
// against an arbitrary Location host.
func NewClient(cfg Config) *Client {
	if cfg.Timeout <= 0 {
		cfg.Timeout = defaultTimeout
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	hc := &http.Client{Timeout: cfg.Timeout}
	if cfg.HTTPClient != nil {
		cloned := *cfg.HTTPClient
		if cloned.Timeout <= 0 {
			cloned.Timeout = cfg.Timeout
		}
		hc = &cloned
	}
	hc.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{
		cfg:     cfg,
		baseURL: cfg.Environment.BaseURL(),
		http:    hc,
	}
}

// Token returns the cached Bearer token, refreshing it single-flight before
// expiry (cadence derived from expires_in minus a 60s safety margin, clamped
// to at most 50 minutes — a fresh fetch invalidates the previous token).
// See docs/apis/oauth.md for the full lifecycle rules.
func (c *Client) Token(ctx context.Context) (string, error) {
	tok, _, err := c.tokenWithGen(ctx)
	return tok, err
}

// tokenWithGen pairs the cached bearer with its generation so callers can
// detect a concurrent refresh later.
func (c *Client) tokenWithGen(ctx context.Context) (string, uint64, error) {
	c.mu.RLock()
	tok, gen, fresh := c.token, c.gen, c.tokenFresh()
	c.mu.RUnlock()
	if fresh {
		return tok, gen, nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.tokenFresh() {
		return c.token, c.gen, nil
	}
	if _, err := c.refreshLocked(ctx); err != nil {
		return "", 0, err
	}
	return c.token, c.gen, nil
}

func (c *Client) tokenFresh() bool {
	return c.token != "" && c.cfg.Now().Before(c.tokenExpiry)
}

// refreshCadence converts the OAuth TTL into an eager refresh window:
// TTL minus a 60s safety margin, clamped to [1s, 50min]. Unknown/zero TTLs
// fall back to the legacy 50-minute cadence.
func refreshCadence(expiresIn FlexInt64) time.Duration {
	const (
		maxCadence = 50 * time.Minute
		minCadence = time.Second
		safety     = time.Minute
	)
	secs := int64(expiresIn)
	if secs <= 0 {
		return maxCadence
	}
	d := time.Duration(secs)*time.Second - safety
	if d < minCadence {
		d = minCadence
	}
	if d > maxCadence {
		d = maxCadence
	}
	return d
}

func (c *Client) refreshLocked(ctx context.Context) (string, error) {
	if c.cfg.ConsumerKey == "" || c.cfg.ConsumerSecret == "" {
		return "", fmt.Errorf("mpesa: Config.ConsumerKey and Config.ConsumerSecret are required before calling any endpoint")
	}
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
	contentType := resp.Header.Get("Content-Type")
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseLen+1))
	if err != nil {
		return "", fmt.Errorf("mpesa: read oauth response: %w", err)
	}
	if len(body) > maxResponseLen {
		return "", fmt.Errorf("mpesa: %s response exceeds %d bytes", oauthPath, maxResponseLen)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", parseError(resp.StatusCode, contentType, body)
	}
	var tok oauthTokenResponse
	if err := json.Unmarshal(body, &tok); err != nil {
		return "", fmt.Errorf("mpesa: decode oauth response: %w", err)
	}
	if tok.AccessToken == "" {
		return "", fmt.Errorf("mpesa: oauth response missing access_token")
	}
	now := c.cfg.Now()
	c.token = tok.AccessToken
	c.tokenExpiry = now.Add(refreshCadence(tok.ExpiresIn))
	c.gen++
	return c.token, nil
}

// forceRefreshLocked discards the cached token unconditionally before
// refetching. After a 401.003.01 the cached value cannot be trusted even if
// fresh by wall-clock: Daraja invalidates ALL previously issued tokens the
// moment ANY holder requests a new one (docs/apis/oauth.md) — including
// sibling replicas sharing the credential.
func (c *Client) forceRefreshLocked(ctx context.Context) (string, error) {
	c.token = ""
	return c.refreshLocked(ctx)
}

// refreshAfterInvalidToken resolves a 401.003.01 under the generation guard.
// If our view of the token was current when it failed (gen unchanged), we
// lead the hard refresh; otherwise a concurrent caller already refreshed and
// we adopt its token without another OAuth round-trip.
func (c *Client) refreshAfterInvalidToken(ctx context.Context, myGen uint64) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen == myGen {
		return c.forceRefreshLocked(ctx)
	}
	if c.tokenFresh() {
		return c.token, nil
	}
	return c.forceRefreshLocked(ctx)
}

func (c *Client) attempt(ctx context.Context, token, path string, payload any) (status int, contentType string, body []byte, err error) {
	buf, err := json.Marshal(payload)
	if err != nil {
		return 0, "", nil, fmt.Errorf("mpesa: encode %s request: %w", path, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(buf))
	if err != nil {
		return 0, "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, "", nil, fmt.Errorf("mpesa: POST %s: %w", path, err)
	}
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	body, err = io.ReadAll(io.LimitReader(resp.Body, maxResponseLen+1))
	if err != nil {
		return 0, ct, nil, fmt.Errorf("mpesa: read %s response: %w", path, err)
	}
	if len(body) > maxResponseLen {
		return 0, ct, nil, fmt.Errorf("mpesa: %s response exceeds %d bytes", path, maxResponseLen)
	}
	return resp.StatusCode, ct, body, nil
}

// post performs an authenticated business call. On HTTP 401 carrying
// errorCode 401.003.01 (invalid/expired token) it force-refreshes the token
// once under the generation guard and retries the business call exactly once
// before surfacing errors.
func (c *Client) post(ctx context.Context, path string, payload any, out any) error {
	tok, gen, err := c.tokenWithGen(ctx)
	if err != nil {
		return err
	}
	status, contentType, body, err := c.attempt(ctx, tok, path, payload)
	if err != nil {
		return err
	}

	if status == http.StatusUnauthorized {
		var probe errorEnvelope
		if json.Unmarshal(body, &probe) == nil && probe.ErrorCode == errCodeInvalidToken {
			freshTok, ferr := c.refreshAfterInvalidToken(ctx, gen)
			if ferr != nil {
				return ferr
			}
			status, contentType, body, err = c.attempt(ctx, freshTok, path, payload)
			if err != nil {
				return err
			}
		}
	}

	if status < 200 || status > 299 {
		return parseError(status, contentType, body)
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
// Timestamp derive from ONE shared EAT instant per call. Injected defaults:
// BusinessShortCode ← cfg.Shortcode and PartyB ← BusinessShortCode when
// empty; TransactionType has NO default and must be set explicitly.
// See docs/apis/stk-push.md for field constraints and the ResultCode catalog.
func (c *Client) STKPush(ctx context.Context, r STKPushRequest) (*STKPushResponse, error) {
	if r.BusinessShortCode == "" {
		r.BusinessShortCode = c.cfg.Shortcode
	}
	if r.PartyB == "" {
		r.PartyB = r.BusinessShortCode
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	// Password binds to the shortcode actually sent — divergent values cause
	// 500.001.1001 credential mismatches.
	password, timestamp, err := GeneratePassword(r.BusinessShortCode, c.cfg.Passkey, c.cfg.Now())
	if err != nil {
		return nil, err
	}
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
// BusinessShortCode ← cfg.Shortcode when empty; the injected Password binds
// to the EFFECTIVE shortcode either way. See docs/apis/stk-query.md.
func (c *Client) STKQuery(ctx context.Context, r STKQueryRequest) (*STKQueryResponse, error) {
	if err := r.Validate(); err != nil {
		return nil, err
	}
	effectiveShortcode := r.BusinessShortCode
	if effectiveShortcode == "" {
		effectiveShortcode = c.cfg.Shortcode
	}
	password, timestamp, err := GeneratePassword(effectiveShortcode, c.cfg.Passkey, c.cfg.Now())
	if err != nil {
		return nil, err
	}
	payload := stkQueryPayload{
		BusinessShortCode: effectiveShortcode,
		Password:          password,
		Timestamp:         timestamp,
		CheckoutRequestID: r.CheckoutRequestID,
	}

	var out STKQueryResponse
	if err := c.post(ctx, stkQueryPath, payload, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// stkQueryPayload mirrors the documented STK Query wire shape; STKQueryRequest
// cannot be embedded here because its BusinessShortCode participates in
// password derivation alongside the injected fields.
type stkQueryPayload struct {
	BusinessShortCode string `json:"BusinessShortCode"`
	Password          string `json:"Password"`
	Timestamp         string `json:"Timestamp"`
	CheckoutRequestID string `json:"CheckoutRequestID"`
}

// B2CPayout pays a registered shortcode out to a customer MSISDN (async).
// Injected defaults: OriginatorConversationID auto-generated (16 lowercase
// hex chars, ≤20 per Daraja constraint, idempotency key for retries),
// PartyA ← cfg.Shortcode when empty. SecurityCredential must come from
// mpesa.SecurityCredential(). See docs/apis/b2c.md.
func (c *Client) B2CPayout(ctx context.Context, r B2CPayoutRequest) (*B2CResponse, error) {
	if r.OriginatorConversationID == "" {
		ocid, oerr := newOriginatorID()
		if oerr != nil {
			return nil, fmt.Errorf("mpesa: generate OriginatorConversationID: %w", oerr)
		}
		r.OriginatorConversationID = ocid
	}
	if r.PartyA == "" {
		r.PartyA = c.cfg.Shortcode
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
// Injected defaults: CommandID ← TransactionStatusQuery, IdentifierType ← "4"
// (organization shortcode). See docs/apis/transaction-status.md.
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

// Reversal reverses a recent C2B transaction — C2B ONLY: B2C payouts cannot
// be reversed through this API and must be handled manually via the M-PESA
// portal. Injected defaults: CommandID ← TransactionReversal,
// ReceiverIdentifierType ← "11" (wire key stays Safaricom's misspelled
// RecieverIdentifierType). See docs/apis/reversal.md.
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

// AccountBalance queries organization shortcode balances (async). Injected
// defaults: CommandID ← AccountBalance, IdentifierType ← "4". See
// docs/apis/account-balance.md for the balance-blob format.
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
// ShortCode ← cfg.Shortcode when empty. Production registration is
// effectively one-shot. See docs/apis/c2b.md.
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

// C2BSimulate fakes an inbound payment (sandbox only). ShortCode ←
// cfg.Shortcode when empty. See docs/apis/c2b.md.
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

// GenerateQRCode creates a dynamic M-PESA QR image payload (fully
// synchronous). See docs/apis/dynamic-qr.md.
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
