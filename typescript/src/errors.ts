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

/**
 * Control/format detector: Unicode General_Category `Cc` (control) or `Cf`
 * (format) — e.g. `\x1b`, `\n`, `\x07`, zero-width spaces. Uses a Unicode
 * property escape, which REQUIRES the `u` flag (`/\p{Cc}|\p{Cf}/u` without
 * it is a SyntaxError) — see MDN "Unicode character class escape:
 * `\p{...}`, `\P{...}`" (the `u`/`v` flag section). Single source of truth
 * replacing the previous 11-clause code-point OR-chain (same strip set:
 * every Cc/Cf point, astral-safe since `for..of` walks code points).
 */
const CONTROL_RE = /[\p{Cc}\p{Cf}]/u;

/** Is this code point Unicode General_Category Cc (control) or Cf (format)? */
function isControlCodePoint(cp: number): boolean {
  return CONTROL_RE.test(String.fromCodePoint(cp));
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
 * Decode a JSON body into a plain object, or `null` when it is not one —
 * NEVER throws. Used on the 401.003.01 retry probe where a malformed body
 * simply means "no Daraja error envelope, do not retry".
 *
 * @param body - Raw response body text.
 * @returns The decoded object, or null for invalid JSON / non-object JSON
 *   (`null`, arrays, scalars).
 */
export function tryDecodeJsonObject(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Single guarded JSON-object decoder for every SDK response/callback parse
 * path. Replaces the `JSON.parse(body) as T` pattern that let
 * `TypeError`/`SyntaxError` escape the typed {@link MpesaError} contract.
 *
 * Guards (in order):
 * 1. `JSON.parse` failure → {@link MpesaDecodeError} (a captive-portal HTML
 *    page or an empty body lands here, not in a raw SyntaxError).
 * 2. Non-object JSON (`"null"`, `"42"`, `"[]"`) → {@link MpesaDecodeError}
 *    (previously `JSON.parse("null")` succeeded and the subsequent property
 *    read threw `TypeError: Cannot read properties of null`).
 *
 * @typeParam T - Expected response shape; the guard proves "plain object",
 *   individual field shapes remain the caller's responsibility (same trust
 *   level as the previous hand-written cast, minus the crash class).
 * @param body - Raw response body text.
 * @param label - Optional context (endpoint path / corpus name) for the message.
 * @returns The decoded object cast to `T`.
 * @throws {MpesaDecodeError} When the body is not a JSON object.
 *
 * @example
 * ```ts
 * const resp = decodeJsonObject<STKPushResponse>(body, STK_PUSH_PATH);
 * ```
 */
export function decodeJsonObject<T>(body: string, label?: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    const reason = err instanceof Error ? err.name : "SyntaxError";
    throw new MpesaDecodeError(
      `mpesa: decode ${label ? `${label} ` : ""}body: invalid JSON (${reason})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MpesaDecodeError(
      `mpesa: decode ${label ? `${label} ` : ""}body: expected a JSON object, got ${Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed}`,
    );
  }
  return parsed as T;
}

/**
 * The typed surface for non-2xx Daraja responses (go `Error`, py `MpesaError`):
 * `statusCode` is always set; `requestId`, `errorCode`, `errorMessage` are null
 * when absent or hostile. `message` renders Go-style via {@link renderMessage}.
 *
 * @example Raise/catch around a client call:
 * ```ts
 * try { await client.stkPush(req); }
 * catch (exc) {
 *   if (exc instanceof MpesaError) {
 *     console.error(exc.statusCode, exc.requestId, exc.errorCode, exc.errorMessage);
 *   } else {
 *     throw exc;
 *   }
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

/**
 * Raised when a 2xx (or otherwise parseable) response/callback body cannot
 * be decoded into the expected JSON object shape. Subclasses
 * {@link MpesaError} so existing `catch (e) { if (e instanceof MpesaError) }`
 * handlers keep working — the failure mode this replaces was a raw
 * `TypeError`/`SyntaxError` escaping that contract (e.g. `JSON.parse("null")`
 * succeeds and then `probe["errorCode"]` throws, or a 2xx HTML error page
 * from a captive portal throws `SyntaxError`).
 *
 * `statusCode` carries the HTTP status when the body came from a response
 * (0 for locally-decoded bodies such as callback POSTs).
 *
 * Declared AFTER {@link MpesaError}: a subclassing `extends` clause evaluates
 * its parent at class-definition time, so the parent must already be
 * initialized (class-declaration TDZ otherwise throws at module load).
 *
 * @example
 * ```ts
 * try { await client.stkPush(req); }
 * catch (e) {
 *   if (e instanceof MpesaDecodeError) log.warn("bad gateway body", e.statusCode);
 * }
 * ```
 */
export class MpesaDecodeError extends MpesaError {
  /**
   * @param message - Full diagnostic; the `mpesa: ` prefix is enforced here so
   *   every SDK error message keeps one canonical prefix.
   * @param statusCode - HTTP status of the offending response (0 when unknown).
   */
  constructor(message: string, statusCode = 0) {
    super(statusCode);
    // Override the HTTP-style rendering: decode failures are local parse
    // problems, not gateway envelopes.
    this.message = message.startsWith("mpesa: ") ? message : `mpesa: ${message}`;
    this.name = "MpesaDecodeError";
    Object.setPrototypeOf(this, MpesaDecodeError.prototype);
  }
}
