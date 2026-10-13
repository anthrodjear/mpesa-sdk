// Client: concurrency-safe Daraja transport with generation-guarded token
// caching, redirect refusal and typed error surfacing.
package mpesa

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
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

	defaultTimeout   = 30 * time.Second
	maxResponseLen   = 1 << 20
	refreshRateLimit = 5 * time.Second // minimum time between OAuth refresh attempts
)

// pinnedSPKIHashes maps hostnames to their expected SPKI SHA-256 hashes.
// A hostname may have multiple pins (e.g. current + backup key).
//
// The map is a process-global registry read ONCE per NewClient (see
// pinnedPinsSnapshot). Handshake callbacks never read it: a pin registered
// after a client was built must not silently change the trust decision of a
// client that is already serving traffic, and reading shared state from the
// TLS handshake goroutine would make that decision depend on call ordering
// rather than on configuration.
var (
	pinnedSPKIHashes = make(map[string][][]byte)
	pinnedSPKIMutex  sync.RWMutex
)

// PinSPKI registers an expected SPKI SHA-256 hash for a hostname. When TLS
// pinning is enabled and the client connects to this hostname, the server's
// certificate SPKI hash must match one of the registered pins or the
// connection is rejected.
//
// The hash is the SHA-256 of the DER-encoded SubjectPublicKeyInfo (SPKI)
// of the server's RSA public key. Users should fetch the actual hash from
// the live endpoint before pinning.
//
// The hash must be exactly sha256.Size (32) bytes: a shorter or longer value
// can never match a SHA-256 digest, so accepting it would turn pinning into
// a permanent connection failure (or, worse, into a silently accepted
// misconfiguration if a future comparison ever used prefix matching).
// Identical hashes are de-duplicated — registering the same pin twice must
// not grow the pin set, so operators can call PinSPKI defensively from
// multiple initialization paths.
func PinSPKI(hostname string, spkiHash []byte) error {
	if len(spkiHash) != sha256.Size {
		return fmt.Errorf("mpesa: PinSPKI hash must be %d bytes (SHA-256), got %d", sha256.Size, len(spkiHash))
	}
	pinnedSPKIMutex.Lock()
	defer pinnedSPKIMutex.Unlock()
	for _, existing := range pinnedSPKIHashes[hostname] {
		if bytes.Equal(existing, spkiHash) {
			return nil // already registered
		}
	}
	// Clone the caller's slice: storing it as-is would let a later caller
	// mutation move the live pin set (and every snapshot taken from it).
	pinnedSPKIHashes[hostname] = append(pinnedSPKIHashes[hostname], bytes.Clone(spkiHash))
	return nil
}

// pinnedPinsSnapshot copies the pin set registered for hostname so the
// caller owns an immutable view. The copy is taken under the registry mutex
// and never aliases the live map, which keeps every later read lock-free and
// immune to concurrent PinSPKI calls. Each entry is deep-cloned: a shallow
// outer copy would still share the inner 32-byte arrays with the registry,
// so mutating a snapshot entry (or the caller's original slice) would move
// the live pins.
func pinnedPinsSnapshot(hostname string) [][]byte {
	pinnedSPKIMutex.RLock()
	defer pinnedSPKIMutex.RUnlock()
	live := pinnedSPKIHashes[hostname]
	if len(live) == 0 {
		return nil
	}
	out := make([][]byte, len(live))
	for i, pin := range live {
		out[i] = bytes.Clone(pin)
	}
	return out
}

