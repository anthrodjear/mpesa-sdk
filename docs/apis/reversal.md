# Reversal

> Reverses a recent **C2B** transaction (customer payment into your collection account).
> Does NOT work for B2C payouts — those reverse manually via the portal.

## Endpoint

| Env | URL |
|---|---|
| Sandbox | `POST https://sandbox.safaricom.co.ke/mpesa/reversal/v1/request` |
| Production | `POST https://api.safaricom.co.ke/mpesa/reversal/v1/request` |

Auth: Bearer token + `SecurityCredential`. Asynchronous. Portal role required:
**Org Reversals Initiator**.

## Request Parameters (official casing)

| Field | Type | Constraints |
|---|---|---|
| `Initiator` | string | API operator username with Reversals role |
| `SecurityCredential` | string | RSA PKCS#1 v1.5 + Base64 (env cert) |
| `CommandID` | enum | only `TransactionReversal` |
| `TransactionID` | string | receipt of the transaction being reversed |
| `Amount` | numeric | required per current docs |
| `ReceiverParty` | numeric | organization shortcode |
| `RecieverIdentifierType` | numeric | ⚠️ value `"11"`; ⚠️ field name misspells "Reciever" in the official API — match exactly |
| `ResultURL` | URL | receives Result callback |
| `QueueTimeOutURL` | URL | timeout notice endpoint |
| `Remarks` | string | 2–100 chars, required |

## Sync ACK Response

Standard shape:

```json
{
  "OriginatorConversationID": "…",
  "ConversationID": "AG_…",
  "ResponseCode": "0",
  "ResponseDescription": "Accept the service request successfully."
}
```

## Async Result Callback

Observed `ResultParameters` keys:

| Key | Value type / example |
|---|---|
| `DebitAccountBalance` | pipe-delimited: `"Utility Account\|KES\|7722179.62\|7722179.62\|0.00\|0.00"` |
| `Amount` | numeric |
| `TransCompletedTime` | `YYYYMMDDHHMMSS` |
| `OriginalTransactionID` | receipt that was reversed |
| `Charge` | numeric/string |
| `CreditPartyPublicName` / `DebitPartyPublicName` | strings |

## Result Codes

`0` success · `R000001` already reversed · `R000002` OriginalTransactionID invalid ·
`1` insufficient funds · `11`/`2006` inactive account · `21` missing role ·
`2001` bad credentials · `2028` product permission · `8006` credential locked.

## Operational Notes

- C2B-only: reversing B2C payouts must be done manually via the M-PESA portal.
- Reversal pulls funds from your account back to the payer — ensure utility float covers it.
- Treat `R000001` as idempotent-success signal for retry logic.

## SDK Requirements

1. Exact-casing request struct including the misspelled `RecieverIdentifierType` JSON key.
2. Default `RecieverIdentifierType` to `"11"` when caller omits it.
3. Typed parser for the shared async Result envelope + parameter map accessors.
