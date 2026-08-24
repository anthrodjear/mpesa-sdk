/**
 * Tests for src/classification.ts — result code classification (ASCII gate, tri-state).
 *
 * Mirrors go/classification.go (parseResultCode + ClassifyResultCode) and
 * python/mpesa/classification.py (ResultClass enum + classify_result_code)
 * translated to TypeScript with ASCII-gate regex and lenient float fallback
 * (matching Go's ParseFloat and Python's float() behavior).
 */
import { describe, expect, it } from "vitest";
import { classifyResultCode, ResultClass } from "../src/classification.js";

describe("classifyResultCode", () => {
  describe("SUCCESS (ResultCode 0 only)", () => {
    it("classifies string \"0\" as SUCCESS", () => {
      expect(classifyResultCode("0")).toBe(ResultClass.SUCCESS);
    });

    it("classifies numeric 0 as SUCCESS", () => {
      expect(classifyResultCode(0)).toBe(ResultClass.SUCCESS);
    });

    it("classifies integral float string \"0.0\" as SUCCESS (lenient)", () => {
      expect(classifyResultCode("0.0")).toBe(ResultClass.SUCCESS);
    });
  });

  describe("FAILURE (documented terminal codes)", () => {
    it("classifies STK Push failure codes", () => {
      expect(classifyResultCode("1")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("17")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("1019")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("1025")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("1032")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("2001")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("9999")).toBe(ResultClass.FAILURE);
    });

    it("classifies B2C async failure codes", () => {
      expect(classifyResultCode("2")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("3")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("4")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("8")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("11")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("21")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("2006")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("2028")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("2040")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("8006")).toBe(ResultClass.FAILURE);
    });

    it("classifies Account Balance failure codes", () => {
      expect(classifyResultCode("15")).toBe(ResultClass.FAILURE);
      expect(classifyResultCode("22")).toBe(ResultClass.FAILURE);
    });

    it("classifies numeric (not just string) failure codes", () => {
      expect(classifyResultCode(1)).toBe(ResultClass.FAILURE);
      expect(classifyResultCode(1032)).toBe(ResultClass.FAILURE);
      expect(classifyResultCode(9999)).toBe(ResultClass.FAILURE);
    });
  });

  describe("INCONCLUSIVE (everything else)", () => {
    it("returns INCONCLUSIVE for null and undefined", () => {
      expect(classifyResultCode(null)).toBe(ResultClass.INCONCLUSIVE);
      expect(classifyResultCode(undefined)).toBe(ResultClass.INCONCLUSIVE);
    });

    it("returns INCONCLUSIVE for empty string", () => {
      expect(classifyResultCode("")).toBe(ResultClass.INCONCLUSIVE);
    });

    it("returns INCONCLUSIVE for whitespace-only strings", () => {
      expect(classifyResultCode("  ")).toBe(ResultClass.INCONCLUSIVE);
    });

    it("returns INCONCLUSIVE for unknown numeric codes", () => {
      expect(classifyResultCode("1001")).toBe(ResultClass.INCONCLUSIVE);
      expect(classifyResultCode("1037")).toBe(ResultClass.INCONCLUSIVE);
      expect(classifyResultCode("4999")).toBe(ResultClass.INCONCLUSIVE);
      expect(classifyResultCode("26")).toBe(ResultClass.INCONCLUSIVE);
      expect(classifyResultCode("-5")).toBe(ResultClass.INCONCLUSIVE);
      expect(classifyResultCode("123456")).toBe(ResultClass.INCONCLUSIVE);
    });

    it("returns INCONCLUSIVE for non-numeric strings", () => {
      expect(classifyResultCode("SFC_IC0003")).toBe(ResultClass.INCONCLUSIVE);
      expect(classifyResultCode("abc")).toBe(ResultClass.INCONCLUSIVE);
    });

    it("returns INCONCLUSIVE for Unicode-ND digit forgery", () => {
      expect(classifyResultCode("٠١")).toBe(ResultClass.INCONCLUSIVE);  // Arabic-Indic
      expect(classifyResultCode("१२")).toBe(ResultClass.INCONCLUSIVE);  // Devanagari
    });

    it("returns INCONCLUSIVE for non-integer floats", () => {
      expect(classifyResultCode("1.5")).toBe(ResultClass.INCONCLUSIVE);
    });

    it("returns INCONCLUSIVE for NaN and Infinity", () => {
      expect(classifyResultCode(NaN)).toBe(ResultClass.INCONCLUSIVE);
      expect(classifyResultCode(Infinity)).toBe(ResultClass.INCONCLUSIVE);
    });
  });
});

describe("ResultClass enum", () => {
  it("has exactly three members", () => {
    expect(Object.keys(ResultClass)).toHaveLength(3);
  });

  it("values are uppercase strings matching enum keys", () => {
    expect(ResultClass.SUCCESS).toBe("SUCCESS");
    expect(ResultClass.FAILURE).toBe("FAILURE");
    expect(ResultClass.INCONCLUSIVE).toBe("INCONCLUSIVE");
  });

  it("rejects duplicate values", () => {
    // Each member has a unique string value — cannot silently alias.
    const vals = Object.values(ResultClass);
    expect(new Set(vals).size).toBe(vals.length);
  });
});
