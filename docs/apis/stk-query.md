# STK Query — M-Pesa Express Query

> Checks the final status of an STK Push. Primary fallback when the callback is late/lost.

## Endpoint

| Env | URL |
|---|---|
| Sandbox | `POST https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query` |
| Production | `POST https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query` |

Auth: Bearer token. All fields required.

## Request Parameters (official casing)

| Field | Type | Notes |
|---|---|---|
| `BusinessShortCode` | numeric | same shortcode used in the push |
| `Password` | string | `base64(Shortcode + Passkey + Timestamp)` with a **fresh** timestamp |
| `Timestamp` | string | fresh `YYYYMMDDHHmmss` EAT — matches the Password input |
| `CheckoutRequestID` | string | `ws_CO_…` from the push response |

## Success Response (HTTP 200)

```json
{
  "ResponseCode": "0",
  "ResponseDescription": "The service request has been accepted successsfully",
  "MerchantRequestID": "8491-75014543-2",
  "CheckoutRequestID": "ws_CO_12122022094855872768372439",
  "ResultCode": "1032",
  "ResultDesc": "Request cancelled by user"
}
```

- Contains BOTH the ack (`ResponseCode`/`ResponseDescription` — the triple-"s" typo
  "successsfully" is Safaricom's own output) AND the transaction outcome
  (`ResultCode`/`ResultDesc`).
- `ResultCode` observed as **string** here in some captures, integer elsewhere → coerce
  leniently in every SDK (accept both, normalize to string constant).
- Unknown checkout ID / malformed request → standard error envelope.

## Polling Strategy (SDK helper / consumer guidance)

```
start ≈ 25–30 s after push
poll every ≈ 5 s
cap   ≈ 90 s total
```

Rules:
1. Only settle on **known-terminal** codes (`0`, `1`, `1032`, `2001`, `1019` …).
2. `1037`, `1001`, `26`, `4999` → keep polling; they are indeterminate, never auto-fail.
3. After backoff exhaustion without a terminal code → mark INDETERMINATE and **block retries**
   (ADR-010 state machine) — reconcile manually / via nightly statement job.
4. Query results are advisory; a callback arriving concurrently wins via CAS transition.

## Error Envelope

Standard `requestId`/`errorCode`/`errorMessage`. Treat unexpected codes (e.g. `4999`
surfacing here) as pending — never as failure.

## SDK Design Notes

- Provide `STKQuery(req)` primitive only; ship an optional `AwaitSTKResult(checkoutID, opts)`
  convenience implementing the poll loop above with cancellation context.
- Unit-test: terminal code stops polling; indeterminate keeps polling until deadline; context
  cancel aborts cleanly.
