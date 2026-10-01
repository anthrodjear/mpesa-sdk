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

### Refresh rate limiting — `mpesa: refresh rate limited ...`

All three engines throttle their own retry loop, so this error comes from the SDK, not
from Safaricom. After **3 consecutive refresh failures** within a **5-second** window the
client refuses further OAuth attempts:

```
mpesa: refresh rate limited after 3 consecutive failures (last attempt 0.412s ago, need 5.0s)
```

| Engine | Threshold | Window | Constants |
|---|---|---|---|
| Go         | 3 failures | 5 s    | `refreshRateLimit` (`go/client.go`) |
| Python     | 3 failures | 5 s    | `_REFRESH_FAILURE_THRESHOLD`, `_REFRESH_RATE_LIMIT_SECONDS` (`python/mpesa/auth.py`) |
| TypeScript | 3 failures | 5000 ms | `REFRESH_FAILURE_THRESHOLD`, `REFRESH_RATE_LIMIT_MS` (`typescript/src/auth.ts`) |

- **The counter resets on the first successful refresh**, so a transient gateway blip does
  not accumulate into a permanent block.
- **A 401-triggered forced refresh bypasses the limit.** The `401.003.01` retry path calls
  the refresh with `force=true` specifically so a genuine credential rotation is never
  refused by the breaker. Only *ordinary* (unforced) refreshes are throttled.
- **What it protects:** a crash-loop. Without it, a process with bad credentials retries the
  token endpoint as fast as the network allows and can get the app rate-limited by
  Safaricom — turning one config error into a self-inflicted outage.
- **What it does not mean:** the credentials are rejected. Wait out the 5 s window and the
  next refresh proceeds normally. If it recurs, fix the credentials — the usual cause is a
  sandbox key paired with `production` (or vice versa), which yields
  `404.001.04 Invalid Authentication`.

## Token Lifecycle & Caching (SDK requirements)

1. TTL ≈ 1 hour → **cache and reuse until ≤ ~50 min old**; refresh proactively before expiry.
2. **Requesting a new token invalidates the previous one** (official FAQ) — a naive multi-goroutine/thread refresh storm can invalidate in-flight tokens. Serialize refreshes:
   - Go: singleflight or `sync.RWMutex` around fetch (ADR-010 pattern)
   - Python: `threading.Lock`
   - TypeScript: promise memoization (store the in-flight promise)
3. On any business-API `401.003.01` (invalid/expired token): force-refresh once, retry the call once, surface error if it repeats.
4. The credential does not expire; safe to embed in long-lived client config (still load from env/secret store, never hardcode).
5. Break repeated refresh failures yourself (3 failures / 5 s) so a crash-loop cannot hammer the token endpoint — see [Refresh rate limiting](#refresh-rate-limiting--mpesa-refresh-rate-limited-) above.

## SDK Design Notes

- Expose `Token(ctx)` (Go) / `get_token()` (Python) / `getToken()` (TS) returning the cached token, transparently refreshing when stale.
- Never log the full token (redact middle segment).
- Unit-test: cache hit avoids second HTTP call; concurrent callers produce exactly one fetch (use a counting mock server); expiry boundary triggers refresh at 50 min.
