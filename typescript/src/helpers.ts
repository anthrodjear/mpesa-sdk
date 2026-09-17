/**
 * Runtime verification helpers — mirrors go/helpers.go and
 * python/mpesa/helpers.py, hardening included.
 *
 * * {@link generatePassword} — STK Push/Query Password + Timestamp from a
 *   SINGLE instant; split clocks trigger intermittent `500.001.1001`
 *   (two-clock bug, docs/apis/stk-push.md). EAT per getting-started.md.
 * * {@link normalizePhone} — Kenyan MSISDN shorthand to gateway form.
 * * {@link securityCredential} — RSA PKCS#1 v1.5 of the initiator
 *   password with the M-Pesa cert (docs/apis/getting-started.md);
 *   validity dates NEVER checked (official certs ship long-expired by
 *   design). **Security note**: uses PKCS#1 v1.5, NOT OAEP — required
 *   by Safaricom's Daraja gateway.
 * * {@link newOriginatorID} — idempotency key for async APIs (<20 chars).
 *
 * **WARNING**: The EAT timezone is UTC+3 (no DST). Timestamps MUST be
 * rendered in EAT for Safaricom — UTC or any other offset causes silent
 * `500.001.1001` rejections.
 *
 * @see {@link https://github.com/anthrodjear/mpesa-sdk/blob/main/docs/apis/getting-started.md#security-credentials | Security Credentials}
 * @see {@link https://github.com/anthrodjear/mpesa-sdk/blob/main/docs/apis/getting-started.md#password | Password Section}
 * @packageDocumentation
 */

import { randomBytes, constants } from "node:crypto";
import { X509Certificate, publicEncrypt } from "node:crypto";

// ---------------------------------------------------------------------------
// EAT timezone constants
// ---------------------------------------------------------------------------

/** EAT offset in milliseconds (UTC+3, no DST). */
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// generatePassword
// ---------------------------------------------------------------------------

/**
 * Build the STK Push/Query Password and Timestamp pair from a single
 * instant. The returned timestamp MUST be sent verbatim in the request
 * body alongside the password — deriving them from different clocks
 * causes intermittent `500.001.1001` errors (the two-clock bug).
 *
 * A zero-ish Date is rejected instead of emitting well-formed garbage.
 *
 * **Timezone**: Timestamp is rendered in EAT (UTC+3). The input `Date`
 * is converted to EAT before formatting.
 *
 * @param shortcode - M-Pesa shortcode (digits only).
 * @param passkey   - Daraja passkey for the shortcode.
 * @param timestamp - The instant to derive the EAT timestamp from.
 *                    Defaults to `new Date()` (single-clock safe).
 * @returns Object with `password` (base64) and `timestamp` (EAT string).
 * @throws {Error} If the timestamp is invalid (NaN epoch).
 *
 * @example Golden vector (2021-06-28T09:24:08Z → EAT "20210628122408"):
 * ```ts
 * const { password, timestamp } = generatePassword(
 *   "174379",
 *   "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919",
 *   new Date("2021-06-28T09:24:08Z"),
 * );
 * // timestamp === "20210628122408"
 * // password === "MTc0Mzc5YmZi..."
 * ```
 * @see docs/apis/stk-push.md — "Password and Timestamp" section
 */
