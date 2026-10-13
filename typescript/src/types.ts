/**
 * SDK wire types — request payloads, response envelopes, callback shapes,
 * and async-result structures. Mirrors Go (go/*.go) and Python
 * (python/mpesa/*.py) reference implementations.
 *
 * **Naming rules**:
 * - Request properties use camelCase (TypeScript convention).
 * - Response/callback properties use PascalCase (matching JSON wire keys).
 * - All intentional misspellings are preserved and annotated.
 *
 * **`exactOptionalPropertyTypes`**: When constructing objects with optional
 * fields, use conditional spread to avoid assigning `undefined`:
 * ```ts
 * { ...base, ...(occasion !== undefined && { occasion }) }
 * ```
 *
 * @packageDocumentation
 */

// ─── Section 1: Enums (import + re-export) ───────────────────────────────────
import {
  TransactionType,
  CommandID,
  ResponseType,
  QRTrxCode,
} from "./enums.js";
export { TransactionType, CommandID, ResponseType, QRTrxCode };
import { coerceAmount, coerceWireInt, coerceWireString } from "./coercion.js";
import { ResultClass, classifyResultCode } from "./classification.js";
import { MpesaDecodeError, decodeJsonObject } from "./errors.js";
import { bodyTooLargeError } from "./_bounded-read.js";

// ─── Section 2: Request interfaces ───────────────────────────────────────────

/** STK Push (Lipa Na M-Pesa Online) request body. */
export interface STKPushRequest {
  /**
   * Client-injected — defaults to config shortcode when empty.
   * Callers typically omit this.
   */
  readonly businessShortCode?: string | undefined;
  readonly transactionType: TransactionType;
  readonly amount: number;
  readonly partyA: string;
  /** Defaults to `businessShortCode` when empty. */
  readonly partyB?: string | undefined;
  readonly phoneNumber: string;
  readonly callBackURL: string;
  readonly accountReference: string;
  readonly transactionDesc: string;
}

/** STK Push query status request body. */
export interface STKQueryRequest {
  /**
   * Client-injected — defaults to config shortcode when empty; when set,
   * the injected Password binds to THIS shortcode.
   * Callers typically omit this.
   */
  readonly businessShortCode?: string | undefined;
  readonly checkoutRequestID: string;
}

/** B2C (Business to Customer) payout request body. */
export interface B2CRequest {
  /**
   * Auto-generated when empty — 16 lowercase hex chars (≤20 per Daraja
   * constraint). Serves as the idempotency key for retries.
   */
  readonly originatorConversationID?: string | undefined;
  readonly initiatorName: string;
  readonly securityCredential: string;
  readonly commandID: CommandID;
  readonly amount: number;
  /** Defaults to config shortcode when empty. */
  readonly partyA?: string | undefined;
  readonly partyB: string;
  readonly remarks: string;
  readonly queueTimeOutURL: string;
  readonly resultURL: string;
  readonly occasion?: string | undefined;
}

/**
 * Alias for {@link B2CRequest} — the B2C payout request body.
 *
 * Added for naming consistency (`b2cPayout` ↔ `B2CPayoutRequest`); the
 * canonical name stays {@link B2CRequest}. Wire output is identical —
 * this is a pure type alias, zero runtime footprint.
 */
export type B2CPayoutRequest = B2CRequest;

/**
 * Common fields shared by both XOR variants of {@link TransactionStatusRequest}.
 * `commandID` and `identifierType` are client-defaulted when omitted.
 */
interface TransactionStatusBase {
  readonly initiator: string;
  readonly securityCredential: string;
  readonly commandID?: CommandID | undefined;
  readonly partyA: string;
  readonly identifierType?: string | undefined;
  readonly resultURL: string;
  readonly queueTimeOutURL: string;
  readonly remarks: string;
  readonly occasion?: string | undefined;
}

/**
 * Transaction status query request body — receipt XOR conversation ID,
 * enforced at TYPE level: exactly one of `transactionID` /
 * `originalConversationID` must be present. Passing both (or neither) is a
 * compile error; the runtime check remains as defense for JS callers.
 */
export type TransactionStatusRequest = TransactionStatusBase &
  (
    | { readonly transactionID: string; readonly originalConversationID?: never }
    | { readonly transactionID?: never; readonly originalConversationID: string }
  );

/** Account balance query request body. */
export interface AccountBalanceRequest {
  readonly initiator: string;
  readonly securityCredential: string;
  /** Defaults to AccountBalance when omitted. */
  readonly commandID?: CommandID | undefined;
  readonly partyA: string;
  readonly identifierType?: string | undefined;
  readonly remarks: string;
  readonly queueTimeOutURL: string;
  readonly resultURL: string;
}

/**
 * Transaction reversal request body.
 * @warning `recieverIdentifierType` is a deliberate misspelling matching the
 * Daraja wire key `"RecieverIdentifierType"`. Do not "fix" to
 * `receiverIdentifierType`.
 */