// SPKIVerifier returns a tls.Config.VerifyPeerCertificate callback that
// checks the server's SPKI hash against a caller-supplied pin set.
//
// Export it so users can pin transports this SDK does not own — a
// tracing/retry/logging wrapper chain, an http2.Transport, or a transport
// shared with other components:
//
//	tr := &http.Transport{TLSClientConfig: &tls.Config{
//		VerifyPeerCertificate: mpesa.SPKIVerifier(host, pins),
//	}}
//
// The returned closure fails closed. An empty pin set is an error rather than
// an allow, because "pinning requested but nothing to compare against" is a
// configuration mistake that must not degrade into unauthenticated TLS.
//
// The pin set is deep-cloned at construction: the closure must enforce the
// pins as registered, not whatever the caller's slice (or its inner arrays)
// happens to hold when a handshake runs.
func SPKIVerifier(hostname string, pins [][]byte) func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
	cloned := make([][]byte, len(pins))
	for i, pin := range pins {
		cloned[i] = bytes.Clone(pin)
	}
	return func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
		if len(rawCerts) == 0 {
			return fmt.Errorf("mpesa: no certificates presented by server")
		}

		leaf, err := x509.ParseCertificate(rawCerts[0])
		if err != nil {
			return fmt.Errorf("mpesa: failed to parse server certificate: %w", err)
		}

		spkiDER, err := x509.MarshalPKIXPublicKey(leaf.PublicKey)
		if err != nil {
			return fmt.Errorf("mpesa: failed to marshal server public key: %w", err)
		}

		hash := sha256.Sum256(spkiDER)

		// Defense in depth: NewClient already refuses to build a pinned
		// client from an empty pin set, so reaching this point means the
		// closure was reached through a hand-built transport. Never allow
		// on an empty set.
		if len(cloned) == 0 {
			return fmt.Errorf("mpesa: TLS pinning enabled for %s with no SPKI pins registered; refusing connection", hostname)
		}

		for _, pin := range cloned {
			if bytes.Equal(hash[:], pin) {
				return nil // Pin matches
			}
		}

		return fmt.Errorf("mpesa: TLS certificate pinning failed for %s: SPKI hash mismatch", hostname)
	}
}

// hostnameFromURL extracts the hostname from a URL string.
func hostnameFromURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// Client is a concurrency-safe Daraja API engine. Create one per environment
// and share it; the OAuth token cache is guarded internally.
//
// Token refresh is single-flight and runs OUTSIDE the client mutex: exactly
// one goroutine performs the OAuth round-trip while every other caller waits
// on a completion channel and then re-checks freshness under double-checked
// locking. A slow or hung OAuth endpoint therefore stalls only the token
// path — it never pins c.mu for the whole round-trip, so readers of a cached
// token keep being served.
//
// Cross-replica note: requesting a token invalidates every previously issued
// one (docs/apis/oauth.md), so sibling replicas refreshing the same credential
// invalidate each other's cached tokens by design; the 401.003.01 generation
// guard below absorbs that cross-owner case without a refresh stampede.
type Client struct {
	cfg     Config
	baseURL string
	http    *http.Client

	mu          sync.RWMutex
	tokenBytes  []byte    // cached OAuth bearer token; zeroed on refresh/Close
	tokenExpiry time.Time // now + clamp(ExpiresIn-60s); zero until first fetch
	gen         uint64    // bumped on every successful refresh

	lastRefreshAttempt time.Time // wall-clock of last refresh attempt (for rate limiting)
	refreshFailures    int       // consecutive refresh failures; reset on success

	// refreshing is true while a refresh leader is performing its OAuth
	// round-trip WITHOUT holding mu; refreshDone is closed when that leader
	// finishes (success or failure) so waiters can re-check freshness.
	// Together they implement single-flight without holding the lock across
	// network I/O.
	refreshing  bool
	refreshDone chan struct{}

	// limits is the resolved per-service ceiling set (Config.Limits or the
	// Safaricom baseline), frozen at construction so a request can never be
	// validated against a different policy than the one the Client reports.
	limits TransactionLimits
	// daily accumulates per-service totals for the current Africa/Nairobi
	// day. It is only consulted when cfg.TrackDaily is set: an unused
	// accumulator is a silent under-count (see Config.TrackDaily).
	daily dailyLedger
}

