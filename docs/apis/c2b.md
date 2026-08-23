# C2B — Register URL, Simulation & Validation/Confirmation Callbacks

> Receives real-time notifications when customers pay into your PayBill/Till. Register callback
> URLs once; optionally simulate payments in sandbox.

## Endpoints

| Operation | Sandbox | Production |
|---|---|---|
| Register URLs | `POST https://sandbox.safaricom.co.ke/mpesa/c2b/v2/registerurl` | `POST https://api.safaricom.co.ke/mpesa/c2b/v2/registerurl` |
| Simulate | `POST https://sandbox.safaricom.co.ke/mpesa/c2b/v2/simulate` | **Sandbox only** |

**v2 is current** — v1 posted SHA-256-hashed MSISDNs; v2 posts masked MSISDN (`2547 ***** 126`).
Auth: Bearer token.

## Register URL — Request Parameters

| Field | Type | Notes |
|---|---|---|
| `ShortCode` | numeric | PayBill/Till receiving payments |
| `ResponseType` | enum | `Completed` \| `Cancelled` — default action when your Validation URL is unreachable/slow (sentence case, exact) |
| `ConfirmationURL` | URL | receives payment-completion notification |
| `ValidationURL` | URL | only invoked if External Validation is enabled on the shortcode (default OFF; activation email to apisupport@safaricom.co.ke, ~6 h) |

## Register/Simulate ACK — ⚠️ unique shape

```json
{
  "OriginatorCoversationID": "53e3-4aa8-9fe0-8fb5e4092cdd3405976",
  "ResponseCode": "0",
  "ResponseDescription": "Accept the service request successfully."
}
```

⚠️ **`OriginatorCoversationID` is misspelled by Safaricom (missing "r")** and there is **no
`ConversationID`** field. SDK types must match this exact casing.

## Simulation — Request Parameters

| Field | Type | Notes |
|---|---|---|
| `ShortCode` | numeric | target shortcode |
| `CommandID` | enum | `CustomerPayBillOnline` (Paybill) \| `CustomerBuyGoodsOnline` (Till) |
| `Amount` | numeric | payment amount |
| `Msisdn` | numeric | payer; sandbox test number `254708374149` |
| `BillRefNumber` | string | required for Paybill (`null` for Buy Goods) |

Registration semantics: **sandbox** — re-register freely before each simulation;
**production** — one-time registration; changes require deleting URLs in Self-Service →
URL Management (validated by two operators), then re-registering.

## Validation Callback (to ValidationURL, if enabled)

```json
{
  "TransactionType": "Pay Bill",
  "TransID": "RKL51ZDR4F",
  "TransTime": "20231121121325",
  "TransAmount": "5.00",
  "BusinessShortCode": "600966",
  "BillRefNumber": "Sample Transaction",
  "InvoiceNumber": "",
  "OrgAccountBalance": "",
  "ThirdPartyTransID": "",
  "MSISDN": "2547 ***** 126",
  "FirstName": "NICHOLAS", "MiddleName": "", "LastName": ""
}
```

`TransactionType`: `"Pay Bill"` \| `"Buy Goods"` (space included). Respond within **~8 seconds**:

Accept: `{ "ResultCode": "0", "ResultDesc": "Accepted" }`
Reject: `{ "ResultCode": "C2B00011", "ResultDesc": "Rejected" }`

Rejection codes: `C2B00011` Invalid MSISDN · `C2B00012` Invalid Account Number ·
`C2B00013` Invalid Amount · `C2B00014` Invalid KYC Details · `C2B00015` Invalid Shortcode ·
`C2B00016` Other Error. Unreachable/slow validation endpoint ⇒ registered `ResponseType` applies.

Any `ThirdPartyTransID` you return echoes back in the confirmation.

## Confirmation Callback (to ConfirmationURL)

Same structure as validation plus populated names and post-payment `OrgAccountBalance`;
sent after payment completes. ACK with HTTP 200 (conventionally
`{"ResultCode": 0, "ResultDesc": "Accepted"}`).

Gateway errors: `400.003.01` invalid token · `400.002.05` bad payload ·
`500.003.1001` internal / "Urls are already registered" · `500.003.02/03` spike arrest/quota.

## SDK Requirements

1. Types for register + simulate requests; exact-casing ACK type with the misspelled field
   exposed cleanly (e.g., property `OriginatorConversationID` mapped to JSON key
   `OriginatorCoversationID`).
2. Typed parsers for validation & confirmation payloads (string amounts! masked MSISDN).
3. Helpers to build accept/reject validation responses.
4. Document that production registration is effectively one-shot — surface clear errors.