export interface ReversalRequest {
  readonly initiator: string;
  readonly securityCredential: string;
  /** Defaults to TransactionReversal when omitted. */
  readonly commandID?: CommandID | undefined;
  readonly transactionID: string;
  readonly amount: number;
  readonly receiverParty: string;
  readonly recieverIdentifierType?: string | undefined;
  readonly resultURL: string;
  readonly queueTimeOutURL: string;
  readonly remarks: string;
}

/** C2B URL registration request body. */
export interface C2BRegisterRequest {
  readonly shortCode?: string | undefined;
  readonly responseType: ResponseType;
  readonly confirmationURL: string;
  readonly validationURL: string;
}

/** C2B payment simulation request body (test environment). */
export interface C2BSimulateRequest {
  /**
   * Client-injected — defaults to config shortcode when empty/omitted
   * (Go/Py parity). Callers typically omit this.
   */
  readonly shortCode?: string | undefined;
  readonly commandID: CommandID;
  readonly amount: number;
  readonly msisdn: string;
  /**
   * Required for `CustomerPayBillOnline` simulations; omit (or pass
   * `undefined`) for `CustomerBuyGoodsOnline`.
   */
  readonly billRefNumber?: string | undefined;
}

/**
 * Dynamic QR code generation request body.
 * Field names match the QR Spec — do not rename to camelCase.
 */
export interface DynamicQRRequest {
  readonly merchantName: string;
  readonly refNo: string;
  readonly amount: number;
  readonly trxCode: QRTrxCode;
  readonly cpi: string;
  readonly size: string;
}

/**
 * Alias for {@link DynamicQRRequest} — the dynamic QR generation request body.
 *
 * Added for naming consistency (`generateQRCode` ↔ `QRCodeRequest`); the
 * canonical name stays {@link DynamicQRRequest}. Wire output is identical —
 * this is a pure type alias, zero runtime footprint.
 */
export type QRCodeRequest = DynamicQRRequest;

// ─── Section 3: Response interfaces ──────────────────────────────────────────

/** STK Push synchronous response from Daraja. */
export interface STKPushResponse {
  readonly MerchantRequestID: string;
  readonly CheckoutRequestID: string;
  readonly ResponseCode: string;
  readonly ResponseDescription: string;
  readonly CustomerMessage: string;
}

/** STK Push query response envelope. */
export interface STKQueryResponse {
  readonly ResponseCode: string;
  readonly ResponseDescription: string;
  readonly MerchantRequestID: string;
  readonly CheckoutRequestID: string;
  /**
   * STK Query result code — the gateway emits BOTH `"1032"` (string) and
   * `1032` (number) depending on gateway version (same trap as
   * {@link StkCallbackResult.ResultCode}; Go `FlexString` / Python
   * `str`-normalization parity).
   *
   * The type is `string | number` for back-compat; `MpesaClient.stkQuery`
   * normalizes it to `string` via `String()` before returning, so callers
   * normally observe a string. When reading raw JSON (fixtures, replays),
   * ALWAYS normalize with `String()` before numeric comparison — never
   * `===` against a single-type literal.
   */
  readonly ResultCode: string | number;
  readonly ResultDesc: string;
}

/** Conversation-based response (B2C, Reversal, Transaction Status). */
export interface ConversationResponse {
  readonly OriginatorConversationID: string;
  readonly ConversationID: string;
  readonly ResponseCode: string;
  readonly ResponseDescription: string;
}

/**
 * C2B URL registration acknowledgement.
 * @warning `OriginatorCoversationID` is a deliberate misspelling matching the
 * Daraja wire key `"OriginatorCoversationID"`. Do not "fix" to
 * `OriginatorConversationID`.
 */
export interface C2BAckResponse {
  /**
   * @warning Misspelled wire key — `"OriginatorCoversationID"` (missing the
   * second 's' in Conversation). Preserved for wire compatibility.
   */
  readonly OriginatorCoversationID: string;
  readonly ResponseCode: string;
  readonly ResponseDescription: string;
}

/** QR code generation response. */
export interface QRCodeResponse {
  readonly ResponseCode: string;
  readonly RequestID: string;
  readonly ResponseDescription: string;
  readonly QRCode: string;
}

/**
 * OAuth access token from Daraja.
 *
 * @warning `expiresIn` arrives as a **string** (`"3599"`) from the wire,
 * NOT a number. Parse with `parseInt()` before using numerically.
 * Both Go and Python document this same trap.
 */
export interface OAuthToken {
  readonly accessToken: string;
  /** Wire type is string (`"3599"`), not number — Safaricom quirk. */
  readonly expiresIn: string;
  readonly tokenType: string;
}

// ─── Section 4: Callback types ───────────────────────────────────────────────

/** A single key-value metadata item within an STK callback. */
export interface MetadataItem {
  readonly Name: string;
  readonly Value: unknown;
}

