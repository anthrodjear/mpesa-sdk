/**
 * STK Push callback ingestion — the body Safaricom POSTs to your
 * `CallBackURL` (mirrors go/callbacks.go `ParseSTKCallback` and
 * python/mpesa/callbacks.py `StkCallbackResult.from_json`).
 *
 * SECURITY POSTURE (parity with Go/Python): the payload carries NO HMAC
 * signature — anyone who can reach your endpoint can forge one. Ranked
 * controls: settle ONLY via {@link MpesaClient.stkQuery} bound to YOUR
 * original request record with `ResultCode === "0"` (a body that parses is
 * never proof of payment); cap request bodies upstream at ≥1 MiB
 * (`parseSTKCallback` enforces the same 1 MiB cap itself); gate the
 * endpoint with the bearer-capability URL tokens from
 * {@link newCallbackToken}; `CheckoutRequestID` binding is a
 * DEDUP/IDEMPOTENCY control, NOT origin authentication; treat every
 * metadata value as ADVISORY; classify per ADR-010 — an INDETERMINATE
 * outcome may still settle minutes later, so never auto-fail or refund on
 * one.
 *
 * Acceptance shape (Go parity): the full envelope
 * `{"Body":{"stkCallback":{…}}}` OR a bare `stkCallback` result object
 * (fixtures, replayed captures). When the `Body` key is present it must be
 * an object carrying an object `stkCallback`; a body whose `Body` is an
 * array/scalar is a loud typed failure, never a silent empty result.
 *
 * @example
 * ```ts
 * // In an HTTP handler:
 * const result = parseSTKCallback(reqBodyRaw);
 * const order = repo.byCheckout(result.CheckoutRequestID); // dedup FIRST
 * if (order === undefined) return ack();                   // unknown: ACK, ignore
 * if (result.classify() === ResultClass.SUCCESS) {         // HINT only —
 *   const resp = await client.stkQuery({ checkoutRequestID: result.CheckoutRequestID });
 *   if (resp.ResultCode === "0") settle(order, result.mpesaReceiptNumber(), result.amount());
 * } else {
 *   markPendingReconcile(order); // stkQuery decides; never refund on a hit
 * }
 * ```
 * @packageDocumentation
 */

import { MetadataMap } from "./types.js";
import { coerceAmount, coerceWireInt, coerceWireString } from "./coercion.js";
import { ResultClass, classifyResultCode } from "./classification.js";
import { MpesaDecodeError } from "./errors.js";
import { bodyTooLargeError } from "./_bounded-read.js";
import type { MetadataItem } from "./types.js";

/** Callback ingestion cap (1 MiB) — Go `maxCallbackBodyBytes` parity. */
const MAX_CALLBACK_BODY_BYTES = 1 << 20;

/** Required wire scalars, in the order Go/Python report them missing. */
const REQUIRED_SCALAR_KEYS = [
  "MerchantRequestID",
  "CheckoutRequestID",
  "ResultCode",
  "ResultDesc",
] as const;

/** Keys whose presence identifies a bare (unwrapped) stkCallback object. */
const BARE_IDENTIFYING_KEYS = ["MerchantRequestID", "CheckoutRequestID", "ResultCode"] as const;

/** Is `value` a plain (non-array, non-null) JSON object? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract a metadata item's `Name` surviving hostile values
 * (unnameable → `""`; Python `_item_name` parity). Non-string names that
 * are non-finite numbers (`1e999` → Infinity from JSON) also yield `""`,
 * mirroring Python's `parse_int` hook turning such magnitudes into
 * absence before the name coercion runs.
 */
function itemName(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

/**
 * Payer MSISDN as an ASCII-digit string (Python `phone_number` parity):
 * numeric encodings are stringified (safe-integer magnitudes only —
 * JSON `1e999` → Infinity and beyond-2^53 magnitudes cannot round-trip in
 * JS, so they surface as null rather than precision-corrupted digits);
 * hostile magnitudes and non-digit strings yield null.
 */
function phoneNumberFrom(value: unknown): string | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) return null;
    const text = String(value);
    return /^[0-9]+$/.test(text) ? text : null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    return /^[0-9]+$/.test(text) ? text : null;
  }
  return null;
}

