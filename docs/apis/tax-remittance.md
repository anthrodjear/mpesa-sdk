# Tax Remittance

> Remit tax (KRA and other obligations) to a revenue authority shortcode.
> Async: the sync reply is a queue ACK; the verdict arrives as a `Result`
> envelope on your `ResultURL`.

## Endpoint

| Env | URL |
|---|---|
| Sandbox | `POST https://sandbox.safaricom.co.ke/mpesa/b2b/v1/remittax` |
| Production | `POST https://api.safaricom.co.ke/mpesa/b2b/v1/remittax` |

## Request

Same core as [B2B](b2b.md) — `OriginatorConversationID`, `Initiator`,
`SecurityCredential`, `SenderIdentifierType`/`ReceiverIdentifierType`
(default `"4"`), `Amount`, `PartyA` (your shortcode), `PartyB` (the authority
shortcode), `AccountReference`, `Remarks`, `QueueTimeOutURL`, `ResultURL` —
with `CommandID` fixed to `TaxRemittance` (anything else is rejected
client-side) plus three tax-specific fields:

| Field | Type | Notes |
|---|---|---|
| `TaxPeriod` | string | accounting period, e.g. `2024Q3` |
| `TaxObligation` | string | obligation type, e.g. `VAT`, `PAYE`, `Excise` |
| `TaxPayerPIN` | string | **taxpayer PIN — a secret.** Redacted in every rendered form of the request; never log it |

`Amount` is gated on the `tax` per-transaction ceiling before any network
I/O.

## Response (queue ACK only)

Same shape as the B2B ACK (`OriginatorConversationID`, `ConversationID`,
`ResponseCode`, `ResponseDescription`).

## Security notes

- The PIN is personally identifiable financial data: it is masked by the same
  redaction hooks as `SecurityCredential` in all three engines, and the
  per-transaction limit error names only the config path — never the value.