/**
 * Callback result payload from STK Push async callback.
 *
 * The gateway sends `ResultCode` as BOTH `0` (number) and `"0"`
 * (string) depending on gateway version — same trap as
 * {@link STKQueryResponse.ResultCode}. The type is `string | number`
 * for back-compat; callers MUST normalize with `String()` before
 * comparison (e.g. `String(cb.ResultCode) === "0"`) — never `===`
 * against a single-type literal.
 *
 * @property ResultCode - `0`/`"0"` = success; anything else = failure.
 * @property CallbackMetadata - Present only on success.
 */
export interface StkCallbackResult {
  readonly MerchantRequestID: string;
  readonly CheckoutRequestID: string;
  readonly ResultCode: string | number;
  readonly ResultDesc: string;
  readonly CallbackMetadata?: {
    readonly Item: readonly MetadataItem[];
  };
}

// ─── MetadataMap helper ──────────────────────────────────────────────────────

/**
 * Map-like wrapper over `MetadataItem[]` with **first-wins** semantics.
 *
 * If the callback contains duplicate keys (malformed or gateway retries),
 * the first occurrence wins — subsequent values are silently dropped.
 * Use {@link MetadataMap.get} for O(1) lookup (backed by a `Map` index,
 * not a scan); for bulk access, iterate with {@link MetadataMap.entries}.
 * Use {@link MetadataMap.duplicateKeys} to detect lossy collisions (Go
 * `DuplicateKeys` / Python `duplicate_keys` parity).
 */
export class MetadataMap {
  private readonly items: MetadataItem[];
  private readonly index: Map<string, unknown>;
  /**
   * Count of wire items shadowed by an earlier same-named item.
   *
   * Counts EXTRA occurrences, not distinct keys: `[A, A, A]` reports `2`.
   * Fixed at construction from the wire items — later {@link MetadataMap.set}
   * calls never change it (Go `DuplicateKeys` / Python `duplicate_keys`
   * parity: Safaricom duplicates have been observed on retries).
   */
  private readonly duplicates: number;

  constructor(items: readonly MetadataItem[]) {
    this.items = [...items];
    this.index = new Map();
    let dupes = 0;
    for (const item of items) {
      if (!this.index.has(item.Name)) {
        this.index.set(item.Name, item.Value);
      } else {
        dupes++;
      }
    }
    this.duplicates = dupes;
  }

  /** Get a value by key. Returns `undefined` if not present. */
  get(key: string): unknown {
    return this.index.get(key);
  }

  /**
   * Set a key-value pair. **No-op** if the key already exists
   * (first-wins semantics).
   *
   * @deprecated Prefer constructing `new MetadataMap(items)` with the full
   *   item list instead — `set()` exists only for back-compat. First-wins
   *   still applies: existing keys are never overwritten, and `set()` calls
   *   never affect {@link MetadataMap.duplicateKeys} (which counts wire
   *   duplicates fixed at construction).
   *
   * @security PII warning — values may contain MSISDN, receipt numbers, or
   * account references. Never log raw MetadataMap contents in production;
   * redact or hash before writing to structured logs.
   */
  set(key: string, value: unknown): void {
    if (!this.index.has(key)) {
      this.index.set(key, value);
      this.items.push({ Name: key, Value: value });
    }
  }

  /** Check whether a key exists. */
  has(key: string): boolean {
    return this.index.has(key);
  }

  /**
   * Count of metadata items shadowed by an earlier same-named item
   * (Safaricom duplicates have been observed on retries).
   *
   * Counts EXTRA occurrences, not distinct keys: `[A, A, A]` returns `2`,
   * `[A, A, B]` returns `1`, no duplicates returns `0`. Non-zero means the
   * flattened view lost data — surface it for reconciliation instead of
   * silently dropping values.
   *
   * Go `STKCallbackResult.DuplicateKeys` / Python
   * `STKCallbackResult.duplicate_keys` parity.
   *
   * @returns Number of shadowed duplicate items fixed at construction.
   *
   * @example
   * ```ts
   * const map = new MetadataMap([
   *   { Name: "Amount", Value: 1000 },
   *   { Name: "Amount", Value: 9999 },
   * ]);
   * map.get("Amount");      // 1000 (first wins)
   * map.duplicateKeys();    // 1 (one item shadowed)
   * ```
   */
  duplicateKeys(): number {
    return this.duplicates;
  }

  /** Iterate all key-value pairs in insertion order. */
  entries(): IterableIterator<[string, unknown]> {
    return this.index.entries();
  }

  /** Number of metadata items. */
  get size(): number {
    return this.index.size;
  }
}

// ─── Section 5: Async result types ───────────────────────────────────────────

/**
 * Simplified async result — the callback contains a lot of nested JSON but
 * callers rarely need every field. This captures the essential envelope.
 *
 * For the full envelope — `ResultType`, `TransactionID`, `ReferenceData`
 * plus a first-wins `parameters()` map — use {@link ParsedAsyncResult}
 * (built by {@link parseAsyncResultBody}), which mirrors Go
 * `AsyncResultBody` / Python `AsyncResult` field-for-field.
 */
