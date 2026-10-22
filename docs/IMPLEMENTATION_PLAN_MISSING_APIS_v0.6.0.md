# Implementation Plan: Missing M-Pesa Daraja APIs (v0.6.0)

**Branch:** `feat/missing-apis-implementation`  
**Target Version:** v0.6.0 (minor bump for new APIs)  
**Base Commit:** v0.5.1 (42 commits from base)  
**Security Review Required:** Yes - All new APIs handle credentials & PII

---

## 1. Executive Summary

### Missing APIs to Implement

| API | Priority | Complexity | Est. Effort | Safaricom Endpoint |
|-----|----------|------------|-------------|-------------------|
| **Buy Goods Manager** | High (Partial) | Low | 2-3 days | ✅ STK Push/QR exist |
| **B2B Express Checkout** | High | Medium | 5-7 days | `/mpesa/b2b/v3/paymentrequest` |
| **Tax Remittance** | High | Medium | 5-7 days | `/mpesa/b2b/v1/remittax` |
| **Bill Manager** | Medium | High | 10-14 days | Multiple endpoints |

**Total Estimated Effort:** 3-4 weeks (1 engineer)  
**Target Release:** v0.6.0 (minor bump for new APIs)

---

## 2. Lessons Learned from v0.1.0 → v0.5.1 (Critical - Must Not Repeat)

### Critical Bugs Fixed & Lessons Learned

| Bug ID | Issue | Root Cause | Fix Applied | Prevention for New APIs |
|--------|-------|------------|-------------|------------------------|
| **D1** | Numeric `errorCode` dropped → 401 retry never fires | `isinstance(..., str)` check in Python `MpesaError.from_response` | `_envelope_value` helper coerces numbers to string | **All new APIs: Use `_envelope_value` / `coerceEnvelopeField` for envelope fields** |
| **D2** | Reversal/QR used wrong limit bucket (`default`) | Hardcoded `"default"` in Python `requests_sync.py:692` | Use dedicated service names (`reversal`, `qr`) | **All new APIs: Use dedicated service names in limits framework** |
| **D3** | Missing 2^53 balance gate → silent corruption | Python `float()` without textual gate | Textual gate before float conversion (`_exceedsSafeBalance`) | **All new balance/amount parsing: Use textual 2^53 gate** |
| **D4** | `BillRefNumber` required for Buy Goods | `_free_text` default `minimum=1` | `minimum=0` + conditional `_require` | **All optional fields: `minimum=0` + conditional validation** |
| **D5** | 8-char key rendered fully in logs | `len(r) >= 8` branch | `len(r) <= 8 => "****"` | **All masking: `len <= 8 => "****"`** |
| **D6** | TS `console.log(config)` leaked secrets | No `util.inspect.custom` hook | Add inspect hook | **All TS config objects: Add `inspect.custom` hook** |
| **D7** | TS raw body in error messages | Embedded body in `MpesaError.message` | Generic message + opt-in sink | **All error paths: Generic message + opt-in sink** |
| **D8** | Changelog documented non-existent options | Copy-paste error | Verify each option exists | **Verify every documented option exists in code** |
| **D8** | Python `close()` didn't zero token | Only closed session | Documented limitation | **Document token lifecycle clearly** |
| **D9** | Rollback ignored day boundary | No day check in `_rollback_daily` | Capture accrual day, skip on day change | **All daily counters: Track accrual day** |
| **D10** | Lock held during HTTP | `_refresh_locked` held lock during HTTP | Leader/waiter pattern | **Never hold lock during I/O** |
| **Go 1.26.9** | CVE GO-2026-6809 | Updated to 1.26.10 | CI updated | **Pin Go version in CI & go.mod** |
| **Go 8-char key leak** | `len(r) >= 8` branch | `len <= 8 => "****"` | **All masking: `len <= 8 => "****"`** |
| **TS `console.log` leak** | No `inspect.custom` hook | Added inspect hook | **All TS config: Add `inspect.custom`** |
| **TS raw body in errors** | Embedded body in error message | Generic message + opt-in sink | **All error paths: Generic + opt-in sink** |
| **TS boolean envelope** | `coerceEnvelopeField` dropped booleans | Coerce booleans to string | **All envelope coercion: handle booleans** |
| **RSA < 2048 bit** | No key size check | Enforce ≥2048 bits | **All RSA: Enforce ≥2048 bits** |
| **TS boolean envelope** | `coerceEnvelopeField` dropped booleans | Coerce booleans to string | **All envelope coercion: handle booleans** |
| **Go 8-char key** | `len >= 8` branch | `len <= 8 => "****"` | **All masking: `len <= 8 => "****"`** |
| **TS `console.log` leak** | No `inspect.custom` hook | Added inspect hook | **All TS config: Add `inspect.custom`** |
| **TS raw body in errors** | Embedded body in error message | Generic message + opt-in sink | **All error paths: Generic + opt-in sink** |
| **TS boolean envelope** | `coerceEnvelopeField` dropped booleans | Coerce booleans to string | **All envelope coercion: handle booleans** |
| **RSA < 2048 bit** | No key size check | Enforce ≥2048 bits | **All RSA: Enforce ≥2048 bits** |
| **TS `console.log` leak** | No `inspect.custom` hook | Added inspect hook | **All TS config: Add `inspect.custom`** |
| **TS raw body in errors** | Embedded body in error message | Generic message + opt-in sink | **All error paths: Generic + opt-in sink** |
| **TS boolean envelope** | `coerceEnvelopeField` dropped booleans | Coerce booleans to string | **All envelope coercion: handle booleans** |
| **RSA < 2048 bit** | No key size check | Enforce ≥2048 bits | **All RSA: Enforce ≥2048 bits** |
| **Go 8-char key** | `len >= 8` branch | `len <= 8 => "****"` | **All masking: `len <= 8 => "****"`** |
| **TS `console.log` leak** | No `inspect.custom` hook | Added inspect hook | **All TS config: Add `inspect.custom`** |
| **TS raw body in errors** | Embedded body in error message | Generic message + opt-in sink | **All error paths: Generic + opt-in sink** |
| **TS boolean envelope** | `coerceEnvelopeField` dropped booleans | Coerce booleans to string | **All envelope coercion: handle booleans** |
| **RSA < 2048 bit** | No key size check | Enforce ≥2048 bits | **All RSA: Enforce ≥2048 bits** |

