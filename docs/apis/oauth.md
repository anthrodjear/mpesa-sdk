# OAuth Token Generation

> Verifies app identity; issues the Bearer token used by every business endpoint.

## Endpoint

| Env | URL |
|---|---|
| Sandbox | `GET https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials` |
| Production | `GET https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials` |

- Method: **GET** (the only non-POST endpoint)
- Header: `Authorization: Basic base64(CONSUMER_KEY:CONSUMER_SECRET)` — colon separator, no spaces
- Body: none

Credentials come from a Daraja app (per-app; **not publicly fixed**). Generate per environment — sandbox and production apps differ.

## Success Response (HTTP 200)

```json
{
  "access_token": "c9SQxWWhmdVRlyh0zh8gZDTkubVF",
  "expires_in": "3599"
}
```

⚠️ `expires_in` is a **STRING**, typically `"3599"`–`"3600"` seconds. Parse leniently (string OR number).

## Failure

HTTP 400/401 with the standard envelope:

```json
{ "errorCode": "404.001.04", "errorMessage": "Invalid Authentication" }
```

- `404.001.04` — app not found (bad key/secret)
- Wrong-environment credentials → "Invalid Authentication"

## Token Lifecycle & Caching (SDK requirements)

1. TTL ≈ 1 hour → **cache and reuse until ≤ ~50 min old**; refresh proactively before expiry.
2. **Requesting a new token invalidates the previous one** (official FAQ) — a naive multi-goroutine/thread refresh storm can invalidate in-flight tokens. Serialize refreshes:
   - Go: singleflight or `sync.RWMutex` around fetch (ADR-010 pattern)
   - Python: `threading.Lock`
   - TypeScript: promise memoization (store the in-flight promise)
3. On any business-API `401.003.01` (invalid/expired token): force-refresh once, retry the call once, surface error if it repeats.
4. The credential does not expire; safe to embed in long-lived client config (still load from env/secret store, never hardcode).

## SDK Design Notes

- Expose `Token(ctx)` (Go) / `get_token()` (Python) / `getToken()` (TS) returning the cached token, transparently refreshing when stale.
- Never log the full token (redact middle segment).
- Unit-test: cache hit avoids second HTTP call; concurrent callers produce exactly one fetch (use a counting mock server); expiry boundary triggers refresh at 50 min.
