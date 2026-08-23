# STK Push — M-Pesa Express / Lipa na M-Pesa Online

> Server-initiated push-to-pay: sends a payment prompt to the customer's phone; funds settle on
> PIN entry. Asynchronous outcome via callback; STK Query is the fallback.

## Endpoint

| Env | URL |
|---|---|
| Sandbox | `POST https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest` |
| Production | `POST https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest` |

Auth: Bearer token. All fields required.

## Request Parameters (official casing — verified on portal)

| Field | Type | Constraints |
|---|---|---|
| `BusinessShortCode` | numeric | 5–6 digit PayBill/Till (sandbox test: `174379`) |
| `Password` | string | `base64.encode(Shortcode + Passkey + Timestamp)` — plain concat, no separators |
| `Timestamp` | string | exactly 14 digits `YYYYMMDDHHmmss`, **EAT (UTC+3)** |
| `TransactionType` | enum | `CustomerPayBillOnline` \| `CustomerBuyGoodsOnline` |
| `Amount` | numeric | **whole numbers only** (no decimals) |
| `PartyA` | numeric | sender MSISDN `2547XXXXXXXX` / `2541XXXXXXXX` (12 digits, no `+`, no leading 0) |
| `PartyB` | numeric | receiving shortcode (normally = BusinessShortCode) |
| `PhoneNumber` | numeric | prompt recipient (may equal PartyA) |
| `CallBackURL` | URL | HTTPS, publicly reachable; avoid reserved keywords in path |
| `AccountReference` | string | **max 12 chars**, shown on the customer's prompt/statement |
| `TransactionDesc` | string | documented max **13 chars** (gateway tolerates ~182, then fails) |

> ⚠️ The official sample JSON below encodes a **UTC** timestamp (`20210628092408`), contradicting the EAT rule above — SDKs emit EAT (`20210628122408`). Do NOT copy the sample's Timestamp.

Sample request (official):

```json
{
  "BusinessShortCode": 174379,
  "Password": "MTc0Mzc5YmZiMjc5ZjlhYTliZGJjZjE1OGU5N2RkNzFhNDY3Y2QyZTBjODkzMDU5YjEwZjc4ZTZiNzJhZGExZWQyYzkxOTIwMjEwNjI4MDkyNDA4",
  "Timestamp": "20210628092408",
  "TransactionType": "CustomerPayBillOnline",
  "Amount": "1",
  "PartyA": "254722000000",
  "PartyB": "174379",
  "PhoneNumber": "254722111111",
  "CallBackURL": "https://mydomain.com/path",
  "AccountReference": "accountref",
  "TransactionDesc": "txndesc"
}
```

## Sync Response (HTTP 200)

```json
{
  "MerchantRequestID": "2654-4b64-97ff-b827b542881d3130",
  "CheckoutRequestID": "ws_CO_1007202409152617172396192",
  "ResponseCode": "0",
  "ResponseDescription": "Success. Request accepted for processing",
  "CustomerMessage": "Success. Request accepted for processing"
}
```

⚠️ `ResponseCode` is a **string** `"0"` and means *accepted* — NOT paid. Persist
`CheckoutRequestID`; it is Daraja's dedup/join key.

## Callback Payload (POSTed to CallBackURL)

```json
{
  "Body": {
    "stkCallback": {
      "MerchantRequestID": "29115-34620561-1",
      "CheckoutRequestID": "ws_CO_191220191020363925",
      "ResultCode": 0,
      "ResultDesc": "The service request is processed successfully.",
      "CallbackMetadata": {
        "Item": [
          { "Name": "Amount", "Value": 1.0 },
          { "Name": "MpesaReceiptNumber", "Value": "NLJ7RT61SV" },
          { "Name": "TransactionDate", "Value": 20191219102115 },
          { "Name": "PhoneNumber", "Value": 254708374149 }
        ]
      }
    }
  }
}
```

Parsing rules:
- `ResultCode` is an **integer** here (contrast with string sync ResponseCode).
- Metadata item names: `Amount` (decimal) · `MpesaReceiptNumber` · `TransactionDate`
  (**numeric-typed** YYYYMMDDHHMMSS) · `PhoneNumber`.
- On failure `CallbackMetadata` is **absent entirely** — parse defensively.

Your endpoint must ACK fast:

```json
{ "ResultCode": 0, "ResultDesc": "Accepted" }
```

Non-200 ⇒ Safaricom retries (~3 attempts); duplicate callbacks DO occur → dedupe by receipt.

## Error Envelope & Codes

```json
{ "requestId": "…", "errorCode": "400.002.02", "errorMessage": "Bad Request - Invalid BusinessShortCode" }
```

- `400.002.02` invalid payload field · `401.003.01` bad/expired token · `404.001.03`
  env/entitlement mismatch · `500.001.1001` **Wrong credentials** = Password/Timestamp mismatch
  (the two-clock bug) or merchant does not exist · `500.002.1001` internal error.

## ResultCode Catalog

| Code | Meaning | Terminal? |
|---|---|---|
| `0` | Success (metadata present) | success |
| `1` | Insufficient balance (incl. declined Fuliza) | fail |
| `17` | Internal failure | fail |
| `1001` | Unable to lock subscriber (txn in progress) | **indeterminate** |
| `1019` | Prompt expired (~1–3 min window) | fail (retryable w/ new intent) |
| `1025` | Error sending prompt (also >~182-char desc, non-Safaricom MSISDN) | fail |
| `1032` | Cancelled by user | fail (new intent ok) |
| `1037` | DS timeout — unreachable/offline phone | **indeterminate** |
| `2001` | Wrong PIN (3-attempt limit) | fail |
| `9999` | Same condition as 1025 | fail |
| `26` | System busy *(single-source)* | indeterminate |
| `4999` | Undocumented query result | **indeterminate — never auto-fail** |

## Sandbox Test Credentials

Shortcode `174379` · Passkey
`bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919` · Test MSISDN
`254708374149` · Consumer key/secret generated per sandbox app on the portal.

## SDK Requirements (ADR-010 critical rules)

1. Timestamp generated **ONCE per request**, reused in Password AND body (two-clock bug ⇒
   intermittent `500.001.1001`). EAT timezone, not UTC.
2. Phone normalization helper: accept `07..`/`+2547..`/`2547..` → emit `2547XXXXXXXX`;
   validate `^254[17]\d{8}$` before send.
3. Validate AccountReference ≤12 chars and TransactionDesc ≤13 chars client-side.
4. Amount must be integer-valued (reject 10.50 at construction).
5. Callback parser returns typed struct + normalized metadata map; tolerate missing metadata.
6. Expose ResultCode classification helpers (success/fail/indeterminate per table above).
