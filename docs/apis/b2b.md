# B2B Express Checkout

> Business-to-business payment between two shortcodes. Async: the sync reply
> is a queue ACK; the verdict arrives as a `Result` envelope on your
> `ResultURL` (timeout notice to `QueueTimeOutURL`).

## Endpoint

| Env | URL |
|---|---|
| Sandbox | `POST https://sandbox.safaricom.co.ke/mpesa/b2b/v3/paymentrequest` |
| Production | `POST https://api.safaricom.co.ke/mpesa/b2b/v3/paymentrequest` |

## Request

| Field | Type | Notes |
|---|---|---|
| `OriginatorConversationID` | string | optional — auto-generated (16-char CSPRNG) when empty |
| `Initiator` | string | API operator name (**note: `Initiator`, not B2C's `InitiatorName`**) |
| `SecurityCredential` | string | RSA-encrypted initiator password — see [getting-started.md](getting-started.md#security-credentials) |
| `CommandID` | enum | `BusinessPayBill` (paybill receiver) · `BusinessBuyGoods` (till receiver) — anything else is rejected client-side |
| `SenderIdentifierType` | string | default `"4"` (organization shortcode) |
| `ReceiverIdentifierType` | string | default `"4"` |
| `Amount` | integer | whole shillings; per-transaction ceiling enforced client-side (bucket `b2b`) |
| `PartyA` | shortcode | sender, 5–10 digits |
| `PartyB` | shortcode | receiver, 5–10 digits |
| `AccountReference` | string | your reference |
| `Remarks` | string | free text |
| `QueueTimeOutURL` | URL | timeout notice endpoint |
| `ResultURL` | URL | final verdict endpoint |

## Response (queue ACK only)

```json
{
  "OriginatorConversationID": "...",
  "ConversationID": "AG_...",
  "ResponseCode": "0",
  "ResponseDescription": "Success"
}
```

`ResponseCode "0"` means queued, not settled. Bind on
`OriginatorConversationID` against your own records before acting — the push
is unsigned like every Daraja callback.

## Security notes

- `SecurityCredential` and `TaxPayerPIN`-class fields are redacted in every
  rendered form of the request (Go `GoString`/`Format`, Python `repr`,
  TypeScript `logSafeRequest`) — never log the raw request object.
- Amounts above the configured `b2b` ceiling fail locally before any network
  I/O; a request rejected pre-dispatch consumes no daily quota.