/**
 * A parsed STK Push callback outcome: the four wire scalars (normalized to
 * strings) plus first-wins metadata accessors. Immutable — construct via
 * {@link StkCallback.parse} or {@link parseSTKCallback}.
 *
 * The accessors tolerate the ABSENT `CallbackMetadata` Safaricom sends on
 * failures: every getter returns null/empty rather than throwing, and
 * {@link StkCallback.classify} is the only decision-grade signal.
 */
export class StkCallback {
  /** Gateway merchant request id (echo of the push request). */
  readonly MerchantRequestID: string;
  /** Idempotency/dedup key — bind against YOUR request record. */
  readonly CheckoutRequestID: string;
  /** ResultCode normalized to string (`0`, `"0"`, `"0.0"` → `"0"`). */
  readonly ResultCode: string;
  /** Gateway result description. */
  readonly ResultDesc: string;
  /** Raw metadata items, duplicates included, order preserved. */
  private readonly _items: readonly MetadataItem[];
  /** Lazily-built first-wins metadata map (one pass, O(1) per getter). */
  private _metadata: MetadataMap | null = null;

  /**
   * @param init - Pre-normalized fields (see {@link StkCallback.parse}).
   */
  private constructor(init: {
    merchantRequestID: string;
    checkoutRequestID: string;
    resultCode: string;
    resultDesc: string;
    items: readonly MetadataItem[];
  }) {
    this.MerchantRequestID = init.merchantRequestID;
    this.CheckoutRequestID = init.checkoutRequestID;
    this.ResultCode = init.resultCode;
    this.ResultDesc = init.resultDesc;
    this._items = init.items;
  }

  /**
   * Parse an already-decoded callback body. Accepts the full
   * `{"Body":{"stkCallback":{…}}}` envelope OR a bare stkCallback result
   * object; shape problems are loud typed errors, missing
   * `CallbackMetadata` stays tolerated.
   *
   * @param body - Decoded JSON value (object expected).
   * @returns The parsed callback.
   * @throws {MpesaDecodeError} When the shape is malformed or required
   *   wire scalars are absent.
   */
  static parse(body: unknown): StkCallback {
    if (!isPlainObject(body)) {
      throw new MpesaDecodeError(
        "mpesa: unexpected STK callback shape: missing or malformed Body.stkCallback",
      );
    }
    let inner: Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(body, "Body")) {
      const bodyObj = body["Body"];
      const stk = isPlainObject(bodyObj) ? bodyObj["stkCallback"] : undefined;
      if (!isPlainObject(stk)) {
        throw new MpesaDecodeError(
          "mpesa: unexpected STK callback shape: missing or malformed Body.stkCallback",
        );
      }
      inner = stk;
    } else {
      // Bare result object (Go parity): accepted only when it carries at
      // least one identifying wire key.
      const hasIdentity = BARE_IDENTIFYING_KEYS.some((k) =>
        Object.prototype.hasOwnProperty.call(body, k),
      );
      if (!hasIdentity) {
        throw new MpesaDecodeError(
          "mpesa: unexpected STK callback shape: missing or malformed Body.stkCallback",
        );
      }
      inner = body;
    }

    const missing = REQUIRED_SCALAR_KEYS.filter(
      (k) => !Object.prototype.hasOwnProperty.call(inner, k),
    );
    if (missing.length > 0) {
      throw new MpesaDecodeError(
        `mpesa: unexpected STK callback shape: missing ${missing.join(", ")}`,
      );
    }

