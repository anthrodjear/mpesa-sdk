# B2C Payout (Business to Customer)

> Sends money from a business shortcode to a customer's M-PESA (refunds, salaries, promotions).
> Asynchronous: sync ACK then final `Result` posted to your ResultURL.

## Endpoint

| Env | URL |
|---|---|
| Sandbox | `POST https://sandbox.safaricom.co.ke/mpesa/b2c/v3/paymentrequest` |
| Production | `POST https://api.safaricom.co.ke/mpesa/b2c/v3/paymentrequest` |

**v3 is the only documented version** (v1/v2 exist only in stale tutorials). Sandbox IS available.
Auth: Bearer token + `SecurityCredential` (see getting-started.md).

## Request Parameters (official casing — verified on portal)

| Field | Type | Constraints |
|---|---|---|
| `OriginatorConversationID` | string | merchant-generated unique ID (<20 chars); duplicate ⇒ `500.002.1001`. Fresh UUID per attempt |
| `InitiatorName` | string | API operator username from portal (⚠️ NOT `Initiator` — TxStatus/Reversal use that) |
| `SecurityCredential` | string | RSA PKCS#1 v1.5 + Base64 of initiator password w/ env cert (344 chars) |
| `CommandID` | enum | `SalaryPayment` \| `BusinessPayment` \| `PromotionPayment` (registered-only except Salary) |
| `Amount` | numeric | **min KES 10 · max KES 250,000/txn · balance cap 500k · daily cap 500k** |
| `PartyA` | numeric | your B2C shortcode — funds debit the **Utility account** |
| `PartyB` | numeric | recipient MSISDN `254XXXXXXXXX` (12 digits, no `+`) |
| `Remarks` | string | 2–100 chars, required |
| `QueueTimeOutURL` | URL | timeout notice endpoint (not a failure receipt) |
| `ResultURL` | URL | receives the final `Result` callback |
| `Occassion` | string | optional, 1–100. ⚠️ **Double-s spelling is official** (other endpoints: `Occasion`) |

Sample request:

```json
{
  "OriginatorConversationID": "600997_Test_32et3241ed8yu",
  "InitiatorName": "testapi",
  "SecurityCredential": "RC6E9WDxXR4b9X2c6z3gp0oC5Th==",
  "CommandID": "BusinessPayment",
  "Amount": "10",
  "PartyA": "600992",
  "PartyB": "254705912645",
  "Remarks": "remarked",
  "QueueTimeOutURL": "https://mydomain.com/path",
  "ResultURL": "https://mydomain.com/path",
  "Occassion": "ChristmasPay"
}
```

## Sync ACK Response

```json
{
  "ConversationID": "AG_20240706_20106e9209f64bebd05b",
  "OriginatorConversationID": "600997_Test_32et3241ed8yu",
  "ResponseCode": "0",
  "ResponseDescription": "Accept the service request successfully."
}
```

## Async Result Callback (to ResultURL)

```json
{
  "Result": {
    "ResultType": 0,
    "ResultCode": 0,
    "ResultDesc": "The service request is processed successfully.",
    "OriginatorConversationID": "53e3-…",
    "ConversationID": "AG_20240706_2010364430d9bbdaf872",
    "TransactionID": "SG632NMUAB",
    "ResultParameters": {
      "ResultParameter": [
        { "Key": "TransactionAmount", "Value": 10 },
        { "Key": "TransactionReceipt", "Value": "SG632NMUAB" },
        { "Key": "ReceiverPartyPublicName", "Value": "254705912645 - NICHOLAS JOHN SONGOK" },
        { "Key": "TransactionCompletedDateTime", "Value": "06.07.2024 22:48:52" },
        { "Key": "B2CUtilityAccountAvailableFunds", "Value": 8959269.6 },
        { "Key": "B2CWorkingAccountAvailableFunds", "Value": 1199371.0 },
        { "Key": "B2CRecipientIsRegisteredCustomer", "Value": "Y" },
        { "Key": "B2CChargesPaidAccountAvailableFunds", "Value": -1980.0 }
      ]
    },
    "ReferenceData": {
      "ReferenceItem": { "Key": "QueueTimeoutURL", "Value": "https://internalsandbox…/mpesa/b2cresults/v1/submit" }
    }
  }
}
```

Parse `ResultParameters` as a Key→Value map (list of `{Key,Value}` objects). Failure example:
same shape with `"ResultCode": 2001, "ResultDesc": "The initiator information is invalid."`.

## Result Codes

`0` success · `1` insufficient utility funds · `2` below min · `3` above max · `4` daily limit ·
`8` max balance · `11` debit party invalid/inactive · `21` initiator lacks role ·
`2001` bad initiator credentials (**wrong user/password/cert/padding**) · `2006` account inactive ·
`2028` shortcode lacks B2C product permission · `2040` unregistered recipient · `8006` locked ·
`SFC_IC0003` operator/receiver does not exist.

Gateway: `500.002.1001` duplicate OriginatorConversationID · `500.003.02` spike arrest (HTTP 429) ·
`500.003.03` quota violation.

## Operational Notes

- Debits **Utility account** (top up via portal, or via B2B MMF→Utility transfer which itself
  requires Safaricom whitelisting).
- **B2C cannot be reversed via the Reversal API** — manual reversal via portal only.
- Refund latency: minutes up to 24h; status only confirmable via Result callback / Transaction Status.
- Initiator password rules: valid 90 days; allowed specials only `# & % $`.
- Role required: ORG B2C API Initiator (set via portal Set Restricted ORG API PASSWORD).

## SDK Requirements

1. `SecurityCredential` builder: load .cer file (skip expiry-chain validation — official certs are
   long-expired), RSA PKCS#1 v1.5 encrypt raw password bytes, Base64 output.
2. Generate `OriginatorConversationID` server-side when caller omits it (UUID-based).
3. Typed Result-callback parser exposing typed accessors over the parameter map.