export interface AsyncResult {
  readonly ResultType: number;
  readonly ResultCode: string;
  readonly ResultDesc: string;
  readonly OriginatorConversationID: string;
  readonly ConversationID: string;
  /**
   * TransactionID echo — present on transaction-status / reversal
   * results, empty on the rest (Go `AsyncResultBody.TransactionID`
   * parity).
   */
  readonly TransactionID: string;
  /** M-Pesa receipt number when present. */
  readonly TransactionReceipt?: string;
  readonly B2CUtilityAccountAvailableFunds?: string;
  readonly B2CUtilityAccountPaidFunds?: string;
  readonly B2CWorkingAccountAvailableFunds?: string;
  readonly B2CWorkingAccountPaidFunds?: string;
  readonly B2CUtilityAccountTransferredFunds?: string;
  readonly B2CWorkingAccountTransferredFunds?: string;
  readonly B2CFlag?: string;
  readonly TransactionStatus?: string;
  readonly Occassion?: string;
  /**
   * Optional ReferenceData echo some async results carry (e.g. B2C
   * `QueueTimeoutURL`). Single-object and list shapes are both
   * normalized to this array (Go `ReferenceData.UnmarshalJSON` parity).
   */
  readonly ReferenceData?: readonly ReferenceItem[];
}

/** One echoed `{Key, Value}` entry inside an async-result `ReferenceData` section. */
export interface ReferenceItem {
  readonly Key: string;
  readonly Value: string;
}

/** One `{Key, Value}` pair inside `ResultParameters.ResultParameter`. */
export interface AsyncResultParameter {
  readonly Key: string;
  readonly Value: unknown;
}

/** A single balance segment from AccountBalance callback text. */
export interface BalanceSegment {
  readonly accountName: string;
  readonly currency: string;
  readonly available: number;
  readonly uncleared: number;
  readonly reserved: number;
  readonly min: number;
  /** Raw `account|currency|avail|uncleared|reserved|min` row (trimmed). */
  readonly raw: string;
}

/**
 * ASCII-digit gate for balance amounts (Python `_BALANCE_NUM_RE`
 * parity): `^[+-]?[0-9]{1,18}(\.[0-9]{1,6})?$`. Rejects `parseFloat`
 * false-positives such as `"1_000"` (→ 1), `"0x10"` (→ 0), and
 * Unicode-ND digits — allowlist per OWASP Input Validation.
 */
const BALANCE_NUM_RE = /^[+-]?[0-9]{1,18}(\.[0-9]{1,6})?$/;

/** Decimal rendering of 2^53 for exact string comparison (Go `maxSafeBalanceStr` parity). */
const MAX_SAFE_BALANCE_STR = "9007199254740992";

/**
 * Does the ASCII-gated decimal `text` exceed ±2^53 in magnitude — decided
 * WITHOUT rounding through float64 first?
 *
 * Why string comparison (precision trap): float64 cannot represent
 * 9007199254740993 — `parseFloat` rounds it to exactly 2^53, so a
 * post-parse `Math.abs(v) > 2**53` check would pass a hostile value that
 * is textually beyond the safe-integer boundary. Comparing stripped
 * integer digits by length, then lexicographically (numeric compare for
 * equal digit counts), rejects the hostile text exactly. Any non-zero
 * fraction when the integer part equals 2^53 also exceeds it. Call only
 * with {@link BALANCE_NUM_RE}-passing input (Go `exceedsSafeBalance`
 * parity).
 */
function exceedsSafeBalance(text: string): boolean {
  let s = text;
  if (s.startsWith("+") || s.startsWith("-")) s = s.slice(1);
  let intPart = s;
  let fracPart = "";
  const dot = s.indexOf(".");
  if (dot >= 0) {
    intPart = s.slice(0, dot);
    fracPart = s.slice(dot + 1);
  }
  // Strip leading zeros so the length comparison is by magnitude.
  intPart = intPart.replace(/^0+/, "");
  if (intPart === "") intPart = "0";
  if (intPart.length > MAX_SAFE_BALANCE_STR.length) return true;
  if (intPart.length < MAX_SAFE_BALANCE_STR.length) return false;
  if (intPart > MAX_SAFE_BALANCE_STR) return true;
  if (intPart < MAX_SAFE_BALANCE_STR) return false;
  // Integer part is exactly 2^53: any non-zero fraction exceeds it.
  return /[1-9]/.test(fracPart);
}