// transportDisablesVerification walks the RoundTripper chain looking for any
// *http.Transport with TLSClientConfig.InsecureSkipVerify=true.
//
// Why the walk (Context7 net/http baseline): http.Client.Transport is an
// interface — production tracing/retry/logging wrappers commonly embed a
// *http.Transport behind Unwrap() http.RoundTripper. Checking only the
// outermost type with `tr, ok := rt.(*http.Transport)` misses an insecure
// inner transport entirely. The loop unwraps via
// `interface{ Unwrap() http.RoundTripper }` until it finds a concrete
// *http.Transport (terminal verdict) or a RoundTripper that does not
// unwrap (nothing more to inspect → safe). A nil Transport means
// http.DefaultTransport (verification on) → safe; a *http.Transport with
// nil TLSClientConfig also verifies → safe.
func transportDisablesVerification(rt http.RoundTripper) bool {
	for rt != nil {
		if tr, ok := rt.(*http.Transport); ok {
			// Concrete transport reached: verdict depends solely on its
			// TLSClientConfig. No further unwrapping is possible.
			return tr != nil && tr.TLSClientConfig != nil && tr.TLSClientConfig.InsecureSkipVerify
		}
		// Not a concrete transport — descend through wrappers that
		// expose their inner RoundTripper (standard library convention
		// for Transport wrappers since Go 1.14-adjacent patterns).
		unwrapper, ok := rt.(interface{ Unwrap() http.RoundTripper })
		if !ok {
			return false
		}
		rt = unwrapper.Unwrap()
	}
	return false
}

// NewClient returns a Client for cfg. Timeout defaults to 30s and Now to
// time.Now when unset. An injected Config.HTTPClient is cloned (never
// mutated) and always gets the never-follow-redirects policy: Daraja never
// legitimately redirects, and following 307/308 would replay request bodies
// against an arbitrary Location host.
//
// Security: an injected Transport with InsecureSkipVerify=true is refused
// outright (fail-closed, Python verify=True parity), including when hidden
// behind wrapper RoundTrippers (tracing, retry, logging) that implement
// Unwrap() http.RoundTripper. A test-only insecure transport accidentally
// wired in production would otherwise MITM the OAuth Basic credential,
// bearer tokens, SecurityCredential and PII. Custom RoundTrippers must
// preserve TLS verification — never set InsecureSkipVerify, even on an
// inner *http.Transport, and wrappers must expose Unwrap() so the check
// can see through them.
//
// TLS pinning (cfg.TLSPinningEnabled) is enforced, never simulated: the pin
// set for the configured host is snapshotted once here, and NewClient fails
// closed when no pin is registered. Pinning is installed by cloning the
// concrete *http.Transport (nil Transport ⇒ a pinned clone of
// http.DefaultTransport), which preserves Proxy/DialContext/RootCAs and any
// pre-existing VerifyPeerCertificate. A wrapper chain or an opaque custom
// RoundTripper CANNOT be pinned — replacing it would silently discard the
// caller's tracing/retry/logging behaviour, and leaving it in place would
// silently disable pinning — so NewClient returns an actionable error and
// tells the caller to install the verifier themselves (see SPKIVerifier).
func NewClient(cfg Config) (*Client, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = defaultTimeout
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	hc := &http.Client{Timeout: cfg.Timeout}
	if cfg.HTTPClient != nil {
		if transportDisablesVerification(cfg.HTTPClient.Transport) {
			return nil, fmt.Errorf("mpesa: refusing HTTPClient with InsecureSkipVerify (would disable TLS verification)")
		}
		cloned := *cfg.HTTPClient
		if cloned.Timeout <= 0 {
			cloned.Timeout = cfg.Timeout
		}
		hc = &cloned
	}
	if cfg.TLSPinningEnabled {
		hostname := hostnameFromURL(cfg.Environment.BaseURL())
		// Snapshot ONCE at construction. The verify closure reads only this
		// copy: pins registered after NewClient must not retroactively change
		// a live client, and an empty set is a fail-closed configuration
		// error rather than "allow everything".
		pins := pinnedPinsSnapshot(hostname)
		if len(pins) == 0 {
			return nil, fmt.Errorf("mpesa: TLSPinningEnabled for %s but PinSPKI registered no pin; refusing to build an unpinned client (fail closed): register the SPKI SHA-256 before NewClient", hostname)
		}
		verify := SPKIVerifier(hostname, pins)
		// applyPinning clones tr (preserving Proxy, DialContext,
		// MaxIdleConns, RootCAs, etc.) and only installs the pinning
		// callback, chaining any pre-existing VerifyPeerCertificate.
		applyPinning := func(tr *http.Transport) *http.Transport {
			cloned := tr.Clone()
			if cloned.TLSClientConfig == nil {
				cloned.TLSClientConfig = &tls.Config{}
			}
			if prev := cloned.TLSClientConfig.VerifyPeerCertificate; prev != nil {
				cloned.TLSClientConfig.VerifyPeerCertificate = func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
					if err := prev(rawCerts, verifiedChains); err != nil {
						return err
					}
					return verify(rawCerts, verifiedChains)
				}
			} else {
				cloned.TLSClientConfig.VerifyPeerCertificate = verify
			}
			return cloned
		}
		switch concrete, _ := hc.Transport.(*http.Transport); {
		case hc.Transport == nil:
			// No transport injected: pin a clone of the process default so
			// system Proxy/DialContext/RootCAs tuning survives.
			if dt, ok := http.DefaultTransport.(*http.Transport); ok {
				hc.Transport = applyPinning(dt)
			} else {
				hc.Transport = &http.Transport{TLSClientConfig: &tls.Config{VerifyPeerCertificate: verify}}
			}
		case concrete != nil:
			// Exactly an *http.Transport: pin its clone, keeping every tuned
			// field (Proxy, DialContext, MaxIdleConns, RootCAs...).
			hc.Transport = applyPinning(concrete)
		default:
			// Wrapper chain (tracing/retry) or a fully custom RoundTripper.
			// There is no way to enforce pinning here without either
			// discarding the caller's middleware or silently skipping the
			// check — both are security failures, so refuse and point at
			// SPKIVerifier, which lets callers pin their own transport.
			return nil, fmt.Errorf("mpesa: TLSPinningEnabled cannot be enforced on a custom/wrapped RoundTripper (%T): set VerifyPeerCertificate via mpesa.SPKIVerifier(hostname, pins) on your own *http.Transport instead of letting the SDK silently skip pinning", hc.Transport)
		}
	}
	hc.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{
		cfg:     cfg,
		baseURL: cfg.Environment.BaseURL(),
		http:    hc,
		limits:  cfg.resolvedLimits(),
	}, nil
}

