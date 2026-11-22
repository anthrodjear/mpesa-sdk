/**
 * Fail-safe bucketing of Daraja result codes for retry-safe decisions.
 *
 * Success is ONLY wire `ResultCode 0`; failure is limited to documented
 * terminal codes across STK Push (docs/apis/stk-push.md), B2C
 * (docs/apis/b2c.md) and Account Balance (docs/apis/account-balance.md)
 * catalogs; everything else is INDETERMINATE (formerly INCONCLUSIVE) — debits
 * have been observed landing minutes after timeout-style codes (see
 * docs/apis/getting-started.md result-code-section). Never auto-fail, never
 * auto-refund, never auto-retry on INDETERMINATE — keep querying.
 *
 * Enum VALUES are lowercase strings matching Go and Python serialization
 * exactly: `"success"`, `"failure"`, `"indeterminate"`. Member names stay
 * idiomatic TypeScript (`ResultClass.SUCCESS`, …), with the canonical
 * third-bucket name `ResultClass.INDETERMINATE` (Go/Python-style callers
 * compile against it); `INCONCLUSIVE` remains as a deprecated alias with the
 * SAME value.
 *
 * @packageDocumentation
 */

/**
 * Retry-safety bucket for a Daraja result code.
 *
 * - **SUCCESS** — Wire ResultCode 0 only; settled successfully, metadata
 *   present. Serializes as `"success"`.
 * - **FAILURE** — Known terminal failure across all API catalogs; safe to
 *   surface as failed. Serializes as `"failure"`.
 * - **INDETERMINATE** — Unknown, non-terminal, or non-numeric: money MAY have
 *   moved. Never auto-fail, never auto-refund, never auto-retry — keep
 *   querying. Serializes as `"indeterminate"`. `INCONCLUSIVE` is a deprecated
 *   alias for this same bucket/value.
 */
export enum ResultClass {
  SUCCESS = "success",
  FAILURE = "failure",
  /** Canonical name for the `indeterminate` wire value (Go/Python parity). */
  INDETERMINATE = "indeterminate",
  /** @deprecated Use {@link ResultClass.INDETERMINATE} (identical value). */
  INCONCLUSIVE = "indeterminate",
}

// The alias is a SOURCE-COMPATIBILITY SPELLING, not a fourth bucket: keep it
// out of Object.keys/Object.values so reflection still reports exactly the
// three distinct wire values (and duplicate-value checks keep holding).
Object.defineProperty(ResultClass, "INCONCLUSIVE", { enumerable: false });

// ── Terminal-failure code sets (frozen for O(1) lookup, immutable) ──────────

/** STK Push terminal failures — docs/apis/stk-push.md ResultCode Catalog. */
const STK_FAILURE = Object.freeze(new Set([1, 17, 1019, 1025, 1032, 2001, 9999]));

/** Async B2C Result callback failures — docs/apis/b2c.md. */
const B2C_FAILURE = Object.freeze(new Set([2, 3, 4, 8, 11, 21, 2006, 2028, 2040, 8006]));

/** Account Balance async Result failures — docs/apis/account-balance.md. */
const ACCOUNT_BALANCE_FAILURE = Object.freeze(new Set([15, 22]));

/** Union of every documented terminal-failure code (Go parity: 17/21 shared). */
const FAILURE_CODES = Object.freeze(
  new Set([...STK_FAILURE, ...B2C_FAILURE, ...ACCOUNT_BALANCE_FAILURE]),
);

// ASCII gate: allows digits, decimal point, and sign; rejects Unicode-ND ("٠٢٣"),
// commas, spaces, and other non-ASCII characters.
const ASCII_GATE = /^[+\-.\d]*$/;

/**
 * Map any raw result-code shape to its {@link ResultClass} bucket.
 *
 * Accepts every observed wire variant: `"0"`, `0`, `"0.0"`, `0.0`, and the
 * double-quote-wrapped form some gateways emit (`'"0"'`). Surrounding
 * double quotes are stripped before the ASCII gate — cutset semantics,
 * parity with Go `strings.Trim(code, "\"")` and Python `raw.strip('"')`.
 * The ASCII gate (`/^[+\-.\d]*$/`) then rejects Unicode-ND digits and
 * non-ASCII garbage before numeric parsing. Integral floats (e.g. `"0.0"`)
 * are accepted via lenient `Number()` conversion with `Math.trunc` check —
 * matching Go's `strconv.ParseFloat` and Python's `float()` fallback.
 * Non-integral floats (e.g. `"1.5"`) land in INCONCLUSIVE.
 *
 * @param code - Raw ResultCode from callback or sync response.
 * @returns The classified {@link ResultClass}.
 *
 * @example
 * ```ts
 * classifyResultCode("0");      // ResultClass.SUCCESS
 * classifyResultCode('"0"');    // ResultClass.SUCCESS (quote-wrapped)
 * classifyResultCode("0.0");    // ResultClass.SUCCESS (lenient float)
 * classifyResultCode(0);        // ResultClass.SUCCESS
 * classifyResultCode('"1032"'); // ResultClass.FAILURE (quote-wrapped)
 * classifyResultCode("1");      // ResultClass.FAILURE
 * classifyResultCode("٠١");    // ResultClass.INDETERMINATE (Unicode-ND)
 * classifyResultCode(undefined); // ResultClass.INDETERMINATE
 * ```
 */
export function classifyResultCode(
  code: string | number | null | undefined,
): ResultClass {
  if (code == null) return ResultClass.INDETERMINATE;

  let raw = typeof code === "string" ? code.trim() : String(code);

  // Cutset-trim surrounding double quotes (Go strings.Trim / Py strip('"')
  // parity): strips every leading/trailing '"' regardless of pairing.
  raw = raw.replace(/^"+|"+$/g, "");

  // ASCII gate: reject non-ASCII characters (Unicode-ND "٠١", etc.).
  if (!ASCII_GATE.test(raw) || raw === "") return ResultClass.INDETERMINATE;

  const n = Number(raw);
  if (!Number.isFinite(n)) return ResultClass.INDETERMINATE;
  if (Math.trunc(n) !== n) return ResultClass.INDETERMINATE; // reject non-integral

  if (n === 0) return ResultClass.SUCCESS;
  if (FAILURE_CODES.has(n)) return ResultClass.FAILURE;
  return ResultClass.INDETERMINATE;
}
