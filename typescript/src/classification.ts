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

// ASCII digits 0x30–0x39 only; rejects Unicode-ND ("٠٢٣"), commas, spaces, signs.
const ASCII_DIGITS = /^[\x30-\x39]*$/;

/**
 * Map any raw result-code shape to its {@link ResultClass} bucket.
 *
 * Accepts every observed wire variant: `"0"`, `0`, `"0.0"`, `0.0`. An ASCII
 * gate (`/^[\x30-\x39]*$/`) rejects Unicode-ND digits and non-numeric garbage
 * before numeric parsing, landing them in INCONCLUSIVE.
 *
 * @param code - Raw ResultCode from callback or sync response.
 * @returns The classified {@link ResultClass}.
 *
 * @example
 * ```ts
 * classifyResultCode("0");      // ResultClass.SUCCESS
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

  // ASCII gate: reject non-ASCII digits (e.g. Unicode-ND "٠١").
  if (!ASCII_DIGITS.test(raw)) return ResultClass.INCONCLUSIVE;
  if (raw === "") return ResultClass.INCONCLUSIVE;

  const n = Number(raw);
  if (!Number.isFinite(n)) return ResultClass.INCONCLUSIVE; // defensive

  if (n === 0) return ResultClass.SUCCESS;
  if (FAILURE_CODES.has(n)) return ResultClass.FAILURE;
  return ResultClass.INCONCLUSIVE;
}
