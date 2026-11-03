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
| `ShortCode` | shortcode | 5–10 digits; defaults to the configured shortcode when omitted |
| `BillRefNumber` | string | the bill identifier; shown in logs (not PII, not a secret) |
| `BillName` | string | free text |
| `Amount` | integer | whole shillings; per-transaction ceiling bucket `bill` |
| `ExpiryDate` | string | shape-checked (≤ 10 chars); the gateway owns the format |
| `CallBackURL` | URL | SSRF-validated like every other SDK URL |
| `PayerNumber` | MSISDN | optional; normalized to `254…`; **redacted in logs** |
| `PayerName` | string | optional; **redacted in logs** (PII) |

`ShortCode` is defaulted on all four operations (register, query, update,
delete) — the same convention as C2B URL registration and STK Push: an empty
value is filled from `Config.Shortcode`/`config.shortcode` on the client's
internal copy, so the caller's object is never mutated. Supply it explicitly
to bill against someone else's shortcode.

## Query / Delete

`ShortCode` + `BillRefNumber` only. No amount, so no limits gate and no
daily accrual.

## Update

`ShortCode` + `BillRefNumber` plus any of `Amount` / `ExpiryDate` /
`CallBackURL` / `PayerNumber` / `PayerName`. A partial update: fields left
unset (or empty) are omitted from the wire — an update with **no** amount
moves no money and consumes no daily quota; with an amount it takes the
`bill` per-transaction ceiling and accrues daily like `register`.

**Spelling "unset" (the type has no `None` on the wire):**

| Engine | How to say "do not touch the amount" |
|---|---|
| Go | leave `Amount` at `0` — the `omitempty` key is omitted |
| Python | `amount=None` (or `0`); `validate` drops it from the payload |
| TypeScript | omit the `amount` key entirely |

A whitespace-only `payerNumber`/`payerName` counts as *not supplied* and is
dropped from the payload in all three engines, never sent as spaces.

> TypeScript differs deliberately on the value itself: `amount: 0` is
> **rejected** as non-positive rather than read as "unset". TypeScript has no
> equivalent of Go's zero-value/`omitempty` sentinel, and an explicit `0` is
> far more likely to be a mistake than a partial update — omit the key
> instead.

## Response

All four operations return the standard ACK envelope —
`ResponseCode`, `ResponseDescription`, `ConversationID`,
`OriginatorConversationID` — with `BillRefNumber` **optional** (Daraja echoes
it on register; absence is tolerated, never an error). This shape is an
assumption documented in each engine's response model; if Safaricom's
bill-manager ack diverges, the response models are the single place to
correct.

Strictness of the ACK decode differs by engine: only **Python's
`from_json`** enforces the four required keys and raises when one is missing.
Go's plain `json.Unmarshal` silently leaves a missing field at its zero value,
and TypeScript's response is a cast — neither can detect the omission. Do not
assume the three engines reject a malformed ACK identically.

## Security notes

- `PayerName`/`PayerNumber` are masked as `[REDACTED]` in Go's
  `LogSafe`/`GoString`/`Format`, Python's `repr`, and TypeScript's
  `logSafeRequest`; `BillRefNumber` is deliberately visible (an identifier,
  not a secret).
- Amounts above the configured `bill` ceiling fail locally before any
  network I/O; a request rejected pre-dispatch consumes no daily quota, and
  the reservation is refunded only when the request provably never reached
  the gateway.
