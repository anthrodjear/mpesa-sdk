# Transaction Status Query

> Checks the status of any transaction on your account by M-Pesa receipt or by original
> conversation ID. The universal reconciliation tool when callbacks are lost.

## Endpoint

| Env | URL |
|---|---|
| Sandbox | `POST https://sandbox.safaricom.co.ke/mpesa/transactionstatus/v1/query` |
| Production | `POST https://api.safaricom.co.ke/mpesa/transactionstatus/v1/query` |

Auth: Bearer token + `SecurityCredential`. Asynchronous (ACK then Result callback).
Portal role required: **Transaction Status query ORG API**.

## Request Parameters (official casing)

| Field | Type | Constraints |
|---|---|---|
| `Initiator` | string | ⚠️ named `Initiator` here — NOT `InitiatorName` (that's B2C) |
| `SecurityCredential` | string | RSA PKCS#1 v1.5 + Base64 (env cert; see getting-started.md) |
| `CommandID` | enum | only `TransactionStatusQuery` |
| `TransactionID` | string | M-Pesa receipt — provide this **OR** `OriginalConversationID` |
| `OriginalConversationID` | string | OriginatorConversationID of the original txn (B2C/AB lookups) |
| `PartyA` | numeric | shortcode (6–9 digits) or MSISDN (12 digits) |
| `IdentifierType` | numeric | docs specify `4` = organization shortcode (legacy `1` MSISDN / `2` Till unverified in current docs — treat as unsupported) |
| `ResultURL` | URL | receives the Result callback |
| `QueueTimeOutURL` | URL | timeout notice endpoint |
| `Remarks` | string | ≤100 chars, required |
| `Occasion` | string | optional, ≤100 (⚠️ single-s here — B2C uses `Occassion`) |

## Sync ACK Response

```json
{
  "OriginatorConversationID": "…",
  "ConversationID": "AG_…",
  "ResponseCode": "0",
  "ResponseDescription": "Accept the service request successfully."
}
```

## Async Result Callback (to ResultURL)

Header fields as standard (`Result.ResultType/ResultCode/ResultDesc/OriginatorConversationID/
ConversationID/TransactionID`). Observed `ResultParameters` keys:

| Key | Value type / example |
|---|---|
| `ReceiptNo` | `"SJ32NMVXY"` |
| `ConversationID` / `OriginatorConversationID` | strings |
| `Amount` | numeric |
| `TransactionStatus` | `Completed` \| `Cancelled` \| `Declined` \| `Expired` (lifecycle stages: Initiated → Authorized → Final) |
| `InitiatedTime` / `FinalisedTime` | `YYYYMMDDHHMMSS` |
| `DebitPartyName` / `DebitAccountType` | strings |
| `DebitPartyCharges` | `"Fee For B2C Payment\|KES\|22.40"` (pipe-delimited!) |
| `ReasonType` / `TransactionReason` | strings |

Result codes: `0` success · `SFC_IC0003` operator/receiver does not exist.
Parse parameter values as opaque strings unless documented numeric — Safaricom mixes types.

## SDK Requirements

1. Exactly one of `TransactionID` / `OriginalConversationID` required — enforce XOR at
   construction time with a clear validation error.
2. Shared async-result envelope type reused by B2C/TxStatus/Reversal/AccountBalance parsers.
3. Expose typed accessor helpers for common keys (`TransactionStatus`, `ReceiptNo`, `Amount`)
   plus raw map access for the rest.
