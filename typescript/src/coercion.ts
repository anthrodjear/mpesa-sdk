/**
 * Lenient coercion helpers for Safaricom's inconsistent JSON value types.
 *
 * Daraja sends the same logical field with different JSON types depending
 * on endpoint: `ResponseCode` arrives as the STRING "0" in synchronous STK
 * responses but as INTEGER 0 inside callbacks; `expires_in` is the STRING
 * "3599" in official OAuth captures and a bare number elsewhere (see
 * docs/apis/stk-push.md, docs/apis/oauth.md). Callback metadata such as
 * `TransactionDate` is numeric-typed (docs/apis/stk-push.md callback).
 *
 * **Callback data is JSON with string-ified numbers**: every function here
 * accepts every observed shape and canonicalizes. Numbers are guarded to the
 * ±2^53 safe-integer range; values beyond that boundary return null/fallback
 * because their integer conversion silently corrupts precision (e.g. `1e30`
 * carries ~19 spurious digits).
 *
 * @packageDocumentation
 */

/**
 * Signed ASCII integer grammar for {@link safeJsonInt}: optional sign and
 * 1–19 ASCII digits, fully anchored. Excludes JSON-number forms (`1e3`,
 * `1.0`), whitespace, Unicode-ND digits and overlong digit runs; leading
 * zeros are accepted (Go `strconv.ParseInt` / Python `int` parity). The
 * 19-digit cap is the Go int64 / Python digit-run bound;
 * {@link Number.isSafeInteger} still rejects magnitudes beyond ±2^53 after
 * conversion.
 */
const SIGNED_ASCII_INT_RE = /^[+-]?[0-9]{1,19}$/;

/**
 * Strict signed-integer parse, or null (Go `strconv.ParseInt` / Python `int`
 * parity). Strings must match {@link SIGNED_ASCII_INT_RE}; bare numbers pass
 * only when they are finite safe integers. Never throws.
 *
 * Unlike the old `JSON.parse(String(value))` implementation, an explicit
 * sign is accepted and exponent notation is refused — exactly how Go and
 * Python parse an integer field on the wire.
 *
 * @example
 * ```ts
 * safeJsonInt("3599");  // 3599
 * safeJsonInt("+100");  // 100  (explicit sign — Go/Python accept it)
 * safeJsonInt("1e3");   // null (exponent notation is NOT an integer string)
 * safeJsonInt(3599);    // 3599
 * safeJsonInt("abc");   // null
 * safeJsonInt("9007199254740993"); // null (beyond ±2^53)
 * ```
 */
export function safeJsonInt(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== "string" || !SIGNED_ASCII_INT_RE.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Fast ASCII-digit check: returns true if `value` is a string matching
 * `/^-?\d{1,19}$/` with no leading zeros on multi-digit numbers. Rejects
 * Unicode-ND digits (e.g. "٠٢٣"), commas, whitespace, and overflow-length
 * strings. Capped at 19 digits for Go int64 / Python 19-digit parity —
 * note this exceeds JS's ±2^53 safe-integer range, so callers MUST still
 * route through {@link safeJsonInt} (which guards ±2^53) before numeric
 * conversion; this check is a shape allowlist only (OWASP Input
 * Validation), not a safe-integer proof.
 *
 * @example
 * ```ts
 * isNumericString("123");   // true
 * isNumericString("-1");    // true
 * isNumericString("01");    // false (leading zero)
 * isNumericString("٠٢٣");  // false (Unicode-ND)
 * isNumericString("1,000"); // false (comma)
 * ```
 */
export function isNumericString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!/^-?\d{1,19}$/.test(value)) return false;
  const abs = value[0] === "-" ? value.slice(1) : value;
  return abs === "0" || abs[0] !== "0";
}

/**
 * Coerce `value` to an integer. Uses {@link safeJsonInt} for parsing; falls
 * back to `opts.fallback` (default 0) on failure. Any value inside the
 * ±2^53 safe-integer range is returned verbatim — including 2147483647
 * (INT32_MAX), which Go and Python accept as an ordinary int. The old
 * TypeScript-specific sentinel throw is gone: it rejected a legitimate wire
 * value that the other SDKs happily settle with.
 *
 * `opts.field` is retained for call-site readability / future diagnostics;
 * this function never throws.
 *
 * @param value - Raw input from JSON payload (string, number, null, etc.).
 * @param opts.fallback - Value returned when parsing fails (default: 0).
 * @param opts.field - Field name at the call site (no longer used for a throw).
 *
 * @example
 * ```ts
 * coerceInt("3599");                     // 3599
 * coerceInt("abc");                      // 0 (default fallback)
 * coerceInt("abc", { fallback: -1 });   // -1
 * coerceInt(2147483647, { field: "expires_in" }); // 2147483647 (no throw)
 * ```
 */
export function coerceInt(
  value: unknown,
  opts: { fallback?: number; field?: string } = {},
): number {
  const n = safeJsonInt(value);
  return n === null ? (opts.fallback ?? 0) : n;
}

/**
 * Convenience alias for {@link safeJsonInt}. Accepts string, number, null
 * or undefined and returns the parsed integer or null.
 *
 * @example
 * ```ts
 * parseIntSafe("3599");  // 3599
 * parseIntSafe(null);    // null
 * ```
 */
export function parseIntSafe(value: unknown): number | null {
  return safeJsonInt(value);
}

