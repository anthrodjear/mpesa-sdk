/**
 * Typed errors for Daraja's standard error envelope — mirror of go/errors.go
 * and python/mpesa/exceptions.py. Every non-2xx response becomes one
 * {@link MpesaError}: the `{requestId, errorCode, errorMessage}` envelope when
 * present (docs/apis/getting-started.md, "Standard Error Envelope"), else a
 * safe diagnostic; members are always sanitized (Unicode Cc/Cf control code
 * points stripped, each field capped at 512 code points) so hostile gateway
 * output can never inject newlines or ANSI escapes into logs.
 *
 * @packageDocumentation
 */

/** Per-field cap, in code points (parity: `_MAX_FIELD_CHARS`). */
const MAX_FIELD_CHARS = 512;
/** Printable-ASCII cap for unparseable-body snippets (parity: `_MAX_SNIPPET_CHARS`). */
const MAX_SNIPPET_CHARS = 200;

/** Is this code point Unicode General_Category Cc (control) or Cf (format)? */
function isControlCodePoint(cp: number): boolean {
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true; // Cc: C0 + DEL..C1
  return cp === 0xad || (cp >= 0x600 && cp <= 0x605) || cp === 0x61c || cp === 0x6dd ||
    cp === 0x70f || (cp >= 0x890 && cp <= 0x891) || cp === 0x8e2 || cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) || (cp >= 0x2066 && cp <= 0x206f) ||
    cp === 0xfeff || (cp >= 0xfff9 && cp <= 0xfffb) ||
    cp === 0x110bd || cp === 0x110cd || (cp >= 0x13430 && cp <= 0x1343f) ||
    (cp >= 0x1bca0 && cp <= 0x1bca3) || (cp >= 0x1d173 && cp <= 0x1d17a) ||
    cp === 0xe0001 || (cp >= 0xe0020 && cp <= 0xe007f);
}

/** Strip Cc/Cf code points, then cap at `limit` kept code points. Astral-safe:
 *  iteration walks code points (not UTF-16 units), cap counts kept ones. */
function sanitizeWireString(value: string, limit: number = MAX_FIELD_CHARS): string {
  let out = "";
  let kept = 0;
  for (const ch of value) {
    if (kept >= limit) break;
    if (!isControlCodePoint(ch.codePointAt(0)!)) { out += ch; kept += 1; }
  }
  return out;
}

/** Up to `limit` printable-ASCII characters of `text`, for safe diagnostics. */
function asciiSnippet(text: string, limit: number = MAX_SNIPPET_CHARS): string {
  let out = "";
  for (const ch of text) {
    if (out.length >= limit) break;
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20 && cp <= 0x7e) out += ch;
  }
  return out;
}

/** Lenient envelope-field coercion: strings pass through, numbers become decimal strings,
 *  everything else counts as absent. Documented TS divergence: python accepts strings only. */
function coerceEnvelopeField(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof value === "number" ? String(value) : "";
}

/** Render the shared single-line form (go/py parity): `mpesa: HTTP n <msg> [<code>] requestId=<id>`. */
function renderMessage(
  statusCode: number, requestId: string | null,
  errorCode: string | null, errorMessage: string | null,
): string {
  const parts = [`HTTP ${statusCode}`];
  if (errorMessage) parts.push(errorMessage);
  if (errorCode) parts.push(`[${errorCode}]`);
  if (requestId) parts.push(`requestId=${requestId}`);
  return `mpesa: ${parts.join(" ")}`;
}

/**
 * The typed surface for non-2xx Daraja responses (go `Error`, py `MpesaError`):
 * `statusCode` is always set; `requestId`, `errorCode`, `errorMessage` are null
 * when absent or hostile. `message` renders Go-style via {@link renderMessage}.
 *
 * @example Raise/catch around a client call:
 * ```ts
 * try { await client.stkPush({ amount: 1, phone: "2547XXXXXXXX" }); }
 * catch (exc) {
 *   if (exc instanceof MpesaError && exc.errorCode === "401.003.01") await client.refreshToken();
 *   else throw exc;
 * }
 * ```
 */
export class MpesaError extends Error {
  /** HTTP status of the failed response (always set). */ readonly statusCode: number;
  /** Daraja `requestId` trace handle, or null when absent/hostile. */ requestId: string | null;
  /** Dotted gateway code such as "500.001.1001", or null. */ errorCode: string | null;
  /** Gateway text, an unparseable-body diagnostic, or null. */ errorMessage: string | null;

  /**
   * Build from known, pre-sanitized values — hand-raised callers pass literals;
   * anything wire-touched goes through {@link MpesaError.fromResponse}. Pins the
   * prototype chain so `instanceof` holds under down-level emits (ES5 pitfall).
   */
  constructor(statusCode: number, requestId: string | null = null,
    errorCode: string | null = null, errorMessage: string | null = null) {
    super(renderMessage(statusCode, requestId, errorCode, errorMessage));
    this.statusCode = statusCode;
    this.requestId = requestId;
    this.errorCode = errorCode;
    this.errorMessage = errorMessage;
    this.name = "MpesaError";
    Object.setPrototypeOf(this, MpesaError.prototype);
  }

  /**
   * Build an {@link MpesaError} from a raw non-2xx body. Never throws: malformed
   * JSON, wrong shapes and binary garbage fall through to an instance whose
   * `errorMessage` carries a diagnostic with byte length, content type (when
   * known) and a printable-ASCII snippet. Envelope fields accept strings and
   * numbers only (other JSON types count as absent); decoding is lossy UTF-8
   * with BOM preserved (py `errors="replace"` parity).
   *
   * @example Hostile gateway body → diagnostic, never a throw:
   * ```ts
   * const err = MpesaError.fromResponse(502, rawBytes, "text/html");
   * log.warn(err.message); // mpesa: HTTP 502 unparseable error body (...)
   * ```
   */
  static fromResponse(statusCode: number, body: string | Uint8Array, contentType = ""): MpesaError {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body).length : body.byteLength;
    const text = typeof body === "string"
      ? body : new TextDecoder("utf-8", { ignoreBOM: true }).decode(body);
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; } // deliberate fail-safe
    const env = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
    const ridRaw = coerceEnvelopeField(env["requestId"]);
    const codeRaw = coerceEnvelopeField(env["errorCode"]);
    const msgRaw = coerceEnvelopeField(env["errorMessage"]);
    const gotAny = ridRaw !== "" || codeRaw !== "" || msgRaw !== "";
    const errorMessage = gotAny ? sanitizeWireString(msgRaw) || null
      : `unparseable error body (${bytes} bytes${contentType ? `, ${contentType}` : ""}): ${asciiSnippet(text)}`;
    return new MpesaError(statusCode, sanitizeWireString(ridRaw) || null,
      sanitizeWireString(codeRaw) || null, errorMessage);
  }
}
