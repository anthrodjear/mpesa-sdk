# Daraja Platform — Getting Started Essentials

> Platform-wide facts every SDK consumer needs. Source: developer.safaricom.co.ke/apis/GettingStarted
> (verified 2026-08-23).

## Environments

| Env | Base URL |
|---|---|
| Sandbox | `https://sandbox.safaricom.co.ke` |
| Production | `https://api.safaricom.co.ke` |

All business APIs: **POST**, `application/json`, Bearer token. Only OAuth is GET + Basic auth.

## Authentication

OAuth 2.0 client_credentials (`GET /oauth/v1/generate`). Token TTL ~1h; new token request
invalidates the previous one → SDKs must serialize refreshes. See [oauth.md](oauth.md).

## SecurityCredential (B2C · Transaction Status · Reversal · Account Balance)

Authoritative algorithm (official "Algorithm for Generating Security Credentials"):

1. Write the **unencrypted** initiator password into a byte array.
2. Encrypt with the M-Pesa public key X.509 certificate using **RSA with PKCS #1 v1.5 padding**
   (explicitly NOT OAEP).
3. Base64-encode the ciphertext → this string is the `SecurityCredential`.

- 2048-bit key ⇒ 256-byte ciphertext ⇒ **344-char Base64**.
- ⚠️ Use the certificate matching your environment — Sandbox ≠ Production (wrong cert ⇒ error 2001).

### Certificate downloads (public URLs)

| Env | URL |
|---|---|
| Sandbox | `https://developer.safaricom.co.ke/certificates/SandboxCertificate.cer` |
| Production | `https://developer.safaricom.co.ke/certificates/ProductionCertificate.cer` |

These certs are for API security credentials only — NOT for the M-PESA Organization portal login.

## Callback URLs & Server Requirements

### Callback URL validation (client-side)

Before a request leaves the process, the SDK validates every URL you supply — `CallBackURL`,
`ResultURL`, `QueueTimeOutURL`, `ValidationURL`, `ConfirmationURL` — and rejects:

| Rejected | Examples |
|---|---|
| Embedded credentials | `https://user:pass@host/hook` |
| `localhost` by name (case-insensitive) | `http://localhost:8000/hook` |
| Loopback | `127.0.0.0/8`, `::1`, `::ffff:127.0.0.1` |
| Private | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7` |
| Link-local | `169.254.0.0/16` (cloud metadata), `fe80::/10` |
| Multicast | `224.0.0.0/4`, `ff00::/8` |
| Unspecified | `0.0.0.0`, `::` |

The same blocked set is enforced in all three engines: `go/requests.go`, `python/mpesa/requests_sync.py`
(`_BLOCKED_NETWORKS`/`_BLOCKED_EXACT`, enforced by `_url()`), and `typescript/src/client.ts`.

> ⚠️ **This guards the host *literal* only — it is not a DNS-rebinding filter.** A name like
> `internal.corp` that resolves to `10.0.0.5` is accepted, exactly as in all three engines. If you
> need a genuine anti-rebinding control, resolve the name and check the address yourself before
> registering it with Daraja.

⚠️ **Consequence for internal testing:** if your test setup points callbacks at an internal host or
uses split-horizon DNS whose public name resolves inside your network, you will see a rejection
like `must not point to an internal or private IP address (loopback)`. Tunnel to a public host
(Ngrok / LocalTunnel) instead of registering a private address — which is what Daraja requires anyway,
since it must reach the URL from the public internet.

### Server requirements

- Asynchronous APIs POST results to `ResultURL` / `CallBackURL` / `QueueTimeOutURL`.
- Deploy an HTTP(S) listener with POST endpoints that **ACK 200 immediately**.
- If the server is unavailable, the gateway logs **503 and DISCARDS the result** — no redelivery
  guarantee. Reconcile via Transaction Status query / nightly statements.
- Production must be HTTPS. Sandbox tolerates HTTP for local testing (tunnel with Ngrok /
  LocalTunnel). Avoid literal keywords in paths: `mpesa`, `safaricom`, `exe`, `exec`, `cmd`,
  `sql`, `query`.

A hit on these URLs is a **hint**, never proof of payment — Daraja signs nothing. Rank your
controls: settle only via Transaction Status / `stk_query` (`ResultCode == 0`) bound to your
stored `CheckoutRequestID`; gate the endpoint with unguessable URL-path tokens; treat ID
matching as duplicate-suppression only (it authenticates nothing vs forgery). Full hierarchy:
[SECURITY.md](../../SECURITY.md).

## Callback Source IP Whitelist

Whitelist these gateway IPs so only Safaricom notifications are processed (official list):

```
196.201.214.200  196.201.214.206  196.201.213.114  196.201.214.207
196.201.214.208  196.201.213.44   196.201.212.127  196.201.212.138
196.201.212.129  196.201.212.136  196.201.212.74   196.201.212.69
```

> ⚠️ Configure these exact addresses in your firewall/proxy — do not substitute broad CIDR ranges (e.g. a whole /24): over-broad ranges admit non-Safaricom hosts.

⚠️ Allowlisting is **defense-in-depth, not authentication**: an IP identifies the network path,
not payload truth — and this list can change without notice (keep yours configurable, never
hardcoded). The primary control remains pull-verification via query bound to your own records;
the full controls hierarchy lives in [SECURITY.md](../../SECURITY.md) (see also ADR-010).

## Going Live Checklist

1. Active M-PESA business account: PayBill, Till Number, or B2C shortcode.
2. Access to [M-PESA Portal](https://org.ke.m-pesa.com/) with an **Admin or Business Manager**
   created (onboarding help: m-pesabusiness@safaricom.co.ke).
3. Create API operators + set restricted ORG API passwords (per-API initiator roles:
   B2C Initiator, Balance Query ORG API, Transaction Status ORG API, Org Reversals Initiator).
4. Download the **Production** certificate; regenerate SecurityCredentials.
5. Register production callback URLs (HTTPS, publicly reachable).
6. Follow the portal "Go Live" flow to obtain production app credentials.

## Standard Error Envelope (sync, HTTP 4xx/5xx)

```json
{ "requestId": "...", "errorCode": "400.002.02", "errorMessage": "Bad Request - Invalid ..." }
```

Common codes across APIs: `400.002.02` bad payload · `401.003.01` invalid/expired token ·
`404.001.03/04` resource/token issues · `500.001.1001` internal/wrong credentials ·
`500.002.1001` duplicate OriginatorConversationID · `500.003.02` spike arrest (429) ·
`500.003.03` quota violation.