/**
 * Parse the pipe-delimited AccountBalance callback text into structured
 * segments. Malformed or incomplete rows are silently skipped.
 *
 * Each numeric field must match {@link BALANCE_NUM_RE} (ASCII digits
 * only) before `parseFloat` — this rejects `"1_000"`, `"0x10"`, and
 * Unicode digits that `parseFloat` would otherwise mis-parse or that
 * Python's `_BALANCE_NUM_RE` rejects. Values beyond ±2^53 are rejected
 * TEXTUALLY via {@link exceedsSafeBalance} (Go `results.go` parity):
 * `parseFloat("9007199254740993")` rounds to exactly 2^53, so a
 * post-parse check would let the precision-corrupting magnitude through.
 *
 * **Skipped-count limitation**: malformed rows are dropped without a
 * count in this pass — the return type stays `BalanceSegment[]` for
 * back-compat. A future breaking change will return
 * `{ segments, skipped }` so callers can distinguish "empty balance"
 * from "all rows malformed".
 *
 * @param text - Raw callback text (e.g.
 *   `"Available Account Balance|KES|1234.56|0.00|0.00|0.00"`).
 * @returns Array of parsed balance segments (may be empty).
 *
 * @example
 * ```ts
 * const segments = parseBalanceSegments(
 *   "Available Account Balance|KES|1234.56|0.00|0.00|0.00&" +
 *   "Float Balance|KES|5000.00|0.00|0.00|0.00"
 * );
 * // segments[0].accountName === "Available Account Balance"
 * // segments[0].available === 1234.56
 * ```
 */
export function parseBalanceSegments(text: string): BalanceSegment[] {
  const segments: BalanceSegment[] = [];
  const parts = text.split("&");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const fields = trimmed.split("|");
    if (fields.length < 6) continue;
    const accountName = fields[0];
    const currency = fields[1];
    const availStr = fields[2];
    const unclearedStr = fields[3];
    const reservedStr = fields[4];
    const minStr = fields[5];
    if (
      accountName === undefined || currency === undefined ||
      availStr === undefined || unclearedStr === undefined ||
      reservedStr === undefined || minStr === undefined
    ) continue;
    const availT = availStr.trim();
    const unclearedT = unclearedStr.trim();
    const reservedT = reservedStr.trim();
    const minT = minStr.trim();
    if (
      !BALANCE_NUM_RE.test(availT) || !BALANCE_NUM_RE.test(unclearedT) ||
      !BALANCE_NUM_RE.test(reservedT) || !BALANCE_NUM_RE.test(minT)
    ) continue;
    if (
      exceedsSafeBalance(availT) || exceedsSafeBalance(unclearedT) ||
      exceedsSafeBalance(reservedT) || exceedsSafeBalance(minT)
    ) continue;
    const available = parseFloat(availT);
    const uncleared = parseFloat(unclearedT);
    const reserved = parseFloat(reservedT);
    const min = parseFloat(minT);
    if (
      Number.isFinite(available) && Number.isFinite(uncleared) &&
      Number.isFinite(reserved) && Number.isFinite(min)
    ) {
      segments.push({
        accountName: accountName.trim(),
        currency: currency.trim(),
        available,
        uncleared,
        reserved,
        min,
        raw: trimmed,
      });
    }
  }
  return segments;
}

// ─── Section 6: isAccepted() and parseAsyncResult() ─────────────────────────

/**
 * Returns `true` when the synchronous response was accepted by Daraja
 * (`ResponseCode === "0"`).
 */
export function isAccepted(res: { ResponseCode: string }): boolean {
  return res.ResponseCode === "0";
}

/**
 * Parsed envelope from a B2C / reversal / transaction-status async result
 * callback. Only the fields common to all async result envelopes are
 * captured here — use {@link AsyncResult} for the full B2C-specific payload.
 */
export interface AsyncResultEnvelope {
  readonly ResultCode: string;
  readonly ResultDesc: string;
  readonly MerchantRequestID?: string;
  readonly CheckoutRequestID?: string;
}

/**
 * Parse and validate the raw async result callback body.
 *
 * Accepts either:
 * - **Flat**: `{ ResultCode, ResultDesc, ... }`
 * - **Wrapped** (Daraja wire shape): `{ "Result": { ResultCode, ResultDesc, ... } }`
 *
 * `ResultCode`/`ResultDesc` accept `string` OR `number` and are
 * coerced via `String()` — the gateway emits both shapes depending on
 * endpoint/version. `ResultCode` is always `string` after coercion for
 * cross-language parity (Go `FlexString`, Python normalizes to `str`).
 *
 * @throws {TypeError} If the body is not an object or is missing required
 *   fields (`ResultCode`, `ResultDesc` as string or number).
 */
