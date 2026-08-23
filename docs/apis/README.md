# Daraja API Reference — SDK Source of Truth

Verified against developer.safaricom.co.ke (official portal, 2026-08-23). Every SDK language
implementation (Go / Python / TypeScript) MUST conform to these documents — exact field-name
casing is contractual because Safaricom's gateway is case-sensitive.

## Documents

| Doc | Covers |
|---|---|
| [getting-started.md](getting-started.md) | Environments, auth model, SecurityCredential algorithm, cert URLs, callback IP whitelist, go-live checklist, error envelope |
| [oauth.md](oauth.md) | `GET /oauth/v1/generate` — token lifecycle & cache rules |
| [stk-push.md](stk-push.md) | `POST /mpesa/stkpush/v1/processrequest` — push-to-pay, callback schema, ResultCode catalog |
| [stk-query.md](stk-query.md) | `POST /mpesa/stkpushquery/v1/query` — status checks, polling strategy |
| [b2c.md](b2c.md) | `POST /mpesa/b2c/v3/paymentrequest` — payouts, async Result schema |
| [c2b.md](c2b.md) | `POST /mpesa/c2b/v2/registerurl` (+ simulate), validation/confirmation callbacks |
| [transaction-status.md](transaction-status.md) | `POST /mpesa/transactionstatus/v1/query` |
| [reversal.md](reversal.md) | `POST /mpesa/reversal/v1/request` — C2B reversal only |
| [account-balance.md](account-balance.md) | `POST /mpesa/accountbalance/v1/query` |
| [dynamic-qr.md](dynamic-qr.md) | `POST /mpesa/qrcode/v1/generate` |

## Cross-Cutting Casing Traps (SDK-breaking if missed)

| Trap | Where |
|---|---|
| `Occassion` (double-s) vs `Occasion` | B2C vs TxStatus/AB |
| `InitiatorName` vs `Initiator` | B2C vs TxStatus/Reversal/AB |
| `RecieverIdentifierType` misspelling | Reversal |
| `OriginatorCoversationID` misspelling + no `ConversationID` | C2B ACKs |
| `QueueTimeOutURL` capital O-U-T | all async APIs |
| `ResponseCode` string `"0"` (sync) vs integer `ResultCode` (callbacks) | STK family |
| `expires_in` is a string | OAuth |
| `RefNo` (not RefNumber); opaque alphanumeric ResponseCode | Dynamic QR |

## Shared SDK Behaviors

1. Thread-safe token cache; refresh at ≤50 min; single-flight refresh; one retry after forced
   refresh on `401.003.01`.
2. EAT timezone timestamp generation, generated once per request where password+timestamp pair
   applies.
3. Client-side validation before any network call (phone format, amount rules, length caps,
   enum whitelists).
4. Typed error surface: HTTP status + parsed envelope (`requestId`/`errorCode`/`errorMessage`)
   with code classification helpers.
5. Callback parsers tolerant of absent metadata/parameters (failures omit them).
6. No secrets in errors or logs; redact tokens and security credentials.
