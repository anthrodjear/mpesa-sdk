/**
 * Tests for src/coercion.ts — safe parseInt, numeric checks, ±2^53 guard.
 *
 * Mirrors go/coercion.go (FlexInt64/FlexString JSON unmarshalers) and
 * python/mpesa/coercion.py (safe_json_int, coerce_int) translated to
 * TypeScript's standalone-function approach with JSON.parse-based parsing.
 */
import { describe, expect, it } from "vitest";
import { coerceInt, isNumericString, parseIntSafe, safeJsonInt } from "../src/coercion.js";

describe("safeJsonInt", () => {
  it("parses string numbers", () => {
    expect(safeJsonInt("3599")).toBe(3599);
    expect(safeJsonInt("0")).toBe(0);
    expect(safeJsonInt("-7")).toBe(-7);
    expect(safeJsonInt("+100")).toBeNull(); // JSON rejects leading +
  });

  it("parses raw numbers", () => {
    expect(safeJsonInt(3599)).toBe(3599);
    expect(safeJsonInt(0)).toBe(0);
    expect(safeJsonInt(-7)).toBe(-7);
  });

  it("returns null for non-number JSON types", () => {
    expect(safeJsonInt(null)).toBeNull();
    expect(safeJsonInt(undefined)).toBeNull();
    expect(safeJsonInt(true)).toBeNull();
    expect(safeJsonInt(false)).toBeNull();
    expect(safeJsonInt([])).toBeNull();
    expect(safeJsonInt({})).toBeNull();
  });

  it("returns null for empty and whitespace strings", () => {
    expect(safeJsonInt("")).toBeNull();
    expect(safeJsonInt(" ")).toBeNull();
  });

  it("returns null for non-numeric strings", () => {
    expect(safeJsonInt("abc")).toBeNull();
    expect(safeJsonInt("12abc")).toBeNull();
  });

  it("returns null for numbers beyond ±2^53 safe-integer range", () => {
    expect(safeJsonInt("9007199254740993")).toBeNull(); // 2^53+1
    expect(safeJsonInt("-9007199254740993")).toBeNull();
    expect(safeJsonInt("1e30")).toBeNull();
  });

  it("returns null for NaN and Infinity", () => {
    expect(safeJsonInt(NaN)).toBeNull();
    expect(safeJsonInt(Infinity)).toBeNull();
    expect(safeJsonInt(-Infinity)).toBeNull();
  });

  it("returns null for string-encoded Infinity/NaN/overflow", () => {
    expect(safeJsonInt("Infinity")).toBeNull();
    expect(safeJsonInt("NaN")).toBeNull();
    expect(safeJsonInt("1e999")).toBeNull();
  });

  it("returns null for __proto__ object input (no prototype pollution)", () => {
    expect(safeJsonInt({ __proto__: 123 } as unknown)).toBeNull();
  });

  it("returns MAX_SAFE_INTEGER boundary value", () => {
    expect(safeJsonInt("9007199254740991")).toBe(9007199254740991); // 2^53-1
  });

  it("returns null for non-integer floats", () => {
    expect(safeJsonInt("1.5")).toBeNull();
  });
});

describe("isNumericString", () => {
  it("accepts valid ASCII digit strings", () => {
    expect(isNumericString("123")).toBe(true);
    expect(isNumericString("-1")).toBe(true);
    expect(isNumericString("0")).toBe(true);
    expect(isNumericString("999999999999999")).toBe(true); // 15 digits max
  });

  it("rejects leading zeros on multi-digit numbers", () => {
    expect(isNumericString("01")).toBe(false);
    expect(isNumericString("001")).toBe(false);
    expect(isNumericString("-01")).toBe(false);
  });

  it("rejects Unicode-ND digits (Arabic-Indic, Devanagari, etc.)", () => {
    expect(isNumericString("٠٢٣")).toBe(false);
    expect(isNumericString("१२३")).toBe(false);
  });

  it("rejects commas, spaces, decimal points, and other characters", () => {
    expect(isNumericString("1,000")).toBe(false);
    expect(isNumericString("1 000")).toBe(false);
    expect(isNumericString("1.5")).toBe(false);
    expect(isNumericString("")).toBe(false);
  });

  it("rejects strings longer than 15 digits", () => {
    expect(isNumericString("1".repeat(16))).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isNumericString(123)).toBe(false);
    expect(isNumericString(null)).toBe(false);
    expect(isNumericString(undefined)).toBe(false);
  });
});

describe("coerceInt", () => {
  it("returns the parsed number on valid input", () => {
    expect(coerceInt("3599")).toBe(3599);
    expect(coerceInt(42)).toBe(42);
    expect(coerceInt("0")).toBe(0);
  });

  it("returns fallback (default 0) on invalid input", () => {
    expect(coerceInt("abc")).toBe(0);
    expect(coerceInt("abc", { fallback: -1 })).toBe(-1);
    expect(coerceInt(null)).toBe(0);
    expect(coerceInt(undefined)).toBe(0);
  });

  it("throws RangeError on INT32_MAX sentinel", () => {
    expect(() => coerceInt(2147483647)).toThrow(RangeError);
  });

  it("returns fallback for numbers beyond safe integer range", () => {
    expect(coerceInt("9007199254740993")).toBe(0); // default fallback
  });

  it("includes field name in RangeError message when provided", () => {
    expect(() => coerceInt(2147483647, { field: "expires_in" }))
      .toThrow("expires_in");
    expect(() => coerceInt(2147483647, { field: "expires_in" }))
      .toThrow("exceeds 32-bit range");
  });
});

describe("parseIntSafe", () => {
  it("returns the same result as safeJsonInt", () => {
    expect(parseIntSafe("3599")).toBe(safeJsonInt("3599"));
    expect(parseIntSafe("abc")).toBe(safeJsonInt("abc"));
    expect(parseIntSafe(null)).toBe(safeJsonInt(null));
  });
});