    const items: MetadataItem[] = [];
    const meta = inner["CallbackMetadata"];
    const list = isPlainObject(meta) ? meta["Item"] : undefined;
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (!isPlainObject(entry)) continue; // scalars/nondict items dropped
        items.push({
          Name: itemName(entry["Name"]),
          // A missing Value is explicit absence (null), never a fake
          // zero — Python `entry.get("Value")` parity.
          Value: Object.prototype.hasOwnProperty.call(entry, "Value")
            ? entry["Value"]
            : null,
        });
      }
    }

    return new StkCallback({
      merchantRequestID: coerceWireString(inner["MerchantRequestID"]) ?? "",
      checkoutRequestID: coerceWireString(inner["CheckoutRequestID"]) ?? "",
      resultCode: coerceWireString(inner["ResultCode"]) ?? "",
      resultDesc: coerceWireString(inner["ResultDesc"]) ?? "",
      items,
    });
  }

  /**
   * @returns The raw metadata items (duplicates included, order preserved).
   */
  items(): readonly MetadataItem[] {
    return this._items;
  }

  /**
   * First-wins metadata map (Go `MetadataMap()` / Python `metadata()`
   * parity). Absent metadata yields an empty map; duplicate names keep
   * the FIRST value — count losses with {@link StkCallback.duplicateKeys}.
   *
   * @returns The flattened metadata map.
   */
  metadata(): MetadataMap {
    if (this._metadata === null) {
      this._metadata = new MetadataMap(this._items);
    }
    return this._metadata;
  }

  /**
   * @returns Count of metadata items shadowed by an earlier same-named item.
   */
  duplicateKeys(): number {
    return this.metadata().duplicateKeys();
  }

  /**
   * ADR-010 bucket for {@link StkCallback.ResultCode} — only wire 0 is
   * success; unknown/non-terminal codes stay INDETERMINATE.
   *
   * @returns The classified {@link ResultClass}.
   */
  classify(): ResultClass {
    return classifyResultCode(this.ResultCode);
  }

  /**
   * @returns `Amount` metadata as a number, or null when absent or
   *   hostile (booleans, beyond-±2^53 magnitudes, non-finite floats and
   *   non-decimal strings all yield null).
   */
  amount(): number | null {
    return coerceAmount(this.metadata().get("Amount"));
  }

  /**
   * @returns `MpesaReceiptNumber` metadata, or null when absent.
   */
  mpesaReceiptNumber(): string | null {
    const value = coerceWireString(this.metadata().get("MpesaReceiptNumber"));
    return value !== null && value !== "" ? value : null;
  }

  /**
   * @returns `TransactionDate` (YYYYMMDDHHMMSS) as a number, or null when
   *   absent/hostile. String-encoded values are accepted; booleans are
   *   rejected.
   */
  transactionDate(): number | null {
    return coerceWireInt(this.metadata().get("TransactionDate"));
  }

  /**
   * @returns `PhoneNumber` (payer MSISDN) as an ASCII-digit string, or
   *   null when absent/hostile.
   */
  phoneNumber(): string | null {
    return phoneNumberFrom(this.metadata().get("PhoneNumber"));
  }
}

/**
 * Parse a RAW STK callback POST body (string or UTF-8 bytes) into a
 * {@link StkCallback}. Bodies over 1 MiB are rejected BEFORE parsing, and
 * every malformed shape raises the typed {@link MpesaDecodeError} — never
 * a raw `SyntaxError`/`TypeError`.
 *
 * @param raw - Raw callback POST body: JSON text or the raw request bytes
 *   (invalid UTF-8 is decoded lossily; the body then fails shape
 *   validation rather than crashing the decoder).
 * @returns The parsed callback.
 * @throws {MpesaError} When the body exceeds 1 MiB
 *   (`mpesa: HTTP 413 callback body response exceeds 1048576 bytes`).
 * @throws {MpesaDecodeError} When the body is unparseable
 *   (`mpesa: unparseable callback body (…)`) or the STK callback shape is
 *   malformed.
 *
 * @example
 * ```ts
 * const result = parseSTKCallback(rawBody);
 * if (result.classify() === ResultClass.SUCCESS) {
 *   // HINT only — settle via stkQuery bound to YOUR record.
 * }
 * ```
 */
export function parseSTKCallback(raw: string | Uint8Array): StkCallback {
  const byteLen =
    typeof raw === "string"
      ? Buffer.byteLength(raw, "utf-8")
      : raw.byteLength;
  if (byteLen > MAX_CALLBACK_BODY_BYTES) {
    // Typed (MpesaError, HTTP 413) via the shared oversize helper so
    // `catch (e instanceof MpesaError)` sees the cap like any other
    // failure mode — the same taxonomy as the auth/client transport caps.
    // Label "callback body" preserves the historic message text.
    throw bodyTooLargeError("callback body", MAX_CALLBACK_BODY_BYTES);
  }
  const text =
    typeof raw === "string"
      ? raw
      : new TextDecoder("utf-8", { fatal: false }).decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.name : "SyntaxError";
    throw new MpesaDecodeError(
      `mpesa: unparseable callback body (${reason})`,
    );
  }
  // Arrays/scalars fail the plain-object guard inside parse() as shape
  // errors — never a TypeError on a property read.
  return StkCallback.parse(parsed);
}