export function parseAsyncResult(body: unknown): AsyncResultEnvelope {
  if (typeof body !== "object" || body === null) {
    throw new TypeError("mpesa: invalid async result envelope");
  }
  const outer = body as Record<string, unknown>;
  const inner: Record<string, unknown> =
    typeof outer.Result === "object" && outer.Result !== null
      ? (outer.Result as Record<string, unknown>)
      : outer;
  const rawCode = inner.ResultCode;
  const rawDesc = inner.ResultDesc;
  if (
    (typeof rawCode !== "string" && typeof rawCode !== "number") ||
    (typeof rawDesc !== "string" && typeof rawDesc !== "number")
  ) {
    throw new TypeError("mpesa: invalid async result envelope");
  }
  return {
    ResultCode: String(rawCode),
    ResultDesc: String(rawDesc),
    ...(typeof inner.MerchantRequestID === "string" && { MerchantRequestID: inner.MerchantRequestID }),
    ...(typeof inner.CheckoutRequestID === "string" && { CheckoutRequestID: inner.CheckoutRequestID }),
  };
}

/**
 * Hard cap (1 MiB) for raw async-result callback bodies accepted by
 * {@link parseAsyncResultJson} — parity with the client/OAuth transport
 * caps (`maxResponseLen` / `MAX_BODY_BYTES`). Measured in UTF-8 bytes,
 * not UTF-16 code units, so multi-byte characters count honestly.
 */
export const MAX_ASYNC_RESULT_BYTES = 1 << 20;

/**
 * Parse a RAW async-result callback body (string or UTF-8 bytes) into an
 * {@link AsyncResultEnvelope} with a bounded size pre-check.
 *
 * Measures the UTF-8 byte length FIRST — `string` via
 * `Buffer.byteLength(raw, "utf-8")` (counts without allocating an encoded
 * copy of the whole body), `Uint8Array` via `byteLength` — and rejects
 * bodies over {@link MAX_ASYNC_RESULT_BYTES} (1 MiB) BEFORE calling
 * `JSON.parse`, then delegates envelope validation to
 * {@link parseAsyncResult}.
 *
 * SECURITY: never `JSON.parse` uncapped callback bodies — an unbounded
 * parse materializes attacker-controlled memory before validation runs.
 * Route every raw callback POST body through this entry instead of
 * `JSON.parse` + {@link parseAsyncResult} by hand.
 *
 * @param raw - Raw callback POST body: JSON text, or the raw request bytes.
 * @returns The validated envelope (`ResultCode` always `string`).
 * @throws {MpesaError} When the body exceeds 1 MiB
 *   (`mpesa: HTTP 413 async result body response exceeds 1048576 bytes
 *   (Content-Length: <byteLen>)`).
 * @throws {MpesaDecodeError} When the body is not valid JSON or not a JSON
 *   object (via {@link decodeJsonObject} — never a raw `SyntaxError`).
 * @throws {TypeError} When the parsed JSON is not a valid envelope
 *   (from {@link parseAsyncResult}).
 *
 * @example
 * ```ts
 * import { parseAsyncResultJson } from "@mpesa-sdk/core";
 *
 * // In an HTTP handler (Express-style):
 * const envelope = parseAsyncResultJson(reqBodyText);
 * if (envelope.ResultCode === "0") markSettled(order);
 * ```
 */
export function parseAsyncResultJson(raw: string | Uint8Array): AsyncResultEnvelope {
  const byteLen =
    typeof raw === "string"
      ? Buffer.byteLength(raw, "utf-8")
      : raw.byteLength;
  if (byteLen > MAX_ASYNC_RESULT_BYTES) {
    // Typed (MpesaError, HTTP 413) via the shared oversize helper so
    // `catch (e instanceof MpesaError)` sees the cap like any other
    // failure mode — the same taxonomy as the auth/client transport caps.
    // Label "async result body" preserves the historic message text; the
    // measured byteLen rides along as the `actual` size.
    throw bodyTooLargeError("async result body", MAX_ASYNC_RESULT_BYTES, byteLen);
  }
  const text =
    typeof raw === "string"
      ? raw
      : new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw);
  return parseAsyncResult(decodeJsonObject<Record<string, unknown>>(text, "async result"));
}

// ─── Section 6b: full async-result envelope (ParsedAsyncResult) ──────────────

/**
 * Is `value` a plain (non-array, non-null) JSON object?
 *
 * Local (not exported): the async-envelope strictness check — Python
 * `isinstance(inner, dict)` parity for the required `Result` wrapper.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Wire scalars the async-result envelope requires (Python parity:
 *  `ResultCode` + `ResultDesc`; the rest are coerced leniently). */
const ASYNC_RESULT_REQUIRED_KEYS = ["ResultCode", "ResultDesc"] as const;

/**
 * The full async-result envelope POSTed to `ResultURL` — Go
 * `AsyncResultBody` / Python `AsyncResult` parity: every documented
 * scalar plus the first-wins `ResultParameters` map and the
 * `ReferenceData` echo. Unsigned like every Safaricom push: bind on
 * `OriginatorConversationID` against your own records before acting, and
 * never auto-fail an INCONCLUSIVE result (ADR-010).
 *
 * Built via {@link ParsedAsyncResult.parse} (already-decoded JSON) or
 * {@link parseAsyncResultBody} (raw POST body with the 1 MiB cap).
 *
 * @example
 * ```ts
 * const result = parseAsyncResultBody(reqBodyText);
 * if (result.classify() === ResultClass.SUCCESS) {
 *   const receipt = result.transactionReceipt();          // typed accessor
 *   const params = result.parameters();                   // first-wins map
 *   const receipt2 = params.get("TransactionReceipt");
 * }
 * ```
 */