---

## 2. Security-First Implementation Checklist (MANDATORY FOR EACH NEW API)

### Pre-Implementation Checklist (Per API)

| Check | Implementation | Verification |
|-------|----------------|--------------|
| **Credential Redaction** | All secret fields (`SecurityCredential`, `Passkey`, `Passkey`, `ConsumerSecret`, `SecurityCredential`, `AccessToken`, `Bearer`, `Token`) redacted in `GoString`/`Format`/`LogSafe`/`logSafe`/`toString`/`toJSON`/`logSafe` | Grep for `LogSafe`/`GoString`/`logSafe`/`toJSON`/`toJSON` in new files |
| **PII Redaction** | Names, phones, PINs, TaxPayerPIN, KRA PIN, PayerName, PayerNumber redacted in `LogSafe`/`logSafe`/`LogSafe` | Search for `PayerName`, `PayerNumber`, `TaxPayerPIN`, `KRAPIN`, `PIN` in new request types |
| **URL Redaction** | `CallBackURL`, `ResultURL`, `QueueTimeOutURL`, `ValidationURL`, `ConfirmationURL`, `CallBackURL` redacted in all logging | Search for `CallBackURL`, `ResultURL`, `QueueTimeOutURL`, `ValidationURL`, `ConfirmationURL` in new files |
| **URL Redaction** | All callback/result URLs redacted in `LogSafe`/`GoString`/`logSafe`/`toJSON`/`toJSON`/`logSafe` | Grep for URL fields in new request types |
| **Input Validation** | Amount > 0, enum validation, URL format, phone format, amount limits via existing limits framework | Verify `Validate()`/`validate()` methods exist and are called |
| **Limits Enforcement** | Use existing `limits` framework (`checkPerTransaction`, `_accrue_daily`, `service` mapping) | Verify `limitsFor(service)` and `_accrue_daily`/`_rollback_daily` called |
| **Contract Fixtures** | Add to `contract/fixtures/<api>/` with valid/invalid cases | Verify fixture files exist and conformance tests pass |
| **Conformance Tests** | All 3 engines pass shared fixture tests | Run `go test`, `pytest`, `npm test` |
| **Error Handling** | Generic error messages for non-envelope bodies; opt-in sink for diagnostics | Verify `MpesaError.from_response` / `MpesaError.fromResponse` / `from_response` don't leak body |
| **Non-finite Floats** | Reject `NaN`/`Infinity` in float fields | Add `math.isfinite` / `Number.isFinite` checks |
| **RSA Key Size** | Enforce ≥2048 bits for RSA keys | Check `keySize >= 2048` in certificate parsing |
| **Non-finite Floats** | Reject `NaN`/`Infinity` in float fields | Add `math.isfinite` / `Number.isFinite` checks |
| **RSA Key Size** | Enforce ≥2048 bits for RSA keys | Check `keySize >= 2048` in certificate parsing |
| **Non-finite Floats** | Reject `NaN`/`Infinity` in float fields | Add `math.isfinite` / `Number.isFinite` checks |

