# Security Audit Report: M-Pesa Daraja SDK (Go)

**Version:** v0.5.1  
**Date:** 2026-10-22  
**Module:** `github.com/anthrodjear/mpesa-sdk/go`  
**Analysis Tool:** [Google Capslock](https://github.com/google/capslock) v0.3.4

---

## Executive Summary

The M-Pesa Daraja Go SDK is a payment integration library for Safaricom's Daraja API. A static capability analysis using [Google Capslock](https://github.com/google/capslock) was performed to assess the SDK's runtime capability footprint.

**Overall Assessment: ✅ All capabilities are expected and justified.** The SDK's capability profile is exactly what's expected for a production payment SDK that communicates with Safaricom's Daraja API over HTTPS.

---

## Capability Analysis Summary

| Capability | Direct References | Assessment |
|------------|-------------------|------------|
| **NETWORK** | 24 | ✅ **Required** — HTTPS calls to Daraja API (OAuth, STK Push, B2C, C2B, etc.) |
| **FILESYSTEM** | 1 | ✅ **Required** — Certificate parsing (`x509.ParseCertificate`) for RSA PKCS#1 v1.5 encryption |
| **READ_SYSTEM_STATE** | 1 | ✅ **Required** — Time access (`time.Now`) for token expiry, timestamps |
| **ARBITRARY_EXECUTION** | 1 | ✅ **Required** — CSPRNG (`crypto/rand.Read`) for callback tokens & idempotency keys |
| **UNANALYZED** | 21 | ✅ **Expected** — Stdlib internals (`crypto/tls`, `net/http`, `encoding/json`, `crypto/x509`) |
| **UNSAFE_POINTER** | 55 | ✅ **Expected** — Stdlib internals (`crypto/tls`, `encoding/json`, `crypto/rsa`) |
| **REFLECT** | 48 | ✅ **Expected** — `encoding/json` + `FlexString`/`FlexInt64` coercion for Safaricom's inconsistent wire formats |

---

## Capability Justification

### NETWORK (24 references) — **REQUIRED**
HTTPS calls to Safaricom Daraja API:
- OAuth token endpoint (`/oauth/v1/generate`)
- STK Push/Query (`/mpesa/stkpush/v1/processrequest`, `/mpesa/stkpushquery/v1/query`)
- B2C (`/mpesa/b2c/v3/paymentrequest`)
- C2B Register/Simulate (`/mpesa/c2b/v2/registerurl`, `/mpesa/c2b/v2/simulate`)
- Transaction Status (`/mpesa/transactionstatus/v1/query`)
- Reversal (`/mpesa/reversal/v1/request`)
- Account Balance (`/mpesa/accountbalance/v1/query`)
- QR Code (`/mpesa/qrcode/v1/generate`)

**Security controls:** TLS verification enforced, TLS pinning (SPKI), trusted base URL allowlist, no redirects, 1 MiB response cap, tuned idle connection pool.

### FILESYSTEM (1 reference)

**Source:** `helpers.go` — `x509.ParseCertificate()` for loading M-Pesa public certificates (PEM/DER) for RSA PKCS#1 v1.5 encryption of `SecurityCredential`.

No file I/O at runtime — certificates passed as `[]byte` by caller.

### READ_SYSTEM_STATE (1 reference)

**Source:** `time.Now` via injected `Config.Now`
- Token expiry calculation
- EAT timestamp generation (`GeneratePassword`)
- Rate limiting (`lastRefreshAttempt`)

`Config.Now` is injectable for tests; production uses system clock.

### ARBITRARY_EXECUTION (1 reference)

**Source:** `crypto/rand.Read` via `randRead` variable
- `NewCallbackToken()` — 128-bit entropy for callback URL capabilities
- `newOriginatorID()` — 16-char hex idempotency keys for B2C

No fallback to `math/rand` — entropy failures propagate as errors (fail-closed).

### UNANALYZED / UNSAFE POINTER / REFLECT

These are **primarily standard library internals** — `crypto/tls`, `net/http`, `encoding/json`, `crypto/x509`, `crypto/rsa`, `crypto/tls` internals. The SDK itself contains **zero direct `unsafe`/`reflect`/plugin usage**.

The REFLECT count (48) includes:
- `encoding/json` marshaling/unmarshaling (all requests/responses)
- `FlexString`/`FlexInt64` coercion for Safaricom's inconsistent wire formats (numbers as strings, strings as numbers, mixed types in metadata)

---

## Security Controls in Place

| Control | Implementation |
|---------|----------------|
| **Credential Redaction** | `Config.Format`, `Config.GoString`, `Config.MarshalJSON`, `Client.GoString`, `Request.LogSafe()` — secrets never reach logs |
| **TLS Verification** | Fail-closed: rejects `InsecureSkipVerify` even through wrapper chains |
| **Certificate Pinning** | SPKI-based, snapshotted at construction, fail-closed on empty pin set |
| **Trusted Host Allowlist** | Only `sandbox.safaricom.co.ke` / `api.safaricom.co.ke` accepted |
| **SSRF Protection** | `requireURL` blocks localhost, private IPs, link-local, multicast, IPv6 zones, inet_aton aliases |
| **Response Size Limits** | 1 MiB cap on all responses; oversized bodies drained for connection reuse |
| **No Redirects** | `CheckRedirect` = `http.ErrUseLastResponse` |
| **Token Zeroing** | `zeroTokenLocked()` overwrites bearer tokens on refresh/close |
| **Password Zeroing** | `SecurityCredential()` zeros plaintext password after encryption |
| **Constant-Time Comparison** | `CallbackTokenEqual` uses `subtle.ConstantTimeCompare` |
| **Input Validation** | All requests validate amount bounds, MSISDN format, URL schema, shortcode shape |

---

## Capability Reduction Assessment

| Capability | Reducible? | Effort | Recommendation |
|------------|------------|--------|----------------|
| Reflection | Medium | Medium | Not recommended — needed for Safaricom's inconsistent wire formats |
| Unsafe Pointer | No | N/A | Stdlib internals — unavoidable |
| Unanalyzed | No | N/A | Stdlib internals — unavoidable |
| Arbitrary Execution | No | N/A | CSPRNG required for security tokens |

**Recommendation:** Do not pursue reduction — the standard library dependency is appropriate and the reflection is for documented API compatibility.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Residual Risk |
|------|------------|--------|------------|---------------|
| MITM on Daraja API | Low | Critical | TLS pinning + allowlist + InsecureSkipVerify rejection | Very Low |
| Credential Leak via Logs | Low | Critical | Multi-layer redaction (Format, GoString, MarshalJSON, LogSafe) | Very Low |
| SSRF via Callback URLs | Low | High | `requireURL` blocks internal IPs, localhost, inet_aton aliases | Low |
| Token Theft via Memory | Low | High | Zero-on-refresh, zero-on-close, short TTL (50 min max) | Low |
| Callback Forgery | Medium | High | Callback tokens (128-bit CSPRNG) + STKQuery settlement requirement | Medium |
| Replay Attacks | Low | Medium | OriginatorConversationID (16-char CSPRNG) + generation-guarded tokens | Low |
| Weak RSA Encryption | Low | Medium | 2048-bit minimum enforced, PKCS#1 v1.5 (wire-mandated) | Low |
| DoS via Oversized Responses | Low | Medium | 1 MiB cap + bounded drain (64 KiB) for connection reuse | Low |

---

## Compliance Alignment

| Standard | Alignment |
|----------|-----------|
| **OWASP ASVS 4.0** | L1/L2: TLS enforcement, input validation, secret handling, crypto agility |
| **PCI-DSS 4.0** | Req 3 (protect stored credentials), Req 4 (encrypt transmission), Req 6 (secure development) |
| **NIST SSDF** | PW.1 (protect secrets), PW.4 (verify software), PW.7 (verify integrity) |
| **SOC 2 Type II** | CC6.1 (logical access), CC6.7 (data transmission), CC7.2 (monitoring) |

---

## Conclusion

**The capslock capability profile is appropriate for a production payment SDK.** The high "Unanalyzed", "Unsafe Pointer", and "Reflection" counts reflect:

1. **Standard library internals** (TLS, HTTP, JSON, crypto) — unavoidable for any Go HTTPS client
2. **Deliberate coercion logic** (`FlexString`, `FlexInt64`) for Safaricom's inconsistent wire formats
3. **Zero direct `unsafe`/`reflect`/plugin usage** in SDK source code

**No capabilities indicate vulnerabilities or over-privilege.** The SDK implements defense-in-depth at every layer: transport (TLS pinning, allowlist), application (input validation, size limits), credential handling (zeroing, redaction), and integration guidance (callback tokens, settlement via query).

**Risk Level: LOW** — The SDK's attack surface is minimal, well-defined, and protected by multiple independent controls.

---

*Report generated by Security Engineer analysis using [Google Capslock](https://github.com/google/capslock) v0.3.4 + source code review*  
*Date: 2026-10-22 | Module: `github.com/anthrodjear/mpesa-sdk/go` v0.5.1*