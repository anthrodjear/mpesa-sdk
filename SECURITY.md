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

### Branch promotion

Promotion is fully automated and runs on every green `develop` build.

- **`develop` is the integration branch.** All changes land there; it is the only branch with automated promotion.
- **Owner approves into `develop`.** Nothing merges to `develop` without an owner review.
- **Green CI auto-promotes `develop` to `main`.** When the `go`, `python`, `typescript` and `security` jobs pass on `develop`, `.github/workflows/promote.yml` opens (or reuses) a `develop` → `main` pull request and enables auto-merge, which merges once the required checks are green. The `security` job (govulncheck / bandit / npm audit) is a hard gate, not advisory — a real vulnerability finding blocks the promotion.
- **`PROMOTE_PAT` is a required repo secret.** It must be a **fine-grained personal access token** with **`contents:write`** and **`pull-requests:write`**, scoped to **this repository only**. The owner creates it under **Settings → Secrets and variables → Actions → New repository secret**.
- **Without `PROMOTE_PAT`, promotion stalls.** The workflow falls back to the built-in `GITHUB_TOKEN`, but GitHub does not run workflows for events created by `GITHUB_TOKEN`. The promotion pull request therefore never receives its required checks, and auto-merge waits forever. A loud warning is emitted on each run so the stall is visible rather than silent.

### Dependency update automation

- **Dependabot targets `develop`, never `main`.** `.github/dependabot.yml` covers npm (`/typescript`), pip (`/python`), gomod (`/go`) and `github-actions` (`/`) on a weekly schedule. Targeting `main` would bypass the `develop` → `main` promotion flow and the owner's review, so it is deliberately not done.
- **Auto-merge is deliberately narrow.** `.github/workflows/dependabot-auto-merge.yml` merges **only** a `version-update:semver-patch` bump of a **development** dependency, and only for Dependabot-authored PRs against `develop`. Skipped-by-policy, and left for **manual owner review**:
  - **production dependency patches** (e.g. Python `requests`, `cryptography`) — these are in the request path, so a patch still needs a human read;
  - **all minor bumps** and **all major bumps**, development or not;
  - **GitHub Actions bumps** — workflow changes are supply-chain-relevant by definition and are always reviewed by a person.
- **Every skipped case emits a step summary.** A skipped auto-merge is reported in the run's job summary rather than silently ignored, so a stalled queue is visible.
- **The same `PROMOTE_PAT` caveat applies.** A merge performed with the default `GITHUB_TOKEN` does not trigger workflow runs, so the push to `develop` would never fire CI and `promote.yml` would never promote the update to `main`. The workflow prefers `PROMOTE_PAT` for exactly this reason.

## Engine scope of the security controls

Some controls in this release are deliberately **not** at parity across engines. A reviewer auditing
from this document should treat the table below as the authoritative scope — a control marked
*Go only* is **absent** from the other engines, not merely undocumented there.

| Control | Go | Python | TypeScript |
|---|---|---|---|
| SPKI certificate pinning (`PinSPKI`, `Config.TLSPinningEnabled`) | ✅ | ❌ absent | ❌ absent |
| Token memory zeroing / explicit `Close()` | ✅ | ⚠️ `close()` releases the connection pool only — **no token erasure** | ❌ no `close()`, no zeroing |
| Trusted base-URL allowlist | ✅ `go/config.go` | ✅ `python/mpesa/auth.py` | ✅ `typescript/src/config.ts` **and** `typescript/src/auth.ts` (TypeScript enforces it in both, so a hand-built `TokenManager` cannot bypass it) |
| OAuth refresh rate limiting (3 failures / 5 s) | ✅ | ✅ | ✅ |
| SSRF-hardened callback URL validation | ✅ | ✅ | ✅ |

**On the Python `close()` gap:** `MpesaClient.close()` calls `self._session.close()` and nothing
more. `TokenManager._token` is left in place, so closing a client does **not** erase the cached
bearer from memory. Any user needing token erasure on shutdown should scope the client to a
short-lived process or container.

**On the callback-URL guard:** the blocked set (loopback, private, link-local, multicast,
unique-local, unspecified, IPv6 and `::ffff:`-embedded IPv4 tails, bare `localhost`, and embedded
`user:pass@` credentials) is identical across engines, and all three enforce it. But it guards the
host **literal** only — a DNS name resolving to a private address passes in all three. It is not a
DNS-rebinding filter, and should not be audited as one.

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
