# Security Policy

## Supported Versions

All three SDK engines are currently released as `0.1.x`. Security fixes are applied to the **latest release only** — older patch lines do not receive backports.

| Engine     | Path         | Version | Supported                          |
|------------|--------------|---------|------------------------------------|
| Go         | `go/`        | 0.1.x   | :white_check_mark: latest only     |
| Python     | `python/`    | 0.1.x   | :white_check_mark: latest only     |
| TypeScript | `typescript/`| 0.1.x   | :white_check_mark: latest only     |

## Reporting a Vulnerability

**Do not open a public issue for a security report.**

Please use GitHub's private vulnerability reporting — the **"Report a vulnerability"** button on this repository's **Security** tab (GitHub Security Advisories). Reports submitted there remain private until a fix is available.

- **Expected response time:** within **72 hours** of your report.
- **Fix target:** **14 days** for critical vulnerabilities; best-effort scheduling for lower severities.
- Please include affected engine(s), version, a minimal reproduction, and your assessment of impact.

## Scope

**In scope:** vulnerabilities in the SDK code itself, in any of `go/`, `python/`, or `typescript/`.

**Out of scope:** behavior of Safaricom's Daraja service (availability, API-side handling of transactions, M-Pesa platform incidents). Issues with the Daraja service itself should be raised with Safaricom through their developer support channels.

## User-Facing Hardening Notes

Brief guidance when integrating this SDK:

- **Callbacks are UNSIGNED.** Daraja C2B validation/confirmation callbacks carry no cryptographic signature. Enforce authenticity at your application layer: IP allowlisting against Safaricom's published ranges, an HMAC over your own callback contract, or binding results to the `CheckoutRequestID` you generated for the original request.
- **Callback URLs are bearer capabilities.** Embed `newCallbackToken()` in your CallBackURL path and gate hits with `callbackTokenEqual()`; a hit proves URL knowledge only — never settle from a callback body. Reconcile via `stkQuery` bound to your CheckoutRequestID, and scrub tokens from access logs/APM.
- **Never commit consumer credentials.** Consumer Key/Secret must live in environment variables or a secrets manager — not in source control, logs, or client-side code.
- **Indeterminate results must not auto-fail.** Timeouts or ambiguous Daraja responses should be recorded as *pending* and reconciled via the transaction status query — auto-marking them as failed risks double-charging customers.