export class ParsedAsyncResult {
  /** ResultType as a number (0 when absent/non-numeric). */
  readonly ResultType: number;
  /** ResultCode normalized to string (Python parity). */
  readonly ResultCode: string;
  /** ResultDesc normalized to string. */
  readonly ResultDesc: string;
  readonly OriginatorConversationID: string;
  readonly ConversationID: string;
  readonly TransactionID: string;
  /** Present when the gateway echoes it. */
  readonly MerchantRequestID: string | undefined;
  /** Present when the gateway echoes it. */
  readonly CheckoutRequestID: string | undefined;
  /** Optional ReferenceData echo; both wire shapes normalized to an array. */
  readonly ReferenceData: readonly ReferenceItem[] | undefined;
  /** First-wins parameter map (reuses {@link MetadataMap} semantics). */
  private readonly _parameters: MetadataMap;

  /**
   * @param init - Pre-normalized fields (see {@link ParsedAsyncResult.parse}).
   */
  private constructor(init: {
    resultType: number;
    resultCode: string;
    resultDesc: string;
    originatorConversationID: string;
    conversationID: string;
    transactionID: string;
    merchantRequestID: string | undefined;
    checkoutRequestID: string | undefined;
    referenceData: readonly ReferenceItem[] | undefined;
    parameters: MetadataMap;
  }) {
    this.ResultType = init.resultType;
    this.ResultCode = init.resultCode;
    this.ResultDesc = init.resultDesc;
    this.OriginatorConversationID = init.originatorConversationID;
    this.ConversationID = init.conversationID;
    this.TransactionID = init.transactionID;
    this.MerchantRequestID = init.merchantRequestID;
    this.CheckoutRequestID = init.checkoutRequestID;
    this.ReferenceData = init.referenceData;
    this._parameters = init.parameters;
  }

  /**
   * Parse an already-decoded async-result JSON body. Accepts the wire
   * shape `{"Result": {...}}` (a bare inner object is tolerated); the
   * `Result` wrapper and the `ResultCode`/`ResultDesc` scalars are
   * required, every other field is coerced leniently.
   *
   * @param body - Decoded JSON value (object expected).
   * @returns The parsed envelope.
   * @throws {MpesaDecodeError} When `Result` is missing or not an object,
   *   or `ResultCode`/`ResultDesc` are absent.
   */
  static parse(body: unknown): ParsedAsyncResult {
    const shapeError = (): MpesaDecodeError =>
      new MpesaDecodeError(
        "mpesa: unexpected AsyncResult shape: missing or malformed Result",
      );
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw shapeError();
    }
    const outer = body as Record<string, unknown>;
    const innerRaw = outer["Result"];
    // Python parity: the {"Result": {...}} wrapper is REQUIRED — a bare
    // inner object (or no wrapper at all) is a shape failure, not an
    // envelope with empty fields.
    if (!isPlainObject(innerRaw)) {
      throw shapeError();
    }
    const inner: Record<string, unknown> = innerRaw;
    const missing = ASYNC_RESULT_REQUIRED_KEYS.filter(
      (k) => !Object.prototype.hasOwnProperty.call(inner, k),
    );
    if (missing.length > 0) {
      throw new MpesaDecodeError(
        `mpesa: unexpected AsyncResult shape: missing ${missing.join(", ")}`,
      );
    }

