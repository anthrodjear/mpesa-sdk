# Bill Manager

> Register, query, update and delete payment bills on a shortcode. Bills can
> carry payer PII — the SDK redacts it in every rendered form of the request.

## Endpoints

| Operation | URL |
|---|---|
| Register | `POST https://<env>/mpesa/billmanager/v1/register` |
| Query | `POST https://<env>/mpesa/billmanager/v1/query` |
| Update | `POST https://<env>/mpesa/billmanager/v1/update` |
| Delete | `POST https://<env>/mpesa/billmanager/v1/delete` |

`<env>` is `sandbox.safaricom.co.ke` or `api.safaricom.co.ke`. Bill Manager
takes **no initiator or SecurityCredential** — it authenticates with the
ordinary business Bearer token.

## Register

| Field | Type | Notes |
|---|---|---|
| `ShortCode` | shortcode | 5–10 digits; **required, not defaulted** |
| `BillRefNumber` | string | the bill identifier; shown in logs (not PII, not a secret) |
| `BillName` | string | free text |
| `Amount` | integer | whole shillings; per-transaction ceiling bucket `bill` |
| `ExpiryDate` | string | shape-checked (≤ 10 chars); the gateway owns the format |
| `CallBackURL` | URL | SSRF-validated like every other SDK URL |
| `PayerNumber` | MSISDN | optional; normalized to `254…`; **redacted in logs** |
| `PayerName` | string | optional; **redacted in logs** (PII) |

## Query / Delete

`ShortCode` + `BillRefNumber` only. No amount, so no limits gate and no
daily accrual.

## Update

`ShortCode` + `BillRefNumber` plus any of `Amount` / `ExpiryDate` /
`CallBackURL` / `PayerNumber` / `PayerName`. A partial update: fields left
unset (or empty) are omitted from the wire — an update with **no** amount
moves no money and consumes no daily quota; with an amount it takes the
`bill` per-transaction ceiling and accrues daily like `register`.

## Response

All four operations return the standard ACK envelope —
`ResponseCode`, `ResponseDescription`, `ConversationID`,
`OriginatorConversationID` — with `BillRefNumber` **optional** (Daraja echoes
it on register; absence is tolerated, never an error). This shape is an
assumption documented in each engine's response model; if Safaricom's
bill-manager ack diverges, the response models are the single place to
correct.

## Security notes

- `PayerName`/`PayerNumber` are masked as `[REDACTED]` in Go's
  `LogSafe`/`GoString`/`Format`, Python's `repr`, and TypeScript's
  `logSafeRequest`; `BillRefNumber` is deliberately visible (an identifier,
  not a secret).
- Amounts above the configured `bill` ceiling fail locally before any
  network I/O; a request rejected pre-dispatch consumes no daily quota, and
  the reservation is refunded only when the request provably never reached
  the gateway.