// checkDaily records amount against service's daily ceiling and reports
// whether it fits. It is a no-op unless Config.TrackDaily is set, so the
// opt-in semantics of the accumulator are enforced at the single point every
// dispatched amount flows through.
func (c *Client) checkDaily(service Service, amount int64) error {
	if !c.cfg.TrackDaily {
		return nil
	}
	return c.daily.consume(service, amount, c.limits, nairobiDay(c.cfg.Now()))
}

// Token returns the cached Bearer token, refreshing it single-flight before
// expiry (cadence derived from expires_in minus a 60s safety margin, clamped
// to at most 50 minutes — a fresh fetch invalidates the previous token).
// See docs/apis/oauth.md for the full lifecycle rules.
func (c *Client) Token(ctx context.Context) (string, error) {
	tok, _, err := c.tokenWithGen(ctx)
	return tok, err
}

// setTokenLocked securely replaces the cached token, zeroing the old value
// first to minimise the window where the credential resides in memory.
// Callers must hold c.mu.
func (c *Client) setTokenLocked(newToken string) {
	c.zeroTokenLocked()
	c.tokenBytes = []byte(newToken)
}

// zeroTokenLocked overwrites the cached token bytes with zeros. Callers must
// hold c.mu.
func (c *Client) zeroTokenLocked() {
	for i := range c.tokenBytes {
		c.tokenBytes[i] = 0
	}
	c.tokenBytes = nil
}

// Close zeros the cached token and marks the client as closed. After Close
// the client must not be reused.
func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.zeroTokenLocked()
	c.tokenExpiry = time.Time{}
}

// tokenWithGen pairs the cached bearer with its generation so callers can
// detect a concurrent refresh later.
func (c *Client) tokenWithGen(ctx context.Context) (string, uint64, error) {
	c.mu.RLock()
	tok, gen, fresh := string(c.tokenBytes), c.gen, c.tokenFresh()
	c.mu.RUnlock()
	if fresh {
		return tok, gen, nil
	}
	return c.leadRefresh(ctx)
}

