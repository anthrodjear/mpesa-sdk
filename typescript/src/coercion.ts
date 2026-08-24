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

/** INT32_MAX sentinel — Daraja signals 32-bit overflow with this exact value. */
const INT32_MAX = 2_147_483_647;

/**
 * Attempt to parse `value` as a JSON number via `JSON.parse(String(value))`.
 * Returns the result if it is a finite safe integer (±2^53); returns null on
 * failure, overflow, NaN, Infinity, or non-numeric JSON types. Never throws.
 *
 * @example
 * ```ts
 * safeJsonInt("3599");  // 3599
 * safeJsonInt(3599);    // 3599
 * safeJsonInt("abc");   // null
 * safeJsonInt("9007199254740993"); // null (beyond ±2^53)
 * ```
 */
export function safeJsonInt(value: unknown): number | null {
  try {
    const parsed = JSON.parse(String(value));
    if (typeof parsed !== "number") return null;
    return Number.isFinite(parsed) && Number.isSafeInteger(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Fast ASCII-digit check: returns true if `value` is a string matching
 * `/^-?\d{1,15}$/` with no leading zeros on multi-digit numbers. Rejects
 * Unicode-ND digits (e.g. "٠٢٣"), commas, whitespace, and overflow-length
 * strings. Capped at 15 digits because any 15-digit integer fits in JS's
 * ±2^53 safe range.
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
  if (!/^-?\d{1,15}$/.test(value)) return false;
  const abs = value[0] === "-" ? value.slice(1) : value;
  return abs === "0" || abs[0] !== "0";
}

/**
 * Coerce `value` to an integer. Uses {@link safeJsonInt} for parsing; falls
 * back to `opts.fallback` (default 0) on failure. Throws `RangeError` when
 * the parsed value equals the INT_MAX sentinel (2^31-1), which Daraja uses
 * to signal 32-bit overflow.
 *
 * @param value - Raw input from JSON payload (string, number, null, etc.).
 * @param opts.fallback - Value returned when parsing fails (default: 0).
 * @param opts.field - Field name for the diagnostic message on RangeError.
 * @throws {RangeError} When the value equals INT32_MAX (2^31-1).
 *
 * @example
 * ```ts
 * coerceInt("3599");                     // 3599
 * coerceInt("abc");                      // 0 (default fallback)
 * coerceInt("abc", { fallback: -1 });   // -1
 * coerceInt(2147483647, { field: "expires_in" }); // throws RangeError
 * ```
 */
export function coerceInt(
  value: unknown,
  opts: { fallback?: number; field?: string } = {},
): number {
  const n = safeJsonInt(value);
  if (n === null) return opts.fallback ?? 0;
  if (n === INT32_MAX) {
    // TS-specific: Go/Python don't throw here — their int types absorb the value.
    const field = opts.field ?? "value";
    throw new RangeError(`mpesa: ${field} exceeds 32-bit range (${n})`);
  }
  return n;
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
