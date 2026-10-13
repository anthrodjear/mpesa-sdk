// Package mpesa is a dependency-free Safaricom Daraja API engine covering
// OAuth, STK Push/Query, B2C payouts, C2B URL registration and simulation,
// Transaction Status, Reversal, Account Balance and Dynamic QR.
//
// # Environments and auth model
//
// Sandbox (https://sandbox.safaricom.co.ke) and Production
// (https://api.safaricom.co.ke) are selected via Config.Environment. Every
// business endpoint is POST with a Bearer token; only the OAuth token
// endpoint is GET with Basic auth. Tokens live about an hour but requesting
// a new one invalidates the previous, so Client caches the token and
// proactively refreshes on an expires_in-derived cadence (expires_in minus a
// 60s safety margin, clamped to [1s, 50min]; an unknown/zero TTL falls back
// to the legacy 50 minutes) under a single-flight leader that performs the
// OAuth round-trip outside the client lock. A refreshed-but-rejected token is
// retried once after a forced refresh on error 401.003.01.
//
// # The authoritative contract
//
// Exact field casing, endpoint versions and result-code catalogs live in
// docs/apis/*.md at the repository root. Safaricom's gateway is
// case-sensitive and misspells several wire fields (OriginatorCoversationID,
// RecieverIdentifierType, Occassion); this SDK reproduces them verbatim on
// the wire while exposing correctly spelled Go identifiers.
//
// # Safety notes
//
// Result codes 1001/1037/26/4999 — and any unknown code — classify as
// indeterminate, never failed: debits have been observed landing minutes
// later, and auto-failing risks refunding paid orders. STK Password and
// Timestamp MUST derive from one shared EAT instant (the two-clock bug
// causes intermittent 500.001.1001). Callbacks carry no HMAC signature:
// settle only via STKQuery bound to YOUR CheckoutRequestID record, gate
// endpoints with callbacktoken.go URL tokens, and cap ingestion body size —
// binding on CheckoutRequestID dedups deliveries, it does not authenticate
// origin. SECURITY.md at the repository root documents the callback and
// indeterminate-safety design this section summarizes.
//
// # Token caching across replicas
//
// Exactly one goroutine per process performs a refresh at a time; it runs the
// OAuth round-trip WITHOUT holding the client lock, so a slow gateway stalls
// only the token path rather than every caller. Across replicas, treat ONE
// process as the logical token owner per credential per deployment: sibling
// refreshes invalidate each other's cached tokens by design
// (docs/apis/oauth.md). The SDK's 401.003.01 generation guard absorbs
// cross-owner invalidations with a single coordinated refresh and one retry.
//
// # Transaction limits
//
// Per-transaction and per-day amount ceilings are CONFIGURABLE, not baked
// into the request types. Safaricom re-tiers merchants dynamically, so a
// hardcoded ceiling — the old literal 250000 KES B2C bound — rejects
// legitimate traffic the gateway would accept the moment a merchant is
// upgraded.
//
// The model is HYBRID CONFIGURABLE DEFAULTS: the SDK ships
// DefaultTransactionLimits and Config.Limits is a partial overlay on top of
// it. A nil field inherits the baseline, so configuring only B2C cannot
// silently disarm the STK/C2B/Default ceilings; disabling a ceiling is
// explicit and deliberate — set the field to 0 or a negative value with
// mpesa.Limit(), the only spelling for "no client-side cap" for a merchant on
// an unlimited tier. The merge is resolved once at NewClient into a fully
// materialized, immutable TransactionLimits the Client reads without any
// further locking.
//
// Daily accumulation against MaxPerDay is OPT-IN via Config.TrackDaily and
// off by default: the accumulator lives in this process and therefore cannot
// observe traffic from sibling replicas sharing the same shortcode, which is
// what Daraja actually meters. A local accumulator would under-count and
// falsely reject. Enable it only when this process is the sole originator for
// the service. The day boundary is Africa/Nairobi (UTC+3, no DST), evaluated
// through the injectable Config.Now clock.
//
// Rejections are returned as *LimitError, naming the service, the configured
// ceiling and the exact Config path to override.
//
// # Secrets
//
// Config and every request type carrying SecurityCredential print a redacted
// form under %v/%+v/%#v — still never log them directly. ConsumerKey is a
// secret, not an identifier: it is masked to its first/last 4 runes
// (GoString/Format/MarshalJSON) so logs stay correlatable without writing a
// live Daraja credential into a log store.
package mpesa