export function generatePassword(
  shortcode: string,
  passkey: string,
  timestamp?: Date,
): { password: string; timestamp: string } {
  const at = timestamp ?? new Date();
  if (Number.isNaN(at.getTime())) {
    throw new Error("mpesa: invalid Date cannot produce an EAT timestamp");
  }

  // Derive EAT timestamp once — single clock source
  const eatMs = at.getTime() + EAT_OFFSET_MS;
  const eatDate = new Date(eatMs);

  const y = eatDate.getUTCFullYear();
  const mo = String(eatDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(eatDate.getUTCDate()).padStart(2, "0");
  const h = String(eatDate.getUTCHours()).padStart(2, "0");
  const mi = String(eatDate.getUTCMinutes()).padStart(2, "0");
  const s = String(eatDate.getUTCSeconds()).padStart(2, "0");

  const ts = `${y}${mo}${d}${h}${mi}${s}`;

  const plaintext = shortcode + passkey + ts;
  const password = Buffer.from(plaintext, "utf-8").toString("base64");

  return { password, timestamp: ts };
}

// ---------------------------------------------------------------------------
// normalizePhone
// ---------------------------------------------------------------------------

/** Max input length before any stripping (matches Go/Python). */
const MAX_MSISDN_INPUT = 32;

/** Gateway form regex: 254 + (1|7) + 8 digits. */
const PHONE_RE = /^254[17]\d{8}$/;

/**
 * Convert Kenyan MSISDN shorthand to gateway form `254XXXXXXXXX`.
 *
 * Accepts `07XXXXXXXX`, `+2547...`, `2547...`/`2541...`. Edge
 * whitespace trimmed; spaces/dashes/parentheses stripped MID-STRING
 * too (`"0723 456 789"` normalizes). Inputs over 32 chars fail fast
 * first. Non-ASCII digit lookalikes (e.g. `"٠٧١٢٣٤٥٦٧٨"`) are rejected
 * like Go RE2.
 *
 * @param raw - Raw phone input from user.
 * @returns Normalized MSISDN starting with `254`.
 * @throws {Error} Overlong input or non-matching final shape.
 *
 * @example
 * ```ts
 * normalizePhone("+254 712-345-678"); // → "254712345678"
 * normalizePhone("0723 456 789");     // → "254723456789"
 * normalizePhone("254712345678");     // → "254712345678"
 * ```
 * @see docs/apis/getting-started.md — "Phone Number Format"
 */
export function normalizePhone(raw: string): string {
  if (raw.length > MAX_MSISDN_INPUT) {
    throw new Error("mpesa: input too long for a Kenyan MSISDN");
  }

  // Trim edges, then strip junk mid-string
  let stripped = raw.trim();
  for (const ch of [" ", "-", "(", ")"]) {
    stripped = stripped.split(ch).join("");
  }

  // Normalize prefix
  if (stripped.startsWith("+254")) {
    stripped = stripped.slice(1); // +254... → 254...
  } else if (stripped.startsWith("0")) {
    stripped = "254" + stripped.slice(1); // 0712... → 254712...
  }

  if (!PHONE_RE.test(stripped)) {
    throw new Error(
      `mpesa: ${JSON.stringify(raw)} is not a valid Kenyan MSISDN ` +
        "(want 07XX/+2547XX/2547XX)",
    );
  }

  return stripped;
}

// ---------------------------------------------------------------------------
// securityCredential
// ---------------------------------------------------------------------------

/**
 * Maximum initiator-password size in UTF-8 bytes for RSA-2048 PKCS#1 v1.5:
 * `keySize - 11 = 245` (Go `rsa.EncryptPKCS1v15` parity — longer
 * plaintexts fail inside the primitive with an opaque error, so reject
 * early with an actionable message instead).
 */
const MAX_RSA_PLAINTEXT_BYTES = 245;

/**
 * Encrypt the initiator password with the M-Pesa public key certificate
 * using RSA PKCS#1 v1.5 and base64-encode the ciphertext.
 *
 * **Security note**: Uses PKCS#1 v1.5 padding (NOT OAEP) as required
 * by Safaricom's Daraja gateway. This is a legacy padding scheme with
 * known weaknesses, but it is the mandated wire format.
 *
 * The certificate may be PEM or DER; validity dates and chains are
 * deliberately NOT verified because official certs ship long-expired
 * by design.
 *
 * Hardening (Go `*rsa.PublicKey` / Python `RSAPublicKey` parity):
 * - The certificate's public key MUST be RSA (`asymmetricKeyType === "rsa"`)
 *   — EC/EdDSA certs are rejected before any crypto runs.
 * - The UTF-8-encoded password MUST fit the RSA-2048 PKCS#1 v1.5 limit
 *   (≤ 245 bytes) — longer inputs are rejected with a length-only message
 *   that never echoes the password.
 *
 * **Argument order trap (documented divergence from Go/Python)**: this
 * function takes `(password, cert)` — password first, certificate
 * second. Go/Python take the reverse order. A fail-fast guard throws
 * when the first argument is not a string, which catches the common
 * swap where a Buffer/PEM certificate is passed as the password
 * (OWASP Input Validation: fail fast on allowlist violation rather
 * than emitting well-formed garbage).
 *
 * @param initiatorPassword - Raw UTF-8 initiator password to encrypt.
 *   MUST be a string; non-string first args throw an arg-order error.
 *   Must be non-blank and encode to ≤ 245 UTF-8 bytes.
 * @param certificatePem    - PEM or DER encoded M-Pesa certificate
 *   carrying an RSA public key.
 * @returns Base64-encoded ciphertext.
 * @throws {Error} Arg-order swap (first arg not a string), empty
 *   password, oversize password (> 245 UTF-8 bytes — message carries the
 *   byte count only, never the password), unparseable cert, or non-RSA key.
 *
 * @example
 * ```ts
 * const cred = securityCredential(
 *   "my-initiator-password",
 *   certBuffer, // Buffer from fs.readFileSync
 * );
 * // cred is base64 string, ~344 chars for RSA-2048
 * ```
 * @see docs/apis/getting-started.md — "Security Credentials" section
 */
export function securityCredential(
  initiatorPassword: string,
  certificatePem: string | Buffer,
): string {
  if (typeof initiatorPassword !== "string") {
    throw new Error(
      "mpesa: securityCredential(password, cert) — arg order swapped? password first, certificate second",
    );
  }
  if (!initiatorPassword.trim()) {
    throw new Error("mpesa: initiator_password is required");
  }
  const passwordBytes = Buffer.from(initiatorPassword, "utf-8");
  if (passwordBytes.byteLength > MAX_RSA_PLAINTEXT_BYTES) {
    throw new Error(
      `mpesa: initiator password too long for RSA-2048 PKCS#1 v1.5 ` +
        `(${passwordBytes.byteLength} bytes, max ${MAX_RSA_PLAINTEXT_BYTES})`,
    );
  }

  const certInput = typeof certificatePem === "string"
    ? Buffer.from(certificatePem, "utf-8")
    : certificatePem;

  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certInput);
  } catch {
    throw new Error("mpesa: parse M-Pesa certificate");
  }

  const publicKey = cert.publicKey;
  if (!publicKey || publicKey.asymmetricKeyType !== "rsa") {
    throw new Error("mpesa: M-Pesa certificate carries non-RSA public key");
  }

  let ciphertext: Buffer;
  try {
    ciphertext = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
      passwordBytes,
    );
  } catch {
    throw new Error("mpesa: encrypt security credential");
  }

  return ciphertext.toString("base64");
}

// ---------------------------------------------------------------------------
// newOriginatorID
// ---------------------------------------------------------------------------

/**
 * Mint a 16-hex-char idempotency key for async APIs (Daraja limit
 * <20 chars). Uses `crypto.randomBytes` with NO predictable fallback.
 *
 * @returns 16 lowercase hex characters.
 * @throws {Error} On entropy failure (never falls back to predictable IDs).
 *
 * @example
 * ```ts
 * const id = newOriginatorID(); // e.g. "a1b2c3d4e5f6a7b8"
 * payload["OriginatorConversationID"] = id;
 * ```
 * @see docs/apis/getting-started.md — "Originator Conversation ID"
 */
export function newOriginatorID(): string {
  return randomBytes(8).toString("hex");
}