// leadRefresh refreshes the token single-flight without holding c.mu across
// network I/O.
//
// The fast path is a double-checked read under the write lock: a concurrent
// leader may have committed a fresh token between the optimistic read in
// tokenWithGen and acquiring the lock, and spinning up another OAuth
// round-trip would then be pure waste (plus a token that invalidates the one
// we just adopted).
//
// When a refresh is already in flight the caller waits on the leader's
// completion channel instead of blocking the whole client on c.mu, then loops
// back into the double check. Only the leader touches the network; everyone
// else either adopts its result or becomes the next leader after a failure.
func (c *Client) leadRefresh(ctx context.Context) (string, uint64, error) {
	for {
		c.mu.Lock()
		if c.tokenFresh() {
			tok, gen := string(c.tokenBytes), c.gen
			c.mu.Unlock()
			return tok, gen, nil
		}
		if c.refreshing {
			done := c.refreshDone
			c.mu.Unlock()
			// Wait for the leader WITHOUT holding mu (or blocking traffic),
			// but stay cancellable: a hung OAuth endpoint must not pin a
			// waiter past its own context deadline.
			select {
			case <-done: // leader finished; loop back into the double check
			case <-ctx.Done():
				return "", 0, ctx.Err()
			}
			continue
		}
		c.refreshing = true
		c.refreshDone = make(chan struct{})
		done := c.refreshDone
		c.mu.Unlock()

		return c.runRefresh(ctx, done, false)
	}
}

// leadForcedRefresh discards the cached token and runs exactly one OAuth
// round-trip for all concurrent callers. Used after a 401.003.01, where the
// cached value cannot be trusted even if fresh by wall clock.
func (c *Client) leadForcedRefresh(ctx context.Context) (string, error) {
	for {
		c.mu.Lock()
		if c.refreshing {
			done := c.refreshDone
			c.mu.Unlock()
			// Cancellable like leadRefresh: a stalled leader must not pin
			// a waiter past its own context deadline.
			select {
			case <-done:
			case <-ctx.Done():
				return "", ctx.Err()
			}
			// A peer completed a forced refresh: adopt its token rather
			// than issuing a second one (generation guard).
			c.mu.RLock()
			tok, fresh := string(c.tokenBytes), c.tokenFresh()
			c.mu.RUnlock()
			if fresh {
				return tok, nil
			}
			continue
		}
		c.refreshing = true
		c.refreshDone = make(chan struct{})
		done := c.refreshDone
		c.mu.Unlock()

		tok, _, err := c.runRefresh(ctx, done, true)
		return tok, err
	}
}

// runRefresh performs the OAuth round-trip for the elected leader and then
// clears the single-flight bookkeeping, publishing the result to waiters.
// The bookkeeping is cleared BEFORE the channel is closed so every waiter
// observes a consistent (refreshing=false) state after waking.
func (c *Client) runRefresh(ctx context.Context, done chan struct{}, force bool) (string, uint64, error) {
	tok, err := c.refresh(ctx, force)
	c.mu.Lock()
	c.refreshing = false
	c.refreshDone = nil
	gen := c.gen
	c.mu.Unlock()
	close(done)
	return tok, gen, err
}