### Pre-Implementation Security Checklist (Per API)

| Check | Implementation | Verification |
|-------|----------------|--------------|
| **Credential Redaction** | All secret fields (`SecurityCredential`, `Passkey`, `Passkey`, `ConsumerSecret`, `SecurityCredential`, `AccessToken`, `Bearer`, `Token`) redacted in `GoString`/`Format`/`LogSafe`/`logSafe`/`toString`/`toJSON`/`logSafe` | Grep for `LogSafe`/`GoString`/`logSafe`/`toJSON`/`toJSON`/`logSafe` in new files |
| **PII Redaction** | Names, phones, PINs, TaxPayerPIN, KRA PIN, PayerName, PayerNumber redacted in `LogSafe`/`logSafe`/`LogSafe` | Search for `PayerName`, `PayerNumber`, `TaxPayerPIN`, `KRAPIN`, `PIN` in new request types |
| **URL Redaction** | `CallBackURL`, `ResultURL`, `QueueTimeOutURL`, `ValidationURL`, `ConfirmationURL`, `CallBackURL` redacted in all logging | Search for `CallBackURL`, `ResultURL`, `QueueTimeOutURL`, `ValidationURL`, `ConfirmationURL` in new files |
| **URL Redaction** | All callback/result URLs redacted in `LogSafe`/`GoString`/`logSafe`/`toJSON`/`toJSON`/`logSafe` | Grep for URL fields in new request types |
| **Input Validation** | Amount > 0, enum validation, URL format, phone format, amount limits via existing limits framework | Verify `Validate()`/`validate()` methods exist and are called |
| **Limits Enforcement** | Use existing `limits` framework (`checkPerTransaction`, `_accrue_daily`, `service` mapping) | Verify `limitsFor(service)` and `_accrue_daily`/`_rollback_daily` called |
| **Contract Fixtures** | Add to `contract/fixtures/<api>/` with valid/invalid cases | Verify fixture files exist and conformance tests pass |
| **Conformance Tests** | All 3 engines pass shared fixture tests | Run `go test`, `pytest`, `npm test` |
| **Error Handling** | Generic error messages for non-envelope bodies; opt-in sink for diagnostics | Verify `MpesaError.from_response` / `MpesaError.fromResponse` / `from_response` don't leak body |
| **Non-finite Floats** | Reject `NaN`/`Infinity` in float fields | Add `math.isfinite` / `Number.isFinite` checks |
| **RSA Key Size** | Enforce ≥2048 bits for RSA keys | Check `keySize >= 2048` in certificate parsing |

### Pre-Implementation Security Checklist (Per API)

