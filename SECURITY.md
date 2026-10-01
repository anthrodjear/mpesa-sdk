# Security Policy

## Supported Versions

All three SDK engines are currently released as `0.3.0`. Security fixes are applied to the **latest release only** — older patch lines do not receive backports.

| Engine     | Path         | Version | Supported                          |
|------------|--------------|---------|------------------------------------|
| Go         | `go/`        | 0.3.0   | :white_check_mark: latest only     |
| Python     | `python/`    | 0.3.0   | :white_check_mark: latest only     |
| TypeScript | `typescript/`| 0.3.0   | :white_check_mark: latest only     |

## Reporting a Vulnerability

**Do not open a public issue for a security report.**

Please use GitHub's private vulnerability reporting — the **"Report a vulnerability"** button on this repository's **Security** tab (GitHub Security Advisories). Reports submitted there remain private until a fix is available.

- **Expected response time:** within **72 hours** of your report.
- **Fix target:** **14 days** for critical vulnerabilities; best-effort scheduling for lower severities.
- Please include affected engine(s), version, a minimal reproduction, and your assessment of impact.

## Scope

**In scope:** vulnerabilities in the SDK code itself, in any of `go/`, `python/`, or `typescript/`.

**Out of scope:** behavior of Safaricom's Daraja service (availability, API-side handling of transactions, M-Pesa platform incidents). Issues with the Daraja service itself should be raised with Safaricom through their developer support channels.

## Release automation

Promotion is fully automated and runs on every green `develop` build.

- **`develop` is the integration branch.** All changes land there; it is the only branch with automated promotion.
- **Owner approves into `develop`.** Nothing merges to `develop` without an owner review.
- **Green CI auto-promotes `develop` to `main`.** When the go / python / typescript jobs pass on `develop`, `.github/workflows/promote.yml` opens (or reuses) a `develop` → `main` pull request and enables auto-merge, which merges once the required checks are green.
- **`PROMOTE_PAT` is a required repo secret.** It must be a **fine-grained personal access token** with **`contents:write`** and **`pull-requests:write`**, scoped to **this repository only**. The owner creates it under **Settings → Secrets and variables → Actions → New repository secret**.
- **Without `PROMOTE_PAT`, promotion stalls.** The workflow falls back to the built-in `GITHUB_TOKEN`, but GitHub does not run workflows for events created by `GITHUB_TOKEN`. The promotion pull request therefore never receives its required checks, and auto-merge waits forever. A loud warning is emitted on each run so the stall is visible rather than silent.

## User-Facing Hardening Notes

Brief guidance when integrating this SDK:

- **Callbacks are UNSIGNED — rank your controls.** Daraja callbacks carry no cryptographic signature: anyone who learns your endpoint URL can POST a body that parses cleanly. Defend in this order:
  1. **PRIMARY — pull-verification.** Treat every callback as a *hint*. Settle only via `stkQuery`/`STKQuery` with `ResultCode == 0`, bound to the `CheckoutRequestID` record you persisted when you fired the push. A forged body cannot survive the round-trip — this kills forged-callback settlement outright.
  2. **ENDPOINT control — bearer-capability URL tokens.** Embed an unguessable token in your registered path and gate every hit on it: Go `NewCallbackToken()`/`CallbackTokenEqual()`, Python `new_callback_token()`/`callback_token_equal()`, TypeScript `newCallbackToken()`/`callbackTokenEqual()`. This proves the caller knows the URL — nothing more. Scrub tokens from access logs/APM traces. Prefer opaque/randomized callback paths.
  3. **ANTI-REPLAY ONLY — `CheckoutRequestID` binding/dedup.** Matching an inbound ID against your records prevents duplicate processing of one event. It authenticates NOTHING against forgery: the ID rides inside the unsigned body, so a replayed or guessed ID passes any binding check.
  4. **Defense-in-depth — IP allowlisting.** Restrict ingress to Safaricom's published gateway ranges (maintained by you; they can change without notice). Never the primary control.

  Sign callback bodies yourself **only if you run your own signing relay** between Daraja and your service — Daraja signs nothing. Include a timestamp or nonce in signed payloads and reject stale signatures.
- **Never log credentials.** Consumer Key, Consumer Secret, Passkey, and Security Credential must never appear in application logs, log aggregation systems, APM traces, or debug output. The SDK's redaction helpers (`repr()`/`log_safe()` in Python, `GoString`/`Format` in Go, `toString()`/`toJSON()`/`logSafe()` in TypeScript) mask these values automatically — always use them when serializing `Config` or request objects for logging. Logging raw credentials — even at debug level — creates a persistent record that outlives the process and may be shipped to centralized log stores.
- **Consumer Keys are secrets, not identifiers.** Treat `MPESA_CONSUMER_KEY` and `MPESA_CONSUMER_SECRET` with the same care as database passwords. They authenticate every OAuth token request and grant full access to your Daraja app. Never embed them in client-side code, commit them to source control, or expose them in error messages. Rotate them immediately if you suspect leakage.
- **Indeterminate results must not auto-fail.** Timeouts or ambiguous Daraja responses should be recorded as *pending* and reconciled via the transaction status query — auto-marking them as failed risks double-charging customers.