func (c *Client) tokenFresh() bool {
	return len(c.tokenBytes) > 0 && c.cfg.Now().Before(c.tokenExpiry)
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
	// Guard against integer overflow: time.Duration is int64 nanoseconds,
	// so secs * time.Second overflows when secs > math.MaxInt64 / 1e9.
	// Clamp to a safe maximum to prevent a negative duration that would
	// bypass the minCadence floor and cause a refresh DoS.
	const maxSecs = math.MaxInt64 / int64(time.Second)
	if secs > maxSecs {
		secs = maxSecs
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

// refresh performs one OAuth round-trip in three phases so the network leg
// runs without c.mu held:
//
//  1. pre-flight under the write lock (credential + rate-limit gate)
//  2. the OAuth HTTP round-trip, lock-free
//  3. commit under the write lock (zero the old token, set the new one,
//     bump the generation LAST so a reader never sees a bumped generation
//     with unset fields)
//
// Splitting the phases is what keeps a hung OAuth endpoint from stalling
// every caller: previously the whole round-trip ran under the client write
// lock, so a 30s timeout froze 100% of traffic. The lock is re-acquired only
// for the cheap, CPU-bound work.
func (c *Client) refresh(ctx context.Context, force bool) (string, error) {
	if c.cfg.ConsumerKey == "" || c.cfg.ConsumerSecret == "" {
		return "", fmt.Errorf("mpesa: Config.ConsumerKey and Config.ConsumerSecret are required before calling any endpoint")
	}

	// Rate limit: only apply to non-forced refreshes after consecutive failures.
	// 401-triggered refreshes (force=true) bypass the rate limit entirely —
	// they are expected behavior when tokens are invalidated. Forced attempts
	// still advance lastRefreshAttempt, so a burst of consecutive forced
	// failures counts toward the gate instead of leaving the clock stale for
	// the next non-forced refresh to slip through.
	now := c.cfg.Now()
	if !force {
		c.mu.Lock()
		limited := c.refreshFailures >= 3 && !c.lastRefreshAttempt.IsZero() && now.Sub(c.lastRefreshAttempt) < refreshRateLimit
		if !limited {
			c.lastRefreshAttempt = now
		}
		c.mu.Unlock()
		if limited {
			return "", fmt.Errorf("mpesa: refresh rate limited after %d consecutive failures (last attempt %v ago, need %v)",
				c.refreshFailures, now.Sub(c.lastRefreshAttempt).Round(time.Millisecond), refreshRateLimit)
		}
	} else {
		c.mu.Lock()
		c.lastRefreshAttempt = now
		c.mu.Unlock()
	}

	// A failed refresh must never leave a token the gateway has already
	// invalidated in the cache: zero it before returning so the next caller
	// refetches instead of replaying a dead credential.
	fail := func(err error) (string, error) {
		c.mu.Lock()
		c.zeroTokenLocked()
		c.mu.Unlock()
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+oauthPath, nil)
	if err != nil {
		c.recordRefreshFailure()
		return fail(err)
	}
	req.SetBasicAuth(c.cfg.ConsumerKey, c.cfg.ConsumerSecret)
	resp, err := c.http.Do(req)
	if err != nil {
		c.recordRefreshFailure()
		return fail(fmt.Errorf("mpesa: oauth request: %w", err))
	}
	// The body is always closed on return; a Close error here cannot change the
	// outcome of a request whose response we have already read in full, so it is
	// discarded explicitly rather than left unchecked.
	defer func() { _ = resp.Body.Close() }()
	contentType := resp.Header.Get("Content-Type")
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseLen+1))
	if err != nil {
		c.recordRefreshFailure()
		return fail(fmt.Errorf("mpesa: read oauth response: %w", err))
	}
	if len(body) > maxResponseLen {
		err := fmt.Errorf("mpesa: %s response exceeds %d bytes", oauthPath, maxResponseLen)
		c.recordRefreshFailure()
		return fail(err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		c.recordRefreshFailure()
		return fail(parseError(resp.StatusCode, contentType, body, c.cfg.ErrorLogger))
	}
	var tok oauthTokenResponse
	if err := json.Unmarshal(body, &tok); err != nil {
		c.recordRefreshFailure()
		return fail(fmt.Errorf("mpesa: decode oauth response: %w", err))
	}
	if tok.AccessToken == "" {
		c.recordRefreshFailure()
		return fail(fmt.Errorf("mpesa: oauth response missing access_token"))
	}

	// Commit: zero the previous value first to minimise the window where the
	// credential sits in memory, then set the new token and expiry, and bump
	// the generation LAST — a reader that observes the new generation must
	// also observe the token and expiry written before it.
	c.mu.Lock()
	defer c.mu.Unlock()
	now = c.cfg.Now()
	c.setTokenLocked(tok.AccessToken)
	c.tokenExpiry = now.Add(refreshCadence(tok.ExpiresIn))
	c.gen++
	c.refreshFailures = 0
	return string(c.tokenBytes), nil
}

// recordRefreshFailure counts a failed refresh attempt (drives the rate
// limiter) under the lock. It also advances lastRefreshAttempt to the failure
// instant, so consecutive forced (401-triggered) failures — which bypass the
// gate check but still fail — keep the clock fresh; otherwise a following
// non-forced refresh would escape the "3 failures within 5s" gate on a stale
// timestamp. Denied (rate-limited) attempts return before any failure is
// recorded, so they never extend the window.
func (c *Client) recordRefreshFailure() {
	c.mu.Lock()
	c.refreshFailures++
	c.lastRefreshAttempt = c.cfg.Now()
	c.mu.Unlock()
}

// forceRefresh discards the cached token unconditionally before refetching.
// After a 401.003.01 the cached value cannot be trusted even if fresh by
// wall-clock: Daraja invalidates ALL previously issued tokens the moment ANY
// holder requests a new one (docs/apis/oauth.md) — including sibling replicas
// sharing the credential.
//
// The discard happens on the failure/progress paths rather than eagerly
// before the round-trip: waiting for the leader to finish is what lets
// concurrent business calls keep being served from an already-cached token
// while a forced refresh is in flight (setTokenLocked still zeroes the
// replaced value, and every failure path zeroes the cache), and a reader that
// does replay the old token simply gets another 401 and adopts the new one
// through the generation guard.
func (c *Client) forceRefresh(ctx context.Context) (string, error) {
	return c.leadForcedRefresh(ctx)
}

// refreshAfterInvalidToken resolves a 401.003.01 under the generation guard.
// If our view of the token was current when it failed (gen unchanged), we
// lead the hard refresh; otherwise a concurrent caller already refreshed and
// we adopt its token without another OAuth round-trip.
func (c *Client) refreshAfterInvalidToken(ctx context.Context, myGen uint64) (string, error) {
	c.mu.RLock()
	peerRefreshed, fresh := c.gen != myGen, c.tokenFresh()
	tok := string(c.tokenBytes)
	c.mu.RUnlock()
	if peerRefreshed && fresh {
		return tok, nil
	}
	return c.forceRefresh(ctx)
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
	// Explicit discard for the same reason as refreshLocked: the body is drained
	// and closed before every return, and a Close error cannot affect the status,
	// content type or bytes already returned to the caller.
	defer func() { _ = resp.Body.Close() }()
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
		return parseError(status, contentType, body, c.cfg.ErrorLogger)
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
	// The STK password is base64(shortcode + passkey + timestamp). An empty
	// Passkey still produces a perfectly well-formed base64 blob, so the only
	// place the mistake is detectable is before the round-trip: validate here
	// (not in Config.Validate) so non-STK users without a passkey are
	// unaffected, and the caller gets a client-side error instead of a
	// 500.001.1001 gateway rejection.
	if strings.TrimSpace(c.cfg.Passkey) == "" {
		return nil, fmt.Errorf("mpesa: Config.Passkey is required for STK Push (it is bound into the request Password)")
	}
	if r.BusinessShortCode == "" {
		r.BusinessShortCode = c.cfg.Shortcode
	}
	if r.PartyB == "" {
		r.PartyB = r.BusinessShortCode
	}
	if err := r.ValidateWithLimits(c.limits); err != nil {
		return nil, err
	}
	// Daily ceiling is checked LAST, immediately before dispatch: it must run
	// after every other validation (and after the defaults injection above)
	// so a rejected request never consumes accumulator budget.
	if err := c.checkDaily(ServiceSTK, r.Amount); err != nil {
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
	// Same contract as STKPush: the password is derived from the passkey, so
	// an empty one can only fail server-side. Validate at the request level
	// (not in Config.Validate) to keep non-STK users unaffected.
	if strings.TrimSpace(c.cfg.Passkey) == "" {
		return nil, fmt.Errorf("mpesa: Config.Passkey is required for STK Query (it is bound into the request Password)")
	}
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
	if err := r.ValidateWithLimits(c.limits); err != nil {
		return nil, err
	}
	if err := c.checkDaily(ServiceB2C, r.Amount); err != nil {
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
	if err := r.ValidateWithLimits(c.limits); err != nil {
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
	if err := r.ValidateWithLimits(c.limits); err != nil {
		return nil, err
	}
	if err := c.checkDaily(ServiceDefault, r.Amount); err != nil {
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
	if err := r.ValidateWithLimits(c.limits); err != nil {
		return nil, err
	}
	if err := c.checkDaily(ServiceC2B, r.Amount); err != nil {
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
	if err := r.ValidateWithLimits(c.limits); err != nil {
		return nil, err
	}
	if err := c.checkDaily(ServiceDefault, r.Amount); err != nil {
		return nil, err
	}
	var out QRCodeResponse
	if err := c.post(ctx, qrCodePath, r, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