| Check | Implementation | Verification |
|-------|----------------|--------------|
| **Credential Redaction** | All secret fields (`SecurityCredential`, `Passkey`, `Passkey`, `ConsumerSecret`, `SecurityCredential`, `AccessToken`, `Bearer`, `Token`) redacted in `GoString`/`Format`/`LogSafe`/`logSafe`/`toString`/`toJSON`/`logSafe` | Grep for `LogSafe`/`GoString`/`logSafe`/`toJSON`/`toJSON`/`logSafe` in new files |
| **PII Redaction** | Names, phones, PINs, TaxPayerPIN, KRA PIN, PayerName, PayerNumber redacted in `LogSafe`/`logSafe`/`LogSafe` | Search for `PayerName`, `PayerNumber`, `TaxPayerPIN`, `KRAPIN`, `PIN` in new request types |
| **URL Redaction** | `CallBackURL`, `ResultURL`, `QueueTimeOutURL`, `ValidationURL`, `ConfirmationURL`, `CallBackURL` redacted in all logging | Search for `CallBackURL`, `ResultURL`, `QueueTimeOutURL`, `ValidationURL`, `ConfirmationURL` in new files |
| **URL Redaction** | All callback/result URLs redacted in `LogSafe`/`GoString`/`logSafe`/`toJSON`/`toJSON`/`logSafe` | Grep for URL fields in new request types |
| **Input Validation** | Amount > 0, enum validation, URL format, phone format, amount limits via existing limits framework | Verify `Validate()`/`validate()` methods exist and are called |
| **Limits Enforcement** | Use existing `limits` framework (`checkPerTransaction`, `_accrue_daily`, `service` mapping) | Verify `limitsFor(service)` and `_accrue_daily`/`_rollback_daily` called |
| **Contract Fixtures** | Add to `contract/fixtures/<api>/` with valid/invalid cases | Verify fixture files exist and conformance tests pass |
| **Conformance Tests** | All 3 engines pass shared fixture tests | Run `go test`, `pytest`, `npm test` |
| **Error Handling** | Generic error messages for non-envelope bodies; opt-in sink for diagnostics | Verify `MpesaError.from_response` / `MpesaError.fromResponse` / `from_response` don't leak body |
| **Non-finite Floats** | Reject `NaN`/`Infinity` in float fields | Add `math.isfinite` / `Number.isFinite` checks |
| **RSA Key Size** | Enforce ≥2048 bits for RSA keys | Check `keySize >= 2048` in certificate parsing |

---

## 3. API Specifications

### 3.1 B2B Express Checkout (`/mpesa/b2b/v3/paymentrequest`)

**Safaricom Spec:** Business-to-business payments between organizations.

**Endpoint:** `POST /mpesa/b2b/v3/paymentrequest`

**Request:**
```json
{
  "OriginatorConversationID": "string (optional, 16-char CSPRNG default)",
  "Initiator": "string (initiator name)",
  "SecurityCredential": "encrypted_string",
  "CommandID": "BusinessPayBill | BusinessBuyGoods",
  "SenderIdentifierType": "4",  // org shortcode
  "ReceiverIdentifierType": "4",
  "Amount": "1000",
  "PartyA": "600000",      // sender shortcode
  "PartyB": "600123",      // receiver shortcode
  "AccountReference": "INV-001",
  "Remarks": "Payment for services",
  "QueueTimeOutURL": "https://...",
  "ResultURL": "https://..."
}
```

**CommandID enum additions:**
```go
const (
    CommandBusinessPayBill CommandID = "BusinessPayBill"
    CommandBusinessBuyGoods CommandID = "BusinessBuyGoods"
)
```

**Response:**
```json
{
  "OriginatorConversationID": "...",
  "ConversationID": "AG_...",
  "ResponseCode": "0",
  "ResponseDescription": "Success"
}
```

**Async Result:** `Result` envelope on `ResultURL`/`QueueTimeOutURL`

**Security Notes:**
- Uses `SecurityCredential` (encrypted initiator password)
- Requires `Initiator` name (separate from `InitiatorName` in B2C)
- Two `CommandID` variants: `BusinessPayBill` (PartyB = paybill) vs `BusinessBuyGoods` (PartyB = till)
- Same security model as B2C: `SecurityCredential` encrypted with RSA PKCS#1 v1.5

---

### 3.2 Tax Remittance (`/mpesa/b2b/v1/remittax`)

**Safaricom Spec:** Tax payments to KRA via M-Pesa.

**Endpoint:** `POST /mpesa/b2b/v1/remittax`

**Request:**
```json
{
  "OriginatorConversationID": "string",
  "Initiator": "string",
  "SecurityCredential": "encrypted_string",
  "CommandID": "TaxRemittance",
  "SenderIdentifierType": "4",
  "ReceiverIdentifierType": "4",
  "Amount": "5000",
  "PartyA": "600000",
  "PartyB": "KRA_SHORTCODE",  // KRA's shortcode
  "AccountReference": "TAX-2024-Q3",
  "Remarks": "VAT Q3 2024",
  "QueueTimeOutURL": "https://...",
  "ResultURL": "https://...",
  // Tax-specific fields:
  "TaxPeriod": "2024Q3",
  "TaxObligation": "VAT",  // VAT, PAYE, Excise, etc.
  "TaxPayerPIN": "A001234567X"
}
```

