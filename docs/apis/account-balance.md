# Account Balance Query

> Queries the balances of all accounts attached to an organization shortcode.
> Asynchronous: ACK then Result callback.

## Endpoint

| Env | URL |
|---|---|
| Sandbox | `POST https://sandbox.safaricom.co.ke/mpesa/accountbalance/v1/query` |
| Production | `POST https://api.safaricom.co.ke/mpesa/accountbalance/v1/query` |

Auth: Bearer token + `SecurityCredential`. Portal role required: **Balance Query ORG API**.

## Request Parameters (official casing)

| Field | Type | Constraints |
|---|---|---|
| `Initiator` | string | API operator username (⚠️ not `InitiatorName`) |
| `SecurityCredential` | string | RSA PKCS#1 v1.5 + Base64 (env cert) |
| `CommandID` | enum | only `AccountBalance` |
| `PartyA` | numeric | shortcode being queried |
| `IdentifierType` | numeric | `4` = organization shortcode |
| `Remarks` | string | required |
| `QueueTimeOutURL` | URL | timeout notice endpoint |
| `ResultURL` | URL | receives Result callback |

## Sync ACK Response

Standard shape (`OriginatorConversationID`, `ConversationID`, `ResponseCode`,
`ResponseDescription`).

## Async Result Callback

Observed parameters:

| Key | Value format |
|---|---|
| `AccountBalance` | segments joined by `&`, each `Name\|Currency\|Available\|Uncleared\|Reserved\|Min` — e.g. `"Working Account\|KES\|700000.00\|700000.00\|0.00\|0.00&Float Account\|KES\|…&Utility Account\|KES\|228037.00\|228037.00\|0.00\|0.00&Charges Paid Account\|KES\|-1540.00\|-1540.00\|0.00\|0.00&Organization Settlement Account\|KES\|0.00\|0.00\|0.00\|0.00"` |
| `BOCompletedTime` | `YYYYMMDDHHMMSS` |

Note `Charges Paid Account` runs **negative** and blocks withdrawals until settled.

Documented core ApiResult codes: `15` duplicate detected · `17` internal failure ·
`18` initiator credential check failed · `20` unresolved initiator ·
`21` initiator→primary party permission failure · `22` initiator inactive ·
`24` missing mandatory fields · `25` invalid request parameters · `26` traffic blocking ·
`29` invalid command · `100000011` rate-limit exceeded · `00.002.1001` maintenance mode.

## SDK Requirements

1. Provide a balance-segment parser: split on `&`, then `|`, into a typed list
   `{AccountName, Currency, Available, Uncleared, Reserved, Min}` with float parsing.
2. Tolerate unknown extra segments and trailing separators.
3. Reuse the shared SecurityCredential builder and async-result envelope types.