/** Shared amount shape (Python `coercion._AMOUNT_RE` parity — now EXACTLY
 * matched, fraction digits included): optional sign, 1–12 integer digits,
 * at most TWO fraction digits. The 6-fraction-digit class this used to allow
 * was a copy drift: `coerce_amount("1.123456")` is None in Python
 * (pinned by test_hardening_regressions.py: ">2dp: NOT silently rounded"),
 * so accepting 3–6 dp here would let the SAME wire body settle in one
 * engine and be dropped in the other. M-Pesa amounts are whole shillings
 * plus cents; anything finer is not a valid amount.
 *  integer digits, optional fraction of 1–2 digits. ASCII-only. */
const AMOUNT_RE = /^[+-]?[0-9]{1,12}(\.[0-9]{1,2})?$/;

/** Hard cap on coerced wire strings (Python `_MAX_STR_LEN` parity). */
const MAX_WIRE_STR_LEN = 4096;

/**
 * Canonical Daraja amount as a number, or null when hostile/unknown
 * (Python `coerce_amount` parity).
 *
 * Guards, in order: booleans → null (bool is not an amount); non-finite
 * numbers (JSON `1e999` → Infinity) → null; |number| > 2^53 → null
 * (precision loss); NUMBERS must also render (via `String(value)`, JS's
 * shortest round-trip form = Python `repr`) to the same ASCII decimal shape
 * as strings — so `1.123456` and `1e21` are refused instead of silently
 * rounded; strings must fully match that shape (rejects `"1_000"`,
 * `"0x10"`, Unicode digits); every other type → null.
 *
 * @example
 * ```ts
 * coerceAmount("10.50");   // 10.5
 * coerceAmount(10.50);     // 10.5
 * coerceAmount(1.123456);  // null (sub-cent precision refused)
 * coerceAmount(1e21);      // null (exponent form refused)
 * coerceAmount(true);      // null
 * coerceAmount(9e999);     // null (non-finite)
 * ```
 */
export function coerceAmount(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > 2 ** 53) return null;
    return AMOUNT_RE.test(String(value)) ? value : null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!AMOUNT_RE.test(text)) return null;
    const parsed = Number.parseFloat(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Canonical string form of any decoded JSON wire value, or null
 * (Python `coerce_str` parity, trimmed, capped at 4096 chars).
 *
 * `null`/`undefined` → null; booleans → `"true"`/`"false"`; strings trim;
 * integral floats de-junk (`3599.0` → `"3599"`); non-finite floats
 * (`Infinity` from `1e999`) → null because `String()` would render
 * `"Infinity"`, a lie about the wire value; objects/arrays → compact JSON.
 *
 * @example
 * ```ts
 * coerceWireString(0);       // "0"
 * coerceWireString(" x ");   // "x"
 * coerceWireString(null);    // null
 * ```
 */
export function coerceWireString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let out: string;
  if (typeof value === "string") {
    out = value.trim();
  } else if (typeof value === "boolean") {
    out = value ? "true" : "false";
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    out = Number.isInteger(value) ? String(value) : String(value);
  } else {
    try {
      out = JSON.stringify(value) ?? "";
    } catch {
      return null;
    }
  }
  return out.length > MAX_WIRE_STR_LEN ? out.slice(0, MAX_WIRE_STR_LEN) : out;
}

/**
 * Non-truncating coercion for OPAQUE payload fields such as a Dynamic QR
 * `QRCode` data URI (Python `coerce_opaque_str` parity). Unlike
 * {@link coerceWireString}, the 4096-char diagnostic cap must NOT apply here:
 * silently clipping a base64/data-URI payload produces a broken QR. The whole
 * response body is already bounded by the shared ingestion cap, so retaining
 * the scalar verbatim stays bounded.
 *
 * Only JSON scalars are accepted: null/undefined → null; objects, arrays,
 * functions, symbols, bigint and other non-JSON types → null (refuse to
 * stringify a structure into a payload). Strings are trimmed, booleans render
 * as their JSON text, finite numbers use their shortest round-trip text.
 *
 * @example
 * ```ts
 * coerceOpaqueWireString("  data:image/png;base64,AAAA  "); // "data:image/png;base64,AAAA"
 * coerceOpaqueWireString({ a: 1 });  // null
 * coerceOpaqueWireString("x".repeat(10_000)).length; // 10000 (no truncation)
 * ```
 */
export function coerceOpaqueWireString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  // Objects, arrays, functions, symbols, bigint — never a QR/payload scalar.
  return null;
}

/**
 * Strict integer from lenient wire shapes, else null (Python `coerce_int`
 * parity): booleans → null; finite safe integers pass; string forms trim,
 * strip ONE surrounding quote pair, and must match the ASCII digit gate
 * (±19 digits) before parsing. Values beyond ±2^53 return null — a
 * documented JS divergence: `JSON.parse` has already rounded such
 * literals, so returning them would hand callers precision-corrupted
 * magnitudes.
 *
 * @example
 * ```ts
 * coerceWireInt("20191219102115");  // 20191219102115
 * coerceWireInt(true);              // null
 * ```
 */
export function coerceWireInt(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === "string") {
    let text = value.trim();
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
      text = text.slice(1, -1).trim();
    }
    return /^[+-]?[0-9]{1,19}$/.test(text) ? safeJsonInt(text) : null;
  }
  return null;
}