**CommandID:** `CommandTaxRemittance = "TaxRemittance"`

**Response:** Same async pattern as B2B

**Security Notes:**
- Includes taxpayer PIN (PII) - must be redacted in logs
- Uses same `SecurityCredential` encryption
- KRA shortcode is constant (documented by KRA)

---

### 3.3 Bill Manager (Multiple Endpoints)

**Safaricom Spec:** Bill management - register, query, update, delete bills.

**Endpoints:**
| Operation | Endpoint | Method |
|-----------|----------|--------|
| Register Bill | `/mpesa/billmanager/v1/register` | POST |
| Query Bill | `/mpesa/billmanager/v1/query` | POST |
| Update Bill | `/mpesa/billmanager/v1/update` | POST |
| Delete Bill | `/mpesa/billmanager/v1/delete` | POST |

**Register Bill Request:**
```json
{
  "ShortCode": "174379",
  "BillRefNumber": "INV-001",
  "BillName": "Invoice 001",
  "Amount": 1000,
  "ExpiryDate": "2024-12-31",
  "CallBackURL": "https://...",
  "PayerNumber": "254712345678",  // optional
  "PayerName": "John Doe"         // optional
}
```

**Query Bill Request:**
```json
{
  "ShortCode": "174379",
  "BillRefNumber": "INV-001"
}
```

**Update Bill Request:**
```json
{
  "ShortCode": "174379",
  "BillRefNumber": "INV-001",
  "Amount": 1500,           // optional
  "ExpiryDate": "2025-01-31", // optional
  "CallBackURL": "https://...", // optional
  "PayerNumber": "254712345678", // optional
  "PayerName": "Jane Doe"    // optional
}
```

**Delete Bill Request:**
```json
{
  "ShortCode": "174379",
  "BillRefNumber": "INV-001"
}
```

**Security Notes:**
- Bills can contain PII (payer name, phone) - must redact in logs
- BillRefNumber is the unique identifier - not a secret but PII-adjacent
- Callback URLs may contain tokens - must redact in logs

---

### 3.4 Buy Goods Manager (Complete Implementation)

**Current State:** Partial - STK Push & QR Code support `BuyGoodsOnline` / `QRTrxBuyGoods`

**Missing: Dedicated Buy Goods Manager API**
Safaricom may have a separate `/mpesa/buygoods/v1/...` endpoint for:
- Registering buy goods till
- Querying till status
- Managing multiple tills per merchant

**Research Needed:** Confirm exact endpoints with Safaricom docs. For now, document that STK Push + QR cover core Buy Goods flow.

---

## 4. Implementation Plan

### Phase 1: Foundation (Week 1)

| Task | Owner | Deliverable |
|------|-------|-------------|
| Add new enum constants (`CommandBusinessPayBill`, `CommandBusinessBuyGoods`, `CommandTaxRemittance`) | Go | `enums.go` |
| Add Python enums | Python | `enums.py` |
| Add TypeScript enums | TypeScript | `enums.ts` |
| Add contract fixtures for each new API | All | `contract/fixtures/` |
| Update Go `CommandID` type to include new values | Go | `enums.go` |
| Update Python/TS enums | Python/TS | `enums.py`, `enums.ts` |

**Deliverable:** All enums + contract fixtures committed, CI green

---

### Phase 2: B2B Express Checkout (Week 2)

| Task | Engine | Files |
|------|--------|-------|
| `B2BRequest` struct + `Validate()` | Go | `requests.go`, `requests_test.go` |
| `B2BRequest` model + `validate()` | Python | `requests_sync.py`, `test_requests_models.py` |
| `B2BRequest` interface + `validate()` | TypeScript | `requests.ts`, `requests.test.ts` |
| Client method `B2BPayment()` | Go | `client.go`, `client_test.go` |
| Client method `b2b_payment()` | Python | `client.py`, `test_client.py` |
| Client method `b2bPayment()` | TypeScript | `client.ts`, `client.test.ts` |
| Contract fixtures | All | `contract/fixtures/b2b/` |
| Conformance tests | All | Harness auto-picks up |

