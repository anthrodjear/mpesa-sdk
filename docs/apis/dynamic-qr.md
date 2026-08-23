# Dynamic QR Code Generator

> Generates a dynamic QR image that M-PESA app / My Safaricom App users scan to
> capture till/paybill details + amount and authorize payment at LIPA NA M-PESA outlets.

## Endpoint

| Env | URL |
|---|---|
| Sandbox | `POST https://sandbox.safaricom.co.ke/mpesa/qrcode/v1/generate` |
| Production | `POST https://api.safaricom.co.ke/mpesa/qrcode/v1/generate` |

Auth: Bearer token. Fully synchronous — no callbacks involved.

## Request Parameters (official casing)

| Field | Type | Constraints |
|---|---|---|
| `MerchantName` | string | company/merchant name shown in app (e.g. `"TEST SUPERMARKET"`) |
| `RefNo` | string | transaction reference (invoice/order id). ⚠️ **`RefNo` — NOT `RefNumber`** |
| `Amount` | numeric | total sale amount |
| `TrxCode` | enum | `BG` Pay Merchant (Buy Goods) · `WA` Withdraw Cash at Agent Till · `PB` Paybill/Business number · `SM` Send Money (mobile) · `SB` Sent to Business (CPI in MSISDN format) |
| `CPI` | string | Credit Party Identifier — mobile number, business number, agent till, paybill, or merchant buy-goods (e.g. `"174379"`) |
| `Size` | string | QR image size in pixels (square), e.g. `"300"` |

Sample request:

```json
{
  "MerchantName": "TEST SUPERMARKET",
  "RefNo": "Invoice Test",
  "Amount": 1,
  "TrxCode": "BG",
  "CPI": "373132",
  "Size": "300"
}
```

## Response (HTTP 200)

```json
{
  "ResponseCode": "AG_20191219_000043fdf61864fe9ff5",
  "RequestID": "16738-27456357-1",
  "ResponseDescription": "QR Code Successfully Generated",
  "QRCode": "<alpha-numeric string containing the QR code image/data>"
}
```

- ⚠️ Here `ResponseCode` is an **opaque alphanumeric tracking string** (<20 chars), not `"0"`/
  numeric status — different semantics from every other endpoint. Do not validate it as a status.
- `QRCode` carries the generated image payload (render/decode per Safaricom's returned format).
- `RequestID` — proxy request identifier.

Failures use the standard `requestId`/`errorCode`/`errorMessage` envelope.

## Validation Rules for SDK Helpers

1. `TrxCode` ∈ {BG, WA, PB, SM, SB} — reject others client-side.
2. CPI format depends on TrxCode: SM/SB expect MSISDN-format (`2547XXXXXXXX`); BG/PB/WA expect
   till/paybill/business numbers — validate loosely (digits, length 5–12) and document.
3. `Amount` > 0; `Size` positive integer string; `MerchantName`/`RefNo` non-empty.

## SDK Design Notes

- Single method per language: `GenerateQR(req)` / `generate_qr()` / `generateQr()`.
- Return typed struct exposing `QRCode` payload verbatim (no server-side decoding).
- Unit-test: happy path passthrough, TrxCode whitelist rejection, RefNo field-name assertion
  (serialize and assert `"RefNo"` key present, `"RefNumber"` absent).