    // ResultParameters / ReferenceData walk.
    const items: MetadataItem[] = [];
    const paramsRaw = inner["ResultParameters"];
    if (typeof paramsRaw === "object" && paramsRaw !== null && !Array.isArray(paramsRaw)) {
      const list = (paramsRaw as Record<string, unknown>)["ResultParameter"];
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
          const e = entry as Record<string, unknown>;
          items.push({
            Name: coerceWireString(e["Key"]) ?? "",
            Value: e["Value"],
          });
        }
      }
    }

    const referenceItems: ReferenceItem[] = [];
    const refRaw = inner["ReferenceData"];
    if (typeof refRaw === "object" && refRaw !== null && !Array.isArray(refRaw)) {
      const list = (refRaw as Record<string, unknown>)["ReferenceItem"];
      const entries: unknown[] =
        typeof list === "object" && list !== null && !Array.isArray(list)
          ? [list] // single-object shape (b2c.md sample)
          : Array.isArray(list) ? list : [];
      for (const entry of entries) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const e = entry as Record<string, unknown>;
        referenceItems.push({
          Key: coerceWireString(e["Key"]) ?? "",
          Value: coerceWireString(e["Value"]) ?? "",
        });
      }
    }

    return new ParsedAsyncResult({
      resultType: coerceWireInt(inner["ResultType"]) ?? 0,
      resultCode: coerceWireString(inner["ResultCode"]) ?? "",
      resultDesc: coerceWireString(inner["ResultDesc"]) ?? "",
      originatorConversationID: coerceWireString(inner["OriginatorConversationID"]) ?? "",
      conversationID: coerceWireString(inner["ConversationID"]) ?? "",
      transactionID: coerceWireString(inner["TransactionID"]) ?? "",
      merchantRequestID: coerceWireString(inner["MerchantRequestID"]) ?? undefined,
      checkoutRequestID: coerceWireString(inner["CheckoutRequestID"]) ?? undefined,
      referenceData: referenceItems.length > 0 ? referenceItems : undefined,
      parameters: new MetadataMap(items),
    });
  }

  /**
   * First-wins `ResultParameters` map (Go `Parameters()` / Python
   * `parameters()` parity). Absent sections yield an empty map; duplicate
   * keys keep the FIRST value — count losses with
   * {@link ParsedAsyncResult.duplicateKeys}.
   *
   * @returns The flattened parameter map.
   */
  parameters(): MetadataMap {
    return this._parameters;
  }

  /**
   * @returns Count of parameter items shadowed by an earlier same-key item.
   */
  duplicateKeys(): number {
    return this._parameters.duplicateKeys();
  }

  /**
   * @returns The echoed ReferenceItem entries (empty when absent).
   */
  referenceItems(): readonly ReferenceItem[] {
    return this.ReferenceData ?? [];
  }

  /**
   * ADR-010 bucket for {@link ParsedAsyncResult.ResultCode} — never
   * auto-fail unknowns.
   *
   * @returns The classified {@link ResultClass}.
   */
  classify(): ResultClass {
    return classifyResultCode(this.ResultCode);
  }

  /**
   * @returns `TransactionReceipt` parameter, or null when absent.
   */
  transactionReceipt(): string | null {
    const raw = this._parameters.get("TransactionReceipt");
    const s = coerceWireString(raw);
    return s !== null && s !== "" ? s : null;
  }

  /**
   * @returns `TransactionStatus` parameter (status APIs), or null.
   */
  transactionStatus(): string | null {
    const raw = this._parameters.get("TransactionStatus");
    const s = coerceWireString(raw);
    return s !== null && s !== "" ? s : null;
  }

  /**
   * @returns `TransactionAmount` parameter as a number, or null when
   *   absent/hostile (governed by the shared amount coercion).
   */
  amount(): number | null {
    return coerceAmount(this._parameters.get("TransactionAmount"));
  }
}

/**
 * Parse a RAW async-result callback body (string or UTF-8 bytes) into the
 * full {@link ParsedAsyncResult} envelope with a bounded size pre-check
 * and a TYPED decode failure.
 *
 * Measures the UTF-8 byte length FIRST (`Buffer.byteLength` for strings —
 * no throwaway encode of the whole body, halving peak memory) and rejects
 * bodies over {@link MAX_ASYNC_RESULT_BYTES} (1 MiB) BEFORE
 * `JSON.parse`, then delegates envelope validation to
 * {@link ParsedAsyncResult.parse}.
 *
 * SECURITY: never `JSON.parse` uncapped callback bodies — an unbounded
 * parse materializes attacker-controlled memory before validation runs.
 * Route every raw callback POST body through this entry.
 *
 * @param raw - Raw callback POST body: JSON text, or the raw request bytes.
 * @returns The validated full envelope.
 * @throws {MpesaError} When the body exceeds 1 MiB
 *   (`mpesa: HTTP 413 async result body response exceeds 1048576 bytes
 *   (Content-Length: <byteLen>)`).
 * @throws {MpesaDecodeError} When the body is not a JSON object or the
 *   envelope shape is malformed.
 *
 * @example
 * ```ts
 * const result = parseAsyncResultBody(reqBodyText);
 * if (result.classify() === ResultClass.SUCCESS) settle(order, result.transactionReceipt());
 * ```
 */
export function parseAsyncResultBody(raw: string | Uint8Array): ParsedAsyncResult {
  const byteLen =
    typeof raw === "string"
      ? Buffer.byteLength(raw, "utf-8")
      : raw.byteLength;
  if (byteLen > MAX_ASYNC_RESULT_BYTES) {
    // Typed (MpesaError, HTTP 413) via the shared oversize helper so
    // `catch (e instanceof MpesaError)` sees the cap like any other
    // failure mode — the same taxonomy as the auth/client transport caps.
    // Label "async result body" preserves the historic message text; the
    // measured byteLen rides along as the `actual` size.
    throw bodyTooLargeError("async result body", MAX_ASYNC_RESULT_BYTES, byteLen);
  }
  const text =
    typeof raw === "string"
      ? raw
      : new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw);
  return ParsedAsyncResult.parse(decodeJsonObject<Record<string, unknown>>(text, "async result"));
}