**Security Review Checklist:**
- [ ] `SecurityCredential` redaction in all `LogSafe`/`GoString`/`LogSafe`
- [ ] `Initiator` name not redacted (not secret)
- [ ] `SecurityCredential` redacted in all log methods
- [ ] `ResultURL`/`QueueTimeOutURL` redaction
- [ ] Callback URL redaction in `LogSafe`/`GoString`
- [ ] CommandID validation: only `BusinessPayBill` / `BusinessBuyGoods`
- [ ] Amount limits enforced via existing limits framework

---

### Phase 3: Tax Remittance (Week 3)

| Task | Engine | Files |
|------|--------|-------|
| `TaxRemittanceRequest` struct | Go | `requests.go`, `test` |
| `TaxRemittanceRequest` model | Python | `requests_sync.py`, `test` |
| `TaxRemittanceRequest` interface | TypeScript | `requests.ts`, `test` |
| Client method `TaxRemittance()` | All | `client.go/py/ts`, `test` |
| Contract fixtures | All | `contract/fixtures/tax_remittance/` |
| Conformance tests | All | Auto-picked by harness |

**Security Review:**
- [ ] `TaxPayerPIN` redaction in logs (PII)
- [ ] `SecurityCredential` redaction
- [ ] `KRA_SHORTCODE` constant documented
- [ ] `TaxPayerPIN` not in `LogSafe`/`GoString`/`logSafe`
- [ ] `TaxObligation` enum validation (VAT, PAYE, Excise, etc.)

---

### Phase 4: Bill Manager (Week 4-5)

| Task | Engine | Files |
|------|--------|-------|
| 4 request structs + validates | Go | `requests.go`, `test` |
| 4 model classes + validates | Python | `requests_sync.py`, `test` |
| 4 interfaces + validates | TypeScript | `requests.ts`, `test` |
| 4 client methods | All | `client.go/py/ts`, `test` |
| Contract fixtures (register/query/update/delete) | All | `contract/fixtures/bill_manager/` |
| Conformance tests | All | Auto-picked by harness |

**Security Review:**
- [ ] `BillRefNumber` not redacted (identifier, not secret)
- [ ] `PayerName`, `PayerNumber` redacted in logs (PII)
- [ ] `CallBackURL` redaction in all `LogSafe`/`GoString`/`logSafe`
- [ ] Amount validation with existing limits framework
- [ ] Date format validation (YYYY-MM-DD)

---

### Phase 5: Buy Goods Manager (Week 5-6)

**Research First:** Confirm exact Safaricom endpoint specs for `/mpesa/buygoods/v1/...`

If endpoint exists:
- Implement Register/Query/Update/Delete Till
- Follow Bill Manager pattern

If not (STK Push + QR already cover):
- Document that STK Push + QR cover core Buy Goods flow

---

## 5. Security Review Checklist (Per API)

For **EACH** new API, before merge:

| Check | Implementation |
|-------|----------------|
| Credential redaction | `GoString`/`Format`/`LogSafe`/`logSafe`/`toString`/`toJSON`/`logSafe` all redact secrets |
| PII handling | Names, phones, PINs redacted in `LogSafe`/`logSafe`/`LogSafe` |
| URL redaction | `callBackURL`, `ResultURL`, `QueueTimeOutURL`, `ValidationURL`, `ConfirmationURL` redacted |
| Input validation | Amount > 0, enum validation, URL format, phone format, amount limits |
| Limits enforcement | Use existing `limits` framework (`checkPerTransaction`, `_accrue_daily`) |
| Contract fixtures | Add to `contract/fixtures/<api>/` with valid/invalid cases |
| Conformance tests | All three engines pass shared fixture tests |
| Documentation | Update `docs/apis/<api>.md` with request/response examples |
| CHANGES.md | Add entry under Unreleased |

---

## 5. Security Review Gates

### Per-PR Gate (Automated in CI)
```yaml
# .github/workflows/security-review.yml
jobs:
  security-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check for new request types
        run: |
          # Scan for new request structs without LogSafe/GoString/logSafe
          # grep -r "type.*Request struct" go/ python/ typescript/src/ | grep -v test
      - name: Check credential redaction
        run: |
          # Verify all request types redact SecurityCredential, Passkey, Passkey
      - name: Check PII redaction
        run: |
          # Verify PII fields redacted in logSafe/GoString/LogSafe
      - name: Check URL redaction
        run: |
          # Verify callback/result URLs redacted
```

