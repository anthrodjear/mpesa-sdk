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
// a new one invalidates the previous, so Client caches and refreshes
// proactively at 50 minutes under a single-flight lock and retries the
// business call once after a forced refresh on error 401.003.01.
//
// # The authoritative contract
//
// Exact field casing, endpoint versions and result-code catalogs live in
// docs/apis/*.md at the repository root. Safaricom's gateway is
// case-sensitive and misspells several wire fields (OriginatorCoversationID,
// RecieverIdentifierType, Occassion); this SDK reproduces them verbatim on
// the wire while exposing correctly spelled Go identifiers.
//
// # Safety notes (ADR-010)
//
// Result codes 1001/1037/26/4999 — and any unknown code — classify as
// indeterminate, never failed: debits have been observed landing minutes
// later, and auto-failing risks refunding paid orders. STK Password and
// Timestamp MUST derive from one shared EAT instant (the two-clock bug
// causes intermittent 500.001.1001). Callbacks carry no HMAC signature: bind
// on CheckoutRequestID, validate fields, and cap ingestion body size.
//
// # Token caching across replicas
//
// Refresh holds the write lock across the OAuth round-trip — a deliberate
// ~once-per-refresh-window stall traded for strict single-flight, since any
// new token request invalidates every previously issued token. Across
// replicas, treat ONE process as the logical token owner per credential per
// deployment: sibling refreshes invalidate each other's cached tokens by
// design (docs/apis/oauth.md). The SDK's 401.003.01 generation guard absorbs
// cross-owner invalidations with a single coordinated refresh and one retry.
//
// # Secrets
//
// Config and every request type carrying SecurityCredential print a redacted
// form under %v/%+v/%#v — still never log them directly.
package mpesa
