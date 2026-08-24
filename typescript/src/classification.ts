/**
 * Fail-safe bucketing of Daraja result codes for retry-safe decisions.
 *
 * Success is ONLY wire `ResultCode 0`; failure is limited to documented
 * terminal codes across STK Push (docs/apis/stk-push.md), B2C
 * (docs/apis/b2c.md) and Account Balance (docs/apis/account-balance.md)
 * catalogs; everything else is INCONCLUSIVE — debits have been observed
 * landing minutes after timeout-style codes (see docs/apis/getting-started.md
 * result-code-section). Never auto-fail, never auto-refund, never auto-retry
 * on INCONCLUSIVE — keep querying.
 *
 * Enum values are UPPER_CASE — a deliberate TypeScript idiom. Go and Python
 * use lowercase (`"success"`, `"failure"`, `"indeterminate"`) per their
 * language conventions; TS uses `"SUCCESS"`, `"FAILURE"`, `"INCONCLUSIVE"`.
 *
 * @packageDocumentation
 */

/**
 * Retry-safety bucket for a Daraja result code.
 *
 * - **SUCCESS** — Wire ResultCode 0 only; settled successfully, metadata
 *   present.
 * - **FAILURE** — Known terminal failure across all API catalogs; safe to
 *   surface as failed.
 * - **INCONCLUSIVE** — Unknown, non-terminal, or non-numeric: money MAY have
 *   moved. Never auto-fail, never auto-refund, never auto-retry — keep
 *   querying.
 */
export enum ResultClass {
  SUCCESS = "SUCCESS",
  FAILURE = "FAILURE",
  INCONCLUSIVE = "INCONCLUSIVE",
}

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
 * Accepts every observed wire variant: `"0"`, `0`, `"0.0"`, `0.0`. An ASCII
 * gate (`/^[+\-.\d]*$/`) rejects Unicode-ND digits and non-ASCII garbage
 * before numeric parsing. Integral floats (e.g. `"0.0"`) are accepted via
 * lenient `Number()` conversion with `Math.trunc` check — matching Go's
 * `strconv.ParseFloat` and Python's `float()` fallback. Non-integral floats
 * (e.g. `"1.5"`) land in INCONCLUSIVE.
 *
 * @param code - Raw ResultCode from callback or sync response.
 * @returns The classified {@link ResultClass}.
 *
 * @example
 * ```ts
 * classifyResultCode("0");      // ResultClass.SUCCESS
 * classifyResultCode("0.0");    // ResultClass.SUCCESS (lenient float)
 * classifyResultCode(0);        // ResultClass.SUCCESS
 * classifyResultCode("1");      // ResultClass.FAILURE
 * classifyResultCode("٠١");    // ResultClass.INCONCLUSIVE (Unicode-ND)
 * classifyResultCode(undefined); // ResultClass.INCONCLUSIVE
 * ```
 */
export function classifyResultCode(
  code: string | number | null | undefined,
): ResultClass {
  if (code == null) return ResultClass.INCONCLUSIVE;

  const raw = typeof code === "string" ? code.trim() : String(code);

  // ASCII gate: reject non-ASCII characters (Unicode-ND "٠١", etc.).
  if (!ASCII_GATE.test(raw) || raw === "") return ResultClass.INCONCLUSIVE;

  const n = Number(raw);
  if (!Number.isFinite(n)) return ResultClass.INCONCLUSIVE;
  if (Math.trunc(n) !== n) return ResultClass.INCONCLUSIVE; // reject non-integral

  if (n === 0) return ResultClass.SUCCESS;
  if (FAILURE_CODES.has(n)) return ResultClass.FAILURE;
  return ResultClass.INCONCLUSIVE;
}