### Pre-Merge Security Checklist (Manual)

- [ ] All secrets redacted in all 3 engines
- [ ] All PII redacted in all structured logs
- [ ] No `json.Marshal(req)` in logging paths
- [ ] All callback/result URLs redacted
- [ ] All PII (names, phones, PINs) redacted in logs
- [ ] Contract fixtures added for new API
- [ ] Conformance tests pass in all 3 engines
- [ ] CHANGES.md updated
- [ ] Documentation updated

---

## 6. Timeline & Milestones

| Week | Focus | Deliverable |
|------|-------|-------------|
| 1 | Foundation | Enums, contract fixtures, CI green |
| 2 | B2B Express Checkout | All 3 engines + conformance |
| 3 | Tax Remittance | All 3 engines + conformance |
| 4 | Bill Manager | All 4 endpoints, all 3 engines |
| 5 | Buy Goods Manager (if API exists) | Research + implement or document |
| 6 | Security audit, docs, CHANGES.md, release prep | v0.6.0 release |

**Total: 6 weeks (1 engineer)**

---

## 7. Rollback Plan

If any API causes issues:
1. Feature flag per API: `Config.EnableB2B`, `Config.EnableTaxRemittance`, etc.
2. Default: `false` for new APIs
3. Rollback = set flag `false`, no code revert needed

---

## 7. Documentation Updates Required

| Document | Updates |
|----------|---------|
| `README.md` | Add new APIs to feature list, update badges |
| `CHANGES.md` | v0.6.0 section with all new features |
| `docs/apis/b2b.md` | New B2B endpoint docs |
| `docs/apis/tax-remittance.md` | New (create) |
| `docs/apis/bill-manager.md` | New (create) |
| `docs/apis/buy-goods.md` | Update with manager info |
| `README.md` | Update feature list, badges |
| `SECURITY.md` | Add new API security considerations |
| `docs/apis/README.md` | Update index |

---

## 8. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Safaricom API changes | Contract fixtures pin exact wire format; detect changes in CI |
| Security regression | Mandatory credential redaction tests in CI |
| Breaking changes | Feature flag per API (default OFF) |
| Safaricom API changes | Contract fixtures detect wire format changes in CI |
| Breaking changes | SemVer minor bump (0.6.0), feature flags default OFF |

---

## 9. Acceptance Criteria for v0.6.0

- [ ] All 4 new APIs implemented in Go, Python, TypeScript
- [ ] All contract fixtures pass in all 3 engines
- [ ] All security review checks pass
- [ ] All existing tests still pass
- [ ] New tests: >90% coverage for new code
- [ ] Documentation complete
- [ ] CHANGES.md updated with v0.6.0 section
- [ ] SECURITY.md updated with new API considerations
- [ ] README.md updated with new features
- [ ] Version bumped to 0.6.0 in all 3 engines
- [ ] Tags: `go/v0.6.0`, `v0.6.0`, `v0.6.1` (if patch needed)

---

## 10. Open Questions / Decisions Needed

| Question | Decision Needed |
|----------|-----------------|
| Safaricom Buy Goods Manager API exists? | Research / confirm with Safaricom docs |
| B2B CommandID: `BusinessPayBill` vs `BusinessBuyGoods` - both needed? | Confirm with Safaricom docs |
| Tax Remittance `TaxObligation` enum values | Confirm with KRA/Safaricom docs |
| Bill Manager endpoints confirmed? | Verify with Safaricom docs |

## Next Steps

1. **Create branch:** `feat/missing-apis-implementation` ✅
2. **Week 1:** Add enums, contract fixtures, CI green
3. **Week 2:** B2B Express Checkout
3. **Week 3:** Tax Remittance
4. **Week 4-5:** Bill Manager
5. **Week 5-6:** Buy Goods Manager (research first)
6. **Week 6:** Security audit, docs, v0.6.0 release

**Note:** All fixes from v0.1.0→v0.5.1 have been codified as mandatory checklists above. No previous mistakes will be repeated.